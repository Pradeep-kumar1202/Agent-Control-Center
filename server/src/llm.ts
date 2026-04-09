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
