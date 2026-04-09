import {
  cacheStats,
  getExtractCache,
  getNormalizeCache,
  putExtractCache,
  putNormalizeCache,
  resetCacheStats,
} from "../cache.js";
import { db, nowIso, type GapRow } from "../db.js";
import { syncAllRepos } from "../workspace/repoManager.js";
import { extractBackendApis } from "./extractors/backendApis.js";
import { extractConfigProps } from "./extractors/configProps.js";
import { extractPaymentMethods } from "./extractors/paymentMethods.js";
import { extractUiComponents } from "./extractors/uiComponents.js";
import { isStructuralFalsePositive, prefilter } from "./filter.js";
import { normalizeCategory, type CanonicalFeature } from "./normalize.js";
import type { Category, ExtractedFeature } from "./types.js";

export interface AnalysisResult {
  reportId: number;
  webSha: string;
  mobileSha: string;
  gapCount: number;
  gapCountByCategory: Record<Category, number>;
  durationMs: number;
  passCounts: {
    raw: number;
    afterPrefilter: number;
    afterNormalize: number;
  };
}

type ExtractorFn = (repo: "web" | "mobile") => Promise<ExtractedFeature[]>;

const EXTRACTORS: Array<{ category: Category; fn: ExtractorFn }> = [
  { category: "payment_method", fn: extractPaymentMethods },
  { category: "config", fn: extractConfigProps },
  { category: "component", fn: extractUiComponents },
  { category: "backend_api", fn: extractBackendApis },
];

/**
 * Pipeline:
 *   1. Sync repos
 *   2. Extract per-category × per-repo (8 parallel Sonnet calls, cached by SHA)
 *   3. Normalize per-category (4 Sonnet calls, cached by SHA)
 *   4. Derive claimed gaps from normalized rows (one side null)
 *   5. Insert all claimed gaps with verified=0
 *
 * Validation (Opus + tools) is lazy — triggered per-gap via POST /gaps/:id/validate.
 */
