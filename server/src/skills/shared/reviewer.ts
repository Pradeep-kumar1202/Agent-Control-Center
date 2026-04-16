/**
 * Shared reviewer types, config, and JSON extraction.
 * Skill-specific review prompts live in their respective skill folders.
 */

import type { Model } from "../../llm.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewIssue {
  file: string;
  check: string;
  severity: "blocker" | "warning" | "nit";
  description: string;
  suggestedFix: string;
}

export interface ReviewResult {
  approved: boolean;
  issues: ReviewIssue[];
  summary: string;
}

/**
 * A fix-coder's explicit rejection of a reviewer issue. Keyed by `file|check`
 * so the next review pass can re-evaluate it with the coder's reasoning
 * instead of silently re-raising the same issue.
 */
export interface Rebuttal {
  file: string;
  check: string;
  reason: string;
}

/**
 * JSON shape a fix-coder is asked to emit at the end of its run so the loop
 * knows which issues it accepted (and fixed) vs. which it disputed.
 */
export interface FixResult {
  fixed?: Array<{ file: string; check: string }>;
  rebuttals?: Rebuttal[];
  summary?: string;
}

export interface RepoReviewLog {
  iteration: number;
  review: ReviewResult;
  /** Rebuttals the fix-coder raised against this iteration's issues. */
  rebuttals?: Rebuttal[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

export const REVIEWER_MODEL: Model = "opus";
// 0 = no hard timeout; reviewer runs until natural completion or user cancel.
export const REVIEWER_TIMEOUT_MS = 0;
export const REVIEWER_TOOLS = ["Read", "Grep", "Glob"];

// ─── JSON extraction ─────────────────────────────────────────────────────────

/**
 * Extract a JSON object from text that may contain tool call results,
 * reasoning, etc. before/after the JSON. Uses balanced-brace extraction.
 */
export function extractJsonFromText<T = unknown>(text: string): T {
  // Try fenced block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch { /* fall through */ }
  }

  // Balanced-brace extraction — look for {"approved"...} (review result shape)
  const start = text.lastIndexOf('{"approved"');
  if (start >= 0) {
    const result = extractBalanced(text, start);
    if (result) {
      try {
        return JSON.parse(result) as T;
      } catch { /* fall through */ }
    }
  }

  // Generic balanced-brace fallback
  const genStart = text.search(/[\[{]/);
  if (genStart >= 0) {
    const result = extractBalanced(text, genStart);
    if (result) {
      try {
        return JSON.parse(result) as T;
      } catch { /* fall through */ }
    }
  }

  throw new Error(`Could not extract JSON from reviewer response.\n--- raw ---\n${text.slice(0, 500)}`);
}

function extractBalanced(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
