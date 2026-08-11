/**
 * Process-group termination.
 *
 * `child.kill()` signals only the direct child, which is not enough for any of
 * the agent CLIs:
 *   - OpenCode spawns a local HTTP server on a random port; killing the CLI
 *     orphans it and the port stays occupied until reboot.
 *   - Codex runs model-generated commands as `/bin/zsh -lc ...` grandchildren.
 *   - Claude Code likewise spawns shells for its Bash tool.
 *
 * Spawning with `detached: true` puts the child in its own process group whose
 * id equals the child's pid, so `process.kill(-pid, sig)` reaches the whole
 * tree. `previewManager` has the same latent defect and should adopt this.
 */

import type { ChildProcess } from "node:child_process";

/**
 * Signal an entire process group, falling back to the direct child.
 *
 * Returns true if anything was signalled. ESRCH (already gone) is success, not
 * failure — the goal is "not running", and it isn't.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;

  try {
    // Negative pid targets the group. Only valid when spawned detached.
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    // Not detached, or the group is gone but the child is not.
    try {
      child.kill(signal);
      return true;
    } catch (inner) {
      return (inner as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
}

/**
 * SIGTERM the group, then SIGKILL anything still alive after `graceMs`.
 *
 * Worth the extra step for agent CLIs: a clean SIGTERM lets them flush a final
 * result event carrying token usage, which a bare SIGKILL discards.
 */
export function terminateProcessGroup(child: ChildProcess, graceMs = 2000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  killProcessGroup(child, "SIGTERM");
  const timer = setTimeout(() => killProcessGroup(child, "SIGKILL"), graceMs);
  // Never hold the event loop open just to escalate a kill.
  timer.unref?.();
  child.once("exit", () => clearTimeout(timer));
}