export async function runAnalysis(): Promise<AnalysisResult> {
  const t0 = Date.now();
  const repos = await syncAllRepos();

  const reportId = (
    db
      .prepare(
        `INSERT INTO reports (created_at, web_sha, mobile_sha, status)
         VALUES (?, ?, ?, 'running')`,
      )
      .run(nowIso(), repos.web.sha, repos.mobile.sha).lastInsertRowid as number
  );

  try {
    resetCacheStats();

    // -------- Pass 1: extract (with disk cache keyed by repo SHA) --------
    const cachedOrFresh = async (
      category: Category,
      fn: ExtractorFn,
      repo: "web" | "mobile",
    ): Promise<ExtractedFeature[]> => {
      const sha = repos[repo].sha;
      const hit = getExtractCache<ExtractedFeature[]>(repo, sha, category);
      if (hit) {
        console.log(`[cache] hit extract ${category}/${repo}`);
        return hit;
      }
      const result = await fn(repo);
      putExtractCache(repo, sha, category, result);
      return result;
    };

    const calls = EXTRACTORS.flatMap(({ category, fn }) => [
      cachedOrFresh(category, fn, "web").then((r) => ({
        category,
        repo: "web" as const,
        result: r,
      })),
      cachedOrFresh(category, fn, "mobile").then((r) => ({
        category,
        repo: "mobile" as const,
        result: r,
      })),
    ]);
    const settled = await Promise.allSettled(calls);

    const byCategory: Record<
      Category,
      { web: ExtractedFeature[]; mobile: ExtractedFeature[] }
    > = {
      payment_method: { web: [], mobile: [] },
      config: { web: [], mobile: [] },
      component: { web: [], mobile: [] },
      backend_api: { web: [], mobile: [] },
    };
    for (const s of settled) {
      if (s.status === "fulfilled") {
        const { category, repo, result } = s.value;
        byCategory[category][repo] = result;
      } else {
        console.error(`[analyze] extractor failed:`, s.reason);
      }
    }

    const rawCount = Object.values(byCategory).reduce(
      (n, c) => n + c.web.length + c.mobile.length,
      0,
    );

    // -------- Pass 1.5: deterministic prefilter (no LLM) --------
    // Collapses sub-key groups (appearance_*, layout_*, wallets_*, etc.),
    // drops generic UI primitives and per-input styling cruft. Rules live
    // in analyzer/filter.ts and are derived from real cached extract output.
    // Filter runs AFTER cache so tuning rules doesn't invalidate extract.
    let afterPrefilter = 0;
    for (const category of Object.keys(byCategory) as Category[]) {
      const bucket = byCategory[category];
      const web = prefilter(bucket.web, category);
      const mobile = prefilter(bucket.mobile, category);
      bucket.web = web.filtered;
      bucket.mobile = mobile.filtered;
      afterPrefilter += bucket.web.length + bucket.mobile.length;
    }
    console.log(
      `[analyze] prefilter: ${rawCount} → ${afterPrefilter} features`,
    );

    // -------- Pass 2: normalize per category (Opus, no tools) --------
    const normalized: Record<Category, CanonicalFeature[]> = {
      payment_method: [],
      config: [],
      component: [],
      backend_api: [],
    };
    await Promise.all(
      EXTRACTORS.map(async ({ category }) => {
        const { web, mobile } = byCategory[category];
        const hit = getNormalizeCache<CanonicalFeature[]>(
          category,
          repos.web.sha,
          repos.mobile.sha,
        );
        if (hit) {
          console.log(`[cache] hit normalize ${category}`);
          normalized[category] = hit;
          return;
        }
        try {
          const result = await normalizeCategory(category, web, mobile);
          normalized[category] = result;
          putNormalizeCache(category, repos.web.sha, repos.mobile.sha, result);
        } catch (err) {
          console.error(
            `[analyze] normalize failed for ${category}:`,
            (err as Error).message,
          );
          // Fallback: pair-by-name with a string-norm key.
          normalized[category] = naivePairs(web, mobile);
        }
      }),
    );

    const afterNormalize = Object.values(normalized).reduce(
      (n, c) => n + c.length,
      0,
    );

    // -------- Pass 3: derive claimed gaps --------
    const gaps: GapInsert[] = [];
    const counts: Record<Category, number> = {
      payment_method: 0,
      config: 0,
      component: 0,
      backend_api: 0,
    };

    let structuralFps = 0;
    for (const category of Object.keys(normalized) as Category[]) {
      for (const f of normalized[category]) {
        if (f.web && !f.mobile) {
          if (isStructuralFalsePositive(category, "mobile")) {
            structuralFps++;
            continue;
          }
          gaps.push({
            category,
            canonical_name: f.canonical_name,
            missing_in: "mobile",
            present_in: "web",
            evidence: [f.web],
            rationale: f.rationale,
            severity: "medium",
            platform_specific: 0,
            verified: 0,
          });
          counts[category]++;
        } else if (f.mobile && !f.web) {
          if (isStructuralFalsePositive(category, "web")) {
            structuralFps++;
            continue;
          }
          gaps.push({
            category,
            canonical_name: f.canonical_name,
            missing_in: "web",
            present_in: "mobile",
            evidence: [f.mobile],
            rationale: f.rationale,
            severity: "medium",
            platform_specific: 0,
            verified: 0,
          });
          counts[category]++;
        }
      }
    }
    if (structuralFps > 0) {
      console.log(
        `[analyze] dropped ${structuralFps} structural false positives (mobile loads payment methods dynamically)`,
      );
    }
    console.log(`[analyze] ${gaps.length} gaps derived after normalize`);

    const stats = cacheStats();
    console.log(`[cache] hits=${stats.hits} misses=${stats.misses}`);

    insertGaps(reportId, gaps);
    db.prepare(`UPDATE reports SET status = 'done' WHERE id = ?`).run(reportId);

    return {
      reportId,
      webSha: repos.web.sha,
      mobileSha: repos.mobile.sha,
      gapCount: gaps.length,
      gapCountByCategory: counts,
      durationMs: Date.now() - t0,
      passCounts: {
        raw: rawCount,
        afterPrefilter,
        afterNormalize,
      },
    };
  } catch (err) {
    db.prepare(
      `UPDATE reports SET status = 'failed', error = ? WHERE id = ?`,
    ).run((err as Error).message, reportId);
    throw err;
  }
}

