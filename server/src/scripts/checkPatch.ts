/**
 * Run the deterministic patch validators over a .patch file, offline.
 *
 * Zero LLM calls, so rules can be tuned against real artifacts in milliseconds
 * — the same "measure against cached output before wiring" loop LEARNINGS
 * iteration 3 used for the extractor prefilter.
 *
 *   npx tsx server/src/scripts/checkPatch.ts <web|mobile> <path/to.patch> [--category config]
 *   npx tsx server/src/scripts/checkPatch.ts --bench <label>
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, REPOS, type RepoKey } from "../config.js";
import { runPatchValidators, type PatchFinding, type PatchQualityReport } from "../agents/patchValidators.js";

function printReport(title: string, report: PatchQualityReport): void {
  const { findings, stats } = report;
  const rejects = findings.filter((f) => f.level === "reject");
  const warns = findings.filter((f) => f.level === "warn");
  const verdict = report.rejected ? "REJECT" : warns.length ? "WARN" : "CLEAN";

  console.log(`\n${title}`);
  console.log(`  ${stats.files} file(s), +${stats.added}/-${stats.removed}   →  ${verdict}`);
  for (const f of [...rejects, ...warns]) print(f);
}

function print(f: PatchFinding): void {
  const tag = f.level === "reject" ? "REJECT" : " warn ";
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  console.log(`   [${tag}] ${f.rule}${loc}`);
  console.log(`            ${f.message}`);
  if (f.detail) console.log(`            ${f.detail.split("\n")[0].slice(0, 120)}`);
}

/** Guess the gap category from a bench case id like "config-mobile-foo". */
function categoryFromCaseId(id: string): string {
  return id.split("-")[0] ?? "config";
}

function repoFromCaseId(id: string): RepoKey {
  return id.includes("-web-") || id.endsWith("-web") ? "web" : "mobile";
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv[0] === "--bench") {
    const label = argv[1];
    if (!label) throw new Error("usage: checkPatch --bench <label>");
    const dir = path.join(DATA_DIR, "bench", "runs", label);
    if (!fs.existsSync(dir)) throw new Error(`no such bench label: ${dir}`);
    const patches = fs.readdirSync(dir).filter((f) => f.endsWith(".patch"));
    if (!patches.length) {
      console.log(`no .patch artifacts under ${dir}`);
      return;
    }
    for (const p of patches) {
      const caseId = p.replace(/\.patch$/, "");
      const repoKey = repoFromCaseId(caseId);
      const patchPath = path.join(dir, p);
      const spec = readSpec(path.join(dir, `${caseId}.json`));
      const report = runPatchValidators({
        diff: fs.readFileSync(patchPath, "utf8"),
        repoDir: REPOS[repoKey].dir,
        category: categoryFromCaseId(caseId),
        spec,
        // Not passing patchPath: `git apply --check --reverse` only means
        // something against the tree the patch was captured from, and the
        // bench repo has long since moved on.
      });
      printReport(`${caseId}  [${repoKey}]`, report);
    }
    return;
  }

  const [repoArg, patchPath] = argv;
  if (!repoArg || !patchPath) {
    console.log(`usage:
  checkPatch <web|mobile> <path/to.patch> [--category config|component]
  checkPatch --bench <label>`);
    return;
  }
  const repoKey = repoArg as RepoKey;
  if (!REPOS[repoKey]) throw new Error(`unknown repo "${repoArg}" (expected web|mobile)`);

  const ci = argv.indexOf("--category");
  const category = ci >= 0 ? argv[ci + 1] : "config";

  const report = runPatchValidators({
    diff: fs.readFileSync(patchPath, "utf8"),
    repoDir: REPOS[repoKey].dir,
    category,
    spec: null,
  });
  printReport(`${path.basename(patchPath)}  [${repoKey}, category=${category}]`, report);
  process.exit(report.rejected ? 1 : 0);
}

/** Bench records don't persist the SourceSpec yet — that lands with the telemetry work. */
function readSpec(recordPath: string): null {
  if (!fs.existsSync(recordPath)) return null;
  return null;
}

try {
  main();
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}
