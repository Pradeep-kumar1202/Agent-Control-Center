/**
 * Run a full analysis from the CLI without involving the HTTP server.
 * Deterministic and model-free; see analyzer/index.ts.
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
  console.log(`  declared surface:`);
  for (const [cat, s] of Object.entries(result.surface)) {
    console.log(`    ${cat.padEnd(15)} web ${s.web}  mobile ${s.mobile}  matched ${s.matched}`);
  }
  if (result.tableWarnings.length > 0) {
    console.log(`  equivalence-table warnings:`);
    for (const w of result.tableWarnings) console.log(`    ${w}`);
  }
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
