/**
 * Fail-closed secret scanning for branches about to leave the machine.
 *
 * The scanner examines every commit in baseCommit..targetCommit, not only the final diff,
 * because a secret that was added and later deleted is still present in Git
 * history and would be uploaded by `git push`.
 *
 * Two independent checks run over both Git history and pull-request metadata:
 *   1. local policy checks reject sensitive paths, known credential formats,
 *      and exact/raw or base64 values captured from workspace `.env*` files
 *      and secret-shaped environment variables;
 *   2. gitleaks scans the full commit range and metadata with a dashboard-owned
 *      config and ignore file that the generated SDK branch cannot modify.
 *
 * Findings are always redacted. A missing scanner, malformed history, timeout,
 * or any other scan failure blocks publishing rather than failing open.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPOS } from "../config.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const GITLEAKS_CONFIG = path.resolve(MODULE_DIR, "../../config/gitleaks.toml");
const GITLEAKS_IGNORE = path.resolve(MODULE_DIR, "../../config/gitleaksignore");
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_FINDINGS = 50;

export interface SecretFinding {
  rule: string;
  location: string;
  commit?: string;
  line?: number;
}

export interface SecretScanResult {
  commitsScanned: number;
  blobsScanned: number;
}

export class SecretScanBlockedError extends Error {
  readonly code = "SECRET_SCAN_BLOCKED" as const;

  constructor(readonly findings: SecretFinding[]) {
    const preview = findings.slice(0, 5).map((finding) => {
      const line = finding.line ? `:${finding.line}` : "";
      const commit = finding.commit ? ` @ ${finding.commit.slice(0, 8)}` : "";
      return `${finding.rule} in ${finding.location}${line}${commit}`;
    }).join("; ");
    const more = findings.length > 5 ? `; and ${findings.length - 5} more` : "";
    super(`[SECRET_SCAN_BLOCKED] Publishing stopped (${findings.length} finding(s)): ${preview}${more}. No secret values are shown.`);
    this.name = "SecretScanBlockedError";
  }
}

export class SecretScanUnavailableError extends Error {
  readonly code = "SECRET_SCAN_UNAVAILABLE" as const;

  constructor(message: string) {
    super(`[SECRET_SCAN_UNAVAILABLE] Publishing stopped because secret scanning could not complete: ${message}`);
    this.name = "SecretScanUnavailableError";
  }
}

interface ProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; maxOutputBytes?: number; input?: Buffer },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const maxBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT;

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      reject(error);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finishError(new Error(`${command} produced more than ${maxBytes} bytes of scan output`));
        return;
      }
      target.push(Buffer.from(chunk));
    };

    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", finishError);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    timer = setTimeout(
      () => finishError(new Error(`${command} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
    if (options.input && child.stdin) {
      child.stdin.on("error", () => { /* child error/exit owns the result */ });
      child.stdin.end(options.input);
    }
  });
}

async function runGit(repoDir: string, args: string[], maxOutputBytes = MAX_COMMAND_OUTPUT): Promise<Buffer> {
  let result: ProcessResult;
  try {
    result = await runProcess("git", ["-C", repoDir, ...args], {
      timeoutMs: 30_000,
      maxOutputBytes,
    });
  } catch (error) {
    throw new SecretScanUnavailableError((error as Error).message);
  }
  if (result.code !== 0) {
    throw new SecretScanUnavailableError(`git ${args[0] ?? "command"} failed while inspecting the branch`);
  }
  return result.stdout;
}

interface ProtectedValue {
  labels: string[];
  value: Buffer;
}

const ENV_SCAN_SKIPPED_DIRS = new Set([
  ".git", ".cache", "build", "coverage", "DerivedData", "dist", "lib",
  "node_modules", "Pods", "tmp",
]);

function isPlaceholderValue(value: string): boolean {
  return value.length < 8 ||
    /^(?:true|false|null|undefined|development|production|test)$/i.test(value) ||
    /^(?:x+|\*+|<[^>]+>|\$\{[^}]+\})$/i.test(value) ||
    /(?:change-?me|replace-?me|your[_-].*(?:key|token|secret)|example|dummy|placeholder)/i.test(value);
}

