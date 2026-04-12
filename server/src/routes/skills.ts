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
import { handleIntegrationSkill } from "../skills/integration/index.js";

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
