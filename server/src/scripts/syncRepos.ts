/**
 * First-time setup: clone both SDK repos into ./workspace/ and initialise
 * their submodules from the bot's public forks on GitHub.
 *
 *   npm run sync -w server     # called by `npm run setup` at repo root
 *
 * The submodule URLs in .gitmodules point at juspay/* repos — two of them
 * (ios, android) use git@github.com: SSH which would break for a fresh
 * clone on a machine without SSH keys. We override those URLs in local
 * .git/config (not in tracked .gitmodules) to point at the bot's public
 * HTTPS forks so first-time setup needs no credentials.
 */

import fs from "node:fs";
import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { syncAllRepos } from "../workspace/repoManager.js";
import { FORK_CONFIG, SUBMODULE_FORKS } from "../skills/githubPr.js";

async function main() {
  const t0 = Date.now();
  const states = await syncAllRepos();
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nsynced in ${dt}s:`);
  for (const s of Object.values(states)) {
    console.log(
      `  ${s.key.padEnd(7)} ${s.name.padEnd(30)} ${s.branch} @ ${s.sha.slice(0, 10)}`,
    );
    console.log(`            ${s.dir}`);
  }

  console.log("\ninitialising submodules from bot forks…");
  for (const s of Object.values(states)) {
    await initSubmodulesFromForks(s.dir, s.name);
  }
  console.log("\nsetup complete.");
}

/**
 * For each submodule listed in the parent's .gitmodules, override its URL in
 * local .git/config to point at the corresponding bot fork (if we have a
 * mapping for it), then run `git submodule update --init --recursive`.
 *
 * We deliberately do NOT edit the tracked .gitmodules file — keeping it in
 * its upstream-juspay state so subsequent PRs compare cleanly against
 * upstream. The URL override lives only in the workspace checkout.
 */
async function initSubmodulesFromForks(repoDir: string, repoName: string): Promise<void> {
  const gitmodulesPath = path.join(repoDir, ".gitmodules");
  if (!fs.existsSync(gitmodulesPath)) {
    console.log(`  ${repoName}: no submodules`);
    return;
  }

  const subs = parseGitmodules(gitmodulesPath);
  if (subs.length === 0) {
    console.log(`  ${repoName}: no submodules`);
    return;
  }

  const git: SimpleGit = simpleGit(repoDir);

  for (const s of subs) {
    const forkRepo = SUBMODULE_FORKS[s.subpath] ?? SUBMODULE_FORKS[s.name];
    if (!forkRepo) {
      console.log(`  ${repoName}/${s.subpath}: no fork mapping — leaving as upstream (may need SSH)`);
      continue;
    }
    const forkUrl = `https://github.com/${FORK_CONFIG.owner}/${forkRepo}.git`;
    console.log(`  ${repoName}/${s.subpath} → ${forkUrl}`);
    await git.raw(["config", `submodule.${s.name}.url`, forkUrl]);
  }

  try {
    await git.subModule(["update", "--init", "--recursive"]);
    console.log(`  ${repoName}: submodules ready`);
  } catch (err) {
    console.warn(
      `  ${repoName}: submodule init failed — the dashboard will still work for analysis, ` +
        `but submodule-aware features (patches touching shared-code/android/ios) will fail.\n` +
        `    cause: ${(err as Error).message}`,
    );
  }
}

interface SubmoduleEntry {
  name: string;     // the "name" inside [submodule "<name>"]
  subpath: string;  // the `path = ...` value (usually equals name, but not always)
}

/**
 * Minimal .gitmodules parser. Extracts the section name and its `path` value.
 * We only care about these two fields — the `url` is being overridden anyway.
 */
function parseGitmodules(filePath: string): SubmoduleEntry[] {
  const content = fs.readFileSync(filePath, "utf8");
  const entries: SubmoduleEntry[] = [];
  const sectionRegex = /\[submodule\s+"([^"]+)"\]([^\[]*)/g;
  for (const m of content.matchAll(sectionRegex)) {
    const name = m[1].trim();
    const body = m[2];
    const pathMatch = body.match(/^\s*path\s*=\s*(.+)$/m);
    if (pathMatch) {
      entries.push({ name, subpath: pathMatch[1].trim() });
    }
  }
  return entries;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