function parseEnvFile(file: string, repoDir: string, strict: boolean): Array<{ label: string; value: string }> {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch {
    if (strict) throw new SecretScanUnavailableError("could not inspect a protected environment file");
    return [];
  }
  if (!stat.isFile()) return [];
  if (stat.size > 1024 * 1024) {
    if (strict) throw new SecretScanUnavailableError("a protected environment file is too large to scan");
    return [];
  }

  let content: string;
  try { content = fs.readFileSync(file, "utf8"); }
  catch {
    if (strict) throw new SecretScanUnavailableError("could not read a protected environment file");
    return [];
  }
  const values: Array<{ label: string; value: string }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (!key || isPlaceholderValue(value)) continue;
    const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : "unnamed-value";
    values.push({ label: `workspace-env:${safeKey}`, value });
  }
  return values;
}

function workspaceEnvValues(repoDir: string, strict = false): Array<{ label: string; value: string }> {
  const found: Array<{ label: string; value: string }> = [];
  if (!fs.existsSync(repoDir)) return found;
  const pending: string[] = [repoDir];

  while (pending.length > 0) {
    const next = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(next, { withFileTypes: true }); }
    catch {
      if (strict) throw new SecretScanUnavailableError("could not completely inspect the workspace for protected environment files");
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(next, entry.name);
      const isEnvFile = entry.name === ".env" || entry.name.startsWith(".env.");
      if (entry.isSymbolicLink()) {
        if (isEnvFile) found.push(...parseEnvFile(absolute, repoDir, strict));
        continue;
      }
      if (entry.isDirectory()) {
        if (!ENV_SCAN_SKIPPED_DIRS.has(entry.name)) {
          pending.push(absolute);
        }
        continue;
      }
      if (entry.isFile() && isEnvFile) {
        found.push(...parseEnvFile(absolute, repoDir, strict));
      }
    }
  }
  return found;
}

// Captured when the server imports the publisher, before any agent receives
// workspace access. A fresh scan is merged at publish time so key rotations are
// also protected. Only values live in memory; nothing is logged or persisted.
const STARTUP_WORKSPACE_VALUES = new Map<string, Array<{ label: string; value: string }>>(
  Object.values(REPOS).map((repo) => [path.resolve(repo.dir), workspaceEnvValues(repo.dir)]),
);

function protectedValues(repoDir: string): ProtectedValue[] {
  const byValue = new Map<string, string[]>();
  const add = (value: string, label: string): void => {
    if (isPlaceholderValue(value)) return;
    const labels = byValue.get(value) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byValue.set(value, labels);
  };

  const secretName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;
  for (const [name, raw] of Object.entries(process.env)) {
    if (!secretName.test(name) || typeof raw !== "string") continue;
    const value = raw.trim();
    add(value, `process-env:${name}`);
  }

  // A PR Port agent can read one SDK and write the other. Protect values from
  // every configured SDK workspace, not only the repository being published.
  for (const entries of STARTUP_WORKSPACE_VALUES.values()) {
    for (const entry of entries) add(entry.value, entry.label);
  }
  const configuredDirs = new Set(Object.values(REPOS).map((repo) => path.resolve(repo.dir)));
  for (const repo of Object.values(REPOS)) {
    for (const entry of workspaceEnvValues(repo.dir, true)) add(entry.value, entry.label);
  }
  // Keep isolated fixtures and any future explicitly supplied repository safe
  // even when it is not one of the two configured workspaces.
  if (!configuredDirs.has(path.resolve(repoDir))) {
    for (const entry of workspaceEnvValues(repoDir, true)) add(entry.value, entry.label);
  }

  const originals = [...byValue.entries()];
  for (const [value, labels] of originals) {
    const bytes = Buffer.from(value);
    const variants = [
      { kind: "base64", value: bytes.toString("base64") },
      { kind: "base64url", value: bytes.toString("base64url") },
      { kind: "hex", value: bytes.toString("hex") },
      { kind: "url-encoded", value: encodeURIComponent(value) },
    ];
    for (const variant of variants) {
      if (variant.value === value || variant.value.length < 12) continue;
      for (const label of labels) add(variant.value, `${label}:${variant.kind}`);
    }
  }

  return [...byValue.entries()].map(([value, labels]) => ({ labels: labels.sort(), value: Buffer.from(value) }));
}

