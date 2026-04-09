import { Router } from "express";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PATCHES_DIR, REPOS, type RepoKey } from "../config.js";
import { db, nowIso, type GapRow } from "../db.js";
import { ask } from "../llm.js";
import simpleGit from "simple-git";

export const patchesRouter = Router();

/**
 * Generate a patch for a verified gap. Steps:
 *
 *   1. Look up the gap. If not verified, run validation first.
 *   2. Read evidence from the "present" repo to understand the feature.
 *   3. Create a branch in the "missing" repo.
 *   4. Ask Opus to implement the feature (with Edit/Write/Read/Glob/Grep).
 *   5. `git diff` the result into a .patch file.
 *   6. Reset the branch so the working tree is clean.
 *   7. Return patch metadata + diff content.
 */
patchesRouter.post("/gaps/:id/patch", async (req, res) => {
  const gapId = Number(req.params.id);
  if (!Number.isFinite(gapId)) {
    return res.status(400).json({ error: "bad id" });
  }

  const gap = db.prepare("SELECT * FROM gaps WHERE id = ?").get(gapId) as
    | GapRow
    | undefined;
  if (!gap) return res.status(404).json({ error: "gap not found" });

  // Already has a patch? Check both by exact gap_id and by identity
  // (canonical_name + category + missing_in) to catch cross-report matches.
  const existing = db
    .prepare(
      `SELECT p.* FROM patches p
       WHERE p.gap_id = ?
       UNION
       SELECT p.* FROM patches p
       JOIN gaps g ON g.id = p.gap_id
       WHERE g.canonical_name = ? AND g.category = ? AND g.missing_in = ?
       LIMIT 1`,
    )
    .get(gapId, gap.canonical_name, gap.category, gap.missing_in);
  if (existing) {
    return res.status(409).json({ error: "patch already exists", patch: existing });
  }

  const targetRepo = gap.missing_in as RepoKey;
  const sourceRepo = gap.present_in as RepoKey;
  const targetDir = REPOS[targetRepo].dir;
  const sourceDir = REPOS[sourceRepo].dir;

  try {
    // ---- Read feature context from source repo ----
    const evidence = safeParseEvidence(gap.evidence);
    const sourceFile = evidence?.[0]?.file;
    let sourceContext = "";
    if (sourceFile) {
      const fullPath = path.join(sourceDir, sourceFile);
      try {
        sourceContext = fs.readFileSync(fullPath, "utf8");
        // Truncate large files to avoid bloating the prompt
        if (sourceContext.length > 8000) {
          sourceContext = sourceContext.slice(0, 8000) + "\n... [truncated]";
        }
      } catch {
        sourceContext = `(could not read ${sourceFile})`;
      }
    }

    // ---- Create branch in target repo ----
    const git = simpleGit(targetDir);
    const slug = gap.canonical_name
      .replace(/[^a-z0-9]+/gi, "-")
      .slice(0, 40)
      .replace(/-$/, "");
    const branchName = `feat/gap-${gapId}-${slug}`;

    // Ensure clean working tree
    await git.raw(["checkout", "--force", "HEAD"]);
    const defaultBranch = (await git.branch()).current || "main";

    // Delete old branch if it exists (from a previous failed attempt)
    try {
      await git.deleteLocalBranch(branchName, true);
    } catch {
      /* didn't exist */
    }

    await git.checkoutLocalBranch(branchName);

    // ---- Ask Opus to implement the feature ----
    const repoLabel =
      targetRepo === "web"
        ? "hyperswitch-web (ReScript web SDK)"
        : "hyperswitch-client-core (ReScript mobile SDK)";
    const sourceLabel =
      sourceRepo === "web"
        ? "hyperswitch-web (ReScript web SDK)"
        : "hyperswitch-client-core (ReScript mobile SDK)";

    const prompt = `You are implementing a missing feature in the ${repoLabel} repository.

Your current working directory IS the ${targetRepo} repo: ${targetDir}
You have Edit, Write, Read, Glob, and Grep tools.

## Feature to implement

Feature name: ${gap.canonical_name}
Category: ${gap.category}
Rationale: ${gap.rationale}

This feature exists in ${sourceLabel} but is MISSING here.

## Reference implementation (from ${sourceRepo} repo)

File: ${sourceFile ?? "unknown"}

\`\`\`
${sourceContext || "(no source context available)"}
\`\`\`

## Instructions

1. First use Glob and Grep to understand the existing code structure and conventions in THIS repo.
2. Find the right location to add the feature — follow the repo's existing patterns.
3. Implement the feature idiomatically for this repo's architecture.
4. Only touch files that are necessary. Do NOT refactor unrelated code.
5. Do NOT add tests unless the repo has an existing test pattern for similar features.
6. Keep the implementation minimal but functional.

Important:
- This is a ${targetRepo === "web" ? "ReScript" : "ReScript"} codebase.
- Follow the naming conventions already used in this repo.
- If the feature requires backend API integration, add the API call structure but use placeholder endpoints matching the repo's existing patterns.

After implementing, output ONLY a JSON summary (no code fences, no extra text) in this exact format:

{"what": "<one-line description of the feature added>", "files": [{"path": "<relative file path>", "change": "<brief description of what changed in this file>"}], "backward_compatible": true, "notes": "<optional: any caveats, defaults, or integration notes>"}

Example:
{"what": "Added hideExpiredPaymentMethods config option", "files": [{"path": "src/types/SdkTypes.res", "change": "Added field to configurationType record, parsed from config dict (default: false)"}], "backward_compatible": true, "notes": "Defaults to false, existing integrations unaffected"}`;

    const summary = await ask(prompt, {
      model: "opus",
      timeoutMs: 600_000,
      cwd: targetDir,
      allowedTools: ["Edit", "Write", "Read", "Glob", "Grep"],
    });

    // ---- Capture diff ----
    const diff = await git.diff();
    const diffStat = await git.diffSummary();

    if (!diff || diffStat.files.length === 0) {
      // Opus didn't change any files — reset and bail
      await git.checkout(defaultBranch);
      try {
        await git.deleteLocalBranch(branchName, true);
      } catch { /* */ }
      return res.status(422).json({
        error: "Opus did not produce any file changes",
        summary,
      });
    }

    // Save .patch file
    const patchFileName = `${gapId}-${slug}.patch`;
    const patchPath = path.join(PATCHES_DIR, patchFileName);
    fs.writeFileSync(patchPath, diff);

    // Commit changes on the branch so the diff is preserved
    await git.add(".");
    await git.commit(`feat: add ${gap.canonical_name}\n\nGenerated by feature-gap-dashboard for gap #${gapId}`);

    // ---- Build check ----
    let buildStatus: "pass" | "fail" | "skipped" = "skipped";
    let buildLog = "";

    const hasNodeModules = fs.existsSync(path.join(targetDir, "node_modules"));
    if (hasNodeModules) {
      try {
        const output = execSync("npx rescript build 2>&1", {
          cwd: targetDir,
          timeout: 120_000,
          encoding: "utf8",
        });
        buildStatus = "pass";
        buildLog = output.slice(-2000);
      } catch (err) {
        buildStatus = "fail";
        const e = err as { stdout?: string; stderr?: string; message?: string };
        buildLog = ((e.stdout ?? "") + "\n" + (e.stderr ?? "") + "\n" + (e.message ?? "")).slice(-2000);
      }
    } else {
      buildLog = "Skipped: node_modules not installed. Run `npm install` in the workspace repo to enable build checks.";
    }

    // Switch back to default branch (leave the feature branch intact)
    await git.checkout(defaultBranch);

    // ---- Save to DB ----
    const patchRow = db
      .prepare(
        `INSERT INTO patches (gap_id, repo, branch, diff_path, summary, files_touched, status, created_at, build_status, build_log)
         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?)`,
      )
      .run(
        gapId,
        targetRepo,
        branchName,
        patchPath,
        summary.slice(0, 2000),
        diffStat.files.length,
        nowIso(),
        buildStatus,
        buildLog,
      );

    res.json({
      patchId: patchRow.lastInsertRowid,
      branch: branchName,
      repo: targetRepo,
      filesTouched: diffStat.files.length,
      summary: summary.slice(0, 2000),
      diff,
      buildStatus,
      buildLog,
    });
  } catch (err) {
    console.error(`[patches] failed for gap ${gapId}:`, err);

    // Try to clean up: go back to default branch
    try {
      const git = simpleGit(targetDir);
      const defaultBranch = (await git.branch()).current || "main";
      if (defaultBranch.startsWith("feat/")) {
        await git.raw(["checkout", "--force", "main"]);
      }
    } catch { /* best effort */ }

    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /patches/:id — return patch metadata + diff content */
patchesRouter.get("/patches/:id", async (req, res) => {
  const patchId = Number(req.params.id);
  const row = db.prepare("SELECT * FROM patches WHERE id = ?").get(patchId) as
    | { id: number; gap_id: number; repo: string; branch: string; diff_path: string; summary: string; files_touched: number; status: string; created_at: string }
    | undefined;

  if (!row) return res.status(404).json({ error: "patch not found" });

  let diff = "";
  try {
    diff = fs.readFileSync(row.diff_path, "utf8");
  } catch {
    diff = "(patch file not found on disk)";
  }

  res.json({ ...row, diff });
});

/** GET /patches — list all patches, enriched with gap identity for cross-report matching */
patchesRouter.get("/patches", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, g.canonical_name, g.category, g.missing_in
       FROM patches p
       LEFT JOIN gaps g ON g.id = p.gap_id
       ORDER BY p.id DESC LIMIT 50`,
    )
    .all();
  res.json(rows);
});

function safeParseEvidence(s: string): Array<{ name?: string; file?: string; snippet?: string }> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
