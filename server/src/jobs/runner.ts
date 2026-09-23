/**
 * The job runner: durable, resumable, cancellable skill runs.
 *
 * ## Why this exists
 *
 * Runs used to live and die with an HTTP response. `res.on("close")` aborted
 * the agent, so a browser reload, a navigation, or a wifi blip destroyed twenty
 * minutes of work — and because `saveSkillRun` only fired at the end, the run
 * left no trace at all. Worse, a deliberate Stop and an accidental reload were
 * indistinguishable at the server: both were just "the socket closed".
 *
 * Here, a run is a row. It is written before any work begins, every event is
 * appended to `job_events`, and the only thing that stops a run is an explicit
 * cancel. Disconnecting just stops listening.
 *
 * ## Guarantees
 *
 *  - **Monotonic, gap-free `seq` per job.** Sequence numbers are assigned on the
 *    single JS thread at event-close time, so ordering needs no coordination.
 *  - **Replay ≡ live.** `subscribe` flushes pending events before reading, so a
 *    subscriber can never see a gap or a duplicate at the replay/tail seam.
 *  - **Bounded storage.** Text deltas are coalesced, and a hard cap stops a
 *    pathological run from filling the database.
 *
 * Everything is in-process and single-writer: better-sqlite3 is synchronous, so
 * there is no interleaving to defend against inside a flush.
 */

import { db, saveSkillRun } from "../db.js";
import type { SkillEnvelope } from "../skills/registry.js";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface SeqEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface JobContext {
  jobId: number;
  emit: (event: Record<string, unknown>) => void;
  signal: AbortSignal;
  /** Call once real work begins (after repo locks are held): queued -> running. */
  setRunning: () => void;
}

export type JobExecutor = (ctx: JobContext) => Promise<SkillEnvelope>;

// ─── tuning ─────────────────────────────────────────────────────────────────

/** Close an open text run at this size, so one event never grows unbounded. */
const TEXT_COALESCE_BYTES = 1024;
/** ...or after this long, so a slow trickle still reaches the UI promptly. */
const TEXT_COALESCE_MS = 100;
/** Flush to SQLite once this many events are pending... */
const FLUSH_EVENTS = 50;
/** ...or this long after the first unflushed event. Bounds crash loss. */
const FLUSH_MS = 200;
/**
 * Hard ceiling on persisted events per job. A 25-minute agent run coalesces to
 * roughly 15k events; this is far above that and exists only so a runaway loop
 * cannot fill the disk. Past the cap, text is dropped (once, loudly) while
 * structural events keep flowing — losing prose is survivable, losing phase and
 * verdict events is not.
 */
const MAX_EVENTS = 50_000;

/** Events that must reach disk immediately — the ones a crash must not lose. */
const CRITICAL_TYPES = new Set(["error", "phase_done", "phase_marker", "gate_result", "job_done"]);

// ─── live state ─────────────────────────────────────────────────────────────

interface LiveJob {
  id: number;
  controller: AbortController;
  lastSeq: number;
  pending: SeqEvent[];
  subscribers: Set<(e: SeqEvent) => void>;
  openText: { parts: string[]; bytes: number; extra: Record<string, unknown>; timer: NodeJS.Timeout | null } | null;
  flushTimer: NodeJS.Timeout | null;
  eventCount: number;
  cappedNotified: boolean;
}

const live = new Map<number, LiveJob>();

const nowIso = (): string => new Date().toISOString();

// ─── persistence helpers ────────────────────────────────────────────────────

const insertEvent = db.prepare(
  "INSERT OR IGNORE INTO job_events (job_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)",
);
const bumpLastSeq = db.prepare("UPDATE jobs SET last_seq = ? WHERE id = ?");

const flushBatch = db.transaction((jobId: number, events: SeqEvent[]) => {
  for (const e of events) {
    const { seq, at, ...rest } = e;
    insertEvent.run(jobId, seq, at, e.type, JSON.stringify(rest));
  }
  if (events.length > 0) bumpLastSeq.run(events[events.length - 1].seq, jobId);
});

