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
// Note: the bot forks (FORK_CONFIG / SUBMODULE_FORKS in skills/githubPr.ts) are
// deliberately NOT used here. They are a push target, not a source of truth —
// they lag upstream, so cloning from them yields commits the parent repos do
// not build against.

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
    // Point at UPSTREAM over HTTPS, not at the bot forks.
    //
    // The override exists only because client-core's .gitmodules uses
    // `git@github.com:` SSH, which breaks a fresh clone on a machine with no
    // SSH keys. Redirecting to the bot forks solved that but introduced a
    // worse problem: the forks lag upstream, so a recorded submodule pointer
    // may not exist there at all. `git submodule update` then cannot fetch it
    // and silently leaves the fork's own main checked out — which is how a
    // fresh setup produced a workspace where hyperswitch-web did not compile
    // (`phoneInvalidText does not belong to type localeStrings`).
    //
    // Upstream HTTPS keeps the no-credentials property and always has the
    // recorded commit. Pushing is unaffected: pushSubmoduleToFork adds its own
    // separate `bot` remote and never relies on `origin`.
    const upstreamUrl = toHttpsUrl(s.url);
    if (!upstreamUrl) {
      console.log(`  ${repoName}/${s.subpath}: unrecognised url "${s.url}" — leaving as-is`);
      continue;
    }
    if (upstreamUrl !== s.url) {
      console.log(`  ${repoName}/${s.subpath} → ${upstreamUrl} (ssh→https)`);
    }
    await git.raw(["config", `submodule.${s.name}.url`, upstreamUrl]);
  }

  try {
    await git.subModule(["update", "--init", "--recursive"]);
  } catch (err) {
    console.warn(
      `  ${repoName}: submodule init failed — the dashboard will still work for analysis, ` +
        `but submodule-aware features (patches touching shared-code/android/ios) will fail.\n` +
        `    cause: ${(err as Error).message}`,
    );
    return;
  }

  // Verify, don't assume. `submodule update` can exit 0 having left a submodule
  // on the wrong commit, and a wrong shared-code is indistinguishable from a
  // broken repo until the ReScript build fails several minutes later.
  let drift = 0;
  for (const s of subs) {
    const subDir = path.join(repoDir, s.subpath);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;
    try {
      const recorded = (await git.raw(["ls-tree", "HEAD", s.subpath])).trim().split(/\s+/)[2];
      const actual = (await simpleGit(subDir).revparse(["HEAD"])).trim();
      if (recorded && actual && recorded !== actual) {
        drift++;
        console.warn(
          `  ${repoName}/${s.subpath}: checked out ${actual.slice(0, 10)} but the parent records ` +
            `${recorded.slice(0, 10)} — the build will likely fail. ` +
            `Check that ${s.url} is reachable and contains that commit.`,
        );
      }
    } catch { /* best effort — a drift warning is a nicety, not a gate */ }
  }
  console.log(`  ${repoName}: submodules ready${drift > 0 ? ` (${drift} with drift — see warnings)` : ""}`);
}

/**
 * Normalise a submodule URL to HTTPS so a fresh clone needs no SSH key.
 * Returns null for anything that isn't a recognisable GitHub remote.
 */
function toHttpsUrl(url: string): string | null {
  if (!url) return null;
  const ssh = url.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  return null;
}

interface SubmoduleEntry {
  name: string;     // the "name" inside [submodule "<name>"]
  subpath: string;  // the `path = ...` value (usually equals name, but not always)
  url: string;      // the upstream url, normalised to HTTPS before use
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
    const urlMatch = body.match(/^\s*url\s*=\s*(.+)$/m);
    if (pathMatch) {
      entries.push({
        name,
        subpath: pathMatch[1].trim(),
        url: urlMatch ? urlMatch[1].trim() : "",
      });
    }
  }
  return entries;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
