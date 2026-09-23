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
import { localGit } from "../../workspace/git.js";
import { PATCHES_DIR, REPOS, type RepoKey } from "../../config.js";
import { db, saveSkillRun } from "../../db.js";
import type { VarBag } from "../../agents/loader.js";
import { extractJson, isRecord, isStringArray } from "../../agents/json.js";
import {
  computePatchVerdict,
  parseDiffFiles,
  runPatchValidators,
} from "../../agents/patchValidators.js";
import {
  AgentsNotConfiguredError,
  UnsupportedRuntimeCapabilityError,
  resolveRun,
  type AccessPolicy,
  type AgentSlot,
  type ProfileSnapshot,
} from "../../runtime/index.js";
import {
  RepairFailedError,
  abortIfNeeded,
  beginPhase,
  makeEnvelope,
  newTotals,
  resolveWithRepair,
  resultFor,
  runStage,
  slugify,
  type StageContext,
} from "../pipeline.js";
import {
  assertWorkspaceReady,
  cleanupTarget,
  preserveWork,
} from "../../workspace/session.js";
import { requestOverride } from "../../routes/profile.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";
import { getBranchDiff } from "../prDiff.js";
import { resolvePortDirection, type PortDirection } from "../prUrl.js";
import { runRescriptBuild } from "../buildCheck.js";
import {
  captureSubmoduleHeads,
  forceCheckoutBranch,
  getDiffWithSubmodules,
  restoreSubmoduleHeads,
  type SubmoduleHead,
} from "../submoduleGit.js";
import {
  formatPortPrBody,
  publishPullRequest,
} from "../githubPr.js";
import { withRepoLocks } from "../../workspace/mutex.js";

export interface PrPortInput {
  prUrl: string;
  /**
   * Open the pull request as a draft. Defaults to TRUE.
   *
   * Publishing targets the canonical `juspay/*` repositories, so a generated
   * port arriving as ready-for-review would page real reviewers on work no
   * human has looked at yet. Draft is the safe default; a caller must opt out
   * deliberately. A non-passing verdict is always a draft regardless.
   */
  draft?: boolean;
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

export interface TriageRepairRequest {
  invalidOutput: string;
  validationError: string;
}

export interface TriageRepairDiagnostics {
  attempted: boolean;
  repaired: boolean;
  initialError?: string;
  repairError?: string;
  initialOutputChars: number;
  repairOutputChars?: number;
}

export interface TriageResolution {
  triage: TriageResult;
  diagnostics: TriageRepairDiagnostics;
}

export class TriageRepairFailedError extends Error {
  constructor(
    message: string,
    readonly diagnostics: TriageRepairDiagnostics,
  ) {
    super(message);
    this.name = "TriageRepairFailedError";
  }
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

export interface PortSpecRepairRequest {
  invalidOutput: string;
  validationError: string;
}

export interface PortSpecRepairDiagnostics {
  attempted: boolean;
  repaired: boolean;
  initialError?: string;
  repairError?: string;
  initialOutputChars: number;
  repairOutputChars?: number;
}

export interface PortSpecResolution {
  spec: PortSpec;
  diagnostics: PortSpecRepairDiagnostics;
}

export class PortSpecRepairFailedError extends Error {
  constructor(
    message: string,
    readonly diagnostics: PortSpecRepairDiagnostics,
  ) {
    super(message);
    this.name = "PortSpecRepairFailedError";
  }
}

interface VerifierResult {
  parsed: boolean;
  pass: boolean;
  issues: string[];
  raw: string;
}

/**
 * This pipeline's context: the shared stage fields plus the PR-port specifics.
 * Phase timing, usage accumulation and emit all come from `StageContext`.
 */
interface PipelineContext extends StageContext {
  direction: PortDirection;
  triageRepair?: TriageRepairDiagnostics;
  portSpecRepair?: PortSpecRepairDiagnostics;
  /** Open the resulting PR as a draft; see PrPortInput.draft. */
  draft: boolean;
}

const PORT_SLOTS: AgentSlot[] = [
  "port.triage",
  "port.source-analyst",
  "port.implementer",
  "port.verifier",
];

/**
 * Stages that must be able to read a second repository.
 *
 * Declared so `resolveRun` fails at 422 before any work starts if the assigned
 * runtime cannot grant it. OpenCode has no `--add-dir` equivalent; running the
 * implementer there without source access would silently produce worse output
 * rather than an error, which is exactly the class of quiet degradation this
 * pipeline is meant to avoid.
 */
const PORT_READ_DIRS: Partial<Record<AgentSlot, boolean>> = {
  "port.implementer": true,
};

const PORT_ACCESS: Partial<Record<AgentSlot, AccessPolicy>> = {
  "port.triage": "repo-read",
  "port.source-analyst": "repo-read",
  "port.implementer": "repo-write",
  "port.verifier": "repo-read",
};

/**
 * Branches this skill owns. `cleanupTarget` will only ever delete a branch
 * starting with this, so a bug that passed the wrong name cannot remove a
 * human's branch. Distinct from the patch pipeline's prefix on purpose, so
 * branch-health and cleanup can tell the two apart.
 */
const BRANCH_PREFIX = "port/pr-";

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

function parseFileDecisions(value: unknown, field: string): PortFileDecision[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.why !== "string") {
      throw new Error(`${field}[${index}] must contain path and why strings`);
    }
    return { path: entry.path, why: entry.why };
  });
}