function flush(job: LiveJob): void {
  if (job.flushTimer) { clearTimeout(job.flushTimer); job.flushTimer = null; }
  if (job.pending.length === 0) return;
  const batch = job.pending;
  job.pending = [];
  try {
    flushBatch(job.id, batch);
  } catch (err) {
    console.error(`[jobs] failed to persist ${batch.length} event(s) for job ${job.id}: ${(err as Error).message}`);
  }
}

function scheduleFlush(job: LiveJob): void {
  if (job.flushTimer) return;
  job.flushTimer = setTimeout(() => { job.flushTimer = null; flush(job); }, FLUSH_MS);
  job.flushTimer.unref?.();
}

// ─── event emission ─────────────────────────────────────────────────────────

/** Assign a seq, fan out to live subscribers, and queue for persistence. */
function publish(job: LiveJob, event: Record<string, unknown>): void {
  const seq: SeqEvent = {
    seq: ++job.lastSeq,
    at: nowIso(),
    type: String(event.type ?? "unknown"),
    ...event,
  };
  job.eventCount++;
  job.pending.push(seq);

  for (const fn of job.subscribers) {
    try { fn(seq); } catch { /* a broken subscriber must not stop the run */ }
  }

  if (CRITICAL_TYPES.has(seq.type) || job.pending.length >= FLUSH_EVENTS) flush(job);
  else scheduleFlush(job);
}

/** Close the in-flight coalesced text event, if any. */
function closeOpenText(job: LiveJob): void {
  const open = job.openText;
  if (!open) return;
  if (open.timer) clearTimeout(open.timer);
  job.openText = null;
  publish(job, { ...open.extra, type: "text", text: open.parts.join("") });
}

/**
 * Merge consecutive text deltas.
 *
 * Agents emit token-level deltas; persisting each as a row would produce
 * hundreds of thousands of rows for a long run and make replay pathological.
 * Any non-text event closes the open run, so ordering between prose and
 * structural events is preserved exactly.
 */
function emitText(job: LiveJob, event: Record<string, unknown>): void {
  const text = String(event.text ?? "");
  const { text: _drop, type: _type, ...extra } = event;

  // A text event carrying extra fields (e.g. a review pass tag) must not merge
  // with one carrying different fields, or the tag would apply to both.
  if (job.openText && JSON.stringify(job.openText.extra) !== JSON.stringify(extra)) {
    closeOpenText(job);
  }

  if (!job.openText) {
    job.openText = { parts: [], bytes: 0, extra, timer: null };
    job.openText.timer = setTimeout(() => closeOpenText(job), TEXT_COALESCE_MS);
    job.openText.timer.unref?.();
  }
  job.openText.parts.push(text);
  job.openText.bytes += text.length;
  if (job.openText.bytes >= TEXT_COALESCE_BYTES) closeOpenText(job);
}

