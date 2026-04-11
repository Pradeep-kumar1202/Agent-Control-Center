/**
 * Preview Manager — owns the lifecycle of dev-server processes for demo videos.
 *
 * One slot per repo (web, mobile). Starting a new preview on a repo stops the
 * previous one first. Spawned in a process group so we can kill webpack workers
 * and gradle daemons cleanly with a single signal.
 *
 * The preview manager always goes through forceCheckoutBranch() from
 * submoduleGit.ts so it inherits the same submodule-safe checkout that the
 * patch generator uses.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { REPOS, type RepoKey } from "../config.js";
import { forceCheckoutBranch } from "./submoduleGit.js";
import { ensureWsScrcpy, stopWsScrcpy } from "./wsScrcpyManager.js";

export type PreviewKind = "web-dev" | "android-emulator";
export type PreviewStatus = "starting" | "ready" | "failed" | "stopped";

export interface PreviewState {
  repoKey: RepoKey;
  kind: PreviewKind;
  branch: string;
  status: PreviewStatus;
  url?: string;
  pid?: number;
  startedAt: number;
  readyAt?: number;
  error?: string;
}

interface PreviewSlot extends PreviewState {
  proc?: ChildProcess;
  logs: string[]; // ring buffer
}

const LOG_RING_SIZE = 200;
const WEB_PORT = 9050;
const WEB_READY_TIMEOUT_MS = 120_000;
const ANDROID_READY_TIMEOUT_MS = 600_000;
const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
const PREVIEW_AVD = process.env.PREVIEW_AVD ?? "Medium_Phone";
const ANDROID_HOME = process.env.ANDROID_HOME ?? "/home/sdk/android-sdk";

const slots = new Map<RepoKey, PreviewSlot>();

// The emulator is intentionally module-scoped so it survives across previews
// — booting an AVD takes ~30s and we don't want to pay that on every patch.
let emulatorProc: ChildProcess | null = null;

function pushLog(slot: PreviewSlot, chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (!line) continue;
    slot.logs.push(line);
    if (slot.logs.length > LOG_RING_SIZE) slot.logs.shift();
  }
}

function publicState(slot: PreviewSlot): PreviewState {
  const { proc: _proc, logs: _logs, ...state } = slot;
  return state;
}

function adbPath(): string {
  return path.join(ANDROID_HOME, "platform-tools", "adb");
}

function emulatorBin(): string {
  return path.join(ANDROID_HOME, "emulator", "emulator");
}

/** True if `adb devices` lists at least one line that ends in "device". */
function hasReadyDevice(): boolean {
  try {
    const out = spawnSync(adbPath(), ["devices"], { encoding: "utf8" });
    if (out.status !== 0) return false;
    return out.stdout
      .split("\n")
      .slice(1)
      .some((line) => /\sdevice$/.test(line.trim()));
  } catch {
    return false;
  }
}

/**
 * Make sure an Android device is online before we hand off to react-native.
 *
 * On a Mac, opening Android Studio sidesteps this for free — it boots an AVD
 * and starts adb-server in the background. On the headless Linux box this
 * dashboard runs on, neither happens automatically, so `npm run android`
 * exits 1 the instant `react-native run-android` calls `adb devices` and
 * sees nothing connected.
 *
 * If a device is already connected, this is a no-op (so the user's own
 * scrcpy/Android Studio session keeps working). Otherwise we start the
 * emulator headless and block until `sys.boot_completed=1`.
 */
