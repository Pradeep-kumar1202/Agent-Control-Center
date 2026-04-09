import cors from "cors";
import express from "express";
import { PORT } from "./config.js";
import { db } from "./db.js";
import { analyzeRouter } from "./routes/analyze.js";
import { gapsRouter } from "./routes/gaps.js";
import { patchesRouter } from "./routes/patches.js";
import { propsRouter } from "./routes/props.js";
import { skillsRouter } from "./routes/skills.js";

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
app.use(gapsRouter);
app.use(patchesRouter);
app.use(propsRouter);   // legacy /props/generate (backward compat)
app.use(skillsRouter);  // /skills/* (new unified endpoint)

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
