/**
 * Per-repo async mutex.
 *
 * Every workspace-touching operation (patch generation, chat turn, anything
 * that runs `git checkout` / `forceCheckoutBranch` / edits files in a clone)
 * goes through this. Two calls on the same repo are serialized; two calls
 * on *different* repos run concurrently.
 *
 * Implementation: a per-repo promise chain. `withRepoLock` returns a promise
 * that resolves to the inner function's result; while it's running, the
 * stored `chain` promise represents "the thing everyone else must wait for".
 * When it settles (success or error), we advance the chain to the next
 * waiter. No setTimeout, no race conditions, no external deps.
 */

import type { RepoKey } from "../config.js";

const chains: Partial<Record<RepoKey, Promise<unknown>>> = {};

export async function withRepoLock<T>(
  repoKey: RepoKey,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains[repoKey] ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  chains[repoKey] = prev.then(() => next);
  try {
    // Wait for the previous holder to settle, ignoring its outcome.
    await prev.catch(() => { /* */ });
    return await fn();
  } finally {
    release();
  }
}

/** For diagnostics only — is anyone holding the lock for this repo? */
export function isRepoLocked(repoKey: RepoKey): boolean {
  return chains[repoKey] !== undefined;
}
