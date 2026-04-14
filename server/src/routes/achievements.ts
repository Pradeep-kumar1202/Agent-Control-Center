/**
 * Achievements routes — read-only aggregation queries across all
 * dashboard activity: patches, skills, reviews, gaps, etc.
 *
 * GET /achievements/summary   — aggregate counts and metrics
 * GET /achievements/timeline  — daily activity for last 30 days
 * GET /achievements/recent    — last 20 actions as a unified feed
 */

import { Router } from "express";
import { db } from "../db.js";

export const achievementsRouter = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillBreakdownEntry {
  total: number;
  ok: number;
  partial: number;
  error: number;
}

interface AchievementsSummary {
  totalPatches: number;
  patchesPassed: number;
  patchesFailed: number;
  buildSuccessRate: number;
  totalPRs: number;
  totalSkillRuns: number;
  skillBreakdown: Record<string, SkillBreakdownEntry>;
  totalReviews: number;
  reviewBreakdown: Record<string, number>;
  totalGapsFound: number;
  gapsVerified: number;
  gapsDismissed: number;
  gapsPatched: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
}

interface TimelineEntry {
  date: string;
  patches: number;
  skills: number;
  reviews: number;
}

interface ActivityItem {
  type: "patch" | "skill" | "review";
  title: string;
  description: string;
  status: string;
  timestamp: string;
  meta: {
    prUrl?: string | null;
    branch?: string;
    repo?: string;
    skillId?: string;
  };
}

// ─── GET /achievements/summary ───────────────────────────────────────────────

achievementsRouter.get("/achievements/summary", (_req, res) => {
  // Patches
  const patchStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN build_status = 'pass' THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN build_status = 'fail' THEN 1 ELSE 0 END) AS failed
       FROM patches`,
    )
    .get() as { total: number; passed: number; failed: number };

  // PRs from patches
  const patchPRs = (
    db.prepare("SELECT COUNT(*) AS n FROM patches WHERE pr_url IS NOT NULL").get() as { n: number }
  ).n;

  // PRs from skill runs (count entries where result_json contains prUrl)
  const skillPRs = (
    db.prepare("SELECT COUNT(*) AS n FROM skill_runs WHERE result_json LIKE '%\"prUrl\"%'").get() as { n: number }
  ).n;

  // Skill runs
  const skillRows = db
    .prepare("SELECT skill_id, status, COUNT(*) AS cnt FROM skill_runs GROUP BY skill_id, status")
    .all() as { skill_id: string; status: string; cnt: number }[];

  const skillBreakdown: Record<string, SkillBreakdownEntry> = {};
  let totalSkillRuns = 0;
  for (const row of skillRows) {
    if (!skillBreakdown[row.skill_id]) {
      skillBreakdown[row.skill_id] = { total: 0, ok: 0, partial: 0, error: 0 };
    }
    skillBreakdown[row.skill_id].total += row.cnt;
    totalSkillRuns += row.cnt;
    if (row.status === "ok") skillBreakdown[row.skill_id].ok += row.cnt;
    else if (row.status === "partial") skillBreakdown[row.skill_id].partial += row.cnt;
    else if (row.status === "error") skillBreakdown[row.skill_id].error += row.cnt;
  }

  // Reviews
  const reviewRows = db
    .prepare("SELECT verdict, COUNT(*) AS cnt FROM reviews GROUP BY verdict")
    .all() as { verdict: string; cnt: number }[];

  const reviewBreakdown: Record<string, number> = {};
  let totalReviews = 0;
  for (const row of reviewRows) {
    reviewBreakdown[row.verdict] = row.cnt;
    totalReviews += row.cnt;
  }

  // Gaps
  const gapStats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
       FROM gaps`,
    )
    .get() as { total: number; verified: number };

  const dismissedCount = (
    db.prepare("SELECT COUNT(*) AS n FROM dismissed_gaps").get() as { n: number }
  ).n;

  // Gaps that have at least one patch
  const gapsPatched = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT gap_id) AS n FROM patches WHERE build_status = 'pass'",
      )
      .get() as { n: number }
  ).n;

  // Date range
  const dates = db
    .prepare(
      `SELECT MIN(ts) AS first_date, MAX(ts) AS last_date FROM (
         SELECT created_at AS ts FROM patches
         UNION ALL SELECT created_at AS ts FROM skill_runs
         UNION ALL SELECT reviewed_at AS ts FROM reviews
       )`,
    )
    .get() as { first_date: string | null; last_date: string | null };

  const summary: AchievementsSummary = {
    totalPatches: patchStats.total,
    patchesPassed: patchStats.passed,
    patchesFailed: patchStats.failed,
    buildSuccessRate:
      patchStats.total > 0
        ? Math.round((patchStats.passed / patchStats.total) * 100)
        : 0,
    totalPRs: patchPRs + skillPRs,
    totalSkillRuns,
    skillBreakdown,
    totalReviews,
    reviewBreakdown,
    totalGapsFound: gapStats.total,
    gapsVerified: gapStats.verified,
    gapsDismissed: dismissedCount,
    gapsPatched,
    firstActivityDate: dates.first_date,
    lastActivityDate: dates.last_date,
  };

  res.json(summary);
});

