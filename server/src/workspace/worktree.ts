/**
 * Per-run git worktrees, pinned to exact commits.
 *
 * ## Why
 *
 * PR Port used to run inside the one shared clone per repo. The 2026-09-23
 * audit traced most of its high-severity failures to that single fact:
 *
 *  - the source "read" was local `main`, not the PR — files the PR adds did not
 *    exist for the analyst and implementer;
 *  - other skills (props, translations, analysis sync) reset the same clone
 *    mid-run without the lock;
 *  - cleanup had to `checkout main` + `clean -fd` the shared clone, so a
 *    cancelled run lost its uncommitted work;
 *  - unpushed commits on local `main` rode into the PR branch;
 *  - the implementer, with write access, could scribble on the source clone and
 *    poison every later run's "workspace clean" precondition.
 *
 * Here every run gets its own checkouts under data/worktrees/run-<id>/:
 *
 *   source/   detached at the PR's head SHA — exactly what the PR contains
 *   target/   a new branch from origin/main's SHA — nothing local leaks in
 *
 * The shared clones are only touched to fetch and to add/remove worktree
 * metadata (held briefly under the repo lock). The branch — the durable
 * artifact — outlives the worktree.
 *
 * Only `shared-code` is initialised as a submodule: it is part of the ReScript
 * sources the build needs. The native `android` / `ios` submodules are large
 * and not needed for a ReScript port or its build.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, REPOS, type RepoKey } from "../config.js";
import { commitWithSubmodules } from "../skills/submoduleGit.js";
import { localGit } from "./git.js";
import { withRepoLocks } from "./mutex.js";

export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
const SHARED_SUBMODULE = "shared-code";

export interface PortWorktrees {
  root: string;
  clones: { source: string; target: string };
  source: { key: RepoKey; dir: string; sha: string };
  target: { key: RepoKey; dir: string; baseSha: string; branch: string };
  /** Earlier local branch of the same name, renamed out of the way (never deleted). */
  archivedBranch: string | null;
}

export interface CreatePortWorktreesOptions {
  runId: number | string;
  source: RepoKey;
  target: RepoKey;
  prNumber: number;
  /** Expected head SHA (from the diff fetch); verified against what git fetched. */
  expectedHeadSha?: string;
  branch: string;
  /** Test seam: clone paths (default: the workspace clones in config). */
  clones?: { source: string; target: string };
  /** Test seam: where run directories are created (default: data/worktrees). */
  worktreesDir?: string;
}

/**
 * Deterministic branch name for a port of one source PR. Keyed on the source
 * PR, not a model-generated feature name: a re-run updates the same PR instead
 * of opening a duplicate.
 */
export function portBranchName(source: RepoKey, prNumber: number): string {
  return `port/pr-${prNumber}-${source}`;
}

export async function createPortWorktrees(opts: CreatePortWorktreesOptions): Promise<PortWorktrees> {
  const root = path.join(opts.worktreesDir ?? WORKTREES_DIR, `run-${opts.runId}`);
  if (fs.existsSync(root)) throw new Error(`worktree root already exists: ${root}`);
  fs.mkdirSync(root, { recursive: true });

  const sourceClone = opts.clones?.source ?? REPOS[opts.source].dir;
  const targetClone = opts.clones?.target ?? REPOS[opts.target].dir;
  const sourceDir = path.join(root, "source");
  const targetDir = path.join(root, "target");

  try {
    return await withRepoLocks([opts.source, opts.target], async () => {
      // ── source: the PR head, exactly ──────────────────────────────────────
      const src = localGit(sourceClone);
      await src.raw(["fetch", "--no-tags", "--no-recurse-submodules", "origin", `refs/pull/${opts.prNumber}/head`]);
      const headSha = (await src.revparse(["FETCH_HEAD"])).trim();
      if (opts.expectedHeadSha && opts.expectedHeadSha !== headSha) {
        throw new Error(
          `PR #${opts.prNumber} head moved while starting (diff was for ${opts.expectedHeadSha.slice(0, 10)}, ` +
            `git fetched ${headSha.slice(0, 10)}). Start the port again.`,
        );
      }
      await src.raw(["worktree", "add", "--detach", sourceDir, headSha]);

      // ── target: a fresh branch from origin/main ──────────────────────────
      const tgt = localGit(targetClone);
      await tgt.raw(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "main"]);
      const baseSha = (await tgt.revparse(["FETCH_HEAD"])).trim();
      const archivedBranch = await archiveExistingBranch(targetClone, opts.branch, opts.runId);
      await tgt.raw(["worktree", "add", "-b", opts.branch, targetDir, baseSha]);

      return {
        root,
        clones: { source: sourceClone, target: targetClone },
        source: { key: opts.source, dir: sourceDir, sha: headSha },
        target: { key: opts.target, dir: targetDir, baseSha, branch: opts.branch },
        archivedBranch,
      };
    }).then(async (wt) => {
      // Outside the lock: submodule init and dependency linking only touch the
      // run's own directories (and the object store, which git locks itself).
      await initSharedSubmodule(wt.source.dir, sourceClone);
      await initSharedSubmodule(wt.target.dir, targetClone);
      await linkNodeModules(targetClone, wt.target.dir);
      return wt;
    });
  } catch (err) {
    await removePortWorktrees({ root, sourceClone, targetClone }).catch(() => { /* best effort */ });
    throw err;
  }
}

