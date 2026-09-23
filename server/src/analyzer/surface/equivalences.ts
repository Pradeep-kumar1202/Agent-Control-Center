/**
 * The checked-in knowledge that turns two declared surfaces into gaps.
 *
 * Deterministic parsers tell us WHAT each SDK declares. They cannot know that
 * web `business` and mobile `merchantDisplayName` are the same option, or that
 * mobile's `health` probe has no web counterpart by design. That knowledge
 * lives here, one reviewed row at a time, each with its evidence — never in a
 * model's per-run opinion (which is what made identities drift and verdicts
 * contradict each other; LEARNINGS 2026-09-23).
 *
 * Rules for editing:
 *  - An EQUIVALENCE needs both keys to exist in the parsers' output and a
 *    sentence saying why they are the same integrator capability. Renames only;
 *    "roughly similar" is not an equivalence — leave it a gap for Verify.
 *  - PLATFORM_SCOPED means "exists on one side on purpose". It keeps the row
 *    (dimmed, platform_specific=1) rather than hiding it.
 *  - NOT_SURFACE removes a declared key that is not an integrator feature
 *    (e.g. session credentials). Use sparingly; it hides things.
 *  - IMPLICIT_PRESENCE is for a capability present without a declaration the
 *    parser can see (a URL supplied by a backend response). Its evidence is
 *    re-checked on every run, so it cannot silently rot.
 *
 * `diffSurface` (index.ts) reports rows that no longer match the code as
 * table warnings on every run and in `npm run eval:gaps`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Side, SurfaceCategory } from "./types.js";

export interface Equivalence {
  category: SurfaceCategory;
  web: string;
  mobile: string;
  why: string;
}

export interface PlatformScoped {
  category: SurfaceCategory;
  /** The side that has it. */
  side: Side;
  key: string;
  reason: string;
}

export interface NotSurface {
  category: SurfaceCategory;
  side: Side;
  key: string;
  reason: string;
}

export interface ImplicitPresence {
  category: SurfaceCategory;
  /** The side where the capability exists without a parseable declaration. */
  side: Side;
  /** The key as declared on the OTHER side. */
  key: string;
  evidence: { file: string; contains: string };
  why: string;
}

export const EQUIVALENCES: Equivalence[] = [
  // ── config ──────────────────────────────────────────────────────────────
  {
    category: "config",
    web: "business",
    mobile: "merchantDisplayName",
    why: "web options.business.name (its only key) and mobile merchantDisplayName both set the merchant name shown in the sheet",
  },
  {
    category: "config",
    web: "branding",
    mobile: "disableBranding",
    why: "web branding: auto|never and mobile disableBranding: bool both toggle the Hyperswitch branding footer",
  },
  {
    category: "config",
    web: "paymentMethodsHeaderText",
    mobile: "paymentSheetHeaderLabel",
    why: "both override the header text above the payment-method list",
  },
  {
    category: "config",
    web: "savedPaymentMethodsHeaderText",
    mobile: "savedPaymentSheetHeaderLabel",
    why: "both override the header text above the saved-methods list",
  },
  {
    category: "config",
    web: "defaultValues",
    mobile: "billingDetails",
    why: "web options.defaultValues has one key, billingDetails; mobile takes billingDetails at the top level — both prefill billing details",
  },
  {
    category: "config",
    web: "wallets",
    mobile: "walletButtonsConfiguration",
    why: "both configure the Google Pay / Apple Pay / PayPal buttons (visibility, type, style)",
  },
  {
    category: "config",
    web: "subscriptionEvents",
    mobile: "subscribedEvents",
    why: "both list the SDK events the integrator subscribes to",
  },
  {
    category: "config",
    web: "layout",
    mobile: "paymentMethodLayout",
    why: "mobile paymentMethodLayout is the structured layout object (type, savedMethodCustomization…); its legacy fallback is the `layout` string",
  },
  // ── backend_api ─────────────────────────────────────────────────────────
  {
    category: "backend_api",
    web: "v1/sdk/configs/web/sdk_config.json",
    mobile: "v1/sdk/configs/{}/sdk_config.json",
    why: "same SDK-config fetch; mobile interpolates the platform segment",
  },
];

