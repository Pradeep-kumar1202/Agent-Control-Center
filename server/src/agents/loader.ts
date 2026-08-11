/**
 * Loader for the Markdown agent definitions in `<PROJECT_ROOT>/agents`.
 *
 * Definitions live outside `server/src` because `tsc` does not copy `.md` into
 * `dist/`, and adding a copy step buys nothing — PROJECT_ROOT-relative
 * resolution works identically under `tsx watch` and `node dist/index.js`, and
 * matches how `seed/` is already resolved.
 *
 * Frontmatter is hand-parsed: scalars and flat `[a, b]` lists only, no nested
 * maps. Same reasoning as config.ts's hand-rolled .env parser — a YAML
 * dependency is ~200 lines of behaviour for ~30 lines of need, and the moment a
 * definition wants a nested map it should have been a .ts file.
 *
 * Two rules make templated prompts safe, and both fail loudly rather than
 * silently producing a broken prompt:
 *
 *   1. a `{{VAR}}` in a body that is neither declared nor reserved → throws at LOAD
 *   2. a declared var not supplied → throws at RENDER
 *
 * Shipping a literal `{{SPEC_JSON}}` into a live prompt is the worst failure
 * mode of templated prompts, so it is made impossible instead of unlikely.
 * `lintAgents()` runs at boot so a typo surfaces at `npm run dev`, not eight
 * minutes into a patch run.
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import {
  isAccessPolicy, isAgentSlot,
  type AccessPolicy, type AgentSlot,
} from "../runtime/types.js";

export const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");

/**
 * Injected by the runtime layer, never declared in `vars:`, so that no prompt
 * file and no call site ever names a runtime.
 */
export const RESERVED_VARS = [
  "TOOL_NOTES", "OUTPUT_NOTES", "BUILD_COMMAND", "BUILD_NOTES",
  "SOURCE_DIR", "TARGET_DIR",
] as const;

export interface AgentDef {
  id: string;
  slot: AgentSlot;
  access: AccessPolicy;
  timeoutMs: number;
  output: "text" | "json";
  /** Parsed JSON Schema, resolved from the `schema:` path. */
  schema?: object;
  vars: string[];
  description?: string;
  body: string;
  sourcePath: string;
}

export interface RenderedAgent {
  def: AgentDef;
  prompt: string;
  schema?: object;
}

export class AgentDefinitionError extends Error {
  constructor(message: string, readonly agentId?: string) {
    super(message);
    this.name = "AgentDefinitionError";
  }
}

const cache = new Map<string, { def: AgentDef; mtimeMs: number }>();
const isDev = process.env.NODE_ENV !== "production";

// ─── frontmatter ─────────────────────────────────────────────────────────────

