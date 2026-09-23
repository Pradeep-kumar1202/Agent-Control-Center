/**
 * The shared skill pipeline.
 *
 * Every primitive here was extracted verbatim from `skills/prPort/index.ts`,
 * which was the only pipeline in this codebase that was fail-closed, preserved
 * work on failure, repaired invalid agent output, and reported phase timings.
 * The other four priority skills each reinvented a weaker subset — and the
 * places they diverged are exactly where the defects were:
 *
 *   - `routes/patches.ts` defaulted its verifier to PASS and treated a parse
 *     failure as success.
 *   - `skills/review/index.ts` caught every pass failure into `{issues: []}`,
 *     so a review whose three passes all crashed reported "approve".
 *   - `routes/gaps.ts` let any unrecognised verdict string fall through to
 *     `verified = 1`.
 *
 * All three are the same bug: an agent that failed to produce usable output was
 * read as an agent that found nothing wrong. The primitives below make that
 * shape unrepresentable — a stage either yields a strictly-parsed value or
 * throws a typed error carrying diagnostics. There is no third outcome.
 */

import { renderAgent, type VarBag } from "../agents/loader.js";
import type { PatchFinding } from "../agents/patchValidators.js";
import { runAgent, type ProfileSnapshot, type Usage } from "../runtime/index.js";
import type { RepoKey } from "../config.js";
import type { SkillEnvelope, SkillRepoResult } from "./registry.js";

// ─── outcome vocabulary ─────────────────────────────────────────────────────

/**
 * The cross-skill roll-up, carried in `envelope.meta.outcome`.
 *
 * Skill-specific verdicts (review's approve/request_changes/inconclusive,
 * gap-verify's confirmed/false_positive/platform_specific) stay in `meta` under
 * their own keys. This union is what history badges and dashboards switch on,
 * so it must mean the same thing everywhere:
 *
 *   pass          every gate satisfied; safe to act on
 *   needs_review  produced output, but a human must look — INCLUDES every
 *                 "we could not tell" case. Never collapse this into pass.
 *   non_portable  deliberately declined before doing work
 *   build_failed  compiled artifact rejected by the build gate
 *   rejected      deterministic validators refused the artifact
 *   error         the run could not complete
 *   cancelled     a human stopped it
 */
export type SkillOutcome =
  | "pass" | "needs_review" | "non_portable"
  | "build_failed" | "rejected" | "error" | "cancelled";

// ─── context ────────────────────────────────────────────────────────────────

export interface PhaseTiming {
  phase: string;
  ms: number;
}

export interface AgentTotals extends Usage {
  stages: number;
}

/**
 * What every stage needs. Skills extend this with their own fields (PR Port
 * adds `direction`, patch generation adds `gap`), so one set of primitives
 * serves all of them.
 *
 * `emit` is the job's event sink — phase markers, timings and forwarded agent
 * events are all job events, which is what makes a run replayable after a
 * reload.
 */
export interface StageContext {
  snapshot: ProfileSnapshot;
  emit: (event: Record<string, unknown>) => void;
  signal: AbortSignal;
  usage: AgentTotals;
  timings: PhaseTiming[];
  currentPhase?: string;
  phaseStartedAt?: number;
}

export function newTotals(): AgentTotals {
  return { stages: 0 };
}

// ─── phases ─────────────────────────────────────────────────────────────────

/**
 * Record how long each phase actually took.
 *
 * A skill run legitimately lasts tens of minutes — PR Port's four agents alone
 * are budgeted 240s + 600s + 1200s + 300s before any build — so "slow" and
 * "wedged" look identical from outside. Without per-phase numbers the only way
 * to answer "why did that take 25 minutes?" was to reconstruct it from file
 * mtimes afterwards.
 */
export function beginPhase(
  ctx: StageContext,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  closePhase(ctx);
  ctx.currentPhase = phase;
  ctx.phaseStartedAt = Date.now();
  ctx.emit({ type: "phase_marker", phase, ...extra });
}

