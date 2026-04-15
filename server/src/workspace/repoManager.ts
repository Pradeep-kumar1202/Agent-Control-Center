/**
 * Workspace repo manager — clones and syncs git repositories into the
 * workspace directory with namespace subdirectories.
 *
 * Directory structure:
 *   workspace/
 *   ├── mobile/
 *   │   ├── hyperswitch-client-core/
 *   │   └── react-native-hyperswitch/
 *   └── web/
 *       └── hyperswitch-web/
 *
 * On first run, repos are cloned. On subsequent runs, repos are pulled.
 * If repos exist at legacy paths (workspace/{repo} without namespace),
 * they are automatically migrated to the new structure.
 */

import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import {
  REPOS,
  WORKSPACE_DIR,
  type AnalysisRepoKey,
  type ExtendedRepoKey,
} from "../config.js";

// ─── Legacy path migration ──────────────────────────────────────────────────

/** Old paths before namespace restructure (workspace/{repo-name} directly). */
const LEGACY_PATHS: Record<ExtendedRepoKey, string> = {
  web: path.join(WORKSPACE_DIR, "hyperswitch-web"),
  mobile: path.join(WORKSPACE_DIR, "hyperswitch-client-core"),
  rn_packages: path.join(WORKSPACE_DIR, "react-native-hyperswitch"),
};

/**
 * If repos exist at old flat paths, move them into the new namespace structure.
 * Idempotent — safe to call on every startup.
 */
function migrateFromLegacyPaths(): void {
  for (const [key, legacyDir] of Object.entries(LEGACY_PATHS) as Array<
    [ExtendedRepoKey, string]
  >) {
    const newDir = REPOS[key].dir;

    // Skip if legacy path IS the new path (shouldn't happen, but guard)
    if (path.resolve(legacyDir) === path.resolve(newDir)) continue;

    // Skip if legacy dir doesn't exist
    if (!fs.existsSync(legacyDir)) continue;

    // Skip if already migrated (new dir exists)
    if (fs.existsSync(newDir)) continue;

    // Create parent namespace directory
    const parentDir = path.dirname(newDir);
    fs.mkdirSync(parentDir, { recursive: true });

    // Move repo to new location
    fs.renameSync(legacyDir, newDir);
    console.log(`[repoManager] Migrated ${key}: ${legacyDir} → ${newDir}`);
  }
}

// ─── Clone / pull logic ──────────────────────────────────────────────────────

interface RepoState {
  key: ExtendedRepoKey;
  name: string;
  dir: string;
  branch: string;
  sha: string;
}

async function syncRepo(key: ExtendedRepoKey): Promise<RepoState> {
  const { name, url, dir } = REPOS[key];

  // Ensure parent directory exists
  const parentDir = path.dirname(dir);
  fs.mkdirSync(parentDir, { recursive: true });

  if (fs.existsSync(path.join(dir, ".git"))) {
    // Repo exists — pull latest
    const git = simpleGit(dir);
    try {
      await git.pull();
    } catch {
      // Pull can fail on detached HEAD, dirty tree, etc. — log but continue.
      console.warn(`[repoManager] Pull failed for ${name}, using existing state`);
    }
    const branch = (await git.branch()).current || "main";
    const sha = (await git.revparse(["HEAD"])).trim();
    return { key, name, dir, branch, sha };
  }

  // Repo doesn't exist — clone it
  console.log(`[repoManager] Cloning ${name} into ${dir}...`);
  await simpleGit().clone(url, dir);
  const git = simpleGit(dir);
  const branch = (await git.branch()).current || "main";
  const sha = (await git.revparse(["HEAD"])).trim();
  console.log(`[repoManager] Cloned ${name} @ ${sha.slice(0, 10)}`);
  return { key, name, dir, branch, sha };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Sync all configured repos — clone if missing, pull if present.
 * Handles migration from legacy flat paths to namespace structure.
 *
 * Returns state for all repos keyed by RepoKey. The gap analysis pipeline
 * uses only "web" and "mobile" (AnalysisRepoKey) — callers can pick what
 * they need.
 */
export async function syncAllRepos(): Promise<
  Record<AnalysisRepoKey, RepoState>
> {
  // Run migration first (idempotent)
  migrateFromLegacyPaths();

  // Ensure workspace dir exists
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Sync all repos in parallel
  const allKeys = Object.keys(REPOS) as ExtendedRepoKey[];
  const states = await Promise.all(allKeys.map((key) => syncRepo(key)));

  // Build result keyed by repo key
  const result = {} as Record<string, RepoState>;
  for (const state of states) {
    result[state.key] = state;
  }

  return result as Record<AnalysisRepoKey, RepoState>;
}

/**
 * Ensure a specific repo is cloned and up-to-date. Used by integration skill
 * to sync only the repos it needs.
 */
export async function ensureRepo(key: ExtendedRepoKey): Promise<RepoState> {
  migrateFromLegacyPaths();
  return syncRepo(key);
}
