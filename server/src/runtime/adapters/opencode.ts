/**
 * OpenCode runtime adapter.
 *
 * Flags and event shapes were captured by running opencode 1.3.17.
 *
 * Two behaviours drive the whole implementation:
 *
 *  1. **`text` events carry a part SNAPSHOT, not a delta.** Each event repeats
 *     the full text of its part. Concatenating them naively duplicates the
 *     message quadratically, so emitted length is tracked per `part.id` and
 *     only the new suffix is yielded. The same dedupe applies to `callID`, so a
 *     tool that transitions running -> completed yields exactly one `tool_use`
 *     and one `tool_result`.
 *
 *  2. **An `error` event can accompany exit code 0.** A blocked LiteLLM key
 *     produces `{"type":"error","error":{"name":"APIError",...401...}}` and the
 *     process still exits cleanly, so exit status alone would record a failed
 *     run as a success. `classifyExit` is told whether an error event was seen.
 *
 * OpenCode has no `--add-dir` equivalent, so cross-repo reads are a hard error
 * rather than a silent degradation, and no ephemeral-session flag, so session
 * state is redirected out of the shared home directory via XDG.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "../../config.js";
import { classifyExit, streamProcess } from "../proc.js";
import {
  UnsupportedRuntimeCapabilityError,
  type AccessPolicy, type AgentEvent, type AgentRuntime,
  type ResolvedAgentRequest, type RuntimeStatus,
} from "../types.js";

const execFileAsync = promisify(execFile);
const BIN = "opencode";

/**
 * `--agent plan|build` alone is not an execution policy — OpenCode's defaults
 * are permissive. Each tier materialises an explicit allow/deny ruleset.
 */
const PERMISSIONS: Record<Exclude<AccessPolicy, "text-only">, Record<string, string>> = {
  "repo-read": { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow" },
  "repo-read-exec": { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", bash: "allow" },
  "repo-write": { "*": "allow" },
};

function materializeConfig(access: Exclude<AccessPolicy, "text-only">): string {
  const config = { permission: PERMISSIONS[access] };
  const json = JSON.stringify(config, null, 2);
  const sha = crypto.createHash("sha1").update(json).digest("hex").slice(0, 16);
  const dir = path.join(DATA_DIR, "runtime", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, json);
  return file;
}

export function buildArgs(req: ResolvedAgentRequest): string[] {
  if (req.access === "text-only") {
    throw new UnsupportedRuntimeCapabilityError(
      "opencode", 'access policy "text-only"', "no way to disable tools entirely",
    );
  }
  if ((req.readDirs ?? []).length > 0) {
    throw new UnsupportedRuntimeCapabilityError(
      "opencode", "readDirs (cross-repo reads)", "no --add-dir equivalent exists",
    );
  }
  const args = [
    "run",
    "--format", "json",
    "--pure",                                  // closest thing to a reproducible run
    "--agent", req.access === "repo-write" ? "build" : "plan",
    "-m", req.model.invocation,
  ];
  if (req.cwd) args.push("--dir", req.cwd);
  if (req.model.effort) args.push("--variant", req.model.effort);
  return args;
}

export function buildEnv(req: ResolvedAgentRequest): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Verified to be honoured: with a deny config the model reports it has no
    // bash tool and never calls one; without it, bash runs.
    OPENCODE_CONFIG: materializeConfig(req.access as Exclude<AccessPolicy, "text-only">),
  };
}

/**
 * XDG is deliberately NOT redirected.
 *
 * Redirecting XDG_CONFIG_HOME/XDG_DATA_HOME to keep session transcripts out of
 * the shared home directory looked like the right call for constraint #4, and
 * it silently broke authentication: OpenCode keeps provider config in
 * ~/.config/opencode/opencode.json and credentials in
 * ~/.local/share/opencode/auth.json, so a redirected run cannot resolve any
 * provider at all. Measured — the same request returns "Authentication Error,
 * Key is blocked" (provider found) without the redirect and
 * "ProviderModelNotFoundError" (provider missing) with it.
 *
 * A runtime that cannot authenticate is useless, and the constraint's intent is
 * still met: we read the user's own existing credentials and never write any.
 * The cost is that OpenCode has no ephemeral mode, so its sessions persist in
 * the user's home directory — a known deviation, recorded rather than hidden.
 */

interface OpenCodePart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: unknown; output?: string };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  cost?: number;
}

interface OpenCodeEvent {
  type?: string;
  part?: OpenCodePart;
  error?: { name?: string; data?: { message?: string } };
}

/** OpenCode tool name -> the Claude-shaped name + input key the UI switches on. */
const TOOL_MAP: Record<string, { name: string; key: string }> = {
  read: { name: "Read", key: "file_path" },
  write: { name: "Write", key: "file_path" },
  edit: { name: "Edit", key: "file_path" },
  patch: { name: "Edit", key: "file_path" },
  grep: { name: "Grep", key: "pattern" },
  glob: { name: "Glob", key: "pattern" },
  list: { name: "Glob", key: "pattern" },
  bash: { name: "Bash", key: "command" },
};

