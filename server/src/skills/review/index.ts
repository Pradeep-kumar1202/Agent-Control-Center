/**
 * PR Reviewer skill — Multi-pass review pipeline.
 *
 * Instead of one large prompt trying to catch everything (and spreading thin),
 * three focused passes run in PARALLEL, each owning a distinct concern:
 *
 *   Pass 1 — Security & Payment Safety  (model: opus, tools: Grep/Read)
 *     PCI patterns, credential exposure, 3DS integrity, amount mutation
 *
 *   Pass 2 — Logic, Correctness & Edge Cases  (model: opus, tools: Read/Grep)
 *     Null safety, async race conditions, error propagation, empty states
 *
 *   Pass 3 — Patterns, Tests & Translations  (model: sonnet, no tools)
 *     Naming conventions, file placement, test coverage, i18n coverage
 *
 * After all three complete:
 *   • Issues are merged and deduplicated
 *   • Hallucinated file paths (not present in the diff) are filtered out
 *   • Verdict is COMPUTED DETERMINISTICALLY from severity — never trusted from LLM
 *   • Summary is templated from facts — no extra LLM call
 *
 * The result: a reviewer you can trust enough to merge on.
 */

import type { Request, Response } from "express";
import simpleGit from "simple-git";
import { REPOS } from "../../config.js";
import { ask, askJson } from "../../llm.js";
import { saveReview, type ReviewRow } from "../../db.js";
import {
  buildReviewSummary,
  computeVerdict,
  deduplicateIssues,
  filterHallucinatedFilePaths,
  parseDiffStats,
} from "../../agents/validators.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";

export interface ReviewSpec {
  branch: string;
  baseBranch?: string;
  repo: "web" | "mobile" | "both";
}

export interface ReviewIssue {
  severity: "blocking" | "suggestion" | "nitpick";
  category:
    | "correctness"
    | "patterns"
    | "tests"
    | "translations"
    | "security"
    | "types"
    | "edge_cases";
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  verdict: "approve" | "request_changes" | "comment";
  issues: ReviewIssue[];
  missingTests: string[];
  missingTranslations: string[];
  statsAnalyzed: {
    filesReviewed: number;
    linesAdded: number;
    linesRemoved: number;
  };
  /** Which passes contributed to this result (for transparency) */
  passesRun: string[];
}

// ─── Diff fetching ─────────────────────────────────────────────────────────────

async function getBranchDiff(
  repoDir: string,
  branch: string,
  baseBranch: string,
): Promise<{ diff: string; stat: string }> {
  const git = simpleGit(repoDir);

  if (
    branch.startsWith("https://github.com") ||
    branch.startsWith("http://github.com")
  ) {
    const prMatch = branch.match(/\/pull\/(\d+)/);
    if (!prMatch) {
      throw new Error(
        "Unrecognised GitHub URL — expected a /pull/<number> URL",
      );
    }
    const prNum = prMatch[1];
    try {
      await git.raw(["fetch", "origin", `pull/${prNum}/head`]);
    } catch (err) {
      throw new Error(
        `Could not fetch PR #${prNum} from origin. ` +
        `Make sure the workspace repo has network access to GitHub and the PR exists. ` +
        `(${(err as Error).message ?? err})`,
      );
    }
    let diff = "";
    let stat = "";
    try {
      diff = await git.diff([`${baseBranch}...FETCH_HEAD`]);
      stat = await git.diff([`${baseBranch}...FETCH_HEAD`, "--stat"]);
    } catch {
      diff = await git.diff([`${baseBranch}..FETCH_HEAD`]);
      stat = await git.diff([`${baseBranch}..FETCH_HEAD`, "--stat"]);
    }
    return { diff, stat };
  }

  try {
    const branches = await git.branch(["-a"]);
    const exists = branches.all.some(
      (b) => b.replace("remotes/origin/", "").trim() === branch,
    );
    if (!exists) await git.fetch("origin", branch);
  } catch {
    // Proceed — branch may be local-only
  }

  let diff = "";
  let stat = "";
  try {
    diff = await git.diff([`${baseBranch}...${branch}`]);
    stat = await git.diff([`${baseBranch}...${branch}`, "--stat"]);
  } catch {
    try {
      diff = await git.diff([`${baseBranch}...origin/${branch}`]);
      stat = await git.diff([`${baseBranch}...origin/${branch}`, "--stat"]);
    } catch {
      try {
        diff = await git.diff([`${baseBranch}..${branch}`]);
        stat = await git.diff([`${baseBranch}..${branch}`, "--stat"]);
      } catch {
        throw new Error(
          `Could not diff "${branch}" against "${baseBranch}". ` +
          `Ensure the branch exists locally or is fetchable from origin.`,
        );
      }
    }
  }

  return { diff, stat };
}

