/**
 * Workspace preconditions and teardown shared by every skill that mutates a repo.
 *
 * Extracted verbatim from `skills/prPort/index.ts`, which was the only pipeline
 * that got this right. The three rules encoded here are the ones that keep a
 * failed run from costing a human anything:
 *
 *  1. Refuse to start on a workspace that already has unrelated changes, so a
 *     later `clean -f -d` can never destroy someone else's work.
 *  2. Preserve whatever the agent produced BEFORE tearing anything down.
 *  3. Only ever delete a branch this tool created, identified by prefix.
 *
 * Everything here goes through `workspace/git.ts` (`localGit`): hooks disabled,
 * prompts refused, deadlocks bounded. See that file for why.
 */

import fs from "node:fs";
import path from "node:path";
import { REPOS, type RepoKey } from "../config.js";
import { localGit } from "./git.js";
import {
  commitWithSubmodules,
  forceCheckoutBranch,
  restoreSubmoduleHeads,
  submoduleDirsFor,
  type SubmoduleCommitResult,
  type SubmoduleHead,
} from "../skills/submoduleGit.js";

/**
 * Fail fast if the repo is not in a state we may safely mutate.
 *
 * `requireMain` is for repos used as a read-only source: reading a diff off a
 * repo parked on some other branch silently analyses the wrong code.
 *
 * Submodule directories are checked separately from the parent because a dirty
 * submodule shows up in the parent's status as a single pointer entry, which
 * would otherwise be indistinguishable from an intentional pointer bump.
 */
export async function assertWorkspaceReady(repoKey: RepoKey, requireMain: boolean): Promise<void> {
  const repoDir = REPOS[repoKey].dir;
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(`Workspace repo is missing: ${repoDir}. Run npm run setup first.`);
  }
  const git = localGit(repoDir);
  const status = await git.status();
  if (requireMain && status.current !== "main") {
    throw new Error(
      `${REPOS[repoKey].name} must be on main before it can be used as the read-only source (currently ${status.current ?? "detached"})`,
    );
  }
  const submodules = new Set(submoduleDirsFor(repoKey));
  const parentChanges = status.files.filter((f) => !submodules.has(f.path));
  if (parentChanges.length > 0) {
    throw new Error(
      `${REPOS[repoKey].name} has unrelated working-tree changes: ${parentChanges.slice(0, 5).map((f) => f.path).join(", ")}`,
    );
  }
  for (const sub of submodules) {
    const subDir = path.join(repoDir, sub);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;
    const subStatus = await localGit(subDir).status();
    if (!subStatus.isClean()) throw new Error(`${REPOS[repoKey].name}/${sub} has unrelated working-tree changes`);
  }
}

/**
 * Return the repo to main and, unless the caller asked to keep it, remove the
 * generated branch.
 *
 * `branchPrefix` is a safety interlock, not a convenience: deletion happens only
 * when the branch name starts with the prefix the caller declares it owns
 * (`port/pr-`, `patch/`, …). A bug that passed the wrong branch name therefore
 * cannot delete a human's branch.
 *
 * The `clean -f -d` is only safe because `assertWorkspaceReady` proved there
 * were no unrelated parent-level files before the run, and the repo lock
 * excludes concurrent jobs for the duration.
 */
export async function cleanupTarget(
  repoKey: RepoKey,
  baseline: SubmoduleHead[],
  branchName: string,
  keepBranch: boolean,
  branchPrefix: string,
): Promise<void> {
  const repoDir = REPOS[repoKey].dir;
  await forceCheckoutBranch(repoDir, repoKey, "main");
  await localGit(repoDir).clean("f", ["-d"]);
  await restoreSubmoduleHeads(repoDir, baseline);
  if (!keepBranch && branchName.startsWith(branchPrefix)) {
    try { await localGit(repoDir).deleteLocalBranch(branchName, true); } catch { /* absent/empty */ }
  }
}

/**
 * Commit whatever is in the working tree so a failed or interrupted run leaves
 * something a human can inspect.
 *
 * Call this BEFORE any checkout or cleanup. Commit failures propagate — see
 * `submoduleGit.commitWithSubmodules`, which used to swallow them and report
 * work as preserved while it was about to be discarded.
 */
export async function preserveWork(
  repoKey: RepoKey,
  message: string,
): Promise<SubmoduleCommitResult> {
  return commitWithSubmodules(REPOS[repoKey].dir, repoKey, message);
}
