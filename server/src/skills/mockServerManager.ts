/**
 * Mock merchant server sidecar.
 *
 * `node mockServer.js` in hyperswitch-client-core is a tiny Express app
 * that answers `GET /create-payment-intent` by calling Hyperswitch sandbox
 * with a secret key and forwarding back {publishableKey, clientSecret} to
 * the demo app running in the emulator. Without it, the demo-app boots,
 * hits http://10.0.2.2:5252/create-payment-intent, times out, and shows
 * "could not connect to the server" instead of a payment sheet.
 *
 * Historically this ran as a hand-started process on the shared Linux box
 * (pid 1611775 from Apr 1, env vars set in its parent shell). That process
 * died, so the dashboard now owns its lifecycle instead. Credentials come
 * from the dashboard's .env (loaded by config.ts) and are forwarded to the
 * child via env inheritance — the mockServer itself calls dotenv but we
 * don't rely on that, we inject from our side.
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { REPOS, type RepoKey } from "../config.js";

const MOCK_SERVER_PORT = Number(process.env.MOCK_SERVER_PORT ?? 5252);
const READY_TIMEOUT_MS = 20_000;

// Re-used across previews. Like emulatorProc / metroProc, we keep this
// alive between Restart clicks because every reboot costs ~2s of launch
// overhead and nothing about a patch regeneration should force us to
// cycle the merchant server.
let proc: ChildProcess | null = null;
let repoKey: RepoKey | null = null;
let starting: Promise<void> | null = null;

export interface MockServerState {
  running: boolean;
  port: number;
  pid?: number;
  repoKey?: RepoKey;
}

export function mockServerInfo(): MockServerState {
  return {
    running: proc !== null && proc.exitCode === null,
    port: MOCK_SERVER_PORT,
    pid: proc?.pid,
    repoKey: repoKey ?? undefined,
  };
}

async function pingMockPort(): Promise<boolean> {
  return new Promise((resolve) => {
    // We don't POST to /create-payment-intent (real sandbox hit) during
    // readiness — just verify the TCP port is listening. The mock server
    // responds to anything at / with a 404 or method-not-allowed, which
    // is plenty to know the process is alive.
    const req = http.get(
      { host: "127.0.0.1", port: MOCK_SERVER_PORT, path: "/", timeout: 1200 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) > 0);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

type Logger = (line: string) => void;

/**
 * Ensure the mock merchant server is running for `forRepo`. Idempotent;
 * concurrent calls await the same start promise. If something is already
 * listening on MOCK_SERVER_PORT we assume it's the mock server and return
 * early — this covers the case where the user still has a hand-started
 * instance from before.
 */
export async function ensureMockServer(forRepo: RepoKey, log: Logger): Promise<void> {
  if (proc && proc.exitCode === null && repoKey === forRepo) return;
  if (starting) {
    await starting;
    return;
  }

  starting = (async () => {
    // Something else already serving? Just adopt it.
    if (await pingMockPort()) {
      log(`[mockserver] port ${MOCK_SERVER_PORT} already serving — reusing`);
      return;
    }

    // Repo change — stop the current one first.
    if (proc && proc.exitCode === null && proc.pid) {
      log(`[mockserver] stopping previous instance for ${repoKey}`);
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try { proc.kill("SIGTERM"); } catch { /* */ }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    const repoDir = REPOS[forRepo].dir;
    const script = path.join(repoDir, "mockServer.js");
    log(`[mockserver] starting node mockServer.js in ${path.basename(repoDir)} on ${MOCK_SERVER_PORT}`);

    // Spin up directly as `node mockServer.js` (not `npm run server`) so
    // there's no npm wrapper between us and the process group we kill.
    proc = spawn("node", [script], {
      cwd: repoDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(MOCK_SERVER_PORT),
        // mockServer.js exits with code 1 if these are missing, so make
        // sure we surface a clear error rather than a silent failure.
        HYPERSWITCH_PUBLISHABLE_KEY: process.env.HYPERSWITCH_PUBLISHABLE_KEY ?? "",
        HYPERSWITCH_SECRET_KEY: process.env.HYPERSWITCH_SECRET_KEY ?? "",
        PROFILE_ID: process.env.PROFILE_ID ?? "",
        HYPERSWITCH_SANDBOX_URL: process.env.HYPERSWITCH_SANDBOX_URL ?? "",
        HYPERSWITCH_INTEG_URL: process.env.HYPERSWITCH_INTEG_URL ?? "",
      },
    });
    repoKey = forRepo;

    proc.stdout?.on("data", (b) => log(`[mockserver] ${b.toString().trimEnd()}`));
    proc.stderr?.on("data", (b) => log(`[mockserver!] ${b.toString().trimEnd()}`));
    proc.on("exit", (code, signal) => {
      log(`[mockserver] exited code=${code} signal=${signal}`);
      proc = null;
      repoKey = null;
    });

    // Fail fast if the process immediately exits because of missing creds.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc && proc.exitCode !== null) {
        throw new Error(
          `mockServer.js exited early with code ${proc.exitCode} — check HYPERSWITCH_* env vars in feature-gap-dashboard/.env`,
        );
      }
      if (await pingMockPort()) {
        log(`[mockserver] ready on ${MOCK_SERVER_PORT}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `mockServer.js did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function stopMockServer(): Promise<void> {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch { /* */ }
  }
  await new Promise((r) => setTimeout(r, 1000));
  if (proc && proc.exitCode === null && proc.pid) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* */ }
  }
  proc = null;
  repoKey = null;
}