// ─── Pass 1: Security & Payment Safety ────────────────────────────────────────

async function runSecurityPass(
  repoName: string,
  repoType: "web" | "mobile",
  diff: string,
  stat: string,
  repoDir: string,
): Promise<{ issues: ReviewIssue[] }> {
  const repoCtx =
    repoType === "web"
      ? "ReScript + React web payment SDK (hyperswitch-web)"
      : "ReScript + React Native mobile payment SDK (hyperswitch-client-core)";

  const prompt = `You are a payment-security specialist reviewing a code change in ${repoName} (${repoCtx}).

YOUR SOLE FOCUS: Security and PCI/payment-safety issues. Ignore style, naming, test coverage entirely.

## Diff Stats
\`\`\`
${stat}
\`\`\`

## Diff
\`\`\`diff
${diff.length > 60_000 ? diff.slice(0, 60_000) + "\n... [truncated]" : diff}
\`\`\`

## What to look for

1. **Card data exposure** — PAN, CVV, expiry digits appearing in:
   - Console.log / logging calls
   - localStorage / sessionStorage / cookies
   - Component state accessible from browser console
   - URLs / query parameters / analytics events

2. **Credential exposure** — API keys, merchant secrets, client secrets hardcoded or in client-accessible state

3. **3DS flow integrity**:
   - Amount or currency can be mutated between creating PaymentIntent and confirming it
   - Redirect URL not validated (open redirect)
   - Challenge flow can be bypassed

4. **Unvalidated input** — User-supplied values reaching payment APIs without sanitisation

5. **Sensitive data in error messages** — Error responses exposing internal structure or card data

For each issue found: cite the EXACT file and line number from the diff above.
Only report what is VISIBLE IN THIS DIFF.  Do not speculate about files not shown.
If no security issues exist, return an empty issues array.

Return ONLY JSON — no markdown, no explanation:
{
  "issues": [
    {
      "severity": "blocking",
      "category": "security",
      "file": "<relative path from diff>",
      "line": <number from diff>,
      "message": "<specific, factual description of the issue>",
      "suggestion": "<exact fix>"
    }
  ]
}`;

  try {
    const result = await askJson<{ issues: ReviewIssue[] }>(prompt, {
      model: "opus",
      timeoutMs: 180_000,
      cwd: repoDir,
      allowedTools: ["Read", "Grep"],
    });
    return { issues: Array.isArray(result.issues) ? result.issues : [] };
  } catch {
    return { issues: [] };
  }
}

// ─── Pass 2: Logic, Correctness & Edge Cases ──────────────────────────────────

async function runLogicPass(
  repoName: string,
  repoType: "web" | "mobile",
  diff: string,
  stat: string,
  repoDir: string,
): Promise<{ issues: ReviewIssue[] }> {
  const repoCtx =
    repoType === "web"
      ? "ReScript + React web SDK. Key patterns: Option types for nullable values, variants for payment methods, React hooks for async state."
      : "ReScript + React Native SDK. Key patterns: Option types, platform-specific modules (iOS/Android), RN bridge calls.";

  const prompt = `You are a senior engineer reviewing logic correctness in ${repoName}.

Context: ${repoCtx}

YOUR SOLE FOCUS: Logic bugs, correctness, and edge case handling. Ignore style and test coverage.

## Diff Stats
\`\`\`
${stat}
\`\`\`

## Diff
\`\`\`diff
${diff.length > 60_000 ? diff.slice(0, 60_000) + "\n... [truncated]" : diff}
\`\`\`

## What to look for

1. **Null / undefined / Option safety**:
   - ReScript: Calling .get() on Option without checking Some/None
   - TS/JS: Accessing properties of potentially-null values
   - Array access without bounds checking

2. **Async correctness**:
   - Race conditions — multiple concurrent operations modifying shared state
   - Missing await — fire-and-forget on operations that must complete
   - Missing error handling on async calls (unhandled promise rejections)
   - State set after component unmount

3. **Payment flow correctness**:
   - Success path assumed without checking API response status
   - Error responses silently ignored
   - Retry logic missing or incorrect
   - Wrong HTTP method / endpoint for the operation

4. **Logic errors**:
   - Off-by-one in loops or array indices
   - Incorrect boolean conditions (== vs ===, negation errors)
   - Missing cases in switch/match (non-exhaustive pattern matching in ReScript)
   - Wrong variable used (copy-paste bug)

5. **Missing edge case states**:
   - Loading state shown during async but UI still interactive
   - Empty list not handled (renders nothing / crashes)
   - Network failure not caught

Use the Read/Grep tools to look at surrounding context for any change that appears
to interact with existing state or call an existing function.

For each issue: cite EXACT file and line from the diff.
Only report what is visible or directly verifiable. No speculation.

Return ONLY JSON:
{
  "issues": [
    {
      "severity": "blocking" | "suggestion" | "nitpick",
      "category": "correctness" | "edge_cases" | "types",
      "file": "<relative path>",
      "line": <number>,
      "message": "<specific description>",
      "suggestion": "<exact fix>"
    }
  ]
}`;

  try {
    const result = await askJson<{ issues: ReviewIssue[] }>(prompt, {
      model: "opus",
      timeoutMs: 240_000,
      cwd: repoDir,
      allowedTools: ["Read", "Grep"],
    });
    return { issues: Array.isArray(result.issues) ? result.issues : [] };
  } catch {
    return { issues: [] };
  }
}

