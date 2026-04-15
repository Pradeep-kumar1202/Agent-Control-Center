/**
 * Shared coder ↔ reviewer loop. Runs a review, sends SSE progress,
 * and iterates (fix → re-review) up to MAX_REVIEW_ITERATIONS.
 *
 * Both sdk-integrator and coder skills use this. The caller provides:
 *   - A diff getter (how to collect the current diff)
 *   - A fix prompt builder (skill-specific: integration passes classification, coder passes task description)
 *   - A review prompt builder (skill-specific)
 */

import type { Response } from "express";
import { ask } from "../../llm.js";
import { sendSSE } from "./sse.js";
import {
  extractJsonFromText,
  REVIEWER_MODEL,
  REVIEWER_TIMEOUT_MS,
  REVIEWER_TOOLS,
  type RepoReviewLog,
  type ReviewIssue,
  type ReviewResult,
} from "./reviewer.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_REVIEW_ITERATIONS = 3;
export const CODER_MODEL = "opus" as const;
export const CODER_TIMEOUT_MS = 600_000;        // 10 min for single-repo
export const MOBILE_CODER_TIMEOUT_MS = 900_000;  // 15 min for combined mobile
export const CODER_TOOLS = ["Edit", "Write", "Read", "Glob", "Grep"];

// ─── Review loop ─────────────────────────────────────────────────────────────

export interface ReviewLoopOpts {
  /** Label for SSE messages (e.g. "mobile", "web"). */
  targetLabel: string;
  /** Working directory for the reviewer's tools. */
  cwd: string;
  /** Collect the current diff from git. */
  getDiff: () => Promise<string>;
  /** Build the review prompt from the current diff. */
  buildReviewPrompt: (diff: string, previousIssues?: ReviewIssue[]) => string;
  /** Build the fix prompt from issues + diff. */
  buildFixPrompt: (issues: ReviewIssue[], diff: string) => string;
  /** Express response for SSE. */
  res: Response;
  /** Optional system prompt (e.g. codebase knowledge) passed to reviewer + fix-coder. */
  system?: string;
}

/**
 * Run the review loop: review → fix → re-review, up to MAX iterations.
 * Returns the review log and the final diff.
 */
export async function runReviewLoop(
  opts: ReviewLoopOpts,
): Promise<{ reviewLog: RepoReviewLog[]; finalDiff: string }> {
  const { targetLabel, cwd, getDiff, buildReviewPrompt, buildFixPrompt, res, system } = opts;
  const reviewLog: RepoReviewLog[] = [];
  let previousIssues: ReviewIssue[] | undefined;
  let diff = await getDiff();

  for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration++) {
    sendSSE(res, {
      type: "review_start",
      repo: targetLabel,
      message: `Reviewing (pass ${iteration}/${MAX_REVIEW_ITERATIONS})...`,
    });

    let review: ReviewResult;
    try {
      const reviewText = await ask(buildReviewPrompt(diff, previousIssues), {
        model: REVIEWER_MODEL,
        timeoutMs: REVIEWER_TIMEOUT_MS,
        cwd,
        allowedTools: REVIEWER_TOOLS,
        system,
      });
      review = extractJsonFromText<ReviewResult>(reviewText);
    } catch (err) {
      review = {
        approved: true,
        issues: [],
        summary: `Reviewer failed: ${(err as Error).message}`,
      };
    }

    reviewLog.push({ iteration, review });

    sendSSE(res, {
      type: "review_result",
      repo: targetLabel,
      message: review.approved
        ? `Approved on pass ${iteration}`
        : `Found ${review.issues.filter((i) => i.severity !== "nit").length} issues on pass ${iteration}`,
      data: review,
    });

    if (review.approved) break;

    const blockersAndWarnings = review.issues.filter((i) => i.severity !== "nit");
    if (blockersAndWarnings.length === 0) break;

    if (iteration === MAX_REVIEW_ITERATIONS) {
      sendSSE(res, {
        type: "progress",
        repo: targetLabel,
        message: `Max review iterations reached. ${blockersAndWarnings.length} issues remain.`,
      });
      break;
    }

    sendSSE(res, {
      type: "fix_start",
      repo: targetLabel,
      message: `Fixing ${blockersAndWarnings.length} issues...`,
    });

    await ask(buildFixPrompt(blockersAndWarnings, diff), {
      model: CODER_MODEL,
      timeoutMs: CODER_TIMEOUT_MS,
      cwd,
      allowedTools: CODER_TOOLS,
      system,
    });

    diff = await getDiff();
    previousIssues = blockersAndWarnings;
  }

  return { reviewLog, finalDiff: diff };
}
