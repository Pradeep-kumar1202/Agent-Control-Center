import { spawn, type ChildProcess } from "node:child_process";
import { RUNTIMES } from "./runtime/index.js";
import { getAgentSettings, resolveSlot } from "./runtime/settings.js";
import type { AccessPolicy, AgentSlot, ModelRef } from "./runtime/types.js";

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

/**
 * @deprecated Anthropic-specific. Use `slot` and assign a runtime in Settings,
 * or pass `model` as a raw string when you need to pin one.
 */
export type Model = "sonnet" | "opus" | "haiku";

export interface AskOptions {
  /**
   * Which pipeline stage this call is. Settings map slots to a runtime + model,
   * so assigning `patch.implementer` to an OpenCode profile moves exactly that
   * stage without touching any code.
   *
   * When omitted, the `default` assignment applies. When nothing is assigned at
   * all, the call falls back to the legacy claude-code path with `model`, so
   * behaviour is unchanged until someone configures a profile.
   */
  slot?: AgentSlot;
  model?: Model | string;
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
  /**
   * Cancels the run and kills the spawned agent's whole process group.
   *
   * Not optional in practice for streaming routes. Without it a client
   * disconnect or a route error leaves the agent alive: one was observed still
   * editing the workspace 13 minutes after its stream had closed, writing onto
   * `main` after the route had already checked the feature branch back out.
   * Those edits belong to no run and silently contaminate the next one's diff.
   */
  signal?: AbortSignal;
}

export class LLMError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
  }
}

/**
 * Translate the legacy `allowedTools` list into a requested authority.
 *
 * This is what lets every existing call site work on a non-Claude runtime with
 * no edit: the list already encodes intent, so the tier can be derived from it
 * instead of being hand-written into 30 places.
 */
export function accessFromAllowedTools(allowedTools?: string[]): AccessPolicy {
  const t = new Set(allowedTools ?? []);
  if (t.size === 0) return "text-only";
  if (t.has("Edit") || t.has("Write") || t.has("NotebookEdit")) return "repo-write";
  if (t.has("Bash")) return "repo-read-exec";
  return "repo-read";
}

/**
 * Decide which runtime serves this call.
 *
 * Returns null to mean "use the built-in claude-code path unchanged" — the case
 * when nothing has been configured yet, which keeps the dashboard behaving
 * exactly as before until someone opens Settings.
 */
function routeFor(opts: AskOptions): ModelRef | null {
  try {
    const settings = getAgentSettings();
    if (Object.keys(settings.profiles).length === 0) return null;
    const ref = opts.slot
      ? resolveSlot(opts.slot, settings)
      : resolveSlot("analysis.extract", { ...settings, assignments: { default: settings.assignments.default ?? "" } });
    if (!ref) return null;
    // The assigned profile wins over `opts.model`, deliberately. Every legacy
    // call site hardcodes an Anthropic name ("opus"/"sonnet"), so honouring it
    // would make assignment pointless — and worse, silently forward "opus" to
    // Codex, which rejects it ("The 'opus' model is not supported when using
    // Codex with a ChatGPT account"). `opts.model` still applies on the
    // fallback path, where no profile is configured at all.
    return ref;
  } catch {
    return null;   // a broken settings row must never take the pipeline down
  }
}

/**
 * Run a call on a non-Claude runtime, forwarding normalized chunks.
 *
 * The adapter's event union is a superset of StreamChunk, so forwarding is a
 * pass-through rather than a translation — adapters already emit Claude-shaped
 * tool names precisely so the UI and every existing NDJSON consumer keep
 * working unchanged.
 */
async function runViaRuntime(
  prompt: string,
  opts: AskOptions,
  model: ModelRef,
  onChunk?: (c: StreamChunk) => void,
): Promise<string> {
  const runtime = RUNTIMES[model.runtime];
  const access = accessFromAllowedTools(opts.allowedTools);
  let text = "";
  let failure: string | null = null;

  for await (const ev of runtime.run({
    slot: opts.slot ?? "analysis.extract",
    prompt,
    developerInstructions: opts.system,
    access,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    model,
  })) {
    if (ev.type === "text") text += ev.text;
    if (ev.type === "error") failure = ev.error;
    onChunk?.(ev as StreamChunk);
  }

  if (failure) throw new LLMError(`${model.runtime} (${model.invocation}): ${failure}`);
  return text.trim();
}

