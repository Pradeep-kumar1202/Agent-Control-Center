/**
 * Test runner — executes Cypress (web) or Detox (mobile) test suites and
 * streams output back to the dashboard in real time.
 *
 * The runner checks out the test branch, ensures dependencies are installed,
 * runs the tests, and streams each stdout line as an NDJSON event. When
 * the process exits, it emits a final result event with the exit code.
 *
 * For Cypress: tests run headless against http://localhost:9050 (the web
 * preview dev server — must be up). Publishable key + secret key come from
 * process.env (loaded from .env by config.ts).
 *
 * For Detox: tests run against the emulator that's already up from the
 * android preview flow.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPOS, type RepoKey } from "../../config.js";
import { forceCheckoutBranch } from "../submoduleGit.js";

export interface TestRunSpec {
  branch: string;
  repo: "web" | "mobile";
  /** Specific test files to run (relative to test dir). If empty, runs all. */
  testFiles?: string[];
}

export interface TestRunChunk {
  type: "log" | "result" | "error" | "done";
  line?: string;
  exitCode?: number;
  success?: boolean;
  error?: string;
}

/**
 * Ensure cypress-tests/node_modules exists. Idempotent — skips if already
 * installed. Runs synchronously because it blocks test execution and we
 * don't want the async interleaving to confuse the NDJSON stream.
 */
function ensureCypressDeps(webRepoDir: string): void {
  const cypressDir = path.join(webRepoDir, "cypress-tests");
  if (fs.existsSync(path.join(cypressDir, "node_modules", ".bin", "cypress"))) {
    return; // already installed
  }
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: cypressDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm install in cypress-tests failed (code ${result.status}): ${(result.stderr ?? "").slice(-500)}`,
    );
  }
}

/**
 * Run the test suite and stream output via `onChunk`. Returns a promise
 * that resolves when the test process exits.
 */
export async function runTestSuite(
  spec: TestRunSpec,
  onChunk: (chunk: TestRunChunk) => void,
): Promise<void> {
  const repoKey = spec.repo as RepoKey;
  const repoDir = REPOS[repoKey].dir;

  // Checkout the test branch
  onChunk({ type: "log", line: `Checking out branch ${spec.branch}...` });
  await forceCheckoutBranch(repoDir, repoKey, spec.branch);

  let cmd: string;
  let args: string[];
  let cwd: string;
  let env: Record<string, string | undefined>;

  if (spec.repo === "web") {
    const cypressDir = path.join(repoDir, "cypress-tests");
    if (!fs.existsSync(cypressDir)) {
      throw new Error("cypress-tests directory not found in hyperswitch-web");
    }
    onChunk({ type: "log", line: "Ensuring Cypress dependencies are installed..." });
    ensureCypressDeps(repoDir);

    cmd = "npx";
    args = ["cypress", "run", "--headless"];
    if (spec.testFiles && spec.testFiles.length > 0) {
      // Agent gives paths like "cypress-tests/cypress/e2e/..." but our cwd
      // is already cypress-tests/, so strip the prefix if present.
      const specs = spec.testFiles.map((f) =>
        f.startsWith("cypress-tests/") ? f.slice("cypress-tests/".length) : f,
      );
      args.push("--spec", specs.join(","));
    }
    cwd = cypressDir;
    env = {
      ...process.env,
      // Cypress reads these from env (cypress.env.json has empty defaults)
      CYPRESS_HYPERSWITCH_PUBLISHABLE_KEY:
        process.env.HYPERSWITCH_PUBLISHABLE_KEY ?? "",
      CYPRESS_HYPERSWITCH_SECRET_KEY:
        process.env.HYPERSWITCH_SECRET_KEY ?? "",
      // Headless Chrome flags for CI-like environment
      ELECTRON_EXTRA_LAUNCH_ARGS: "--disable-gpu --no-sandbox",
    };
  } else {
    // Mobile — Detox. The `--reuse` flag is critical: without it, Detox
    // tries to boot a fresh emulator for each test suite, which crashes on
    // this headless Linux box (no Qt/X display). With --reuse, Detox
    // attaches to whatever emulator is already connected via adb.
    cmd = "npx";
    args = [
      "detox",
      "test",
      "--configuration",
      "android.emu.debug",
      "--reuse",
      "--headless",
      "--loglevel",
      "info",
    ];
    if (spec.testFiles && spec.testFiles.length > 0) {
      // Detox accepts test file paths after --
      args.push("--", ...spec.testFiles);
    }
    cwd = repoDir;
    env = { ...process.env };
  }

  onChunk({
    type: "log",
    line: `Running: ${cmd} ${args.join(" ")} (cwd: ${path.basename(cwd)})`,
  });

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const timer = setTimeout(() => {
      onChunk({ type: "log", line: "Test run timed out (10 min) — killing" });
      try { proc.kill("SIGKILL"); } catch { /* */ }
    }, 600_000);

    proc.stdout.on("data", (raw) => {
      for (const line of raw.toString().split("\n")) {
        if (line.trim()) onChunk({ type: "log", line: line.trimEnd() });
      }
    });
    proc.stderr.on("data", (raw) => {
      for (const line of raw.toString().split("\n")) {
        if (line.trim()) onChunk({ type: "log", line: `[stderr] ${line.trimEnd()}` });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      onChunk({ type: "error", error: err.message });
      onChunk({ type: "done" });
      resolve();
    });

    proc.on("exit", async (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      onChunk({
        type: "result",
        exitCode,
        success: exitCode === 0,
      });

      // Reset to main so the workspace isn't stuck on the test branch
      try {
        await forceCheckoutBranch(repoDir, repoKey, "main");
      } catch { /* best effort */ }

      onChunk({ type: "done" });
      resolve();
    });
  });
}
