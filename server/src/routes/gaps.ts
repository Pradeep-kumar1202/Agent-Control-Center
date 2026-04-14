import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { getValidateCache, putValidateCache } from "../cache.js";
import { MODEL_REASON, REPOS, type RepoKey } from "../config.js";
import { db, nowIso, type GapPrRow, type GapRow, type PatchRow } from "../db.js";
import { askJson } from "../llm.js";
import { syncAllRepos } from "../workspace/repoManager.js";
import { PROJECT_ROOT } from "../config.js";

export const gapsRouter = Router();

interface VerdictPayload {
  verdict: "confirmed" | "false_positive" | "platform_specific";
  found_in_missing?: string;
  severity: "low" | "medium" | "high";
  rationale: string;
}

/**
 * Lazy per-gap validator. Runs Opus + Read/Grep/Glob inside the "missing"
 * repo and either marks the row verified=1 (with updated severity/rationale),
 * marks it platform_specific, or deletes it if Opus finds it's a false positive.
 *
 * Results are cached by (missing_repo_sha, canonical_name) so re-clicking
 * Verify on the same gap at the same repo SHA is free.
 */
gapsRouter.post("/gaps/:id/validate", async (req, res) => {
  const gapId = Number(req.params.id);
  if (!Number.isFinite(gapId)) {
    return res.status(400).json({ error: "bad id" });
  }

  const gap = db.prepare(`SELECT * FROM gaps WHERE id = ?`).get(gapId) as
    | GapRow
    | undefined;
  if (!gap) return res.status(404).json({ error: "gap not found" });

  try {
    const repos = await syncAllRepos();
    const missingRepo = gap.missing_in as RepoKey;
    const missingSha = repos[missingRepo].sha;

    let verdict = getValidateCache<VerdictPayload>(
      missingRepo,
      missingSha,
      gap.canonical_name,
    );

    if (!verdict) {
      verdict = await validateOne(gap, missingRepo);
      putValidateCache(missingRepo, missingSha, gap.canonical_name, verdict);
    }

    if (verdict.verdict === "false_positive") {
      // Persist the dismissal so re-runs never re-insert this gap
      db.prepare(
        `INSERT OR REPLACE INTO dismissed_gaps
           (category, canonical_name, missing_in, reason, found_in_missing, dismissed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        gap.category,
        gap.canonical_name,
        gap.missing_in,
        verdict.rationale,
        verdict.found_in_missing ?? null,
        new Date().toISOString(),
      );
      db.prepare(`DELETE FROM gaps WHERE id = ?`).run(gapId);
      return res.json({
        verdict: verdict.verdict,
        removed: true,
        found_in_missing: verdict.found_in_missing,
        rationale: verdict.rationale,
      });
    }

    db.prepare(
      `UPDATE gaps
         SET verified = 1,
             rationale = ?,
             severity = ?,
             platform_specific = ?
       WHERE id = ?`,
    ).run(
      verdict.rationale,
      verdict.severity,
      verdict.verdict === "platform_specific" ? 1 : 0,
      gapId,
    );

    const updated = db
      .prepare(`SELECT * FROM gaps WHERE id = ?`)
      .get(gapId) as GapRow;
    res.json({
      verdict: verdict.verdict,
      removed: false,
      gap: { ...updated, evidence: safeParse(updated.evidence) },
    });
  } catch (err) {
    console.error(`[gaps/validate] failed for ${gapId}:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /gaps/:id/source — return the reference implementation source code */
gapsRouter.get("/gaps/:id/source", async (req, res) => {
  const gapId = Number(req.params.id);
  if (!Number.isFinite(gapId)) {
    return res.status(400).json({ error: "bad id" });
  }

  const gap = db.prepare(`SELECT * FROM gaps WHERE id = ?`).get(gapId) as
    | GapRow
    | undefined;
  if (!gap) return res.status(404).json({ error: "gap not found" });

  const presentRepo = gap.present_in as RepoKey;
  const repoDir = REPOS[presentRepo].dir;
  const evidence = safeParse(gap.evidence) as Array<{ name?: string; file?: string; snippet?: string }> | null;
  const filePath = evidence?.[0]?.file;

  if (!filePath) {
    return res.json({ file: null, content: null, repo: presentRepo });
  }

  const fs = await import("node:fs");
  const path = await import("node:path");
  const fullPath = path.join(repoDir, filePath);
  let content = "";
  try {
    content = fs.readFileSync(fullPath, "utf8");
    // Cap at 15KB for the viewer
    if (content.length > 15000) {
      content = content.slice(0, 15000) + "\n\n... [truncated at 15KB]";
    }
  } catch {
    content = `(could not read file: ${filePath})`;
  }

  res.json({ file: filePath, content, repo: presentRepo });
});

async function validateOne(
  gap: GapRow,
  missingRepo: RepoKey,
): Promise<VerdictPayload> {
  const cwd = REPOS[missingRepo].dir;
  const repoLabel =
    missingRepo === "web"
      ? "hyperswitch-web (the web SDK)"
      : "hyperswitch-client-core (the mobile SDK)";
  const evidence = safeParse(gap.evidence) as Array<{ file?: string }> | null;
  const otherFile = evidence?.[0]?.file ?? "unknown";

  const prompt = `You are validating ONE claimed feature gap in ${repoLabel}.

Your current working directory IS the ${missingRepo} repo. You have Glob, Grep, and Read tools — USE THEM. Do not guess. Actually look.

Claim: feature "${gap.canonical_name}" (category: ${gap.category}) is present in the OTHER repo at ${otherFile}, and the gap-finder thinks it's MISSING here.

Important context about the mobile repo (hyperswitch-client-core): payment methods there are rendered dynamically from backend responses — you will NOT find payment method names hardcoded in source. If the claim is a payment method and you're searching in the mobile repo, treat it as "platform_specific" because the mobile SDK gets its payment method list from the backend at runtime.

Instructions:
  1. Use Glob/Grep to look for the feature under that name OR any plausible alias, abbreviation, or synonym.
  2. Open files with Read if you need to confirm.
  3. Decide ONE verdict:
      "confirmed"         - feature is genuinely absent from this repo
      "false_positive"    - you found it (under this name or another). Set found_in_missing to the file path.
      "platform_specific" - the feature inherently cannot exist in this platform, OR it's a dynamic backend-driven feature (like payment methods in mobile).

Severity guidance:
  high   = core payment flow / common payment method / important config
  medium = useful integrator config or secondary widget
  low    = edge case, minor cosmetic option, or rarely-used endpoint

Output ONLY a JSON object — no prose, no code fences:

{"verdict":"confirmed|false_positive|platform_specific","found_in_missing":"<path or omit>","severity":"low|medium|high","rationale":"<≤200 chars>"}`;

  const result = await askJson<VerdictPayload>(prompt, {
    model: MODEL_REASON,
    timeoutMs: 300_000,
    cwd,
    allowedTools: ["Glob", "Grep", "Read"],
  });

  return result;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─── PR link routes ───────────────────────────────────────────────────────────

/** GET /gap-prs — all PR links, returned as array */
gapsRouter.get("/gap-prs", (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM gap_prs ORDER BY added_at ASC`)
    .all() as GapPrRow[];
  res.json(rows);
});

/** POST /gaps/:id/pr — attach a PR URL to a gap */
gapsRouter.post("/gaps/:id/pr", (req, res) => {
  const gapId = Number(req.params.id);
  if (!Number.isFinite(gapId)) {
    return res.status(400).json({ error: "bad id" });
  }

  const gap = db.prepare(`SELECT * FROM gaps WHERE id = ?`).get(gapId) as
    | GapRow
    | undefined;
  if (!gap) return res.status(404).json({ error: "gap not found" });

  const { pr_url } = req.body as { pr_url?: string };
  if (!pr_url || !pr_url.startsWith("http")) {
    return res.status(400).json({ error: "pr_url must be a valid URL" });
  }

  // Deduplicate: don't add the same URL twice for the same gap identity
  const existing = db
    .prepare(
      `SELECT id FROM gap_prs
       WHERE canonical_name = ? AND category = ? AND missing_in = ? AND pr_url = ?`,
    )
    .get(gap.canonical_name, gap.category, gap.missing_in, pr_url);
  if (existing) {
    return res.status(409).json({ error: "PR already linked to this gap" });
  }

  const info = db
    .prepare(
      `INSERT INTO gap_prs (canonical_name, category, missing_in, pr_url, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(gap.canonical_name, gap.category, gap.missing_in, pr_url, nowIso());

  const row = db
    .prepare(`SELECT * FROM gap_prs WHERE id = ?`)
    .get(info.lastInsertRowid) as GapPrRow;
  res.status(201).json(row);
});

/** DELETE /gap-prs/:prId — remove a PR link */
gapsRouter.delete("/gap-prs/:prId", (req, res) => {
  const prId = Number(req.params.prId);
  if (!Number.isFinite(prId)) {
    return res.status(400).json({ error: "bad id" });
  }
  const info = db.prepare(`DELETE FROM gap_prs WHERE id = ?`).run(prId);
  if (info.changes === 0) return res.status(404).json({ error: "not found" });
  res.json({ deleted: true });
});

/**
 * POST /analysis/seed-reset
 *
 * Clears all analysis data (reports + gaps, cascading to patches) and
 * re-populates from the seed files (seed/verified-gaps.json).
 *
 * Patches are preserved by re-linking them to the new gap IDs via
 * canonical_name + category + missing_in matching.
 */
gapsRouter.post("/analysis/seed-reset", (_req, res) => {
  const seedDir = path.join(PROJECT_ROOT, "seed");
  const verifiedPath = path.join(seedDir, "verified-gaps.json");

  if (!fs.existsSync(verifiedPath)) {
    return res.status(400).json({ error: "seed/verified-gaps.json not found" });
  }

  let seedGaps: Array<Record<string, unknown>>;
  try {
    seedGaps = JSON.parse(fs.readFileSync(verifiedPath, "utf8"));
  } catch (err) {
    return res.status(500).json({ error: `Failed to parse seed file: ${(err as Error).message}` });
  }

  try {
    let gapsInserted = 0;
    let patchesRelinked = 0;
    let patchesOrphaned = 0;

    db.transaction(() => {
      // 1. Save all existing patches before deletion (cascade will remove them)
      const existingPatches = db
        .prepare(
          `SELECT p.*, g.canonical_name AS gap_canonical_name, g.category AS gap_category, g.missing_in AS gap_missing_in
           FROM patches p
           LEFT JOIN gaps g ON g.id = p.gap_id`,
        )
        .all() as Array<PatchRow & { gap_canonical_name: string; gap_category: string; gap_missing_in: string }>;

      // 2. Delete all reports → cascades to gaps → cascades to patches
      db.prepare("DELETE FROM reports").run();

      // 3. Insert a new seed report
      const reportId = db
        .prepare(`INSERT INTO reports (created_at, web_sha, mobile_sha, status) VALUES (?, 'seed', 'seed', 'done')`)
        .run(nowIso()).lastInsertRowid as number;

      // 4. Insert seed gaps and track canonical_name → new gap id
      const nameToId = new Map<string, number>();
      const insertGap = db.prepare(
        `INSERT INTO gaps (report_id, category, canonical_name, missing_in, present_in, evidence, rationale, severity, platform_specific, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of seedGaps) {
        const gapId = insertGap.run(
          reportId,
          g.category,
          g.canonical_name,
          g.missing_in,
          g.present_in,
          g.evidence,
          g.rationale,
          g.severity,
          g.platform_specific ?? 0,
          g.verified ?? 1,
        ).lastInsertRowid as number;
        nameToId.set(`${String(g.canonical_name)}:${String(g.category)}:${String(g.missing_in)}`, gapId);
        gapsInserted++;
      }

      // 5. Re-insert patches linked to new gap IDs
      const insertPatch = db.prepare(
        `INSERT INTO patches (gap_id, repo, branch, diff_path, summary, files_touched, status, created_at, build_status, build_log, pr_url, pr_number, pr_warning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of existingPatches) {
        const key = `${p.gap_canonical_name}:${p.gap_category}:${p.gap_missing_in}`;
        const newGapId = nameToId.get(key);
        if (newGapId !== undefined) {
          insertPatch.run(
            newGapId,
            p.repo,
            p.branch,
            p.diff_path,
            p.summary,
            p.files_touched,
            p.status,
            p.created_at,
            p.build_status,
            p.build_log,
            p.pr_url,
            p.pr_number,
            p.pr_warning,
          );
          patchesRelinked++;
        } else {
          patchesOrphaned++;
        }
      }
    })();

    res.json({
      message: "Seed reset complete",
      gapsInserted,
      patchesRelinked,
      patchesOrphaned,
    });
  } catch (err) {
    console.error("[seed-reset] error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