/**
 * Text that means the agent was still working rather than answering.
 *
 * Observed on hyperswitch-web#1593: after 170 s the model emitted
 * `featureName: "Eligibility check triage in progress"` with a first-person
 * note about which skill it was consulting, and `portability: "no"`. Every
 * structural rule passed — `"no"` requires non-empty `reasons` (the narration
 * satisfied it) and no `portableFiles` (empty satisfied it) — so a placeholder
 * became a verdict and cancelled a perfectly portable feature.
 *
 * Schema-valid is not the same as answered. These patterns are the difference.
 */
/**
 * A `featureName` that states a status instead of naming the capability.
 *
 * Scoped to this field only, and kept narrow. An earlier version also rejected
 * the words "pending", "reviewing" and "analysing" anywhere in the output —
 * which promptly failed a perfectly good triage of hyperswitch-web#1593 whose
 * reason read "The **pending** eligibility message and localized surcharge
 * disclosure are observable...". Those are ordinary payment-domain terms
 * (pending payment, pending eligibility). Rejecting a correct answer is worse
 * than the placeholder bug this guard exists to catch.
 */
const STATUS_AS_NAME = /\b(in progress|tbd|to be determined)\b|^\s*(analy[sz]ing|triaging|reviewing|checking|investigating)\b/i;

/**
 * The agent describing its own activity rather than reporting a finding.
 *
 * This is the actual failure signature: first-person process talk, e.g.
 * "I'm using the design-sdk-change skill to verify…". Domain vocabulary is
 * deliberately not matched here — only self-reference is.
 */
