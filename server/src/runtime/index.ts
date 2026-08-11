/**
 * Runtime registry and dispatch.
 *
 * Callers name a SLOT and an ACCESS POLICY. Which runtime and model that
 * becomes is a settings lookup; how the CLI is invoked is the adapter's
 * business. Nothing above this layer constructs argv, parses events, or knows
 * that Codex needs a schema file on disk.
 *
 * Resolution happens BEFORE any streaming response begins. The patch route
 * flushes NDJSON headers early (patches.ts:242), and once headers are out a
 * clean HTTP status is impossible — so every slot a run will need is resolved,
 * capability-checked, and frozen into an immutable snapshot first.
 */

import { claudeCodeRuntime } from "./adapters/claudeCode.js";
import { codexRuntime } from "./adapters/codex.js";
import { opencodeRuntime } from "./adapters/opencode.js";
import { getAgentSettings, resolveSlot, type AgentSettings } from "./settings.js";
import {
  AgentsNotConfiguredError, UnsupportedRuntimeCapabilityError,
  type AccessPolicy, type AgentEvent, type AgentRequest, type AgentRuntime,
  type AgentSlot, type ModelRef, type ResolvedAgentRequest, type RuntimeId, type RuntimeStatus,
} from "./types.js";

export const RUNTIMES: Record<RuntimeId, AgentRuntime> = {
  "claude-code": claudeCodeRuntime,
  "codex": codexRuntime,
  "opencode": opencodeRuntime,
};

/** Which policies each runtime can actually express. Enforced, never fudged. */
const SUPPORTED_ACCESS: Record<RuntimeId, AccessPolicy[]> = {
  // Verified by server/src/scripts/probeAccessPolicy.ts, not assumed.
  "claude-code": ["text-only", "repo-read", "repo-read-exec", "repo-write"],
  // Codex's read-only sandbox still executes commands, so text-only is a lie it cannot tell.
  "codex": ["repo-read", "repo-read-exec", "repo-write"],
  "opencode": ["repo-read", "repo-read-exec", "repo-write"],
};

const SUPPORTS_READ_DIRS: Record<RuntimeId, boolean> = {
  "claude-code": true,   // --add-dir
  "codex": true,         // --add-dir
  "opencode": false,     // no equivalent
};

export function supportsAccess(runtime: RuntimeId, access: AccessPolicy): boolean {
  return SUPPORTED_ACCESS[runtime].includes(access);
}

/**
 * An immutable record of what a run decided to use, captured up front.
 *
 * Frozen so a settings change mid-run cannot make a job's later stages
 * disagree with its earlier ones — which would make the resulting quality
 * measurement meaningless.
 */
export interface ProfileSnapshot {
  takenAt: string;
  models: Partial<Record<AgentSlot, ModelRef>>;
}

export interface ResolveOptions {
  /** Per-request override, e.g. a browser-local profile choice. */
  override?: AgentSettings;
  /** Access policy each slot will be invoked with, for the capability check. */
  access?: Partial<Record<AgentSlot, AccessPolicy>>;
  readDirs?: Partial<Record<AgentSlot, boolean>>;
}

/**
 * Resolve every slot a run needs, or throw before anything starts.
 *
 * Throwing early is the whole point: a 428 the UI can act on beats discovering
 * at minute 20 that the verifier slot was never assigned.
 */
export function resolveRun(slots: AgentSlot[], opts: ResolveOptions = {}): ProfileSnapshot {
  const settings = opts.override ?? getAgentSettings();
  const models: Partial<Record<AgentSlot, ModelRef>> = {};
  const unassigned: AgentSlot[] = [];

  for (const slot of slots) {
    const ref = resolveSlot(slot, settings);
    if (!ref) { unassigned.push(slot); continue; }
    models[slot] = ref;
  }
  if (unassigned.length > 0) throw new AgentsNotConfiguredError(unassigned);

  for (const slot of slots) {
    const ref = models[slot]!;
    const access = opts.access?.[slot];
    if (access && !supportsAccess(ref.runtime, access)) {
      throw new UnsupportedRuntimeCapabilityError(
        ref.runtime, `access policy "${access}" for slot "${slot}"`,
        "assign a different runtime to this slot in Settings",
      );
    }
    if (opts.readDirs?.[slot] && !SUPPORTS_READ_DIRS[ref.runtime]) {
      throw new UnsupportedRuntimeCapabilityError(
        ref.runtime, `cross-repo reads for slot "${slot}"`,
        "no --add-dir equivalent; assign claude-code or codex to this slot",
      );
    }
  }

  return { takenAt: new Date().toISOString(), models: Object.freeze(models) };
}

/** Run one request against the runtime the snapshot froze for its slot. */
export function runAgent(req: AgentRequest, snapshot: ProfileSnapshot): AsyncIterable<AgentEvent> {
  const model = snapshot.models[req.slot];
  if (!model) throw new AgentsNotConfiguredError([req.slot]);
  const runtime = RUNTIMES[model.runtime];
  const resolved: ResolvedAgentRequest = { ...req, model };
  return runtime.run(resolved);
}

/** Collect a run's text output, discarding tool chatter. */
export async function runAgentText(
  req: AgentRequest,
  snapshot: ProfileSnapshot,
): Promise<{ text: string; error?: string }> {
  let text = "";
  let error: string | undefined;
  for await (const ev of runAgent(req, snapshot)) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "error") error = ev.error;
  }
  return { text: text.trim(), error };
}

export async function probeAll(): Promise<RuntimeStatus[]> {
  return Promise.all(Object.values(RUNTIMES).map((r) => r.probe()));
}

export { getAgentSettings, setAgentSettings, seedFromEnvIfEmpty, validateAgentSettings } from "./settings.js";
export * from "./types.js";
