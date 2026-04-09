/**
 * Offline measurement script.
 *
 * Reads the cached extract JSON files, runs the deterministic prefilter,
 * and reports before/after counts + projected gap count. NO LLM CALLS.
 *
 * Use this to tune the filter against real data before wiring it into the
 * pipeline. Append results to LEARNINGS.md after each tuning pass.
 *
 *   npx tsx src/scripts/measureFilter.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";
import { prefilter, isStructuralFalsePositive } from "../analyzer/filter.js";
import type { Category, ExtractedFeature } from "../analyzer/types.js";

const CATEGORIES: Category[] = [
  "payment_method",
  "config",
  "component",
  "backend_api",
];

interface CacheFile {
  repo: "web" | "mobile";
  sha: string;
  category: Category;
  path: string;
}

function loadCacheFiles(): CacheFile[] {
  const dir = path.join(DATA_DIR, "cache", "extract");
  const files = fs.readdirSync(dir);
  const byKey = new Map<string, CacheFile>();

  for (const f of files) {
    // filename: {repo}-{shortSha}-{category}.json
    const m = /^(web|mobile)-([a-f0-9]+)-(payment_method|config|component|backend_api)\.json$/.exec(
      f,
    );
    if (!m) continue;
    const [, repo, sha, category] = m;
    // keep the most-recent SHA per (repo, category) — assume lexicographic
    const key = `${repo}:${category}`;
    const existing = byKey.get(key);
    if (!existing || sha > existing.sha) {
      byKey.set(key, {
        repo: repo as "web" | "mobile",
        sha,
        category: category as Category,
        path: path.join(dir, f),
      });
    }
  }

  return [...byKey.values()];
}

function load(f: CacheFile): ExtractedFeature[] {
  return JSON.parse(fs.readFileSync(f.path, "utf8"));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function main() {
  const files = loadCacheFiles();
  if (files.length === 0) {
    console.error("No cached extract files found in data/cache/extract/");
    process.exit(1);
  }

  console.log(
    `\nUsing cache from: ${files
      .map((f) => `${f.repo}@${f.sha}`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ")}\n`,
  );

  // Per-category raw + filtered counts.
  const rawByRepoCategory: Record<string, ExtractedFeature[]> = {};
  const filteredByRepoCategory: Record<string, ExtractedFeature[]> = {};

  console.log(
    pad("category", 16) +
      pad("repo", 8) +
      pad("raw", 8) +
      pad("filtered", 12) +
      pad("dropped", 10) +
      pad("collapsed", 10),
  );
  console.log("─".repeat(64));

  let totalRaw = 0;
  let totalFiltered = 0;

  for (const category of CATEGORIES) {
    for (const repo of ["web", "mobile"] as const) {
      const f = files.find((x) => x.repo === repo && x.category === category);
      if (!f) continue;
      const raw = load(f);
      const result = prefilter(raw, category);
      rawByRepoCategory[`${repo}:${category}`] = raw;
      filteredByRepoCategory[`${repo}:${category}`] = result.filtered;
      totalRaw += raw.length;
      totalFiltered += result.filtered.length;

      console.log(
        pad(category, 16) +
          pad(repo, 8) +
          pad(String(raw.length), 8) +
          pad(String(result.filtered.length), 12) +
          pad(String(result.dropped), 10) +
          pad(String(result.collapsed), 10),
      );
    }
  }

  console.log("─".repeat(64));
  console.log(
    pad("TOTAL", 16) +
      pad("", 8) +
      pad(String(totalRaw), 8) +
      pad(String(totalFiltered), 12),
  );

  // ---- Projected gap counts ----
  // Apply the same name-key pairing normalize does: if a name exists on one
  // side only, it's a candidate gap. This is a lower bound on the real
  // normalize behavior (normalize can collapse near-dupes we don't catch
  // here), so the projected gap count is PESSIMISTIC — the real pipeline
  // should produce equal or fewer gaps.
  const projectRaw = projectGaps(rawByRepoCategory);
  const projectFiltered = projectGaps(filteredByRepoCategory);

  console.log("\n── Projected gaps (naive name-match, no LLM normalize) ──");
  console.log(
    pad("", 16) +
      pad("", 8) +
      pad("raw", 8) +
      pad("filtered", 12) +
      pad("delta", 10),
  );
  for (const category of CATEGORIES) {
    const r = projectRaw[category] ?? { web: 0, mobile: 0 };
    const f = projectFiltered[category] ?? { web: 0, mobile: 0 };
    // Apply structural false-positive rule (payment_method / missing_in=mobile)
    const rTotal =
      r.web +
      r.mobile -
      (isStructuralFalsePositive(category, "mobile") ? r.mobile : 0);
    const fTotal =
      f.web +
      f.mobile -
      (isStructuralFalsePositive(category, "mobile") ? f.mobile : 0);
    console.log(
      pad(category, 16) +
        pad("", 8) +
        pad(String(rTotal), 8) +
        pad(String(fTotal), 12) +
        pad(String(fTotal - rTotal), 10),
    );
  }

  const totalRawGaps = Object.values(projectRaw).reduce(
    (n, c) => n + c.web + c.mobile,
    0,
  );
  const totalFilteredGaps = Object.entries(projectFiltered).reduce(
    (n, [cat, c]) => {
      const category = cat as Category;
      const hidden = isStructuralFalsePositive(category, "mobile") ? c.mobile : 0;
      return n + c.web + c.mobile - hidden;
    },
    0,
  );

  console.log("─".repeat(64));
  console.log(
    pad("TOTAL gaps", 16) +
      pad("", 8) +
      pad(String(totalRawGaps), 8) +
      pad(String(totalFilteredGaps), 12) +
      pad(String(totalFilteredGaps - totalRawGaps), 10),
  );

  // Show what SURVIVED (for spot-checking the signal quality)
  console.log("\n── Surviving gaps (sample, after filter) ──");
  for (const category of CATEGORIES) {
    const web = new Set(
      (filteredByRepoCategory[`web:${category}`] ?? []).map((f) =>
        f.name.toLowerCase(),
      ),
    );
    const mobile = new Set(
      (filteredByRepoCategory[`mobile:${category}`] ?? []).map((f) =>
        f.name.toLowerCase(),
      ),
    );

    const missingInMobile = [...web].filter((n) => !mobile.has(n));
    const missingInWeb = [...mobile].filter((n) => !web.has(n));

    console.log(`\n  [${category}]`);
    if (!isStructuralFalsePositive(category, "mobile")) {
      console.log(
        `    missing in mobile (${missingInMobile.length}): ${missingInMobile.slice(0, 8).join(", ")}${missingInMobile.length > 8 ? ", …" : ""}`,
      );
    } else {
      console.log(
        `    missing in mobile: SKIPPED (structural false positive — mobile loads dynamically)`,
      );
    }
    console.log(
      `    missing in web    (${missingInWeb.length}): ${missingInWeb.slice(0, 8).join(", ")}${missingInWeb.length > 8 ? ", …" : ""}`,
    );
  }
}

function projectGaps(
  byKey: Record<string, ExtractedFeature[]>,
): Record<Category, { web: number; mobile: number }> {
  const out: Record<Category, { web: number; mobile: number }> = {
    payment_method: { web: 0, mobile: 0 },
    config: { web: 0, mobile: 0 },
    component: { web: 0, mobile: 0 },
    backend_api: { web: 0, mobile: 0 },
  };

  for (const category of CATEGORIES) {
    const web = new Set(
      (byKey[`web:${category}`] ?? []).map((f) => f.name.toLowerCase()),
    );
    const mobile = new Set(
      (byKey[`mobile:${category}`] ?? []).map((f) => f.name.toLowerCase()),
    );

    out[category].mobile = [...web].filter((n) => !mobile.has(n)).length;
    out[category].web = [...mobile].filter((n) => !web.has(n)).length;
  }

  return out;
}

main();
