import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  publishPullRequest,
  SubmodulePublishingRequiredError,
  upstreamSlug,
  type GitHubPublishTransport,
} from "../skills/githubPr.js";
import {
  SecretScanBlockedError,
  SecretScanUnavailableError,
} from "../skills/secretScan.js";
import { agentSubprocessEnv, BLOCKED_PUSH_URL } from "../runtime/agentEnv.js";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "acc-publish-check-"));

function git(...args: string[]): string {
  return execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" }).trim();
}

function commitFile(file: string, content: string, message: string): void {
  const absolute = path.join(fixture, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  git("add", "--", file);
  git("commit", "-m", message);
}

async function main(): Promise<void> {
  git("init", "-b", "main");
  git("config", "user.name", "Agent Control Center Check");
  git("config", "user.email", "acc-check@example.invalid");
  git("remote", "add", "origin", "https://github.com/juspay/hyperswitch-web.git");
  commitFile("README.md", "fixture\n", "fixture base");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("checkout", "-b", "feat/direct-upstream-check");
  commitFile(
    "implementation.ts",
    "export const apiKey = process.env.JUSPAY_API_KEY;\n",
    "safe generated change",
  );

  const quarantined = agentSubprocessEnv({
    ...process.env,
    HOME: path.join(fixture, "home"),
    PATH: ["/usr/bin", "/bin"].join(path.delimiter),
    GH_TOKEN: "must-not-reach-agent",
    GITHUB_TOKEN: "must-not-reach-agent",
    SSH_AUTH_SOCK: "/tmp/must-not-reach-agent",
    JUSPAY_API_KEY: "model-provider-key-must-remain",
  });
  assert.equal(quarantined.GH_TOKEN, undefined);
  assert.equal(quarantined.GITHUB_TOKEN, undefined);
  assert.equal(quarantined.SSH_AUTH_SOCK, undefined);
  assert.equal(quarantined.JUSPAY_API_KEY, "model-provider-key-must-remain");
  const runtimePath = (quarantined.PATH ?? "").split(path.delimiter);
  assert.ok(runtimePath.includes(path.join(fixture, "home", ".local", "bin")));
  assert.ok(runtimePath.includes(path.join(fixture, "home", ".opencode", "bin")));
  assert.equal(
    execFileSync("git", ["-C", fixture, "remote", "get-url", "--push", "origin"], {
      encoding: "utf8", env: quarantined,
    }).trim(),
    BLOCKED_PUSH_URL,
  );
  assert.match(
    execFileSync("git", ["-C", fixture, "remote", "get-url", "origin"], {
      encoding: "utf8", env: quarantined,
    }).trim(),
    /^https:\/\/127\.0\.0\.1:1\/agent-github-blocked\//,
  );

  const observed: Array<Record<string, unknown>> = [];
  const fake: GitHubPublishTransport = {
    async pushBranch(request) {
      observed.push({ kind: "push", ...request });
    },
    async createOrFindPullRequest(request) {
      observed.push({ kind: "pr", ...request });
      return "https://github.com/juspay/hyperswitch-web/pull/321";
    },
  };

  const published = await publishPullRequest({
    repoDir: fixture,
    repoKey: "web",
    branch: "feat/direct-upstream-check",
    title: "feat: direct upstream check",
    body: "body",
    draft: true,
  }, fake);

  assert.equal(upstreamSlug("web"), "juspay/hyperswitch-web");
  assert.equal(upstreamSlug("mobile"), "juspay/hyperswitch-client-core");
  assert.equal(published.prNumber, 321);
  assert.equal(published.remoteUrl, "https://github.com/juspay/hyperswitch-web.git");
  assert.deepEqual(observed.map((entry) => entry.kind), ["push", "pr"]);
  assert.equal(observed[0].repoSlug, "juspay/hyperswitch-web");
  assert.match(String(observed[0].targetCommit), /^[a-f0-9]{40}$/);
  assert.match(String(observed[0].baseCommit), /^[a-f0-9]{40}$/);
  assert.equal(observed[1].repoSlug, "juspay/hyperswitch-web");
  assert.equal(observed[1].draft, true);

  const beforeRejected = observed.length;
  await assert.rejects(
    () => publishPullRequest({
      repoDir: "/unused/by-early-rejection",
      repoKey: "mobile",
      branch: "feat/submodule-change",
      title: "feat: submodule change",
      body: "body",
      submodulesChanged: ["shared-code", "ios", "shared-code"],
    }, fake),
    (error: unknown) => {
      assert.ok(error instanceof SubmodulePublishingRequiredError);
      assert.deepEqual(error.submodules, ["shared-code", "ios"]);
      assert.equal(error.code, "SUBMODULE_PRS_REQUIRED");
      return true;
    },
  );
  assert.equal(observed.length, beforeRejected, "submodule rejection must happen before publishing");

  await assert.rejects(
    () => publishPullRequest({
      repoDir: "/unused/by-early-rejection",
      repoKey: "web",
      branch: "main",
      title: "bad",
      body: "bad",
    }, fake),
    /protected or empty branch/,
  );

  await assert.rejects(
    () => publishPullRequest({
      repoDir: fixture,
      repoKey: "web",
      branch: "feat/direct-upstream-check",
      title: "bad",
      body: "bad",
    }, {
      async pushBranch() { /* no network */ },
      async createOrFindPullRequest() {
        return "https://github.com/someone/hyperswitch-web/pull/1";
      },
    }),
    /unexpected canonical PR URL/,
  );

  // A secret that is removed in a later commit still exists in branch history
  // and must be caught before the transport sees any request.
  git("checkout", "main");
  git("checkout", "-b", "feat/secret-in-history");
  const fakePat = ["ghp", "7E3kP9mQ2xR8vL4nT6yU1aB5cD0fG7hJ3Z9s"].join("_");
  commitFile("temporary-leak.txt", `token=${fakePat}\n`, "accidentally add credential");
  fs.unlinkSync(path.join(fixture, "temporary-leak.txt"));
  git("add", "-u", "--", "temporary-leak.txt");
  git("commit", "-m", "remove credential");
  const beforeSecret = observed.length;
  await assert.rejects(
    () => publishPullRequest({
      repoDir: fixture,
      repoKey: "web",
      branch: "feat/secret-in-history",
      title: "must not publish",
      body: "body",
    }, fake),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanBlockedError);
      assert.equal(error.code, "SECRET_SCAN_BLOCKED");
      assert.ok(!error.message.includes(fakePat), "secret values must stay redacted");
      return true;
    },
  );
  assert.equal(observed.length, beforeSecret, "secret rejection must happen before publishing");

  // An ignored/untracked workspace .env is itself never staged here, but a
  // value copied out of it must still be detected in an unrelated source file.
  git("checkout", "main");
  git("checkout", "-b", "feat/copied-workspace-env");
  const workspaceSecret = "hs_workspace_only_7fK2mQ9vL4xR8tN6";
  const encodedWorkspaceSecret = Buffer.from(workspaceSecret).toString("base64");
  fs.writeFileSync(path.join(fixture, ".env"), `HYPERSWITCH_SECRET_KEY=${workspaceSecret}\n`);
  commitFile(
    "copied-value.ts",
    `export const raw = "${workspaceSecret}";\nexport const encoded = "${encodedWorkspaceSecret}";\n`,
    "copy a workspace value",
  );
  commitFile(`${workspaceSecret}.txt`, "placeholder\n", "put a credential in a filename");
  const beforeWorkspaceSecret = observed.length;
  await assert.rejects(
    () => publishPullRequest({
      repoDir: fixture,
      repoKey: "web",
      branch: "feat/copied-workspace-env",
      title: "must not publish",
      body: "body",
    }, fake),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanBlockedError);
      assert.ok(error.findings.some((finding) => finding.rule.includes("workspace-env:HYPERSWITCH_SECRET_KEY")));
      assert.ok(error.findings.some((finding) => finding.rule.includes("workspace-env:HYPERSWITCH_SECRET_KEY:base64")));
      assert.ok(!error.message.includes(workspaceSecret), "workspace secret values must stay redacted");
      assert.ok(!error.message.includes(encodedWorkspaceSecret), "encoded workspace secrets must stay redacted");
      assert.ok(
        error.findings.every((finding) => !finding.location.includes(workspaceSecret)),
        "finding locations must redact credentials embedded in filenames",
      );
      return true;
    },
  );
  assert.equal(observed.length, beforeWorkspaceSecret, "workspace secret rejection must happen before publishing");
  fs.unlinkSync(path.join(fixture, ".env"));

  // PR title/body are remote data too, so they cross the same gate.
  git("checkout", "feat/direct-upstream-check");
  const beforeMetadataSecret = observed.length;
  await assert.rejects(
    () => publishPullRequest({
      repoDir: fixture,
      repoKey: "web",
      branch: "feat/direct-upstream-check",
      title: "safe title",
      body: `accidental token ${fakePat}`,
    }, fake),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanBlockedError);
      assert.ok(error.findings.some((finding) => finding.location === "pull request body"));
      assert.ok(!error.message.includes(fakePat), "PR metadata secrets must stay redacted");
      return true;
    },
  );
  assert.equal(observed.length, beforeMetadataSecret, "metadata rejection must happen before publishing");

  // Sensitive files are blocked even when their contents look like placeholders.
  git("checkout", "main");
  git("checkout", "-b", "feat/sensitive-file");
  commitFile(".env.local", "API_KEY=replace-me\n", "add local environment file");
  await assert.rejects(
    () => publishPullRequest({
      repoDir: fixture,
      repoKey: "web",
      branch: "feat/sensitive-file",
      title: "must not publish",
      body: "body",
    }, fake),
    (error: unknown) => {
      assert.ok(error instanceof SecretScanBlockedError);
      assert.ok(error.findings.some((finding) => finding.rule === "sensitive-path/dotenv"));
      return true;
    },
  );

  // The gate is fail-closed: an unavailable scanner cannot silently pass.
  git("checkout", "feat/direct-upstream-check");
  const previousBinary = process.env.GITLEAKS_BIN;
  process.env.GITLEAKS_BIN = path.join(fixture, "missing-gitleaks");
  try {
    await assert.rejects(
      () => publishPullRequest({
        repoDir: fixture,
        repoKey: "web",
        branch: "feat/direct-upstream-check",
        title: "must not publish",
        body: "body",
      }, fake),
      (error: unknown) => {
        assert.ok(error instanceof SecretScanUnavailableError);
        assert.equal(error.code, "SECRET_SCAN_UNAVAILABLE");
        return true;
      },
    );
  } finally {
    if (previousBinary === undefined) delete process.env.GITLEAKS_BIN;
    else process.env.GITLEAKS_BIN = previousBinary;
  }

  console.log("canonical GitHub publishing and secret-gate checks passed");
}

try {
  await main();
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