// ─── Pass 3: Patterns, Tests & Translations ───────────────────────────────────

async function runConventionPass(
  repoName: string,
  repoType: "web" | "mobile",
  diff: string,
  stat: string,
): Promise<{
  issues: ReviewIssue[];
  missingTests: string[];
  missingTranslations: string[];
}> {
  const repoCtx =
    repoType === "web"
      ? `
- Written in ReScript + React
- Types: src/Types/PaymentType.res, src/Types/
- Components: src/Components/
- Utilities: src/Utilities/
- Locale files: shared-code/assets/v2/jsons/locales/
- Cypress tests: cypress-tests/cypress/e2e/`
      : `
- Written in ReScript + React Native
- Config types: src/types/SdkTypes.res
- Components: src/components/
- Locale files: shared-code/assets/v2/jsons/locales/
- Detox tests: detox-tests/e2e/`;

  const prompt = `You are reviewing code conventions, test coverage, and internationalisation in ${repoName}.
${repoCtx}

YOUR SOLE FOCUS: Patterns, test coverage, and i18n. Ignore security and logic correctness.

## Diff Stats
\`\`\`
${stat}
\`\`\`

## Diff
\`\`\`diff
${diff.length > 60_000 ? diff.slice(0, 60_000) + "\n... [truncated]" : diff}
\`\`\`

## What to look for

1. **Pattern consistency**:
   - ReScript naming: camelCase fields, PascalCase types, snake_case file names
   - File placement: new files in the correct directory for their role
   - New props wired consistently with existing patterns (PaymentType.res / SdkTypes.res)
   - Import paths follow the existing structure

2. **Test coverage**:
   - New user-visible behaviour added without a corresponding Cypress / Detox test
   - New payment flow without a failure-path test (declined, timeout, network error)
   - Integration between new prop and existing payment flow untested

3. **Translation coverage**:
   - Hardcoded user-visible strings in JSX/render code instead of locale keys
   - New locale keys missing from the locales directory
   - Existing locale key used for a semantically different purpose

For MISSING TESTS: list each behavioural gap as a sentence, e.g.
"No test for card validation when hideExpiredPaymentMethods is true"

For MISSING TRANSLATIONS: list each hardcoded string, e.g.
"Hardcoded 'Payment failed' in src/Components/PaymentStatus.res line 42"

Return ONLY JSON:
{
  "issues": [
    {
      "severity": "blocking" | "suggestion" | "nitpick",
      "category": "patterns" | "tests" | "translations" | "types",
      "file": "<relative path>",
      "line": <number or null>,
      "message": "<specific description>",
      "suggestion": "<fix>"
    }
  ],
  "missingTests": ["<description of missing test>"],
  "missingTranslations": ["<hardcoded string or missing key>"]
}`;

  try {
    const result = await askJson<{
      issues: ReviewIssue[];
      missingTests: string[];
      missingTranslations: string[];
    }>(prompt, {
      model: "sonnet",
      timeoutMs: 120_000,
    });
    return {
      issues: Array.isArray(result.issues) ? result.issues : [],
      missingTests: Array.isArray(result.missingTests) ? result.missingTests : [],
      missingTranslations: Array.isArray(result.missingTranslations)
        ? result.missingTranslations
        : [],
    };
  } catch {
    return { issues: [], missingTests: [], missingTranslations: [] };
  }
}

// ─── Review orchestrator ───────────────────────────────────────────────────────

