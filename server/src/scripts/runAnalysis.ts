/**
 * Smoke test: run a full analysis from the CLI without involving the HTTP
 * server. Useful for iterating on extractors.
 *
 *   npm run analyze -w server
 */
import { runAnalysis } from "../analyzer/index.js";
import { db } from "../db.js";

async function main() {
  console.log("[analyze] starting…");
  const result = await runAnalysis();
  console.log(`\n[analyze] done in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  report id: ${result.reportId}`);
  console.log(`  web SHA:   ${result.webSha.slice(0, 10)}`);
  console.log(`  mobile SHA: ${result.mobileSha.slice(0, 10)}`);
  console.log(`  gaps:      ${result.gapCount}`);
  console.log(`  pipeline:`);
  console.log(`    raw extracted        ${result.passCounts.raw}`);
  console.log(`    after prefilter      ${result.passCounts.afterPrefilter}`);
  console.log(`    after normalize      ${result.passCounts.afterNormalize}`);
  console.log(`  by category:`);
  for (const [cat, n] of Object.entries(result.gapCountByCategory)) {
    console.log(`    ${cat.padEnd(15)} ${n}`);
  }

  const sample = db
    .prepare(
      `SELECT category, canonical_name, missing_in, present_in
       FROM gaps WHERE report_id = ? ORDER BY missing_in, canonical_name LIMIT 30`,
    )
    .all(result.reportId);

  console.log(`\nfirst ${sample.length} gaps:`);
  for (const row of sample as Array<{
    category: string;
    canonical_name: string;
    missing_in: string;
    present_in: string;
  }>) {
    console.log(
      `  [${row.category}] ${row.canonical_name.padEnd(24)} missing in ${row.missing_in.padEnd(7)}(present in ${row.present_in})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
