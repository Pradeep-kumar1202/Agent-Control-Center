/**
 * Auto-documentation generator — uses Sonnet to produce two markdown bodies
 * for every completed agent action:
 *
 *   1. `content`          — internal-style dev notes (What it does / How it
 *                            was implemented / Configuration / Testing notes).
 *   2. `official_content` — GitBook-ready copy matching docs.hyperswitch.io.
 *
 * Both live on the same docs row. The official body is skipped for the
 * `tests` skill (Cypress/Detox scaffolding isn't public API).
 *
 * Called as fire-and-forget after patch_done or saveSkillRun(); failures are
 * logged but never thrown back to the caller.
 */

import fs from "node:fs";
import { db, nowIso, type DocRow } from "../../db.js";
import { ask } from "../../llm.js";
import { buildOfficialPrompt } from "./officialPrompt.js";

export interface GenerateDocArgs {
  sourceType: "patch" | "skill" | "integration" | "feature";
  sourceId: number;
  skillId?: string;
  diff: string;
  summary: string;
  featureName: string;
  filesChanged: string[];
  repoKey: "web" | "mobile";
}

/** Skills whose runs never produce public documentation. */
const NO_OFFICIAL_DOC_SKILLS = new Set(["tests", "review"]);

/**
 * Generate both markdown bodies and persist them on a new docs row. Returns
 * the new row id, or -1 on failure (never throws).
 */
