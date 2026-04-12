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

// PR links table — keyed by (canonical_name, category, missing_in), NOT gap_id,
// because gap IDs are reassigned on every re-run while the identity triple is stable.
db.exec(`
  CREATE TABLE IF NOT EXISTS gap_prs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL,
    category       TEXT NOT NULL,
    missing_in     TEXT NOT NULL,
    pr_url         TEXT NOT NULL,
    added_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gap_prs_identity
    ON gap_prs(canonical_name, category, missing_in);
`);

// Review history table — added as a separate exec so existing DBs get it
// automatically without needing a full schema drop.
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch      TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    repo        TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    result_json TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_branch ON reviews(branch);
  CREATE INDEX IF NOT EXISTS idx_reviews_at ON reviews(reviewed_at DESC);
`);

// Chat-with-the-patch-agent thread history. Each row is one "message" in
// the conversation. Tool uses get their own rows so the UI can render them
// as distinct chips without re-parsing blobs. Dropping a patch cascades
// the thread away with it.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id   INTEGER NOT NULL REFERENCES patches(id) ON DELETE CASCADE,
    turn       INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content    TEXT NOT NULL,
    tool_name  TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_patch_turn
    ON chat_messages(patch_id, turn, id);
`);

// Unified skill run history. Every skill (props, tests, translations, review)
// persists its full SkillEnvelope here so results survive modal close and
// page refresh. The list endpoint omits result_json for performance; full
// result is loaded on demand when the user clicks "View" in the history tab.
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id    TEXT NOT NULL,
    status      TEXT NOT NULL,
    input_json  TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_skill_runs_skill
    ON skill_runs(skill_id, created_at DESC);
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

// Migrate: add PR fields. Set when the patches route successfully pushes the
// branch to the bot fork and opens a PR via gh.
try {
  db.exec(`ALTER TABLE patches ADD COLUMN pr_url TEXT`);
} catch { /* already exists */ }
try {
  db.exec(`ALTER TABLE patches ADD COLUMN pr_number INTEGER`);
} catch { /* already exists */ }
try {
  db.exec(`ALTER TABLE patches ADD COLUMN pr_warning TEXT`);
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
  pr_url: string | null;
  pr_number: number | null;
  pr_warning: string | null;
};

export type ReviewRow = {
  id: number;
  branch: string;
  base_branch: string;
  repo: string;
  verdict: "approve" | "request_changes" | "comment" | "error";
  result_json: string;
  reviewed_at: string;
};

export type GapPrRow = {
  id: number;
  canonical_name: string;
  category: string;
  missing_in: string;
  pr_url: string;
  added_at: string;
};

export type ChatMessageRow = {
  id: number;
  patch_id: number;
  turn: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  created_at: string;
};

export type SkillRunRow = {
  id: number;
  skill_id: string;
  status: string;
  input_json: string;
  result_json: string;
  created_at: string;
};

/** Persist any skill's result envelope so it survives modal close + page refresh. */
export function saveSkillRun(
  skillId: string,
  status: string,
  inputJson: string,
  resultJson: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO skill_runs (skill_id, status, input_json, result_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(skillId, status, inputJson, resultJson, nowIso()).lastInsertRowid as number;
}

/** Persist a completed review to the database and return its new row ID. */
export function saveReview(
  branch: string,
  baseBranch: string,
  repo: string,
  verdict: ReviewRow["verdict"],
  resultJson: string,
): number {
  const stmt = db.prepare(`
    INSERT INTO reviews (branch, base_branch, repo, verdict, result_json, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(branch, baseBranch, repo, verdict, resultJson, nowIso());
  return info.lastInsertRowid as number;
}
