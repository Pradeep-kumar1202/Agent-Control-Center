/**
 * PR Port skill — translate one exact PR from web -> mobile or mobile -> web.
 *
 * The public interface is the Express handler plus deterministic URL resolve.
 * Runtime selection, source analysis, target mutation, gates, preservation,
 * push and persistence stay behind that seam so callers cannot accidentally
 * skip a quality gate.
 */

import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { PATCHES_DIR, REPOS, type RepoKey } from "../../config.js";
import { db, saveSkillRun } from "../../db.js";
import { renderAgent, type VarBag } from "../../agents/loader.js";
import {
  computePatchVerdict,
  parseDiffFiles,
  runPatchValidators,
} from "../../agents/patchValidators.js";
import {
  AgentsNotConfiguredError,
  UnsupportedRuntimeCapabilityError,
  resolveRun,
  runAgent,
  type AccessPolicy,
  type AgentSlot,
  type ProfileSnapshot,
  type Usage,
} from "../../runtime/index.js";
import { validateAgentSettings, type AgentSettings } from "../../runtime/settings.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";
import { getBranchDiff } from "../prDiff.js";
import { resolvePortDirection, type PortDirection } from "../prUrl.js";
import { runRescriptBuild } from "../buildCheck.js";
import {
  captureSubmoduleHeads,
  commitWithSubmodules,
  forceCheckoutBranch,
  getDiffWithSubmodules,
  restoreSubmoduleHeads,
  submoduleDirsFor,
  type SubmoduleCommitResult,
  type SubmoduleHead,
} from "../submoduleGit.js";
import {
  commitsAheadOfForkMain,
  createPullRequest,
  formatPortPrBody,
  pushBranchToFork,
  pushSubmoduleToFork,
  rewriteGitmodulesToForks,
} from "../githubPr.js";
import { withRepoLocks } from "../../workspace/mutex.js";

export interface PrPortInput {
  prUrl: string;
}

type ChangeKind = "config" | "component" | "api" | "bugfix" | "refactor" | "infra";
type Portability = "yes" | "partial" | "no";
type PortOutcome = "pass" | "needs_review" | "non_portable" | "build_failed" | "rejected" | "error" | "cancelled";

export interface PortFileDecision {
  path: string;
  why: string;
}

export interface TriageResult {
  featureName: string;
  changeKind: ChangeKind;
  portability: Portability;
  reasons: string[];
  portableFiles: PortFileDecision[];
  skippedFiles: PortFileDecision[];
}

export interface PortSpec {
  featureName: string;
  changeKind: ChangeKind;
  behavior: string;
  sourceFiles: Array<{ path: string; role: string; whatChanged: string }>;
  implementationSteps: string[];
  typeDefinition?: string;
  configKey?: string;
  defaultValue?: string;
  reScriptGotchas: string[];
  notPorting: PortFileDecision[];
}

interface VerifierResult {
  parsed: boolean;
  pass: boolean;
  issues: string[];
  raw: string;
}

interface AgentTotals extends Usage {
  stages: number;
}

interface PipelineContext {
  direction: PortDirection;
  snapshot: ProfileSnapshot;
  emit: (event: unknown) => void;
  signal: AbortSignal;
  usage: AgentTotals;
}

const PORT_SLOTS: AgentSlot[] = [
  "port.triage",
  "port.source-analyst",
  "port.implementer",
  "port.verifier",
];

const PORT_ACCESS: Partial<Record<AgentSlot, AccessPolicy>> = {
  "port.triage": "repo-read",
  "port.source-analyst": "repo-read",
  "port.implementer": "repo-write",
  "port.verifier": "repo-read",
};

const CHANGE_KINDS = new Set<ChangeKind>(["config", "component", "api", "bugfix", "refactor", "infra"]);
const PORTABILITIES = new Set<Portability>(["yes", "partial", "no"]);
const MAX_STREAM_ERROR = 4000;

// ─── deterministic triage ──────────────────────────────────────────────────

const WEB_ONLY_FORM_TOKENS = [
  "blikcode", "pixpayment", "vpaid", "documentnumber", "cryptocurrencynetwork", "giftcardform",
];

const compactToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Non-binding, zero-token evidence passed into the triage stage. */
export function deterministicPortabilityHints(
  source: RepoKey,
  target: RepoKey,
  diff: string,
): string[] {
  const files = parseDiffFiles(diff);
  const hints: string[] = [];

  if (source === "web" && target === "mobile") {
    for (const file of files) {
      const token = compactToken(file.path);
      if (WEB_ONLY_FORM_TOKENS.some((t) => token.includes(t))) {
        hints.push(`${file.path}: looks like a dedicated payment-method input; mobile commonly renders this from backend field metadata`);
      }
    }
    const added = files.flatMap((f) => f.addedLines).join("\n");
    if (/(?:supported|available|enabled)?paymentMethods?\s*[:=]\s*\[/i.test(added)) {
      hints.push("Added code appears to define a static payment-method list; mobile obtains that list from backend responses");
    }
  }

  if (source === "mobile" && target === "web") {
    const changed = files.map((f) => f.path);
    if (changed.length > 0 && changed.every((p) => /^(ios|android)\//.test(p))) {
      hints.push("Every changed file is native-only (ios/ or android/); no direct web artifact exists unless the PR establishes shared behavior");
    }
  }

  return [...new Set(hints)];
}

// ─── structured output parsing ──────────────────────────────────────────────

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = fenced ? [fenced[1].trim()] : [];
  const start = text.search(/[\[{]/);
  if (start >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  throw new Error("agent output was not valid JSON");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseFileDecisions(value: unknown, field: string): PortFileDecision[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.why !== "string") {
      throw new Error(`${field}[${index}] must contain path and why strings`);
    }
    return { path: entry.path, why: entry.why };
  });
}

export function parseTriageResult(text: string): TriageResult {
  const value = extractJson(text);
  if (!isRecord(value)) throw new Error("triage result must be an object");
  if (typeof value.featureName !== "string" || !value.featureName.trim()) throw new Error("triage featureName is required");
  if (!CHANGE_KINDS.has(value.changeKind as ChangeKind)) throw new Error("triage changeKind is invalid");
  if (!PORTABILITIES.has(value.portability as Portability)) throw new Error("triage portability is invalid");
  if (!isStringArray(value.reasons)) throw new Error("triage reasons must be an array of strings");
  const portableFiles = parseFileDecisions(value.portableFiles, "portableFiles");
  const skippedFiles = parseFileDecisions(value.skippedFiles, "skippedFiles");
  if (value.portability !== "yes" && value.reasons.length === 0) {
    throw new Error("triage must explain partial/no portability");
  }
  if (value.portability !== "no" && portableFiles.length === 0) {
    throw new Error("triage marked work portable but named no portable files");
  }
  return {
    featureName: value.featureName.trim(),
    changeKind: value.changeKind as ChangeKind,
    portability: value.portability as Portability,
    reasons: value.reasons,
    portableFiles,
    skippedFiles,
  };
}

export function parsePortSpec(text: string, sourceDir: string, sourceDiff: string): PortSpec {
  const value = extractJson(text);
  if (!isRecord(value)) throw new Error("port spec must be an object");
  if (typeof value.featureName !== "string" || !value.featureName.trim()) throw new Error("port spec featureName is required");
  if (!CHANGE_KINDS.has(value.changeKind as ChangeKind)) throw new Error("port spec changeKind is invalid");
  if (typeof value.behavior !== "string" || !value.behavior.trim()) throw new Error("port spec behavior is required");
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length === 0) throw new Error("port spec sourceFiles is required");
  if (!isStringArray(value.implementationSteps) || value.implementationSteps.length === 0) {
    throw new Error("port spec implementationSteps is required");
  }

  const changedPaths = new Set(parseDiffFiles(sourceDiff).map((f) => f.path));
  const sourceFiles = value.sourceFiles.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.role !== "string" || typeof entry.whatChanged !== "string") {
      throw new Error(`sourceFiles[${index}] must contain path, role and whatChanged strings`);
    }
    const normalized = path.posix.normalize(entry.path.replaceAll("\\", "/"));
    if (normalized.startsWith("../") || normalized.startsWith("/") || normalized === "..") {
      throw new Error(`sourceFiles[${index}] escapes the source repo: ${entry.path}`);
    }
    const existsInCheckout = fs.existsSync(path.join(sourceDir, normalized));
    if (!existsInCheckout && !changedPaths.has(normalized)) {
      throw new Error(`sourceFiles[${index}] is not present in the checkout or PR diff: ${normalized}`);
    }
    return { path: normalized, role: entry.role, whatChanged: entry.whatChanged };
  });

  const optionalString = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key] !== "" ? value[key] as string : undefined;
  return {
    featureName: value.featureName.trim(),
    changeKind: value.changeKind as ChangeKind,
    behavior: value.behavior.trim(),
    sourceFiles,
    implementationSteps: value.implementationSteps,
    typeDefinition: optionalString("typeDefinition"),
    configKey: optionalString("configKey"),
    defaultValue: optionalString("defaultValue"),
    reScriptGotchas: isStringArray(value.reScriptGotchas) ? value.reScriptGotchas : [],
    notPorting: value.notPorting === undefined ? [] : parseFileDecisions(value.notPorting, "notPorting"),
  };
}

