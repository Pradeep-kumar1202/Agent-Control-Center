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
import { SKILLS } from "../skills/registry.js";
import { handlePropsSkill } from "../skills/props/index.js";
import { handleTestsSkill } from "../skills/tests/index.js";
import { handleTranslationsSkill } from "../skills/translations/index.js";
import { handleReviewSkill } from "../skills/review/index.js";
import { runTestSuite, type TestRunSpec, type TestRunChunk } from "../skills/tests/runner.js";
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
  const { branch, repo, testFiles } = req.body as Partial<TestRunSpec>;
  if (!branch || !repo || !["web", "mobile"].includes(repo)) {
    return res.status(400).json({ error: "branch and repo ('web'|'mobile') are required" });
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let clientClosed = false;
  res.on("close", () => { clientClosed = true; });

  const writeLine = (chunk: TestRunChunk) => {
    if (clientClosed) return;
    try { res.write(JSON.stringify(chunk) + "\n"); } catch { /* socket closed */ }
  };

  try {
    await withRepoLock(repo as RepoKey, () =>
      runTestSuite(
        { branch, repo, testFiles },
        writeLine,
      ),
    );
  } catch (err) {
    writeLine({ type: "error", error: (err as Error).message });
    writeLine({ type: "done" });
  } finally {
    if (!clientClosed) {
      res.end();
    }
  }
});