const SELF_NARRATION = /\b(i['’]m|i am|i['’]ll|i will|let me|i['’]ve|my analysis)\b|\busing the [\w-]+ skill\b/i;

function assertAnswered(field: string, value: string, checkStatus: boolean): void {
  if (checkStatus && STATUS_AS_NAME.test(value)) {
    throw new Error(`triage ${field} states a status rather than naming the capability ("${value.slice(0, 80)}") — report the finished conclusion`);
  }
  if (SELF_NARRATION.test(value)) {
    throw new Error(`triage ${field} narrates your process instead of stating a finding ("${value.slice(0, 80)}")`);
  }
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

  // The status check applies to the NAME only. `reasons` is prose about the
  // code and legitimately contains words like "pending" or "under review".
  assertAnswered("featureName", value.featureName, true);
  for (const reason of value.reasons) assertAnswered("reasons", reason, false);

  if (value.portability !== "yes" && value.reasons.length === 0) {
    throw new Error("triage must explain partial/no portability");
  }
  if (value.portability !== "no" && portableFiles.length === 0) {
    throw new Error("triage marked work portable but named no portable files");
  }
  // Declining the whole PR is the most expensive answer to get wrong: it ends
  // the run. Require the decision to be shown per file, so "no" cannot be
  // asserted without having looked at what is being declined.
  if (value.portability === "no" && skippedFiles.length === 0) {
    throw new Error("triage marked the PR non-portable but named no skipped files — list each source file and why it has no target counterpart");
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

/**
 * Parse triage output and make at most one fail-closed semantic repair attempt.
 *
 * The generic machinery lives in `pipeline.resolveWithRepair`; this wrapper only
 * supplies the parser and re-labels the failure so callers keep receiving a
 * `TriageRepairFailedError`. The stage label is the exact noun phrase used in
 * the user-facing message.
 */
export async function resolveTriageResult(
  initialText: string,
  repair: (request: TriageRepairRequest) => Promise<string>,
): Promise<TriageResolution> {
  try {
    const { value, diagnostics } = await resolveWithRepair(
      "triage output", initialText, parseTriageResult, repair,
    );
    return { triage: value, diagnostics };
  } catch (err) {
    if (err instanceof RepairFailedError) throw new TriageRepairFailedError(err.message, err.diagnostics);
    throw err;
  }
}

export function parsePortSpec(text: string, _sourceDir: string, sourceDiff: string): PortSpec {
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
  const normalizeChangedPath = (rawPath: string, field: string, index: number): string => {
    const withSlashes = rawPath.replaceAll("\\", "/");
    const normalized = path.posix.normalize(withSlashes);
    if (
      normalized.startsWith("../") || normalized.startsWith("/") || normalized === ".." ||
      /^[A-Za-z]:\//.test(withSlashes)
    ) {
      throw new Error(`${field}[${index}] escapes the source repo: ${rawPath}`);
    }
    if (!changedPaths.has(normalized)) {
      throw new Error(`${field}[${index}] is not present in the source PR diff: ${normalized}`);
    }
    return normalized;
  };
  const sourceFiles = value.sourceFiles.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.role !== "string" || typeof entry.whatChanged !== "string") {
      throw new Error(`sourceFiles[${index}] must contain path, role and whatChanged strings`);
    }
    const normalized = normalizeChangedPath(entry.path, "sourceFiles", index);
    return { path: normalized, role: entry.role, whatChanged: entry.whatChanged };
  });

  const optionalString = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key] !== "" ? value[key] as string : undefined;
  if (!isStringArray(value.reScriptGotchas)) throw new Error("port spec reScriptGotchas must be an array of strings");
  const notPorting = parseFileDecisions(value.notPorting, "notPorting").map((entry, index) => ({
    ...entry,
    path: normalizeChangedPath(entry.path, "notPorting", index),
  }));
  return {
    featureName: value.featureName.trim(),
    changeKind: value.changeKind as ChangeKind,
    behavior: value.behavior.trim(),
    sourceFiles,
    implementationSteps: value.implementationSteps,
    typeDefinition: optionalString("typeDefinition"),
    configKey: optionalString("configKey"),
    defaultValue: optionalString("defaultValue"),
    reScriptGotchas: value.reScriptGotchas,
    notPorting,
  };
}

