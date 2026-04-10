import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

/**
 * LLM wrapper using GitHub Models API (OpenAI-compatible endpoint).
 *
 * GitHub Copilot Pro gives access to Claude Sonnet and other models via:
 *   https://models.inference.ai.azure.com
 *
 * Authentication: set GITHUB_TOKEN in .env to a GitHub Personal Access Token.
 * Get one at: github.com → Settings → Developer Settings → Personal Access Tokens → Classic
 * (No special scopes needed beyond having an active Copilot Pro subscription.)
 */

const client = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com",
  apiKey: process.env.GITHUB_TOKEN ?? "",
});

// GitHub Models model IDs
// Check exact IDs at: https://github.com/marketplace/models
// Click a model → "Use this model" → copy the model name shown in the code snippet
const MODEL_IDS: Record<string, string> = {
  sonnet: "gpt-4.1",
  haiku: "gpt-4.1-mini",
  opus: "gpt-4.1",
};

// Cancellation controllers for in-flight requests (replaces subprocess tracking)
const activeControllers = new Set<AbortController>();

export function killAllSubprocesses(): number {
  const n = activeControllers.size;
  for (const ctrl of activeControllers) ctrl.abort();
  activeControllers.clear();
  return n;
}

export function activeSubprocessCount(): number {
  return activeControllers.size;
}

export type Model = "sonnet" | "opus" | "haiku";

export interface AskOptions {
  model?: Model;
  /** Hard timeout in ms (default 180s) */
  timeoutMs?: number;
  /** System prompt */
  system?: string;
  /** Working directory for file tools (Read/Write/Edit/Glob/Grep) */
  cwd?: string;
  /**
   * When provided, runs an agentic loop giving the model access to these tools.
   * Supported: "Read", "Write", "Edit", "Glob", "Grep"
   */
  allowedTools?: string[];
}

export class LLMError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
  }
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const ALL_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file's contents. Returns the file text (truncated at 50k chars).",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path or path relative to cwd" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file. Creates parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to write" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Replace an exact string in a file. Fails if old_string is not found or is ambiguous (appears more than once). Provide more surrounding context in old_string to disambiguate.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string", description: "Exact text to replace (must be unique in file)" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "Find files matching a glob pattern. Returns newline-separated file paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern e.g. 'src/**/*.ts'" },
          path: { type: "string", description: "Directory to search in (defaults to cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search file contents for a regex pattern. Returns matching lines with file:line context.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search (defaults to cwd)" },
          include: { type: "string", description: "Glob file filter e.g. '*.ts'" },
        },
        required: ["pattern"],
      },
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

function resolvePath(p: string, cwd?: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd ?? process.cwd(), p);
}

async function executeTool(
  name: string,
  args: Record<string, string>,
  cwd?: string,
): Promise<string> {
  try {
    switch (name) {
      case "Read": {
        const abs = resolvePath(args.file_path, cwd);
        let content = fs.readFileSync(abs, "utf8");
        if (content.length > 50_000) content = content.slice(0, 50_000) + "\n... [truncated at 50k chars]";
        return content;
      }

      case "Write": {
        const abs = resolvePath(args.file_path, cwd);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content, "utf8");
        return `Wrote ${args.content.length} bytes to ${args.file_path}`;
      }

      case "Edit": {
        const abs = resolvePath(args.file_path, cwd);
        const raw = fs.readFileSync(abs, "utf8");
        const count = raw.split(args.old_string).length - 1;
        if (count === 0) return `Error: old_string not found in ${args.file_path}`;
        if (count > 1) return `Error: old_string appears ${count} times in ${args.file_path} — add more surrounding context to make it unique`;
        fs.writeFileSync(abs, raw.replace(args.old_string, args.new_string), "utf8");
        return `Edited ${args.file_path} successfully`;
      }

      case "Glob": {
        const base = args.path ? resolvePath(args.path, cwd) : (cwd ?? process.cwd());
        const files = await fg(args.pattern, { cwd: base, dot: true });
        return files.length === 0 ? "(no matches)" : files.slice(0, 200).join("\n");
      }

      case "Grep": {
        const base = args.path ? resolvePath(args.path, cwd) : (cwd ?? process.cwd());
        const regex = new RegExp(args.pattern, "i");
        const results: string[] = [];

        const searchFile = (filePath: string) => {
          try {
            fs.readFileSync(filePath, "utf8")
              .split("\n")
              .forEach((line, i) => {
                if (regex.test(line)) results.push(`${filePath}:${i + 1}: ${line.trim()}`);
              });
          } catch { /* skip unreadable files */ }
        };

        const stat = fs.statSync(base, { throwIfNoEntry: false });
        if (stat?.isFile()) {
          searchFile(base);
        } else {
          const files = await fg(args.include ?? "**/*", { cwd: base, dot: false });
          for (const f of files.slice(0, 500)) {
            searchFile(path.join(base, f));
            if (results.length >= 300) break;
          }
        }

        return results.length === 0 ? "(no matches)" : results.slice(0, 300).join("\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error (${name}): ${(err as Error).message}`;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a prompt to the model. Returns raw text.
 * If allowedTools is provided, runs an agentic tool-use loop.
 */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const { model = "sonnet", timeoutMs = 180_000, system, cwd, allowedTools } = opts;
  const modelId = MODEL_IDS[model] ?? MODEL_IDS.sonnet;

  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    // ── Simple completion (no tools) ──────────────────────────────────────────
    if (!allowedTools?.length) {
      const resp = await client.chat.completions.create(
        { model: modelId, messages },
        { signal: controller.signal },
      );
      return resp.choices[0].message.content ?? "";
    }

    // ── Agentic tool loop ─────────────────────────────────────────────────────
    const tools = ALL_TOOLS.filter((t) => allowedTools.includes(t.function.name));

    for (let iter = 0; iter < 50; iter++) {
      const resp = await client.chat.completions.create(
        { model: modelId, messages, tools, tool_choice: "auto" },
        { signal: controller.signal },
      );

      const msg = resp.choices[0].message;
      // Cast needed because OpenAI SDK's internal type isn't always inferred as the param union
      messages.push(msg as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      if (!msg.tool_calls?.length) return msg.content ?? "";

      for (const call of msg.tool_calls) {
        const result = await executeTool(
          call.function.name,
          JSON.parse(call.function.arguments) as Record<string, string>,
          cwd,
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    throw new LLMError("Agent loop exceeded 50 iterations without completing");
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new LLMError(`LLM call timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

/**
 * Ask the model and parse a JSON response. Strips ```json fences if present.
 */
export async function askJson<T = unknown>(
  prompt: string,
  opts: AskOptions = {},
): Promise<T> {
  const text = await ask(prompt, opts);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  const balanced = extractBalancedJson(text);
  if (balanced) candidates.push(balanced);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch { /* try next */ }
  }

  throw new LLMError(`LLM response was not valid JSON.\n--- raw ---\n${text}`);
}

function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
