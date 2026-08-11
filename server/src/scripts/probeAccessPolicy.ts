/**
 * Prove each AccessPolicy actually blocks what it claims to.
 *
 * This exists because the previous tier table was wrong and nothing caught it:
 * `--allowed-tools` and `--tools ""` were both believed to restrict tool
 * access, and neither does. Every "read-only" agent had full write and shell
 * access, and a read-only analyst burned its whole 600 s budget on 15 Bash
 * calls before timing out.
 *
 * A capability table that is asserted rather than tested is a comment, not a
 * boundary. Run this after any CLI upgrade.
 *
 *   npx tsx server/src/scripts/probeAccessPolicy.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertAccessEnforced } from "../runtime/adapters/claudeCode.js";
import { ACCESS_POLICIES, type AccessPolicy } from "../runtime/types.js";

async function main(): Promise<void> {
  // Sandbox dir so a policy that FAILS to block Write cannot scribble in the repo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-access-probe-"));
  console.log(`\nAccessPolicy enforcement — claude-code   (probe dir: ${dir})\n`);

  let failures = 0;
  for (const access of ACCESS_POLICIES as readonly AccessPolicy[]) {
    process.stdout.write(`  ${access.padEnd(15)} `);
    try {
      const { enforced, detail } = await assertAccessEnforced(access, "sonnet", dir);
      if (enforced) {
        console.log(`✓ ${detail}`);
      } else {
        failures++;
        console.log(`✗ NOT ENFORCED — ${detail}`);
      }
    } catch (err) {
      failures++;
      console.log(`✗ probe failed: ${(err as Error).message}`);
    }
  }

  const leaked = fs.readdirSync(dir);
  if (leaked.length > 0) {
    failures++;
    console.log(`\n  ✗ files created in the probe dir despite read-only policies: ${leaked.join(", ")}`);
  }

  console.log(
    failures === 0
      ? "\nAll access policies enforced.\n"
      : `\n${failures} policy check(s) FAILED — the tier table does not match reality.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
