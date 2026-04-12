import { Router } from "express";
import { getValidateCache, putValidateCache } from "../cache.js";
import { MODEL_REASON, REPOS, type AnalysisRepoKey } from "../config.js";
import { db, type GapRow } from "../db.js";
import { askJson } from "../llm.js";
import { syncAllRepos } from "../workspace/repoManager.js";

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
    const missingRepo = gap.missing_in as AnalysisRepoKey;
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

  const presentRepo = gap.present_in as AnalysisRepoKey;
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
  missingRepo: AnalysisRepoKey,
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
