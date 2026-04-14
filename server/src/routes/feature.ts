/**
 * Feature Agent routes — interactive multi-turn feature building.
 *
 * POST   /feature/sessions              — create session with initial description
 * GET    /feature/sessions              — list all sessions
 * GET    /feature/sessions/:id          — session + messages
 * POST   /feature/sessions/:id/chat     — send message, stream NDJSON response
 * POST   /feature/sessions/:id/implement — trigger implementation phase
 * DELETE /feature/sessions/:id          — delete session
 */

import { Router } from "express";
import { db, nowIso, type FeatureSessionRow, type FeatureMessageRow } from "../db.js";
import { askStream, type StreamChunk } from "../llm.js";
import { REPOS, type RepoKey } from "../config.js";
import { withRepoLock } from "../workspace/mutex.js";
import { forceCheckoutBranch, commitWithSubmodules, getDiffWithSubmodules, resetSubmodules } from "../skills/submoduleGit.js";
import { runRescriptBuild } from "../skills/buildCheck.js";
import { pushBranchToFork, createPullRequest, pushSubmoduleToFork, rewriteGitmodulesToForks } from "../skills/githubPr.js";
import { generateDoc } from "../skills/docs/generator.js";
import simpleGit from "simple-git";

export const featureRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSession(id: number): FeatureSessionRow | undefined {
  return db.prepare("SELECT * FROM feature_sessions WHERE id = ?").get(id) as FeatureSessionRow | undefined;
}

function getMessages(sessionId: number): FeatureMessageRow[] {
  return db
    .prepare("SELECT * FROM feature_messages WHERE session_id = ? ORDER BY turn ASC, id ASC")
    .all(sessionId) as FeatureMessageRow[];
}

function nextTurn(sessionId: number): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(turn), -1) AS max_turn FROM feature_messages WHERE session_id = ?")
    .get(sessionId) as { max_turn: number };
  return row.max_turn + 1;
}

function saveMessage(sessionId: number, turn: number, role: string, content: string, toolName?: string): void {
  db.prepare(
    `INSERT INTO feature_messages (session_id, turn, role, content, tool_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, turn, role, content, toolName ?? null, nowIso());
}

// ─── POST /feature/sessions ──────────────────────────────────────────────────

featureRouter.post("/feature/sessions", (req, res) => {
  const { description } = req.body as { description: string };
  if (!description?.trim()) {
    res.status(400).json({ error: "description is required" });
    return;
  }
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO feature_sessions (title, status, repos, created_at, updated_at)
     VALUES (?, 'discovery', '["web","mobile"]', ?, ?)`,
  ).run(description.trim().slice(0, 100), now, now);

  const session = getSession(info.lastInsertRowid as number)!;
  res.json(session);
});

// ─── GET /feature/sessions ───────────────────────────────────────────────────

featureRouter.get("/feature/sessions", (_req, res) => {
  const sessions = db
    .prepare("SELECT * FROM feature_sessions ORDER BY updated_at DESC")
    .all() as FeatureSessionRow[];
  res.json(sessions);
});

// ─── GET /feature/sessions/:id ───────────────────────────────────────────────

featureRouter.get("/feature/sessions/:id", (req, res) => {
  const session = getSession(Number(req.params.id));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const messages = getMessages(session.id);
  res.json({ ...session, messages });
});

// ─── DELETE /feature/sessions/:id ────────────────────────────────────────────

featureRouter.delete("/feature/sessions/:id", (req, res) => {
  const result = db.prepare("DELETE FROM feature_sessions WHERE id = ?").run(Number(req.params.id));
  res.json({ deleted: result.changes > 0 });
});

// ─── POST /feature/sessions/:id/chat ─────────────────────────────────────────

