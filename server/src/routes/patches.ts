import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { PATCHES_DIR, REPOS, type RepoKey } from "../config.js";
import { db, nowIso, type GapRow } from "../db.js";
import { ask } from "../llm.js";
import simpleGit from "simple-git";
import { commitWithSubmodules, getDiffWithSubmodules, resetSubmodules, forceCheckoutBranch } from "../skills/submoduleGit.js";
import { runRescriptBuild } from "../skills/buildCheck.js";
import { pushBranchToFork, createPullRequest, formatPrBody, pushSubmoduleToFork, rewriteGitmodulesToForks } from "../skills/githubPr.js";

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

    // Always start fresh from main, regardless of what branch the workspace
    // happens to be on. Reading "current branch" was a bug — if a previous
    // failed run left the workspace stuck on a feature branch, the next
    // patch would be built on top of stale state and the same cleanup path
    // would re-strand it. main is the only safe ground truth.
    const defaultBranch = "main";

    // Ensure clean working tree (including submodules) and pin to main.
    await resetSubmodules(targetDir, targetRepo);
    await forceCheckoutBranch(targetDir, targetRepo, defaultBranch);

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
You have Edit, Write, Read, Glob, Grep, and Bash tools.

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

## Instructions — read every step before starting

1. First use Glob and Grep to understand the existing code structure and conventions in THIS repo.
2. Find the right location to add the feature — follow the repo's existing patterns.
3. Implement the feature idiomatically for this repo's architecture.
4. Only touch files that are necessary. Do NOT refactor unrelated code.
5. Do NOT add tests unless the repo has an existing test pattern for similar features.
6. Keep the implementation minimal but functional.

## ⛔ HARD REQUIREMENT — the task is NOT done until the build is green

This is a ReScript codebase. Type errors and missing-binding errors are common — you MUST verify your edits compile. The server runs the same build check on the back end and will REJECT a patch with build errors, wasting the entire run.

After every meaningful edit (or batch of related edits), run:

