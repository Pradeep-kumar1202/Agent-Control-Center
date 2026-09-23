/**
 * Client side of the durable job model.
 *
 * The rule that makes this StrictMode-safe and reload-proof:
 *
 *   **Starting a job is an ACTION. Watching one is an EFFECT.**
 *
 * Previously the patch panel called `POST .../patch/stream` from inside a mount
 * effect, so React 18 StrictMode's double-invoke fired two pipelines against the
 * same repo lock, and a reload silently killed the run. Here `startJob` is only
 * ever called from a click handler, and effects do nothing but subscribe —
 * subscribing twice is harmless, because a subscription is a read.
 *
 * A run therefore survives reload, navigation and network blips. The only thing
 * that stops it is `cancelJob`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readNdjson } from "./components/ndjson";

const BASE = "/api";

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface JobEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface JobRow {
  id: number;
  skill_id: string;
  status: JobStatus;
  input_json: string;
  result_json: string | null;
  error: string | null;
  last_seq: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

const TERMINAL: JobStatus[] = ["done", "error", "cancelled", "interrupted"];
export const isTerminal = (s: JobStatus): boolean => TERMINAL.includes(s);

/** Where a skill's in-flight job id is remembered across reloads. */
const storageKey = (skillId: string): string => `acc.job.${skillId}`;

export function rememberJob(skillId: string, jobId: number): void {
  try { localStorage.setItem(storageKey(skillId), String(jobId)); } catch { /* private mode */ }
}
export function forgetJob(skillId: string): void {
  try { localStorage.removeItem(storageKey(skillId)); } catch { /* private mode */ }
}
export function rememberedJob(skillId: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey(skillId));
    const id = raw ? Number(raw) : NaN;
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch { return null; }
}

// ─── API ────────────────────────────────────────────────────────────────────

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; slots?: string[] };
      if (body?.error) detail = body.error;
      if (body?.slots?.length) detail += ` Configure these slots in Settings: ${body.slots.join(", ")}.`;
    } catch { /* keep the status */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/**
 * Create a job. Returns as soon as the server has a row — it does not wait for
 * the run.
 *
 * `clientKey` is generated per call so a double-click or a retry after a
 * dropped response resolves to the same job instead of starting a second one.
 */
export async function startJob(
  skillId: string,
  input: unknown,
  headers: Record<string, string> = {},
): Promise<number> {
  const clientKey = crypto.randomUUID();
  const res = await fetch(`${BASE}/skills/${skillId}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ input, clientKey }),
  });
  // 409 with a jobId means "this exact work is already running" — attach to
  // that run instead of failing, so a second tab or a retry watches the same job.
  if (res.status === 409) {
    const body = await res.clone().json().catch(() => ({})) as { jobId?: number };
    if (typeof body.jobId === "number") {
      rememberJob(skillId, body.jobId);
      return body.jobId;
    }
  }
  const { jobId } = await asJson<{ jobId: number }>(res);
  rememberJob(skillId, jobId);
  return jobId;
}

export async function cancelJob(jobId: number): Promise<void> {
  await asJson(await fetch(`${BASE}/jobs/${jobId}/cancel`, { method: "POST" }));
}

export async function fetchJob(jobId: number): Promise<JobRow> {
  return asJson<JobRow>(await fetch(`${BASE}/jobs/${jobId}`));
}

export async function listJobs(params: { status?: JobStatus[]; skill?: string } = {}): Promise<JobRow[]> {
  const qs = new URLSearchParams();
  if (params.status?.length) qs.set("status", params.status.join(","));
  if (params.skill) qs.set("skill", params.skill);
  const { jobs } = await asJson<{ jobs: JobRow[] }>(await fetch(`${BASE}/jobs?${qs}`));
  return jobs;
}

/**
 * Stream a job's events, replaying everything after `fromSeq` first.
 *
 * Tolerant parsing is deliberate here: a server killed mid-write can leave a
 * truncated final line, and discarding a whole replayed transcript over one
 * damaged byte would defeat the purpose of persisting it.
 */
export async function* streamJobEvents(
  jobId: number,
  fromSeq: number,
  signal: AbortSignal,
): AsyncGenerator<JobEvent> {
  const res = await fetch(`${BASE}/jobs/${jobId}/events?from=${fromSeq}`, { signal });
  if (!res.ok || !res.body) throw new Error(`Cannot open job stream (HTTP ${res.status})`);
  yield* readNdjson<JobEvent>(res.body, { tolerant: true });
}

// ─── hook ───────────────────────────────────────────────────────────────────

export interface UseJobState {
  jobId: number | null;
  status: JobStatus | null;
  events: JobEvent[];
  result: unknown | null;
  error: string | null;
  /** True while a run exists and has not reached a terminal status. */
  active: boolean;
  /** Start a run. Call ONLY from an event handler, never from an effect. */
  start: (input: unknown, headers?: Record<string, string>) => Promise<void>;
  /** Explicit Stop. Distinct from closing the page, which does nothing. */
  cancel: () => Promise<void>;
  /** Forget the current run without stopping it. */
  clear: () => void;
}

/**
 * Attach to a skill's current job, resuming one left over from a previous page
 * load if there is one.
 */
export function useJob(skillId: string): UseJobState {
  const [jobId, setJobId] = useState<number | null>(() => rememberedJob(skillId));
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [result, setResult] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Survives re-subscription so a reconnect resumes rather than repainting.
  const lastSeq = useRef(0);

  useEffect(() => {
    if (jobId === null) return;
    const ctrl = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const row = await fetchJob(jobId);
        if (cancelled) return;
        setStatus(row.status);
        if (row.result_json) {
          try { setResult(JSON.parse(row.result_json)); } catch { /* leave null */ }
        }
        if (row.error) setError(row.error);

        for await (const event of streamJobEvents(jobId, lastSeq.current, ctrl.signal)) {
          if (cancelled) return;
          if (typeof event.seq === "number" && event.seq > 0) lastSeq.current = event.seq;
          setEvents((prev) => [...prev, event]);

          if (event.type === "job_running") setStatus("running");
          if (event.type === "error" && typeof event.error === "string") setError(event.error);
          if (event.type === "job_done") {
            setStatus(event.status as JobStatus);
            if (event.envelope !== undefined) setResult(event.envelope);
            forgetJob(skillId);
          }
        }
      } catch (err) {
        // An aborted fetch is this effect being cleaned up, not a run failure.
        if (!cancelled && (err as Error).name !== "AbortError") {
          setError((err as Error).message);
        }
      }
    })();

    return () => { cancelled = true; ctrl.abort(); };
  }, [jobId, skillId]);

  const start = useCallback(async (input: unknown, headers: Record<string, string> = {}) => {
    setEvents([]); setResult(null); setError(null); setStatus("queued");
    lastSeq.current = 0;
    try {
      setJobId(await startJob(skillId, input, headers));
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    }
  }, [skillId]);

  const cancel = useCallback(async () => {
    if (jobId === null) return;
    try { await cancelJob(jobId); } catch (err) { setError((err as Error).message); }
  }, [jobId]);

  const clear = useCallback(() => {
    forgetJob(skillId);
    setJobId(null); setStatus(null); setEvents([]); setResult(null); setError(null);
    lastSeq.current = 0;
  }, [skillId]);

  return {
    jobId, status, events, result, error,
    active: status !== null && !isTerminal(status),
    start, cancel, clear,
  };
}
