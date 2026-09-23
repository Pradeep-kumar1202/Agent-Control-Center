/**
 * Canonical GitHub publishing.
 *
 * Every caller supplies one finished parent-repository branch. This module
 * owns all externally-visible publishing behavior: verify the branch is safe,
 * verify `origin` is the expected juspay repository, push with a lease, and
 * create (or reuse) the PR in that same canonical repository.
 *
 * Authentication stays outside the dashboard. Git uses the user's configured
 * credential helper and PR creation shells out to the already-authenticated
 * `gh` CLI. No token is read or persisted here.
 *
 * Before the transport can perform any remote operation, a fail-closed secret
 * gate scans full branch history and PR metadata, including exact values from
 * workspace `.env*` files. An unavailable scanner is a publishing failure.
 *
 * Submodule changes deliberately fail before any network mutation. Publishing
 * those correctly requires separate branches and PRs against sdk-utils,
 * sdk-android, or sdk-ios followed by an ordered parent PR. Pointing
 * `.gitmodules` at a fork would make a canonical PR non-mergeable, so this
 * module refuses that former shortcut.
 */

import { spawn } from "node:child_process";
import { publishGit } from "../workspace/git.js";
import type { RepoKey } from "../config.js";
import { runtimeCliEnv } from "../runtime/agentEnv.js";
import { assertPublishPayloadContainsNoSecrets } from "./secretScan.js";

const UPSTREAM: Record<RepoKey, { owner: string; repo: string }> = {
  web: { owner: "juspay", repo: "hyperswitch-web" },
  mobile: { owner: "juspay", repo: "hyperswitch-client-core" },
};

export function upstreamSlug(repoKey: RepoKey): string {
  const u = UPSTREAM[repoKey];
  return `${u.owner}/${u.repo}`;
}

