/**
 * Translator skill — Given a translation key and English value, translate into
 * all supported languages and surgically insert only that key into each locale
 * file in both repos.
 *
 * Produces minimal git diffs: exactly +1 line per locale file (the new key
 * appended at the end, plus the previous last key gains a comma separator —
 * this is unavoidable JSON syntax and appears as 2 lines changed per file,
 * but zero existing keys are touched).
 *
 * Flow:
 *  1. One Opus call to translate into all languages
 *  2. For each repo: create branch, insert key into all 32 locale files, commit
 */

import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { REPOS } from "../../config.js";
import { askJson } from "../../llm.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";

export interface TranslationSpec {
  keyName: string;
  englishValue: string;
  context: string;
}

const LOCALES_SUBPATH = "shared-code/assets/v2/jsons/locales";

// RTL languages that need direction-aware translation awareness
const RTL_LANGS = new Set(["ar", "he"]);

/**
 * Find all locale JSON files in the repo's locales directory.
 * Returns an array of { lang, filePath } objects.
 */
function getLocaleFiles(repoDir: string): Array<{ lang: string; filePath: string }> {
  const localesDir = path.join(repoDir, LOCALES_SUBPATH);
  try {
    return fs
      .readdirSync(localesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        lang: f.replace(".json", ""),
        filePath: path.join(localesDir, f),
      }));
  } catch {
    return [];
  }
}

/**
 * Surgically insert a single key-value pair into a JSON locale file.
 * Appends the key at the end of the object using pure string manipulation —
 * ZERO reformatting. Only two lines ever change per file:
 *   1. The previous last key gains a trailing comma (if it didn't have one).
 *   2. The new key is appended before the closing brace.
 * Idempotent: no-op if the key already exists.
 */
