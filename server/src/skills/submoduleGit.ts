/**
 * Submodule-aware git helpers.
 *
 * Both hyperswitch repos use git submodules (shared-code, android, ios).
 * Standard `git add/commit/diff` from the parent repo CANNOT stage or diff
 * files inside submodules — git errors with:
 *   "fatal: Pathspec '...' is in submodule '...'"
 *
 * The solution: stage + commit inside each submodule first, then stage the
 * updated submodule pointer from the parent.
 */

import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";

/** Known submodule directories per repo. */
const SUBMODULE_DIRS: Record<string, string[]> = {
  web: ["shared-code"],
  mobile: ["shared-code", "android", "ios"],
};

/**
 * Check whether a submodule directory has uncommitted changes.
 */
async function submoduleHasChanges(subDir: string): Promise<boolean> {
  try {
    const git = simpleGit(subDir);
    const status = await git.status();
    return (
      status.modified.length > 0 ||
      status.not_added.length > 0 ||
      status.created.length > 0 ||
      status.deleted.length > 0 ||
      status.staged.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Get the diff of uncommitted changes inside a submodule.
 * Returns both staged and unstaged changes.
 */
async function submoduleDiff(subDir: string): Promise<string> {
  try {
    const git = simpleGit(subDir);
    // Unstaged changes (files modified on disk but not yet git-added)
    const unstaged = await git.diff();
    // Also check for untracked files — list them in diff-like format
    const status = await git.status();
    let untracked = "";
    for (const f of status.not_added) {
      try {
        const content = fs.readFileSync(path.join(subDir, f), "utf8");
        untracked += `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n`;
        const lines = content.split("\n");
        untracked += `@@ -0,0 +1,${lines.length} @@\n`;
        untracked += lines.map((l) => `+${l}`).join("\n") + "\n";
      } catch { /* skip unreadable */ }
    }
    return (unstaged + "\n" + untracked).trim();
  } catch {
    return "";
  }
}

export interface SubmoduleCommitResult {
  /** Combined diff from all submodules + parent */
  combinedDiff: string;
  /** Total files touched across all submodules + parent */
  totalFiles: number;
  /** Which submodules had changes */
  submodulesChanged: string[];
}

/**
 * Stage and commit changes across a repo and all its submodules.
 *
 * Flow:
 * 1. Collect diffs from each submodule that has changes
 * 2. Stage + commit inside each dirty submodule
 * 3. Stage ONLY parent-level files (not submodule pointers) + changed submodule pointers
 * 4. Commit in the parent
 *
 * Returns the combined diff (submodule file-level diffs + parent diffs).
 */
export async function commitWithSubmodules(
  repoDir: string,
  repoKey: "web" | "mobile",
  commitMessage: string,
): Promise<SubmoduleCommitResult> {
  const parentGit = simpleGit(repoDir);
  const submodules = SUBMODULE_DIRS[repoKey] ?? [];

  const diffs: string[] = [];
  let totalFiles = 0;
  const submodulesChanged: string[] = [];

  // Step 1 & 2: For each submodule, collect diff then stage + commit
  for (const subName of submodules) {
    const subDir = path.join(repoDir, subName);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;

    const hasChanges = await submoduleHasChanges(subDir);
    if (!hasChanges) continue;

    // Collect the diff BEFORE staging (so we get the real file diffs)
    const diff = await submoduleDiff(subDir);
    if (diff) {
      // Prefix paths in the diff with the submodule name for clarity
      const prefixed = diff.replace(
        /^(diff --git a\/)(.+?)( b\/)(.+)$/gm,
        `$1${subName}/$2$3${subName}/$4`,
      );
      diffs.push(prefixed);
    }

    // Stage and commit inside the submodule
    const subGit = simpleGit(subDir);
    await subGit.add(".");
    const subStatus = await subGit.status();
    const filesInSub = subStatus.staged.length;
    totalFiles += filesInSub;
    submodulesChanged.push(subName);

    try {
      await subGit.commit(commitMessage);
    } catch {
      // Might fail if nothing was actually staged — that's OK
    }
  }

  // Step 3: Collect parent-level diff (files in src/, etc. — NOT submodule pointers)
  // Use pathspec exclusions so we don't see `Subproject commit xxx-dirty` noise
  const excludePaths = submodules.map((s) => `:(exclude)${s}`);
  const parentDiff = await parentGit.diff(["--", ".", ...excludePaths]);
  if (parentDiff) {
    diffs.push(parentDiff);
    const parentStat = await parentGit.diffSummary(["--", ".", ...excludePaths]);
    totalFiles += parentStat.files.length;
  }

  // Step 4: Stage parent-level files ONLY (exclude all submodule pointers)
  // This prevents accidentally staging unrelated dirty submodule pointers
  try {
    await parentGit.raw(["add", "--", ".", ...excludePaths]);
  } catch {
    // Fallback: if pathspec exclusion doesn't work with add, stage individually
    // by resetting submodule entries after add
    await parentGit.add(".");
    // Unstage submodule pointers we didn't change
    for (const sub of submodules) {
      if (!submodulesChanged.includes(sub)) {
        try { await parentGit.raw(["reset", "HEAD", "--", sub]); } catch { /* */ }
      }
    }
  }

  // Stage ONLY the submodule pointers we actually committed into
  for (const sub of submodulesChanged) {
    try { await parentGit.raw(["add", sub]); } catch { /* */ }
  }

  // Step 5: Commit in parent (only if there's something to commit)
  const parentStatus = await parentGit.status();
  if (parentStatus.staged.length > 0) {
    try {
      await parentGit.commit(commitMessage);
    } catch (err) {
      console.error("[submoduleGit] parent commit failed:", (err as Error).message);
    }
  }

  return {
    combinedDiff: diffs.join("\n"),
    totalFiles,
    submodulesChanged,
  };
}

/**
 * Get the combined diff for a repo including all submodule changes.
 * Use this BEFORE committing to preview what changed.
 */
export async function getDiffWithSubmodules(
  repoDir: string,
  repoKey: "web" | "mobile",
): Promise<{ diff: string; fileCount: number }> {
  const parentGit = simpleGit(repoDir);
  const submodules = SUBMODULE_DIRS[repoKey] ?? [];

  const diffs: string[] = [];
  let fileCount = 0;

  for (const subName of submodules) {
    const subDir = path.join(repoDir, subName);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;

    const hasChanges = await submoduleHasChanges(subDir);
    if (!hasChanges) continue;

    const diff = await submoduleDiff(subDir);
    if (diff) {
      const prefixed = diff.replace(
        /^(diff --git a\/)(.+?)( b\/)(.+)$/gm,
        `$1${subName}/$2$3${subName}/$4`,
      );
      diffs.push(prefixed);
      // Rough file count from diff headers
      fileCount += (diff.match(/^diff --git /gm) || []).length;
    }
  }

  // Parent diff excluding submodule pointer noise
  const excludePaths = submodules.map((s) => `:(exclude)${s}`);
  const parentDiff = await parentGit.diff(["--", ".", ...excludePaths]);
  if (parentDiff) {
    diffs.push(parentDiff);
    const parentStat = await parentGit.diffSummary(["--", ".", ...excludePaths]);
    fileCount += parentStat.files.length;
  }

  return { diff: diffs.join("\n"), fileCount };
}

/**
 * Reset all submodules to clean state (discard uncommitted changes).
 * Useful before checking out a new branch.
 */
export async function resetSubmodules(
  repoDir: string,
  repoKey: "web" | "mobile",
): Promise<void> {
  const submodules = SUBMODULE_DIRS[repoKey] ?? [];
  for (const subName of submodules) {
    const subDir = path.join(repoDir, subName);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;
    try {
      const git = simpleGit(subDir);
      await git.raw(["checkout", "--force", "."]);
      await git.clean("f", ["-d"]);
    } catch { /* ignore */ }
  }
}

/**
 * Force checkout back to a branch, resetting submodules first.
 * Prevents "your local changes would be overwritten" errors.
 */
export async function forceCheckoutBranch(
  repoDir: string,
  repoKey: "web" | "mobile",
  branch: string,
): Promise<void> {
  await resetSubmodules(repoDir, repoKey);
  const git = simpleGit(repoDir);
  await git.raw(["checkout", "--force", branch]);
}
