/**
 * Integrator-mountable UI surfaces.
 *
 * Two kinds, both deterministic:
 *
 * 1. Entry points — the strings an integrator passes to mount a UI:
 *      web     src/Types/CardThemeType.res  getPaymentMode      (elements.create("<mode>"))
 *      mobile  src/types/SdkTypes.res       parseSdkState, parsePmmState  (native `type`)
 *
 * 2. Catalogued features — named sub-features with no registry (click-to-pay,
 *    installments, card scanning…). Each is listed once in FEATURE_CATALOG with
 *    one path pattern applied to both SDKs; presence is a file lookup, never a
 *    model's opinion. Adding a feature means adding a row here — that is the
 *    review point.
 */

import fs from "node:fs";
import path from "node:path";
import {
  lineAt,
  lineTextAt,
  listFiles,
  readSource,
  requireAtLeast,
  switchStringArms,
  topLevelLet,
} from "./source.js";
import type { Side, SurfaceItem } from "./types.js";

export interface CatalogFeature {
  /** Stable identity; used as the gap's canonical_name. */
  key: string;
  description: string;
  /**
   * A feature counts as present in an SDK when any source file under its
   * source dirs has a repo-relative path matching this pattern. The SAME
   * pattern runs on both SDKs, so an implementation appearing later on the
   * missing side is picked up without editing this table.
   */
  pathPattern: RegExp;
}

/** Seeded from the curated gap review (seed/verified-gaps.json, component rows). */
export const FEATURE_CATALOG: CatalogFeature[] = [
  { key: "click_to_pay", description: "Click to Pay (Visa / Mastercard SRC) saved-card flow", pathPattern: /ClickToPay/i },
  { key: "installment_options", description: "Card installment plan selection", pathPattern: /Installment/i },
  { key: "info_element", description: "Informational element rendered alongside the payment element", pathPattern: /InfoElement/i },
  { key: "form_view_journey", description: "Journey (step-by-step) form layout for payout collection", pathPattern: /FormViewJourney/i },
  { key: "scan_card_button", description: "Camera card scanning", pathPattern: /ScanCard/i },
];

const SOURCE_DIRS = ["src", "shared-code/sdk-utils"];

export function extractComponentSurface(side: Side, repoDir: string): SurfaceItem[] {
  const items = side === "web" ? webEntryPoints(repoDir) : mobileEntryPoints(repoDir);
  const files = SOURCE_DIRS.flatMap((d) => listFiles(repoDir, d, ".res"));
  for (const f of FEATURE_CATALOG) {
    const rel = files.find((p) => f.pathPattern.test(p));
    if (!rel) continue;
    const abs = path.join(repoDir, rel);
    items.push({ key: f.key, file: rel, line: 1, snippet: fs.readFileSync(abs, "utf8").split("\n", 1)[0].trim() });
  }
  return items;
}

function webEntryPoints(repoDir: string): SurfaceItem[] {
  const file = readSource(repoDir, "src/Types/CardThemeType.res");
  const arms = switchStringArms(topLevelLet(file, "getPaymentMode"));
  return requireAtLeast(
    arms.map((a) => ({ key: a.key, file: file.rel, line: lineAt(file.text, a.offset), snippet: lineTextAt(file.text, a.offset) })),
    5,
    "web entry points (getPaymentMode)",
  );
}

function mobileEntryPoints(repoDir: string): SurfaceItem[] {
  const file = readSource(repoDir, "src/types/SdkTypes.res");
  const arms = [
    ...switchStringArms(topLevelLet(file, "parseSdkState")),
    ...switchStringArms(topLevelLet(file, "parsePmmState")),
  ];
  return requireAtLeast(
    arms.map((a) => ({ key: a.key, file: file.rel, line: lineAt(file.text, a.offset), snippet: lineTextAt(file.text, a.offset) })),
    5,
    "mobile entry points (parseSdkState/parsePmmState)",
  );
}