function parseFrontmatter(raw: string, sourcePath: string): { meta: Record<string, string | string[]>; body: string } {
  if (!raw.startsWith("---")) {
    throw new AgentDefinitionError(`${sourcePath}: missing --- frontmatter block`);
  }
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    throw new AgentDefinitionError(`${sourcePath}: unterminated frontmatter block`);
  }
  const head = raw.slice(3, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);

  const meta: Record<string, string | string[]> = {};
  for (const rawLine of head.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

// ─── includes ────────────────────────────────────────────────────────────────

const INCLUDE_RE = /<!--\s*include:\s*([^\s>]+?)\s*-->/g;
const MAX_INCLUDE_DEPTH = 2;

function expandIncludes(body: string, sourcePath: string, seen: string[] = []): string {
  return body.replace(INCLUDE_RE, (_m, rel: string) => {
    const abs = path.join(AGENTS_DIR, rel);
    if (seen.includes(abs)) {
      throw new AgentDefinitionError(`${sourcePath}: include cycle via ${rel}`);
    }
    if (seen.length >= MAX_INCLUDE_DEPTH) {
      throw new AgentDefinitionError(`${sourcePath}: include depth > ${MAX_INCLUDE_DEPTH} at ${rel}`);
    }
    if (!fs.existsSync(abs)) {
      throw new AgentDefinitionError(`${sourcePath}: included file not found: ${rel}`);
    }
    return expandIncludes(fs.readFileSync(abs, "utf8").trimEnd(), abs, [...seen, abs]);
  });
}

// ─── load ────────────────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

function usedVars(body: string): string[] {
  return [...new Set([...body.matchAll(VAR_RE)].map((m) => m[1]))];
}

export function loadAgent(id: string): AgentDef {
  const sourcePath = path.join(AGENTS_DIR, `${id}.md`);
  if (!fs.existsSync(sourcePath)) {
    throw new AgentDefinitionError(`no agent definition at ${sourcePath}`, id);
  }
  const mtimeMs = fs.statSync(sourcePath).mtimeMs;
  const hit = cache.get(id);
  if (hit && (!isDev || hit.mtimeMs === mtimeMs)) return hit.def;

  const raw = fs.readFileSync(sourcePath, "utf8");
  const { meta, body: rawBody } = parseFrontmatter(raw, sourcePath);
  const body = expandIncludes(rawBody, sourcePath).trimEnd();

  const str = (k: string): string | undefined =>
    typeof meta[k] === "string" ? (meta[k] as string) : undefined;

  const slot = str("slot");
  if (!isAgentSlot(slot)) {
    throw new AgentDefinitionError(`${sourcePath}: invalid or missing slot "${slot ?? ""}"`, id);
  }
  const access = str("access");
  if (!isAccessPolicy(access)) {
    throw new AgentDefinitionError(`${sourcePath}: invalid or missing access "${access ?? ""}"`, id);
  }
  const output = str("output") ?? "text";
  if (output !== "text" && output !== "json") {
    throw new AgentDefinitionError(`${sourcePath}: output must be "text" or "json"`, id);
  }

  const declared = Array.isArray(meta.vars) ? (meta.vars as string[]) : [];
  const allowed = new Set<string>([...declared, ...RESERVED_VARS]);
  const undeclared = usedVars(body).filter((v) => !allowed.has(v));
  if (undeclared.length > 0) {
    // Fail at load, not at render: a body referencing a var nobody supplies
    // would otherwise ship `{{FOO}}` verbatim into a live prompt.
    throw new AgentDefinitionError(
      `${sourcePath}: body uses undeclared variable(s) ${undeclared.join(", ")} — add to vars: or use a reserved var`,
      id,
    );
  }

  let schema: object | undefined;
  const schemaRel = str("schema");
  if (schemaRel) {
    const schemaPath = path.join(AGENTS_DIR, schemaRel);
    if (!fs.existsSync(schemaPath)) {
      throw new AgentDefinitionError(`${sourcePath}: schema not found: ${schemaRel}`, id);
    }
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as object;
    } catch (err) {
      throw new AgentDefinitionError(`${sourcePath}: schema ${schemaRel} is not valid JSON: ${(err as Error).message}`, id);
    }
  }

  const def: AgentDef = {
    id: str("id") ?? id,
    slot,
    access,
    timeoutMs: Number(str("timeoutMs") ?? 300_000),
    output,
    schema,
    vars: declared,
    description: str("description"),
    body,
    sourcePath,
  };
  cache.set(id, { def, mtimeMs });
  return def;
}

// ─── render ──────────────────────────────────────────────────────────────────

export type VarBag = Record<string, string | number | boolean | undefined>;

export function renderAgent(id: string, vars: VarBag, reserved: VarBag = {}): RenderedAgent {
  const def = loadAgent(id);
  const supplied: VarBag = { ...reserved, ...vars };

  const missing = def.vars.filter((v) => supplied[v] === undefined);
  if (missing.length > 0) {
    throw new AgentDefinitionError(
      `${def.id}: missing value(s) for declared variable(s) ${missing.join(", ")}`,
      def.id,
    );
  }

  const prompt = def.body.replace(VAR_RE, (_m, name: string) => {
    const v = supplied[name];
    if (v === undefined) {
      // Only reachable for a reserved var the runtime layer failed to inject.
      throw new AgentDefinitionError(`${def.id}: reserved variable ${name} was not injected`, def.id);
    }
    return String(v);
  });

  return { def, prompt, schema: def.schema };
}

// ─── discovery + lint ────────────────────────────────────────────────────────

export function listAgentIds(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("_") || entry.name === "schemas") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
        out.push(rel.replace(/\.md$/, ""));
      }
    }
  };
  walk(AGENTS_DIR, "");
  return out.sort();
}

export function listAgents(): AgentDef[] {
  return listAgentIds().map(loadAgent);
}

/**
 * Validate every definition. Returns human-readable problems; empty means clean.
 * Call at boot so a broken prompt fails fast instead of mid-run.
 */
export function lintAgents(): string[] {
  const issues: string[] = [];
  for (const id of listAgentIds()) {
    try {
      const def = loadAgent(id);
      const used = new Set(usedVars(def.body));
      for (const v of def.vars) {
        if (!used.has(v)) issues.push(`${id}: declares unused variable ${v}`);
      }
      if (def.output === "json" && !def.schema) {
        issues.push(`${id}: output is json but no schema is declared — parse-and-repair is the only fallback`);
      }
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  return issues;
}