featureRouter.post("/feature/sessions/:id/chat", async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { message } = req.body as { message: string };
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Save user message
  const turn = nextTurn(sessionId);
  saveMessage(sessionId, turn, "user", message);
  db.prepare("UPDATE feature_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);

  // Build system prompt with full history
  const messages = getMessages(sessionId);
  const history = messages
    .filter((m) => m.role !== "tool")
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const repos: string[] = JSON.parse(session.repos);
  // Use first repo's dir for codebase exploration
  const repoKey = repos[0] as RepoKey;
  const repoDir = REPOS[repoKey]?.dir;

  const systemPrompt = `You are a senior payment SDK architect helping to build a new feature.

Feature title: ${session.title}
Target repos: ${repos.join(", ")}
Current phase: ${session.status}

You have access to the codebase via Read/Glob/Grep to explore existing patterns and ask informed questions.

## Conversation so far
${history}

## Your task
Based on the conversation, either:
1. Ask clarifying questions about requirements, behavior, edge cases, target repos, or backward compatibility
2. If you have enough information, provide a complete feature spec and say "I have enough information to implement this feature."

Do NOT start implementing yet. Focus on understanding the requirements thoroughly.
Keep your response concise and focused.`;

  // Stream response
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  let assistantText = "";

  function writeLine(obj: unknown): void {
    if (!res.writableEnded) {
      res.write(JSON.stringify(obj) + "\n");
    }
  }

  try {
    await askStream(systemPrompt + "\n\nUser: " + message, {
      model: "opus",
      cwd: repoDir,
      allowedTools: ["Read", "Glob", "Grep"],
      timeoutMs: 300_000,
    }, (chunk) => {
      writeLine(chunk);
      if (chunk.type === "text") assistantText += chunk.text;
      // Save tool uses
      if (chunk.type === "tool_use") {
        const tool = chunk.tool as { name: string; input?: unknown } | undefined;
        saveMessage(sessionId, turn, "tool", JSON.stringify(tool?.input ?? {}), tool?.name ?? "unknown");
      }
    });

    // Save assistant response
    saveMessage(sessionId, turn, "assistant", assistantText);
    writeLine({ type: "done", turn });
  } catch (err) {
    writeLine({ type: "error", error: (err as Error).message });
  }

  if (!res.writableEnded) res.end();
});

// ─── POST /feature/sessions/:id/implement ────────────────────────────────────

