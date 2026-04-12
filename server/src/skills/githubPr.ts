/**
 * GitHub PR creation — push the feature branch to a fork and open a pull
 * request against the upstream juspay repo.
 *
 * Authentication piggybacks on `gh auth login` (HTTPS). The gh CLI installs
 * itself as a git credential helper, so `git push` to the fork URL just works
 * without us touching tokens. PR creation goes through `gh pr create` for the
 * same reason.
 *
 * NOTE on submodules: both hyperswitch repos use submodules. A PR against the
 * parent fork only carries the parent commit (which is a submodule pointer
 * bump). If the agent edited inside a submodule, those changes will not be
 * visible in the upstream PR unless the submodule commit is also pushed to a
 * reachable repo. We detect that case in the caller and skip PR creation with
 * a clear warning instead of opening a half-broken PR.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import type { RepoKey } from "../config.js";

export interface ForkConfig {
  /** GitHub username that owns the forks. */
  owner: string;
  /** Fork repo name for hyperswitch-web. */
  webRepo: string;
  /** Fork repo name for hyperswitch-client-core. */
  mobileRepo: string;
}

export const FORK_CONFIG: ForkConfig = {
  owner: process.env.BOT_FORK_OWNER ?? "pradeep120230-creator",
  webRepo: process.env.WEB_FORK_REPO ?? "sdk-agent-hyperswitch-web",
  mobileRepo: process.env.MOBILE_FORK_REPO ?? "sdk-agent-hyperswitch-client-core",
};

/**
 * Submodule-directory → bot fork repo name. Both hyperswitch repos use the
 * same `shared-code` dir name pointing at the same upstream, so a single
 * mapping covers both parents. android/ios only exist under mobile.
 */
export const SUBMODULE_FORKS: Record<string, string> = {
  "shared-code": process.env.SHARED_CODE_FORK ?? "sdk-agent-hyperswitch-sdk-utils",
  "android": process.env.ANDROID_FORK ?? "sdk-agent-hyperswitch-sdk-android",
  "ios": process.env.IOS_FORK ?? "sdk-agent-hyperswitch-sdk-ios",
};

const UPSTREAM: Record<RepoKey, { owner: string; repo: string }> = {
  web: { owner: "juspay", repo: "hyperswitch-web" },
  mobile: { owner: "juspay", repo: "hyperswitch-client-core" },
};

export function forkSlug(repoKey: RepoKey): string {
  const repo = repoKey === "web" ? FORK_CONFIG.webRepo : FORK_CONFIG.mobileRepo;
  return `${FORK_CONFIG.owner}/${repo}`;
}

export function upstreamSlug(repoKey: RepoKey): string {
  const u = UPSTREAM[repoKey];
  return `${u.owner}/${u.repo}`;
}

function forkRemoteUrl(repoKey: RepoKey): string {
  return `https://github.com/${forkSlug(repoKey)}.git`;
}