/**
 * A branch of the same name from an earlier attempt is renamed, never deleted:
 * it may hold preserved work from a failed or cancelled run.
 */
async function archiveExistingBranch(clone: string, branch: string, runId: number | string): Promise<string | null> {
  const git = localGit(clone);
  const exists = (await git.raw(["branch", "--list", branch])).trim() !== "";
  if (!exists) return null;
  const archived = `${branch}-attempt-${runId}-before`;
  await git.raw(["branch", "-m", branch, archived]);
  return archived;
}

async function initSharedSubmodule(worktreeDir: string, clone: string): Promise<void> {
  const gitmodules = path.join(worktreeDir, ".gitmodules");
  if (!fs.existsSync(gitmodules) || !fs.readFileSync(gitmodules, "utf8").includes(`path = ${SHARED_SUBMODULE}`)) return;
  const args = ["submodule", "update", "--init", "--recursive"];
  // Borrow objects from the shared clone's checkout of the submodule so this
  // is a local operation unless the PR pins a commit we have never fetched.
  if (fs.existsSync(path.join(clone, SHARED_SUBMODULE, ".git"))) {
    args.push("--reference", path.join(clone, SHARED_SUBMODULE));
  }
  args.push("--", SHARED_SUBMODULE);
  await localGit(worktreeDir).raw(args);
}

/**
 * The build needs the SDK's dependencies; link the clone's install rather than
 * re-installing per run.
 *
 * The link must never be committed. A `.gitignore` entry of `node_modules/`
 * (trailing slash — hyperswitch-client-core's) matches directories only, and
 * git sees a symlink as a file, so the link would ride into every port's PR.
 * `/node_modules` in the repository's shared info/exclude matches both, and
 * never touches tracked files.
 */