export async function generateDoc(args: GenerateDocArgs): Promise<number> {
  try {
    const content = await askForInternalContent(args);

    const now = nowIso();
    const insert = db.prepare(`
      INSERT INTO docs (source_type, source_id, skill_id, title, content, files_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insert.run(
      args.sourceType,
      args.sourceId,
      args.skillId ?? null,
      args.featureName,
      content,
      JSON.stringify(args.filesChanged),
      now,
      now,
    );
    const docId = info.lastInsertRowid as number;
    console.log(`[docs] generated internal doc #${docId} for ${args.sourceType}/${args.sourceId}`);

    // Fire-and-forget official copy. Failure here never blocks the caller
    // and never rolls back the internal row we just inserted.
    void tryWriteOfficialContent(docId, args);

    return docId;
  } catch (err) {
    console.error("[docs] failed to generate doc:", err);
    return -1;
  }
}

/**
 * Regenerate BOTH bodies of an existing doc in place. Preserves the row id
 * so docs links elsewhere in the UI don't break.
 */
export async function regenerateDoc(docId: number): Promise<DocRow | null> {
  const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(docId) as DocRow | undefined;
  if (!doc) return null;

  const source = loadSourceForDoc(doc);
  const args: GenerateDocArgs = {
    sourceType: doc.source_type,
    sourceId: doc.source_id,
    skillId: doc.skill_id ?? undefined,
    diff: source.diff,
    summary: source.summary,
    featureName: doc.title,
    filesChanged: source.filesChanged,
    repoKey: source.repoKey,
  };

  try {
    const content = await askForInternalContent(args);
    db.prepare("UPDATE docs SET content = ?, updated_at = ? WHERE id = ?")
      .run(content, nowIso(), docId);
  } catch (err) {
    console.error(`[docs] regenerate(${docId}) internal content failed:`, err);
    // Fall through — we still try to refresh the official body so the user
    // gets something new from the click.
  }

  if (!NO_OFFICIAL_DOC_SKILLS.has(args.skillId ?? "")) {
    await tryWriteOfficialContent(docId, args);
  }

  return db.prepare("SELECT * FROM docs WHERE id = ?").get(docId) as DocRow;
}

/**
 * Regenerate ONLY the official body of an existing doc, preserving the
 * internal content untouched. Used by the per-block "Regen Official" button
 * and the empty-state "Generate official doc" backfill button.
 */
export async function generateOfficialOnly(docId: number): Promise<DocRow | null> {
  const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(docId) as DocRow | undefined;
  if (!doc) return null;

  const source = loadSourceForDoc(doc);
  const args: GenerateDocArgs = {
    sourceType: doc.source_type,
    sourceId: doc.source_id,
    skillId: doc.skill_id ?? undefined,
    diff: source.diff,
    summary: source.summary,
    featureName: doc.title,
    filesChanged: source.filesChanged,
    repoKey: source.repoKey,
  };

  await tryWriteOfficialContent(docId, args);
  return db.prepare("SELECT * FROM docs WHERE id = ?").get(docId) as DocRow;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function askForInternalContent(args: GenerateDocArgs): Promise<string> {
  const filesSection = args.filesChanged.length > 0
    ? `\nFiles changed:\n${args.filesChanged.map((f) => `- ${f}`).join("\n")}`
    : "";

  const prompt = `You are a technical documentation writer for a payment SDK.
Given the following information about a code change, write clear, structured documentation.

Feature: ${args.featureName}
Repository: ${args.repoKey === "web" ? "hyperswitch-web (ReScript)" : "hyperswitch-client-core (ReScript mobile)"}
Summary: ${args.summary}
${filesSection}

Diff (first 3000 chars):
\`\`\`
${args.diff.slice(0, 3000)}
\`\`\`

Write documentation in this exact format (no extra sections):

## ${args.featureName}

### What it does
(1-3 sentences describing the behavior this adds or changes)

### How it was implemented
(Bullet list of key changes — mention specific files and what was done in each)

### Configuration
(Any config keys, types, defaults added. Write "No configuration changes." if none)

### Testing notes
(How to verify this works — 1-3 bullet points)

Output ONLY the markdown, no preamble or explanation.`;

  const content = await ask(prompt, { model: "sonnet", timeoutMs: 120_000 });
  return content.trim();
}

/**
 * Run the official-style prompt and UPDATE the doc row. Never throws — any
 * failure just leaves the column as-is (NULL for new rows, stale for regen).
 */
async function tryWriteOfficialContent(docId: number, args: GenerateDocArgs): Promise<void> {
  if (NO_OFFICIAL_DOC_SKILLS.has(args.skillId ?? "")) {
    console.log(`[docs] skipping official content for doc #${docId} (skill=${args.skillId})`);
    return;
  }
  try {
    const prompt = buildOfficialPrompt({
      featureName: args.featureName,
      repoKey: args.repoKey,
      skillId: args.skillId,
      summary: args.summary,
      filesChanged: args.filesChanged,
      diff: args.diff,
    });
    const official = await ask(prompt, { model: "sonnet", timeoutMs: 120_000 });
    db.prepare("UPDATE docs SET official_content = ?, updated_at = ? WHERE id = ?")
      .run(official.trim(), nowIso(), docId);
    console.log(`[docs] wrote official content for doc #${docId}`);
  } catch (err) {
    console.error(`[docs] official-content generation failed for doc #${docId}:`, err);
  }
}

/**
 * Re-read the diff + summary + files list + repo that originally produced
 * a doc. Shared by regenerateDoc and generateOfficialOnly.
 */
function loadSourceForDoc(doc: DocRow): {
  diff: string;
  summary: string;
  filesChanged: string[];
  repoKey: "web" | "mobile";
} {
  let diff = "";
  let summary = "";
  let repoKey: "web" | "mobile" = "web";
  let filesChanged: string[] = [];

  if (doc.source_type === "patch") {
    const patch = db.prepare("SELECT * FROM patches WHERE id = ?").get(doc.source_id) as {
      diff_path: string;
      summary: string;
      repo: string;
    } | undefined;
    if (patch) {
      summary = patch.summary;
      repoKey = patch.repo as "web" | "mobile";
      try { diff = fs.readFileSync(patch.diff_path, "utf8"); } catch { /* diff file missing */ }
    }
  } else if (doc.source_type === "skill") {
    const run = db.prepare("SELECT * FROM skill_runs WHERE id = ?").get(doc.source_id) as {
      result_json: string;
      skill_id: string;
    } | undefined;
    if (run) {
      try {
        const result = JSON.parse(run.result_json);
        const firstRepo = Object.keys(result.results ?? {})[0];
        if (firstRepo && result.results[firstRepo]) {
          diff = result.results[firstRepo].diff ?? "";
          summary = result.results[firstRepo].summary ?? "";
          repoKey = firstRepo as "web" | "mobile";
        }
      } catch { /* parse failed */ }
    }
  }

  try { filesChanged = JSON.parse(doc.files_json); } catch { /* */ }

  return { diff, summary, filesChanged, repoKey };
}
