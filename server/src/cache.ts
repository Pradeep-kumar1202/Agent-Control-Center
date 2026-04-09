import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

/**
 * Tiny disk cache. Keys are SHA-derived so re-runs against the same repo
 * commits are essentially free — no LLM calls, no subprocess startups.
 *
 * Layout under data/cache/:
 *   extract/   <repo>-<sha>-<category>.json     → ExtractedFeature[]
 *   normalize/ <category>-<webSha>-<mobileSha>.json → CanonicalFeature[]
 *   validate/  <missingIn>-<sha>-<nameHash>.json    → ValidationResult
 */

const CACHE_DIR = path.join(DATA_DIR, "cache");
fs.mkdirSync(path.join(CACHE_DIR, "extract"), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, "normalize"), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, "validate"), { recursive: true });

let hits = 0;
let misses = 0;

export function cacheStats() {
  return { hits, misses };
}

export function resetCacheStats() {
  hits = 0;
  misses = 0;
}

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

// ---------- extract cache ----------

export function extractKey(
  repo: "web" | "mobile",
  sha: string,
  category: string,
): string {
  return path.join(
    CACHE_DIR,
    "extract",
    `${repo}-${shortSha(sha)}-${safeName(category)}.json`,
  );
}

export function getExtractCache<T>(
  repo: "web" | "mobile",
  sha: string,
  category: string,
): T | null {
  const file = extractKey(repo, sha, category);
  const v = readJson<T>(file);
  if (v != null) hits++;
  else misses++;
  return v;
}

export function putExtractCache(
  repo: "web" | "mobile",
  sha: string,
  category: string,
  data: unknown,
) {
  writeJson(extractKey(repo, sha, category), data);
}

// ---------- normalize cache ----------

export function normalizeKey(
  category: string,
  webSha: string,
  mobileSha: string,
): string {
  return path.join(
    CACHE_DIR,
    "normalize",
    `${safeName(category)}-${shortSha(webSha)}-${shortSha(mobileSha)}.json`,
  );
}

export function getNormalizeCache<T>(
  category: string,
  webSha: string,
  mobileSha: string,
): T | null {
  const file = normalizeKey(category, webSha, mobileSha);
  const v = readJson<T>(file);
  if (v != null) hits++;
  else misses++;
  return v;
}

export function putNormalizeCache(
  category: string,
  webSha: string,
  mobileSha: string,
  data: unknown,
) {
  writeJson(normalizeKey(category, webSha, mobileSha), data);
}

// ---------- validate cache ----------

export function validateKey(
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
): string {
  return path.join(
    CACHE_DIR,
    "validate",
    `${missingIn}-${shortSha(repoSha)}-${nameHash(canonicalName)}.json`,
  );
}

export function getValidateCache<T>(
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
): T | null {
  const file = validateKey(missingIn, repoSha, canonicalName);
  const v = readJson<T>(file);
  if (v != null) hits++;
  else misses++;
  return v;
}

export function putValidateCache(
  missingIn: "web" | "mobile",
  repoSha: string,
  canonicalName: string,
  data: unknown,
) {
  writeJson(validateKey(missingIn, repoSha, canonicalName), data);
}