featureRouter.post("/feature/sessions/:id/implement", async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Update status
  db.prepare("UPDATE feature_sessions SET status = 'implementing', updated_at = ? WHERE id = ?").run(nowIso(), sessionId);

  // Build conversation context
  const messages = getMessages(sessionId);
  const history = messages
    .filter((m) => m.role !== "tool")
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const repos: RepoKey[] = JSON.parse(session.repos);

  // Stream response
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  function writeLine(obj: unknown): void {
    if (!res.writableEnded) {
      res.write(JSON.stringify(obj) + "\n");
    }
  }

  const results: Record<string, { branch: string; diff: string; fileCount: number; prUrl: string | null; summary: string; error?: string }> = {};

  try {
    for (const repoKey of repos) {
      writeLine({ type: "repo_marker", repo: repoKey });
      const repoDir = REPOS[repoKey].dir;
      const slug = session.title.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 40);
      const branchName = `feat/feature-${slug}-${repoKey}`;

      const result = await withRepoLock(repoKey, async () => {
        try {
          await forceCheckoutBranch(repoDir, repoKey, "main");
          const git = simpleGit(repoDir);
          try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
          await git.checkoutLocalBranch(branchName);

          // Phase 1: Analyse patterns
          writeLine({ type: "phase_marker", phase: "analysing" });

          let planText = "";
          const analystPrompt = `You are analysing the ${repoKey === "web" ? "hyperswitch-web" : "hyperswitch-client-core"} repository at ${repoDir}.

The user wants to build this feature:
<conversation>
${history}
</conversation>

Study the existing codebase to understand patterns. Find similar features and extract the implementation pattern.

Output a JSON spec (no fences):
{
  "featureSummary": "one-sentence description",
  "referenceFeature": "name of most similar existing feature",
  "implementationSteps": ["ordered list of changes"],
  "filesToCreate": ["new files needed"],
  "filesToModify": ["existing files to edit"]
}`;

          await askStream(analystPrompt, {
            model: "opus",
            cwd: repoDir,
            allowedTools: ["Read", "Glob", "Grep"],
            timeoutMs: 600_000,
          }, (chunk) => {
            writeLine(chunk);
            if (chunk.type === "text") planText += chunk.text;
          });

          // Phase 2: Implement
          writeLine({ type: "phase_marker", phase: "implementing" });

          let agentText = "";
          const implementerPrompt = `You are implementing a feature in ${repoDir}.

Feature requirements (from conversation with user):
<conversation>
${history}
</conversation>

${planText ? `<analysis>\n${planText}\n</analysis>` : ""}

Implement the feature following existing codebase patterns.
After each batch of edits, run: npm run --silent re:build 2>&1 (Bash, timeout 240000)
If build fails, read all errors, find root cause, fix, re-run. No attempt limit.
When build is green, output a one-line summary.`;

          await askStream(implementerPrompt, {
            model: "opus",
            cwd: repoDir,
            allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            timeoutMs: 1_200_000,
          }, (chunk) => {
            writeLine(chunk);
            if (chunk.type === "text") agentText += chunk.text;
          });

          // Build gate
          const { diff, fileCount } = await getDiffWithSubmodules(repoDir, repoKey);
          if (fileCount === 0) {
            await forceCheckoutBranch(repoDir, repoKey, "main");
            return { branch: branchName, diff: "", fileCount: 0, prUrl: null, summary: "No changes", error: "No changes produced" };
          }

          const build = runRescriptBuild(repoDir);

          // Phase 3: Verify
          writeLine({ type: "phase_marker", phase: "verifying" });

          await askStream(`Verify the feature implementation in ${repoDir}. Run the build and check it's green. Output JSON: {pass: boolean, issues: string[]}`, {
            model: "opus",
            cwd: repoDir,
            allowedTools: ["Read", "Glob", "Grep", "Bash"],
            timeoutMs: 300_000,
          }, (chunk) => { writeLine(chunk); });

          // Commit & push
          const { combinedDiff, totalFiles, submodulesChanged } =
            await commitWithSubmodules(repoDir, repoKey, `feat: ${session.title}`);

          let prUrl: string | null = null;
          try {
            for (const sub of submodulesChanged) {
              await pushSubmoduleToFork({ parentDir: repoDir, subDir: sub, branchName });
            }
            if (submodulesChanged.length > 0) {
              await rewriteGitmodulesToForks(repoDir, submodulesChanged);
              const g = simpleGit(repoDir);
              await g.add(".gitmodules");
              await g.commit("chore: point submodules at bot forks for build");
            }
            await pushBranchToFork(repoDir, repoKey, branchName);
            const pr = await createPullRequest({
              repoKey,
              branch: branchName,
              title: `feat: ${session.title}`,
              body: `## Feature Agent\n\n${agentText.slice(0, 1000)}`,
            });
            prUrl = pr.prUrl;
          } catch { /* PR failed — not fatal */ }

          await forceCheckoutBranch(repoDir, repoKey, "main");

          return {
            branch: branchName,
            diff: combinedDiff || diff,
            fileCount: totalFiles || fileCount,
            prUrl,
            summary: agentText.slice(0, 2000),
          };
        } catch (err) {
          try { await forceCheckoutBranch(repoDir, repoKey, "main"); } catch { /* */ }
          return { branch: branchName, diff: "", fileCount: 0, prUrl: null, summary: "", error: (err as Error).message };
        }
      });

      results[repoKey] = result;
    }

    // Update session
    const anyError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const firstBranch = Object.values(results).find((r) => r.branch)?.branch ?? null;

    db.prepare(
      "UPDATE feature_sessions SET status = ?, branch = ?, updated_at = ? WHERE id = ?",
    ).run(allError ? "failed" : "done", firstBranch, nowIso(), sessionId);

    writeLine({
      type: "implement_done",
      results: Object.fromEntries(
        Object.entries(results).map(([k, v]) => [k, {
          branch: v.branch,
          filesTouched: v.fileCount,
          diff: v.diff,
          prUrl: v.prUrl,
          summary: v.summary,
          error: v.error,
        }]),
      ),
    });

    // Fire-and-forget documentation
    for (const [rk, result] of Object.entries(results)) {
      if (!result.error && result.diff) {
        generateDoc({
          sourceType: "feature",
          sourceId: sessionId,
          diff: result.diff,
          summary: result.summary,
          featureName: session.title,
          filesChanged: result.diff.split("\n").filter((l) => l.startsWith("diff --git")).map((l) => l.replace(/^diff --git a\//, "").replace(/ b\/.*/, "")),
          repoKey: rk as "web" | "mobile",
        }).catch(() => { /* fire-and-forget */ });
      }
    }
  } catch (err) {
    db.prepare("UPDATE feature_sessions SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
    writeLine({ type: "error", error: (err as Error).message });
  }

  if (!res.writableEnded) res.end();
});