export const PLATFORM_SCOPED: PlatformScoped[] = [
  // ── config ── (reasons from the curated seed review unless stated)
  {
    category: "config",
    side: "mobile",
    key: "netceteraSDKApiKey",
    reason: "API key for the native Netcetera 3DS SDK, which only the mobile SDK embeds; web 3DS runs in the browser",
  },
  {
    category: "config",
    side: "mobile",
    key: "allowsPaymentMethodsRequiringShippingAddress",
    reason: "native payment-sheet flag (Stripe PaymentSheet parity); web has no equivalent sheet-level shipping gate",
  },
  {
    category: "config",
    side: "web",
    key: "loader",
    reason: "controls the web iframe loading skeleton; the native sheet has no iframe loader",
  },
  // ── backend_api ──
  {
    category: "backend_api",
    side: "mobile",
    key: "health",
    reason: "network reachability probe used by the mobile SDK's offline handling (NetworkStatusHook); browsers expose navigator.onLine",
  },
  // ── component ──
  ...(["tabSheet", "buttonSheet", "widgetPaymentSheet", "widgetTabSheet", "widgetButtonSheet", "widgetPaymentMethodsManagement"] as const).map(
    (key): PlatformScoped => ({
      category: "component",
      side: "mobile",
      key,
      reason: "native presentation variant (modal vs embedded widget, tab vs button layout) of a surface web mounts once (`payment` / `paymentMethodsManagement`) and styles via options.layout",
    }),
  ),
  {
    category: "component",
    side: "mobile",
    key: "scan_card_button",
    reason: "camera card scanning uses a native scanner module; not available to the web SDK iframe",
  },
  // Carried over from the April seed review (Opus + tools), labelled as such so
  // they stay challengeable rather than looking like settled fact.
  {
    category: "config",
    side: "mobile",
    key: "displayPayButton",
    reason: "[seed review 2026-04] lets the host app hide the sheet's built-in confirm button; the web SDK manages its own pay button (see sdkHandleConfirmPayment)",
  },
  {
    category: "component",
    side: "web",
    key: "form_view_journey",
    reason: "[seed review 2026-04] multi-step layout of the web payout-collect widget; mobile uses native navigation and backend-driven forms",
  },
  {
    category: "component",
    side: "web",
    key: "click_to_pay",
    reason: "[seed review 2026-04] built on the Visa/Mastercard Click to Pay JS SDK inside the web iframe; revisit if native Click to Pay SDKs are adopted",
  },
  {
    category: "component",
    side: "web",
    key: "info_element",
    reason: "[seed review 2026-04] web-only helper that renders info text next to form fields; mobile uses native primitives",
  },
];

export const NOT_SURFACE: NotSurface[] = (["clientSecret", "pmSessionId", "sdkAuthorization"] as const).map(
  (key): NotSurface => ({
    category: "config",
    side: "web",
    key,
    reason: "session credential passed to elements(); mobile receives the same values in paymentSessionConfig, not as configuration",
  }),
);

export const IMPLICIT_PRESENCE: ImplicitPresence[] = [
  {
    category: "config",
    side: "web",
    key: "primaryButtonLabel",
    evidence: { file: "src/Types/PaymentType.res", contains: 'buttonText: ?(dict->getOptionString("buttonText"))' },
    why: "web sets the SDK pay-button label via the nested option sdkHandleConfirmPayment.buttonText (and sdkHandleSavePayment.buttonText in payment-methods management); nested, so not an alias of a top-level key",
  },
  {
    category: "backend_api",
    side: "mobile",
    key: "payments/{}/3ds/authentication",
    evidence: { file: "src/hooks/NetceteraThreeDsHooks.res", contains: "threeDsAuthenticationUrl" },
    why: "mobile calls the 3DS authentication endpoint via the URL the confirm response supplies (three_ds_authentication_url), not a literal path",
  },
];

/** Normalised comparison key: config/component names compare case- and separator-insensitively; API paths exactly. */
export function compareKey(category: SurfaceCategory, key: string): string {
  return category === "backend_api" ? key : key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function implicitPresenceHolds(rule: ImplicitPresence, repoDir: string): boolean {
  const abs = path.join(repoDir, rule.evidence.file);
  return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(rule.evidence.contains);
}
