/**
 * Chat-with-the-patch-agent routes.
 *
 * GET    /patches/:id/chat   — list persisted messages for a patch
 * POST   /patches/:id/chat   — new turn; streams NDJSON response
 * DELETE /patches/:id/chat   — wipe the thread
 *
 * The POST endpoint is the interesting one. It spawns a fresh `claude -p`
 * per turn, primed with (a) the original patch context and (b) the full
 * conversation history, and streams the agent's output back to the browser
 * as application/x-ndjson. Each line is one of our StreamChunk events.
 *
 * Workspace access is serialized per repo via withRepoLock so a chat turn
 * can't race a patch run on the same clone.
 */

import { Router } from "express";
import fs from "node:fs";
import { REPOS, type RepoKey } from "../config.js";

const DEBUG_LOG = "/tmp/chat-debug.log";
function dlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(DEBUG_LOG, line); } catch { /* */ }
  console.log(msg);
}
import { db, nowIso, type ChatMessageRow, type GapRow, type PatchRow } from "../db.js";
import { askStream, type StreamChunk } from "../llm.js";
import { forceCheckoutBranch } from "../skills/submoduleGit.js";
import { withRepoLock } from "../workspace/mutex.js";

export const chatRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function loadPatch(id: number): PatchRow | undefined {
  return db.prepare("SELECT * FROM patches WHERE id = ?").get(id) as
    | PatchRow
    | undefined;
}

function loadGap(id: number): GapRow | undefined {
  return db.prepare("SELECT * FROM gaps WHERE id = ?").get(id) as
    | GapRow
    | undefined;
}

function loadMessages(patchId: number): ChatMessageRow[] {
  return db
    .prepare(
      "SELECT * FROM chat_messages WHERE patch_id = ? ORDER BY turn ASC, id ASC",
    )
    .all(patchId) as ChatMessageRow[];
}

function nextTurn(patchId: number): number {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(turn), -1) AS max_turn FROM chat_messages WHERE patch_id = ?",
    )
    .get(patchId) as { max_turn: number };
  return row.max_turn + 1;
}

function insertMessage(msg: {
  patchId: number;
  turn: number;
  role: ChatMessageRow["role"];
  content: string;
  toolName?: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO chat_messages (patch_id, turn, role, content, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.patchId,
      msg.turn,
      msg.role,
      msg.content,
      msg.toolName ?? null,
      nowIso(),
    );
  return info.lastInsertRowid as number;
}

/**
 * Truncate a big diff to head+tail when we're about to stuff it into the
 * system prompt. Opus can handle a lot but there's no point shipping 50 KB
 * of unchanged context every single turn.
 */
function truncateDiff(diff: string, maxBytes = 6000): string {
  if (diff.length <= maxBytes) return diff;
  const half = Math.floor(maxBytes / 2) - 20;
  return (
    diff.slice(0, half) +
    `\n\n… [${diff.length - 2 * half} bytes omitted — ask with Read/Grep for specifics] …\n\n` +
    diff.slice(-half)
  );
}

function formatHistory(messages: ChatMessageRow[]): string {
  if (messages.length === 0) return "(no prior turns — this is the first message)";
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const tag = m.role === "user" ? "USER" : "ASSISTANT";
      return `${tag}: ${m.content}`;
    })
    .join("\n\n");
}