export function closePhase(ctx: StageContext): void {
  if (ctx.currentPhase === undefined || ctx.phaseStartedAt === undefined) return;
  const ms = Date.now() - ctx.phaseStartedAt;
  ctx.timings.push({ phase: ctx.currentPhase, ms });
  ctx.emit({ type: "phase_done", phase: ctx.currentPhase, ms });
  ctx.currentPhase = undefined;
  ctx.phaseStartedAt = undefined;
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

/**
 * Reserved-variable defaults.
 *
 * `agents/loader.ts` fails at RENDER if a reserved var appears in a body and is
 * not supplied, so these must cover every reserved var a generic agent might
 * use. `SOURCE_DIR`/`TARGET_DIR` are deliberately absent — they are meaningful
 * only to two-repo skills, which pass them explicitly, and a wrong-but-present
 * default would be worse than a loud failure.
 */
const DEFAULT_RESERVED: VarBag = {
  TOOL_NOTES: "Use only the repository tools allowed by this stage.",
  OUTPUT_NOTES: "Return only the requested structured output.",
  BUILD_COMMAND: "npm run --silent re:build 2>&1",
  BUILD_NOTES: "Cold ReScript builds may take up to 180 seconds.",
};

export interface StageOptions {
  cwd: string;
  /** Extra reserved vars (SOURCE_DIR / TARGET_DIR for cross-repo skills). */
  reserved?: VarBag;
  /** Additional readable directories; rejected by runtimes that cannot grant them. */
  readDirs?: string[];
  /** Permit empty output. Only correct where "said nothing" is a real answer. */
  allowEmpty?: boolean;
  /** Tag every forwarded event, so parallel stages can be separated downstream. */
  tag?: Record<string, unknown>;
}

/**
 * Run one markdown-defined agent stage and return its text.
 *
 * Every agent event is forwarded to `ctx.emit` so the transcript is complete
 * and replayable. An `error` event throws rather than returning partial text —
 * a stage that failed must never look like a stage that produced nothing to
 * say.
 */
export async function runStage(
  ctx: StageContext,
  agentId: string,
  vars: VarBag,
  opts: StageOptions,
): Promise<string> {
  abortIfNeeded(ctx.signal);
  const rendered = renderAgent(agentId, vars, { ...DEFAULT_RESERVED, ...opts.reserved });

  let text = "";
  let failure: string | null = null;
  for await (const event of runAgent({
    slot: rendered.def.slot,
    prompt: rendered.prompt,
    cwd: opts.cwd,
    access: rendered.def.access,
    outputSchema: rendered.schema,
    readDirs: opts.readDirs,
    timeoutMs: rendered.def.timeoutMs,
    signal: ctx.signal,
  }, ctx.snapshot)) {
    ctx.emit(opts.tag ? { ...event, ...opts.tag } : event);
    if (event.type === "text") text += event.text;
    else if (event.type === "usage") mergeUsage(ctx.usage, event.usage);
    else if (event.type === "error") failure = event.error;
  }
  ctx.usage.stages++;
  if (failure) throw new Error(failure);
  if (!opts.allowEmpty && !text.trim()) throw new Error(`${agentId} returned no output`);
  return text.trim();
}

// ─── repair ─────────────────────────────────────────────────────────────────

export interface RepairDiagnostics {
  attempted: boolean;
  repaired: boolean;
  initialOutputChars: number;
  initialError?: string;
  repairError?: string;
  repairOutputChars?: number;
}

export interface RepairRequest {
  invalidOutput: string;
  validationError: string;
}

export class RepairFailedError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly diagnostics: RepairDiagnostics,
  ) {
    super(message);
    this.name = "RepairFailedError";
  }
}

/**
 * `stage` is used verbatim as the subject of the failure message, so it should
 * read as a noun phrase ("triage output", "source specification") rather than
 * an identifier. Callers that surface these to users depend on the exact
 * wording.
 */
function repairMessage(stage: string, kind: "failed" | "remained", detail: string): string {
  return kind === "failed"
    ? `${stage} was invalid and its repair attempt failed: ${detail}`
    : `${stage} remained invalid after one repair attempt: ${detail}`;
}

export interface Resolved<T> {
  value: T;
  diagnostics: RepairDiagnostics;
}

/**
 * Strictly parse agent output, making at most ONE repair attempt.
 *
 * The repair budget is one round by policy, not by accident: a second round
 * roughly doubles the token cost of a failure while rarely converting a genuine
 * misunderstanding into a correct answer. If one targeted correction does not
 * produce parseable output, a human should look.
 *
 * There are exactly two exits — a parsed `T`, or `RepairFailedError`. That is
 * the whole point. Callers cannot accidentally treat unusable output as an
 * empty-but-valid result, which is the bug this replaces in three skills.
 */
export async function resolveWithRepair<T>(
  stage: string,
  initialText: string,
  parse: (text: string) => T,
  repair: (request: RepairRequest) => Promise<string>,
): Promise<Resolved<T>> {
  const base: RepairDiagnostics = {
    attempted: false,
    repaired: false,
    initialOutputChars: initialText.length,
  };

  try {
    return { value: parse(initialText), diagnostics: base };
  } catch (err) {
    const initialError = (err as Error).message;

    let repairedText: string;
    try {
      repairedText = (await repair({ invalidOutput: initialText, validationError: initialError })).trim();
    } catch (repairFailure) {
      const repairError = (repairFailure as Error).message;
      throw new RepairFailedError(
        stage,
        repairMessage(stage, "failed", repairError),
        { ...base, attempted: true, initialError, repairError },
      );
    }

    try {
      return {
        value: parse(repairedText),
        diagnostics: {
          ...base,
          attempted: true,
          repaired: true,
          initialError,
          repairOutputChars: repairedText.length,
        },
      };
    } catch (err2) {
      const repairError = (err2 as Error).message;
      throw new RepairFailedError(
        stage,
        repairMessage(stage, "remained", repairError),
        { ...base, attempted: true, initialError, repairError, repairOutputChars: repairedText.length },
      );
    }
  }
}

