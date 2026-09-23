/**
 * Decide, before any agent runs, whether a gap is worth patching at all.
 *
 * The worst patch run on record (LEARNINGS iteration 9, `payment_method_order`)
 * spent 12 minutes, built green, passed the verifier — and rewrote working
 * code, because the "gap" was a false positive. Nothing checked whether there
 * was anything to do. This gate does, with zero model calls:
 *
 *  1. The row must be verified and not platform-specific. Unverified rows are
 *     candidates, not work items.
 *  2. The gap must still exist in the current checkout. For surface categories
 *     we re-derive that category (well under a second) and refuse if the key is
 *     now declared on the missing side, or the equivalence table now pairs it.
 */

import { REPOS } from "../config.js";
import type { GapRow } from "../db.js";
import { diffSurface, SURFACE_CATEGORIES, type SurfaceCategory } from "./surface/index.js";
import { extractBackendApiSurface } from "./surface/backendApi.js";
import { extractComponentSurface } from "./surface/components.js";
import { extractConfigSurface } from "./surface/config.js";
import { extractPaymentFlowSurface } from "./surface/paymentFlows.js";
import { compareKey } from "./surface/equivalences.js";

export type PatchGateResult =
  | { ok: true }
  | { ok: false; status: 409 | 422; code: "GAP_NOT_VERIFIED" | "GAP_PLATFORM_SPECIFIC" | "GAP_CLOSED"; error: string };

const EXTRACT = {
  config: extractConfigSurface,
  backend_api: extractBackendApiSurface,
  component: extractComponentSurface,
  payment_method: extractPaymentFlowSurface,
} as const;

export function checkPatchable(
  gap: GapRow,
  dirs: { web: string; mobile: string } = { web: REPOS.web.dir, mobile: REPOS.mobile.dir },
): PatchGateResult {
  if (gap.platform_specific === 1) {
    return {
      ok: false,
      status: 422,
      code: "GAP_PLATFORM_SPECIFIC",
      error: `"${gap.canonical_name}" is platform-specific: ${gap.rationale.replace(/^Platform-specific:\s*/i, "")}`,
    };
  }
  if (gap.verified !== 1) {
    return {
      ok: false,
      status: 422,
      code: "GAP_NOT_VERIFIED",
      error: `"${gap.canonical_name}" is an unverified candidate. Run Verify first — patching an unconfirmed gap risks rewriting code that already works.`,
    };
  }

  if (!(SURFACE_CATEGORIES as string[]).includes(gap.category)) return { ok: true }; // legacy rows
  const category = gap.category as SurfaceCategory;
  const missingIn = gap.missing_in as "web" | "mobile";

  const diff = diffSurface(category, { web: EXTRACT[category]("web", dirs.web), mobile: EXTRACT[category]("mobile", dirs.mobile) }, dirs);
  if (diff.gaps.some((g) => g.canonicalName === gap.canonical_name && g.missingIn === missingIn)) return { ok: true };

  // Closed. Say why, with evidence, so nobody has to rediscover it.
  const declaredKey = safeKey(gap) ?? gap.canonical_name;
  const nowThere = diff.surface[missingIn].find((i) => compareKey(category, i.key) === compareKey(category, declaredKey));
  const where = nowThere
    ? `it is now declared in ${missingIn} at ${nowThere.file}:${nowThere.line} (${nowThere.snippet})`
    : `the equivalence table now pairs it with an existing ${missingIn} feature`;
  return {
    ok: false,
    status: 409,
    code: "GAP_CLOSED",
    error: `"${gap.canonical_name}" is no longer a gap: ${where}. Re-run analysis to refresh the table.`,
  };
}

/** The declared key recorded as evidence[0].name by surface analysis. */
function safeKey(gap: GapRow): string | null {
  try {
    const ev = JSON.parse(gap.evidence) as Array<{ name?: string }>;
    return ev[0]?.name ?? null;
  } catch {
    return null;
  }
}
