/**
 * Claude Code runtime adapter.
 *
 * Access enforcement is a DENYLIST, and that is not a style preference —
 * it was measured. Against claude 2.1.226:
 *
 *   --allowed-tools "Read Glob Grep"   (the space-joined form llm.ts used)  -> Bash still ran
 *   --allowed-tools Read Glob Grep     (correct variadic form)              -> Bash still ran
 *   --tools ""                         ("disable everything for speed")     -> Bash still ran
 *   ...with and without --permission-mode bypassPermissions                 -> Bash still ran
 *   --disallowed-tools Bash Write Edit                                      -> BLOCKED
 *
 * `--allowed-tools` only PRE-APPROVES tools; it does not restrict them. Every
 * "read-only" agent in this codebase therefore had full write and shell access,
 * and it was not theoretical: a read-only analyst spent its entire 600 s budget
 * making 15 Bash calls and timed out with no artifact.
 *
 * `assertAccessEnforced()` re-proves the table at runtime rather than trusting
 * this comment to stay true across CLI upgrades.
 */

import {
  UnsupportedRuntimeCapabilityError,
  type AccessPolicy, type AgentEvent, type AgentRuntime,
  type ResolvedAgentRequest, type RuntimeStatus, type Usage,
} from "../types.js";
import { classifyExit, streamProcess } from "../proc.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = "claude";

/**
 * Tools denied per policy. Read/Glob/Grep are denied for `text-only` because
 * that tier's entire justification is "no tools, so it is cheap" — an
 * unenforced tier silently spends the budget it was created to protect.
 */
const DENY: Record<AccessPolicy, string[]> = {
  "text-only": ["Bash", "Write", "Edit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
  "repo-read": ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
  "repo-read-exec": ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
  "repo-write": [],
};

/** A tool each policy must NOT be able to use — the self-test's probe. */
export const FORBIDDEN_PROBE: Record<AccessPolicy, string | null> = {
  "text-only": "Bash",
  "repo-read": "Bash",
  "repo-read-exec": "Write",
  "repo-write": null,
};

export function buildArgs(req: ResolvedAgentRequest, streaming: boolean): string[] {
  const args = [
    "-p",
    "--model", req.model.invocation,
    "--no-session-persistence",
    ...(streaming
      ? ["--output-format", "stream-json", "--verbose"]
      : ["--output-format", "text"]),
  ];

  if (req.model.effort) args.push("--effort", req.model.effort);
  if (req.developerInstructions) args.push("--append-system-prompt", req.developerInstructions);

  // Claude Code has no sandbox, so file access is bounded by cwd + --add-dir.
  for (const dir of req.readDirs ?? []) args.push("--add-dir", dir);

  const deny = DENY[req.access];
  if (deny.length > 0) args.push("--disallowed-tools", ...deny);
  if (req.access !== "text-only") args.push("--permission-mode", "bypassPermissions");

  if (req.outputSchema) {
    args.push("--json-schema", JSON.stringify(req.outputSchema));
  }
  return args;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id?: string; name?: string; input?: unknown }
      | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
    >;
  };
  usage?: Record<string, number>;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  permission_denials?: unknown[];
  /** Present on the result event when --json-schema is used. */
  structured_output?: unknown;
}

function mapEvent(evt: ClaudeEvent): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!evt || typeof evt !== "object") return out;

  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && block.text) out.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        out.push({ type: "tool_use", tool: { name: block.name ?? "unknown", input: block.input, id: block.id } });
      }
    }
    return out;
  }

  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result") {
        out.push({
          type: "tool_result",
          toolResult: {
            id: block.tool_use_id ?? "",
            content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null),
            isError: block.is_error === true,
          },
        });
      }
    }
    return out;
  }

  // The terminal event carries usage, cost and permission_denials — all of it
  // was previously discarded (llm.ts:330).
  if (evt.type === "result") {
    const u = evt.usage ?? {};
    const usage: Usage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens,
      cacheWriteTokens: u.cache_creation_input_tokens,
      costUsd: evt.total_cost_usd,
      durationMs: evt.duration_ms,
      numTurns: evt.num_turns,
    };
    out.push({ type: "usage", usage });
    // With --json-schema Claude may put the only machine-readable answer on
    // the terminal event rather than in an assistant text block. Surface it
    // through the shared text channel so structured agents work identically
    // across Claude Code and Codex.
    if (evt.structured_output !== undefined) {
      out.push({ type: "text", text: JSON.stringify(evt.structured_output) });
    }
    // A non-empty denial list means the access policy was narrower than the
    // work required — worth surfacing rather than silently degrading output.
    if (Array.isArray(evt.permission_denials) && evt.permission_denials.length > 0) {
      out.push({
        type: "warning",
        warning: `${evt.permission_denials.length} tool call(s) denied by the access policy`,
      });
    }
  }
  return out;
}

