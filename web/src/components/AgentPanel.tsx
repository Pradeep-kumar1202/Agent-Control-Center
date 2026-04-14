import { useEffect, useRef, useState } from "react";
import { api, type ChatMessageRow, type ChatStreamChunk, type PatchBuildFailedChunk, type PatchDoneChunk, type PatchStreamChunk, type PhaseMarkerChunk } from "../api";
import { readNdjson } from "./ndjson";

// ─── props ───────────────────────────────────────────────────────────────────

interface Props {
  gapId: number;
  gapName: string;
  /** "patch" = auto-start generation; "chat" = skip generation, go straight to chat */
  mode: "patch" | "chat";
  /** Set when mode="chat" to load existing conversation */
  existingPatchId?: number;
  onClose: () => void;
  /** Called on successful patch generation with the patch metadata */
  onPatchSuccess: (patch: PatchDoneChunk) => void;
}

// ─── state types ─────────────────────────────────────────────────────────────

type PanelStage =
  | "patching"      // streaming patch generation
  | "patch-done"    // generation done, chat input visible
  | "build-failed"  // build check failed — chat to fix
  | "chat-only"     // mode="chat", no generation
  | "error";        // terminal non-recoverable error

type AgentPhase = "analysing" | "implementing" | "verifying";

interface StreamState {
  text: string;
  tools: Array<{ name: string; input?: unknown; id?: string }>;
  error: string | null;
}

interface LiveTurnState {
  text: string;
  toolUses: Array<{ name: string; input?: unknown; id?: string }>;
  error: string | null;
}

// ─── component ───────────────────────────────────────────────────────────────

