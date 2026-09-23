import { db, nowIso, type GapRow } from "../db.js";
import { syncAllRepos } from "../workspace/repoManager.js";
import { analyzeSurfaces, type SurfaceGap } from "./surface/index.js";
import type { Category } from "./types.js";

export interface AnalysisResult {
  reportId: number;
  webSha: string;
  mobileSha: string;
  gapCount: number;
  gapCountByCategory: Record<Category, number>;
  durationMs: number;
  /** Per category: keys declared on each side and how many found a counterpart. */
  surface: Record<string, { web: number; mobile: number; matched: number }>;
  /** Equivalence-table rows that no longer match the code — review and fix. */
  tableWarnings: string[];
}

/**
 * Pipeline (zero model calls):
 *   1. Sync repos.
 *   2. Parse each SDK's declared public surface — config keys, backend
 *      endpoints, entry points + catalogued features (analyzer/surface/).
 *   3. Apply the checked-in equivalence table; every declared key with no
 *      counterpart is a gap, identified by the key itself.
 *   4. Insert, honouring dismissals and carrying forward Verify verdicts.
 *
 * Same SHAs in, same gaps out, in well under a second. A parser that cannot
 * find its declaration throws, and the report is marked failed — a one-sided
 * surface would otherwise turn every feature on the other side into a gap.
 *
 * `payment_method` compares the backend next_action types each SDK can
 * complete, not method names — mobile renders whatever methods the backend
 * lists, but a missing next_action handler breaks every method that needs it.
 *
 * Judgement stays on demand: POST /gaps/:id/validate (Opus + read tools).
 */
export async function runAnalysis(): Promise<AnalysisResult> {
  const t0 = Date.now();
  const repos = await syncAllRepos();

  const reportId = db
    .prepare(
      `INSERT INTO reports (created_at, web_sha, mobile_sha, status)
       VALUES (?, ?, ?, 'running')`,
    )
    .run(nowIso(), repos.web.sha, repos.mobile.sha).lastInsertRowid as number;

  try {
    const diffs = analyzeSurfaces({ web: repos.web.dir, mobile: repos.mobile.dir });

    const surface: AnalysisResult["surface"] = {};
    const gaps: SurfaceGap[] = [];
    for (const d of diffs) {
      surface[d.category] = { web: d.surface.web.length, mobile: d.surface.mobile.length, matched: d.matched };
      gaps.push(...d.gaps);
      for (const e of d.excluded) console.log(`[analyze] excluded ${d.category}/${e.key} (${e.side}): ${e.reason}`);
    }
    const tableWarnings = diffs.flatMap((d) => d.tableWarnings.map((w) => `${d.category}: ${w}`));
    for (const w of tableWarnings) console.warn(`[analyze] equivalence table: ${w}`);

    // Counts describe what was stored, after dismissals — not what was derived.
    const inserted = insertGaps(reportId, gaps);
    const counts: Record<Category, number> = { payment_method: 0, config: 0, component: 0, backend_api: 0 };
    for (const g of inserted) counts[g.category]++;
    db.prepare(`UPDATE reports SET status = 'done' WHERE id = ?`).run(reportId);
    console.log(
      `[analyze] ${inserted.length} gaps stored (${inserted.filter((g) => g.platformSpecific).length} platform-specific, ` +
        `${gaps.length - inserted.length} dismissed) in ${Date.now() - t0} ms`,
    );

    return {
      reportId,
      webSha: repos.web.sha,
      mobileSha: repos.mobile.sha,
      gapCount: inserted.length,
      gapCountByCategory: counts,
      durationMs: Date.now() - t0,
      surface,
      tableWarnings,
    };
  } catch (err) {
    db.prepare(`UPDATE reports SET status = 'failed', error = ? WHERE id = ?`).run((err as Error).message, reportId);
    throw err;
  }
}

/** Inserts the non-dismissed gaps and returns them. */
function insertGaps(reportId: number, gaps: SurfaceGap[]): SurfaceGap[] {
  // Carry forward Verify verdicts by identity. Identities are declared keys
  // now, so they survive unrelated commits instead of drifting with a
  // model's naming.
  const previous = new Map<string, GapRow>();
  for (const row of db
    .prepare(`SELECT * FROM gaps WHERE verified = 1 ORDER BY id DESC`)
    .all() as GapRow[]) {
    const key = `${row.category}|${row.canonical_name}|${row.missing_in}`;
    if (!previous.has(key)) previous.set(key, row);
  }

  const dismissed = new Set(
    (db.prepare(`SELECT category, canonical_name, missing_in FROM dismissed_gaps`).all() as Array<{
      category: string;
      canonical_name: string;
      missing_in: string;
    }>).map((d) => `${d.category}|${d.canonical_name}|${d.missing_in}`),
  );

  const stmt = db.prepare(
    `INSERT INTO gaps
       (report_id, category, canonical_name, missing_in, present_in,
        evidence, rationale, severity, platform_specific, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let carried = 0;
  const inserted: SurfaceGap[] = [];
  db.transaction(() => {
    for (const g of gaps) {
      const key = `${g.category}|${g.canonicalName}|${g.missingIn}`;
      if (dismissed.has(key)) continue;
      inserted.push(g);
      const prev = previous.get(key);
      if (prev) carried++;
      // The equivalence table is authoritative for platform scope: it is
      // reviewed, versioned knowledge. A Verify verdict can add scope but a
      // stale verdict cannot remove what the table now says.
      const platformSpecific = g.platformSpecific || prev?.platform_specific === 1 ? 1 : 0;
      stmt.run(
        reportId,
        g.category,
        g.canonicalName,
        g.missingIn,
        g.presentIn,
        JSON.stringify([
          { name: g.key, file: g.evidence.file, line: g.evidence.line, snippet: g.evidence.snippet },
        ]),
        prev?.rationale ?? g.rationale,
        prev?.severity ?? "medium",
        platformSpecific,
        g.platformSpecific || prev ? 1 : 0,
      );
    }
  })();
  if (carried > 0) console.log(`[analyze] carried forward ${carried} Verify verdicts`);
  return inserted;
}