async function linkNodeModules(clone: string, worktreeDir: string): Promise<void> {
  const src = path.join(clone, "node_modules");
  if (!fs.existsSync(src)) {
    throw new Error(`node_modules not installed in ${clone}. Install the SDK's dependencies before starting a PR port.`);
  }
  const commonDir = path.resolve(worktreeDir, (await localGit(worktreeDir).raw(["rev-parse", "--git-common-dir"])).trim());
  const exclude = path.join(commonDir, "info", "exclude");
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!existing.split("\n").includes("/node_modules")) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}/node_modules\n`);
  }
  fs.symlinkSync(src, path.join(worktreeDir, "node_modules"), "dir");
}

/**
 * Commit whatever the run left uncommitted in its target worktree, so nothing
 * is lost when the worktree is removed. Returns true if a commit was made.
 */
export async function preserveTargetWork(wt: Pick<PortWorktrees, "target">, message: string): Promise<boolean> {
  if (!fs.existsSync(wt.target.dir)) return false;
  const status = await localGit(wt.target.dir).status();
  const dirty = status.files.some((f) => f.path !== "node_modules");
  if (!dirty) return false;
  await commitWithSubmodules(wt.target.dir, wt.target.key, message);
  return true;
}

/** Remove a run's worktrees. The target branch (and its commits) is kept. */
export async function removePortWorktrees(args: { root: string; sourceClone: string; targetClone: string }): Promise<void> {
  for (const [clone, sub] of [[args.sourceClone, "source"], [args.targetClone, "target"]] as const) {
    const dir = path.join(args.root, sub);
    if (fs.existsSync(dir)) {
      try { fs.rmSync(path.join(dir, "node_modules"), { force: true }); } catch { /* symlink only */ }
      try { await localGit(clone).raw(["worktree", "remove", "--force", "--force", dir]); } catch { /* fall through */ }
    }
    try { await localGit(clone).raw(["worktree", "prune"]); } catch { /* */ }
  }
  fs.rmSync(args.root, { recursive: true, force: true });
}

export function worktreeClones(wt: PortWorktrees): { root: string; sourceClone: string; targetClone: string } {
  return { root: wt.root, sourceClone: wt.clones.source, targetClone: wt.clones.target };
}

/**
 * End of run: remove the worktrees. If nothing was committed the new branch is
 * empty — delete it (only if it carries `ownedPrefix`) and give an archived
 * earlier attempt its name back, so a failed start never displaces real work.
 */
export async function finishPortWorktrees(wt: PortWorktrees, committed: boolean, ownedPrefix: string): Promise<void> {
  await removePortWorktrees(worktreeClones(wt));
  if (committed) return;
  const clone = localGit(wt.clones.target);
  const ahead = Number((await clone.raw(["rev-list", "--count", `${wt.target.baseSha}..${wt.target.branch}`]).catch(() => "0")).trim());
  if (ahead > 0 || !wt.target.branch.startsWith(ownedPrefix)) return;
  await clone.raw(["branch", "-D", wt.target.branch]).catch(() => { /* already gone */ });
  if (wt.archivedBranch) await clone.raw(["branch", "-m", wt.archivedBranch, wt.target.branch]).catch(() => { /* */ });
}

/**
 * Boot-time recovery for runs killed with the server (crash, restart, kill -9).
 *
 * The job row is already marked `interrupted` by the job runner's sweep; here
 * we make sure the work is not: any uncommitted change in a leftover target
 * worktree is committed onto its branch before the worktree is removed.
 * Safe to call when nothing is left over.
 */
export async function recoverOrphanedWorktrees(
  isLiveRun: (runId: string) => boolean,
  worktreesDir: string = WORKTREES_DIR,
): Promise<string[]> {
  if (!fs.existsSync(worktreesDir)) return [];
  const recovered: string[] = [];
  for (const name of fs.readdirSync(worktreesDir)) {
    const runId = name.replace(/^run-/, "");
    if (!name.startsWith("run-") || isLiveRun(runId)) continue;
    const root = path.join(worktreesDir, name);
    const targetDir = path.join(root, "target");
    const targetClone = resolveCloneOf(targetDir);
    const sourceClone = resolveCloneOf(path.join(root, "source"));
    try {
      if (targetClone && fs.existsSync(targetDir)) {
        const key = repoKeyOf(targetClone, targetDir);
        const status = await localGit(targetDir).status();
        if (status.files.some((f) => f.path !== "node_modules")) {
          await commitWithSubmodules(targetDir, key, `wip: port run ${runId} — interrupted by server restart`);
        }
        recovered.push(`${name}: ${status.current ?? "detached"}`);
      }
    } catch (err) {
      console.error(`[worktree] could not preserve ${name}: ${(err as Error).message} — leaving it in place`);
      continue;
    }
    await removePortWorktrees({
      root,
      sourceClone: sourceClone ?? REPOS.web.dir,
      targetClone: targetClone ?? REPOS.mobile.dir,
    }).catch((err) => console.error(`[worktree] could not remove ${name}: ${(err as Error).message}`));
  }
  return recovered;
}

/** Which SDK a clone is; falls back to its submodule layout (mobile has android/ios). */
function repoKeyOf(clone: string, worktreeDir: string): RepoKey {
  const known = (Object.keys(REPOS) as RepoKey[]).find((k) => REPOS[k].dir === clone);
  if (known) return known;
  const gm = path.join(worktreeDir, ".gitmodules");
  return fs.existsSync(gm) && /path = (android|ios)\b/.test(fs.readFileSync(gm, "utf8")) ? "mobile" : "web";
}

/** A linked worktree's `.git` file points at `<clone>/.git/worktrees/<name>`. */
function resolveCloneOf(worktreeDir: string): string | null {
  const dotGit = path.join(worktreeDir, ".git");
  if (!fs.existsSync(dotGit) || fs.statSync(dotGit).isDirectory()) return null;
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotGit, "utf8"));
  if (!m) return null;
  const idx = m[1].trim().lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
  return idx < 0 ? null : m[1].trim().slice(0, idx);
}
