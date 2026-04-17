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
import { askStream, type StreamChunk } from "../../llm.js";
import { sendSSE } from "./sse.js";
import {
  extractJsonFromText,
  REVIEWER_MODEL,
  REVIEWER_TIMEOUT_MS,
  REVIEWER_TOOLS,
  type FixResult,
  type Rebuttal,
  type RepoReviewLog,
  type ReviewIssue,
  type ReviewResult,
} from "./reviewer.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_REVIEW_ITERATIONS = 3;
export const CODER_MODEL = "opus" as const;
// 0 = no hard timeout; the coder runs until natural completion or user cancel.
export const CODER_TIMEOUT_MS = 0;
export const MOBILE_CODER_TIMEOUT_MS = 0;
export const CODER_TOOLS = [
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "Bash(npx create-react-native-library:*)",
];

// ─── Stream chunk → SSE forwarder ────────────────────────────────────────────

/** Short readable summary of a tool call's input (e.g. "Read src/Foo.swift"). */
function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const i = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const arg =
    pick("file_path", "path", "pattern", "command", "query", "prompt", "description") ??
    "";
  const short = arg.length > 80 ? arg.slice(0, 77) + "..." : arg;
  return short ? `${name} ${short}` : name;
}

/**
 * Forward a single askStream chunk onto the SSE response.
 * - text → truncated to one line of summary, full text in data
 * - tool_use → short "Read foo.ts" style message
 * - tool_result → dim row; only surfaces if errored
 */
export function forwardCoderChunk(
  res: Response,
  repoLabel: string,
  chunk: StreamChunk,
): void {
  if (chunk.type === "text" && chunk.text) {
    const t = chunk.text.trim();
    if (!t) return;
    sendSSE(res, {
      type: "text",
      repo: repoLabel,
      message: t.length > 200 ? t.slice(0, 197) + "..." : t,
      data: { text: chunk.text },
    });
    return;
  }
  if (chunk.type === "tool_use" && chunk.tool) {
    sendSSE(res, {
      type: "tool_use",
      repo: repoLabel,
      message: summarizeToolInput(chunk.tool.name, chunk.tool.input),
      data: { tool: { name: chunk.tool.name, input: chunk.tool.input } },
    });
    return;
  }
  if (chunk.type === "tool_result" && chunk.toolResult) {
    sendSSE(res, {
      type: "tool_result",
      repo: repoLabel,
      message: chunk.toolResult.isError ? "tool error" : "",
      data: { isError: chunk.toolResult.isError === true },
    });
    return;
  }
  if (chunk.type === "error") {
    sendSSE(res, {
      type: "error",
      repo: repoLabel,
      message: chunk.error || "stream error",
    });
  }
}

// ─── Review loop ─────────────────────────────────────────────────────────────

export interface ReviewLoopOpts {
  /** Label for SSE messages (e.g. "mobile", "web"). */
  targetLabel: string;
  /** Working directory for the reviewer's tools. */
  cwd: string;
  /** Collect the current diff from git. */
  getDiff: () => Promise<string>;
  /**
   * Build the review prompt from the current diff.
   * `previousIssues` are issues the fix-coder tried to fix last round.
   * `rebuttals` are issues the fix-coder explicitly rejected last round —
   * the reviewer should re-evaluate those with the coder's stated reason
   * instead of silently re-raising them.
   */
  buildReviewPrompt: (
    diff: string,
    previousIssues?: ReviewIssue[],
    rebuttals?: Rebuttal[],
  ) => string;
  /** Build the fix prompt from issues + diff. */
  buildFixPrompt: (issues: ReviewIssue[], diff: string) => string;
  /** Express response for SSE. */
  res: Response;
  /** Optional system prompt (e.g. codebase knowledge) passed to reviewer + fix-coder. */
  system?: string;
}

/**
 * Best-effort parse of the fix-coder's JSON output. Returns empty rebuttals
 * if the coder didn't emit JSON or the JSON isn't shaped right — in that
 * case we assume every issue was accepted and silently attempted, which
 * matches the pre-rebuttal behavior.
 */
function parseFixResult(text: string): FixResult {
  try {
    return extractJsonFromText<FixResult>(text);
  } catch {
    return {};
  }
}

function keyOf(i: { file: string; check: string }): string {
  return `${i.file}|${i.check}`;
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
  let pendingRebuttals: Rebuttal[] | undefined;
  let diff = await getDiff();

  for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration++) {
    sendSSE(res, {
      type: "review_start",
      repo: targetLabel,
      message: `Reviewing (pass ${iteration}/${MAX_REVIEW_ITERATIONS})...`,
    });
    sendSSE(res, {
      type: "phase",
      repo: targetLabel,
      message: `Reviewing (pass ${iteration}/${MAX_REVIEW_ITERATIONS})`,
    });

    let review: ReviewResult;
    try {
      let reviewText = "";
      await askStream(
        buildReviewPrompt(diff, previousIssues, pendingRebuttals),
        {
          model: REVIEWER_MODEL,
          timeoutMs: REVIEWER_TIMEOUT_MS,
          cwd,
          allowedTools: REVIEWER_TOOLS,
          system,
        },
        (chunk) => {
          forwardCoderChunk(res, targetLabel, chunk);
          if (chunk.type === "text" && chunk.text) reviewText += chunk.text;
        },
      );
      review = extractJsonFromText<ReviewResult>(reviewText);
    } catch (err) {
      review = {
        approved: true,
        issues: [],
        summary: `Reviewer failed: ${(err as Error).message}`,
      };
    }

    reviewLog.push({ iteration, review, rebuttals: pendingRebuttals });

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
    sendSSE(res, {
      type: "phase",
      repo: targetLabel,
      message: `Fixing ${blockersAndWarnings.length} issues`,
    });

    let fixText = "";
    await askStream(
      buildFixPrompt(blockersAndWarnings, diff),
      {
        model: CODER_MODEL,
        timeoutMs: CODER_TIMEOUT_MS,
        cwd,
        allowedTools: CODER_TOOLS,
        system,
      },
      (chunk) => {
        forwardCoderChunk(res, targetLabel, chunk);
        if (chunk.type === "text" && chunk.text) fixText += chunk.text;
      },
    );

    const fixResult = parseFixResult(fixText);
    const rebuttedKeys = new Set((fixResult.rebuttals ?? []).map(keyOf));
    const attemptedFixes = blockersAndWarnings.filter((i) => !rebuttedKeys.has(keyOf(i)));
    pendingRebuttals = fixResult.rebuttals && fixResult.rebuttals.length > 0
      ? fixResult.rebuttals
      : undefined;

    if (pendingRebuttals) {
      sendSSE(res, {
        type: "fix_result",
        repo: targetLabel,
        message: `Coder disputed ${pendingRebuttals.length} of ${blockersAndWarnings.length} issues`,
        data: { rebuttals: pendingRebuttals, attempted: attemptedFixes.length },
      });
    }

    diff = await getDiff();
    previousIssues = attemptedFixes;
  }

  return { reviewLog, finalDiff: diff };
}