async function prepareAndroidDevice(slot: PreviewSlot): Promise<void> {
  // Best-effort: idempotent.
  spawnSync(adbPath(), ["start-server"], { stdio: "ignore" });

  if (hasReadyDevice()) {
    pushLog(slot, `[emulator] device already connected, skipping boot`);
    return;
  }

  // Reuse an emulator we previously spawned if it's still alive.
  if (emulatorProc && emulatorProc.exitCode === null) {
    pushLog(slot, `[emulator] reusing existing emulator pid=${emulatorProc.pid}`);
  } else {
    pushLog(slot, `[emulator] booting AVD ${PREVIEW_AVD} headless`);
    emulatorProc = spawn(
      emulatorBin(),
      [
        "-avd",
        PREVIEW_AVD,
        "-no-window",
        "-no-audio",
        "-no-snapshot-save",
        "-no-boot-anim",
        "-gpu",
        "swiftshader_indirect",
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME },
      },
    );
    emulatorProc.stdout?.on("data", (b) => pushLog(slot, `[emulator] ${b.toString().trim()}`));
    emulatorProc.stderr?.on("data", (b) => pushLog(slot, `[emulator] ${b.toString().trim()}`));
    emulatorProc.on("exit", (code, signal) => {
      pushLog(slot, `[emulator] exited code=${code} signal=${signal}`);
      emulatorProc = null;
    });
  }

  // Block until adb sees the device AND it reports sys.boot_completed=1.
  const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasReadyDevice()) {
      const boot = spawnSync(
        adbPath(),
        ["shell", "getprop", "sys.boot_completed"],
        { encoding: "utf8" },
      );
      if (boot.status === 0 && boot.stdout.trim() === "1") {
        pushLog(slot, `[emulator] boot completed`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `emulator failed to reach sys.boot_completed=1 within ${EMULATOR_BOOT_TIMEOUT_MS / 1000}s`,
  );
}

async function pingWebPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) > 0);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function startPreview(
  repoKey: RepoKey,
  branch: string,
  kind: PreviewKind,
): Promise<PreviewState> {
  // Stop any preview already running for this repo.
  if (slots.has(repoKey)) {
    await stopPreview(repoKey);
  }

  const repoDir = REPOS[repoKey].dir;

  // Reset submodules + force-checkout the feature branch via the shared helper.
  await forceCheckoutBranch(repoDir, repoKey, branch);

  // Create the slot up front so the emulator boot logs and any boot errors
  // land in the same ring buffer the UI is already polling.
  const slot: PreviewSlot = {
    repoKey,
    kind,
    branch,
    status: "starting",
    startedAt: Date.now(),
    logs: [],
  };
  slots.set(repoKey, slot);

  if (kind === "android-emulator") {
    try {
      await prepareAndroidDevice(slot);
    } catch (err) {
      slot.status = "failed";
      slot.error = `emulator did not boot: ${(err as Error).message}`;
      return publicState(slot);
    }
    // Bring up the ws-scrcpy sidecar so the drawer can iframe its UI the
    // moment the APK finishes installing. Fire-and-forget — if it fails the
    // preview still works, just without live mirroring.
    void ensureWsScrcpy().catch((e) =>
      pushLog(slot, `[ws-scrcpy] failed to start: ${(e as Error).message}`),
    );
  }

  const cmd = "npm";
  const args = kind === "web-dev" ? ["start"] : ["run", "android"];

  const proc = spawn(cmd, args, {
    cwd: repoDir,
    detached: true, // own process group so we can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME },
  });

  slot.proc = proc;
  slot.pid = proc.pid;

  proc.stdout?.on("data", (b) => pushLog(slot, b.toString()));
  proc.stderr?.on("data", (b) => pushLog(slot, b.toString()));

  proc.on("exit", (code, signal) => {
    if (slot.status === "starting") {
      // Special case for android: `npm run android` is install+launch, not
      // a long-running process. A clean exit (code 0) after BUILD SUCCESSFUL
      // is the success case — the APK is installed and the activity is
      // running on the emulator. Without this branch the watcher's 1.5s
      // poll loses to the exit handler and we mark a successful run as
      // failed (race we hit on a 6s gradle build).
      const tail = slot.logs.join("\n");
      const androidLaunched =
        kind === "android-emulator" &&
        code === 0 &&
        /BUILD SUCCESSFUL/i.test(tail) &&
        /Starting:\s+Intent|Installed on \d+ device/i.test(tail);
      if (androidLaunched) {
        slot.status = "ready";
        slot.readyAt = Date.now();
        return;
      }
      slot.status = "failed";
      const hint =
        kind === "android-emulator"
          ? " — check the logs above for gradle/RN errors (the emulator booted fine)"
          : "";
      slot.error = `process exited (code=${code}, signal=${signal}) before becoming ready${hint}`;
    } else if (slot.status === "ready") {
      slot.status = "stopped";
    }
  });

  // Background readiness watcher.
  void watchForReady(slot);

  return publicState(slot);
}

async function watchForReady(slot: PreviewSlot): Promise<void> {
  const timeoutMs =
    slot.kind === "web-dev" ? WEB_READY_TIMEOUT_MS : ANDROID_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const webReadyRegex = /compiled\s+successfully|webpack\s+\d+\.\d+\.\d+\s+compiled/i;
  const androidReadyRegex = /BUILD SUCCESSFUL/i;

  while (Date.now() < deadline) {
    if (slot.status !== "starting") return;
    const tail = slot.logs.join("\n");

    if (slot.kind === "web-dev") {
      if (webReadyRegex.test(tail) || (await pingWebPort(WEB_PORT))) {
        slot.status = "ready";
        slot.readyAt = Date.now();
        slot.url = `http://localhost:${WEB_PORT}`;
        return;
      }
    } else if (slot.kind === "android-emulator") {
      if (androidReadyRegex.test(tail)) {
        slot.status = "ready";
        slot.readyAt = Date.now();
        return;
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  if (slot.status === "starting") {
    slot.status = "failed";
    slot.error = `did not become ready within ${Math.round(timeoutMs / 1000)}s`;
    // Kill the stuck process so it doesn't squat on the port.
    void killSlot(slot);
  }
}

async function killSlot(slot: PreviewSlot): Promise<void> {
  const proc = slot.proc;
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try { proc.kill("SIGTERM"); } catch { /* */ }
  }
  await new Promise((r) => setTimeout(r, 3000));
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch { /* */ }
    }
  }
}

export async function stopPreview(repoKey: RepoKey): Promise<PreviewState | null> {
  const slot = slots.get(repoKey);
  if (!slot) return null;
  await killSlot(slot);
  slot.status = "stopped";
  return publicState(slot);
}

export function getPreview(repoKey: RepoKey): PreviewState | null {
  const slot = slots.get(repoKey);
  return slot ? publicState(slot) : null;
}

export function getPreviewLogs(repoKey: RepoKey, since = 0): {
  lines: string[];
  total: number;
} {
  const slot = slots.get(repoKey);
  if (!slot) return { lines: [], total: 0 };
  const total = slot.logs.length;
  const start = Math.max(0, since);
  return { lines: slot.logs.slice(start), total };
}

/** Stop every preview — used by the server shutdown hook. */
export async function stopAllPreviews(): Promise<void> {
  await Promise.all(
    Array.from(slots.keys()).map((k) => stopPreview(k)),
  );
  // Also tear down the long-lived emulator so we don't leak it across restarts.
  if (emulatorProc && emulatorProc.exitCode === null && emulatorProc.pid) {
    try {
      process.kill(-emulatorProc.pid, "SIGTERM");
    } catch {
      try { emulatorProc.kill("SIGTERM"); } catch { /* */ }
    }
  }
  emulatorProc = null;
  // And the ws-scrcpy sidecar.
  await stopWsScrcpy();
}
