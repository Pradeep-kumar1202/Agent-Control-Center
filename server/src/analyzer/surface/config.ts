/**
 * Integrator-facing configuration keys, read from the decoders that
 * actually consume them.
 *
 *   web     src/Types/PaymentType.res   allowedPaymentElementOptions + itemToObjMapper(dict)
 *           src/CardTheme.res           itemToObjMapper — the `elements(...)` options
 *   mobile  src/types/SdkTypes.res      parseConfigurationDict(configObj)
 *           src/types/LayoutTypes.res   parseLayout(configObj)
 *
 * Only top-level keys: nested schemas (layout.*, wallets.*, appearance.*)
 * are compared as their parent key. That matches how integrators think
 * about the options and how the curated seed was judged.
 */

import {
  keysReadFrom,
  lineAt,
  lineTextAt,
  readSource,
  requireAtLeast,
  stringArrayLiterals,
  topLevelLet,
  type KeyHit,
  type SourceFile,
} from "./source.js";
import type { Side, SurfaceItem } from "./types.js";

export function extractConfigSurface(side: Side, repoDir: string): SurfaceItem[] {
  return side === "web" ? webConfig(repoDir) : mobileConfig(repoDir);
}

function webConfig(repoDir: string): SurfaceItem[] {
  const paymentType = readSource(repoDir, "src/Types/PaymentType.res");
  const cardTheme = readSource(repoDir, "src/CardTheme.res");

  const out = new Map<string, SurfaceItem>();
  // Decoder reads are the strongest evidence; add them first so they win.
  addHits(out, paymentType, keysReadFrom(topLevelLet(paymentType, "itemToObjMapper"), "dict"));
  addHits(out, paymentType, stringArrayLiterals(topLevelLet(paymentType, "allowedPaymentElementOptions")));
  // `elements(options)` — appearance, fonts, locale, loader and session inputs.
  addHits(out, cardTheme, stringArrayLiterals(topLevelLet(cardTheme, "itemToObjMapper")));

  return requireAtLeast([...out.values()], 20, "web config keys");
}

function mobileConfig(repoDir: string): SurfaceItem[] {
  const sdkTypes = readSource(repoDir, "src/types/SdkTypes.res");
  const layoutTypes = readSource(repoDir, "src/types/LayoutTypes.res");

  const out = new Map<string, SurfaceItem>();
  addHits(out, sdkTypes, keysReadFrom(topLevelLet(sdkTypes, "parseConfigurationDict"), "configObj"));
  addHits(out, layoutTypes, keysReadFrom(topLevelLet(layoutTypes, "parseLayout"), "configObj"));

  return requireAtLeast([...out.values()], 15, "mobile config keys");
}

function addHits(out: Map<string, SurfaceItem>, file: SourceFile, hits: KeyHit[]): void {
  for (const h of hits) {
    if (out.has(h.key)) continue;
    out.set(h.key, {
      key: h.key,
      file: file.rel,
      line: lineAt(file.text, h.offset),
      snippet: lineTextAt(file.text, h.offset),
    });
  }
}
