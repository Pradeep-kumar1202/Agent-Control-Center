import cors from "cors";
import express from "express";
import { PORT } from "./config.js";
import { db } from "./db.js";
import { achievementsRouter } from "./routes/achievements.js";
import { analyzeRouter } from "./routes/analyze.js";
import { chatRouter } from "./routes/chat.js";
import { docsRouter } from "./routes/docs.js";
import { featureRouter } from "./routes/feature.js";
import { gapsRouter } from "./routes/gaps.js";
import { patchesRouter } from "./routes/patches.js";
import { previewRouter } from "./routes/preview.js";
import { propsRouter } from "./routes/props.js";
import { reviewsRouter } from "./routes/reviews.js";
import { settingsRouter } from "./routes/settings.js";
import { skillsRouter } from "./routes/skills.js";
import { lintAgents } from "./agents/loader.js";
import { seedFromEnvIfEmpty } from "./runtime/index.js";
import { stopAllPreviews } from "./skills/previewManager.js";
import { stopMockServer } from "./skills/embeddedMockServer.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  const counts = {
    reports: (db.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n,
    gaps: (db.prepare("SELECT COUNT(*) AS n FROM gaps").get() as { n: number }).n,
    patches: (db.prepare("SELECT COUNT(*) AS n FROM patches").get() as { n: number }).n,
  };
  res.json({ ok: true, counts });
});

app.use(achievementsRouter);
app.use(analyzeRouter);
app.use(chatRouter);     // /patches/:id/chat (iteration 8 — in-drawer chat)
app.use(docsRouter);     // /docs/* (auto-generated documentation)
app.use(featureRouter);  // /feature/* (interactive feature agent)
app.use(gapsRouter);
app.use(patchesRouter);
app.use(previewRouter);  // /preview/* (dev-server lifecycle for demo videos)
app.use(propsRouter);    // legacy /props/generate (backward compat)
app.use(reviewsRouter);  // /reviews/* (review history)
app.use(settingsRouter); // /settings, /runtimes/* (runtime + model assignment)
app.use(skillsRouter);   // /skills/* (new unified endpoint)

// Seed runtime profiles from env on first boot only, so headless runs
// (npm run analyze, cron) work without anyone opening the Settings page.
seedFromEnvIfEmpty();

// Fail fast on a malformed agent definition: a typo in agents/*.md should
// surface at `npm run dev`, not eight minutes into a patch run.
for (const issue of lintAgents()) console.warn(`[agents] ${issue}`);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// Tear down any running dev-server previews when the dashboard exits, so
// webpack workers / gradle daemons don't outlive us and squat on ports.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — stopping previews`);
  try {
    await stopAllPreviews();
  } catch (err) {
    console.error("[server] error stopping previews:", err);
  }
  try {
    await stopMockServer();
  } catch (err) {
    console.error("[server] error stopping mock server:", err);
  }
  server.close(() => process.exit(0));
  // Hard exit if close hangs
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
