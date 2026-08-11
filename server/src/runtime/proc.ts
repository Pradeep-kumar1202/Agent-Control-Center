/**
 * Shared subprocess machinery for every runtime adapter.
 *
 * Adapters describe *what* to run; this owns the lifecycle, so the three
 * runtimes cannot drift into three subtly different notions of "finished".
 *
 * Three defects in the previous implementation are fixed here:
 *
 *  1. **Scoped cancellation.** `killAllSubprocesses()` killed every active LLM
 *     subprocess, so cancelling an analysis also killed unrelated patch and
 *     chat runs. Cancellation is now per-job via AbortSignal; the kill-all path
 *     survives only as an explicit shutdown case.
 *  2. **Orphaned grandchildren.** SIGKILL to the CLI leaked OpenCode's local
 *     HTTP server and Codex's shell children. Everything spawns detached and is
 *     killed by process group.
 *  3. **Ambiguous termination.** Exit code alone is not truth — OpenCode emits
 *     an `error` event and can still exit 0. Callers get exactly one terminal
 *     outcome, derived from exit code AND whether an error event was seen.
 */

import { spawn } from "node:child_process";
import { killProcessGroup, terminateProcessGroup } from "../procGroup.js";

export interface SpawnSpec {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin then closed. Prompts always travel this way, never in argv. */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProcEvent =
  | { kind: "line"; value: unknown; raw: string }
  | { kind: "unparseable"; raw: string }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean; aborted: boolean };

export class RuntimeSpawnError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "RuntimeSpawnError";
  }
}

/** Live children, for shutdown only. Normal cancellation uses AbortSignal. */
const liveChildren = new Set<ReturnType<typeof spawn>>();

export function killAllSubprocesses(): number {
  let n = 0;
  for (const child of liveChildren) {
    if (killProcessGroup(child, "SIGKILL")) n++;
  }
  liveChildren.clear();
  return n;
}

export function activeSubprocessCount(): number {
  return liveChildren.size;
}

/**
 * Run a CLI and yield its stdout as parsed NDJSON, then exactly one `exit`.
 *
 * Backpressure-free by design: lines are buffered into a queue rather than
 * pausing the stream, because a slow consumer must never stall an agent that is
 * mid-tool-call.
 */
export async function* streamProcess(spec: SpawnSpec): AsyncGenerator<ProcEvent> {
  const { bin, args, cwd, env, stdin, timeoutMs = 180_000, signal } = spec;

  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? process.env,
    cwd,
    // Own process group, so grandchildren die with the parent.
    detached: true,
  });
  liveChildren.add(child);

  const queue: ProcEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let timedOut = false;
  let aborted = false;
  let stderr = "";
  let buf = "";

  const push = (e: ProcEvent): void => {
    queue.push(e);
    notify?.();
  };

  const emitLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      push({ kind: "line", value: JSON.parse(trimmed), raw: trimmed });
    } catch {
      push({ kind: "unparseable", raw: trimmed });
    }
  };

  const onAbort = (): void => {
    aborted = true;
    terminateProcessGroup(child);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child);
  }, timeoutMs);
  timer.unref?.();

  child.stdout.on("data", (raw: Buffer) => {
    buf += raw.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      emitLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.on("data", (raw: Buffer) => { stderr += raw.toString(); });

  child.on("error", (err) => {
    finished = true;
    push({
      kind: "exit", code: null, signal: null,
      stderr: `${stderr}\nfailed to spawn ${bin}: ${err.message}`,
      timedOut, aborted,
    });
  });

  child.on("close", (code, sig) => {
    if (buf.trim()) emitLine(buf);   // drain a trailing line with no newline
    buf = "";
    finished = true;
    push({ kind: "exit", code, signal: sig, stderr, timedOut, aborted });
  });

  if (stdin !== undefined) {
    child.stdin.on("error", () => { /* EPIPE if the CLI exits early — the exit event is the real signal */ });
    child.stdin.write(stdin);
    child.stdin.end();
  }

  try {
    for (;;) {
      while (queue.length > 0) {
        const e = queue.shift()!;
        yield e;
        if (e.kind === "exit") return;
      }
      if (finished && queue.length === 0) return;
      await new Promise<void>((resolve) => { notify = resolve; });
      notify = null;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    liveChildren.delete(child);
    // If the consumer broke out early (client disconnect), don't leak the tree.
    if (!finished) terminateProcessGroup(child);
  }
}

/**
 * Classify an exit into success or a descriptive failure.
 *
 * `sawErrorEvent` is not optional politeness — OpenCode reports an APIError in
 * its event stream and still exits 0, so trusting the exit code alone would
 * record a failed run as a success.
 */
export function classifyExit(
  e: Extract<ProcEvent, { kind: "exit" }>,
  sawErrorEvent: boolean,
  bin: string,
): { ok: true } | { ok: false; message: string; stderr?: string } {
  if (e.aborted) return { ok: false, message: `${bin} cancelled` };
  if (e.timedOut) return { ok: false, message: `${bin} timed out`, stderr: e.stderr };
  if (e.code === null && e.signal) return { ok: false, message: `${bin} killed by ${e.signal}`, stderr: e.stderr };
  if (e.code !== 0) return { ok: false, message: `${bin} exited with code ${e.code}`, stderr: e.stderr };
  if (sawErrorEvent) return { ok: false, message: `${bin} reported an error despite exiting 0`, stderr: e.stderr };
  return { ok: true };
}
