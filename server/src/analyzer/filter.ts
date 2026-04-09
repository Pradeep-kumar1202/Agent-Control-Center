/**
 * Deterministic post-extraction filter.
 *
 * Runs between extract and normalize. Kills known noise without any LLM call.
 * Two passes:
 *
 *   1. collapseCanonicalGroups  — merge sub-keys of the same API into one
 *      canonical feature. Both SDKs expose things like appearance/layout/
 *      wallets at very different granularities (web: `appearance_variables`,
 *      mobile: flat `color_primary`, `font_family`, etc.). Normalize can't
 *      reliably cross-match these, so we flatten them to a single canonical
 *      entry per group per side.
 *
 *   2. dropNoise — remove generic UI primitives from the `component`
 *      category (tab_bar, date_element, button_element, etc.) and per-input
 *      styling cruft from `config` (element_*, icon_style, hide_*, etc.).
 *      These are infrastructure, not integrator-facing features.
 *
 * Rules are derived from real cached extract output — do not add patterns
 * without checking them against `data/cache/extract/*.json`.
 */
import type { Category, ExtractedFeature } from "./types.js";

interface Group {
  canonical: string;
  /** Matcher against the lowercased feature name. */
  match: (name: string) => boolean;
}

/**
 * Config sub-key groups. If ≥1 sub-keys match on a side, we replace them
 * ALL with a single canonical entry (using the first sub-key's file/snippet
 * as evidence). Order matters — earlier groups win if a name matches more
 * than one.
 */
const CONFIG_GROUPS: Group[] = [
  {
    canonical: "appearance_api",
    match: (n) =>
      /^appearance_/.test(n) ||
      /^color_/.test(n) ||
      /^font_/.test(n) ||
      /^shapes_/.test(n) ||
      n === "fonts" ||
      n === "loader" ||
      n === "primary_button_shapes" ||
      n === "primary_button_colors" ||
      n === "primary_button_color",
  },
  {
    canonical: "layout_config",
    match: (n) => n === "layout" || /^layout_/.test(n),
  },
  {
    canonical: "wallets_ui_config",
    match: (n) =>
      /^wallets_/.test(n) ||
      /^google_pay_button_/.test(n) ||
      /^apple_pay_button_/.test(n),
  },
  {
    canonical: "billing_fields_config",
    match: (n) =>
      /^fields_/.test(n) ||
      n === "billing_address_collection" ||
      n === "shipping_details" ||
      n === "default_billing_details" ||
      n === "display_billing_details",
  },
  {
    canonical: "saved_payment_methods_config",
    match: (n) =>
      n === "display_saved_payment_methods" ||
      n === "display_saved_payment_methods_checkbox" ||
      n === "saved_payment_methods_checkbox_checked_by_default" ||
      n === "saved_payment_methods_header_text" ||
      n === "display_default_saved_payment_icon" ||
      n === "saved_method_customization" ||
      n === "saved_payment_screen_header_text",
  },
];

/**
 * Per-input / styling cruft that isn't an integrator-facing feature.
 * Dropped outright, not collapsed.
 */
const CONFIG_NOISE_EXACT = new Set<string>([
  // web element low-level styling
  "element_classes",
  "element_style",
  "element_value",
  "hide_postal_code",
  "icon_style",
  "hide_icon",
  "show_icon",
  "disabled",
  "placeholder",
  "show_error",
  // mobile placeholder overrides (sub-options of card_form, not features)
  "placeholder_card_number",
  "placeholder_expiry_date",
  "placeholder_cvv",
  // internal flow wiring, not features
  "redirection_flags",
  "confirm_params_return_url",
  "confirm_params_publishable_key",
  "confirm_params_redirect",
]);

/**
 * Generic UI primitives that the mobile extractor picks up as "components"
 * but are not features. These are inputs and infra, not things an integrator
 * would ever ask "does web have this?" about.
 */