function insertKeyIntoLocaleFile(filePath: string, keyName: string, value: string): boolean {
  const raw = fs.readFileSync(filePath, "utf-8");

  // Idempotent: bail if key is already present
  if (new RegExp(`"${keyName}"\\s*:`).test(raw)) return false;

  const lastBraceIdx = raw.lastIndexOf("}");
  if (lastBraceIdx < 0) return false;

  // Detect indentation from the first quoted key in the file
  const indentMatch = raw.match(/^([ \t]+)"/m);
  const indent = indentMatch?.[1] ?? "  ";

  // Everything before the closing brace, with trailing whitespace stripped
  const beforeBrace = raw.slice(0, lastBraceIdx);
  const trimmed = beforeBrace.trimEnd();

  // Add comma to the previous last key if it doesn't already end with one
  const needsComma = !trimmed.endsWith(",");
  const prefix = trimmed + (needsComma ? "," : "") + "\n";

  const escapedValue = JSON.stringify(value); // safely quoted + escaped
  const newLine = `${indent}"${keyName}": ${escapedValue}`;

  fs.writeFileSync(filePath, prefix + newLine + "\n" + raw.slice(lastBraceIdx));
  return true;
}

async function translateKey(spec: TranslationSpec, nonEnglishLangs: string[]): Promise<Record<string, string>> {
  const prompt = `Translate the following UI string into the specified languages.
Return ONLY a flat JSON object with language codes as keys and translated strings as values.

Key name: ${spec.keyName}
English value: "${spec.englishValue}"
Context (where this text is used): ${spec.context}

Target languages (use EXACTLY these codes as JSON keys):
${nonEnglishLangs.join(", ")}

Important translation notes:
- For RTL languages (ar, he): translate naturally, do not add directional markers
- For regional variants (en-GB, fr-BE, nl-BE, tr-CY): use appropriate regional spellings/vocabulary
- Keep UI terminology consistent with payment/checkout contexts (card, payment, checkout, etc.)
- Preserve any {placeholder} tokens if present in the English string
- Keep translations concise — this is UI text

Return ONLY the JSON object, no explanation:
{
  "de": "...",
  "fr": "...",
  [... all ${nonEnglishLangs.length} languages]
}`;

  return askJson<Record<string, string>>(prompt, {
    model: "opus",
    timeoutMs: 120_000,
  });
}

async function processRepo(
  repoKey: "web" | "mobile",
  spec: TranslationSpec,
  translations: Record<string, string>,
): Promise<SkillRepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const git = simpleGit(repoDir);
  const slug = spec.keyName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
  const branchName = `feat/translate-${slug}-${repoKey}`;

  const localeFiles = getLocaleFiles(repoDir);
  if (localeFiles.length === 0) {
    throw new Error(`No locale files found at ${path.join(repoDir, LOCALES_SUBPATH)}`);
  }

  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";
  try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  await git.checkoutLocalBranch(branchName);

  let filesModified = 0;
  for (const { lang, filePath } of localeFiles) {
    const value = lang === "en"
      ? spec.englishValue
      : (translations[lang] ?? spec.englishValue);

    const modified = insertKeyIntoLocaleFile(filePath, spec.keyName, value);
    if (modified) filesModified++;
  }

  if (filesModified === 0) {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error(`Key "${spec.keyName}" already exists in all locale files`);
  }

  const diff = await git.diff();
  const diffStat = await git.diffSummary();

  await git.add(LOCALES_SUBPATH);
  await git.commit(
    `i18n: add "${spec.keyName}" translation key (${filesModified} locales)\n\nGenerated by feature-gap-dashboard translator skill`,
  );
  await git.checkout(defaultBranch);

  // Build a compact summary showing key + a few sample translations
  const sampleLangs = ["de", "fr", "es", "ja", "ar"].filter((l) => translations[l]);
  const samples = sampleLangs.map((l) => `${l}: "${translations[l]}"`).join(", ");
  const summary = JSON.stringify({
    what: `Added "${spec.keyName}" to ${filesModified} locale files`,
    key: spec.keyName,
    english: spec.englishValue,
    samples,
    allTranslations: { en: spec.englishValue, ...translations },
  });

  return {
    repo: repoKey,
    branch: branchName,
    summary,
    diff,
    filesTouched: diffStat.files.length,
  };
}

export async function handleTranslationsSkill(req: Request, res: Response): Promise<void> {
  const spec = req.body as TranslationSpec;
  if (!spec.keyName || !spec.englishValue || !spec.context) {
    res.status(400).json({ error: "keyName, englishValue, and context are required" });
    return;
  }

  try {
    // Discover languages from web repo locale files (both repos have identical set)
    const webLocales = getLocaleFiles(REPOS.web.dir);
    if (webLocales.length === 0) {
      res.status(500).json({ error: "Locale files not found — ensure workspace repos are cloned" });
      return;
    }

    const nonEnglishLangs = webLocales.map((l) => l.lang).filter((l) => l !== "en");

    // Phase 1: One Opus call to translate all languages
    let translations: Record<string, string> = {};
    try {
      translations = await translateKey(spec, nonEnglishLangs);
    } catch (err) {
      res.status(500).json({ error: `Translation failed: ${(err as Error).message}` });
      return;
    }

    // Phase 2: Insert into both repos (deterministic, no LLM)
    const results: Record<string, SkillRepoResult> = {};

    for (const repoKey of ["web", "mobile"] as const) {
      try {
        results[repoKey] = await processRepo(repoKey, spec, translations);
      } catch (err) {
        results[repoKey] = {
          repo: repoKey, branch: "", summary: "", diff: "", filesTouched: 0,
          error: (err as Error).message,
        };
      }
    }

    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "translations",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
      meta: {
        keyName: spec.keyName,
        englishValue: spec.englishValue,
        allTranslations: { en: spec.englishValue, ...translations },
        rtlLangs: nonEnglishLangs.filter((l) => RTL_LANGS.has(l)),
      },
    };
    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
