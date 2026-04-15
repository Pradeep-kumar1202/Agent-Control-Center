import { spawn, type ChildProcess } from "node:child_process";

/**
 * LLM wrapper that shells out to the local `claude` CLI in print mode.
 *
 * This intentionally avoids @anthropic-ai/sdk so we never need an API key —
 * `claude -p` uses the user's existing Claude Code login (e.g. Max plan)
 * and bills against the subscription, not API credits.
 */

// Track every active claude subprocess we spawn so /analyze/cancel can kill
// them all without touching unrelated claude sessions on the machine.
const activeChildren = new Set<ChildProcess>();

export function killAllSubprocesses(): number {
  let n = 0;
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
      n++;
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  return n;
}

export function activeSubprocessCount(): number {
  return activeChildren.size;
}

export type Model = "sonnet" | "opus" | "haiku";

export interface AskOptions {
  model?: Model;
  /** Hard timeout for the subprocess. */
  timeoutMs?: number;
  /** System prompt prepended to the user prompt. */
  system?: string;
  /**
   * Working directory for the subprocess. Tools like Read/Grep/Glob will
   * resolve relative paths against this directory.
   */
  cwd?: string;
  /**
   * Allowed tool names. When provided, the CLI is launched with tool access
   * (and `--permission-mode bypassPermissions`) so Claude can read/grep the
   * filesystem itself. Defaults to disabled (no tools).
   */
  allowedTools?: string[];
}

export class LLMError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
  }
}

/**
 * Send a prompt to Claude via the CLI. Returns the raw text response.
 */
export function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const {
    model = "sonnet",
    timeoutMs = 180_000,
    system,
    cwd,
    allowedTools,
  } = opts;

  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "text",
    "--no-session-persistence",
  ];
  if (system) args.push("--append-system-prompt", system);

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowed-tools", allowedTools.join(" "));
    args.push("--permission-mode", "bypassPermissions");
  } else {
    // No tool use — disable everything for speed.
    args.push("--tools", "");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd,
    });
    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    // timeoutMs <= 0 disables the hard timeout — used by long-running coder paths.
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new LLMError(`claude CLI timed out after ${timeoutMs}ms`, stderr));
        }, timeoutMs)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      activeChildren.delete(child);
    };

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      cleanup();
      reject(new LLMError(`failed to spawn claude: ${err.message}`, stderr));
    });

    child.on("close", (code, signal) => {
      cleanup();
      if (signal === "SIGKILL") {
        reject(new LLMError(`claude CLI cancelled (SIGKILL)`));
        return;
      }
      if (code !== 0) {
        reject(new LLMError(`claude CLI exited with code ${code}`, stderr));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Streaming variant of `ask`. Spawns `claude -p --output-format stream-json`
 * and invokes `onChunk` as events arrive, so a caller can forward them to an
 * HTTP response (NDJSON) or a websocket in real time.
 *
 * The chunk shape is our own, not Anthropic's — we normalize their stream-
 * json into four categories the chat route cares about: plain text from the
 * assistant, tool_use calls, tool_result responses, and a terminal "done"
 * marker. Errors surface as a single `{type: "error"}` chunk before the
 * returned promise rejects.
 *
 * Note: `--output-format stream-json` requires `--verbose` to actually emit
 * per-event lines (the CLI is strict about this).
 */
export interface StreamChunk {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  /** Assistant text delta (type: "text"). */
  text?: string;
  /** Tool call details (type: "tool_use"). */
  tool?: { name: string; input?: unknown; id?: string };
  /** Tool result from a tool_use by id (type: "tool_result"). */
  toolResult?: { id: string; content?: string; isError?: boolean };
  /** Human-readable error when the stream can't be parsed or the CLI dies. */
  error?: string;
}

export function askStream(
  prompt: string,
  opts: AskOptions,
  onChunk: (chunk: StreamChunk) => void,
): Promise<void> {
  const {
    model = "sonnet",
    timeoutMs = 180_000,
    system,
    cwd,
    allowedTools,
  } = opts;

  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    // stream-json requires verbose mode to actually emit incremental events.
    "--verbose",
    "--no-session-persistence",
  ];
  if (system) args.push("--append-system-prompt", system);
  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowed-tools", allowedTools.join(" "));
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--tools", "");
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd,
    });
    activeChildren.add(child);

    let buf = "";
    let stderr = "";
    // timeoutMs <= 0 disables the hard timeout — used by long-running coder paths.
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          child.kill("SIGKILL");
          onChunk({ type: "error", error: `claude CLI timed out after ${timeoutMs}ms` });
          reject(new LLMError(`claude CLI timed out after ${timeoutMs}ms`, stderr));
        }, timeoutMs)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      activeChildren.delete(child);
    };

    child.stdout.on("data", (raw) => {
      buf += raw.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as StreamEvent;
          for (const chunk of mapStreamEvent(evt)) onChunk(chunk);
        } catch {
          onChunk({ type: "error", error: `unparseable stream-json line: ${line.slice(0, 200)}` });
        }
      }
    });
    child.stderr.on("data", (raw) => (stderr += raw.toString()));

    child.on("error", (err) => {
      cleanup();
      onChunk({ type: "error", error: `failed to spawn claude: ${err.message}` });
      reject(new LLMError(`failed to spawn claude: ${err.message}`, stderr));
    });

    child.on("close", (code, signal) => {
      cleanup();
      // Drain any trailing line without a newline.
      if (buf.trim()) {
        try {
          const evt = JSON.parse(buf.trim()) as StreamEvent;
          for (const chunk of mapStreamEvent(evt)) onChunk(chunk);
        } catch { /* ignore trailing noise */ }
      }
      if (signal === "SIGKILL") {
        onChunk({ type: "error", error: "claude CLI cancelled (SIGKILL)" });
        reject(new LLMError("claude CLI cancelled (SIGKILL)"));
        return;
      }
      if (code !== 0) {
        onChunk({ type: "error", error: `claude CLI exited with code ${code}` });
        reject(new LLMError(`claude CLI exited with code ${code}`, stderr));
        return;
      }
      onChunk({ type: "done" });
      resolve();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ─── stream-json event mapping ──────────────────────────────────────────────
//
// The CLI's stream-json shape is loosely based on Anthropic's Messages API
// streaming events. We only care about a handful of variants; everything
// else is ignored. These types are narrow on purpose — anything unknown is
// skipped by mapStreamEvent rather than blowing up the chat.

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id?: string; name?: string; input?: unknown }
      | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
    >;
  };
}