function buildSystemPrompt(args: {
  patch: PatchRow;
  gap: GapRow;
  diff: string;
  history: ChatMessageRow[];
}): string {
  const { patch, gap, diff, history } = args;
  const repoLabel =
    patch.repo === "web"
      ? "hyperswitch-web (ReScript web SDK)"
      : "hyperswitch-client-core (ReScript mobile SDK)";
  const targetDir = REPOS[patch.repo as RepoKey].dir;
  const buildLogTail = patch.build_log
    ? patch.build_log.split("\n").slice(-20).join("\n")
    : "(no build log saved)";

  return `You are the feature-gap-dashboard patch agent, continuing a conversation with a developer who is actively testing the change you previously made.

## What you did earlier

You implemented this feature in ${repoLabel}:

- Gap #${gap.id}: \`${gap.canonical_name}\` (category: \`${gap.category}\`)
- Rationale: ${gap.rationale}

Your original agent run produced this summary:

${patch.summary}

The diff you committed to branch \`${patch.branch}\`:

\`\`\`
${truncateDiff(diff)}
\`\`\`

Build status when you committed: ${patch.build_status ?? "unknown"}
Build log tail:

\`\`\`
${buildLogTail}
\`\`\`

## Environment

- Your cwd is already set to ${targetDir} and the workspace is checked out to branch \`${patch.branch}\`.
- Tools available: Read, Write, Edit, Glob, Grep, Bash.
- Build command: \`npm run --silent re:build 2>&1\`. When you call Bash, pass \`timeout: 240000\` — the default 120s is too short for a cold ReScript build.
- The workspace is locked to you while you run; assume every edit matters.

## Conversation so far

${formatHistory(history)}

## Your job now

Read the user's next message. Investigate carefully — Grep/Read before Editing. If a fix is obvious, apply it, re-run the build until green, and tell the user what you changed. If the user reports a visual bug in the running app, trace from the UI component down to the type/config involved.

## ⛔ CRITICAL: Always commit after editing

After your edits compile successfully (\`npm run --silent re:build\` exits 0), you MUST commit your changes to the current branch. Uncommitted changes get wiped when the user rebuilds or restarts the preview. The commit command:

\`\`\`bash
git add -A && git commit -m "feat: <short description of what you changed>"
\`\`\`

Run this via the Bash tool BEFORE you output your final summary. The task is NOT done until both:
1. \`npm run --silent re:build 2>&1\` exits 0
2. \`git add -A && git commit -m "..."\` succeeds

If the build fails after 5 attempts, do NOT commit broken code — leave the workspace clean and tell the user what went wrong.

## ReScript gotchas

- Adding a field to a record type means every constructor of that record must be updated. Grep for all builders before editing.
- Optional fields are \`option<T>\` and constructed with \`Some(x)\` / \`None\`.
- Switches must be exhaustive.

Never mark a task as done while the build is failing. Max 5 build attempts per turn; if you can't make it compile, say so explicitly and leave a summary of the error instead of pretending it works.`;
}

// ─── routes ─────────────────────────────────────────────────────────────────

chatRouter.get("/patches/:id/chat", (req, res) => {
  const patchId = Number(req.params.id);
  if (!Number.isFinite(patchId)) return res.status(400).json({ error: "bad id" });
  const patch = loadPatch(patchId);
  if (!patch) return res.status(404).json({ error: "patch not found" });
  res.json({ patchId, messages: loadMessages(patchId) });
});

chatRouter.delete("/patches/:id/chat", (req, res) => {
  const patchId = Number(req.params.id);
  if (!Number.isFinite(patchId)) return res.status(400).json({ error: "bad id" });
  const info = db
    .prepare("DELETE FROM chat_messages WHERE patch_id = ?")
    .run(patchId);
  res.json({ deleted: info.changes });
});

