import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { REPOS, WORKSPACE_DIR, type RepoKey } from "../config.js";

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

export interface RepoState {
  key: RepoKey;
  name: string;
  dir: string;
  sha: string;
  branch: string;
}

/**
 * Clone the repo if missing, otherwise fetch + fast-forward the default branch.
 * Returns the repo's current HEAD state.
 *
 * Notes:
 *  - Uses HTTPS, no auth — the repos are public.
 *  - Never touches remotes other than `origin`. Never pushes.
 *  - If the working tree is dirty (e.g. a patch branch from Step 7), we
 *    refuse to overwrite — caller should handle that case explicitly.
 */
export async function cloneOrPull(key: RepoKey): Promise<RepoState> {
  const repo = REPOS[key];
  const exists = fs.existsSync(path.join(repo.dir, ".git"));

  if (!exists) {
    fs.mkdirSync(path.dirname(repo.dir), { recursive: true });
    const git = simpleGit();
    console.log(`[repo] cloning ${repo.name} → ${repo.dir}`);
    await git.clone(repo.url, repo.dir, ["--depth", "1"]);
  }

  const git: SimpleGit = simpleGit(repo.dir);

  // Fetch latest. Use --no-tags to keep things minimal.
  if (exists) {
    console.log(`[repo] fetching ${repo.name}`);
    await git.fetch(["--no-tags", "origin"]);
  }

  const defaultBranch = await detectDefaultBranch(git);

  // If working tree is clean and we're on the default branch, fast-forward.
  // Otherwise, just report current SHA without touching anything.
  const status = await git.status();
  const onDefault = status.current === defaultBranch;
  const clean = status.isClean();

  if (exists && onDefault && clean) {
    try {
      await git.pull("origin", defaultBranch, ["--ff-only"]);
    } catch (err) {
      console.warn(
        `[repo] ${repo.name}: ff-only pull failed, leaving HEAD as-is:`,
        (err as Error).message,
      );
    }
  } else if (exists && !clean) {
    console.warn(
      `[repo] ${repo.name}: working tree dirty, skipping pull. ` +
        `Branch=${status.current}, modified=${status.modified.length}`,
    );
  }

  const sha = (await git.revparse(["HEAD"])).trim();
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

  return { key, name: repo.name, dir: repo.dir, sha, branch };
}

/**
 * Best-effort detection of the remote default branch (main/master/etc.).
 */
async function detectDefaultBranch(git: SimpleGit): Promise<string> {
  try {
    const out = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    // e.g. "refs/remotes/origin/main"
    const m = out.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch {
    /* fallthrough */
  }
  // Fallback: try main, then master.
  for (const candidate of ["main", "master"]) {
    try {
      await git.raw(["rev-parse", "--verify", `origin/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  // Last resort: whatever HEAD points at.
  const head = await git.revparse(["--abbrev-ref", "HEAD"]);
  return head.trim();
}

/**
 * Convenience: clone-or-pull both repos in parallel and return their states.
 */
export async function syncAllRepos(): Promise<Record<RepoKey, RepoState>> {
  const [web, mobile] = await Promise.all([
    cloneOrPull("web"),
    cloneOrPull("mobile"),
  ]);
  return { web, mobile };
}
