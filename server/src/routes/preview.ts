import { Router } from "express";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { REPOS, type RepoKey } from "../config.js";
import {
  startPreview,
  stopPreview,
  getPreview,
  getPreviewLogs,
  forceRestartMetro,
  type PreviewKind,
} from "../skills/previewManager.js";
import { ensureWsScrcpy, wsScrcpyInfo } from "../skills/wsScrcpyManager.js";

const ANDROID_HOME = process.env.ANDROID_HOME ?? "/home/sdk/android-sdk";

export const previewRouter = Router();

const VALID_REPOS: RepoKey[] = ["web", "mobile"];
const VALID_KINDS: PreviewKind[] = ["web-dev", "android-emulator"];

function parseRepoKey(value: unknown): RepoKey | null {
  return typeof value === "string" && (VALID_REPOS as string[]).includes(value)
    ? (value as RepoKey)
    : null;
}

previewRouter.post("/preview/start", async (req, res) => {
  const repoKey = parseRepoKey(req.body?.repoKey);
  const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
  const kind = req.body?.kind as PreviewKind | undefined;

  if (!repoKey) return res.status(400).json({ error: "invalid repoKey" });
  if (!branch) return res.status(400).json({ error: "missing branch" });
  if (!kind || !VALID_KINDS.includes(kind)) {
    return res.status(400).json({ error: "invalid kind" });
  }

  try {
    const state = await startPreview(repoKey, branch, kind);
    res.json(state);
  } catch (err) {
    console.error("[preview] start failed:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

previewRouter.post("/preview/stop", async (req, res) => {
  const repoKey = parseRepoKey(req.body?.repoKey);
  if (!repoKey) return res.status(400).json({ error: "invalid repoKey" });
  const state = await stopPreview(repoKey);
  res.json({ stopped: state !== null, state });
});

previewRouter.get("/preview/:repoKey", (req, res) => {
  const repoKey = parseRepoKey(req.params.repoKey);
  if (!repoKey) return res.status(400).json({ error: "invalid repoKey" });
  res.json(getPreview(repoKey));
});

previewRouter.get("/preview/:repoKey/logs", (req, res) => {
  const repoKey = parseRepoKey(req.params.repoKey);
  if (!repoKey) return res.status(400).json({ error: "invalid repoKey" });
  const since = Number(req.query.since ?? 0);
  res.json(getPreviewLogs(repoKey, Number.isFinite(since) ? since : 0));
});

/**
 * Stream a single PNG screenshot of the running Android emulator.
 *
 * `adb exec-out screencap -p` writes a PNG to stdout (no shell wrapping, no
 * line-ending mangling — that's why it's exec-out, not shell). We pipe it
 * straight into the response. The drawer polls this every ~500 ms with a
 * cache-busting query param to give a low-fps preview.
 *
 * Intentionally not interactive — view-only is enough for "see the visual
 * effect". If we ever need touch input, ws-scrcpy or scrcpy-ws would be the
 * next step.
 */
/**
 * Send a tap event to the running Android emulator. Used by the drawer's
 * click-through interaction so the user can navigate the demo app from the
 * dashboard. Coordinates are in emulator pixels (the drawer is responsible
 * for mapping click-position-in-image to screen-pixels via the image's
 * naturalWidth/naturalHeight, which match the device resolution).
 */
previewRouter.post("/preview/mobile/tap", (req, res) => {
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return res.status(400).json({ error: "x and y must be non-negative numbers" });
  }
  console.log(`[preview tap] adb input tap ${Math.round(x)} ${Math.round(y)}`);
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  const proc = spawn(adb, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b.toString()));
  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("exit", (code) => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true, x: Math.round(x), y: Math.round(y) });
    else res.status(503).json({ error: stderr.trim() || `adb exited ${code}` });
  });
});

/**
 * Ask Metro to broadcast a reload command to every connected client.
 * Equivalent to pressing `R` twice or tapping "Reload" in the RN dev menu —
 * the running app re-fetches its JS bundle from Metro without reinstalling
 * the APK. Used during a chat-agent iteration when the agent has just
 * edited .res files and re-run `npm run re:build`; Metro already has the
 * new bundle but the app is still running the old one.
 */
previewRouter.post("/preview/mobile/metro-reload", (_req, res) => {
  const req = http.request(
    { host: "127.0.0.1", port: 8081, path: "/reload", method: "POST", timeout: 3000 },
    (r) => {
      let body = "";
      r.on("data", (c) => (body += c.toString()));
      r.on("end", () => {
        if ((r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300) {
          res.json({ ok: true, metro: body.trim() || "OK" });
        } else {
          res.status(503).json({ error: `metro returned ${r.statusCode}: ${body.slice(0, 200)}` });
        }
      });
    },
  );
  req.on("error", (err) => {
    if (!res.headersSent) res.status(503).json({ error: err.message });
  });
  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) res.status(504).json({ error: "metro /reload timed out" });
  });
  req.end();
});

/**
 * The "bulletproof apply" button. Does the full sequence end-to-end,
 * blocking until the app is visibly running the fresh bundle:
 *
 *   1. yarn re:build                             (~1-3s)
 *   2. adb am force-stop io.hyperswitch.demoapp  (~0.3s) — frees the app's
 *      in-memory JS context. WITHOUT this, the running VM keeps the old
 *      bundle around forever.
 *   3. forceRestartMetro                         (~5-8s) — kill + respawn
 *      with --reset-cache so the haste-map is rebuilt from scratch and
 *      any .bs.js the agent just wrote is picked up even if the watcher
 *      missed it.
 *   4. adb am start .../MainActivity             (~0.5s) — cold launch of
 *      the app, which reconnects to fresh Metro and fetches the fresh
 *      bundle.
 *
 * Total: ~8-12 s. Client UI shows a spinner the whole time. Blocking
 * response so the frontend only un-busys when the app is actually back.
 *
 * Order matters: force-stop BEFORE killing Metro, so the user doesn't
 * see a red "unable to connect" flash mid-process.
 */
