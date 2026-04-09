import { Router } from "express";
import { runAnalysis } from "../analyzer/index.js";
import { db } from "../db.js";
import { activeSubprocessCount, killAllSubprocesses } from "../llm.js";

export const analyzeRouter = Router();

// Single in-memory lock — analysis is heavy and we only ever want one running.
let running = false;

analyzeRouter.post("/analyze", (_req, res) => {
  if (running) {
    return res.status(409).json({ error: "analysis already running" });
  }
  running = true;
  // Fire-and-forget so HTTP returns immediately. The frontend polls
  // /reports/latest until status flips to "done".
  runAnalysis()
    .then((r) =>
      console.log(
        `[analyze] done: report ${r.reportId} (${r.gapCount} gaps, ${(r.durationMs / 1000).toFixed(1)}s)`,
      ),
    )
    .catch((e) => console.error(`[analyze] failed:`, e))
    .finally(() => {
      running = false;
    });
  res.status(202).json({ accepted: true });
});

analyzeRouter.post("/analyze/cancel", (_req, res) => {
  const killed = killAllSubprocesses();
  // Mark the latest running report as failed so the UI flips out of polling.
  db.prepare(
    `UPDATE reports SET status = 'failed', error = 'cancelled by user'
     WHERE status = 'running'`,
  ).run();
  running = false;
  console.log(`[analyze] cancelled, killed ${killed} subprocess(es)`);
  res.json({ cancelled: true, killed });
});

analyzeRouter.get("/analyze/status", (_req, res) => {
  res.json({
    running,
    activeSubprocesses: activeSubprocessCount(),
  });
});

analyzeRouter.get("/reports/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT * FROM reports ORDER BY id DESC LIMIT 1`)
    .get();
  res.json(row ?? null);
});

analyzeRouter.get("/reports", (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM reports ORDER BY id DESC LIMIT 50`)
    .all();
  res.json(rows);
});

analyzeRouter.get("/gaps", (req, res) => {
  const reportIdParam = req.query.report_id;
  const reportId =
    reportIdParam !== undefined
      ? Number(reportIdParam)
      : (
          db
            .prepare(`SELECT id FROM reports ORDER BY id DESC LIMIT 1`)
            .get() as { id: number } | undefined
        )?.id;

  if (!reportId) return res.json([]);

  const rows = db
    .prepare(
      `SELECT * FROM gaps
       WHERE report_id = ?
       ORDER BY category, missing_in, canonical_name`,
    )
    .all(reportId);

  // Parse evidence JSON for the client.
  const parsed = rows.map((r: any) => ({
    ...r,
    evidence: safeParse(r.evidence),
  }));
  res.json(parsed);
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
