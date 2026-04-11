/**
 * Review history routes.
 *
 * GET  /reviews          → list of past reviews (newest first), no result JSON
 * GET  /reviews/:id      → full review including result_json
 * DELETE /reviews/:id    → remove a review from history
 */

import { Router } from "express";
import { db } from "../db.js";
import type { ReviewRow } from "../db.js";

export const reviewsRouter = Router();

reviewsRouter.get("/reviews", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, branch, base_branch, repo, verdict, reviewed_at
       FROM reviews
       ORDER BY reviewed_at DESC
       LIMIT 100`,
    )
    .all() as Omit<ReviewRow, "result_json">[];
  res.json(rows);
});

reviewsRouter.get("/reviews/:id", (req, res) => {
  const row = db
    .prepare(`SELECT * FROM reviews WHERE id = ?`)
    .get(Number(req.params.id)) as ReviewRow | undefined;
  if (!row) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.json(row);
});

reviewsRouter.delete("/reviews/:id", (req, res) => {
  const info = db
    .prepare(`DELETE FROM reviews WHERE id = ?`)
    .run(Number(req.params.id));
  if (info.changes === 0) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.json({ deleted: true });
});