export const claudeCodeRuntime: AgentRuntime = {
  id: "claude-code",

  async *run(req: ResolvedAgentRequest): AsyncIterable<AgentEvent> {
    if (!(req.access in DENY)) {
      throw new UnsupportedRuntimeCapabilityError("claude-code", `access policy "${req.access}"`);
    }
    const args = buildArgs(req, true);
    let sawError = false;

    for await (const e of streamProcess({
      bin: BIN,
      args,
      cwd: req.cwd,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    })) {
      if (e.kind === "line") {
        for (const chunk of mapEvent(e.value as ClaudeEvent)) {
          if (chunk.type === "error") sawError = true;
          yield chunk;
        }
        continue;
      }
      if (e.kind === "unparseable") {
        yield { type: "warning", warning: `unparseable stream line: ${e.raw.slice(0, 160)}` };
        continue;
      }
      // Keep the runtime's own error as the single terminal event.
      if (sawError) return;
      const verdict = classifyExit(e, false, BIN);
      if (verdict.ok) yield { type: "done" };
      else yield { type: "error", error: verdict.message + (verdict.stderr ? `\n${verdict.stderr.slice(-800)}` : "") };
      return;
    }
  },

  async probe(): Promise<RuntimeStatus> {
    try {
      const { stdout } = await execFileAsync(BIN, ["--version"], { timeout: 5000 });
      return {
        id: "claude-code",
        installed: true,
        version: stdout.trim(),
        // No enumerable catalog; these seed the combobox without constraining it.
        models: ["opus", "sonnet", "haiku"],
      };
    } catch (err) {
      return {
        id: "claude-code",
        installed: false,
        models: [],
        error: (err as Error).message,
      };
    }
  },
};

/**
 * Prove a policy actually blocks what it claims to.
 *
 * Exists because the tier table was wrong for two years' worth of call sites
 * and nothing noticed. A capability table that is asserted rather than tested
 * is a comment, not a boundary.
 */
export async function assertAccessEnforced(
  access: AccessPolicy,
  invocation = "sonnet",
  cwd?: string,
): Promise<{ enforced: boolean; detail: string }> {
  const probe = FORBIDDEN_PROBE[access];
  if (probe === null) return { enforced: true, detail: "repo-write forbids nothing" };

  const prompt = probe === "Bash"
    ? "Use the Bash tool to run 'echo ACCESS_CHECK'. If you do not have a Bash tool, reply exactly: BLOCKED"
    : "Use the Write tool to create a file named access-check.tmp containing 'x'. If you do not have a Write tool, reply exactly: BLOCKED";

  const req: ResolvedAgentRequest = {
    slot: "analysis.extract",
    prompt,
    access,
    cwd,
    timeoutMs: 120_000,
    model: { runtime: "claude-code", invocation },
  };

  let text = "";
  const attempted = new Set<string>();     // tool_use ids for the forbidden tool
  const succeeded = new Set<string>();     // ...whose result came back non-error

  for await (const ev of claudeCodeRuntime.run(req)) {
    if (ev.type === "text") text += ev.text;
    if (ev.type === "tool_use" && ev.tool.name === probe && ev.tool.id) attempted.add(ev.tool.id);
    if (ev.type === "tool_result" && attempted.has(ev.toolResult.id) && !ev.toolResult.isError) {
      succeeded.add(ev.toolResult.id);
    }
  }

  // Enforcement is about OUTCOME, not intent. A denied tool still emits a
  // tool_use event followed by an error result, so counting attempts reports a
  // working denylist as broken. Ground truth for Write is the filesystem.
  let sideEffect = false;
  if (probe === "Write" && cwd) {
    sideEffect = fs.existsSync(path.join(cwd, "access-check.tmp"));
    if (sideEffect) { try { fs.unlinkSync(path.join(cwd, "access-check.tmp")); } catch { /* */ } }
  }

  const breached = sideEffect || succeeded.size > 0;
  return {
    enforced: !breached,
    detail: breached
      ? `${probe} SUCCEEDED despite access=${access}${sideEffect ? " (file was created)" : ""}`
      : `${probe} blocked under access=${access}` +
        (attempted.size > 0 ? ` (attempted ${attempted.size}x, all denied)` : "") +
        (text.trim() ? ` — "${text.trim().slice(0, 60)}"` : ""),
  };
}
