/**
 * Codex runtime adapter.
 *
 * Flags and event shapes below were captured by running codex-cli 0.147.0, not
 * inferred from docs.
 *
 * Three things Codex does that the others do not:
 *  - `--output-schema <FILE>` enforces structured output, so the verifier's
 *    verdict cannot come back unparseable. That makes Codex the natural
 *    verifier, and means cross-runtime verification and fail-closed
 *    verification are the same lever.
 *  - `--add-dir` grants read access outside the sandbox root, which is what
 *    makes cross-repo analysis possible at all.
 *  - `--ignore-user-config` keeps `~/.codex/AGENTS.md` out of the run. That
 *    file exists on this machine; without the flag it is loaded into every
 *    invocation and would silently contaminate cross-runtime comparison.
 *
 * Codex cannot express `text-only`: its read-only sandbox still executes
 * commands. That is a hard error, never a silent downgrade — the whole economic
 * argument for the extract tier is "no tools", and quietly handing it a shell
 * is exactly the bulk-tools-on-the-hot-path mistake LEARNINGS warns about.
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
const BIN = "codex";

const SANDBOX: Record<Exclude<AccessPolicy, "text-only">, string> = {
  "repo-read": "read-only",
  "repo-read-exec": "read-only",
  "repo-write": "workspace-write",
};

/**
 * `--output-schema` takes a path, so the schema is materialised on disk.
 * Content-addressed under data/ (gitignored) rather than /tmp: idempotent,
 * inspectable when a run misbehaves, and cleaned up with the rest of data/.
 */
function materializeSchema(schema: object): string {
  const json = JSON.stringify(schema, null, 2);
  const sha = crypto.createHash("sha1").update(json).digest("hex").slice(0, 16);
  const dir = path.join(DATA_DIR, "schemas");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, json);
  return file;
}

export function buildArgs(req: ResolvedAgentRequest): string[] {
  if (req.access === "text-only") {
    throw new UnsupportedRuntimeCapabilityError(
      "codex", 'access policy "text-only"',
      "the read-only sandbox still permits command execution",
    );
  }
  const args = [
    "exec", "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "-s", SANDBOX[req.access],
    // Non-interactive runs must never stall on an approval they cannot surface.
    "-c", 'approval_policy="never"',
    "-m", req.model.invocation,
  ];
  if (req.cwd) args.push("-C", req.cwd);
  for (const dir of req.readDirs ?? []) args.push("--add-dir", dir);
  if (req.model.effort) args.push("-c", `model_reasoning_effort="${req.model.effort}"`);
  if (req.developerInstructions) {
    // Codex takes real developer instructions, so system text is never folded
    // into the user prompt the way it must be for OpenCode.
    args.push("-c", `developer_instructions=${JSON.stringify(req.developerInstructions)}`);
  }
  if (req.outputSchema) args.push("--output-schema", materializeSchema(req.outputSchema));
  args.push("-");   // read the prompt from stdin
  return args;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  path?: string;
}

interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: Record<string, number>;
  error?: { message?: string } | string;
}

/**
 * Map Codex events onto the shared union, translating tool names into the
 * Claude-shaped ones the UI switches on — AgentPanel matches `Bash` plus an
 * input key of `command`, and detects an in-flight build via `re:build` inside
 * that command, so `command_execution` must surface as `Bash{command}` for the
 * existing build indicator to keep working.
 */
function mapEvent(evt: CodexEvent): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!evt || typeof evt !== "object") return out;

  switch (evt.type) {
    case "thread.started":
    case "turn.started":
      out.push({ type: "status", status: evt.type });
      return out;

    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = evt.item;
      if (!item) return out;
      const done = evt.type === "item.completed";

      if (item.type === "agent_message") {
        // Codex emits completed items, never token deltas, so text arrives a
        // turn at a time. Tool chips still stream from item.started.
        if (done && item.text) out.push({ type: "text", text: item.text });
        return out;
      }
      if (item.type === "reasoning") {
        // Never surfaced as text — chain-of-thought must not leak into the
        // agent transcript that gets persisted as a patch summary.
        out.push({ type: "status", status: "thinking" });
        return out;
      }
      if (item.type === "command_execution") {
        const id = item.id ?? "";
        if (!done) {
          out.push({ type: "tool_use", tool: { name: "Bash", input: { command: item.command }, id } });
        } else {
          out.push({
            type: "tool_result",
            toolResult: {
              id,
              content: item.aggregated_output ?? "",
              isError: typeof item.exit_code === "number" && item.exit_code !== 0,
            },
          });
        }
        return out;
      }
      if (item.type === "file_change" || item.type === "patch_apply") {
        const id = item.id ?? "";
        if (!done) out.push({ type: "tool_use", tool: { name: "Edit", input: { file_path: item.path }, id } });
        else out.push({ type: "tool_result", toolResult: { id, content: item.status ?? "applied" } });
        return out;
      }
      return out;   // unknown item types are ignored, not fatal
    }

    case "turn.completed": {
      const u = evt.usage ?? {};
      out.push({
        type: "usage",
        usage: {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cached_input_tokens,
          cacheWriteTokens: u.cache_write_input_tokens,
          reasoningTokens: u.reasoning_output_tokens,
          // Codex reports no cost. Left undefined on purpose — a synthesised
          // number from a pricing table we'd have to maintain is worse than a blank.
        },
      });
      return out;
    }

    case "turn.failed":
    case "error": {
      const msg = typeof evt.error === "string" ? evt.error : evt.error?.message;
      out.push({ type: "error", error: msg ?? "codex reported a failure" });
      return out;
    }
  }
  return out;
}

export const codexRuntime: AgentRuntime = {
  id: "codex",

  async *run(req: ResolvedAgentRequest): AsyncIterable<AgentEvent> {
    const args = buildArgs(req);   // throws for text-only before anything spawns
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
        for (const chunk of mapEvent(e.value as CodexEvent)) {
          if (chunk.type === "error") sawError = true;
          yield chunk;
        }
        continue;
      }
      if (e.kind === "unparseable") continue;   // codex prints human notices on stdout too
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
      const { stdout: ver } = await execFileAsync(BIN, ["--version"], { timeout: 5000 });
      let models: string[] = [];
      try {
        // Real machine-readable catalog, unlike the other two runtimes.
        const { stdout } = await execFileAsync(BIN, ["debug", "models"], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
        const parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
          models?: Array<{ slug?: string; visibility?: string; supported_in_api?: boolean }>;
        };
        models = (parsed.models ?? [])
          .filter((m) => m.slug && m.visibility === "list" && m.supported_in_api !== false)
          .map((m) => m.slug!);
      } catch { /* catalog is a convenience; absence is not a failure */ }
      return { id: "codex", installed: true, version: ver.trim(), models };
    } catch (err) {
      return { id: "codex", installed: false, models: [], error: (err as Error).message };
    }
  },
};
