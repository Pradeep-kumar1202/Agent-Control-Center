/**
 * Deterministic validators — run AFTER every LLM output, before the result
 * is shown to the user or written to disk.  Zero tokens.  Pure logic.
 *
 * These exist because the #1 source of agent mistakes is not bad reasoning —
 * it is hallucinated file paths, leaked placeholder values, and empty outputs
 * that slip through without a guard.  Catching them here means the user never
 * sees a bad result.
 */

import fs from "node:fs";
import path from "node:path";
import type { ReviewIssue } from "../skills/review/index.js";

// ─── Review validators ────────────────────────────────────────────────────────

/**
 * Parse all file paths that actually appear in a unified diff.
 * Used to filter out findings that cite files not touched by the PR.
 */
export function extractDiffFilePaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    // "diff --git a/src/foo.ts b/src/foo.ts"
    const git = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (git) { paths.add(git[1]); paths.add(git[2]); continue; }
    // "+++ b/src/foo.ts"
    const plus = line.match(/^\+\+\+ b\/(.+)$/);
    if (plus) { paths.add(plus[1]); continue; }
    // "--- a/src/foo.ts"
    const minus = line.match(/^--- a\/(.+)$/);
    if (minus && minus[1] !== "/dev/null") paths.add(minus[1]);
  }
  return paths;
}

/**
 * Drop findings that cite file paths not present in the diff.
 * This is the single highest-impact validator for review quality:
 * the model frequently invents plausible-looking paths for issues it
 * "knows about" but which aren't actually in this PR.
 */
export function filterHallucinatedFilePaths(
  issues: ReviewIssue[],
  diff: string,
): ReviewIssue[] {
  if (!diff) return issues;
  const diffPaths = extractDiffFilePaths(diff);
  if (diffPaths.size === 0) return issues; // diff not parsed — keep all

  return issues.filter((issue) => {
    if (!issue.file) return true; // no file cited — keep (valid for general findings)
    // Exact match or suffix match (model sometimes omits repo-root prefix)
    return (
      diffPaths.has(issue.file) ||
      [...diffPaths].some(
        (p) => p.endsWith(issue.file!) || issue.file!.endsWith(p),
      )
    );
  });
}

/**
 * Deterministic verdict gate — computed from issue severity, NOT from the LLM.
 *
 * Why: Models have a strong bias toward approving PRs even when they list
 * blocking issues.  This function ignores the model's stated verdict entirely
 * and derives it mechanically from the issue list.
 *
 *   blocking present  → "request_changes"
 *   suggestion only   → "comment"
 *   nothing / nitpick → "approve"
 */
export function computeVerdict(
  issues: ReviewIssue[],
): "approve" | "request_changes" | "comment" {
  if (issues.some((i) => i.severity === "blocking")) return "request_changes";
  if (issues.some((i) => i.severity === "suggestion")) return "comment";
  return "approve";
}

/**
 * Merge and deduplicate findings from multiple review passes.
 * Two issues are considered duplicates when they share the same category
 * and the first 80 normalised characters of their message.
 * On conflict, the higher-severity version wins.
 */
export function deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const SEVERITY_RANK: Record<ReviewIssue["severity"], number> = {
    blocking: 3,
    suggestion: 2,
    nitpick: 1,
  };

  const seen = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    const key = `${issue.category}:${issue.message
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 80)}`;
    const existing = seen.get(key);
    if (
      !existing ||
      SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity]
    ) {
      seen.set(key, issue);
    }
  }
  return [...seen.values()];
}

/**
 * Parse diff --stat output into structured numbers.
 * Example stat line: "3 files changed, 42 insertions(+), 7 deletions(-)"
 */
