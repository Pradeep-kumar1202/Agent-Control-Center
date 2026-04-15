/**
 * Knowledge loader — reads .md knowledge files from the monorepo and caches
 * them in memory on first access. These are injected as system prompts into
 * coder and reviewer subprocesses via --append-system-prompt.
 *
 * Files (all in hyperswitch-client-core/):
 *   - WORKFLOW_NATIVE_SDK_INTEGRATION.md  (~1150 lines) — Full integration workflow
 *   - LEARNINGS.md                        (~204 lines)  — Practical pitfalls log
 *   - AGENTS.md                           (~286 lines)  — ReScript coding rules
 *
 * We read from the monorepo checkout (not the ACC workspace clone) since it's
 * the canonical location and is always available even before repos are cloned.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../../config.js";

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Monorepo root is one level above the ACC project root.
 * PROJECT_ROOT = .../Agent-Control-Center/
 * MONOREPO_ROOT = .../hyperswitch-unified/
 */
const MONOREPO_ROOT = path.resolve(PROJECT_ROOT, "..");

const CLIENT_CORE_DIR = path.join(MONOREPO_ROOT, "hyperswitch-client-core");

const KNOWLEDGE_FILES = {
  workflow: path.join(CLIENT_CORE_DIR, "WORKFLOW_NATIVE_SDK_INTEGRATION.md"),
  learnings: path.join(CLIENT_CORE_DIR, "LEARNINGS.md"),
  agents: path.join(CLIENT_CORE_DIR, "AGENTS.md"),
} as const;

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, string>();

async function loadFile(key: keyof typeof KNOWLEDGE_FILES): Promise<string> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const content = await readFile(KNOWLEDGE_FILES[key], "utf-8");
    cache.set(key, content);
    console.log(`[knowledge] Loaded ${key} (${content.split("\n").length} lines)`);
    return content;
  } catch (err) {
    console.warn(
      `[knowledge] Could not load ${key} from ${KNOWLEDGE_FILES[key]}: ${(err as Error).message}`,
    );
    cache.set(key, "");
    return "";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Full integration knowledge for mobile targets.
 * Includes: WORKFLOW + LEARNINGS + AGENTS (all 3 files).
 * Used by: sdk-integrator skill coder + reviewer when target = mobile.
 */
export async function loadMobileIntegrationKnowledge(): Promise<string> {
  const [workflow, learnings, agents] = await Promise.all([
    loadFile("workflow"),
    loadFile("learnings"),
    loadFile("agents"),
  ]);

  const sections: string[] = [];

  if (workflow) {
    sections.push(`<knowledge-workflow>
${workflow}
</knowledge-workflow>`);
  }

  if (learnings) {
    sections.push(`<knowledge-learnings>
${learnings}
</knowledge-learnings>`);
  }

  if (agents) {
    sections.push(`<knowledge-coding-rules>
${agents}
</knowledge-coding-rules>`);
  }

  if (sections.length === 0) return "";

  return `# Codebase Knowledge

The following sections contain critical knowledge about the codebase, integration workflow, known pitfalls, and coding rules. You MUST follow these when writing or reviewing code.

${sections.join("\n\n")}`;
}

/**
 * Coding knowledge for mobile targets (general coding tasks, not full integration).
 * Includes: LEARNINGS + AGENTS (no WORKFLOW — that's integration-specific).
 * Used by: coder skill when repos include mobile.
 */
export async function loadMobileCoderKnowledge(): Promise<string> {
  const [learnings, agents] = await Promise.all([
    loadFile("learnings"),
    loadFile("agents"),
  ]);

  const sections: string[] = [];

  if (learnings) {
    sections.push(`<knowledge-learnings>
${learnings}
</knowledge-learnings>`);
  }

  if (agents) {
    sections.push(`<knowledge-coding-rules>
${agents}
</knowledge-coding-rules>`);
  }

  if (sections.length === 0) return "";

  return `# Codebase Knowledge

The following sections contain practical learnings from past integrations and coding rules for this codebase. You MUST follow these when writing or reviewing code.

${sections.join("\n\n")}`;
}
