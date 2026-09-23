import { Router } from "express";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { REPOS, type RepoKey } from "../config.js";
import {
  startPreview,
  stopPreview,
  getPreview,
  getPreviewLogs,
  forceRestartMetro,
  type PreviewKind,
} from "../skills/previewManager.js";
import { BranchGoneError } from "../skills/submoduleGit.js";
import { ensureWsScrcpy, wsScrcpyInfo } from "../skills/wsScrcpyManager.js";
import {
  getCredentials,
  getMockServerState,
  setCredentials,
  setPaymentIntentBody,
  startMockServer,
  stopMockServer,
  tailMockServerLogs,
  type Credentials,
} from "../skills/embeddedMockServer.js";
import { db, type GapRow, type PatchRow } from "../db.js";
import { askStream, type StreamChunk } from "../llm.js";
import { forceCheckoutBranch } from "../skills/submoduleGit.js";
import { withRepoLock } from "../workspace/mutex.js";

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
    if (err instanceof BranchGoneError) {
      // 409 Conflict — the client's understanding of the server state
      // (patch row says this branch is valid) is stale. Dashboard reacts
      // by marking the row and prompting regeneration.
      return res.status(409).json({
        error: "branch_gone",
        code: "BRANCH_GONE",
        branch: err.branch,
        repo: err.repo,
        message: err.message,
      });
    }
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

// ─── Mock merchant server lifecycle (embedded on port 5252) ───────────────────
//
// Registered BEFORE the generic `/preview/:repoKey` route so that
// `/preview/mock-server` doesn't get parsed as a repoKey param.

previewRouter.get("/preview/mock-server", (_req, res) => {
  res.json(getMockServerState());
});

previewRouter.post("/preview/mock-server/start", async (_req, res) => {
  try {
    const state = await startMockServer();
    res.json(state);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

previewRouter.post("/preview/mock-server/stop", async (_req, res) => {
  try {
    const state = await stopMockServer();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

previewRouter.post("/preview/mock-server/config", (req, res) => {
  const body = req.body?.paymentIntentBody;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "paymentIntentBody must be a JSON object" });
  }
  setPaymentIntentBody(body as Record<string, unknown>);
  res.json(getMockServerState());
});

previewRouter.get("/preview/mock-server/logs", (req, res) => {
  const since = Number(req.query.since ?? 0);
  res.json(tailMockServerLogs(Number.isFinite(since) ? since : 0));
});

// Hyperswitch credentials (UI-overridable at runtime). Returns the resolved
// values (UI override OR .env fallback) plus a flag per field so the UI
// knows whether each came from an override vs. the environment.
previewRouter.get("/preview/mock-server/credentials", (_req, res) => {
  res.json(getCredentials());
});

previewRouter.post("/preview/mock-server/credentials", (req, res) => {
  const allowed: Array<keyof Credentials> = [
    "publishableKey",
    "secretKey",
    "profileId",
    "netceteraApiKey",
    "baseUrl",
  ];
  const patch: Partial<Credentials> = {};
  for (const k of allowed) {
    const v = req.body?.[k];
    if (typeof v === "string") patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "no valid credential fields in body" });
  }
  res.json(setCredentials(patch));
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
function runAdb(args: string[]): Promise<void> {
  const adb = path.join(ANDROID_HOME, "platform-tools", "adb");
  return new Promise((resolve, reject) => {
    const p = spawn(adb, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `adb exited ${code}`));
    });
  });
}

function runReBuild(repoDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
}

/**
 * The bulletproof-apply sequence used by both the manual Recompile button and
 * the "Test in demo app" flow. Throws with { phase } embedded in the message
 * so the caller can surface which step failed.
 *
 * Order matters: force-stop BEFORE killing Metro so the user doesn't see a
 * red "unable to connect" flash mid-process.
 */
async function recompileMobileDemo(): Promise<{ buildLog: string }> {
  const repoDir = REPOS.mobile.dir;
  const buildLog = await runReBuild(repoDir);
  try { await runAdb(["shell", "am", "force-stop", "io.hyperswitch.demoapp"]); } catch { /* non-fatal */ }
  await forceRestartMetro(repoDir);
  await runAdb(["shell", "am", "start", "-n", "io.hyperswitch.demoapp/.MainActivity"]);
  return { buildLog };
}