export function parseDiffStats(stat: string): {
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
} {
  const m = stat.match(
    /(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/,
  );
  if (m) {
    return {
      filesReviewed: parseInt(m[1] ?? "0"),
      linesAdded: parseInt(m[2] ?? "0"),
      linesRemoved: parseInt(m[3] ?? "0"),
    };
  }
  // Fallback: count file rows in the stat block
  const fileRows = stat.split("\n").filter((l) => l.includes(" | ")).length;
  return { filesReviewed: fileRows, linesAdded: 0, linesRemoved: 0 };
}

/**
 * Build a factual one-sentence summary from the validated data.
 * No LLM call — always accurate because it's derived directly from the issues.
 */
export function buildReviewSummary(
  issues: ReviewIssue[],
  verdict: "approve" | "request_changes" | "comment",
  stats: ReturnType<typeof parseDiffStats>,
): string {
  const blocking = issues.filter((i) => i.severity === "blocking").length;
  const suggestions = issues.filter((i) => i.severity === "suggestion").length;
  const nitpicks = issues.filter((i) => i.severity === "nitpick").length;
  const filesStr = `${stats.filesReviewed} file${stats.filesReviewed !== 1 ? "s" : ""} reviewed (${stats.linesAdded}+/${stats.linesRemoved}-)`;

  if (verdict === "approve") {
    const minor = nitpicks > 0 ? ` ${nitpicks} minor nitpick${nitpicks > 1 ? "s" : ""}.` : " Ready to merge.";
    return `${filesStr}. No blocking issues found.${minor}`;
  }
  if (verdict === "comment") {
    return `${filesStr}. ${suggestions} suggestion${suggestions > 1 ? "s" : ""} to consider; no blockers.`;
  }
  const categories = [
    ...new Set(
      issues.filter((i) => i.severity === "blocking").map((i) => i.category),
    ),
  ];
  return `${filesStr}. ${blocking} blocking issue${blocking > 1 ? "s" : ""} in: ${categories.join(", ")}. ${suggestions} suggestion${suggestions !== 1 ? "s" : ""}, ${nitpicks} nitpick${nitpicks !== 1 ? "s" : ""}.`;
}

// ─── Translation validators ───────────────────────────────────────────────────

export interface TranslationQualityIssue {
  locale: string;
  type: "empty" | "english_leaked" | "too_long" | "placeholder_missing";
  message: string;
}

/**
 * Validate the full translations map before writing to locale files.
 * Returns an array of issues (caller decides whether to block or just warn).
 */
export function validateTranslations(
  translations: Record<string, string>,
  englishValue: string,
): TranslationQualityIssue[] {
  const issues: TranslationQualityIssue[] = [];

  // Detect {placeholder} tokens in the source string
  const placeholders = [...englishValue.matchAll(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g)].map(
    (m) => m[0],
  );
  // Flag translations longer than 2.5× the English string (UI overflow risk)
  const maxLength = Math.max(120, englishValue.length * 2.5);

  for (const [locale, value] of Object.entries(translations)) {
    if (!value || value.trim() === "") {
      issues.push({
        locale,
        type: "empty",
        message: `Empty translation for locale "${locale}"`,
      });
      continue;
    }

    // English text leaking into a non-English locale
    if (
      value === englishValue &&
      locale !== "en" &&
      !locale.startsWith("en-")
    ) {
      issues.push({
        locale,
        type: "english_leaked",
        message: `"${locale}" has the same text as English — likely untranslated`,
      });
    }

    // Potential UI overflow
    if (value.length > maxLength) {
      issues.push({
        locale,
        type: "too_long",
        message: `"${locale}" is ${value.length} chars vs English ${englishValue.length} — may overflow UI`,
      });
    }

    // Placeholder preservation
    for (const ph of placeholders) {
      if (!value.includes(ph)) {
        issues.push({
          locale,
          type: "placeholder_missing",
          message: `"${locale}" is missing placeholder ${ph}`,
        });
      }
    }
  }

  return issues;
}

// ─── Test file validators ─────────────────────────────────────────────────────

export interface TestValidationIssue {
  file: string;
  type:
    | "not_found"
    | "no_describe"
    | "no_test_blocks"
    | "hardcoded_credential"
    | "wrong_pattern"
    | "no_assertions";
  message: string;
}

/**
 * Validate a list of generated test files before committing them.
 * Checks structural correctness without running them.
 */
export function validateGeneratedTests(
  repoDir: string,
  generatedFiles: string[],
  testType: "cypress" | "detox",
): TestValidationIssue[] {
  const issues: TestValidationIssue[] = [];

  for (const relPath of generatedFiles) {
    const absPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(repoDir, relPath);

    if (!fs.existsSync(absPath)) {
      issues.push({
        file: relPath,
        type: "not_found",
        message: `Generated file does not exist on disk: ${relPath}`,
      });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      issues.push({ file: relPath, type: "not_found", message: `Cannot read ${relPath}` });
      continue;
    }

    if (!content.includes("describe(")) {
      issues.push({
        file: relPath,
        type: "no_describe",
        message: "Missing describe() block — not a valid test file",
      });
    }

    if (!content.includes("it(") && !content.includes("test(")) {
      issues.push({
        file: relPath,
        type: "no_test_blocks",
        message: "Missing it() or test() blocks",
      });
    }

    // Detect hardcoded API keys / tokens
    if (
      /['"](pk_[a-zA-Z0-9_]{10,}|sk_[a-zA-Z0-9_]{10,}|[a-zA-Z0-9]{32,})['"]/.test(
        content,
      )
    ) {
      issues.push({
        file: relPath,
        type: "hardcoded_credential",
        message:
          "Possible hardcoded credential — use Cypress.env() or Constants instead",
      });
    }

    // Framework-specific pattern checks
    if (testType === "cypress") {
      if (!content.includes("cy.")) {
        issues.push({
          file: relPath,
          type: "wrong_pattern",
          message: "No cy. commands found — may not be a valid Cypress test",
        });
      }
      if (!content.includes("expect(") && !content.includes(".should(")) {
        issues.push({
          file: relPath,
          type: "no_assertions",
          message: "No assertions (expect/should) found",
        });
      }
    }

    if (testType === "detox") {
      if (!content.includes("device.") && !content.includes("element(")) {
        issues.push({
          file: relPath,
          type: "wrong_pattern",
          message: "No device. or element() calls — may not be a valid Detox test",
        });
      }
      if (!content.includes("expect(")) {
        issues.push({
          file: relPath,
          type: "no_assertions",
          message: "No expect() assertions found",
        });
      }
    }
  }

  return issues;
}
