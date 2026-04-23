/**
 * Unified skills router — mounts all skill endpoints under /skills/*.
 *
 * GET  /skills                     → skill manifest (list of available skills)
 * POST /skills/props/generate      → add a config prop (SkillEnvelope)
 * POST /skills/tests/generate      → write Cypress + Detox tests
 * POST /skills/translations/generate → translate key into all languages
 * POST /skills/review/generate     → comprehensive PR review
 */

import { Router } from "express";
import { spawnSync } from "node:child_process";
import { SKILLS } from "../skills/registry.js";
import { db, nowIso, type SkillRunRow, type TestRunRow } from "../db.js";
import { handlePropsSkill } from "../skills/props/index.js";
import { handleTestsSkill } from "../skills/tests/index.js";
import { handleTranslationsSkill } from "../skills/translations/index.js";
import { handleReviewSkill } from "../skills/review/index.js";
import { handleIntegrationSkill } from "../skills/integration/index.js";
import { runTestSuite, type TestRunSpec, type TestRunChunk } from "../skills/tests/runner.js";
import { ensureTestPrereqs } from "../skills/tests/prereqs.js";
import { withRepoLock } from "../workspace/mutex.js";
import type { RepoKey } from "../config.js";

export const skillsRouter = Router();

/** Returns the skills manifest so the frontend can discover available skills. */
skillsRouter.get("/skills", (_req, res) => {
  res.json(SKILLS);
});

skillsRouter.post("/skills/props/generate", handlePropsSkill);
skillsRouter.post("/skills/tests/generate", handleTestsSkill);
skillsRouter.post("/skills/translations/generate", handleTranslationsSkill);
skillsRouter.post("/skills/review/generate", handleReviewSkill);
skillsRouter.post("/skills/integration/generate", handleIntegrationSkill);

// ─── Skill run history ────────────────────────────────────────────────────

