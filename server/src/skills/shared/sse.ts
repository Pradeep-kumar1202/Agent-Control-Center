/**
 * Shared SSE helpers used by any skill that streams progress events.
 */

import type { Response } from "express";

export interface SSEEvent {
  type:
    | "progress"
    | "phase"
    | "tool_use"
    | "tool_result"
    | "text"
    | "review_start"
    | "review_result"
    | "fix_start"
    | "repo_done"
    | "done"
    | "error";
  /** Target or repo key for display. */
  repo?: string;
  message: string;
  data?: unknown;
}

/** Write a single SSE event to the response stream. */
export function sendSSE(res: Response, event: SSEEvent): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Set up SSE response headers. */
export function initSSE(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
