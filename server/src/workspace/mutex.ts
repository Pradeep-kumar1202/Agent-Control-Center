/**
 * Per-repo async mutex — ensures only one operation at a time per repo.
 * Prevents concurrent git operations from racing each other (e.g., a
 * skill run + a patch run on the same clone).
 */

import type { ExtendedRepoKey } from "../config.js";

const locks = new Map<string, Promise<void>>();

/**
 * Acquire a per-repo lock, run the callback, then release.
 * If another operation is already running on the same repo, this waits
 * for it to finish before proceeding.
 */
export async function withRepoLock<T>(
  repo: ExtendedRepoKey | string,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait for any existing lock on this repo
  while (locks.has(repo)) {
    await locks.get(repo);
  }

  let release: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(repo, lock);

  try {
    return await fn();
  } finally {
    locks.delete(repo);
    release!();
  }
}
