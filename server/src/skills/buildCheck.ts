/**
 * Mandatory ReScript build check.
 *
 * Every skill that mutates source files (props, translations, patches) MUST
 * run this before reporting success. If `npm run re:build` fails, the change
 * is fundamentally broken (missing module, syntax error, type mismatch) and
 * the agent should NOT mark its work as successful.
 */

import { execSync } from "node:child_process";
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
