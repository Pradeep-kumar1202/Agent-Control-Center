/**
 * Documentation routes — CRUD for auto-generated documentation.
 *
 * GET    /docs                         — list all docs (summary view)
 * GET    /docs/search?q=...            — search docs by title/content
 * GET    /docs/:id                     — full doc with content
 * DELETE /docs/:id                     — delete a doc
 * POST   /docs/:id/regenerate          — regenerate BOTH internal + official bodies
 * POST   /docs/:id/regenerate-official — regenerate ONLY the official body
 */

import { Router } from "express";
import { db, type DocRow } from "../db.js";
import { generateOfficialOnly, regenerateDoc } from "../skills/docs/generator.js";

export const docsRouter = Router();

// ─── List all docs (summary, no content body) ───────────────────────────────

docsRouter.get("/docs", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, source_type, source_id, skill_id, title, files_json, created_at, updated_at
       FROM docs
       ORDER BY created_at DESC`,
    )
    .all();
  res.json(rows);
});

// ─── Search docs ─────────────────────────────────────────────────────────────

docsRouter.get("/docs/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.json([]);
    return;
  }
  const pattern = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT id, source_type, source_id, skill_id, title, files_json, created_at, updated_at
       FROM docs
       WHERE title LIKE ? OR content LIKE ?
       ORDER BY created_at DESC`,
    )
    .all(pattern, pattern);
  res.json(rows);
});

// ─── Get single doc (full content) ──────────────────────────────────────────

docsRouter.get("/docs/:id", (req, res) => {
  const id = Number(req.params.id);
  const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(id) as DocRow | undefined;
  if (!doc) {
    res.status(404).json({ error: "Doc not found" });
    return;
  }
  res.json(doc);
});

// ─── Delete doc ──────────────────────────────────────────────────────────────

docsRouter.delete("/docs/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM docs WHERE id = ?").run(id);
  res.json({ deleted: result.changes > 0 });
});

// ─── Regenerate doc ──────────────────────────────────────────────────────────

docsRouter.post("/docs/:id/regenerate", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const doc = await regenerateDoc(id);
    if (!doc) {
      res.status(404).json({ error: "Doc not found or regeneration failed" });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Regenerate ONLY the official block (cheaper; leaves internal intact) ──

docsRouter.post("/docs/:id/regenerate-official", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const doc = await generateOfficialOnly(id);
    if (!doc) {
      res.status(404).json({ error: "Doc not found" });
      return;
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