function upstreamRemoteUrl(repoKey: RepoKey): string {
  return `https://github.com/${upstreamSlug(repoKey)}.git`;
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
      env: runtimeCliEnv(),
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

export class SubmodulePublishingRequiredError extends Error {
  readonly code = "SUBMODULE_PRS_REQUIRED" as const;

  constructor(readonly submodules: string[]) {
    super(
      `Automatic PR creation to the canonical parent repository is blocked because this change modifies ` +
      `${submodules.join(", ")}. Publish separate PRs to the corresponding juspay submodule repositories first; ` +
      `the local parent branch has been preserved.`,
    );
    this.name = "SubmodulePublishingRequiredError";
  }
}

export interface PublishPullRequestArgs {
  repoDir: string;
  repoKey: RepoKey;
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
  submodulesChanged?: string[];
}

interface PushRequest {
  repoDir: string;
  repoSlug: string;
  remoteUrl: string;
  branch: string;
  /** Immutable object that passed the secret gate. Never replace with branch. */
  targetCommit: string;
  baseCommit: string;
}

interface CreateRequest {
  repoSlug: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}

/** Internal true-external seam: production uses Git/gh; checks inject a fake. */
export interface GitHubPublishTransport {
  pushBranch(request: PushRequest): Promise<void>;
  createOrFindPullRequest(request: CreateRequest): Promise<string>;
}

function slugFromRemoteUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (scp) return scp[1].toLowerCase();
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

const liveTransport: GitHubPublishTransport = {
  async pushBranch(request): Promise<void> {
    const git = publishGit(request.repoDir);
    const current = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (current !== request.branch) {
      throw new Error("Refusing to push: the scanned generated branch is not currently checked out");
    }

    const currentCommit = (await git.revparse(["--verify", `${request.branch}^{commit}`])).trim();
    if (currentCommit !== request.targetCommit) {
      throw new Error(
        "Refusing to push: the generated branch changed after its secret scan; run publishing again",
      );
    }

    const ahead = Number((await git.raw([
      "rev-list", "--count", `${request.baseCommit}..${request.targetCommit}`,
    ])).trim());
    if (!Number.isFinite(ahead) || ahead < 1) {
      throw new Error("Refusing to push: the scanned commit has no commits ahead of origin/main");
    }

    const originUrl = (await git.raw(["remote", "get-url", "--push", "origin"])).trim();
    if (slugFromRemoteUrl(originUrl) !== request.repoSlug.toLowerCase()) {
      throw new Error(
        `Refusing to push: origin is not the canonical repository ${request.repoSlug}`,
      );
    }

    // Refresh the remote-tracking branch immediately before force-with-lease.
    // If the branch does not exist, ls-remote is empty and the lease correctly
    // expects a new branch. Never use an unconditional force against juspay/*.
    const remoteRef = `refs/heads/${request.branch}`;
    const remoteHead = await git.raw(["ls-remote", "--heads", "origin", remoteRef]);
    const expectedRemoteSha = remoteHead.trim().split(/\s+/, 1)[0] ?? "";
    if (expectedRemoteSha) {
      await git.raw([
        "fetch", "--no-tags", "--no-recurse-submodules", "origin",
        `${remoteRef}:refs/remotes/origin/${request.branch}`,
      ]);
    }
    // Pin the lease to the SHA observed above. An empty expected SHA means the
    // branch must still not exist, so a concurrent creator is protected too.
    await git.raw([
      "push",
      `--force-with-lease=${remoteRef}:${expectedRemoteSha}`,
      "origin",
      `${request.targetCommit}:${remoteRef}`,
    ]);
  },

  async createOrFindPullRequest(request): Promise<string> {
    const existingRaw = await run("gh", [
      "pr", "list",
      "--repo", request.repoSlug,
      "--head", request.branch,
      "--state", "open",
      "--limit", "1",
      "--json", "url,number",
    ], { timeoutMs: 30_000 });
    try {
      const existing = JSON.parse(existingRaw) as Array<{ url?: unknown; number?: unknown }>;
      if (typeof existing[0]?.url === "string" && Number.isFinite(existing[0]?.number)) {
        return existing[0].url;
      }
    } catch { /* let gh create the PR */ }

    const createArgs = [
      "pr", "create",
      "--repo", request.repoSlug,
      "--head", request.branch,
      "--base", "main",
      "--title", request.title,
      "--body", request.body,
    ];
    if (request.draft) createArgs.push("--draft");
    return run("gh", createArgs, { timeoutMs: 60_000 });
  },
};

interface PublishSnapshot {
  /** Local remote-tracking main, so local-only commits on main are scanned too. */
  baseCommit: string;
  /** Immutable branch tip that both scanners approve and the transport pushes. */
  targetCommit: string;
}

async function resolvePublishSnapshot(repoDir: string, branch: string): Promise<PublishSnapshot> {
  const git = publishGit(repoDir);
  let current: string;
  let baseCommit: string;
  let targetCommit: string;
  try {
    [current, baseCommit, targetCommit] = await Promise.all([
      git.revparse(["--abbrev-ref", "HEAD"]),
      git.revparse(["--verify", "refs/remotes/origin/main^{commit}"]),
      git.revparse(["--verify", `${branch}^{commit}`]),
    ]);
  } catch {
    throw new Error(
      `Refusing to publish: could not resolve the generated branch and origin/main. ` +
      `Synchronize the workspace before publishing.`,
    );
  }
  current = current.trim();
  baseCommit = baseCommit.trim();
  targetCommit = targetCommit.trim();
  if (current !== branch) {
    throw new Error("Refusing to publish: the requested generated branch is not currently checked out");
  }
  const ahead = Number((await git.raw([
    "rev-list", "--count", `${baseCommit}..${targetCommit}`,
  ])).trim());
  if (!Number.isFinite(ahead) || ahead < 1) {
    throw new Error("Refusing to publish: the generated branch has no commits ahead of origin/main");
  }
  return { baseCommit, targetCommit };
}

/**
 * Publish one parent-only branch to the canonical juspay repository.
 *
 * The interface intentionally exposes no remote names, fork owners, push
 * ordering, secret-scan policy, or gh arguments. Callers either receive a
 * canonical PR or one actionable failure, and tests exercise the same
 * interface with a fake transport.
 */
export async function publishPullRequest(
  args: PublishPullRequestArgs,
  transport: GitHubPublishTransport = liveTransport,
): Promise<{ prUrl: string; prNumber: number; remoteUrl: string }> {
  const submodules = [...new Set(args.submodulesChanged ?? [])];
  if (submodules.length > 0) throw new SubmodulePublishingRequiredError(submodules);
  if (!args.branch.trim() || args.branch === "main" || args.branch === "master") {
    throw new Error("Refusing to publish a protected or empty branch");
  }

  // Resolve once, scan immutable object IDs, and push that exact object. This
  // closes the scan/push race where another job could advance the branch name
  // after scanning but before transport.
  const snapshot = await resolvePublishSnapshot(args.repoDir, args.branch);

  // This is deliberately outside the transport: every production publishing
  // path crosses the same mandatory local gate before any remote read or write.
  await assertPublishPayloadContainsNoSecrets({
    repoDir: args.repoDir,
    baseCommit: snapshot.baseCommit,
    targetCommit: snapshot.targetCommit,
    branch: args.branch,
    title: args.title,
    body: args.body,
  });

  const repoSlug = upstreamSlug(args.repoKey);
  const remoteUrl = upstreamRemoteUrl(args.repoKey);
  await transport.pushBranch({
    repoDir: args.repoDir,
    repoSlug,
    remoteUrl,
    branch: args.branch,
    baseCommit: snapshot.baseCommit,
    targetCommit: snapshot.targetCommit,
  });
  const url = await transport.createOrFindPullRequest({
    repoSlug,
    branch: args.branch,
    title: args.title,
    body: args.body,
    draft: args.draft === true,
  });
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
  if (!match || match[1].toLowerCase() !== repoSlug.toLowerCase()) {
    throw new Error(`GitHub returned an unexpected canonical PR URL: ${url}`);
  }
  return { prUrl: url, prNumber: Number(match[2]), remoteUrl };
}

export interface PortPrBodyArgs {
  sourcePrUrl: string;
  sourceRepo: string;
  targetRepo: string;
  featureName: string;
  /**
   * `no` is reachable: triage may advise against porting while the analyst,
   * which reads both repositories, finds real behavior to port. The disagreement
   * is surfaced in the body rather than hidden, because it is precisely what a
   * reviewer should scrutinise.
   */
  portability: "yes" | "partial" | "no";
  portabilityReasons: string[];
  summaryJson: string;
  filesTouched: number;
  skippedFiles: Array<{ path: string; why: string }>;
  buildLog: string | null;
  verdict: "pass" | "needs_review";
  findings: Array<{ level: string; rule?: string; message: string; file?: string }>;
  verifierIssues: string[];
}

/** Build the reviewer-facing report for a cross-SDK port. */
export function formatPortPrBody(args: PortPrBodyArgs): string {
  let summary = args.summaryJson.trim();
  try {
    const parsed = JSON.parse(args.summaryJson) as { what?: unknown; notes?: unknown };
    summary = typeof parsed.what === "string" ? parsed.what : summary;
    if (typeof parsed.notes === "string" && parsed.notes.trim()) summary += `\n\n${parsed.notes.trim()}`;
  } catch { /* retain raw summary */ }

  const skipped = args.skippedFiles.length > 0
    ? args.skippedFiles.map((f) => `- \`${f.path}\` — ${f.why}`).join("\n")
    : "- None declared by triage/analysis.";
  const portability = args.portabilityReasons.length > 0
    ? args.portabilityReasons.map((reason) => `- ${reason}`).join("\n")
    : "- The complete behavioral change was classified as portable.";
  const findings = args.findings.length > 0
    ? args.findings.map((f) => `- **${f.level}** ${f.rule ? `\`${f.rule}\` ` : ""}${f.file ? `\`${f.file}\`: ` : ""}${f.message}`).join("\n")
    : "- No deterministic findings.";
  const verifier = args.verifierIssues.length > 0
    ? args.verifierIssues.map((i) => `- ${i}`).join("\n")
    : "- No semantic issues reported.";
  const build = args.buildLog
    ? `<details><summary>ReScript build log (tail)</summary>\n\n\`\`\`\n${args.buildLog.split("\n").slice(-30).join("\n")}\n\`\`\`\n\n</details>`
    : "ReScript build passed.";
  return [
    "## Summary",
    "",
    summary || `Port ${args.featureName} to ${args.targetRepo}.`,
    "",
    "## Source",
    "",
    `Ported from [${args.sourceRepo} PR](${args.sourcePrUrl}) into \`${args.targetRepo}\`.`,
    `${args.filesTouched} target file(s) changed.`,
    "",
    args.portability === "no"
      ? "## Portability: triage advised against porting — review carefully"
      : `## Portability: ${args.portability}`,
    "",
    portability,
    "",
    "## Intentionally not ported",
    "",
    skipped,
    "",
    `## Quality verdict: ${args.verdict}`,
    "",
    findings,
    "",
    "### Semantic verifier",
    "",
    verifier,
    "",
    "## Build",
    "",
    build,
    "---",
    "*Generated by Agent Control Center. Platform-specific behavior still requires reviewer validation.*",
  ].join("\n");
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
    buildSection,
    `---`,
    `*Automated PR. Reviewer: please verify the implementation matches the existing patterns in this repo and run any platform-specific tests.*`,
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");
}
