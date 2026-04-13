import { useEffect, useRef, useState } from "react";
import { api, type PatchDoneChunk, type PatchStreamChunk, type PatchResponse } from "../api";
import { readNdjson } from "./ndjson";

interface Props {
  gapId: number;
  gapName: string;
  onClose: () => void;
  /** Called when the agent finishes successfully with the full patch metadata. */
  onSuccess: (patch: PatchResponse) => void;
}

interface LiveState {
  phase: "analysing" | "implementing" | "building" | "committing" | "done" | "error";
  text: string;
  toolUses: Array<{ name: string; input?: unknown; id?: string }>;
  error: string | null;
  patch: PatchDoneChunk | null;
}

/**
 * Full-height right-edge drawer that streams the patch generation agent's
 * activity in real-time.
 *
 * Phase 1 (source analysis): agent uses Read/Grep/Glob with absolute paths
 *   on the SOURCE repo to understand the feature fully before touching the target.
 * Phase 2 (target implementation): agent edits the TARGET repo, runs
 *   npm run re:build after each edit batch, iterates until green.
 *
 * On success, calls onSuccess() with the full patch metadata so App.tsx can
 * open the DiffViewer.
 */
export function PatchGenerationPanel({ gapId, gapName, onClose, onSuccess }: Props) {
  const [live, setLive] = useState<LiveState>({
    phase: "analysing",
    text: "",
    toolUses: [],
    error: null,
    patch: null,
  });
  const [streaming, setStreaming] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as content arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live]);

  // Start streaming immediately on mount.
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      try {
        const r = await api.streamPatch(gapId, ctrl.signal);

        if (r.status === 409) {
          // Patch already exists — treat as an error with a helpful message.
          const body = await r.json() as { error: string };
          setLive((prev) => ({ ...prev, phase: "error", error: body.error ?? "Patch already exists" }));
          setStreaming(false);
          return;
        }

        if (!r.ok || !r.body) {
          const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` })) as { error?: string };
          setLive((prev) => ({ ...prev, phase: "error", error: body.error ?? `HTTP ${r.status}` }));
          setStreaming(false);
          return;
        }

        for await (const chunk of readNdjson<PatchStreamChunk>(r.body)) {
          if (chunk.type === "text" && chunk.text) {
            const text = chunk.text;
            setLive((prev) => {
              // Detect phase transitions from agent text.
              let phase = prev.phase;
              const lower = text.toLowerCase();
              if (phase === "analysing" && (lower.includes("phase 2") || lower.includes("now implement") || lower.includes("target repo"))) {
                phase = "implementing";
              }
              return { ...prev, text: prev.text + text, phase };
            });
          } else if (chunk.type === "tool_use" && chunk.tool) {
            const tool = chunk.tool;
            setLive((prev) => {
              // Detect when the agent runs a build.
              const isBuild =
                tool.name === "Bash" &&
                typeof tool.input === "object" &&
                tool.input !== null &&
                "command" in tool.input &&
                typeof (tool.input as { command: string }).command === "string" &&
                (tool.input as { command: string }).command.includes("re:build");
              const phase = isBuild ? "building" : prev.phase === "building" ? "implementing" : prev.phase;
              return {
                ...prev,
                phase,
                toolUses: [...prev.toolUses, tool],
              };
            });
          } else if (chunk.type === "error" && chunk.error) {
            setLive((prev) => ({ ...prev, phase: "error", error: chunk.error ?? "unknown error" }));
          } else if (chunk.type === "patch_done") {
            const done = chunk as PatchDoneChunk;
            setLive((prev) => ({ ...prev, phase: "done", patch: done }));
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setLive((prev) => ({ ...prev, phase: "error", error: (e as Error).message }));
        }
      } finally {
        setStreaming(false);
      }
    })();

    return () => { ctrl.abort(); };
  }, [gapId]);

  const cancel = () => { abortRef.current?.abort(); };

  const phaseLabel: Record<LiveState["phase"], string> = {
    analysing: "Phase 1 — Analysing source repo…",
    implementing: "Phase 2 — Implementing in target…",
    building: "Building…",
    committing: "Committing & pushing…",
    done: "Done",
    error: "Failed",
  };

  const phaseColor: Record<LiveState["phase"], string> = {
    analysing: "text-indigo-300 border-indigo-500/30 bg-indigo-500/10",
    implementing: "text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/10",
    building: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    committing: "text-cyan-300 border-cyan-500/30 bg-cyan-500/10",
    done: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    error: "text-red-300 border-red-500/30 bg-red-500/10",
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/40"
        onClick={streaming ? undefined : onClose}
      />
      {/* Panel */}
      <div className="w-[62vw] max-w-4xl h-full flex flex-col bg-slate-950 border-l border-slate-700 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-100 truncate">
              Generating patch
            </div>
            <div className="text-xs text-slate-500 truncate mt-0.5">
              {gapName}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium ${phaseColor[live.phase]}`}
            >
              {streaming && live.phase !== "done" && live.phase !== "error" && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              )}
              {phaseLabel[live.phase]}
            </span>
            {streaming ? (
              <button
                onClick={cancel}
                className="rounded border border-red-600 bg-red-500/10 px-3 py-1 text-xs text-red-300 hover:bg-red-500/20"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={onClose}
                className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:text-slate-200"
              >
                Close
              </button>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-1 font-mono text-[11px]">
          {/* Tool-use chips */}
          {live.toolUses.map((t, i) => (
            <ToolChip key={`${t.id ?? i}`} tool={t} />
          ))}

          {/* Agent text */}
          {live.text && (
            <div className="mt-2 whitespace-pre-wrap text-slate-300 leading-relaxed text-[11px]">
              {live.text}
              {streaming && live.phase !== "done" && live.phase !== "error" && (
                <span className="inline-block w-1 h-3 ml-0.5 bg-slate-400 animate-pulse align-middle" />
              )}
            </div>
          )}

          {/* Build indicator */}
          {live.phase === "building" && streaming && (
            <div className="mt-2 flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span className="text-amber-300">Running npm run re:build…</span>
            </div>
          )}

          {/* Error */}
          {live.error && (
            <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-300 whitespace-pre-wrap">
              {live.error}
            </div>
          )}

          {/* Success summary */}
          {live.phase === "done" && live.patch && (
            <SuccessCard patch={live.patch} onViewDiff={() => {
              onSuccess({
                patchId: live.patch!.patchId,
                branch: live.patch!.branch,
                repo: live.patch!.repo,
                filesTouched: live.patch!.filesTouched,
                summary: live.patch!.summary,
                diff: live.patch!.diff,
                buildStatus: "pass",
                buildLog: live.patch!.buildLog,
                prUrl: live.patch!.prUrl,
                prNumber: live.patch!.prNumber,
                prWarning: live.patch!.prWarning,
              });
              onClose();
            }} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

function ToolChip({ tool }: { tool: { name: string; input?: unknown; id?: string } }) {
  const inputStr = (() => {
    if (!tool.input) return "";
    if (typeof tool.input === "string") return tool.input;
    // Show the most useful part of the input depending on tool.
    const inp = tool.input as Record<string, unknown>;
    if (tool.name === "Bash" && typeof inp.command === "string") return inp.command.slice(0, 80);
    if (tool.name === "Read" && typeof inp.file_path === "string") return inp.file_path;
    if (tool.name === "Grep" && typeof inp.pattern === "string") {
      const p = inp.path ? ` in ${inp.path}` : "";
      return `/${inp.pattern as string}/${p}`;
    }
    if ((tool.name === "Edit" || tool.name === "Write") && typeof inp.file_path === "string") return inp.file_path;
    if (tool.name === "Glob" && typeof inp.pattern === "string") return inp.pattern;
    try { return JSON.stringify(tool.input).slice(0, 80); } catch { return ""; }
  })();

  const isBuild = tool.name === "Bash" && inputStr.includes("re:build");
  const chipColor = isBuild
    ? "border-amber-700 bg-amber-500/5 text-amber-300"
    : tool.name === "Edit" || tool.name === "Write"
      ? "border-fuchsia-700/60 bg-fuchsia-500/5 text-fuchsia-300"
      : "border-slate-700 bg-slate-950/60 text-slate-400";

  return (
    <div className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 mr-1 mb-0.5 text-[10px] font-mono ${chipColor}`}>
      <span className="opacity-60">⚙</span>
      <span className="font-medium">{tool.name}</span>
      {inputStr && <span className="opacity-60 truncate max-w-[50ch]">{inputStr}</span>}
    </div>
  );
}

function SuccessCard({ patch, onViewDiff }: { patch: PatchDoneChunk; onViewDiff: () => void }) {
  return (
    <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-emerald-300 font-semibold text-sm">Build passed — patch ready</span>
      </div>
      <div className="text-xs text-slate-400 space-y-1">
        <div>
          <span className="text-slate-500">Files changed:</span>{" "}
          <span className="text-slate-200">{patch.filesTouched}</span>
        </div>
        <div>
          <span className="text-slate-500">Branch:</span>{" "}
          <code className="text-indigo-300">{patch.branch}</code>
        </div>
        {patch.prUrl && (
          <div>
            <span className="text-slate-500">PR:</span>{" "}
            <a
              href={patch.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-300 hover:text-indigo-100 underline"
            >
              {patch.prUrl}
            </a>
          </div>
        )}
        {patch.prWarning && (
          <div className="text-amber-400 text-[10px]">{patch.prWarning}</div>
        )}
      </div>
      <button
        onClick={onViewDiff}
        className="rounded border border-indigo-600 bg-indigo-500/10 px-4 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20"
      >
        View Diff &amp; Chat →
      </button>
    </div>
  );
}
