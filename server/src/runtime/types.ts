/**
 * Vocabulary for the runtime layer.
 *
 * A *runtime* is an execution environment (Claude Code, Codex, OpenCode), not a
 * model provider. OpenCode can drive a LiteLLM-hosted model; Codex can be
 * pointed at a custom provider. So runtime, model provider and model are
 * recorded separately, while the string actually handed to the CLI is preserved
 * verbatim — it is the only part guaranteed to round-trip.
 */

export type RuntimeId = "claude-code" | "codex" | "opencode";

export interface ModelRef {
  runtime: RuntimeId;
  /** Passed to the CLI unchanged: "opus" | "gpt-5.6-sol" | "litellm/open-large". */
  invocation: string;
  /** Parsed out when discoverable, for reporting only. Never reassembled into `invocation`. */
  modelProvider?: string;
  model?: string;
  effort?: string;
}

/**
 * Stable task identities. Deliberately finer-grained than a generic role:
 * patch implementation, test writing and props work have different quality and
 * cost profiles, and collapsing them into one "implement" role would force them
 * onto the same model.
 */
export type AgentSlot =
  | "analysis.extract" | "analysis.normalize" | "gap.verify"
  | "patch.source-analyst" | "patch.implementer" | "patch.verifier"
  | "patch.critic" | "patch.repair"
  | "port.triage" | "port.source-analyst" | "port.implementer" | "port.verifier"
  | "review.security" | "review.logic" | "review.convention"
  | "skill.props" | "skill.tests" | "skill.translations" | "skill.integration"
  | "feature.discovery" | "feature.implement"
  | "docs.writer" | "chat.patch";

export const AGENT_SLOTS: readonly AgentSlot[] = [
  "analysis.extract", "analysis.normalize", "gap.verify",
  "patch.source-analyst", "patch.implementer", "patch.verifier",
  "patch.critic", "patch.repair",
  "port.triage", "port.source-analyst", "port.implementer", "port.verifier",
  "review.security", "review.logic", "review.convention",
  "skill.props", "skill.tests", "skill.translations", "skill.integration",
  "feature.discovery", "feature.implement",
  "docs.writer", "chat.patch",
] as const;

/**
 * Requested authority — not a list of tool names.
 *
 * This belongs to the CODE, never to user settings: changing a model
 * assignment must not be able to widen what an agent may touch.
 *
 * `repo-read-exec` is not a nicety. Five distinct tool combinations exist
 * across the current call sites, and two of them (feature.ts:311,
 * integration/index.ts:284) want read plus command execution without writes —
 * which is also exactly what a verifier that must run the build needs.
 */
export type AccessPolicy = "text-only" | "repo-read" | "repo-read-exec" | "repo-write";

export const ACCESS_POLICIES: readonly AccessPolicy[] = [
  "text-only", "repo-read", "repo-read-exec", "repo-write",
] as const;

export function isAccessPolicy(v: unknown): v is AccessPolicy {
  return typeof v === "string" && (ACCESS_POLICIES as readonly string[]).includes(v);
}

export function isAgentSlot(v: unknown): v is AgentSlot {
  return typeof v === "string" && (AGENT_SLOTS as readonly string[]).includes(v);
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * List-price equivalent, not spend. Claude reports `total_cost_usd` even on a
   * subscription plan; Codex reports nothing. Never synthesise this from a
   * pricing table — a stale table is worse than an honest blank.
   */
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
}

/**
 * Normalized event stream. Field names match what `web/src/api.ts` already
 * expects, so AgentPanel and readNdjson keep working across all runtimes.
 *
 * Adapters translate their native tool names into the Claude-shaped names the
 * UI switches on (`Bash`/`Read`/`Grep`/`Edit`/`Write`/`Glob` plus the input
 * keys `command`/`file_path`/`pattern`) — AgentPanel.tsx:637-649 matches on
 * both, and :387 detects an in-flight build via `Bash` + `re:build`.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; tool: { name: string; input?: unknown; id?: string } }
  | { type: "tool_result"; toolResult: { id: string; content?: string; isError?: boolean } }
  | { type: "status"; status: string }
  | { type: "warning"; warning: string }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; error: string; code?: string };

export interface AgentRequest {
  slot: AgentSlot;
  prompt: string;
  /** Real developer/system instructions where the runtime has them; folded into the prompt only where it does not. */
  developerInstructions?: string;
  cwd?: string;
  /** Extra readable roots. Unsupported by OpenCode → hard error, never a silent downgrade. */
  readDirs?: string[];
  access: AccessPolicy;
  /** Enforced natively on claude-code (--json-schema) and codex (--output-schema). */
  outputSchema?: object;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Attribution for the agent_invocations row. */
  ref?: { type: "patch" | "gap" | "skill_run" | "feature" | "review" | "bench"; id: number };
}

export interface ResolvedAgentRequest extends AgentRequest {
  model: ModelRef;
}

export interface RuntimeStatus {
  id: RuntimeId;
  installed: boolean;
  version?: string;
  /** Discovered model identifiers, used to seed (never constrain) the settings combobox. */
  models: string[];
  error?: string;
}

export interface AgentRuntime {
  id: RuntimeId;
  run(request: ResolvedAgentRequest): AsyncIterable<AgentEvent>;
  probe(): Promise<RuntimeStatus>;
}

// ─── errors ──────────────────────────────────────────────────────────────────

export class RuntimeUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE" as const;
  constructor(readonly runtime: RuntimeId, readonly binary: string) {
    super(`Runtime "${runtime}" is not available — "${binary}" was not found on PATH`);
    this.name = "RuntimeUnavailableError";
  }
}

export class ModelUnauthorizedError extends Error {
  readonly code = "MODEL_UNAUTHORIZED" as const;
  constructor(readonly runtime: RuntimeId, readonly invocation: string, detail: string) {
    super(`Model "${invocation}" rejected by ${runtime}: ${detail}`);
    this.name = "ModelUnauthorizedError";
  }
}

/**
 * Thrown when a runtime cannot honour a requested capability.
 *
 * Downgrading in silence is forbidden: if `text-only` cannot be expressed, the
 * caller must find out rather than unknowingly hand shell access to a bulk
 * extraction pass.
 */
export class UnsupportedRuntimeCapabilityError extends Error {
  readonly code = "UNSUPPORTED_RUNTIME_CAPABILITY" as const;
  constructor(readonly runtime: RuntimeId, readonly capability: string, detail?: string) {
    super(`Runtime "${runtime}" cannot honour ${capability}${detail ? ` — ${detail}` : ""}`);
    this.name = "UnsupportedRuntimeCapabilityError";
  }
}

export class AgentsNotConfiguredError extends Error {
  readonly code = "AGENTS_NOT_CONFIGURED" as const;
  constructor(readonly slots: AgentSlot[]) {
    super(`No runtime assigned for: ${slots.join(", ")}`);
    this.name = "AgentsNotConfiguredError";
  }
}