function parseVerifier(text: string): VerifierResult {
  try {
    const value = extractJson(text);
    if (!isRecord(value) || typeof value.pass !== "boolean" || !isStringArray(value.issues)) {
      throw new Error("verifier result has the wrong shape");
    }
    const issues = value.pass === false && value.issues.length === 0
      ? ["Verifier rejected the port without naming an issue"]
      : value.issues;
    return { parsed: true, pass: value.pass, issues, raw: text };
  } catch {
    return { parsed: false, pass: false, issues: [], raw: text };
  }
}

// ─── agent execution ────────────────────────────────────────────────────────

function mergeUsage(total: AgentTotals, usage: Usage): void {
  for (const key of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens", "costUsd", "numTurns", "durationMs",
  ] as const) {
    const value = usage[key];
    if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
  }
}

async function runDefinition(
  ctx: PipelineContext,
  id: string,
  vars: VarBag,
  cwd: string,
  sourceDir: string,
  targetDir: string,
  allowEmpty = false,
): Promise<string> {
  const rendered = renderAgent(id, vars, {
    SOURCE_DIR: sourceDir,
    TARGET_DIR: targetDir,
    TOOL_NOTES: "Use only the repository tools allowed by this stage.",
    OUTPUT_NOTES: "Return only the requested structured output.",
    BUILD_COMMAND: "npm run --silent re:build 2>&1",
    BUILD_NOTES: "Cold ReScript builds may take up to 180 seconds.",
  });

  let text = "";
  let failure: string | null = null;
  for await (const event of runAgent({
    slot: rendered.def.slot,
    prompt: rendered.prompt,
    cwd,
    access: rendered.def.access,
    outputSchema: rendered.schema,
    timeoutMs: rendered.def.timeoutMs,
    signal: ctx.signal,
  }, ctx.snapshot)) {
    ctx.emit(event);
    if (event.type === "text") text += event.text;
    else if (event.type === "usage") mergeUsage(ctx.usage, event.usage);
    else if (event.type === "error") failure = event.error;
  }
  ctx.usage.stages++;
  if (failure) throw new Error(failure);
  if (!allowEmpty && !text.trim()) throw new Error(`${id} returned no output`);
  return text.trim();
}

// ─── workspace safety ───────────────────────────────────────────────────────

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const err = new Error("PR port cancelled");
  err.name = "AbortError";
  throw err;
}

async function assertWorkspaceReady(repoKey: RepoKey, requireMain: boolean): Promise<void> {
  const repoDir = REPOS[repoKey].dir;
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error(`Workspace repo is missing: ${repoDir}. Run npm run setup first.`);
  }
  const git = simpleGit(repoDir);
  const status = await git.status();
  if (requireMain && status.current !== "main") {
    throw new Error(`${REPOS[repoKey].name} must be on main before it can be used as the read-only source (currently ${status.current ?? "detached"})`);
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
    const subStatus = await simpleGit(subDir).status();
    if (!subStatus.isClean()) throw new Error(`${REPOS[repoKey].name}/${sub} has unrelated working-tree changes`);
  }
}

