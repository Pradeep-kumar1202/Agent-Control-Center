/**
 * Manual smoke test for the repo manager.
 *
 *   npm run sync -w server
 *
 * Clones (or pulls) both repos into ./workspace/ and prints their HEAD state.
 */
import { syncAllRepos } from "../workspace/repoManager.js";

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