function emit(job: LiveJob, event: Record<string, unknown>): void {
  const type = String(event.type ?? "unknown");

  if (job.eventCount >= MAX_EVENTS) {
    if (type === "text") {
      if (!job.cappedNotified) {
        job.cappedNotified = true;
        closeOpenText(job);
        publish(job, {
          type: "warning",
          warning: `event cap reached (${MAX_EVENTS}); further agent text is not recorded. Structural events continue.`,
        });
      }
      return;
    }
  }

  if (type === "text") emitText(job, event);
  else { closeOpenText(job); publish(job, event); }
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

function finalize(
  job: LiveJob,
  status: JobStatus,
  skillId: string,
  input: unknown,
  envelope: SkillEnvelope | null,
  error: string | null,
): void {
  closeOpenText(job);

  let skillRunId: number | null = null;
  if (envelope) {
    try {
      skillRunId = saveSkillRun(skillId, envelope.status, JSON.stringify(input ?? {}), JSON.stringify(envelope));
      envelope.meta = { ...envelope.meta, runId: skillRunId, jobId: job.id };
      db.prepare("UPDATE skill_runs SET result_json = ? WHERE id = ?")
        .run(JSON.stringify(envelope), skillRunId);
    } catch (err) {
      console.error(`[jobs] failed to persist skill run for job ${job.id}: ${(err as Error).message}`);
    }
  }

  // The terminal event is published BEFORE the row update so a subscriber that
  // sees job_done can immediately re-read the row and find it consistent.
  publish(job, { type: "job_done", status, ...(error ? { error } : {}), ...(envelope ? { envelope } : {}) });
  flush(job);

  try {
    db.prepare(
      "UPDATE jobs SET status = ?, result_json = ?, error = ?, skill_run_id = ?, ended_at = ? WHERE id = ?",
    ).run(status, envelope ? JSON.stringify(envelope) : null, error, skillRunId, nowIso(), job.id);
  } catch (err) {
    console.error(`[jobs] failed to finalize job ${job.id}: ${(err as Error).message}`);
  }

  for (const fn of job.subscribers) {
    try { fn({ seq: -1, at: nowIso(), type: "__end" }); } catch { /* ignore */ }
  }
  job.subscribers.clear();
  live.delete(job.id);
}

export interface StartOptions {
  clientKey?: string;
}

/**
 * Create a job row and begin executing it. Returns immediately.
 *
 * Callers must have already validated input and resolved agent profiles — a job
 * that cannot possibly run should never be born, because once it exists its
 * failure is only visible inside the event stream.
 */
export function startJob(
  skillId: string,
  input: unknown,
  executor: JobExecutor,
  opts: StartOptions = {},
): number {
  // True idempotency: the key identifies the REQUEST, not the attempt, so a
  // repeat returns the same job whatever its status.
  //
  // Matching only in-flight jobs would be both wrong and unsafe. Wrong, because
  // a client retrying after a dropped response would start a second 25-minute
  // pipeline over work that already succeeded. Unsafe, because `client_key` is
  // UNIQUE, so the insert would throw instead of degrading gracefully.
  if (opts.clientKey) {
    const existing = db.prepare(
      "SELECT id FROM jobs WHERE client_key = ?",
    ).get(opts.clientKey) as { id: number } | undefined;
    if (existing) return existing.id;
  }

  const info = db.prepare(
    "INSERT INTO jobs (skill_id, status, client_key, input_json, created_at) VALUES (?, 'queued', ?, ?, ?)",
  ).run(skillId, opts.clientKey ?? null, JSON.stringify(input ?? {}), nowIso());
  const jobId = Number(info.lastInsertRowid);

  const job: LiveJob = {
    id: jobId,
    controller: new AbortController(),
    lastSeq: 0,
    pending: [],
    subscribers: new Set(),
    openText: null,
    flushTimer: null,
    eventCount: 0,
    cappedNotified: false,
  };
  live.set(jobId, job);

  const ctx: JobContext = {
    jobId,
    emit: (event) => emit(job, event),
    signal: job.controller.signal,
    setRunning: () => {
      if (job.controller.signal.aborted) return;
      db.prepare("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'")
        .run(nowIso(), jobId);
      emit(job, { type: "job_running" });
    },
  };

  // Deliberately not awaited: the HTTP handler returns the id immediately and
  // the client subscribes to the event stream separately.
  void (async () => {
    try {
      const envelope = await executor(ctx);
      finalize(job, envelope.status === "error" ? "error" : "done", skillId, input, envelope, null);
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError" || job.controller.signal.aborted;
      const message = (err as Error)?.message ?? String(err);
      finalize(job, aborted ? "cancelled" : "error", skillId, input, null, aborted ? "cancelled by user" : message);
    }
  })();

  return jobId;
}

/**
 * Explicit cancellation — the only thing that stops a run.
 *
 * A queued job is marked immediately: its executor may not have reached the
 * point where it observes the signal (it could be waiting on a repo lock), and
 * the user should not have to wait for that to see the state change.
 */
export function cancelJob(jobId: number): boolean {
  const job = live.get(jobId);
  if (!job) return false;
  job.controller.abort();
  try {
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'queued'").run(jobId);
  } catch { /* the executor's finalize will set the terminal state */ }
  return true;
}

/** Abort every in-flight job. Used on shutdown. */
export function abortAllJobs(): void {
  for (const job of live.values()) job.controller.abort();
}

export function activeJobCount(): number {
  return live.size;
}

// ─── subscription ───────────────────────────────────────────────────────────

/**
 * Replay events after `fromSeq`, then stream new ones.
 *
 * Pending events are flushed first so the DB read is authoritative — that is
 * what makes replay and live tail meet exactly once, with no gap and no
 * duplicate. Returns an unsubscribe function; unsubscribing never affects the
 * job.
 */
export function subscribe(
  jobId: number,
  fromSeq: number,
  onEvent: (e: SeqEvent) => void,
): () => void {
  const job = live.get(jobId);
  if (job) { closeOpenText(job); flush(job); }

  const rows = db.prepare(
    "SELECT seq, at, type, payload FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
  ).all(jobId, fromSeq) as Array<{ seq: number; at: string; type: string; payload: string }>;

  for (const row of rows) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* keep the envelope */ }
    onEvent({ ...parsed, seq: row.seq, at: row.at, type: row.type });
  }

  if (!job) {
    // Terminal already: tell the reader there is nothing more coming.
    onEvent({ seq: -1, at: nowIso(), type: "__end" });
    return () => { /* nothing to detach */ };
  }

  job.subscribers.add(onEvent);
  return () => { job.subscribers.delete(onEvent); };
}