async function cleanupTarget(
  repoKey: RepoKey,
  baseline: SubmoduleHead[],
  branchName: string,
  keepBranch: boolean,
): Promise<void> {
  const repoDir = REPOS[repoKey].dir;
  await forceCheckoutBranch(repoDir, repoKey, "main");
  // Safe because assertWorkspaceReady proved there were no parent-level
  // untracked files before the run and the repo lock excludes concurrent jobs.
  await simpleGit(repoDir).clean("f", ["-d"]);
  await restoreSubmoduleHeads(repoDir, baseline);
  if (!keepBranch && branchName.startsWith("port/pr-")) {
    try { await simpleGit(repoDir).deleteLocalBranch(branchName, true); } catch { /* absent/empty */ }
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "change";
}

function resultFor(
  repo: RepoKey,
  branch: string,
  diff: string,
  filesTouched: number,
  summary: string,
  extra: Partial<SkillRepoResult> = {},
): SkillRepoResult {
  return { repo, branch, diff, filesTouched, summary, ...extra };
}

function envelope(
  ctx: PipelineContext,
  status: SkillEnvelope["status"],
  outcome: PortOutcome,
  result: SkillRepoResult,
  extraMeta: Record<string, unknown> = {},
): SkillEnvelope {
  const { direction } = ctx;
  return {
    skillId: "pr-port",
    status,
    results: { [direction.target]: result },
    meta: {
      outcome,
      sourcePr: direction.pr,
      source: direction.source,
      target: direction.target,
      profileTakenAt: ctx.snapshot.takenAt,
      usage: ctx.usage,
      ...extraMeta,
    },
  };
}

async function preserveWork(
  repoKey: RepoKey,
  message: string,
): Promise<SubmoduleCommitResult> {
  return commitWithSubmodules(REPOS[repoKey].dir, repoKey, message);
}

// ─── pipeline ───────────────────────────────────────────────────────────────

async function runPrPort(ctx: PipelineContext): Promise<SkillEnvelope> {
  const { direction, emit, signal } = ctx;
  const sourceDir = REPOS[direction.source].dir;
  const targetDir = REPOS[direction.target].dir;

  return withRepoLocks([direction.source, direction.target], async () => {
    abortIfNeeded(signal);
    await assertWorkspaceReady(direction.source, true);
    await assertWorkspaceReady(direction.target, true);
    if (!fs.existsSync(path.join(targetDir, "node_modules"))) {
      throw new Error(
        `node_modules not installed in ${targetDir}. Run npm install there before starting a PR port.`,
      );
    }

    emit({ type: "phase_marker", phase: "fetching" });
    const source = await getBranchDiff(sourceDir, direction.pr.url, "main", direction.source);
    if (!source.diff.trim()) {
      return envelope(
        ctx,
        "error",
        "error",
        resultFor(direction.target, "", "", 0, "The source PR contains no diff against its PR base.", {
          error: "Source PR diff is empty",
        }),
        { sourceBaseSha: source.baseSha, sourceHeadSha: source.headSha },
      );
    }
    emit({
      type: "diff_ready",
      source: direction.source,
      target: direction.target,
      stat: source.stat,
      fileCount: parseDiffFiles(source.diff).length,
    });

    const deterministic = deterministicPortabilityHints(direction.source, direction.target, source.diff);
    emit({ type: "phase_marker", phase: "triaging" });
    const triageText = await runDefinition(ctx, "pr-port/triage", {
      PR_URL: direction.pr.url,
      SOURCE_REPO: REPOS[direction.source].name,
      TARGET_REPO: REPOS[direction.target].name,
      DIFF_STAT: source.stat || "(no stat output)",
      SOURCE_DIFF: source.diff,
      DETERMINISTIC_HINTS: deterministic.length > 0 ? deterministic.map((h) => `- ${h}`).join("\n") : "- No deterministic non-portability hints.",
    }, sourceDir, sourceDir, targetDir);
    const triage = parseTriageResult(triageText);
    emit({ type: "triage_result", triage });

    if (triage.portability === "no") {
      const reason = triage.reasons.join(" ") || "No meaningful target-SDK behavior remains.";
      return envelope(
        ctx,
        "partial",
        "non_portable",
        resultFor(direction.target, "", "", 0, reason),
        {
          triage,
          deterministicHints: deterministic,
          sourceBaseSha: source.baseSha,
          sourceHeadSha: source.headSha,
        },
      );
    }

    emit({ type: "phase_marker", phase: "analysing" });
    const analystText = await runDefinition(ctx, "pr-port/source-analyst", {
      PR_URL: direction.pr.url,
      SOURCE_REPO: REPOS[direction.source].name,
      TARGET_REPO: REPOS[direction.target].name,
      DIFF_STAT: source.stat || "(no stat output)",
      SOURCE_DIFF: source.diff,
      TRIAGE_JSON: JSON.stringify(triage, null, 2),
    }, sourceDir, sourceDir, targetDir);
    const spec = parsePortSpec(analystText, sourceDir, source.diff);
    emit({ type: "spec_result", spec });

    const branchName = `port/pr-${direction.pr.number}-${slugify(spec.featureName)}`;
    const baseline = await captureSubmoduleHeads(targetDir, direction.target);
    let branchCreated = false;
    let keepBranch = false;
    let committed = false;
    let latestDiff = "";
    let latestFiles = 0;
    let patchPath: string | undefined;

    try {
      abortIfNeeded(signal);
      await forceCheckoutBranch(targetDir, direction.target, "main");
      await restoreSubmoduleHeads(targetDir, baseline);
      const targetGit = simpleGit(targetDir);
      try { await targetGit.deleteLocalBranch(branchName, true); } catch { /* first run */ }
      await targetGit.checkoutLocalBranch(branchName);
      branchCreated = true;

      emit({ type: "phase_marker", phase: "implementing", branch: branchName });
      const implementerText = await runDefinition(ctx, "pr-port/implementer", {
        TARGET_REPO: REPOS[direction.target].name,
        PORT_SPEC_JSON: JSON.stringify(spec, null, 2),
      }, targetDir, sourceDir, targetDir);

      ({ diff: latestDiff, fileCount: latestFiles } = await getDiffWithSubmodules(targetDir, direction.target));
      if (!latestDiff.trim() || latestFiles === 0) {
        return envelope(
          ctx,
          "error",
          "error",
          resultFor(direction.target, branchName, "", 0, implementerText, { error: "Implementer produced no target changes" }),
          { triage, spec, deterministicHints: deterministic },
        );
      }

      fs.mkdirSync(PATCHES_DIR, { recursive: true });
      patchPath = path.join(PATCHES_DIR, `port-${direction.source}-pr-${direction.pr.number}-${slugify(spec.featureName)}.patch`);
      fs.writeFileSync(patchPath, latestDiff);

      emit({ type: "phase_marker", phase: "building" });
      const build = runRescriptBuild(targetDir);
      emit({ type: "build_result", passed: build.passed, log: build.log });
      if (!build.passed) {
        await preserveWork(direction.target, `wip: port ${direction.pr.owner}/${direction.pr.repo}#${direction.pr.number} — build failed`);
        committed = true;
        keepBranch = true;
        return envelope(
          ctx,
          "partial",
          "build_failed",
          resultFor(direction.target, branchName, latestDiff, latestFiles, implementerText, {
            error: "ReScript build failed; work was preserved on the local branch",
          }),
          { triage, spec, buildStatus: "fail", buildLog: build.log, patchPath, deterministicHints: deterministic },
        );
      }

      emit({ type: "phase_marker", phase: "validating" });
      const quality = runPatchValidators({
        diff: latestDiff,
        repoDir: targetDir,
        category: "pr-port",
        patchPath,
        spec: {
          configKey: spec.configKey,
          typeDefinition: spec.typeDefinition,
          allRelatedFiles: spec.sourceFiles.map((f) => ({ path: f.path, role: f.role })),
        },
      });
      emit({ type: "validators", report: quality });

      if (quality.rejected) {
        await preserveWork(direction.target, `wip: port ${direction.pr.owner}/${direction.pr.repo}#${direction.pr.number} — validator rejection`);
        committed = true;
        keepBranch = true;
        return envelope(
          ctx,
          "partial",
          "rejected",
          resultFor(direction.target, branchName, latestDiff, latestFiles, implementerText),
          { triage, spec, buildStatus: "pass", buildLog: build.log, quality, patchPath, deterministicHints: deterministic },
        );
      }

      emit({ type: "phase_marker", phase: "verifying" });
      const verifierText = await runDefinition(ctx, "pr-port/verifier", {
        FEATURE_NAME: spec.featureName,
        SOURCE_REPO: REPOS[direction.source].name,
        TARGET_REPO: REPOS[direction.target].name,
        PORT_SPEC_JSON: JSON.stringify(spec, null, 2),
        TARGET_DIFF: latestDiff,
      }, targetDir, sourceDir, targetDir, true);
      const verifier = parseVerifier(verifierText);
      const verdict = computePatchVerdict(quality, verifier);
      emit({ type: "verifier_result", verifier, verdict });

      const commitMessage = `feat: port ${direction.pr.owner}/${direction.pr.repo}#${direction.pr.number} — ${spec.featureName}`;
      const commitResult = await preserveWork(direction.target, commitMessage);
      committed = true;
      keepBranch = true;
      const ahead = await commitsAheadOfForkMain(targetDir, branchName);
      if (ahead === 0 && commitResult.submodulesChanged.length === 0) {
        throw new Error("Port commit produced zero commits; refusing to push an empty branch");
      }

      let prUrl: string | null = null;
      let prNumber: number | null = null;
      let prWarning: string | null = null;
      const submodulePushes: string[] = [];
      try {
        for (const subDir of commitResult.submodulesChanged) {
          const pushed = await pushSubmoduleToFork({ parentDir: targetDir, subDir, branchName });
          submodulePushes.push(`${subDir} -> ${pushed.forkUrl} @ ${pushed.sha.slice(0, 8)}`);
        }
        if (commitResult.submodulesChanged.length > 0) {
          const rewritten = rewriteGitmodulesToForks(targetDir, commitResult.submodulesChanged);
          if (rewritten.length > 0) {
            await simpleGit(targetDir).add([".gitmodules"]);
            await simpleGit(targetDir).commit(`chore: point submodules at bot forks for build\n\nRewritten: ${rewritten.join(", ")}`);
          }
        }
        await pushBranchToFork(targetDir, direction.target, branchName);
        const body = formatPortPrBody({
          sourcePrUrl: direction.pr.url,
          sourceRepo: REPOS[direction.source].name,
          targetRepo: REPOS[direction.target].name,
          featureName: spec.featureName,
          portability: triage.portability,
          portabilityReasons: triage.reasons,
          summaryJson: implementerText,
          filesTouched: latestFiles,
          skippedFiles: [...triage.skippedFiles, ...spec.notPorting],
          buildLog: build.log,
          verdict: verdict === "pass" ? "pass" : "needs_review",
          findings: quality.findings,
          verifierIssues: verifier.issues,
          submodulePushes,
        });
        const created = await createPullRequest({
          repoKey: direction.target,
          branch: branchName,
          title: `feat: port ${spec.featureName}`,
          body,
          draft: verdict !== "pass",
        });
        prUrl = created.prUrl;
        prNumber = created.prNumber;
      } catch (err) {
        prWarning = `PR creation failed; the local branch is preserved: ${(err as Error).message}`;
      }

      return envelope(
        ctx,
        verdict === "pass" ? "ok" : "partial",
        verdict === "pass" ? "pass" : "needs_review",
        resultFor(direction.target, branchName, latestDiff, latestFiles, implementerText, {
          prUrl,
          prNumber,
          prWarning,
        }),
        {
          triage,
          spec,
          buildStatus: "pass",
          buildLog: build.log,
          quality,
          verifier,
          patchPath,
          deterministicHints: deterministic,
          submodulePushes,
          sourceBaseSha: source.baseSha,
          sourceHeadSha: source.headSha,
        },
      );
    } catch (err) {
      const aborted = signal.aborted || (err as Error).name === "AbortError";
      if (branchCreated && !committed && !aborted) {
        try {
          ({ diff: latestDiff, fileCount: latestFiles } = await getDiffWithSubmodules(targetDir, direction.target));
          if (latestDiff.trim()) {
            await preserveWork(direction.target, `wip: port ${direction.pr.owner}/${direction.pr.repo}#${direction.pr.number} — interrupted`);
            keepBranch = true;
            committed = true;
          }
        } catch { /* patch artifact and error still surface below */ }
      }
      return envelope(
        ctx,
        "error",
        aborted ? "cancelled" : "error",
        resultFor(direction.target, branchName, latestDiff, latestFiles, "", {
          error: aborted ? "PR port cancelled" : (err as Error).message,
        }),
        { triage, spec, patchPath, deterministicHints: deterministic },
      );
    } finally {
      if (branchCreated) {
        try { await cleanupTarget(direction.target, baseline, branchName, keepBranch); }
        catch (err) { console.error(`[pr-port] target cleanup failed: ${(err as Error).message}`); }
      }
    }
  });
}

// ─── HTTP interface + persistence ──────────────────────────────────────────

function requestOverride(req: Request): AgentSettings | undefined {
  const encoded = req.get("X-Agent-Profiles");
  if (!encoded) return undefined;
  let parsed: AgentSettings;
  try {
    const uriEncoded = Buffer.from(encoded, "base64").toString("utf8");
    parsed = JSON.parse(decodeURIComponent(uriEncoded)) as AgentSettings;
  } catch {
    throw new Error("X-Agent-Profiles is not a valid browser agent profile override");
  }
  const validation = validateAgentSettings(parsed);
  if (!validation.ok) throw new Error(`Invalid browser agent profile override: ${validation.errors.join("; ")}`);
  return parsed;
}

function persistEnvelope(input: PrPortInput, value: SkillEnvelope): number | null {
  try {
    const runId = saveSkillRun("pr-port", value.status, JSON.stringify(input), JSON.stringify(value));
    value.meta = { ...value.meta, runId };
    db.prepare("UPDATE skill_runs SET result_json = ? WHERE id = ?").run(JSON.stringify(value), runId);
    return runId;
  } catch (err) {
    console.error(`[pr-port] failed to persist run: ${(err as Error).message}`);
    return null;
  }
}

export function handleResolvePrPort(req: Request, res: Response): void {
  try {
    const direction = resolvePortDirection(String((req.body as Partial<PrPortInput>)?.prUrl ?? ""));
    res.json(direction);
  } catch (err) {
    res.status(400).json({ code: (err as { code?: string }).code ?? "INVALID_PR_URL", error: (err as Error).message });
  }
}

export async function handlePrPortSkill(req: Request, res: Response): Promise<void> {
  const input = req.body as Partial<PrPortInput>;
  let direction: PortDirection;
  let snapshot: ProfileSnapshot;
  try {
    direction = resolvePortDirection(String(input.prUrl ?? ""));
    const override = requestOverride(req);
    snapshot = resolveRun(PORT_SLOTS, { override, access: PORT_ACCESS });
  } catch (err) {
    if (err instanceof AgentsNotConfiguredError) {
      res.status(428).json({ code: err.code, error: err.message, slots: err.slots });
      return;
    }
    if (err instanceof UnsupportedRuntimeCapabilityError) {
      res.status(422).json({ code: err.code, error: err.message });
      return;
    }
    res.status(400).json({ code: (err as { code?: string }).code ?? "INVALID_REQUEST", error: (err as Error).message });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();
  let clientClosed = false;
  const onClientGone = () => {
    if (clientClosed) return;
    clientClosed = true;
    controller.abort();
  };
  res.on("close", onClientGone);
  req.on("aborted", onClientGone);

  const emit = (event: unknown): void => {
    if (clientClosed || res.writableEnded) return;
    try { res.write(`${JSON.stringify(event)}\n`); } catch { onClientGone(); }
  };

  const ctx: PipelineContext = {
    direction,
    snapshot,
    emit,
    signal: controller.signal,
    usage: { stages: 0 },
  };

  let finalEnvelope: SkillEnvelope;
  try {
    finalEnvelope = await runPrPort(ctx);
  } catch (err) {
    finalEnvelope = envelope(
      ctx,
      "error",
      controller.signal.aborted ? "cancelled" : "error",
      resultFor(direction.target, "", "", 0, "", {
        error: (err as Error).message.slice(0, MAX_STREAM_ERROR),
      }),
    );
    emit({ type: "error", error: (err as Error).message.slice(0, MAX_STREAM_ERROR) });
  }

  persistEnvelope({ prUrl: direction.pr.url }, finalEnvelope);
  emit({ type: "port_done", envelope: finalEnvelope });
  if (!res.writableEnded && !clientClosed) res.end();
}
