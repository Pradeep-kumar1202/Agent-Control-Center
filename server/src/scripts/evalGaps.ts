/**
 * Score deterministic gap derivation against the curated seed.
 *
 *   npm run eval:gaps -w server           (workspace clones must exist: npm run sync)
 *
 * Zero model calls. Reads the current workspace checkouts, derives gaps for
 * config / backend_api / component, and compares with seed/verified-gaps.json
 * and seed/dismissed-gaps.json:
 *
 *   still-a-gap        seed says real gap; we still report it            (recall)
 *   closed-upstream    seed gap, but the key now exists on both sides     (seed is stale)
 *   seed-unmatched     seed row we cannot map to a declared key           (seed name was model-invented, or parser blind spot — review)
 *   dismissed-regress  seed dismissed it as a false positive; we report it (precision failure — fix before shipping)
 *   new                reported by us, absent from the seed               (review)
 *
 * Exit code 1 on any parse failure or dismissed-regress, so it can gate CI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPOS } from "../config.js";
import { analyzeSurfaces, canonicalName, SURFACE_CATEGORIES, type SurfaceGap } from "../analyzer/surface/index.js";
import { compareKey } from "../analyzer/surface/equivalences.js";
import type { SurfaceCategory } from "../analyzer/surface/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface SeedVerified {
  category: string;
  canonical_name: string;
  missing_in: "web" | "mobile";
  platform_specific: number;
}
interface SeedDismissed {
  category: string;
  canonical_name: string;
  missing_in: "web" | "mobile";
}

const norm = (c: SurfaceCategory, name: string) => compareKey(c, name);

function main(): number {
  const verified = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/verified-gaps.json"), "utf8")) as SeedVerified[];
  const dismissed = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/dismissed-gaps.json"), "utf8")) as SeedDismissed[];

  const diffs = analyzeSurfaces({ web: REPOS.web.dir, mobile: REPOS.mobile.dir });
  const gapIndex = new Map<string, SurfaceGap>();
  const declared = { web: new Set<string>(), mobile: new Set<string>() };
  for (const d of diffs) {
    for (const g of d.gaps) gapIndex.set(`${g.category}|${g.missingIn}|${norm(g.category, g.key)}`, g);
    for (const side of ["web", "mobile"] as const) {
      for (const i of d.surface[side]) declared[side].add(`${d.category}|${norm(d.category, i.key)}`);
    }
  }
  const inScope = (c: string): c is SurfaceCategory => (SURFACE_CATEGORIES as string[]).includes(c);
  const lookup = (c: SurfaceCategory, missing: "web" | "mobile", name: string) => gapIndex.get(`${c}|${missing}|${norm(c, name)}`);

  const rows: Record<string, string[]> = {
    "still-a-gap": [],
    "still-a-gap (platform-specific mismatch)": [],
    "closed-upstream": [],
    "seed-unmatched": [],
    "dismissed-regress": [],
    new: [],
  };
  const accounted = new Set<string>();

  for (const s of verified) {
    if (!inScope(s.category)) continue;
    const g = lookup(s.category, s.missing_in, s.canonical_name);
    const label = `${s.category}/${s.canonical_name} (missing in ${s.missing_in}${s.platform_specific ? ", platform-specific" : ""})`;
    if (g) {
      accounted.add(`${g.category}|${g.missingIn}|${norm(g.category, g.key)}`);
      if (!!s.platform_specific === g.platformSpecific) rows["still-a-gap"].push(label);
      else rows["still-a-gap (platform-specific mismatch)"].push(`${label} → we say platform_specific=${g.platformSpecific}`);
    } else if (declared[s.missing_in].has(`${s.category}|${norm(s.category, s.canonical_name)}`)) {
      rows["closed-upstream"].push(`${label} → now declared in ${s.missing_in}`);
    } else {
      rows["seed-unmatched"].push(label);
    }
  }
  for (const s of dismissed) {
    if (!inScope(s.category)) continue;
    const g = lookup(s.category, s.missing_in, s.canonical_name);
    if (g && !g.platformSpecific) {
      accounted.add(`${g.category}|${g.missingIn}|${norm(g.category, g.key)}`);
      rows["dismissed-regress"].push(`${s.category}/${s.canonical_name} (missing in ${s.missing_in}) — evidence ${g.evidence.file}:${g.evidence.line}`);
    }
  }
  for (const [k, g] of gapIndex) {
    if (accounted.has(k)) continue;
    rows.new.push(
      `${g.category}/${g.canonicalName} (missing in ${g.missingIn}${g.platformSpecific ? ", platform-specific" : ""}) — ${g.evidence.file}:${g.evidence.line}`,
    );
  }

  console.log(`gap eval — web ${REPOS.web.dir}\n           mobile ${REPOS.mobile.dir}\n`);
  for (const d of diffs) {
    const real = d.gaps.filter((g) => !g.platformSpecific).length;
    console.log(
      `${d.category.padEnd(12)} declared web ${String(d.surface.web.length).padStart(3)}  mobile ${String(d.surface.mobile.length).padStart(3)}  ` +
        `matched ${String(d.matched).padStart(3)}  gaps ${String(real).padStart(3)} (+${d.gaps.length - real} platform-specific)  excluded ${d.excluded.length}`,
    );
  }
  for (const [name, list] of Object.entries(rows)) {
    console.log(`\n${name} (${list.length})`);
    for (const l of list.sort()) console.log(`  ${l}`);
  }
  const warnings = diffs.flatMap((d) => d.tableWarnings.map((w) => `${d.category}: ${w}`));
  console.log(`\nequivalence-table warnings (${warnings.length})`);
  for (const w of warnings) console.log(`  ${w}`);

  return rows["dismissed-regress"].length > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`gap eval failed: ${(err as Error).message}`);
  process.exitCode = 1;
}

// Referenced so the import is not flagged unused when categories grow.
void canonicalName;