// ─── boot + retention ───────────────────────────────────────────────────────

/**
 * Mark runs that a previous process left in flight.
 *
 * Same shape as the `test_runs` reaper: without it a killed run shows a stuck
 * spinner forever. A synthetic terminal event is appended so a client replaying
 * the stream reaches a clean end instead of hanging.
 */
export function sweepInterruptedJobs(): number {
  try {
    const stale = db.prepare(
      "SELECT id, last_seq FROM jobs WHERE status IN ('queued','running')",
    ).all() as Array<{ id: number; last_seq: number }>;
    if (stale.length === 0) return 0;

    const at = nowIso();
    const sweep = db.transaction(() => {
      for (const row of stale) {
        insertEvent.run(
          row.id, row.last_seq + 1, at, "error",
          JSON.stringify({ error: "server restarted mid-run" }),
        );
        insertEvent.run(
          row.id, row.last_seq + 2, at, "job_done",
          JSON.stringify({ status: "interrupted" }),
        );
        db.prepare("UPDATE jobs SET status='interrupted', last_seq=?, ended_at=?, error=COALESCE(error,'server restarted mid-run') WHERE id=?")
          .run(row.last_seq + 2, at, row.id);
      }
    });
    sweep();
    console.log(`[jobs] marked ${stale.length} interrupted job(s) from a previous process`);
    return stale.length;
  } catch (err) {
    console.error(`[jobs] sweep failed: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Drop event streams for old finished jobs.
 *
 * The `jobs` rows stay: they are small, and `result_json` is the durable record
 * the history UI reads. Only the (potentially large) transcripts age out.
 */
export function pruneJobEvents(olderThanDays = 14): number {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = db.prepare(
      "DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE ended_at IS NOT NULL AND ended_at < ?)",
    ).run(cutoff);
    return info.changes;
  } catch (err) {
    console.error(`[jobs] prune failed: ${(err as Error).message}`);
    return 0;
  }
}

// ─── reads ──────────────────────────────────────────────────────────────────

export interface JobRow {
  id: number;
  skill_id: string;
  status: JobStatus;
  input_json: string;
  result_json: string | null;
  error: string | null;
  skill_run_id: number | null;
  last_seq: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export function getJob(jobId: number): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
}

export function listJobs(filter: { status?: JobStatus[]; skillId?: string; limit?: number } = {}): JobRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status?.length) {
    clauses.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  if (filter.skillId) { clauses.push("skill_id = ?"); params.push(filter.skillId); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.min(filter.limit ?? 50, 200));
  return db.prepare(
    `SELECT id, skill_id, status, error, skill_run_id, last_seq, created_at, started_at, ended_at, input_json
     FROM jobs ${where} ORDER BY id DESC LIMIT ?`,
  ).all(...params) as JobRow[];
}
