/**
 * Auto-documentation generator — uses Sonnet to produce structured
 * markdown docs from diffs and summaries whenever an agent action completes.
 *
 * Called as fire-and-forget after patch_done or saveSkillRun().
 */

import { db, nowIso, type DocRow } from "../../db.js";
import { ask } from "../../llm.js";

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

/**
 * Generate and persist a documentation entry for an agent action.
 * Returns the new doc row ID, or -1 on failure (never throws).
 */
export async function generateDoc(args: GenerateDocArgs): Promise<number> {
  try {
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

    const content = await ask(prompt, {
      model: "sonnet",
      timeoutMs: 60_000,
    });

    const now = nowIso();
    const stmt = db.prepare(`
      INSERT INTO docs (source_type, source_id, skill_id, title, content, files_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      args.sourceType,
      args.sourceId,
      args.skillId ?? null,
      args.featureName,
      content.trim(),
      JSON.stringify(args.filesChanged),
      now,
      now,
    );
    console.log(`[docs] generated doc #${info.lastInsertRowid} for ${args.sourceType}/${args.sourceId}`);
    return info.lastInsertRowid as number;
  } catch (err) {
    console.error("[docs] failed to generate doc:", err);
    return -1;
  }
}

/**
 * Re-generate a doc from its stored source data.
 * Looks up the original patch/skill run to get the diff + summary.
 */
export async function regenerateDoc(docId: number): Promise<DocRow | null> {
  const doc = db.prepare("SELECT * FROM docs WHERE id = ?").get(docId) as DocRow | undefined;
  if (!doc) return null;

  // Try to get the original source data
  let diff = "";
  let summary = "";
  let filesChanged: string[] = [];
  let repoKey: "web" | "mobile" = "web";

  if (doc.source_type === "patch") {
    const patch = db.prepare("SELECT * FROM patches WHERE id = ?").get(doc.source_id) as {
      diff_path: string;
      summary: string;
      repo: string;
    } | undefined;
    if (patch) {
      summary = patch.summary;
      repoKey = patch.repo as "web" | "mobile";
      try {
        const fs = await import("node:fs");
        diff = fs.readFileSync(patch.diff_path, "utf8");
      } catch { /* diff file missing */ }
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

  const newId = await generateDoc({
    sourceType: doc.source_type,
    sourceId: doc.source_id,
    skillId: doc.skill_id ?? undefined,
    diff,
    summary,
    featureName: doc.title,
    filesChanged,
    repoKey,
  });

  if (newId > 0) {
    // Delete old doc
    db.prepare("DELETE FROM docs WHERE id = ?").run(docId);
    return db.prepare("SELECT * FROM docs WHERE id = ?").get(newId) as DocRow;
  }
  return null;
}