chatRouter.post("/patches/:id/chat", async (req, res) => {
  const patchId = Number(req.params.id);
  if (!Number.isFinite(patchId)) return res.status(400).json({ error: "bad id" });
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "message is required" });

  dlog(`[chat] POST /patches/${patchId}/chat — message="${message.slice(0, 60)}"`);

  const patch = loadPatch(patchId);
  if (!patch) return res.status(404).json({ error: "patch not found" });
  const gap = loadGap(patch.gap_id);
  if (!gap) return res.status(404).json({ error: "gap not found" });

  const targetRepo = patch.repo as RepoKey;
  const targetDir = REPOS[targetRepo].dir;

  // Read stored diff (best-effort).
  let diffText = "";
  try {
    diffText = fs.readFileSync(patch.diff_path, "utf8");
  } catch {
    diffText = "(diff file not found — ask me to rebuild the patch if you need it)";
  }

  // Persist the user message BEFORE locking / spawning. If the agent fails
  // or the user cancels, the user's message is still saved — they can see
  // what they asked and try again.
  const turn = nextTurn(patchId);
  insertMessage({ patchId, turn, role: "user", content: message });

  // NDJSON response.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  // Let Express flush early so the browser starts reading immediately.
  res.flushHeaders?.();

  const writeLine = (obj: unknown) => {
    try {
      res.write(JSON.stringify(obj) + "\n");
    } catch { /* socket closed */ }
  };

  // Track client disconnect via res.on("close") — req.on("close") fires in
  // modern Node as soon as the request body is fully read (regardless of
  // whether the client is still listening), so it's the wrong event.
  // res.on("close") fires exactly when the socket closes to the client.
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
  });

  const history = loadMessages(patchId).filter(
    (m) => m.id < Number.MAX_SAFE_INTEGER, // include all rows except the just-inserted user message
  );
  // loadMessages already included the user row we just inserted; drop it
  // from history since it's the *current* user prompt.
  const priorHistory = history.filter(
    (m) => !(m.turn === turn && m.role === "user"),
  );

  const systemPrompt = buildSystemPrompt({
    patch,
    gap,
    diff: diffText,
    history: priorHistory,
  });

  // Accumulators for persistence after the stream ends.
  let assistantText = "";
  const toolUses: Array<{ name: string; input: unknown }> = [];

  const onChunk = (chunk: StreamChunk) => {
    if (clientClosed) return;
    // Pass through to the client verbatim.
    writeLine(chunk);
    if (chunk.type === "text" && chunk.text) {
      assistantText += chunk.text;
    } else if (chunk.type === "tool_use" && chunk.tool) {
      toolUses.push({ name: chunk.tool.name, input: chunk.tool.input });
    }
  };

  try {
    dlog(`[chat] turn ${turn} — acquiring ${targetRepo} lock`);
    await withRepoLock(targetRepo, async () => {
      dlog(`[chat] turn ${turn} — lock acquired, checking out ${patch.branch}`);
      await forceCheckoutBranch(targetDir, targetRepo, patch.branch);
      dlog(`[chat] turn ${turn} — checked out, spawning claude`);

      await askStream(
        message,
        {
          model: "opus",
          cwd: targetDir,
          system: systemPrompt,
          allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
          timeoutMs: 900_000,
        },
        onChunk,
      );
      dlog(`[chat] turn ${turn} — askStream resolved`);
    });
    dlog(`[chat] turn ${turn} — lock released`);
  } catch (err) {
    // Errors are already surfaced via an {type:"error"} chunk from askStream.
    dlog(`[chat] turn ${turn} — FAILED: ${(err as Error).message}`);
  } finally {
    dlog(`[chat] turn ${turn} — finally: assistantLen=${assistantText.length} toolUses=${toolUses.length} clientClosed=${clientClosed} writableEnded=${res.writableEnded}`);
    // Persist whatever we accumulated — even partial assistant text is
    // better than nothing for post-mortem.
    if (assistantText.trim().length > 0) {
      insertMessage({
        patchId,
        turn,
        role: "assistant",
        content: assistantText.trim(),
      });
    }
    for (const t of toolUses) {
      const input = typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? null);
      insertMessage({
        patchId,
        turn,
        role: "tool",
        content: input.slice(0, 2000),
        toolName: t.name,
      });
    }
    if (!clientClosed) {
      writeLine({ type: "done", turn });
      dlog(`[chat] turn ${turn} — about to res.end()`);
      res.end();
      dlog(`[chat] turn ${turn} — res.end() returned, writableEnded=${res.writableEnded}`);
    } else {
      dlog(`[chat] turn ${turn} — skipping writes because clientClosed=true`);
    }
  }
});