/** Run a command, return stdout. Throws with stderr on non-zero exit. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* */ }
          reject(new Error(`${cmd} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
    });
  });
}

/**
 * Force-push the current feature branch to the bot's fork. Adds a `bot`
 * remote on first use and updates its URL otherwise.
 */
export async function pushBranchToFork(
  repoDir: string,
  repoKey: RepoKey,
  branch: string,
): Promise<{ remoteUrl: string }> {
  const git = simpleGit(repoDir);
  const remoteUrl = forkRemoteUrl(repoKey);

  const remotes = await git.getRemotes(true);
  const existing = remotes.find((r) => r.name === "bot");
  if (existing) {
    if (existing.refs.push !== remoteUrl) {
      await git.raw(["remote", "set-url", "bot", remoteUrl]);
    }
  } else {
    await git.addRemote("bot", remoteUrl);
  }

  // Force-push: the agent re-runs may rewrite the same branch name.
  await git.push(["--force", "bot", branch]);
  return { remoteUrl };
}

/**
 * Push a single submodule's HEAD to its corresponding bot fork as the same
 * feature branch name. The submodule was already committed by
 * commitWithSubmodules — at this point HEAD inside the submodule points at
 * the new commit. We push that SHA to the fork via a refspec so we don't
 * have to create a real branch in the submodule's detached state.
 *
 * Returns the fork URL we pushed to (used to rewrite .gitmodules).
 */
export async function pushSubmoduleToFork(args: {
  parentDir: string;
  subDir: string; // e.g. "shared-code"
  branchName: string;
}): Promise<{ forkUrl: string; sha: string }> {
  const forkRepoName = SUBMODULE_FORKS[args.subDir];
  if (!forkRepoName) {
    throw new Error(`no fork mapping for submodule "${args.subDir}"`);
  }
  const forkUrl = `https://github.com/${FORK_CONFIG.owner}/${forkRepoName}.git`;
  const subPath = path.join(args.parentDir, args.subDir);
  const subGit = simpleGit(subPath);

  const remotes = await subGit.getRemotes(true);
  const existing = remotes.find((r) => r.name === "bot");
  if (existing) {
    if (existing.refs.push !== forkUrl) {
      await subGit.raw(["remote", "set-url", "bot", forkUrl]);
    }
  } else {
    await subGit.addRemote("bot", forkUrl);
  }

  // Push HEAD into a real branch on the fork. Submodules are typically in
  // detached HEAD after `git submodule update`, so a refspec is the cleanest
  // way to give that commit a name on the remote.
  await subGit.push(["--force", "bot", `HEAD:refs/heads/${args.branchName}`]);

  const sha = (await subGit.revparse(["HEAD"])).trim();
  return { forkUrl, sha };
}

/**
 * Rewrite `.gitmodules` in the parent working tree to point at bot forks for
 * the submodules listed. Only edits URLs we have a fork mapping for; leaves
 * everything else alone.
 *
 * This is what makes `git submodule update --init --recursive` work for
 * anyone who checks out the feature branch from the parent fork — without
 * the rewrite, git would chase the original juspay URL which doesn't have
 * the new submodule SHA.
 *
 * Returns the list of submodule dirs that were actually rewritten.
 */
export function rewriteGitmodulesToForks(
  parentDir: string,
  submoduleDirs: string[],
): string[] {
  const gitmodulesPath = path.join(parentDir, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) return [];

  let content = fs.readFileSync(gitmodulesPath, "utf8");
  const rewritten: string[] = [];

  for (const subDir of submoduleDirs) {
    const forkRepoName = SUBMODULE_FORKS[subDir];
    if (!forkRepoName) continue;
    const forkUrl = `https://github.com/${FORK_CONFIG.owner}/${forkRepoName}.git`;

    // Match the submodule section and rewrite its `url = ...` line.
    // Section header looks like:  [submodule "shared-code"]
    const sectionRegex = new RegExp(
      `(\\[submodule\\s+"${escapeRegex(subDir)}"\\][^\\[]*?\\burl\\s*=\\s*)([^\\n]+)`,
      "m",
    );
    if (sectionRegex.test(content)) {
      content = content.replace(sectionRegex, `$1${forkUrl}`);
      rewritten.push(subDir);
    }
  }

  if (rewritten.length > 0) {
    fs.writeFileSync(gitmodulesPath, content);
  }
  return rewritten;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Open a pull request **inside the bot's own fork** — i.e. the head is the
 * feature branch, the base is the fork's own `main`. We deliberately do
 * NOT target juspay:main because:
 *
 *   1. The bot doesn't have merge permission on juspay/* — any PR there
 *      would sit open waiting for upstream maintainers.
 *   2. Testing our dashboard end-to-end needs a PR the user can merge
 *      themselves, exercising the full "build → PR → review → merge"
 *      story without cross-org approval.
 *
 * `gh pr create` inside a single repo doesn't need the `owner:branch`
 * prefix for `--head` — we pass just the branch name. The base is `main`
 * of the same fork.
 */
export async function createPullRequest(args: {
  repoKey: RepoKey;
  branch: string;
  title: string;
  body: string;
}): Promise<{ prUrl: string; prNumber: number }> {
  const fork = forkSlug(args.repoKey);

  // gh pr create prints the PR URL to stdout on success.
  const url = await run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      fork,
      "--head",
      args.branch,
      "--base",
      "main",
      "--title",
      args.title,
      "--body",
      args.body,
    ],
    { timeoutMs: 60_000 },
  );

  const match = url.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`gh pr create returned unexpected output: ${url}`);
  }
  return { prUrl: url, prNumber: Number(match[1]) };
}

/**
 * Return the number of commits on `branch` that are ahead of the bot fork's
 * `main`. Used as a post-commit sanity check: if we're about to push a
 * branch that has zero new commits, something earlier failed silently —
 * abort loudly instead of opening an empty PR.
 */
export async function commitsAheadOfForkMain(
  repoDir: string,
  branch: string,
): Promise<number> {
  const git = simpleGit(repoDir);
  try {
    // Use main@origin if local main is ahead; otherwise plain main.
    const out = await git.raw(["rev-list", "--count", `main..${branch}`]);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Build a PR markdown body from agent summary + build log + branch info. */
export function formatPrBody(args: {
  gapId: number;
  canonicalName: string;
  category: string;
  rationale: string;
  summaryJson: string;
  filesTouched: number;
  buildLog: string | null;
  submodulePushes?: string[];
}): string {
  // Try to surface the agent's "what" line if the summary parses cleanly.
  let what = "";
  let notes = "";
  try {
    const parsed = JSON.parse(args.summaryJson);
    if (typeof parsed?.what === "string") what = parsed.what;
    if (typeof parsed?.notes === "string") notes = parsed.notes;
  } catch {
    /* keep empty */
  }

  const buildSection = args.buildLog
    ? `\n## Build\n\nReScript build passed.\n\n<details><summary>build log (tail)</summary>\n\n\`\`\`\n${args.buildLog.split("\n").slice(-30).join("\n")}\n\`\`\`\n\n</details>\n`
    : "";

  const submoduleSection =
    args.submodulePushes && args.submodulePushes.length > 0
      ? `\n## Submodules\n\nThis branch touches submodules and rewrites \`.gitmodules\` to point at bot forks so it is **checkout-buildable**. The submodule pointer SHAs live in:\n\n${args.submodulePushes.map((s) => `- \`${s}\``).join("\n")}\n\n> ⚠️ Because \`.gitmodules\` was rewritten, this PR is not directly mergeable into upstream as-is. To land it upstream, the submodule changes need their own PRs against the submodule upstream first, then this PR with .gitmodules reverted. Use this branch for build/preview validation.\n`
      : "";

  return [
    `## Summary`,
    ``,
    what || `Add \`${args.canonicalName}\` to fill a feature parity gap with the other SDK.`,
    ``,
    `## Why`,
    ``,
    args.rationale,
    ``,
    `## Generated by`,
    ``,
    `feature-gap-dashboard, gap #${args.gapId} (category: \`${args.category}\`).`,
    `${args.filesTouched} file(s) touched.`,
    notes ? `\n## Notes\n\n${notes}\n` : "",
    submoduleSection,
    buildSection,
    `---`,
    `*Automated PR. Reviewer: please verify the implementation matches the existing patterns in this repo and run any platform-specific tests.*`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}