/** Every tool the CLI can expose. Anything not permitted is explicitly denied. */
const ALL_TOOLS = [
  "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task",
] as const;

/**
 * Translate an allow-list into the CLI flags that actually enforce it.
 *
 * `--allowed-tools` does NOT restrict anything — it only pre-approves. Measured
 * against claude 2.1.226, Bash ran under all of:
 *
 *   --allowed-tools "Read Glob Grep"     (the space-joined form this used)
 *   --allowed-tools Read Glob Grep       (correct variadic form)
 *   --tools ""                           ("disable everything for speed")
 *
 * with and without `--permission-mode bypassPermissions`. Only
 * `--disallowed-tools` blocks. So every "read-only" agent here — the patch
 * analyst and verifier, gap validation, both review passes, feature discovery —
 * had full write and shell access, and the no-tools tier behind the extractors
 * and normalize was never cheap in the way it claimed to be.
 *
 * This was not hypothetical: a read-only analyst spent its entire 600 s budget
 * making 15 Bash calls and timed out having produced nothing.
 *
 * `server/src/scripts/probeAccessPolicy.ts` re-proves this per tier, so a CLI
 * upgrade that changes the semantics fails a check instead of silently
 * reopening the hole.
 */
function toolGateArgs(allowedTools?: string[]): string[] {
  const allowed = new Set(allowedTools ?? []);
  const denied = ALL_TOOLS.filter((t) => !allowed.has(t));
  if (denied.length === 0) return ["--permission-mode", "bypassPermissions"];

  const args = ["--disallowed-tools", ...denied];
  // Only meaningful when some tool remains; with everything denied it just
  // pre-approves an empty set.
  if (allowed.size > 0) args.push("--permission-mode", "bypassPermissions");
  return args;
}

/**
 * Send a prompt to Claude via the CLI. Returns the raw text response.
 */
export function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const route = routeFor(opts);
  if (route && route.runtime !== "claude-code") return runViaRuntime(prompt, opts, route);

  const {
    // A claude-code profile still gets to pick the model; with no profile at
    // all this is the caller's own value, unchanged.
    model = route?.invocation ?? "sonnet",
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

  args.push(...toolGateArgs(allowedTools));

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd,
    });
    activeChildren.add(child);

    // Cancel on abort. The runtime adapters kill the whole process group via
    // proc.ts; this legacy path can only reach the direct child, which is
    // still far better than leaving an agent editing the repo after its
    // stream has closed.
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("close", () => opts.signal?.removeEventListener("abort", onAbort));

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LLMError(`claude CLI timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
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
  // "status" | "warning" | "usage" are additive — emitted only by the non-Claude
  // runtimes. Existing consumers ignore chunk types they don't recognise.
  type: "text" | "tool_use" | "tool_result" | "done" | "error" | "status" | "warning" | "usage";
  /** Coarse progress from runtimes that don't stream token deltas (codex). */
  status?: string;
  /** Non-fatal notice, e.g. an access policy that was narrower than the work needed. */
  warning?: string;
  /** Token counts and, where the runtime reports one, a list-price equivalent. */
  usage?: Record<string, number | undefined>;
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
  const route = routeFor(opts);
  if (route && route.runtime !== "claude-code") {
    return runViaRuntime(prompt, opts, route, onChunk).then(() => undefined);
  }

  const {
    model = route?.invocation ?? "sonnet",
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
  args.push(...toolGateArgs(allowedTools));

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd,
    });
    activeChildren.add(child);

    // Cancel on abort. The runtime adapters kill the whole process group via
    // proc.ts; this legacy path can only reach the direct child, which is
    // still far better than leaving an agent editing the repo after its
    // stream has closed.
    const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("close", () => opts.signal?.removeEventListener("abort", onAbort));

    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      onChunk({ type: "error", error: `claude CLI timed out after ${timeoutMs}ms` });
      reject(new LLMError(`claude CLI timed out after ${timeoutMs}ms`, stderr));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
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
