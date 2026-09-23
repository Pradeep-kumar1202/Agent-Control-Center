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
import { ensureMockServer, stopMockServer } from "./mockServerManager.js";
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
const METRO_PORT = 8081;
const WEB_READY_TIMEOUT_MS = 120_000;
const ANDROID_READY_TIMEOUT_MS = 600_000;
const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
const METRO_READY_TIMEOUT_MS = 90_000;
const RESCRIPT_BUILD_TIMEOUT_MS = 240_000;
const PREVIEW_AVD = process.env.PREVIEW_AVD ?? "Pixel_9_Pro";
const ANDROID_HOME = process.env.ANDROID_HOME ?? "/home/sdk/android-sdk";
// Override defaults (6 GB RAM, 4 CPU cores). config.ini-level values get
// ignored by the emulator in a few edge cases; the CLI flags win every
// time. Env-var escape hatches in case the host is tight on memory.
const EMULATOR_MEMORY_MB = Number(process.env.PREVIEW_EMU_MEMORY_MB ?? 6144);
const EMULATOR_CORES = Number(process.env.PREVIEW_EMU_CORES ?? 4);

const slots = new Map<RepoKey, PreviewSlot>();

// The emulator is intentionally module-scoped so it survives across previews
// — booting an AVD takes ~30s and we don't want to pay that on every patch.
let emulatorProc: ChildProcess | null = null;

// Same logic for Metro (the React Native dev server). Metro is what serves
// the compiled JS bundle to the running APK via HTTP on port 8081. Without
// it, the app launches and then fails to load any JS. We keep one Metro
// alive per repo and reuse it across previews so "reload app" on the
// emulator picks up chat-agent edits without a full restart.
let metroProc: ChildProcess | null = null;
let metroRepoDir: string | null = null;
// Metro's stdout/stderr listeners are bound once at spawn time, but we
// want their output to land in the *currently active* preview slot, not
// the original slot from the first preview (which may have been destroyed
// and replaced). This ref is updated by ensureMetro on every call so
// subsequent previews keep seeing live Metro output in their log panel.
let metroActiveSlot: PreviewSlot | null = null;

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

/**
 * Run `yarn re:build` (= `rescript`) once in the repo to compile .res → .bs.js.
 * Blocks until the compile exits. Streams both stdout and stderr into the
 * slot's log buffer so the user sees it in the drawer. Not a real-time
 * watcher — just one pass. Metro handles subsequent rebuilds once the agent
 * edits files through chat + re-runs `npm run re:build` via Bash.
 */
async function buildRescript(slot: PreviewSlot, repoDir: string): Promise<void> {
  pushLog(slot, `[re:build] compiling ReScript in ${path.basename(repoDir)}…`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("npm", ["run", "--silent", "re:build"], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`re:build timed out after ${RESCRIPT_BUILD_TIMEOUT_MS / 1000}s`));
    }, RESCRIPT_BUILD_TIMEOUT_MS);
    proc.stdout?.on("data", (b) => pushLog(slot, `[re:build] ${b.toString().trimEnd()}`));
    proc.stderr?.on("data", (b) => pushLog(slot, `[re:build] ${b.toString().trimEnd()}`));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        pushLog(slot, `[re:build] finished clean`);
        resolve();
      } else {
        reject(new Error(`re:build exited with code ${code}`));
      }
    });
  });
}

/**
 * Physically remove Metro's disk caches before a fresh spawn.
 *
 * In theory `react-native start --reset-cache` wipes these. In practice
 * we've seen Metro serve stale bundles across restarts — the transform
 * cache at /tmp/metro-cache accumulates hundreds of subdirs keyed by
 * content hash, and the haste-map snapshot at /tmp/metro-file-map-* is
 * occasionally preserved across restarts. Deleting both before each
 * spawn guarantees Metro starts with zero on-disk memory.
 *
 * Safe to run while Metro is NOT running (unused files just get removed).
 * Never run while Metro IS running — you'll corrupt the live haste-map.
 */
async function nukeMetroDiskCache(log: (line: string) => void): Promise<void> {
  const fsp = await import("node:fs/promises");
  const targets = [
    "/tmp/metro-cache",
    // metro-file-map-<hash>-<another-hash> ← hashes vary per project. Use
    // a glob-ish scan so we catch all of them.
  ];
  let removed = 0;
  for (const t of targets) {
    try {
      await fsp.rm(t, { recursive: true, force: true });
      removed++;
    } catch { /* already gone */ }
  }
  try {
    const entries = await fsp.readdir("/tmp");
    for (const name of entries) {
      if (name.startsWith("metro-file-map-")) {
        try {
          await fsp.rm(`/tmp/${name}`, { force: true });
          removed++;
        } catch { /* */ }
      }
    }
  } catch { /* */ }
  log(`[metro] nuked disk cache (${removed} paths)`);
}

