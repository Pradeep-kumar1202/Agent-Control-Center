/**
 * ws-scrcpy sidecar lifecycle.
 *
 * ws-scrcpy is a Node app that runs scrcpy against a connected adb device
 * and streams its display as H.264 over a websocket, with touch/keyboard
 * input flowing back through the same channel. We run it as a long-lived
 * sidecar process on `WS_SCRCPY_PORT` (default 8000) and iframe its index
 * page from the preview drawer.
 *
 * Why sidecar instead of in-process:
 * - ws-scrcpy is a full Express app with its own websocket server, adbkit
 *   client, and static asset pipeline. Bundling it into our server would
 *   fight every abstraction it already owns.
 * - It was unpublished from npm; we run the git clone from `tools/ws-scrcpy`
 *   directly via its built `dist/index.js` entrypoint.
 * - Lifecycle is simple: start on first android-preview request, keep alive
 *   across previews, tear down on server shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";

const WS_SCRCPY_PORT = Number(process.env.WS_SCRCPY_PORT ?? 8000);
const WS_SCRCPY_DIR = path.join(PROJECT_ROOT, "tools", "ws-scrcpy", "dist");
const READY_TIMEOUT_MS = 30_000;

let proc: ChildProcess | null = null;
let starting: Promise<void> | null = null;

interface WsScrcpyInfo {
  running: boolean;
  port: number;
  url: string;
  pid?: number;
}

export function wsScrcpyInfo(): WsScrcpyInfo {
  return {
    running: proc !== null && proc.exitCode === null,
    port: WS_SCRCPY_PORT,
    url: `http://localhost:${WS_SCRCPY_PORT}/`,
    pid: proc?.pid,
  };
}

async function pingPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 1500 },
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

/**
 * Ensure ws-scrcpy is up and listening. Idempotent — subsequent calls while
 * a start is in flight await the same promise. Resolves once the http
 * endpoint is reachable.
 */
export async function ensureWsScrcpy(): Promise<WsScrcpyInfo> {
  if (proc && proc.exitCode === null) return wsScrcpyInfo();
  if (starting) {
    await starting;
    return wsScrcpyInfo();
  }

  starting = (async () => {
    // Pre-check: something else may already be bound to the port (e.g. a
    // test run earlier in this session). If so, just use it.
    if (await pingPort(WS_SCRCPY_PORT)) {
      console.log(`[ws-scrcpy] port ${WS_SCRCPY_PORT} already serving — reusing`);
      return;
    }

    console.log(`[ws-scrcpy] starting sidecar on port ${WS_SCRCPY_PORT}`);
    proc = spawn("node", ["index.js"], {
      cwd: WS_SCRCPY_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(WS_SCRCPY_PORT) },
    });

    proc.stdout?.on("data", (b) => {
      const s = b.toString().trim();
      if (s) console.log(`[ws-scrcpy] ${s}`);
    });
    proc.stderr?.on("data", (b) => {
      const s = b.toString().trim();
      if (s) console.error(`[ws-scrcpy!] ${s}`);
    });
    proc.on("exit", (code, signal) => {
      console.log(`[ws-scrcpy] exited code=${code} signal=${signal}`);
      proc = null;
    });

    // Wait until the port is serving.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await pingPort(WS_SCRCPY_PORT)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `ws-scrcpy did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
  return wsScrcpyInfo();
}

export async function stopWsScrcpy(): Promise<void> {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  try {
    // Detached → kill the whole process group.
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch { /* */ }
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (proc && proc.exitCode === null && proc.pid) {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { /* */ }
  }
  proc = null;
}