function normalizeToolInput(tool: string, input: unknown): unknown {
  const spec = TOOL_MAP[tool];
  if (!spec || typeof input !== "object" || input === null) return input;
  const src = input as Record<string, unknown>;
  const value = src.filePath ?? src.path ?? src.pattern ?? src.command ?? src.query;
  return value === undefined ? input : { ...src, [spec.key]: value };
}

interface MapperState {
  /** part.id -> characters already emitted, because text events are snapshots. */
  emitted: Map<string, number>;
  /** callID -> whether tool_use / tool_result have been emitted. */
  tools: Map<string, { started: boolean; finished: boolean }>;
}

export function createMapperState(): MapperState {
  return { emitted: new Map(), tools: new Map() };
}

export function mapEvent(evt: OpenCodeEvent, st: MapperState): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!evt || typeof evt !== "object") return out;

  if (evt.type === "error") {
    // Surfaced verbatim: this is how a blocked LiteLLM key reaches the user as
    // "Key is blocked" instead of a generic failure 20 minutes later.
    const msg = evt.error?.data?.message ?? evt.error?.name ?? "opencode reported an error";
    out.push({ type: "error", error: msg });
    return out;
  }

  const part = evt.part;
  if (!part) return out;

  if (evt.type === "text" || part.type === "text") {
    const id = part.id ?? "";
    const full = part.text ?? "";
    const already = st.emitted.get(id) ?? 0;
    if (full.length > already) {
      out.push({ type: "text", text: full.slice(already) });
      st.emitted.set(id, full.length);
    }
    return out;
  }

  if (evt.type === "tool_use" || part.type === "tool") {
    const id = part.callID ?? part.id ?? "";
    const tool = part.tool ?? "unknown";
    const mapped = TOOL_MAP[tool]?.name ?? tool;
    const status = part.state?.status;
    const seen = st.tools.get(id) ?? { started: false, finished: false };

    if (!seen.started) {
      out.push({
        type: "tool_use",
        tool: { name: mapped, input: normalizeToolInput(tool, part.state?.input), id },
      });
      seen.started = true;
    }
    if (!seen.finished && (status === "completed" || status === "error")) {
      out.push({
        type: "tool_result",
        toolResult: { id, content: part.state?.output ?? "", isError: status === "error" },
      });
      seen.finished = true;
    }
    st.tools.set(id, seen);
    return out;
  }

  if (evt.type === "step_finish") {
    const t = part.tokens;
    if (t) {
      out.push({
        type: "usage",
        usage: {
          inputTokens: t.input,
          outputTokens: t.output,
          reasoningTokens: t.reasoning,
          cacheReadTokens: t.cache?.read,
          cacheWriteTokens: t.cache?.write,
          costUsd: part.cost,
        },
      });
    }
    return out;
  }

  if (evt.type === "step_start") out.push({ type: "status", status: "step_start" });
  return out;
}

export const opencodeRuntime: AgentRuntime = {
  id: "opencode",

  async *run(req: ResolvedAgentRequest): AsyncIterable<AgentEvent> {
    const args = buildArgs(req);        // throws for text-only / readDirs
    const env = buildEnv(req);
    const st = createMapperState();
    let sawError = false;

    // OpenCode has no developer-instruction flag, so system text is prepended.
    const prompt = req.developerInstructions
      ? `<system>\n${req.developerInstructions}\n</system>\n\n${req.prompt}`
      : req.prompt;

    for await (const e of streamProcess({
      bin: BIN, args, cwd: req.cwd, env, stdin: prompt,
      timeoutMs: req.timeoutMs, signal: req.signal,
    })) {
      if (e.kind === "line") {
        for (const chunk of mapEvent(e.value as OpenCodeEvent, st)) {
          if (chunk.type === "error") sawError = true;
          yield chunk;
        }
        continue;
      }
      if (e.kind === "unparseable") continue;
      // An error event already terminated the stream and carried the runtime's
      // own message — "Authentication Error, Key is blocked" is far more useful
      // than a generic exit summary, and emitting a second terminal event here
      // would both overwrite it and break the one-terminal-event guarantee.
      if (sawError) return;
      const verdict = classifyExit(e, false, BIN);
      if (verdict.ok) yield { type: "done" };
      else yield { type: "error", error: verdict.message + (verdict.stderr ? `\n${verdict.stderr.slice(-800)}` : "") };
      return;
    }
  },

  async probe(): Promise<RuntimeStatus> {
    try {
      const { stdout: ver } = await execFileAsync(BIN, ["--version"], { timeout: 10_000 });
      let models: string[] = [];
      try {
        const { stdout } = await execFileAsync(BIN, ["models"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        models = stdout.split("\n").map((s) => s.trim()).filter((s) => s.includes("/"));
      } catch { /* catalog is a convenience */ }
      return { id: "opencode", installed: true, version: ver.trim(), models };
    } catch (err) {
      return { id: "opencode", installed: false, models: [], error: (err as Error).message };
    }
  },
};