\`\`\`bash
npm run --silent re:build 2>&1
\`\`\`

When you call the Bash tool, **pass \`timeout: 240000\`** (240 seconds) — the default 2-minute Bash timeout is too short for a cold ReScript build in this repo.

Then:
- **If the build succeeds** (no error lines, exit code 0): you may produce the JSON summary and stop.
- **If the build fails**: read the compiler output carefully. ReScript errors are precise — they cite the file, line, column, and the exact type mismatch or missing module. **Fix the issue and re-run the build.** Do not guess; the compiler tells you what's wrong.

You have a budget of **up to 5 build attempts** within this single run. Common iteration loop:
  edit → \`npm run --silent re:build 2>&1\` → read error → edit → build → ... → green → done.

Do not output the JSON summary until \`npm run --silent re:build\` exits 0.

If after 5 attempts you still cannot make it compile, do NOT pretend it works. Output the JSON summary with the field \`build_status: "failed_after_retries"\` and put the last build error tail in \`notes\`. The server will reject it but at least we'll see what went wrong.

## ReScript-specific gotchas

- Adding a field to a record type means **every constructor of that record** must include the new field. Use Grep to find all the places that build the record.
- Optional fields are \`option<T>\` and constructed with \`Some(x)\` / \`None\`. Don't write \`undefined\` or \`null\`.
- New modules need an entry in the source tree that ReScript already includes (check \`bsconfig.json\` / \`rescript.json\` includes).
- Pattern matches must be exhaustive — adding a variant means updating every \`switch\`.

## Naming and integration

- Follow the naming conventions already used in this repo.
- If the feature requires backend API integration, add the API call structure but use placeholder endpoints matching the repo's existing patterns.

## Output format

After the build is green, output ONLY a JSON summary (no code fences, no extra text) in this exact format:

{"what": "<one-line description of the feature added>", "files": [{"path": "<relative file path>", "change": "<brief description of what changed in this file>"}], "backward_compatible": true, "build_status": "passed", "build_attempts": <number>, "notes": "<optional: any caveats, defaults, or integration notes>"}

Example:
{"what": "Added hideExpiredPaymentMethods config option", "files": [{"path": "src/types/SdkTypes.res", "change": "Added field to configurationType record, parsed from config dict (default: false)"}], "backward_compatible": true, "build_status": "passed", "build_attempts": 2, "notes": "First attempt missed the parseConfigurationDict update; second attempt fixed it"}`;

    const summary = await ask(prompt, {
      model: "opus",
      // Bumped from 600s → 1500s to give the agent room to iterate on build
      // failures (up to 5 build attempts × ~120s each + edit time).
      timeoutMs: 1_500_000,
      cwd: targetDir,
      // Bash added so the agent can run `npm run re:build` itself and iterate
      // until green. Edit/Write/Read/Glob/Grep unchanged.
      allowedTools: ["Edit", "Write", "Read", "Glob", "Grep", "Bash"],
    });

    // ---- Capture diff (submodule-aware for mobile repo) ----
    const { diff, fileCount } = await getDiffWithSubmodules(targetDir, targetRepo);

    if (!diff || fileCount === 0) {
      // Opus didn't change any files — reset and bail
      await forceCheckoutBranch(targetDir, targetRepo, defaultBranch);
      try {
        await git.deleteLocalBranch(branchName, true);
      } catch { /* */ }
      return res.status(422).json({
        error: "Opus did not produce any file changes",
        summary,
      });
    }

    // Save .patch file (always — even on build failure, so the user can inspect)
    const patchFileName = `${gapId}-${slug}.patch`;
    const patchPath = path.join(PATCHES_DIR, patchFileName);
    fs.writeFileSync(patchPath, diff);

    // ---- Mandatory ReScript build check ----
    // Runs against the agent's edits in the working tree. If it fails the
    // change is fundamentally broken (missing module, syntax/type error) and
    // we refuse to commit or persist a patch row — the user can inspect the
    // diff at `patchPath` and re-run.
    const build = runRescriptBuild(targetDir);
    if (!build.passed) {
      // Leave the agent's edits on disk so they can be inspected, but reset
      // back to the default branch so the workspace isn't stuck on a broken
      // feature branch.
      await forceCheckoutBranch(targetDir, targetRepo, defaultBranch);
      try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
      return res.status(422).json({
        error: "ReScript build failed — patch rejected. The agent's edits introduced a syntax or type error.",
        buildStatus: "fail",
        buildLog: build.log,
        diff,
        summary: summary.slice(0, 2000),
        patchPath,
      });
    }

    // Build passed — commit the changes (submodules first, then parent)
    const commitMsg = `feat: add ${gap.canonical_name}\n\nGenerated by feature-gap-dashboard for gap #${gapId}`;
    const commitResult = await commitWithSubmodules(targetDir, targetRepo, commitMsg);

    // ---- Push fork + open PR (submodule-aware) ----
    //
    // For each submodule the agent committed inside, push that submodule's
    // commit to its corresponding bot fork. Then rewrite .gitmodules in the
    // parent so anyone checking out the feature branch from the parent fork
    // can `git submodule update --init --recursive` and resolve every SHA.
    // Trade-off: this branch is optimized for "checkout & build", not for
    // direct merge into juspay upstream — the .gitmodules rewrite is in the
    // diff, which is non-mainstream. The PR body says so explicitly.
    let prUrl: string | null = null;
    let prNumber: number | null = null;
    let prWarning: string | null = null;
    const submodulePushSummaries: string[] = [];
    try {
      // 1. Push each dirty submodule to its fork.
      for (const subDir of commitResult.submodulesChanged) {
        const result = await pushSubmoduleToFork({
          parentDir: targetDir,
          subDir,
          branchName,
        });
        submodulePushSummaries.push(`${subDir} → ${result.forkUrl} @ ${result.sha.slice(0, 8)}`);
      }

      // 2. Rewrite .gitmodules + add it as a follow-up commit on the feature
      //    branch (only if we actually touched any submodule).
      if (commitResult.submodulesChanged.length > 0) {
        const rewritten = rewriteGitmodulesToForks(targetDir, commitResult.submodulesChanged);
        if (rewritten.length > 0) {
          const parentGit = simpleGit(targetDir);
          await parentGit.add([".gitmodules"]);
          await parentGit.commit(
            `chore: point submodules at bot forks for build\n\n` +
              `Automated by feature-gap-dashboard so the feature branch is checkout-buildable.\n` +
              `Rewritten: ${rewritten.join(", ")}`,
          );
        }
      }

      // 3. Push the parent feature branch to the parent fork.
      await pushBranchToFork(targetDir, targetRepo, branchName);

      // 4. Open the PR.
      const body = formatPrBody({
        gapId,
        canonicalName: gap.canonical_name,
        category: gap.category,
        rationale: gap.rationale,
        summaryJson: summary,
        filesTouched: fileCount,
        buildLog: build.log,
        submodulePushes: submodulePushSummaries,
      });
      const created = await createPullRequest({
        repoKey: targetRepo,
        branch: branchName,
        title: `feat: add ${gap.canonical_name}`,
        body,
      });
      prUrl = created.prUrl;
      prNumber = created.prNumber;
    } catch (err) {
      prWarning = `PR creation failed: ${(err as Error).message}`;
      console.error(`[patches] PR creation failed for gap ${gapId}:`, err);
    }

    // Switch back to default branch (leave the feature branch intact)
    await forceCheckoutBranch(targetDir, targetRepo, defaultBranch);

    // ---- Save to DB ----
    const patchRow = db
      .prepare(
        `INSERT INTO patches (gap_id, repo, branch, diff_path, summary, files_touched, status, created_at, build_status, build_log, pr_url, pr_number, pr_warning)
         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        gapId,
        targetRepo,
        branchName,
        patchPath,
        summary.slice(0, 2000),
        fileCount,
        nowIso(),
        "pass",
        build.log,
        prUrl,
        prNumber,
        prWarning,
      );

    res.json({
      patchId: patchRow.lastInsertRowid,
      branch: branchName,
      repo: targetRepo,
      filesTouched: fileCount,
      summary: summary.slice(0, 2000),
      diff,
      buildStatus: "pass",
      buildLog: build.log,
      prUrl,
      prNumber,
      prWarning,
    });
  } catch (err) {
    console.error(`[patches] failed for gap ${gapId}:`, err);

    // Try to clean up: go back to default branch
    try {
      await forceCheckoutBranch(targetDir, targetRepo, "main");
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
