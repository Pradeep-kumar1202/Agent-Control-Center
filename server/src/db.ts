import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, DB_PATH, PATCHES_DIR } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PATCHES_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    web_sha     TEXT NOT NULL,
    mobile_sha  TEXT NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT
  );

  CREATE TABLE IF NOT EXISTS gaps (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id         INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    category          TEXT NOT NULL,
    canonical_name    TEXT NOT NULL,
    missing_in        TEXT NOT NULL,
    present_in        TEXT NOT NULL,
    evidence          TEXT NOT NULL,
    rationale         TEXT NOT NULL,
    severity          TEXT NOT NULL,
    platform_specific INTEGER NOT NULL DEFAULT 0,
    verified          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS patches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    gap_id        INTEGER NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
    repo          TEXT NOT NULL,
    branch        TEXT NOT NULL,
    diff_path     TEXT NOT NULL,
    summary       TEXT NOT NULL,
    files_touched INTEGER NOT NULL,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE(gap_id)
  );

  CREATE INDEX IF NOT EXISTS idx_gaps_report ON gaps(report_id);
  CREATE INDEX IF NOT EXISTS idx_patches_gap ON patches(gap_id);

  -- Tracks gaps that were verified as false_positive by Opus.
  -- Survives across re-runs and SHA changes so we never re-insert them.
  CREATE TABLE IF NOT EXISTS dismissed_gaps (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT NOT NULL,
    canonical_name  TEXT NOT NULL,
    missing_in      TEXT NOT NULL,
    reason          TEXT NOT NULL,
    found_in_missing TEXT,
    dismissed_at    TEXT NOT NULL,
    UNIQUE(category, canonical_name, missing_in)
  );
`);

// Migrate existing DBs that predate the verified column.
try {
  db.exec(`ALTER TABLE gaps ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`);
} catch {
  /* column already exists — ignore */
}

// Migrate: add build_status and build_log to patches.
try {
  db.exec(`ALTER TABLE patches ADD COLUMN build_status TEXT`);
} catch { /* already exists */ }
try {
  db.exec(`ALTER TABLE patches ADD COLUMN build_log TEXT`);
} catch { /* already exists */ }

export function nowIso(): string {
  return new Date().toISOString();
}

export type ReportRow = {
  id: number;
  created_at: string;
  web_sha: string;
  mobile_sha: string;
  status: "running" | "done" | "failed";
  error: string | null;
};

export type GapRow = {
  id: number;
  report_id: number;
  category: "payment_method" | "config" | "component" | "backend_api";
  canonical_name: string;
  missing_in: "web" | "mobile";
  present_in: "web" | "mobile";
  evidence: string;
  rationale: string;
  severity: "low" | "medium" | "high";
  platform_specific: 0 | 1;
  verified: 0 | 1;
};

export type PatchRow = {
  id: number;
  gap_id: number;
  repo: "web" | "mobile";
  branch: string;
  diff_path: string;
  summary: string;
  files_touched: number;
  status: "generated" | "failed";
  created_at: string;
  build_status: "pass" | "fail" | "skipped" | null;
  build_log: string | null;
};