// ─── GET /achievements/timeline ──────────────────────────────────────────────

achievementsRouter.get("/achievements/timeline", (_req, res) => {
  // Generate last 30 days as a base
  const days: string[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const patchCounts = db
    .prepare(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS cnt
       FROM patches
       WHERE created_at >= ?
       GROUP BY day`,
    )
    .all(days[0]) as { day: string; cnt: number }[];

  const skillCounts = db
    .prepare(
      `SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS cnt
       FROM skill_runs
       WHERE created_at >= ?
       GROUP BY day`,
    )
    .all(days[0]) as { day: string; cnt: number }[];

  const reviewCounts = db
    .prepare(
      `SELECT SUBSTR(reviewed_at, 1, 10) AS day, COUNT(*) AS cnt
       FROM reviews
       WHERE reviewed_at >= ?
       GROUP BY day`,
    )
    .all(days[0]) as { day: string; cnt: number }[];

  const patchMap = new Map(patchCounts.map((r) => [r.day, r.cnt]));
  const skillMap = new Map(skillCounts.map((r) => [r.day, r.cnt]));
  const reviewMap = new Map(reviewCounts.map((r) => [r.day, r.cnt]));

  const timeline: TimelineEntry[] = days.map((d) => ({
    date: d,
    patches: patchMap.get(d) ?? 0,
    skills: skillMap.get(d) ?? 0,
    reviews: reviewMap.get(d) ?? 0,
  }));

  res.json(timeline);
});

// ─── GET /achievements/recent ────────────────────────────────────────────────

achievementsRouter.get("/achievements/recent", (_req, res) => {
  // Union last 20 across patches, skill_runs, reviews
  const patchRows = db
    .prepare(
      `SELECT p.id, p.branch, p.repo, p.summary, p.build_status, p.created_at, p.pr_url,
              g.canonical_name
       FROM patches p
       LEFT JOIN gaps g ON g.id = p.gap_id
       ORDER BY p.created_at DESC
       LIMIT 20`,
    )
    .all() as Array<{
    id: number;
    branch: string;
    repo: string;
    summary: string;
    build_status: string | null;
    created_at: string;
    pr_url: string | null;
    canonical_name: string | null;
  }>;

  const skillRunRows = db
    .prepare(
      `SELECT id, skill_id, status, input_json, created_at
       FROM skill_runs
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all() as Array<{
    id: number;
    skill_id: string;
    status: string;
    input_json: string;
    created_at: string;
  }>;

  const reviewRows = db
    .prepare(
      `SELECT id, branch, repo, verdict, reviewed_at
       FROM reviews
       ORDER BY reviewed_at DESC
       LIMIT 20`,
    )
    .all() as Array<{
    id: number;
    branch: string;
    repo: string;
    verdict: string;
    reviewed_at: string;
  }>;

  const items: ActivityItem[] = [];

  for (const p of patchRows) {
    items.push({
      type: "patch",
      title: p.canonical_name ?? `Patch on ${p.branch}`,
      description: p.summary?.slice(0, 120) ?? "",
      status: p.build_status ?? "unknown",
      timestamp: p.created_at,
      meta: { prUrl: p.pr_url, branch: p.branch, repo: p.repo },
    });
  }

  for (const s of skillRunRows) {
    let label = s.skill_id;
    try {
      const input = JSON.parse(s.input_json);
      if (input.propName) label = `Prop: ${input.propName}`;
      else if (input.branch) label = `${s.skill_id} on ${input.branch}`;
      else if (input.keyName) label = `Translation: ${input.keyName}`;
    } catch { /* ignore */ }
    items.push({
      type: "skill",
      title: label,
      description: `${s.skill_id} skill — ${s.status}`,
      status: s.status,
      timestamp: s.created_at,
      meta: { skillId: s.skill_id },
    });
  }

  for (const r of reviewRows) {
    items.push({
      type: "review",
      title: `Review: ${r.branch}`,
      description: `${r.verdict} — ${r.repo}`,
      status: r.verdict,
      timestamp: r.reviewed_at,
      meta: { branch: r.branch, repo: r.repo },
    });
  }

  // Sort by timestamp descending, take top 20
  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  res.json(items.slice(0, 20));
});
