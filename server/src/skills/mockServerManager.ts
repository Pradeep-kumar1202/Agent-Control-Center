/**
 * Mock merchant server — thin shim over `embeddedMockServer`.
 *
 * Historically this module spawned `node mockServer.js` from the
 * hyperswitch-client-core workspace. That approach made it awkward to edit
 * the payment-intent body live from the dashboard — every change meant
 * rewriting the vendored `mockData.js` and restarting the child.
 *
 * The endpoint now runs in-process (see embeddedMockServer.ts). This file
 * exists only so the existing call sites in `previewManager.ts` keep
 * compiling without a noisy import migration.
 */

import type { RepoKey } from "../config.js";
import {
  startMockServer,
  stopMockServer as stopEmbedded,
  getMockServerState,
} from "./embeddedMockServer.js";

export interface MockServerState {
  running: boolean;
  port: number;
  pid?: number;
  repoKey?: RepoKey;
}

export function mockServerInfo(): MockServerState {
  const s = getMockServerState();
  return { running: s.running, port: s.port };
}

type Logger = (line: string) => void;

/**
 * Ensure the in-process mock merchant server is listening. The `forRepo`
 * parameter is retained for API compatibility with the old spawn-based
 * manager — it no longer affects behavior because the embedded server has
 * no repo coupling (it's just an Express listener).
 */
export async function ensureMockServer(_forRepo: RepoKey, log: Logger): Promise<void> {
  try {
    const before = getMockServerState();
    if (before.running) {
      log(`[mockserver] already listening on port ${before.port}`);
      return;
    }
    log(`[mockserver] starting embedded listener`);
    const after = await startMockServer();
    log(`[mockserver] ready on port ${after.port}`);
  } catch (err) {
    log(`[mockserver!] ${(err as Error).message}`);
    throw err;
  }
}

export async function stopMockServer(): Promise<void> {
  await stopEmbedded();
}