const COMPONENT_NOISE_EXACT = new Set<string>([
  // input primitives
  "tab_bar",
  "tab_view",
  "tab_element",
  "generic_tab_element",
  "date_element",
  "phone_element",
  "full_name_element",
  "address_element",
  "nickname_element",
  "button_element",
  "generic_button_element",
  // infrastructure shells
  "required_fields",
  "dynamic_fields",
  "dynamic_sheet",
  // container views (these host features, they aren't features themselves)
  "checkout_view",
  "hosted_checkout",
  "payment_sheet",
  "saved_payment_sheet",
  "wallet_view",
  // Payment-method-specific form fields — web renders these as dedicated
  // input components, but mobile shows a generic backend-driven form for all
  // payment methods. These will never exist as separate components in mobile.
  "blik_code_input",
  "pix_payment_input",
  "vpa_id_input",
  "document_number_input",
  "crypto_currency_networks",
  "gift_card_form",
]);

/** Normalize a name to lowercase snake_case for matching. */
function norm(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Collapse grouped sub-keys into canonical entries. For each group, if any
 * sub-keys match, replace ALL matching entries with a single entry named
 * after the group's canonical name. The first matching entry supplies
 * file/snippet evidence.
 */
function collapseCanonicalGroups(
  features: ExtractedFeature[],
  groups: Group[],
): ExtractedFeature[] {
  const out: ExtractedFeature[] = [];
  const emittedCanonical = new Set<string>();

  for (const f of features) {
    const n = norm(f.name);
    const group = groups.find((g) => g.match(n));

    if (!group) {
      out.push(f);
      continue;
    }

    if (emittedCanonical.has(group.canonical)) {
      // already represented — skip this sub-key
      continue;
    }

    emittedCanonical.add(group.canonical);
    out.push({
      name: group.canonical,
      file: f.file,
      snippet: f.snippet,
    });
  }

  return out;
}

function dropNoise(
  features: ExtractedFeature[],
  exact: Set<string>,
): ExtractedFeature[] {
  return features.filter((f) => !exact.has(norm(f.name)));
}

/**
 * Drop duplicate names on the same side. Normalize usually catches these
 * but the raw extractor output can contain duplicates (e.g. the cached
 * web backend_api file has `GET /payments/{id}` twice).
 */
function dedupeByName(features: ExtractedFeature[]): ExtractedFeature[] {
  const seen = new Set<string>();
  const out: ExtractedFeature[] = [];
  for (const f of features) {
    const n = norm(f.name);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(f);
  }
  return out;
}

export interface PrefilterResult {
  filtered: ExtractedFeature[];
  dropped: number;
  collapsed: number;
}

/**
 * Public entry point: takes raw extractor output for one (category, repo)
 * and returns a cleaned list. Pipeline:
 *
 *   1. dedupe by name
 *   2. drop exact-match noise (per-category denylist)
 *   3. collapse canonical groups (config only, for now)
 */
export function prefilter(
  features: ExtractedFeature[],
  category: Category,
): PrefilterResult {
  const before = features.length;
  let work = dedupeByName(features);

  if (category === "component") {
    work = dropNoise(work, COMPONENT_NOISE_EXACT);
  }

  if (category === "config") {
    work = dropNoise(work, CONFIG_NOISE_EXACT);
    const beforeCollapse = work.length;
    work = collapseCanonicalGroups(work, CONFIG_GROUPS);
    return {
      filtered: work,
      dropped: before - beforeCollapse,
      collapsed: beforeCollapse - work.length,
    };
  }

  return {
    filtered: work,
    dropped: before - work.length,
    collapsed: 0,
  };
}

/**
 * Structural filter for claimed gaps, applied AFTER normalize.
 *
 * Mobile SDK loads payment methods dynamically from backend responses —
 * static extraction will NEVER find payment method names in mobile source.
 * Any web payment method will always look "missing in mobile". These are
 * structural false positives. Drop them at the data layer, not the UI.
 */
export function isStructuralFalsePositive(
  category: Category,
  missingIn: "web" | "mobile",
): boolean {
  return category === "payment_method" && missingIn === "mobile";
}
