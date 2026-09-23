/**
 * Mandatory ReScript build check.
 *
 * Every skill that mutates source files (props, translations, patches) MUST
 * run this before reporting success. If `npm run re:build` fails, the change
 * is fundamentally broken (missing module, syntax error, type mismatch) and
 * the agent should NOT mark its work as successful.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface BuildCheckResult {
  passed: boolean;
  log: string; // tail of stdout+stderr, suitable for surfacing to the UI
}

const BUILD_TIMEOUT_MS = 180_000;
const LOG_TAIL_BYTES = 4000;

/**
 * Run `npm run re:build` (which resolves to `rescript`) inside the given repo.
 * Throws if node_modules isn't installed — we never silently skip the check.
 */
export function runRescriptBuild(repoDir: string): BuildCheckResult {
  if (!fs.existsSync(path.join(repoDir, "node_modules"))) {
    throw new Error(
      `node_modules not installed in ${repoDir} — cannot run mandatory ReScript build check. Run \`npm install\` first.`,
    );
  }

  try {
    const output = execSync("npm run --silent re:build 2>&1", {
      cwd: repoDir,
      timeout: BUILD_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return { passed: true, log: tail(output) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined =
      (e.stdout ?? "") + "\n" + (e.stderr ?? "") + "\n" + (e.message ?? "");
    return { passed: false, log: tail(combined) };
  }
}

/**
 * Non-blocking variant of runRescriptBuild. `execSync` freezes the whole
 * server's event loop for the length of the build (up to 3 minutes) — every
 * other request and stream stalls. This spawns the build, enforces the same
 * timeout, and stops it if `signal` aborts (a cancelled run should not keep
 * compiling). A timeout is reported as a failure that says so, not as a
 * generic build failure.
 */
export function runRescriptBuildAsync(repoDir: string, signal?: AbortSignal): Promise<BuildCheckResult> {
  if (!fs.existsSync(path.join(repoDir, "node_modules"))) {
    return Promise.reject(
      new Error(`node_modules not installed in ${repoDir} — cannot run mandatory ReScript build check. Run \`npm install\` first.`),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "re:build"], {
      cwd: repoDir,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    const append = (b: Buffer) => {
      out += b.toString();
      if (out.length > 1024 * 1024) out = out.slice(-512 * 1024);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const killTree = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, BUILD_TIMEOUT_MS);
    const onAbort = () => killTree();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        const err = new Error("build cancelled");
        err.name = "AbortError";
        reject(err);
        return;
      }
      if (timedOut) {
        resolve({ passed: false, log: tail(`${out}\n[build timed out after ${BUILD_TIMEOUT_MS / 1000}s]`) });
        return;
      }
      resolve({ passed: code === 0, log: tail(out) });
    });
  });
}

/**
 * Run the build check and throw a descriptive error on failure. Use this when
 * the caller wants the failure to short-circuit the skill (props, translations,
 * patches) and propagate up to the route's catch handler.
 */
export function assertRescriptBuildPasses(repoDir: string, repoLabel: string): void {
  const { passed, log } = runRescriptBuild(repoDir);
  if (!passed) {
    throw new Error(
      `ReScript build failed in ${repoLabel} — change rejected. The agent's edits introduced a syntax or type error. Build output (tail):\n\n${log}`,
    );
  }
}

function tail(s: string): string {
  if (s.length <= LOG_TAIL_BYTES) return s;
  return "…\n" + s.slice(-LOG_TAIL_BYTES);
}