/**
 * The common case: run a stage, strictly parse it, repair once if needed.
 *
 * `repairAgentId` reuses the parent stage's slot by convention (see
 * `agents/pr-port/triage-repair.md`) so repair never needs its own assignment
 * in Settings.
 */
export async function runStructured<T>(
  ctx: StageContext,
  agentId: string,
  repairAgentId: string,
  vars: VarBag,
  parse: (text: string) => T,
  opts: StageOptions,
): Promise<Resolved<T>> {
  const text = await runStage(ctx, agentId, vars, opts);
  return resolveWithRepair(agentId, text, parse, async (request) => {
    ctx.emit({ type: "stage_repair", stage: agentId, attempt: 1, reason: request.validationError });
    return runStage(ctx, repairAgentId, {
      ...vars,
      INVALID_OUTPUT: request.invalidOutput,
      VALIDATION_ERROR: request.validationError,
    }, opts);
  });
}

// ─── deterministic gates ────────────────────────────────────────────────────

export interface Gate {
  id: string;
  run: () => Promise<PatchFinding[]>;
}

export interface GateOutcome {
  findings: PatchFinding[];
  rejected: boolean;
  repaired: boolean;
  rounds: number;
}

/**
 * Run every gate, and on failure repair once and run EVERY GATE AGAIN.
 *
 * Re-running all gates rather than only the failed one is the load-bearing
 * detail. A repair edits the working tree; that edit can satisfy the gate that
 * complained while breaking one that had already passed. Re-checking only the
 * complainant would report a green run over a tree no complete gate set has
 * ever approved.
 *
 * Gates are run in sequence, not in parallel: several of them shell out to git
 * or a build in the same working tree, and concurrent mutation there is exactly
 * the kind of nondeterminism this whole change exists to remove.
 */
export async function runGates(
  ctx: StageContext,
  gates: Gate[],
  repair?: (findings: PatchFinding[]) => Promise<void>,
): Promise<GateOutcome> {
  const sweep = async (round: number): Promise<PatchFinding[]> => {
    const found: PatchFinding[] = [];
    for (const gate of gates) {
      abortIfNeeded(ctx.signal);
      const findings = await gate.run();
      ctx.emit({
        type: "gate_result",
        gate: gate.id,
        round,
        passed: !findings.some((f) => f.level === "reject"),
        findings,
      });
      found.push(...findings);
    }
    return found;
  };

  let findings = await sweep(1);
  let rejected = findings.some((f) => f.level === "reject");
  if (!rejected || !repair) {
    return { findings, rejected, repaired: false, rounds: 1 };
  }

  ctx.emit({ type: "gate_repair", attempt: 1, findings: findings.filter((f) => f.level === "reject") });
  await repair(findings);

  findings = await sweep(2);
  rejected = findings.some((f) => f.level === "reject");
  return { findings, rejected, repaired: true, rounds: 2 };
}

// ─── control flow + envelope ────────────────────────────────────────────────

export function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const err = new Error("run cancelled");
  err.name = "AbortError";
  throw err;
}

export function isAbort(err: unknown): boolean {
  return (err as Error | undefined)?.name === "AbortError";
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "change";
}

export function resultFor(
  repo: RepoKey,
  branch: string,
  diff: string,
  filesTouched: number,
  summary: string,
  extra: Partial<SkillRepoResult> = {},
): SkillRepoResult {
  return { repo, branch, diff, filesTouched, summary, ...extra };
}

/**
 * Build the terminal envelope.
 *
 * `closePhase` runs here because every exit path — success, handled failure and
 * caught exception — ends by constructing an envelope. Closing at each return
 * site instead would eventually miss one and silently drop a phase's timing.
 */
export function makeEnvelope(
  ctx: StageContext,
  skillId: string,
  status: SkillEnvelope["status"],
  outcome: SkillOutcome,
  results: Record<string, SkillRepoResult>,
  extraMeta: Record<string, unknown> = {},
): SkillEnvelope {
  closePhase(ctx);
  return {
    skillId,
    status,
    results,
    meta: {
      outcome,
      profileTakenAt: ctx.snapshot.takenAt,
      usage: ctx.usage,
      timings: ctx.timings,
      totalMs: ctx.timings.reduce((n, t) => n + t.ms, 0),
      ...extraMeta,
    },
  };
}