export function AgentPanel({
  gapId,
  gapName,
  mode,
  existingPatchId,
  onClose,
  onPatchSuccess,
}: Props) {
  const [stage, setStage] = useState<PanelStage>(mode === "patch" ? "patching" : "chat-only");
  const [phase, setPhase] = useState<AgentPhase | null>(null);
  const [streaming, setStreaming] = useState(mode === "patch");
  const [stream, setStream] = useState<StreamState>({ text: "", tools: [], error: null });
  const [patch, setPatch] = useState<PatchDoneChunk | null>(null);
  const [buildFailed, setBuildFailed] = useState<PatchBuildFailedChunk | null>(null);
  const [patchId, setPatchId] = useState<number | undefined>(existingPatchId);
  const [diffOpen, setDiffOpen] = useState(false);
  const [buildLogOpen, setBuildLogOpen] = useState(true);

  // Chat state
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [liveTurn, setLiveTurn] = useState<LiveTurnState | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  // Note-for-agent: typed during generation phase, queued into chat input on completion
  const [agentNote, setAgentNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  const patchAbortRef = useRef<AbortController | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stream, messages, liveTurn, patch, buildFailed]);

  // Load chat messages when in chat mode
  useEffect(() => {
    const id = patchId;
    if (!id) return;
    if (stage === "chat-only" || stage === "patch-done" || stage === "build-failed") {
      api.getChatMessages(id)
        .then(({ messages: m }) => setMessages(m))
        .catch(() => {});
    }
  }, [stage, patchId]);

  // Start patch generation on mount when mode="patch"
  useEffect(() => {
    if (mode !== "patch") return;
    const ctrl = new AbortController();
    patchAbortRef.current = ctrl;

    (async () => {
      try {
        const r = await api.streamPatch(gapId, ctrl.signal);

        if (r.status === 409) {
          const body = await r.json() as { error?: string };
          setStream((prev) => ({ ...prev, error: body.error ?? "Patch already exists" }));
          setStage("error");
          setStreaming(false);
          return;
        }

        if (!r.ok || !r.body) {
          const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` })) as { error?: string };
          setStream((prev) => ({ ...prev, error: body.error ?? `HTTP ${r.status}` }));
          setStage("error");
          setStreaming(false);
          return;
        }

        for await (const chunk of readNdjson<PatchStreamChunk>(r.body)) {
          if (chunk.type === "phase_marker") {
            setPhase((chunk as PhaseMarkerChunk).phase);
          } else if (chunk.type === "text" && chunk.text) {
            const text = chunk.text;
            setStream((prev) => ({ ...prev, text: prev.text + text }));
          } else if (chunk.type === "tool_use" && chunk.tool) {
            const tool = chunk.tool;
            setStream((prev) => ({ ...prev, tools: [...prev.tools, tool] }));
          } else if (chunk.type === "error" && chunk.error) {
            setStream((prev) => ({ ...prev, error: chunk.error ?? "unknown error" }));
            setStage("error");
          } else if (chunk.type === "build_failed") {
            const failed = chunk as PatchBuildFailedChunk;
            setBuildFailed(failed);
            setPatchId(failed.patchId);
            setStage("build-failed");
            // Pre-populate chat with the build error context
            const note = agentNote.trim();
            const seedMsg = note
              ? `${note}\n\nAlso — the build failed with these errors:\n\n${failed.buildLog.slice(-2000)}\n\nPlease fix all the errors and re-run the build until it passes.`
              : `The build failed. Please fix these errors and re-run until it passes:\n\n${failed.buildLog.slice(-2000)}`;
            setChatInput(seedMsg);
          } else if (chunk.type === "patch_done") {
            const done = chunk as PatchDoneChunk;
            setPatch(done);
            setPatchId(done.patchId);
            setStage("patch-done");
            onPatchSuccess(done);
            // Move any queued note into the chat input
            if (agentNote.trim()) {
              setChatInput(agentNote.trim());
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setStream((prev) => ({ ...prev, error: (e as Error).message }));
          setStage("error");
        }
      } finally {
        setStreaming(false);
      }
    })();

    return () => { ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapId, mode]);

  // ── Chat send ──────────────────────────────────────────────────────────────
  const sendChat = async () => {
    const message = chatInput.trim();
    if (!message || chatStreaming || !patchId) return;
    setChatInput("");
    setChatError(null);

    const userMsg: ChatMessageRow = {
      id: -Date.now(),
      patch_id: patchId,
      turn: (messages[messages.length - 1]?.turn ?? -1) + 1,
      role: "user",
      content: message,
      tool_name: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLiveTurn({ text: "", toolUses: [], error: null });
    setChatStreaming(true);

    const ctrl = new AbortController();
    chatAbortRef.current = ctrl;
    try {
      const r = await fetch(`/api/patches/${patchId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`chat stream failed: HTTP ${r.status}`);
      }
      for await (const chunk of readNdjson<ChatStreamChunk>(r.body)) {
        if (chunk.type === "text" && chunk.text) {
          setLiveTurn((prev) => prev ? { ...prev, text: prev.text + chunk.text! } : prev);
        } else if (chunk.type === "tool_use" && chunk.tool) {
          setLiveTurn((prev) => prev ? { ...prev, toolUses: [...prev.toolUses, chunk.tool!] } : prev);
        } else if (chunk.type === "error" && chunk.error) {
          setLiveTurn((prev) => prev ? { ...prev, error: chunk.error ?? "error" } : prev);
        } else if (chunk.type === "done") {
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setLiveTurn((prev) => prev ? { ...prev, error: "cancelled" } : prev);
      } else {
        setChatError((e as Error).message);
      }
    } finally {
      setChatStreaming(false);
      chatAbortRef.current = null;
      try {
        const { messages: m } = await api.getChatMessages(patchId);
        setMessages(m);
      } catch { /* keep optimistic */ }
      setLiveTurn(null);
    }
  };

  // ── Phase label & colors ───────────────────────────────────────────────────
  const phaseLabels: Record<AgentPhase, string> = {
    analysing: "Analysing source →",
    implementing: "Implementing →",
    verifying: "Verifying →",
  };
  const phaseColors: Record<AgentPhase, string> = {
    analysing: "var(--blue)",
    implementing: "var(--accent)",
    verifying: "var(--green)",
  };
  const stageLabel: Record<PanelStage, string> = {
    patching: phase ? phaseLabels[phase] : "Starting…",
    "patch-done": "Done ✓",
    "build-failed": "Build failed — fix in chat",
    "chat-only": "Chat",
    error: "Failed",
  };
  const stageColor: Record<PanelStage, string> = {
    patching: phase ? phaseColors[phase] : "var(--text3)",
    "patch-done": "var(--green)",
    "build-failed": "var(--amber)",
    "chat-only": "var(--text2)",
    error: "var(--red)",
  };

  const showChat = stage === "patch-done" || stage === "chat-only" || stage === "build-failed";
  const gapBranch = patch?.branch ?? buildFailed?.branch ?? "";

  const currentPhaseColor = phase ? phaseColors[phase] : "var(--text3)";

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex" }}>
      {/* Backdrop */}
      <div
        style={{ flex: 1, background: "rgba(0,0,0,0.5)" }}
        onClick={streaming || chatStreaming ? undefined : onClose}
      />

      {/* Panel */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "55vw",
          maxWidth: 920,
          background: "var(--bg2)",
          borderLeft: "1px solid var(--border2)",
          boxShadow: "-4px 0 40px rgba(0,0,0,0.6)",
        }}
      >
        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--sans)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {stage === "patching" ? "Generating patch" : stage === "build-failed" ? "Build failed — fix with chat" : stage === "chat-only" ? "Chat with agent" : gapName}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {gapName}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 12 }}>
            {/* Phase/stage pill */}
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              border: "1px solid", borderColor: stageColor[stage] + "40",
              background: stageColor[stage] + "18",
              color: stageColor[stage],
              borderRadius: 20, padding: "2px 9px", fontSize: 11, fontWeight: 500,
              fontFamily: "var(--mono)",
            }}>
              {streaming && stage === "patching" && (
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", background: currentPhaseColor,
                  animation: "pulse 1.2s ease-in-out infinite", flexShrink: 0,
                }} />
              )}
              {stageLabel[stage]}
            </span>

            {streaming ? (
              <button
                className="btn btn-red btn-sm"
                onClick={() => patchAbortRef.current?.abort()}
              >
                Cancel
              </button>
            ) : (
              <button
                className="btn btn-sm"
                onClick={onClose}
                style={{ color: "var(--text2)" }}
              >
                Close
              </button>
            )}
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0, overflowY: "auto",
            padding: "12px 16px", display: "flex", flexDirection: "column", gap: 4,
            fontFamily: "var(--mono)", fontSize: 11,
          }}
        >
          {/* Tool chips from patch generation stream */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {stream.tools.map((t, i) => (
              <ToolChip key={`${t.id ?? i}`} tool={t} />
            ))}
          </div>

          {/* Agent text */}
          {stream.text && (
            <div style={{ marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.6, color: "var(--text2)", fontSize: 11 }}>
              {stream.text}
              {streaming && stage !== "error" && (
                <span style={{ display: "inline-block", width: 4, height: 12, marginLeft: 2, verticalAlign: "middle", background: "var(--text3)", animation: "pulse 0.8s ease-in-out infinite" }} />
              )}
            </div>
          )}

          {/* Build running indicator */}
          {stream.tools.some((t) => t.name === "Bash" && typeof (t.input as {command?:string})?.command === "string" && (t.input as {command:string}).command.includes("re:build")) && streaming && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid rgba(245,158,11,.3)", background: "rgba(245,158,11,0.05)", borderRadius: 6, padding: "6px 12px", marginTop: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--amber)", animation: "pulse 0.8s ease-in-out infinite", flexShrink: 0 }} />
              <span style={{ color: "var(--amber)", fontSize: 11 }}>Running re:build…</span>
            </div>
          )}

          {/* Generic error block */}
          {stream.error && stage === "error" && (
            <div style={{ marginTop: 8, border: "1px solid var(--red-dim)", background: "var(--red-dim)", borderRadius: 6, padding: "10px 14px", color: "var(--red)", whiteSpace: "pre-wrap", fontSize: 11 }}>
              {stream.error}
            </div>
          )}

          {/* ── Build failure block ── */}
          {buildFailed && stage === "build-failed" && (
            <div style={{ marginTop: 8, border: "1px solid rgba(245,158,11,.3)", background: "rgba(245,158,11,.05)", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ color: "var(--amber)", fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                Build failed — patch saved to branch <code style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{buildFailed.branch}</code>
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8 }}>
                {buildFailed.filesTouched} file{buildFailed.filesTouched !== 1 ? "s" : ""} changed. Use the chat below to fix the build errors.
              </div>
              <button
                onClick={() => setBuildLogOpen((v) => !v)}
                className="btn btn-sm"
                style={{ marginBottom: 6, color: "var(--amber)", borderColor: "rgba(245,158,11,.3)", fontSize: 10 }}
              >
                {buildLogOpen ? "Hide build log ↑" : "Show build log ↓"}
              </button>
              {buildLogOpen && (
                <pre style={{
                  fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5,
                  background: "var(--bg4)", color: "var(--red)", borderRadius: 6,
                  padding: "8px 12px", overflowX: "auto", maxHeight: 280, overflowY: "auto",
                  whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}>
                  {buildFailed.buildLog}
                </pre>
              )}
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => setDiffOpen((v) => !v)}
                  className="btn btn-sm"
                  style={{ fontSize: 10, color: "var(--text2)" }}
                >
                  {diffOpen ? "Hide diff ↑" : "Show diff ↓"} ({buildFailed.filesTouched} files)
                </button>
                {diffOpen && (
                  <pre style={{
                    fontFamily: "var(--mono)", fontSize: 10, background: "var(--bg4)",
                    color: "var(--text2)", borderRadius: 6, padding: "8px 12px",
                    overflowX: "auto", maxHeight: 220, overflowY: "auto", marginTop: 6,
                    whiteSpace: "pre-wrap", wordBreak: "break-all",
                  }}>
                    {buildFailed.diff}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* ── Success card + diff ── */}
          {patch && stage === "patch-done" && (
            <div style={{ marginTop: 12, border: "1px solid rgba(62,207,142,.2)", background: "rgba(62,207,142,0.04)", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ color: "var(--green)", fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                Build passed ✓  Verification passed ✓  Patch ready
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text3)" }}>
                <div>Files changed: <span style={{ color: "var(--text)" }}>{patch.filesTouched}</span></div>
                <div>Branch: <code style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{patch.branch}</code></div>
                {patch.prUrl && (
                  <div>PR: <a href={patch.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue)", textDecoration: "underline" }}>{patch.prUrl}</a></div>
                )}
                {patch.prWarning && <div style={{ color: "var(--amber)", fontSize: 10 }}>{patch.prWarning}</div>}
              </div>
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={() => setDiffOpen((v) => !v)}
                  className="btn btn-sm"
                  style={{ fontSize: 10, color: "var(--text2)" }}
                >
                  {diffOpen ? "Hide diff ↑" : "Show diff ↓"}
                </button>
                {diffOpen && (
                  <pre style={{
                    fontFamily: "var(--mono)", fontSize: 10, background: "var(--bg4)",
                    color: "var(--text2)", borderRadius: 6, padding: "8px 12px",
                    overflowX: "auto", maxHeight: 280, overflowY: "auto", marginTop: 6,
                    whiteSpace: "pre-wrap", wordBreak: "break-all",
                  }}>
                    {patch.diff}
                  </pre>
                )}
              </div>
              {messages.length === 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>
                  Chat with the agent below to refine the patch ↓
                </div>
              )}
            </div>
          )}

          {/* ── Chat thread ── */}
          {showChat && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {messages.length === 0 && !liveTurn && stage === "build-failed" && (
                <div style={{ fontSize: 11, color: "var(--amber)", padding: "8px 0" }}>
                  The build error has been pre-filled in the chat below. Hit Send to ask the agent to fix it — it will checkout the branch, read the errors, and iterate until the build is green.
                </div>
              )}
              {messages.length === 0 && !liveTurn && stage === "chat-only" && (
                <div style={{ textAlign: "center", padding: "16px 0", color: "var(--text3)", fontSize: 11 }}>
                  No messages yet. Ask about the patch — the agent can investigate, edit files, and rebuild.
                </div>
              )}
              {groupByTurn(messages).map((turn) => (
                <TurnBlock key={turn.turn} turn={turn} />
              ))}
              {liveTurn && <LiveTurnBlock live={liveTurn} streaming={chatStreaming} />}
              {chatError && (
                <div style={{ border: "1px solid var(--red-dim)", background: "var(--red-dim)", borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "var(--red)" }}>
                  {chatError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Note for agent (during patching) ── */}
        {stage === "patching" && streaming && (
          <div style={{ borderTop: "1px solid var(--border)", padding: "8px 12px", flexShrink: 0, background: "var(--bg3)" }}>
            <button
              onClick={() => setNoteOpen((v) => !v)}
              style={{ fontSize: 10, color: noteOpen ? "var(--accent)" : "var(--text3)", cursor: "pointer", background: "none", border: "none", padding: 0, fontFamily: "var(--sans)" }}
            >
              {noteOpen ? "▼" : "▶"} Leave a note for the agent
            </button>
            {noteOpen && (
              <div style={{ marginTop: 6 }}>
                <textarea
                  value={agentNote}
                  onChange={(e) => setAgentNote(e.target.value)}
                  placeholder="E.g. 'Make sure to also update S3ApiHook.res if you add locale fields' — sent as first chat message after generation"
                  rows={3}
                  style={{
                    width: "100%", background: "var(--bg4)", border: "1px solid var(--border2)",
                    borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "var(--text)",
                    fontFamily: "var(--sans)", resize: "none", outline: "none",
                    boxSizing: "border-box",
                  }}
                  onFocus={(e) => e.target.style.borderColor = "var(--accent)"}
                  onBlur={(e) => e.target.style.borderColor = "var(--border2)"}
                />
                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>
                  This note will be sent as your first message after generation completes or if the build fails.
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Chat input (after done / build-failed / chat-only) ── */}
        {showChat && (
          <div style={{ borderTop: "1px solid var(--border)", padding: "10px 12px", flexShrink: 0 }}>
            {stage === "build-failed" && !patchId && (
              <div style={{ marginBottom: 6, fontSize: 10, color: "var(--red)" }}>
                No patch found for this gap — generate a patch first.
              </div>
            )}
            {stage === "chat-only" && !patchId && (
              <div style={{ marginBottom: 6, fontSize: 10, color: "var(--red)" }}>
                No patch found for this gap — generate a patch first.
              </div>
            )}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendChat(); }
                }}
                placeholder={
                  !patchId
                    ? "Generate a patch first to enable chat"
                    : chatStreaming
                      ? "Agent is responding…"
                      : stage === "build-failed"
                        ? "Describe the fix or just hit Send to auto-fix the build error"
                        : "Ask the agent (Enter to send, Shift+Enter for newline)"
                }
                disabled={chatStreaming || !patchId}
                rows={3}
                style={{
                  flex: 1, resize: "none", borderRadius: 6, fontSize: 11,
                  padding: "7px 10px", outline: "none",
                  background: "var(--bg4)",
                  border: "1px solid var(--border2)",
                  color: "var(--text)",
                  fontFamily: "var(--sans)",
                  opacity: chatStreaming || !patchId ? 0.5 : 1,
                  cursor: chatStreaming || !patchId ? "not-allowed" : "text",
                }}
                onFocus={(e) => e.target.style.borderColor = "var(--accent)"}
                onBlur={(e) => e.target.style.borderColor = "var(--border2)"}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {chatStreaming ? (
                  <button
                    className="btn btn-red btn-sm"
                    onClick={() => chatAbortRef.current?.abort()}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => void sendChat()}
                    disabled={!chatInput.trim() || !patchId}
                    style={{
                      borderColor: "var(--accent)",
                      color: "var(--accent)",
                      background: "var(--accent-dim)",
                      opacity: !chatInput.trim() || !patchId ? 0.4 : 1,
                    }}
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
            {gapBranch && (
              <div className="mono" style={{ marginTop: 4, fontSize: 10, color: "var(--text3)" }}>
                branch: <code style={{ color: "var(--accent)" }}>{gapBranch}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

function ToolChip({ tool }: { tool: { name: string; input?: unknown; id?: string } }) {
  const inputStr = (() => {
    if (!tool.input) return "";
    if (typeof tool.input === "string") return tool.input;
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
  const isWrite = tool.name === "Edit" || tool.name === "Write";

  const chipStyle: React.CSSProperties = isBuild
    ? { borderColor: "rgba(245,158,11,.3)", background: "rgba(245,158,11,0.05)", color: "var(--amber)" }
    : isWrite
      ? { borderColor: "var(--accent-dim2)", background: "var(--accent-dim)", color: "var(--accent)" }
      : { borderColor: "var(--border)", background: "var(--bg3)", color: "var(--text3)" };

  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        border: "1px solid", borderRadius: 4, padding: "2px 7px",
        fontSize: 10, fontFamily: "var(--mono)",
        ...chipStyle,
      }}
    >
      <span style={{ opacity: 0.6 }}>⚙</span>
      <span style={{ fontWeight: 500 }}>{tool.name}</span>
      {inputStr && (
        <span style={{ opacity: 0.65, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {inputStr}
        </span>
      )}
    </div>
  );
}

// ─── chat sub-components ──────────────────────────────────────────────────────

interface TurnGroup {
  turn: number;
  user?: ChatMessageRow;
  assistant?: ChatMessageRow;
  tools: ChatMessageRow[];
}

function groupByTurn(messages: ChatMessageRow[]): TurnGroup[] {
  const map = new Map<number, TurnGroup>();
  for (const m of messages) {
    let g = map.get(m.turn);
    if (!g) { g = { turn: m.turn, tools: [] }; map.set(m.turn, g); }
    if (m.role === "user") g.user = m;
    else if (m.role === "assistant") g.assistant = m;
    else if (m.role === "tool") g.tools.push(m);
  }
  return Array.from(map.values()).sort((a, b) => a.turn - b.turn);
}

function TurnBlock({ turn }: { turn: TurnGroup }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {turn.user && <UserBubble content={turn.user.content} />}
      {(turn.assistant || turn.tools.length > 0) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {turn.tools.map((t) => (
              <ToolChip key={t.id} tool={{ name: t.tool_name ?? "tool", input: t.content }} />
            ))}
          </div>
          {turn.assistant && <AssistantBubble content={turn.assistant.content} />}
        </div>
      )}
    </div>
  );
}

function LiveTurnBlock({ live, streaming }: { live: LiveTurnState; streaming: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {live.toolUses.map((t, i) => (
          <ToolChip key={`${t.id ?? i}`} tool={t} />
        ))}
      </div>
      {(live.text || streaming) && (
        <AssistantBubble content={live.text || (streaming ? "▍" : "")} streaming={streaming} />
      )}
      {live.error && (
        <div style={{ border: "1px solid var(--red-dim)", borderRadius: 6, padding: "5px 10px", fontSize: 11, color: "var(--red)", background: "var(--red-dim)" }}>
          {live.error}
        </div>
      )}
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{
        maxWidth: "85%", borderRadius: "8px 8px 2px 8px", padding: "7px 12px",
        fontSize: 12, whiteSpace: "pre-wrap",
        border: "1px solid var(--accent-dim2)", background: "var(--accent-dim)",
        color: "var(--text)", fontFamily: "var(--sans)", lineHeight: 1.5,
      }}>
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{
        maxWidth: "95%", borderRadius: "8px 8px 8px 2px", padding: "7px 12px",
        fontSize: 12, whiteSpace: "pre-wrap",
        border: "1px solid var(--border)", background: "var(--bg3)",
        color: "var(--text2)", fontFamily: "var(--sans)", lineHeight: 1.5,
      }}>
        {content}
        {streaming && (
          <span style={{ display: "inline-block", width: 4, height: 12, marginLeft: 2, verticalAlign: "middle", background: "var(--text3)", animation: "pulse 0.8s ease-in-out infinite" }} />
        )}
      </div>
    </div>
  );
}
