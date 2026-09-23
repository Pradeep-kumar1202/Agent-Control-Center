import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Disk cache for per-gap Verify verdicts (Opus + read tools — the only model
 * call left in gap analysis). Keyed by the missing repo's SHA, so a verdict is
 * reused only while that repo is unchanged.
 *
 * Layout under data/cache/:
 *   validate/  <category>-<missingIn>-<sha>-<nameHash>.json → verdict
 *
 * The category is part of the key: `config|terms` and `component|terms` are
 * different gaps, and sharing one verdict let a component dismissal delete a
 * real config gap (2026-09-23 audit).
 */

const CACHE_DIR = path.join(DATA_DIR, "cache");
fs.mkdirSync(path.join(CACHE_DIR, "validate"), { recursive: true });

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
}

function nameHash(name: string): string {
  return crypto.createHash("sha1").update(name).digest("hex").slice(0, 10);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown) {
  // atomic-ish: write to tmp then rename
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function validateKey(
  category: string,
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
): string {
  return path.join(
    CACHE_DIR,
    "validate",
    `${safeName(category)}-${missingIn}-${shortSha(repoSha)}-${nameHash(canonicalName)}.json`,
  );
}

export function getValidateCache<T>(
  category: string,
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
): T | null {
  return readJson<T>(validateKey(category, missingIn, repoSha, canonicalName));
}

export function putValidateCache(
  category: string,
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
  data: unknown,
) {
  writeJson(validateKey(category, missingIn, repoSha, canonicalName), data);
}