async function reviewRepo(
  repoKey: "web" | "mobile",
  spec: ReviewSpec,
): Promise<SkillRepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const baseBranch = spec.baseBranch ?? "main";
  const repoName =
    repoKey === "web" ? "hyperswitch-web" : "hyperswitch-client-core";

  const { diff, stat } = await getBranchDiff(repoDir, spec.branch, baseBranch);

  if (!diff) {
    const empty: ReviewResult = {
      summary: "No changes found between the specified branches.",
      verdict: "approve",
      issues: [],
      missingTests: [],
      missingTranslations: [],
      statsAnalyzed: { filesReviewed: 0, linesAdded: 0, linesRemoved: 0 },
      passesRun: [],
    };
    return {
      repo: repoKey,
      branch: spec.branch,
      diff: "",
      filesTouched: 0,
      summary: JSON.stringify(empty),
    };
  }

  // ── Run all three passes in parallel ────────────────────────────────────────
  const [securityResult, logicResult, conventionResult] = await Promise.all([
    runSecurityPass(repoName, repoKey, diff, stat, repoDir),
    runLogicPass(repoName, repoKey, diff, stat, repoDir),
    runConventionPass(repoName, repoKey, diff, stat),
  ]);

  // ── Merge and clean ──────────────────────────────────────────────────────────
  const rawIssues: ReviewIssue[] = [
    ...securityResult.issues,
    ...logicResult.issues,
    ...conventionResult.issues,
  ];

  // 1. Remove findings that cite files not in this diff (hallucinations)
  const realIssues = filterHallucinatedFilePaths(rawIssues, diff);

  // 2. Deduplicate across passes (same category + message)
  const dedupedIssues = deduplicateIssues(realIssues);

  // 3. Deterministic verdict — never trust the model's stated verdict
  const verdict = computeVerdict(dedupedIssues);

  // 4. Stats from diff (deterministic, no LLM)
  const stats = parseDiffStats(stat);

  // 5. Templated summary from facts (no extra LLM call)
  const summary = buildReviewSummary(dedupedIssues, verdict, stats);

  const reviewResult: ReviewResult = {
    summary,
    verdict,
    issues: dedupedIssues,
    missingTests: conventionResult.missingTests,
    missingTranslations: conventionResult.missingTranslations,
    statsAnalyzed: stats,
    passesRun: ["security", "logic", "convention"],
  };

  return {
    repo: repoKey,
    branch: spec.branch,
    diff,
    filesTouched: stats.filesReviewed,
    summary: JSON.stringify(reviewResult),
  };
}

// ─── Express handler ───────────────────────────────────────────────────────────

export async function handleReviewSkill(
  req: Request,
  res: Response,
): Promise<void> {
  const spec = req.body as ReviewSpec;
  if (!spec.branch || !spec.repo) {
    res.status(400).json({ error: "branch and repo are required" });
    return;
  }

  const results: Record<string, SkillRepoResult> = {};

  try {
    if (spec.repo === "web" || spec.repo === "both") {
      try {
        results.web = await reviewRepo("web", spec);
      } catch (err) {
        results.web = {
          repo: "web",
          branch: spec.branch,
          summary: "",
          diff: "",
          filesTouched: 0,
          error: (err as Error).message,
        };
      }
    }

    if (spec.repo === "mobile" || spec.repo === "both") {
      try {
        results.mobile = await reviewRepo("mobile", spec);
      } catch (err) {
        results.mobile = {
          repo: "mobile",
          branch: spec.branch,
          summary: "",
          diff: "",
          filesTouched: 0,
          error: (err as Error).message,
        };
      }
    }

    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "review",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
      meta: { branch: spec.branch, baseBranch: spec.baseBranch ?? "main" },
    };

    // Persist to DB so the user can come back later and see past reviews.
    // Derive an overall verdict: worst verdict across all repos reviewed.
    const verdictPriority = { request_changes: 3, comment: 2, approve: 1, error: 0 };
    let overallVerdict: ReviewRow["verdict"] = allError ? "error" : "approve";
    for (const r of Object.values(results)) {
      if (r.error) continue;
      try {
        const parsed = JSON.parse(r.summary) as { verdict?: string };
        const v = parsed.verdict as ReviewRow["verdict"] | undefined;
        if (v && (verdictPriority[v] ?? 0) > (verdictPriority[overallVerdict] ?? 0)) {
          overallVerdict = v;
        }
      } catch { /* skip unparseable */ }
    }
    try {
      const reviewId = saveReview(
        spec.branch,
        spec.baseBranch ?? "main",
        spec.repo,
        overallVerdict,
        JSON.stringify(envelope),
      );
      envelope.meta = { ...envelope.meta, reviewId };
    } catch { /* DB save failure must never block the response */ }

    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

