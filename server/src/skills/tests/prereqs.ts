/**
 * Test-run prerequisites.
 *
 * Before `runTestSuite` can do anything useful, the environment the tests
 * talk to has to be alive:
 *
 *   web     → localhost:9050 (the hyperswitch-web dev server) + :5252 mock
 *   mobile  → Android emulator + Metro + demo APK installed + :5252 mock
 *
 * Today the user had to open the Preview panel and hit Start manually. This
 * module does it for them: reuses the existing previewManager lifecycle and
 * the embedded mock server, and blocks until everything reports `ready`.
 *
 * Idempotent — if the correct preview is already running on the requested
 * branch, we short-circuit and just surface a "skipping" log line.
 */

import type { RepoKey } from "../../config.js";
import { getMockServerState, startMockServer } from "../embeddedMockServer.js";
import {
  getPreview,
  getPreviewLogs,
  startPreview,
  type PreviewKind,
} from "../previewManager.js";

const READY_TIMEOUT_MS = 600_000; // 10 min — matches ANDROID_READY_TIMEOUT_MS

export async function ensureTestPrereqs(
  repo: RepoKey,
  branch: string,
  writeLine: (line: string) => void,
): Promise<void> {
  const kind: PreviewKind = repo === "web" ? "web-dev" : "android-emulator";
  const label = repo === "web" ? "web dev server (9050)" : "android emulator + app";

  const existing = getPreview(repo);
  if (
    existing &&
    existing.status === "ready" &&
    existing.branch === branch &&
    existing.kind === kind
  ) {
    writeLine(`[prereq] ${label} already ready on ${branch} — skipping startup`);
  } else {
    if (existing && existing.status !== "stopped") {
      writeLine(
        `[prereq] existing preview on repo=${repo} (status=${existing.status}, branch=${existing.branch}) — replacing`,
      );
    }
    writeLine(`[prereq] starting ${label} on branch '${branch}'…`);
    await startPreview(repo, branch, kind);
    await waitUntilReady(repo, writeLine);
    writeLine(`[prereq] ${label} is ready`);
  }

  // Mock merchant server. For android the preview flow already calls
  // ensureMockServer in phase 4, but for web nothing else starts it, and we
  // also want a belt-and-suspenders check for the android path in case the
  // preview was already ready from a previous run (so phase 4 was skipped).
  const mockState = getMockServerState();
  if (mockState.running) {
    writeLine(`[prereq] mock merchant server already running on :${mockState.port}`);
  } else {
    writeLine(`[prereq] starting embedded mock merchant server…`);
    const r = await startMockServer();
    writeLine(`[prereq] mock merchant server ready on :${r.port}`);
  }
}

async function waitUntilReady(
  repo: RepoKey,
  writeLine: (line: string) => void,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const p = getPreview(repo);
    if (!p) {
      throw new Error(`preview slot for ${repo} disappeared during startup`);
    }
    if (p.status !== lastStatus) {
      writeLine(`[prereq] preview status → ${p.status}`);
      lastStatus = p.status;
    }
    if (p.status === "ready") return;
    if (p.status === "failed") {
      // Surface the tail of the preview's own log ring into the NDJSON
      // stream so the user can see the gradle/RN/webpack error that
      // actually killed the process. Without this all they get is the
      // one-line p.error which hides the root cause.
      const tail = getPreviewLogs(repo).lines.slice(-40);
      for (const line of tail) writeLine(`[preview] ${line}`);
      throw new Error(`preview failed: ${p.error ?? "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const tail = getPreviewLogs(repo).lines.slice(-40);
  for (const line of tail) writeLine(`[preview] ${line}`);
  throw new Error(
    `preview did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)}s`,
  );
}
