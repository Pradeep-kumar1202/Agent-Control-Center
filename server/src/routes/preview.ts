import { Router } from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import type { RepoKey } from "../config.js";
import {
  startPreview,
  stopPreview,
  getPreview,
  getPreviewLogs,
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
 * Re-launch the hyperswitch demo app on the emulator. Useful when the user
 * has navigated to the launcher (or pressed Home in the drawer) and wants
 * to get back into the app without restarting the whole preview.
 */
previewRouter.post("/preview/mobile/launch-app", (_req, res) => {
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  const proc = spawn(
    adb,
    ["shell", "am", "start", "-n", "io.hyperswitch.demoapp/.MainActivity"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (b) => (stderr += b.toString()));
  proc.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  proc.on("exit", (code) => {
    if (res.headersSent) return;
    if (code === 0) res.json({ ok: true });
    else res.status(503).json({ error: stderr.trim() || `adb exited ${code}` });
  });
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