previewRouter.post("/preview/mobile/recompile", (_req, res) => {
  const repoDir = REPOS.mobile.dir;
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");

  const runAdb = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = spawn(adb, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (b) => (stderr += b.toString()));
      p.on("error", reject);
      p.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `adb exited ${code}`));
      });
    });

  const runReBuild = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const proc = spawn("npm", ["run", "--silent", "re:build"], {
        cwd: repoDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      let log = "";
      proc.stdout.on("data", (b) => (log += b.toString()));
      proc.stderr.on("data", (b) => (log += b.toString()));
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* */ }
        reject(new Error("re:build timed out"));
      }, 240_000);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(log);
        else {
          const err = new Error(`re:build exited with code ${code}`);
          (err as Error & { log?: string }).log = log;
          reject(err);
        }
      });
    });

  (async () => {
    let phase = "re:build";
    try {
      console.log("[recompile] phase 1/4: re:build");
      const buildLog = await runReBuild();

      phase = "force-stop";
      console.log("[recompile] phase 2/4: force-stop app");
      try { await runAdb(["shell", "am", "force-stop", "io.hyperswitch.demoapp"]); } catch { /* non-fatal */ }

      phase = "metro restart";
      console.log("[recompile] phase 3/4: restart Metro with --reset-cache");
      await forceRestartMetro(repoDir);

      phase = "relaunch";
      console.log("[recompile] phase 4/4: launch app fresh");
      await runAdb(["shell", "am", "start", "-n", "io.hyperswitch.demoapp/.MainActivity"]);

      console.log("[recompile] done");
      res.json({
        ok: true,
        log: buildLog.split("\n").slice(-10).join("\n"),
      });
    } catch (err) {
      const e = err as Error & { log?: string };
      if (res.headersSent) return;
      res.status(phase === "re:build" ? 422 : 500).json({
        error: `${phase} failed: ${e.message}`,
        log: e.log ? e.log.split("\n").slice(-40).join("\n") : undefined,
      });
    }
  })();
});

/**
 * Re-launch the hyperswitch demo app on the emulator: force-stop, then
 * am start. Force-stop is critical — `am start` on an already-running
 * activity just brings it to foreground without killing the process, so
 * the JS bundle the app already loaded stays in memory. Force-stop kills
 * the whole process group, so the subsequent am start causes a cold
 * launch that re-fetches the bundle from Metro.
 */
previewRouter.post("/preview/mobile/launch-app", (_req, res) => {
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  const runAdb = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = spawn(adb, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (b) => (stderr += b.toString()));
      p.on("error", reject);
      p.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `adb exited ${code}`));
      });
    });
  (async () => {
    try {
      await runAdb(["shell", "am", "force-stop", "io.hyperswitch.demoapp"]);
      await runAdb(["shell", "am", "start", "-n", "io.hyperswitch.demoapp/.MainActivity"]);
      res.json({ ok: true });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
    }
  })();
});

/**
 * Send a key event (KEYCODE_BACK, KEYCODE_HOME, etc.) to the emulator.
 * Used for the drawer's Back/Home buttons since the user can't reach the
 * device's gesture nav from a screenshot stream.
 */
previewRouter.post("/preview/mobile/key", (req, res) => {
  const keycode = String(req.body?.keycode ?? "").toUpperCase();
  // Whitelist of safe input keycodes — don't accept arbitrary strings.
  const ALLOWED = new Set(["KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_APP_SWITCH", "KEYCODE_MENU", "KEYCODE_ENTER"]);
  if (!ALLOWED.has(keycode)) {
    return res.status(400).json({ error: `keycode must be one of ${[...ALLOWED].join(", ")}` });
  }
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  const proc = spawn(adb, ["shell", "input", "keyevent", keycode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("exit", (code) => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true, keycode });
    else res.status(503).json({ error: `adb exited ${code}` });
  });
});

/**
 * Return the iframe URL for the ws-scrcpy mirror, bringing the sidecar up
 * on demand if it isn't already running. The drawer calls this once the
 * android preview reaches "ready" state. The returned URL goes straight
 * into an iframe; ws-scrcpy renders its own device-picker UI and the user
 * clicks the MSE stream button on the emulator card.
 *
 * Note: the iframe host must be reachable from the user's browser, which
 * on this shared box is via Tailscale/VPN. The URL uses `window.location`
 * hostname rewriting on the client side, so we return a relative-host
 * hint and let the drawer swap in the current host.
 */
previewRouter.get("/preview/mobile/mirror-url", async (_req, res) => {
  try {
    const info = await ensureWsScrcpy();
    res.json({ url: info.url, port: info.port, running: info.running });
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

previewRouter.get("/preview/mobile/mirror-status", (_req, res) => {
  res.json(wsScrcpyInfo());
});

previewRouter.get("/preview/mobile/screenshot", (_req, res) => {
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  const proc = spawn(adb, ["exec-out", "screencap", "-p"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b.toString()));
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  proc.stdout.pipe(res);
  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("exit", (code) => {
    if (code !== 0 && !res.headersSent) {
      res.status(503).json({ error: stderr.trim() || `adb exited ${code}` });
    }
  });
});
