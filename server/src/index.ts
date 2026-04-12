import cors from "cors";
import express from "express";
import { PORT } from "./config.js";
import { db } from "./db.js";
import { analyzeRouter } from "./routes/analyze.js";
import { chatRouter } from "./routes/chat.js";
import { gapsRouter } from "./routes/gaps.js";
import { patchesRouter } from "./routes/patches.js";
import { previewRouter } from "./routes/preview.js";
import { propsRouter } from "./routes/props.js";
import { reviewsRouter } from "./routes/reviews.js";
import { skillsRouter } from "./routes/skills.js";
import { stopAllPreviews } from "./skills/previewManager.js";

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

app.use(analyzeRouter);
app.use(chatRouter);     // /patches/:id/chat (iteration 8 — in-drawer chat)
app.use(gapsRouter);
app.use(patchesRouter);
app.use(previewRouter);  // /preview/* (dev-server lifecycle for demo videos)
app.use(propsRouter);    // legacy /props/generate (backward compat)
app.use(reviewsRouter);  // /reviews/* (review history)
app.use(skillsRouter);   // /skills/* (new unified endpoint)

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
  server.close(() => process.exit(0));
  // Hard exit if close hangs
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