/**
 * Ensure Metro (the React Native dev server) is running and bound to
 * METRO_PORT for this repo. Idempotent — returns immediately if a Metro
 * for this repo is already alive. If a Metro is running for a *different*
 * repo, we tear it down first (Metro binds the port, only one at a time).
 *
 * Ready detection: ping port 8081 until it responds.
 */
async function ensureMetro(slot: PreviewSlot, repoDir: string): Promise<void> {
  // Every call routes Metro's background logs to whichever slot is the
  // caller. Without this, the stdout handler captured the first-ever slot
  // in a closure and subsequent previews never saw Metro output.
  metroActiveSlot = slot;

  // Already running for the same repo? Just check the port.
  if (metroProc && metroProc.exitCode === null && metroRepoDir === repoDir) {
    if (await pingWebPort(METRO_PORT)) {
      pushLog(slot, `[metro] reusing existing process pid=${metroProc.pid} (port ${METRO_PORT} live)`);
      return;
    }
    // Process alive but port not responding — something's wrong, kill it.
    pushLog(slot, `[metro] existing process is not responding on ${METRO_PORT}, restarting`);
    try { process.kill(-metroProc.pid!, "SIGKILL"); } catch { /* */ }
    metroProc = null;
    metroRepoDir = null;
  }

  // Different repo or not running — start fresh.
  if (metroProc && metroProc.exitCode === null) {
    pushLog(slot, `[metro] stopping existing process for ${metroRepoDir}`);
    try { process.kill(-metroProc.pid!, "SIGTERM"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 500));
    metroProc = null;
    metroRepoDir = null;
  }

  // Orphan detection: if port 8081 is already bound but `metroProc` is
  // null, it's a Metro from a previous tsx-watch iteration (our server
  // reloaded, losing the ref). Adopting it silently is WORSE than killing
  // it because the orphan's haste-map / bundle cache is frozen from
  // whenever it started — any .bs.js files written after that point won't
  // appear in its output. Kill and respawn.
  if (await pingWebPort(METRO_PORT)) {
    const owner = await findPortOwnerPid(METRO_PORT);
    pushLog(
      slot,
      `[metro] port ${METRO_PORT} is bound by an orphan (pid=${owner ?? "unknown"}) — killing for a fresh start with current .bs.js`,
    );
    if (owner) {
      try { process.kill(owner, "SIGTERM"); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 1000));
      // If it's still there, escalate.
      if (await pingWebPort(METRO_PORT)) {
        try { process.kill(owner, "SIGKILL"); } catch { /* */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // Wipe Metro's on-disk caches before spawning so --reset-cache doesn't
  // have to rely on its own invalidation (which has been unreliable in
  // practice). Only safe when Metro is *not* running — the orphan kill
  // above guarantees that.
  await nukeMetroDiskCache((line) => pushLog(slot, line));

  pushLog(slot, `[metro] starting in ${path.basename(repoDir)}`);
  const proc = spawn("npm", ["run", "start"], {
    cwd: repoDir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
  });
  metroProc = proc;
  metroRepoDir = repoDir;
  // These handlers read `metroActiveSlot` from module scope, NOT the
  // captured `slot` parameter, so they always write to the current
  // preview's log buffer — even across multiple preview runs.
  proc.stdout?.on("data", (b) => {
    if (metroActiveSlot) pushLog(metroActiveSlot, `[metro] ${b.toString().trimEnd()}`);
  });
  proc.stderr?.on("data", (b) => {
    if (metroActiveSlot) pushLog(metroActiveSlot, `[metro!] ${b.toString().trimEnd()}`);
  });
  proc.on("exit", (code, signal) => {
    if (metroActiveSlot) {
      pushLog(metroActiveSlot, `[metro] exited code=${code} signal=${signal}`);
    }
    if (metroProc === proc) {
      metroProc = null;
      metroRepoDir = null;
    }
  });

  // Wait for the port to answer.
  const deadline = Date.now() + METRO_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingWebPort(METRO_PORT)) {
      pushLog(slot, `[metro] ready on ${METRO_PORT}`);
      return;
    }
    if (proc.exitCode !== null) {
      throw new Error(`metro exited early with code ${proc.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`metro did not become ready within ${METRO_READY_TIMEOUT_MS / 1000}s`);
}

function emulatorBin(): string {
  return path.join(ANDROID_HOME, "emulator", "emulator");
}

/** True if `adb devices` lists at least one line that ends in "device". */
/**
 * Returns the serials of ALL ready ADB devices/emulators.
 */
function getReadyDeviceSerials(): string[] {
  try {
    const out = spawnSync(adbPath(), ["devices"], { encoding: "utf8" });
    if (out.status !== 0) return [];
    return out.stdout
      .split("\n")
      .slice(1)
      .filter((line) => /\sdevice$/.test(line.trim()))
      .map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

/**
 * Returns the serial of the first ready ADB device, or null if none.
 * Used when we don't need to be picky (e.g. checking if anything is online).
 */
function getReadyDeviceSerial(): string | null {
  return getReadyDeviceSerials()[0] ?? null;
}

// Serial of the emulator we are using for the current/last preview.
// Set by prepareAndroidDevice, consumed by startPreview to pass --deviceId.
let activeEmulatorSerial: string | null = null;

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

  // Check if our specific AVD (PREVIEW_AVD = e.g. Pixel_9_Pro) is already running.
  for (const serial of getReadyDeviceSerials()) {
    const avdName = spawnSync(adbPath(), ["-s", serial, "emu", "avd", "name"], { encoding: "utf8" });
    const name = avdName.stdout.split("\n")[0].trim();
    if (name === PREVIEW_AVD) {
      pushLog(slot, `[emulator] ${PREVIEW_AVD} already running on ${serial}, skipping boot`);
      activeEmulatorSerial = serial;
      return;
    }
  }

  // Reuse an emulator we previously spawned if it's still alive.
  if (emulatorProc && emulatorProc.exitCode === null) {
    pushLog(slot, `[emulator] reusing existing emulator pid=${emulatorProc.pid}`);
  } else {
    pushLog(
      slot,
      `[emulator] booting AVD ${PREVIEW_AVD} headless (memory=${EMULATOR_MEMORY_MB}MB cores=${EMULATOR_CORES})`,
    );
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
        "-memory",
        String(EMULATOR_MEMORY_MB),
        "-cores",
        String(EMULATOR_CORES),
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

  // Block until adb sees OUR AVD specifically and it reports sys.boot_completed=1.
  // We match by querying each connected emulator's AVD name so we don't
  // accidentally latch onto a Medium_Phone or any other concurrently running AVD.
  const deadline = Date.now() + EMULATOR_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const serial of getReadyDeviceSerials()) {
      const avdName = spawnSync(adbPath(), ["-s", serial, "emu", "avd", "name"], { encoding: "utf8" });
      const name = avdName.stdout.split("\n")[0].trim(); // first line is the AVD name
      if (name !== PREVIEW_AVD) continue; // not our AVD, skip
      const boot = spawnSync(
        adbPath(),
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { encoding: "utf8" },
      );
      if (boot.status === 0 && boot.stdout.trim() === "1") {
        pushLog(slot, `[emulator] boot completed — ${PREVIEW_AVD} on ${serial}`);
        activeEmulatorSerial = serial;
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `emulator failed to reach sys.boot_completed=1 within ${EMULATOR_BOOT_TIMEOUT_MS / 1000}s`,
  );
}

/**
 * Find the PID of whatever process is listening on a local TCP port. Used
 * for orphan cleanup — if Metro (or any sidecar) is bound to the port but
 * we don't own the handle, we need to kill the owner before spawning a
 * replacement.
 *
 * Implementation: reads /proc/net/tcp + /proc/net/tcp6 to find the inode
 * for the listening socket, then walks /proc/<pid>/fd to find the process
 * that has that inode open. No external dependencies.
 */
async function findPortOwnerPid(port: number): Promise<number | null> {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  // Listen state = 0A in /proc/net/tcp. Local address column is "ip:port".
  const fs = await import("node:fs");
  let inode: string | null = null;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const content = fs.readFileSync(file, "utf8");
      for (const line of content.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10) continue;
        const [, local, , state, , , , , , ino] = cols;
        if (state !== "0A") continue; // listen
        if (!local?.endsWith(":" + portHex)) continue;
        inode = ino;
        break;
      }
    } catch { /* */ }
    if (inode) break;
  }
  if (!inode) return null;
  // Walk /proc/*/fd/* looking for a symlink to "socket:[<inode>]".
  const target = `socket:[${inode}]`;
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      const fdDir = `/proc/${pid}/fd`;
      for (const fd of fs.readdirSync(fdDir)) {
        try {
          const link = fs.readlinkSync(`${fdDir}/${fd}`);
          if (link === target) return Number(pid);
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  return null;
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
    pushLog(slot, `── phase 1/5: emulator ────────────────────────────`);
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

    pushLog(slot, `── phase 2/5: ReScript compile ────────────────────`);
    try {
      await buildRescript(slot, repoDir);
    } catch (err) {
      slot.status = "failed";
      slot.error = `ReScript build failed: ${(err as Error).message}`;
      return publicState(slot);
    }

    pushLog(slot, `── phase 3/5: Metro dev server (port ${METRO_PORT}) ──`);
    try {
      await ensureMetro(slot, repoDir);
    } catch (err) {
      slot.status = "failed";
      slot.error = `Metro did not start: ${(err as Error).message}`;
      return publicState(slot);
    }

    pushLog(slot, `── phase 4/5: mock merchant server (port 5252) ────`);
    try {
      await ensureMockServer(repoKey, (line) => pushLog(slot, line));
    } catch (err) {
      slot.status = "failed";
      slot.error = `mock merchant server did not start: ${(err as Error).message}`;
      return publicState(slot);
    }

    pushLog(slot, `── phase 5/5: install + launch APK ─────────────────`);
  }

  const cmd = "npm";
  const args = kind === "web-dev" ? ["start"] : ["run", "android"];

  // ANDROID_SERIAL pins ADB, Gradle, and React Native to one specific device.
  // This is the only reliable way to handle multiple simultaneous emulators —
  // --deviceId only affects the RN launcher, not the Gradle installDebug task,
  // so without ANDROID_SERIAL both emulators still get the APK and then RN
  // trips over "adb: more than one device/emulator" or "adb: forward takes
  // two arguments" when it tries to port-forward for each one in turn.
  const androidEnv: Record<string, string> = {
    FORCE_COLOR: "0",
    ANDROID_HOME,
    ANDROID_SDK_ROOT: ANDROID_HOME,
    ...(activeEmulatorSerial ? { ANDROID_SERIAL: activeEmulatorSerial } : {}),
  };

  if (activeEmulatorSerial) {
    pushLog(slot, `[android] ANDROID_SERIAL=${activeEmulatorSerial} — targeting ${PREVIEW_AVD} only`);
  }

  const proc = spawn(cmd, args, {
    cwd: repoDir,
    detached: true, // own process group so we can kill the whole tree
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...androidEnv },
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

/**
 * Force a clean restart of Metro for the mobile repo. Kills the current
 * Metro (process group + orphan scan for safety), then spawns a fresh one
 * via ensureMetro. Since the npm script is `react-native start
 * --reset-cache --client-logs`, the new process re-crawls the entire file
 * tree and rebuilds the haste-map from scratch — guarantees the next
 * bundle fetch reflects every .bs.js / .res edit on disk.
 *
 * Used by /preview/mobile/recompile after the chat agent has edited files
 * and we need to be SURE Metro picks them up (its filesystem watcher
 * races the agent on fast edits and sometimes loses).
 */
export async function forceRestartMetro(repoDir: string): Promise<void> {
  // Kill our own process group reference first.
  if (metroProc && metroProc.exitCode === null && metroProc.pid) {
    try {
      process.kill(-metroProc.pid, "SIGTERM");
    } catch {
      try { metroProc.kill("SIGTERM"); } catch { /* */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (metroProc && metroProc.exitCode === null && metroProc.pid) {
      try { process.kill(-metroProc.pid, "SIGKILL"); } catch { /* */ }
    }
  }
  metroProc = null;
  metroRepoDir = null;

  // Also look for and kill any orphaned Metro listening on the port
  // (tsx-watch reload residue, test spawns, etc). ensureMetro's own
  // orphan-detection handles this, but doing it here too avoids a race
  // where ensureMetro sees our just-killed process's TIME_WAIT state.
  if (await pingWebPort(METRO_PORT)) {
    const owner = await findPortOwnerPid(METRO_PORT);
    if (owner) {
      try { process.kill(owner, "SIGKILL"); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Respawn via the normal path. If there's an active slot we route logs
  // into it; otherwise fall back to a stub slot that drops logs.
  const activeSlot = metroActiveSlot ?? {
    repoKey: "mobile" as RepoKey,
    kind: "android-emulator" as PreviewKind,
    branch: "",
    status: "starting" as PreviewStatus,
    startedAt: Date.now(),
    logs: [],
  };
  await ensureMetro(activeSlot, repoDir);
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
  // And Metro.
  if (metroProc && metroProc.exitCode === null && metroProc.pid) {
    try {
      process.kill(-metroProc.pid, "SIGTERM");
    } catch {
      try { metroProc.kill("SIGTERM"); } catch { /* */ }
    }
  }
  metroProc = null;
  metroRepoDir = null;
  metroActiveSlot = null;
  // And the mock merchant server.
  await stopMockServer();
  // And the ws-scrcpy sidecar.
  await stopWsScrcpy();
}