/** List past runs for a skill (newest first). Omits result_json for performance. */
skillsRouter.get("/skills/:skillId/runs", (req, res) => {
  const skillId = req.params.skillId;
  const rows = db
    .prepare(
      `SELECT id, skill_id, status, input_json, created_at
       FROM skill_runs
       WHERE skill_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(skillId);
  res.json(rows);
});

/** Get a single run with full result_json. */
skillsRouter.get("/skills/:skillId/runs/:runId", (req, res) => {
  const row = db
    .prepare("SELECT * FROM skill_runs WHERE id = ? AND skill_id = ?")
    .get(Number(req.params.runId), req.params.skillId) as SkillRunRow | undefined;
  if (!row) return res.status(404).json({ error: "run not found" });
  res.json(row);
});

/** Delete a run. */
skillsRouter.delete("/skills/:skillId/runs/:runId", (req, res) => {
  const info = db
    .prepare("DELETE FROM skill_runs WHERE id = ? AND skill_id = ?")
    .run(Number(req.params.runId), req.params.skillId);
  res.json({ deleted: info.changes > 0 });
});

/**
 * Run a generated test suite and stream the output as NDJSON.
 *
 * Body: { branch: string, repo: "web" | "mobile", testFiles?: string[] }
 *
 * Response: application/x-ndjson with events:
 *   {type: "log",    line: "..."}           — one line of test output
 *   {type: "result", exitCode, success}     — final pass/fail
 *   {type: "error",  error: "..."}          — runner-level error
 *   {type: "done"}                          — stream end
 */
skillsRouter.post("/skills/tests/run", async (req, res) => {
  const { branch, repo, testFiles, prUrl } = req.body as Partial<TestRunSpec> & {
    prUrl?: string;
  };
  if (!branch || !repo || !["web", "mobile"].includes(repo)) {
    return res.status(400).json({ error: "branch and repo ('web'|'mobile') are required" });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;
  res.on("close", () => { clientClosed = true; });

  // Create the history row up front so the UI can link to it from the very
  // first status update. Logs get flushed into this row at run end.
  const runId = db
    .prepare(
      `INSERT INTO test_runs (repo, branch, pr_url, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(repo, branch, prUrl ?? null, nowIso()).lastInsertRowid as number;

  const buffered: string[] = [];
  const BUF_CAP_BYTES = 512 * 1024; // ~500KB
  let bufBytes = 0;
  const push = (chunk: unknown) => {
    const s = JSON.stringify(chunk);
    if (bufBytes + s.length < BUF_CAP_BYTES) {
      buffered.push(s);
      bufBytes += s.length + 1;
    }
  };

  const writeLine = (chunk: TestRunChunk | { type: "run_id"; id: number }) => {
    push(chunk);
    if (clientClosed) return;
    try { res.write(JSON.stringify(chunk) + "\n"); } catch { /* socket closed */ }
  };

  // First chunk tells the UI which history row this run belongs to.
  writeLine({ type: "run_id", id: runId });

  let finalExit: number | null = null;
  let finalSuccess: boolean | null = null;
  let finalError: string | null = null;

  try {
    // Stream preview + mock-server startup into the same log pane before
    // the actual test process starts.
    await ensureTestPrereqs(repo as RepoKey, branch, (line) =>
      writeLine({ type: "log", line: `[prereq] ${line.replace(/^\[prereq\]\s*/, "")}` }),
    );

    await withRepoLock(repo as RepoKey, () =>
      runTestSuite({ branch, repo, testFiles }, (chunk) => {
        writeLine(chunk);
        if (chunk.type === "result") {
          finalExit = chunk.exitCode ?? null;
          finalSuccess = chunk.success ?? null;
        } else if (chunk.type === "error") {
          finalError = chunk.error ?? "unknown runner error";
        }
      }),
    );
  } catch (err) {
    finalError = (err as Error).message;
    writeLine({ type: "error", error: finalError });
    writeLine({ type: "done" });
  } finally {
    // Parse pass/fail from the last ~80 log lines.
    const { pass, fail } = parseCounts(buffered);

    const status: TestRunRow["status"] =
      finalError ? "error" : finalSuccess === true ? "passed" : finalSuccess === false ? "failed" : "error";

    try {
      db.prepare(
        `UPDATE test_runs
           SET status=?, ended_at=?, exit_code=?, pass_count=?, fail_count=?,
               logs_ndjson=?, error_message=?
         WHERE id=?`,
      ).run(
        status,
        nowIso(),
        finalExit,
        pass,
        fail,
        buffered.join("\n"),
        finalError,
        runId,
      );
    } catch (e) {
      console.error("[tests] failed to persist test run", runId, e);
    }

    if (!clientClosed) {
      res.end();
    }
  }
});

// Parse "N passing" / "N failing" (Cypress/mocha) and Detox's "Tests: N passed, M failed"
// from the tail of the log stream. Best-effort — returns 0/0 when absent.
function parseCounts(ndjsonLines: string[]): { pass: number; fail: number } {
  const tail = ndjsonLines.slice(-120);
  let pass = 0;
  let fail = 0;
  for (const entry of tail) {
    let line = "";
    try {
      const parsed = JSON.parse(entry) as { type?: string; line?: string };
      if (parsed.type !== "log" || typeof parsed.line !== "string") continue;
      line = parsed.line;
    } catch {
      continue;
    }
    // Cypress / mocha
    const p1 = line.match(/(\d+)\s+passing/);
    if (p1) pass = Math.max(pass, Number(p1[1]));
    const f1 = line.match(/(\d+)\s+failing/);
    if (f1) fail = Math.max(fail, Number(f1[1]));
    // Detox summary (jest-style). Captures "Tests:       3 passed, 1 failed, 4 total"
    const detoxPass = line.match(/Tests:[^\n]*?(\d+)\s+passed/);
    if (detoxPass) pass = Math.max(pass, Number(detoxPass[1]));
    const detoxFail = line.match(/Tests:[^\n]*?(\d+)\s+failed/);
    if (detoxFail) fail = Math.max(fail, Number(detoxFail[1]));
  }
  return { pass, fail };
}

// ─── Test run history ─────────────────────────────────────────────────────

/** List past test runs (newest first). Omits logs_ndjson for payload size. */
skillsRouter.get("/skills/tests/runs", (req, res) => {
  const { repo, branch, limit } = req.query as Record<string, string | undefined>;
  const conds: string[] = [];
  const params: Array<string> = [];
  if (repo) {
    conds.push("repo = ?");
    params.push(repo);
  }
  if (branch) {
    conds.push("branch = ?");
    params.push(branch);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = db
    .prepare(
      `SELECT id, repo, branch, pr_url, status, started_at, ended_at,
              exit_code, pass_count, fail_count, error_message
         FROM test_runs
         ${where}
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(...params, lim);
  res.json(rows);
});

/** Full row including logs_ndjson. */
skillsRouter.get("/skills/tests/runs/:id", (req, res) => {
  const row = db
    .prepare("SELECT * FROM test_runs WHERE id = ?")
    .get(Number(req.params.id)) as TestRunRow | undefined;
  if (!row) return res.status(404).json({ error: "run not found" });
  res.json(row);
});

/**
 * Resolve a GitHub PR URL to its head branch name via `gh pr view`. Allows
 * the "Run existing tests" form to accept either a plain branch or a PR URL.
 * Returns { branch, prUrl } on success or 400/502 on failure.
 */
skillsRouter.post("/skills/tests/resolve-pr", async (req, res) => {
  const { prUrl } = req.body as { prUrl?: string };
  if (!prUrl || !/^https?:\/\/github\.com\/.+\/pull\/\d+/.test(prUrl)) {
    return res.status(400).json({ error: "prUrl must be a GitHub PR URL" });
  }
  try {
    const r = spawnSync("gh", ["pr", "view", prUrl, "--json", "headRefName", "-q", ".headRefName"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (r.status !== 0) {
      return res.status(502).json({
        error: `gh pr view failed: ${(r.stderr || r.stdout || "").trim()}`,
      });
    }
    const branch = r.stdout.trim();
    if (!branch) {
      return res.status(502).json({ error: "gh pr view returned empty headRefName" });
    }
    res.json({ branch, prUrl });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