previewRouter.post("/preview/mobile/recompile", (_req, res) => {
  (async () => {
    try {
      const { buildLog } = await recompileMobileDemo();
      res.json({ ok: true, log: buildLog.split("\n").slice(-10).join("\n") });
    } catch (err) {
      const e = err as Error & { log?: string };
      if (res.headersSent) return;
      res.status(e.log ? 422 : 500).json({
        error: e.message,
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

/**
 * "Test in demo app" — streaming NDJSON endpoint.
 *
 * Called when the user in the preview chat asks to try the patched feature
 * visually. Checks out the patch branch, then runs an agent that edits
 * android/demo-app/.../MainActivity.kt `getCustomisations()` (and the iOS
 * ViewController if applicable) to exercise the new prop with a demonstrative
 * value. After the agent returns, the server runs the same 4-step rebuild as
 * /preview/mobile/recompile so the running emulator reflects the change.
 *
 * Does NOT commit or push — pure local edits on the patch branch. The patch
 * agent's "commit your changes" requirement (from chat.ts) means the demo-app
 * edits also get committed when the preview chat continues after this.
 */
previewRouter.post("/preview/test-feature/:patchId", async (req, res) => {
  const patchId = Number(req.params.patchId);
  if (!Number.isFinite(patchId)) {
    return res.status(400).json({ error: "bad patchId" });
  }

  const patch = db.prepare("SELECT * FROM patches WHERE id = ?").get(patchId) as PatchRow | undefined;
  if (!patch) return res.status(404).json({ error: "patch not found" });
  if (patch.repo !== "mobile") {
    return res.status(400).json({ error: "test-feature is only supported for mobile patches" });
  }
  const gap = db.prepare("SELECT * FROM gaps WHERE id = ?").get(patch.gap_id) as GapRow | undefined;
  if (!gap) return res.status(404).json({ error: "gap not found" });

  const targetRepo: RepoKey = "mobile";
  const targetDir = REPOS[targetRepo].dir;

  let diffText = "";
  try { diffText = fs.readFileSync(patch.diff_path, "utf8"); } catch { /* */ }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;
  const abortController = new AbortController();
  res.on("close", () => {
    clientClosed = true;
    abortController.abort();
  });

  const writeLine = (obj: unknown) => {
    if (clientClosed || res.writableEnded) return;
    try { res.write(JSON.stringify(obj) + "\n"); } catch { /* */ }
  };

  const truncatedDiff = diffText.length > 6000
    ? diffText.slice(0, 3000) + "\n\n… [truncated — use Read/Grep for full context] …\n\n" + diffText.slice(-3000)
    : diffText;

  try {
    await withRepoLock(targetRepo, async () => {
      writeLine({ type: "phase_marker", phase: "checkout" });
      await forceCheckoutBranch(targetDir, targetRepo, patch.branch);

      writeLine({ type: "phase_marker", phase: "editing_demo_app" });

      const prompt = `You are exercising a just-patched SDK feature in the hyperswitch-client-core demo app so the developer can visually verify it on the running Android emulator.

## What was patched (branch: ${patch.branch})

Gap: ${gap.canonical_name} (category: ${gap.category})

Diff:
\`\`\`
${truncatedDiff || "(diff file missing — Read the branch to find the new field)"}
\`\`\`

## Your job

1. Read the diff above to identify:
   - The new field added to a record in \`src/types/SdkTypes.res\` (if any).
   - The matching Kotlin field added to \`android/hyperswitch-sdk-android-api/.../PaymentSheet.kt\` Configuration.Builder (if any).
   - The matching Swift property added to the iOS Configuration (if any).

2. Edit \`android/demo-app/src/main/kotlin/io/hyperswitch/demoapp/MainActivity.kt\` — find \`getCustomisations()\` (or equivalent function that constructs \`PaymentSheet.Configuration\`) and add a call to the new Builder method with a concrete demonstrative value. Pick a value that will be visually obvious in the payment sheet so the developer can confirm the feature works.

3. If an iOS demo file exists at \`ios/.../ViewController.swift\` AND the Swift wrapper was updated, mirror the change there on \`configuration\`.

4. Run \`npm run --silent re:build\` via Bash (timeout: 240000). Must exit 0.

5. Do NOT commit. Do NOT touch any ReScript or wrapper files — only the demo-app entry points.

## ⛔ REQUIRED: Report the expected visual behaviour

After the build passes, your final text output MUST explain, in plain language, exactly what the developer should see on the running emulator because of the demo-app values you chose. Be concrete and per-setting — the developer can't infer it from the diff. Example shape:

  "I set \`paymentMethodOrder = [\"card\", \"upi\", \"wallet\"]\` — card will now appear FIRST in the payment sheet, then UPI, then the wallet group. Previously the default ordering put UPI above card."
  "I set \`displaySavedPaymentMethods = true\` — the 'Saved payment methods' section should now render above the 'Add new' card form. If displaySavedPaymentMethodsCheckbox is also true, a 'Save for future payments' checkbox appears under the card form."
  "I set \`primaryButtonLabel = \"Pay now\"\` — the bottom CTA that normally reads \"Pay $X\" should now read \"Pay now\" instead."

For every prop you touched:
  - Say WHAT you set it to.
  - Say WHAT should visibly change on screen (position, label text, visibility, order, colour — whatever is observable).
  - If the feature has branching behaviour (e.g. different values produce different UIs), describe all relevant branches you exercised.
  - If the behaviour is timing-dependent (e.g. only visible on a returning-customer intent), call that out so the developer knows where to look.

Do NOT just say "wired up the new prop" or "added the field" — the developer already knows you edited MainActivity.kt. They need to know what the emulator screen will now show that it didn't before.

Do NOT run adb, do NOT restart Metro — the server handles that after you exit.`;

      await askStream(
        prompt,
        {
          model: "opus",
          cwd: targetDir,
          allowedTools: ["Read", "Edit", "Glob", "Grep", "Bash"],
          timeoutMs: 900_000,
          signal: abortController.signal,
        },
        (chunk: StreamChunk) => writeLine(chunk),
      );

      if (clientClosed) return;

      writeLine({ type: "phase_marker", phase: "recompile" });
      try {
        const { buildLog } = await recompileMobileDemo();
        writeLine({ type: "recompile_done", buildLogTail: buildLog.split("\n").slice(-10).join("\n") });
      } catch (err) {
        const e = err as Error & { log?: string };
        writeLine({
          type: "error",
          error: `Recompile failed: ${e.message}`,
          buildLogTail: e.log ? e.log.split("\n").slice(-40).join("\n") : undefined,
        });
      }
    });
  } catch (err) {
    writeLine({ type: "error", error: (err as Error).message });
  } finally {
    if (!clientClosed) {
      writeLine({ type: "done" });
      res.end();
    }
  }
});