/** Parse a PortSpec and make at most one fail-closed semantic repair attempt. */
export async function resolvePortSpec(
  initialText: string,
  sourceDir: string,
  sourceDiff: string,
  repair: (request: PortSpecRepairRequest) => Promise<string>,
): Promise<PortSpecResolution> {
  try {
    const { value, diagnostics } = await resolveWithRepair(
      "source specification",
      initialText,
      (text) => parsePortSpec(text, sourceDir, sourceDiff),
      repair,
    );
    return { spec: value, diagnostics };
  } catch (err) {
    if (err instanceof RepairFailedError) throw new PortSpecRepairFailedError(err.message, err.diagnostics);
    throw err;
  }
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

/**
 * Thin adapter over the shared `runStage`, preserving this pipeline's
 * positional call shape and its SOURCE_DIR / TARGET_DIR reserved vars.
 */
async function runDefinition(
  ctx: PipelineContext,
  id: string,
  vars: VarBag,
  cwd: string,
  sourceDir: string,
  targetDir: string,
  allowEmpty = false,
  readDirs?: string[],
): Promise<string> {
  return runStage(ctx, id, vars, {
    cwd,
    reserved: { SOURCE_DIR: sourceDir, TARGET_DIR: targetDir },
    allowEmpty,
    readDirs,
  });
}

function envelope(
  ctx: PipelineContext,
  status: SkillEnvelope["status"],
  outcome: PortOutcome,
  result: SkillRepoResult,
  extraMeta: Record<string, unknown> = {},
): SkillEnvelope {
  const { direction } = ctx;
  return makeEnvelope(ctx, "pr-port", status, outcome, { [direction.target]: result }, {
    sourcePr: direction.pr,
    source: direction.source,
    target: direction.target,
    ...(ctx.triageRepair ? { triageRepair: ctx.triageRepair } : {}),
    ...(ctx.portSpecRepair ? { portSpecRepair: ctx.portSpecRepair } : {}),
    ...extraMeta,
  });
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

    beginPhase(ctx, "fetching");
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
    beginPhase(ctx, "triaging");
    const triageText = await runDefinition(ctx, "pr-port/triage", {
      PR_URL: direction.pr.url,
      SOURCE_REPO: REPOS[direction.source].name,
      TARGET_REPO: REPOS[direction.target].name,
      DIFF_STAT: source.stat || "(no stat output)",
      SOURCE_DIFF: source.diff,
      DETERMINISTIC_HINTS: deterministic.length > 0 ? deterministic.map((h) => `- ${h}`).join("\n") : "- No deterministic non-portability hints.",
    }, sourceDir, sourceDir, targetDir);
    let triageResolution: TriageResolution;
    try {
      triageResolution = await resolveTriageResult(triageText, async (request) => {
        emit({ type: "triage_repair", attempt: 1, reason: request.validationError });
        return runDefinition(ctx, "pr-port/triage-repair", {
          PR_URL: direction.pr.url,
          SOURCE_REPO: REPOS[direction.source].name,
          TARGET_REPO: REPOS[direction.target].name,
          CHANGED_FILES: parseDiffFiles(source.diff).map((file) => `- ${file.path}`).join("\n"),
          SOURCE_DIFF: source.diff,
          DETERMINISTIC_HINTS: deterministic.length > 0 ? deterministic.map((h) => `- ${h}`).join("\n") : "- No deterministic non-portability hints.",
          VALIDATION_ERROR: request.validationError,
          INVALID_OUTPUT: request.invalidOutput,
        }, sourceDir, sourceDir, targetDir);
      });
    } catch (err) {
      if (err instanceof TriageRepairFailedError) ctx.triageRepair = err.diagnostics;
      throw err;
    }
    ctx.triageRepair = triageResolution.diagnostics;
    const triage = triageResolution.triage;
    emit({ type: "triage_result", triage, repaired: triageResolution.diagnostics.repaired });

    // Triage scopes the work; it does not get to end the run on its own opinion.
    //
    // It sees only the diff, has not read the target repo, and is the cheapest,
    // least-informed stage in the pipeline — yet a "no" here used to cancel
    // everything. On hyperswitch-web#1593 ("eligibility enhancement with
    // surcharge calculation", 29 files) that produced a flat refusal to port a
    // straightforwardly portable feature.
    //
    // A refusal is therefore only honoured when the DETERMINISTIC rules agree.
    // Those encode structural facts about the two SDKs (mobile has no static
    // payment-method registry, native-only changes have no web counterpart) and
    // cost no tokens. Absent that corroboration the pipeline continues, and the
    // analyst — which reads actual code in both repos — decides.
    if (triage.portability === "no" && deterministic.length > 0) {
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
    if (triage.portability === "no") {
      // Recorded, not obeyed: the analyst is told triage wanted to decline and
      // must either find portable behavior or say plainly that none exists.
      emit({
        type: "warning",
        warning: "Triage proposed declining this PR but no deterministic rule supports that; continuing to source analysis.",
      });
    }

    beginPhase(ctx, "analysing");
    const analystText = await runDefinition(ctx, "pr-port/source-analyst", {
      PR_URL: direction.pr.url,
      SOURCE_REPO: REPOS[direction.source].name,
      TARGET_REPO: REPOS[direction.target].name,
      DIFF_STAT: source.stat || "(no stat output)",
      SOURCE_DIFF: source.diff,
      TRIAGE_JSON: JSON.stringify(triage, null, 2),
    }, sourceDir, sourceDir, targetDir);
    let specResolution: PortSpecResolution;
    try {
      specResolution = await resolvePortSpec(analystText, sourceDir, source.diff, async (request) => {
        emit({ type: "spec_repair", attempt: 1, reason: request.validationError });
        return runDefinition(ctx, "pr-port/source-analyst-repair", {
          PR_URL: direction.pr.url,
          SOURCE_REPO: REPOS[direction.source].name,
          TARGET_REPO: REPOS[direction.target].name,
          CHANGED_FILES: parseDiffFiles(source.diff).map((file) => `- ${file.path}`).join("\n"),
          SOURCE_DIFF: source.diff,
          TRIAGE_JSON: JSON.stringify(triage, null, 2),
          VALIDATION_ERROR: request.validationError,
          INVALID_OUTPUT: request.invalidOutput,
        }, sourceDir, sourceDir, targetDir);
      });
    } catch (err) {
      if (err instanceof PortSpecRepairFailedError) ctx.portSpecRepair = err.diagnostics;
      throw err;
    }
    ctx.portSpecRepair = specResolution.diagnostics;
    const spec = specResolution.spec;
    emit({ type: "spec_result", spec, repaired: specResolution.diagnostics.repaired });

    const branchName = `${BRANCH_PREFIX}${direction.pr.number}-${slugify(spec.featureName)}`;
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
      const targetGit = localGit(targetDir);
      try { await targetGit.deleteLocalBranch(branchName, true); } catch { /* first run */ }
      await targetGit.checkoutLocalBranch(branchName);
      branchCreated = true;

      beginPhase(ctx, "implementing", { branch: branchName });
      // The implementer reads the source repo directly.
      //
      // It used to be deliberately source-blind, with the JSON spec as the only
      // bridge — the idea being that blindness prevents verbatim copying. In
      // practice the spec is lossy: anything the analyst failed to write down
      // became invisible, and the implementer had no way to check an edge case,
      // a default, or a backend field name. The result was mechanical output.
      //
      // Copying is better prevented by instruction and by the validators than by
      // withholding context. `readDirs` is honoured by claude-code and codex via
      // --add-dir; opencode has no equivalent and `resolveRun` rejects the slot
      // up front rather than silently running without it.
      const implementerText = await runDefinition(ctx, "pr-port/implementer", {
        TARGET_REPO: REPOS[direction.target].name,
        SOURCE_REPO: REPOS[direction.source].name,
        PR_URL: direction.pr.url,
        PORT_SPEC_JSON: JSON.stringify(spec, null, 2),
        SOURCE_DIFF: source.diff,
      }, targetDir, sourceDir, targetDir, false, [sourceDir]);

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

      beginPhase(ctx, "building");
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

      beginPhase(ctx, "validating");
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

      beginPhase(ctx, "verifying");
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

      let prUrl: string | null = null;
      let prNumber: number | null = null;
      let prWarning: string | null = null;
      try {
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
        });
        const created = await publishPullRequest({
          repoDir: targetDir,
          repoKey: direction.target,
          branch: branchName,
          title: `feat: port ${spec.featureName}`,
          body,
          draft: ctx.draft || verdict !== "pass",
          submodulesChanged: commitResult.submodulesChanged,
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
        try { await cleanupTarget(direction.target, baseline, branchName, keepBranch, BRANCH_PREFIX); }
        catch (err) { console.error(`[pr-port] target cleanup failed: ${(err as Error).message}`); }
      }
    }
  });
}

// ─── HTTP interface + persistence ──────────────────────────────────────────

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
    snapshot = resolveRun(PORT_SLOTS, { override, access: PORT_ACCESS, readDirs: PORT_READ_DIRS });
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
    draft: input.draft !== false,
    timings: [],
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