const SENSITIVE_PATH_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "sensitive-path/dotenv", pattern: /(^|\/)\.env(?:$|\.)/i },
  { rule: "sensitive-path/private-key", pattern: /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision))$/i },
  { rule: "sensitive-path/credential-store", pattern: /(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc|_netrc|\.dockercfg|local\.properties|google-services\.json|GoogleService-Info\.plist|service-account\.json|credentials\.(?:json|ya?ml|toml)|secrets?\.(?:json|ya?ml|toml)|terraform\.tfstate(?:\..*)?|[^/]+\.tfvars(?:\.json)?)$/i },
  { rule: "sensitive-path/scanner-policy", pattern: /(?:^|\/)(?:\.gitleaks\.toml|\.gitleaksignore)$/i },
  { rule: "sensitive-path/opaque-archive", pattern: /\.(?:7z|rar|tar|tar\.gz|tgz|zip)$/i },
];

const CONTENT_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "content/private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { rule: "content/github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g },
  { rule: "content/gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { rule: "content/aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { rule: "content/google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { rule: "content/slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "content/stripe-secret-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { rule: "content/npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { rule: "content/sendgrid-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { rule: "content/bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { rule: "content/basic-auth-url", pattern: /(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^/\s@]{8,}@/g },
];

const CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret[_-]?key|secret|token)\b\s*[:=]\s*["'`]([^"'`\r\n]{8,})["'`]/gi;

/** Keep a credential embedded in a filename from leaking through a finding. */
function safeFileLocation(file: string, secrets: ProtectedValue[]): string {
  let safe = file;
  for (const entry of secrets) {
    const value = entry.value.toString("utf8");
    if (value) safe = safe.split(value).join("[REDACTED]");
  }
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    safe = safe.replace(rule.pattern, "[REDACTED]");
  }
  return safe.length <= 240 ? safe : `${safe.slice(0, 220)}…[truncated]`;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    total -= p * Math.log2(p);
  }
  return total;
}

function addFinding(findings: SecretFinding[], finding: SecretFinding): void {
  if (findings.length < MAX_FINDINGS) findings.push(finding);
}

function scanLocation(
  data: Buffer,
  location: string,
  commit: string,
  secrets: ProtectedValue[],
  findings: SecretFinding[],
): void {
  for (const entry of secrets) {
    const offset = data.indexOf(entry.value);
    if (offset < 0) continue;
    const line = data.subarray(0, offset).toString("utf8").split("\n").length;
    addFinding(findings, {
      rule: `protected-value/${entry.labels.join("+")}`,
      location,
      commit: commit.slice(0, 12),
      line,
    });
  }

  const text = data.toString("utf8");
  if (data.includes(0)) {
    addFinding(findings, {
      rule: "content/binary-blob-requires-manual-review",
      location,
      commit: commit.slice(0, 12),
    });
  }
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:/m.test(text)) {
    addFinding(findings, {
      rule: "content/git-lfs-object-requires-manual-review",
      location,
      commit: commit.slice(0, 12),
      line: 1,
    });
  }
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    addFinding(findings, {
      rule: rule.rule,
      location,
      commit: commit.slice(0, 12),
      line: text.slice(0, match.index).split("\n").length,
    });
  }

  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  for (let match = CREDENTIAL_ASSIGNMENT.exec(text); match; match = CREDENTIAL_ASSIGNMENT.exec(text)) {
    const value = match[1].trim();
    if (isPlaceholderValue(value) || /^[A-Z][A-Z0-9_]+$/.test(value) || entropy(value) < 3.2) continue;
    addFinding(findings, {
      rule: "content/high-entropy-credential-assignment",
      location,
      commit: commit.slice(0, 12),
      line: text.slice(0, match.index).split("\n").length,
    });
    break;
  }
}

async function localPolicyScan(
  repoDir: string,
  baseCommit: string,
  targetCommit: string,
): Promise<{ result: SecretScanResult; findings: SecretFinding[] }> {
  const range = `${baseCommit}..${targetCommit}`;
  const commits = (await runGit(repoDir, ["rev-list", "--reverse", range]))
    .toString("utf8")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const findings: SecretFinding[] = [];
  const secrets = protectedValues(repoDir);
  let blobsScanned = 0;

  for (const commit of commits) {
    const parentLine = (await runGit(repoDir, ["rev-list", "--parents", "-n", "1", commit]))
      .toString("utf8").trim().split(/\s+/);
    if (parentLine.length > 2) {
      addFinding(findings, {
        rule: "history/merge-commit-requires-manual-review",
        location: "commit history",
        commit: commit.slice(0, 12),
      });
      continue;
    }

    const metadata = await runGit(repoDir, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", commit]);
    scanLocation(metadata, "commit metadata/message", commit, secrets, findings);

    const changed = await runGit(repoDir, [
      "diff-tree", "--root", "--no-commit-id", "-r", "--no-renames",
      "--diff-filter=ACMT", "--name-only", "-z", commit,
    ]);
    const paths = changed.toString("utf8").split("\0").filter(Boolean);

    for (const file of paths) {
      const safeFile = safeFileLocation(file, secrets);
      for (const rule of SENSITIVE_PATH_RULES) {
        if (rule.pattern.test(file)) {
          addFinding(findings, { rule: rule.rule, location: safeFile, commit: commit.slice(0, 12) });
        }
      }
      scanLocation(Buffer.from(file), "file path", commit, secrets, findings);

      const treeEntry = (await runGit(repoDir, ["ls-tree", "-z", commit, "--", file]))
        .toString("utf8").replace(/\0$/, "");
      const tab = treeEntry.indexOf("\t");
      const metadata = (tab >= 0 ? treeEntry.slice(0, tab) : treeEntry).split(/\s+/);
      const objectType = metadata[1];
      const objectId = metadata[2];
      if (objectType === "commit") {
        addFinding(findings, {
          rule: "history/submodule-pointer-requires-separate-publishing",
          location: safeFile,
          commit: commit.slice(0, 12),
        });
        continue;
      }
      if (objectType !== "blob" || !objectId) {
        throw new SecretScanUnavailableError("could not resolve a committed blob");
      }

      const size = Number((await runGit(repoDir, ["cat-file", "-s", objectId])).toString("utf8").trim());
      if (!Number.isFinite(size) || size < 0) {
        throw new SecretScanUnavailableError("could not determine a committed blob size");
      }
      if (size > MAX_BLOB_BYTES) {
        addFinding(findings, {
          rule: "content/blob-too-large-to-scan",
          location: safeFile,
          commit: commit.slice(0, 12),
        });
        continue;
      }

      const blob = await runGit(repoDir, ["cat-file", "blob", objectId], MAX_BLOB_BYTES + 1024);
      blobsScanned++;
      scanLocation(blob, safeFile, commit, secrets, findings);
    }
  }

  return { result: { commitsScanned: commits.length, blobsScanned }, findings };
}

interface GitleaksReportEntry {
  RuleID?: unknown;
  Description?: unknown;
  File?: unknown;
  StartLine?: unknown;
  Commit?: unknown;
}

function gitleaksPolicyArgs(): string[] {
  return [
    "--no-banner",
    "--no-color",
    "--redact=100",
    "--exit-code=42",
    "--log-level=error",
    "--report-format=json",
    "--report-path=-",
    "--config", GITLEAKS_CONFIG,
    "--gitleaks-ignore-path", GITLEAKS_IGNORE,
    "--ignore-gitleaks-allow",
    "--max-decode-depth=5",
  ];
}

function parseGitleaksResult(result: ProcessResult, defaultLocation: string): SecretFinding[] {
  if (result.code === 0) return [];
  if (result.code !== 42) {
    throw new SecretScanUnavailableError(`gitleaks exited ${result.code ?? "without a status"}`);
  }

  let parsed: GitleaksReportEntry[] = [];
  try {
    const value = JSON.parse(result.stdout.toString("utf8")) as unknown;
    if (Array.isArray(value)) parsed = value as GitleaksReportEntry[];
  } catch { /* a leak exit still blocks below with a generic redacted finding */ }
  if (parsed.length === 0) return [{ rule: "gitleaks/detected", location: defaultLocation }];
  return parsed.slice(0, MAX_FINDINGS).map((entry) => {
    return {
      rule: `gitleaks/${typeof entry.RuleID === "string" ? entry.RuleID : "detected"}`,
      // Scanner paths are branch-controlled and may themselves contain a
      // credential. The local policy reports a redacted path when possible;
      // the independent scanner deliberately reports only this safe scope.
      location: defaultLocation,
      commit: typeof entry.Commit === "string" && /^[a-f0-9]{7,64}$/i.test(entry.Commit)
        ? entry.Commit.slice(0, 12)
        : undefined,
      line: typeof entry.StartLine === "number" && Number.isFinite(entry.StartLine) && entry.StartLine > 0
        ? entry.StartLine
        : undefined,
    };
  });
}

function unavailableGitleaksError(error: unknown): SecretScanUnavailableError {
  const detail = (error as NodeJS.ErrnoException).code === "ENOENT"
    ? `gitleaks is not installed or not on PATH (run: brew install gitleaks)`
    : "the gitleaks process failed or timed out";
  return new SecretScanUnavailableError(detail);
}

async function runGitleaksOnGit(
  repoDir: string,
  baseCommit: string,
  targetCommit: string,
): Promise<SecretFinding[]> {
  const binary = process.env.GITLEAKS_BIN?.trim() || "gitleaks";
  let result: ProcessResult;
  try {
    result = await runProcess(binary, [
      "git",
      ...gitleaksPolicyArgs(),
      "--max-archive-depth=2",
      "--log-opts", `${baseCommit}..${targetCommit}`,
      repoDir,
    ], { timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024 });
  } catch (error) {
    throw unavailableGitleaksError(error);
  }
  return parseGitleaksResult(result, "branch history");
}

async function runGitleaksOnMetadata(data: Buffer): Promise<SecretFinding[]> {
  const binary = process.env.GITLEAKS_BIN?.trim() || "gitleaks";
  let result: ProcessResult;
  try {
    result = await runProcess(binary, ["stdin", ...gitleaksPolicyArgs()], {
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024,
      input: data,
    });
  } catch (error) {
    throw unavailableGitleaksError(error);
  }
  return parseGitleaksResult(result, "pull request metadata");
}

function localMetadataScan(repoDir: string, branch: string, title: string, body: string): SecretFinding[] {
  const secrets = protectedValues(repoDir);
  const findings: SecretFinding[] = [];
  scanLocation(Buffer.from(branch), "branch name", "", secrets, findings);
  scanLocation(Buffer.from(title), "pull request title", "", secrets, findings);
  scanLocation(Buffer.from(body), "pull request body", "", secrets, findings);
  return findings;
}

/**
 * Assert that every commit and every piece of PR metadata which would leave the
 * machine is free of detectable secrets. Any finding or inability to complete
 * all scans throws before the publisher's transport is invoked.
 */
export async function assertPublishPayloadContainsNoSecrets(
  input: {
    repoDir: string;
    baseCommit: string;
    targetCommit: string;
    branch: string;
    title: string;
    body: string;
  },
): Promise<SecretScanResult> {
  const local = await localPolicyScan(input.repoDir, input.baseCommit, input.targetCommit);
  const metadataFindings = localMetadataScan(input.repoDir, input.branch, input.title, input.body);
  const localFindings = [...local.findings, ...metadataFindings].slice(0, MAX_FINDINGS);
  if (localFindings.length > 0) throw new SecretScanBlockedError(localFindings);

  const gitleaksFindings = await runGitleaksOnGit(
    input.repoDir,
    input.baseCommit,
    input.targetCommit,
  );
  if (gitleaksFindings.length > 0) throw new SecretScanBlockedError(gitleaksFindings);
  const metadata = Buffer.from(
    `Branch name:\n${input.branch}\n\nPull request title:\n${input.title}\n\nPull request body:\n${input.body}\n`,
  );
  const metadataGitleaksFindings = await runGitleaksOnMetadata(metadata);
  if (metadataGitleaksFindings.length > 0) throw new SecretScanBlockedError(metadataGitleaksFindings);
  return local.result;
}