function mapStreamEvent(evt: StreamEvent): StreamChunk[] {
  const out: StreamChunk[] = [];
  if (!evt || typeof evt !== "object") return out;

  // assistant message: text + tool_use blocks.
  if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        out.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        out.push({
          type: "tool_use",
          tool: {
            name: block.name ?? "unknown",
            input: block.input,
            id: block.id,
          },
        });
      }
    }
    return out;
  }

  // user message (from the CLI's side): carries tool_result entries for
  // tool_use blocks the assistant just emitted.
  if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? null);
        out.push({
          type: "tool_result",
          toolResult: {
            id: block.tool_use_id ?? "",
            content,
            isError: block.is_error === true,
          },
        });
      }
    }
    return out;
  }

  // terminal event — we signal done ourselves on process exit, but treat
  // the CLI's explicit result event as a hint.
  if (evt.type === "result") {
    return out; // handled on exit
  }

  return out;
}

/**
 * Ask the model and parse a JSON response. Strips ```json fences if present.
 */
export async function askJson<T = unknown>(
  prompt: string,
  opts: AskOptions = {},
): Promise<T> {
  const text = await ask(prompt, opts);

  // Prefer a fenced ```json``` block if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  // Always also try the balanced-brace extractor as a fallback.
  const balanced = extractBalancedJson(text);
  if (balanced) candidates.push(balanced);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try the next candidate */
    }
  }

  throw new LLMError(
    `LLM response was not valid JSON.\n--- raw ---\n${text}`,
  );
}

/**
 * Walk forward from the first `{` or `[` and return the substring up to its
 * matching brace, ignoring quoted strings. Returns null if no balanced
 * value is found.
 */
function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
