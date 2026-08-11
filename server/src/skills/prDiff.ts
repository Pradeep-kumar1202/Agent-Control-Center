import simpleGit from "simple-git";
import type { RepoKey } from "../config.js";
import { parsePrUrl, repoKeyForSlug } from "./prUrl.js";

export interface BranchDiff {
  diff: string;
  stat: string;
  baseSha?: string;
  headSha?: string;
}

async function diffRefs(
  repoDir: string,
  baseRef: string,
  headRef: string,
): Promise<Pick<BranchDiff, "diff" | "stat">> {
  const git = simpleGit(repoDir);
  try {
    const [diff, stat] = await Promise.all([
      git.diff([`${baseRef}...${headRef}`]),
      git.diff([`${baseRef}...${headRef}`, "--stat"]),
    ]);
    return { diff, stat };
  } catch {
    const [diff, stat] = await Promise.all([
      git.diff([`${baseRef}..${headRef}`]),
      git.diff([`${baseRef}..${headRef}`, "--stat"]),
    ]);
    return { diff, stat };
  }
}

async function fetchSha(repoDir: string, remoteUrl: string, ref: string): Promise<string> {
  const git = simpleGit(repoDir);
  // The workspace may configure fetch.recurseSubmodules=on-demand. A parent PR
  // diff needs no submodule objects, and recursing can fail on stale bot-fork
  // refs before FETCH_HEAD is usable, so make the isolation explicit.
  await git.raw(["fetch", "--no-tags", "--no-recurse-submodules", remoteUrl, ref]);
  return (await git.revparse(["FETCH_HEAD"])).trim();
}

function statFromUnifiedDiff(diff: string): string {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return `${files} file${files === 1 ? "" : "s"} changed, ${added} insertion${added === 1 ? "" : "s"}(+), ${removed} deletion${removed === 1 ? "" : "s"}(-)`;
}

async function fetchExactPrDiff(prUrl: string): Promise<string> {
  const response = await fetch(`${prUrl}.diff`, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "agent-control-center",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${prUrl}.diff`);
  const diff = await response.text();
  if (!diff.trim()) throw new Error("GitHub returned an empty PR diff");
  if (diff.length > 750 * 1024) {
    throw new Error("PR diff exceeds the 750 KiB safe analysis limit; split the source change before porting it");
  }
  return diff.trim();
}

async function getPrDiff(
  repoDir: string,
  prUrl: string,
  _baseBranch: string,
  expectedRepo?: RepoKey,
): Promise<BranchDiff> {
  const pr = parsePrUrl(prUrl);
  if (!pr) throw new Error("Unrecognised GitHub URL — expected a /pull/<number> URL");

  const actualRepo = repoKeyForSlug(pr.owner, pr.repo);
  if (expectedRepo && actualRepo !== expectedRepo) {
    throw new Error(
      `The PR belongs to ${actualRepo ?? `${pr.owner}/${pr.repo}`}, but the selected workspace repo is ${expectedRepo}`,
    );
  }

  const remoteUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
  // GitHub's `.diff` endpoint is the exact PR artifact even after merge. A
  // current-main...head comparison is not: once a merge commit contains the
  // head it can be empty, and after later history diverges it can include
  // hundreds of unrelated files.
  try {
    const diff = await fetchExactPrDiff(pr.url);
    let headSha: string | undefined;
    try {
      const out = await simpleGit(repoDir).raw(["ls-remote", remoteUrl, `refs/pull/${pr.number}/head`]);
      headSha = out.trim().split(/\s+/)[0] || undefined;
    } catch { /* provenance convenience only */ }
    return { diff, stat: statFromUnifiedDiff(diff), headSha };
  } catch (err) {
    // Fall through to the git-only path for environments where github.com is
    // reachable by git credentials but patch-diff.githubusercontent.com is not.
    const exactDiffError = (err as Error).message;

    let headSha: string;
    try {
      headSha = await fetchSha(repoDir, remoteUrl, `refs/pull/${pr.number}/head`);
    } catch (fetchError) {
      throw new Error(
        `Could not fetch PR #${pr.number} from ${pr.owner}/${pr.repo}. ` +
        `Exact diff failed (${exactDiffError}); git fetch failed (${(fetchError as Error).message}).`,
      );
    }

    try {
      // A merge ref has the exact PR base as parent 1 for both open and merged
      // PRs. If it is unavailable, fail rather than silently diff against
      // today's main and port unrelated history.
      const mergeSha = await fetchSha(repoDir, remoteUrl, `refs/pull/${pr.number}/merge`);
      const baseSha = (await simpleGit(repoDir).revparse([`${mergeSha}^1`])).trim();
      return { ...(await diffRefs(repoDir, baseSha, headSha)), baseSha, headSha };
    } catch (mergeError) {
      throw new Error(
        `Could not obtain the exact diff for PR #${pr.number}. ` +
        `.diff failed (${exactDiffError}); merge-ref fallback failed (${(mergeError as Error).message}).`,
      );
    }
  }
}

/**
 * Diff a local/remote branch or an exact GitHub PR without checking it out.
 *
 * `expectedRepo` closes the old review bug where a web PR URL paired with the
 * mobile radio button fetched the same PR number from mobile's origin.
 */
export async function getBranchDiff(
  repoDir: string,
  branchOrPr: string,
  baseBranch: string,
  expectedRepo?: RepoKey,
): Promise<BranchDiff> {
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(branchOrPr)) {
    return getPrDiff(repoDir, branchOrPr, baseBranch, expectedRepo);
  }

  const git = simpleGit(repoDir);
  try {
    const branches = await git.branch(["-a"]);
    const exists = branches.all.some(
      (b) => b.replace("remotes/origin/", "").trim() === branchOrPr,
    );
    if (!exists) await git.fetch("origin", branchOrPr);
  } catch {
    // Proceed — it may be local-only.
  }

  for (const ref of [branchOrPr, `origin/${branchOrPr}`]) {
    try {
      return await diffRefs(repoDir, baseBranch, ref);
    } catch {
      // Try the next representation.
    }
  }
  throw new Error(
    `Could not diff \"${branchOrPr}\" against \"${baseBranch}\". ` +
    "Ensure the branch exists locally or is fetchable from origin.",
  );
}
