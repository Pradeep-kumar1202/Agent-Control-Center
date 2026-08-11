/**
 * Persisted runtime settings: reusable profiles plus per-slot assignments.
 *
 * Shape is profiles + assignments rather than a flat slot->model map so a user
 * gets a simple default ("everything on `fast`") while retaining exact
 * per-stage overrides ("but the patch implementer runs on `coding`").
 *
 * Owns its own idempotent DDL, matching the `CREATE TABLE IF NOT EXISTS`
 * convention already used throughout db.ts.
 */

import { db, nowIso } from "../db.js";
import { isAgentSlot, type AgentSlot, type ModelRef, type RuntimeId } from "./types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

export interface Profile {
  runtime: RuntimeId;
  /** Passed to the CLI verbatim. */
  invocation: string;
  effort?: string;
}

export interface AgentSettings {
  profiles: Record<string, Profile>;
  /** Slot name -> profile name. The `default` key applies to any unassigned slot. */
  assignments: Record<string, string>;
}

const EMPTY: AgentSettings = { profiles: {}, assignments: {} };
const KEY = "agents";

const RUNTIMES: RuntimeId[] = ["claude-code", "codex", "opencode"];

export function isProfile(v: unknown): v is Profile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return RUNTIMES.includes(p.runtime as RuntimeId)
    && typeof p.invocation === "string" && p.invocation.trim().length > 0
    && (p.effort === undefined || typeof p.effort === "string");
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

export function getAgentSettings(): AgentSettings {
  const s = getSetting<AgentSettings>(KEY, EMPTY);
  return {
    profiles: s.profiles && typeof s.profiles === "object" ? s.profiles : {},
    assignments: s.assignments && typeof s.assignments === "object" ? s.assignments : {},
  };
}

export interface SettingsValidation {
  ok: boolean;
  errors: string[];
}

/** Reject bad input at the boundary; a malformed profile must never reach a spawn. */
export function validateAgentSettings(next: AgentSettings): SettingsValidation {
  const errors: string[] = [];
  for (const [name, p] of Object.entries(next.profiles ?? {})) {
    if (!isProfile(p)) errors.push(`profile "${name}" is invalid (needs runtime + non-empty invocation)`);
  }
  for (const [slot, profileName] of Object.entries(next.assignments ?? {})) {
    if (slot !== "default" && !isAgentSlot(slot)) errors.push(`unknown slot "${slot}"`);
    if (!next.profiles?.[profileName]) errors.push(`assignment "${slot}" references unknown profile "${profileName}"`);
  }
  return { ok: errors.length === 0, errors };
}

export function setAgentSettings(next: AgentSettings): SettingsValidation {
  const v = validateAgentSettings(next);
  if (v.ok) setSetting(KEY, next);
  return v;
}

/**
 * Seed profiles from env on first boot only, so headless and cron runs work
 * without anyone opening the UI.
 *
 *   ACC_PROFILE_FAST="claude-code:sonnet"
 *   ACC_PROFILE_CODING="opencode:litellm/open-large:high"
 *   ACC_ASSIGN_DEFAULT="fast"
 *   ACC_ASSIGN_PATCH_IMPLEMENTER="coding"
 *
 * Seeding, not layering: once written, the DB is the single source of truth and
 * env changes stop moving the needle. A four-level precedence chain nobody can
 * reason about is worse than one obvious rule.
 */
export function seedFromEnvIfEmpty(): AgentSettings {
  const existing = getAgentSettings();
  if (Object.keys(existing.profiles).length > 0) return existing;

  const profiles: Record<string, Profile> = {};
  const assignments: Record<string, string> = {};

  for (const [k, raw] of Object.entries(process.env)) {
    if (!raw) continue;
    const pm = k.match(/^ACC_PROFILE_(.+)$/);
    if (pm) {
      const [runtime, invocation, effort] = raw.split(":");
      const p = { runtime, invocation, effort } as Profile;
      if (isProfile(p)) profiles[pm[1].toLowerCase()] = p;
      continue;
    }
    const am = k.match(/^ACC_ASSIGN_(.+)$/);
    if (am) {
      const slot = am[1].toLowerCase().replace(/_/g, ".");
      assignments[slot === "default" ? "default" : slot] = raw;
    }
  }

  if (Object.keys(profiles).length === 0) return existing;
  const next: AgentSettings = { profiles, assignments };
  const v = validateAgentSettings(next);
  if (!v.ok) {
    console.warn(`[settings] ignoring env seed — ${v.errors.join("; ")}`);
    return existing;
  }
  setSetting(KEY, next);
  console.log(`[settings] seeded ${Object.keys(profiles).length} profile(s) from env`);
  return next;
}

/** Resolve one slot, or null when nothing is assigned. */
export function resolveSlot(slot: AgentSlot, settings = getAgentSettings()): ModelRef | null {
  const name = settings.assignments[slot] ?? settings.assignments.default;
  if (!name) return null;
  const p = settings.profiles[name];
  if (!p) return null;
  return {
    runtime: p.runtime,
    invocation: p.invocation,
    effort: p.effort,
    ...parseInvocation(p.runtime, p.invocation),
  };
}

/**
 * Split a provider-namespaced invocation for REPORTING only.
 *
 * The opaque string is always what gets passed to the CLI; these fields exist
 * so telemetry can answer "how did LiteLLM-hosted models compare" without
 * anyone reassembling them and getting it subtly wrong.
 */
function parseInvocation(runtime: RuntimeId, invocation: string): { modelProvider?: string; model?: string } {
  if (runtime === "opencode") {
    const slash = invocation.indexOf("/");
    if (slash > 0) return { modelProvider: invocation.slice(0, slash), model: invocation.slice(slash + 1) };
  }
  if (runtime === "claude-code") return { modelProvider: "anthropic", model: invocation };
  if (runtime === "codex") return { modelProvider: "openai", model: invocation };
  return {};
}
