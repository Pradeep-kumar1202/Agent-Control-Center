/**
 * HTTP surface for jobs.
 *
 * The split that makes runs survive a reload:
 *
 *   POST /skills/:skillId/jobs   creates the run, returns an id, streams nothing
 *   GET  /jobs/:id/events        replays then tails — safe to open, close and
 *                                reopen from any tab, any number of times
 *   POST /jobs/:id/cancel        the ONLY thing that stops a run
 *
 * Creation and observation being separate endpoints is the whole point.
 * Previously they were one streaming POST, which meant closing the connection
 * was indistinguishable from asking to stop. Here, disconnecting from
 * `/events` merely unsubscribes.
 */

import { Router, type Request, type Response } from "express";
import {
  cancelJob,
  getJob,
  listJobs,
  subscribe,
  type JobStatus,
  type SeqEvent,
} from "./runner.js";

export const jobsRouter = Router();

/** Registry of skill executors, populated by each skill module at import time. */
export type JobStarter = (req: Request, res: Response) => void | Promise<void>;
const starters = new Map<string, JobStarter>();

/**
 * Register a skill's job entry point.
 *
 * The handler is responsible for validating input and resolving agent profiles
 * BEFORE calling `startJob`, and for replying `201 {jobId}`. Doing that work in
 * the handler rather than inside the executor is what lets a misconfigured run
 * fail with a real status code instead of an error buried in a stream.
 */
export function registerJobSkill(skillId: string, starter: JobStarter): void {
  starters.set(skillId, starter);
}

jobsRouter.post("/skills/:skillId/jobs", async (req, res) => {
  const starter = starters.get(req.params.skillId);
  if (!starter) {
    res.status(404).json({ error: `Unknown job skill: ${req.params.skillId}` });
    return;
  }
  try {
    await starter(req, res);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: (err as Error).message });
  }
});

jobsRouter.get("/jobs", (req, res) => {
  const status = typeof req.query.status === "string"
    ? (req.query.status.split(",").filter(Boolean) as JobStatus[])
    : undefined;
  const skillId = typeof req.query.skill === "string" ? req.query.skill : undefined;
  const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  res.json({ jobs: listJobs({ status, skillId, limit: Number.isFinite(limit) ? limit : undefined }) });
});

jobsRouter.get("/jobs/:id", (req, res) => {
  const job = getJob(Number(req.params.id));
  if (!job) { res.status(404).json({ error: "Unknown job" }); return; }
  res.json(job);
});

jobsRouter.post("/jobs/:id/cancel", (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  if (!job) { res.status(404).json({ error: "Unknown job" }); return; }
  const cancelling = cancelJob(id);
  res.json({ jobId: id, cancelling, status: getJob(id)?.status ?? job.status });
});

/**
 * Replay-then-tail the event stream as NDJSON.
 *
 * `from` is the last sequence number the client already has, so a reconnect
 * after a dropped connection resumes precisely rather than repainting from the
 * start. Heartbeats keep intermediaries from closing an idle stream during a
 * long agent stage; they carry no `seq` and are never persisted, so they cannot
 * be mistaken for run content.
 */
jobsRouter.get("/jobs/:id/events", (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  if (!job) { res.status(404).json({ error: "Unknown job" }); return; }

  const fromRaw = Number(req.query.from);
  const from = Number.isFinite(fromRaw) && fromRaw >= 0 ? fromRaw : 0;

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  const write = (obj: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`${JSON.stringify(obj)}\n`);
  };

  const heartbeat = setInterval(() => write({ type: "heartbeat", at: new Date().toISOString() }), 15_000);
  heartbeat.unref?.();

  const detach = subscribe(id, from, (event: SeqEvent) => {
    if (event.type === "__end") { cleanup(); res.end(); return; }
    write(event);
  });

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    detach();
  }

  // Disconnecting unsubscribes. It does NOT cancel the job — that is what
  // POST /jobs/:id/cancel is for, and keeping them distinct is why a reload no
  // longer destroys a run.
  res.on("close", cleanup);
  req.on("aborted", cleanup);
});
