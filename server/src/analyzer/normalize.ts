import { MODEL_EXTRACT } from "../config.js";
import { askJson } from "../llm.js";
import type { Category, ExtractedFeature } from "./types.js";

/**
 * One row of the canonical cross-repo feature list.
 *
 * `web` and `mobile` may be null when a feature only exists in one repo —
 * those rows become gaps after the validate pass.
 */
export interface CanonicalFeature {
  canonical_name: string;
  web: ExtractedFeature | null;
  mobile: ExtractedFeature | null;
  rationale: string;
}

const CATEGORY_NOUN: Record<Category, string> = {
  payment_method: "payment methods",
  config: "integrator-facing configuration options",
  component: "user-visible UI widgets",
  backend_api: "backend API endpoints",
};

/**
 * Use Opus to canonicalize features across the two repos for one category.
 *
 * Goals:
 *  1. Map naming variants (web "card_holder_name" ↔ mobile "cardHolder").
 *  2. Collapse sub-fields into their parent (web's appearance_inner_layout,
 *     appearance_labels, appearance_rules, appearance_variables → one
 *     "appearance" row).
 *  3. Output one row per real feature, with whichever sides exist populated.
 */
export async function normalizeCategory(
  category: Category,
  web: ExtractedFeature[],
  mobile: ExtractedFeature[],
): Promise<CanonicalFeature[]> {
  if (web.length === 0 && mobile.length === 0) return [];

  const prompt = buildPrompt(category, web, mobile);
  console.log(
    `[normalize] ${category}: web=${web.length} mobile=${mobile.length} → Opus`,
  );

  const result = await askJson<{ features: CanonicalFeature[] }>(prompt, {
    model: MODEL_EXTRACT,
    timeoutMs: 300_000,
  });
  const list = result.features ?? [];
  console.log(
    `[normalize] ${category}: ${list.length} canonical (collapsed from ${web.length + mobile.length})`,
  );
  return list;
}

function buildPrompt(
  category: Category,
  web: ExtractedFeature[],
  mobile: ExtractedFeature[],
): string {
  const noun = CATEGORY_NOUN[category];

  return `You are normalizing two raw feature lists from sibling SDK repos.

Category: ${noun}

WEB SDK (hyperswitch-web) extracted ${web.length}:
${JSON.stringify(web)}

MOBILE SDK (hyperswitch-client-core) extracted ${mobile.length}:
${JSON.stringify(mobile)}

Produce a single canonical list. Apply these rules:

1. **Cross-repo naming variants are the same feature.** Examples:
   - "card_holder_name" ↔ "cardHolder" → one row "card_holder_name"
   - "ach_debit" ↔ "ach_bank_debit" → one row "ach_debit"
   - "appearance_theme" ↔ "theme" (when context is appearance) → one row

2. **Collapse sub-fields into parents** when one repo lists granular fields and
   the other lists the umbrella. Example: if web has "appearance",
   "appearance_variables", "appearance_rules", "appearance_labels", that's
   ONE feature called "appearance" — pick the most representative evidence
   row from web and set that as web. Don't emit four rows.

3. **Sub-variants of one payment method are one feature.** Example:
   "instant_bank_transfer", "instant_bank_transfer_finland",
   "instant_bank_transfer_poland" → one row "instant_bank_transfer".

4. For each canonical row, set web/mobile to the BEST matching ExtractedFeature
   from the input lists, or null if no real match exists in that repo. Do NOT
   invent evidence — null is fine.

5. \`canonical_name\` must be lower_snake_case.

6. \`rationale\` is one short sentence explaining the merge / mapping.

Output ONLY a JSON object. No prose, no code fences, no commentary:

{"features":[{"canonical_name":"<name>","web":<ExtractedFeature|null>,"mobile":<ExtractedFeature|null>,"rationale":"<one sentence>"}]}

Where ExtractedFeature has shape {"name":"...","file":"...","snippet":"..."}.

It is OK and expected for the canonical list to be SHORTER than the sum of the
two input lists — that's the whole point.`;
}
