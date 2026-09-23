/**
 * Proof that a run survives everything that used to destroy it.
 *
 * The defect this replaces: runs lived on an HTTP response, so a reload, a
 * navigation, or a dropped connection killed the agent and left no record —
 * `saveSkillRun` only fired on success. A deliberate Stop and an accidental
 * disconnect were the same event at the server.
 *
 * Every assertion below is a property the dashboard now depends on:
 *   - replay after a disconnect reconstructs the transcript exactly
 *   - sequence numbers are monotonic and gap-free
 *   - unsubscribing does NOT cancel; only cancel cancels
 *   - a duplicate submission (StrictMode, double-click) reuses the job
 *   - a run killed with the server reappears as 'interrupted', not as nothing
 *
 * Runs against a throwaway database via ACC_DB_PATH, set before the dynamic
 * import so `db.ts` opens the temp file rather than the operator's real one.
 * No LLM calls: executors here are plain functions.
 *
 * Run: npx tsx server/src/scripts/checkJobs.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-jobs-"));
process.env.ACC_DB_PATH = path.join(tmpDir, "test.db");

const { db } = await import("../db.js");
const {
  startJob, cancelJob, subscribe, getJob, listJobs,
  sweepInterruptedJobs, pruneJobEvents,
} = await import("../jobs/runner.js");
const runner = await import("../jobs/runner.js");
type SeqEvent = import("../jobs/runner.js").SeqEvent;
type JobContext = import("../jobs/runner.js").JobContext;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}

const envelope = (status: "ok" | "partial" | "error" = "ok") =>
  ({ skillId: "test", status, results: {}, meta: {} });

/** Wait until a job reaches a terminal status, or time out. */
async function settle(jobId: number, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getJob(jobId);
    if (row && !["queued", "running"].includes(row.status)) return row.status;
    if (Date.now() > deadline) return `TIMEOUT(${row?.status ?? "missing"})`;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── 1. replay equals live, seq is monotonic and gap-free ───────────────────

async function testReplayEqualsLive(): Promise<void> {
  console.log("\nReplay reconstructs the transcript");

  const liveSeen: SeqEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  const jobId = startJob("test", { a: 1 }, async (ctx: JobContext) => {
    ctx.setRunning();
    ctx.emit({ type: "phase_marker", phase: "one" });
    ctx.emit({ type: "text", text: "hello " });
    ctx.emit({ type: "text", text: "world" });
    ctx.emit({ type: "phase_done", phase: "one", ms: 5 });
    await gate;
    ctx.emit({ type: "phase_marker", phase: "two" });
    return envelope();
  });

  const detach = subscribe(jobId, 0, (e) => { if (e.type !== "__end") liveSeen.push(e); });
  await new Promise((r) => setTimeout(r, 150));   // let the coalesce window close

  // Simulate the browser going away mid-run. This must NOT stop the job.
  detach();
  release();
  const status = await settle(jobId);
  check("job completed after its subscriber detached", status === "done", `status=${status}`);

  const replayed: SeqEvent[] = [];
  subscribe(jobId, 0, (e) => { if (e.type !== "__end") replayed.push(e); });

  const liveTypes = liveSeen.map((e) => `${e.seq}:${e.type}`);
  const replayPrefix = replayed.slice(0, liveSeen.length).map((e) => `${e.seq}:${e.type}`);
  check("replay reproduces what the live subscriber saw",
    JSON.stringify(liveTypes) === JSON.stringify(replayPrefix),
    `live=${liveTypes.join(",")}\n        replay=${replayPrefix.join(",")}`);

  const seqs = replayed.map((e) => e.seq);
  const gapFree = seqs.every((s, i) => s === i + 1);
  check("seq is monotonic and gap-free", gapFree, `seqs=${seqs.join(",")}`);

  const text = replayed.filter((e) => e.type === "text").map((e) => e.text).join("");
  check("consecutive text deltas coalesce into one event",
    text === "hello world" && replayed.filter((e) => e.type === "text").length === 1,
    `text=${JSON.stringify(text)} count=${replayed.filter((e) => e.type === "text").length}`);

  check("terminal job_done is persisted", replayed.at(-1)?.type === "job_done",
    `last=${replayed.at(-1)?.type}`);

  // Resuming from a known seq must not repeat what the client already has.
  const resumed: SeqEvent[] = [];
  subscribe(jobId, 2, (e) => { if (e.type !== "__end") resumed.push(e); });
  check("resume from seq N returns only newer events",
    resumed.every((e) => e.seq > 2) && resumed.length === replayed.length - 2,
    `got ${resumed.length}, expected ${replayed.length - 2}`);
}

// ─── 2. cancel is the only thing that stops a run ───────────────────────────

async function testCancel(): Promise<void> {
  console.log("\nCancellation");

  let observedAbort = false;
  const jobId = startJob("test", {}, async (ctx: JobContext) => {
    ctx.setRunning();
    await new Promise((r) => setTimeout(r, 3000));
    if (ctx.signal.aborted) { observedAbort = true; const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
    return envelope();
  });

  await new Promise((r) => setTimeout(r, 50));
  check("cancel returns true for a live job", cancelJob(jobId) === true);
  const status = await settle(jobId, 6000);
  check("cancelled run ends as 'cancelled'", status === "cancelled", `status=${status}`);
  check("executor observed the abort signal", observedAbort);

  // An executor that catches its own abort and RETURNS an error envelope (PR
  // Port does, to report preserved work) must still end as 'cancelled'.
  const returningId = startJob("test", {}, async (ctx: JobContext) => {
    ctx.setRunning();
    await new Promise((r) => setTimeout(r, 3000));
    return { ...envelope(), status: "error" as const };
  });
  await new Promise((r) => setTimeout(r, 50));
  cancelJob(returningId);
  const returningStatus = await settle(returningId, 6000);
  check("a cancelled run that returns an error envelope ends as 'cancelled'", returningStatus === "cancelled", `status=${returningStatus}`);

  // Queued: the executor may be blocked on a repo lock and cannot observe the
  // signal yet, so the status must flip immediately for the user.
  let startedWork = false;
  const queuedId = startJob("test", {}, async (ctx: JobContext) => {
    await new Promise((r) => setTimeout(r, 100));
    if (ctx.signal.aborted) { const e = new Error("cancelled"); e.name = "AbortError"; throw e; }
    startedWork = true;
    ctx.setRunning();
    return envelope();
  });
  cancelJob(queuedId);
  check("cancel while queued marks the row immediately",
    getJob(queuedId)?.status === "cancelled", `status=${getJob(queuedId)?.status}`);
  await settle(queuedId, 3000);
  check("a job cancelled while queued never starts work", startedWork === false);
}

// ─── 3. idempotency (StrictMode / double-click) ─────────────────────────────

async function testIdempotency(): Promise<void> {
  console.log("\nDuplicate submissions");

  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const exec = async (ctx: JobContext) => { runs++; ctx.setRunning(); await gate; return envelope(); };

  const first = startJob("test", {}, exec, { clientKey: "same-key" });
  const second = startJob("test", {}, exec, { clientKey: "same-key" });
  check("same clientKey returns the same job", first === second, `${first} vs ${second}`);
  check("the pipeline ran exactly once", runs === 1, `runs=${runs}`);

  release();
  await settle(first);

  // A retry after the run finished must resolve to the completed job, not start
  // a second pipeline over work that already succeeded.
  let ranAgain = false;
  const retry = startJob("test", {}, async (ctx) => { ranAgain = true; ctx.setRunning(); return envelope(); }, { clientKey: "same-key" });
  check("retrying a finished key returns the original job", retry === first, `${retry} vs ${first}`);
  check("retrying a finished key does not re-run it", ranAgain === false);

  const distinct = startJob("test", {}, async (ctx) => { ctx.setRunning(); return envelope(); }, { clientKey: "other-key" });
  check("a different key starts a new job", distinct !== first);
  await settle(distinct);
}

// ─── 4. failure and crash recovery ──────────────────────────────────────────

async function testFailureAndSweep(): Promise<void> {
  console.log("\nFailure and crash recovery");

  const failId = startJob("test", {}, async () => { throw new Error("boom"); });
  const failStatus = await settle(failId);
  check("a thrown executor ends as 'error'", failStatus === "error", `status=${failStatus}`);
  check("the failure message is persisted", (getJob(failId)?.error ?? "").includes("boom"));

  const errEnvId = startJob("test", {}, async (ctx) => { ctx.setRunning(); return envelope("error"); });
  check("an error envelope ends as 'error'", await settle(errEnvId) === "error");

  // Every terminal run must leave a durable record — the old pipeline wrote
  // nothing at all for a verifier rejection or an abort.
  check("a completed job records its skill_runs row", getJob(errEnvId)?.skill_run_id !== null);

  // Simulate `kill -9` mid-run: rows left 'running' with no live process.
  db.prepare("INSERT INTO jobs (skill_id, status, input_json, last_seq, created_at) VALUES ('test','running','{}',7,?)")
    .run(new Date().toISOString());
  const orphan = (db.prepare("SELECT MAX(id) AS id FROM jobs").get() as { id: number }).id;

  const swept = sweepInterruptedJobs();
  check("boot sweep marks orphaned runs", swept >= 1, `swept=${swept}`);
  check("orphan becomes 'interrupted'", getJob(orphan)?.status === "interrupted",
    `status=${getJob(orphan)?.status}`);

  // Without a synthetic terminal event, a client replaying the stream would
  // hang forever waiting for an end that never comes.
  const tail: SeqEvent[] = [];
  subscribe(orphan, 0, (e) => tail.push(e));
  check("interrupted run replays to a clean end",
    tail.some((e) => e.type === "job_done") && tail.at(-1)?.type === "__end",
    `types=${tail.map((e) => e.type).join(",")}`);
}

// ─── 5. listing and retention ───────────────────────────────────────────────

async function testListingAndPrune(): Promise<void> {
  console.log("\nListing and retention");

  const all = listJobs({});
  check("listJobs returns rows", all.length > 0, `count=${all.length}`);
  check("status filter works",
    listJobs({ status: ["cancelled"] }).every((j) => j.status === "cancelled"));

  const before = db.prepare("SELECT COUNT(*) AS n FROM job_events").get() as { n: number };
  check("events exist before pruning", before.n > 0, `n=${before.n}`);

  // Nothing is old enough yet, so a prune must be a no-op — retention must not
  // delete live history.
  check("prune spares recent jobs", pruneJobEvents(14) === 0);

  db.prepare("UPDATE jobs SET ended_at = ? WHERE ended_at IS NOT NULL")
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString());
  const pruned = pruneJobEvents(14);
  check("prune removes aged event streams", pruned > 0, `pruned=${pruned}`);
  check("job rows themselves survive pruning",
    (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n > 0);
}

async function main(): Promise<void> {
  console.log("jobs layer checks");
  try {
    await testReplayEqualsLive();
    await testCancel();
    await testIdempotency();
    await testFailureAndSweep();
    await testListingAndPrune();
  } finally {
    runner.abortAllJobs();
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nAll jobs checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