type GapInsert = Omit<GapRow, "id" | "report_id" | "evidence"> & {
  evidence: ExtractedFeature[];
};

function insertGaps(reportId: number, gaps: GapInsert[]) {
  // Look up previously verified gaps so we can carry forward Opus verdicts.
  // Key: "category|canonical_name|missing_in" → previous gap row
  const previousVerified = new Map<string, GapRow>();
  const prevRows = db
    .prepare(
      `SELECT * FROM gaps
       WHERE verified = 1 OR platform_specific = 1
       ORDER BY id DESC`,
    )
    .all() as GapRow[];
  for (const row of prevRows) {
    const key = `${row.category}|${row.canonical_name}|${row.missing_in}`;
    if (!previousVerified.has(key)) {
      previousVerified.set(key, row);
    }
  }

  // Load permanently dismissed gaps (false positives confirmed by Opus).
  // These survive across SHA changes so we never waste tokens re-verifying.
  const dismissedGaps = new Set<string>();
  const dismissedRows = db
    .prepare(`SELECT category, canonical_name, missing_in FROM dismissed_gaps`)
    .all() as Array<{ category: string; canonical_name: string; missing_in: string }>;
  for (const d of dismissedRows) {
    dismissedGaps.add(`${d.category}|${d.canonical_name}|${d.missing_in}`);
  }

  const stmt = db.prepare(
    `INSERT INTO gaps
       (report_id, category, canonical_name, missing_in, present_in,
        evidence, rationale, severity, platform_specific, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let carried = 0;
  let dismissed = 0;
  const tx = db.transaction((rows: GapInsert[]) => {
    for (const g of rows) {
      const key = `${g.category}|${g.canonical_name}|${g.missing_in}`;

      // Skip gaps that were permanently dismissed as false positives
      if (dismissedGaps.has(key)) {
        dismissed++;
        continue;
      }

      const prev = previousVerified.get(key);
      const verified = prev ? 1 : 0;
      const severity = prev ? prev.severity : g.severity;
      const rationale = prev ? prev.rationale : g.rationale;
      const platformSpecific = prev ? prev.platform_specific : g.platform_specific;
      if (prev) carried++;

      stmt.run(
        reportId,
        g.category,
        g.canonical_name,
        g.missing_in,
        g.present_in,
        JSON.stringify(g.evidence),
        rationale,
        severity,
        platformSpecific,
        verified,
      );
    }
  });
  tx(gaps);
  if (carried > 0) {
    console.log(
      `[analyze] carried forward ${carried} verified/platform-specific verdicts from previous runs`,
    );
  }
  if (dismissed > 0) {
    console.log(
      `[analyze] skipped ${dismissed} previously dismissed false positives`,
    );
  }
}

/**
 * Fallback pairing used if Opus normalize fails for a category — collapses
 * by string key only, no near-duplicate merging.
 */
function naivePairs(
  web: ExtractedFeature[],
  mobile: ExtractedFeature[],
): CanonicalFeature[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set<string>();
  const out: CanonicalFeature[] = [];
  const webMap = new Map(web.map((f) => [norm(f.name), f]));
  const mobileMap = new Map(mobile.map((f) => [norm(f.name), f]));

  for (const [k, f] of webMap) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      canonical_name: f.name,
      web: f,
      mobile: mobileMap.get(k) ?? null,
      rationale: "fallback naive pairing",
    });
  }
  for (const [k, f] of mobileMap) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      canonical_name: f.name,
      web: null,
      mobile: f,
      rationale: "fallback naive pairing",
    });
  }
  return out;
}
