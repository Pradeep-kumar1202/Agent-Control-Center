import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { readNdjson } from "../../components/ndjson";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FeatureSession {
  id: number;
  title: string;
  status: "discovery" | "implementing" | "done" | "failed";
  repos: string;
  branch: string | null;
  created_at: string;
  updated_at: string;
}

interface FeatureMessage {
  id: number;
  session_id: number;
  turn: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  created_at: string;
}

interface FeatureSessionDetail extends FeatureSession {
  messages: FeatureMessage[];
}

type Phase = "analysing" | "implementing" | "verifying" | null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  discovery: { bg: "var(--blue-dim)", color: "var(--blue)" },
  implementing: { bg: "var(--amber-dim)", color: "var(--amber)" },
  done: { bg: "var(--green-dim)", color: "var(--green)" },
  failed: { bg: "var(--red-dim)", color: "var(--red)" },
};

// ─── Component ───────────────────────────────────────────────────────────────

export function FeatureAgent() {
  const [sessions, setSessions] = useState<FeatureSession[]>([]);
  const [activeSession, setActiveSession] = useState<FeatureSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [implementing, setImplementing] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");
  const [toolChips, setToolChips] = useState<string[]>([]);
  const [implResults, setImplResults] = useState<Record<string, unknown> | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession?.messages, liveText]);

  async function loadSessions() {
    try {
      const list = await api.listFeatureSessions();
      setSessions(list);
    } catch { /* */ }
    setLoading(false);
  }

  async function selectSession(id: number) {
    try {
      const detail = await api.getFeatureSession(id);
      setActiveSession(detail);
      setLiveText("");
      setToolChips([]);
      setImplResults(null);
      setPhase(null);
    } catch { /* */ }
  }

  async function createSession() {
    if (!newDesc.trim()) return;
    setCreating(true);
    try {
      const session = await api.createFeatureSession(newDesc.trim());
      setNewDesc("");
      await loadSessions();
      await selectSession(session.id);
    } catch { /* */ }
    setCreating(false);
  }

  async function deleteSession(id: number) {
    try {
      await api.deleteFeatureSession(id);
      if (activeSession?.id === id) setActiveSession(null);
      await loadSessions();
    } catch { /* */ }
  }

  async function sendChat() {
    if (!activeSession || !chatInput.trim() || chatStreaming) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChatStreaming(true);
    setLiveText("");
    setToolChips([]);

    // Optimistic update
    setActiveSession((prev) => prev ? {
      ...prev,
      messages: [...prev.messages, {
        id: -1, session_id: prev.id, turn: -1, role: "user" as const,
        content: msg, tool_name: null, created_at: new Date().toISOString(),
      }],
    } : null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await api.streamFeatureChat(activeSession.id, msg, controller.signal);
      if (!resp.ok || !resp.body) {
        setChatStreaming(false);
        return;
      }

      let assistantText = "";
      for await (const chunk of readNdjson<Record<string, unknown>>(resp.body)) {
        if (chunk.type === "text") {
          assistantText += chunk.text;
          setLiveText(assistantText);
        } else if (chunk.type === "tool_use") {
          const tool = chunk.tool as { name: string } | undefined;
          if (tool?.name) setToolChips((prev) => [...prev.slice(-9), tool.name]);
        } else if (chunk.type === "done") {
          // Add assistant message to local state
          setActiveSession((prev) => prev ? {
            ...prev,
            messages: [...prev.messages, {
              id: -2, session_id: prev.id, turn: -1, role: "assistant" as const,
              content: assistantText, tool_name: null, created_at: new Date().toISOString(),
            }],
          } : null);
          setLiveText("");
        }
      }
    } catch { /* abort */ }

    setChatStreaming(false);
    setToolChips([]);
    abortRef.current = null;
  }

  async function triggerImplementation() {
    if (!activeSession || implementing) return;
    setImplementing(true);
    setPhase(null);
    setCurrentRepo(null);
    setToolChips([]);
    setImplResults(null);

    try {
      const resp = await api.triggerImplementation(activeSession.id);
      if (!resp.ok || !resp.body) {
        setImplementing(false);
        return;
      }

      for await (const chunk of readNdjson<Record<string, unknown>>(resp.body)) {
        if (chunk.type === "phase_marker") {
          setPhase(chunk.phase as Phase);
        } else if (chunk.type === "repo_marker") {
          setCurrentRepo(chunk.repo as string);
        } else if (chunk.type === "tool_use") {
          const tool = chunk.tool as { name: string } | undefined;
          if (tool?.name) setToolChips((prev) => [...prev.slice(-19), tool.name]);
        } else if (chunk.type === "text") {
          setLiveText((prev) => prev + (chunk.text as string));
        } else if (chunk.type === "implement_done") {
          setImplResults(chunk.results as Record<string, unknown>);
        }
      }
    } catch { /* */ }

    setImplementing(false);
    setPhase(null);
    await loadSessions();
    if (activeSession) await selectSession(activeSession.id);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>

      {/* ── Session List (left) ─────────────────────────────────────── */}
      <div style={{
        width: 240, minWidth: 240, borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* New session input */}
        <div style={{ padding: "12px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="Describe feature..."
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createSession()}
              style={{
                flex: 1, background: "var(--bg3)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "5px 8px", color: "var(--text)",
                fontSize: 11, outline: "none", fontFamily: "var(--sans)",
              }}
            />
            <button className="btn btn-accent btn-sm" disabled={creating || !newDesc.trim()} onClick={createSession}>
              +
            </button>
          </div>
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {loading && <div style={{ padding: 12, fontSize: 11, color: "var(--text3)" }}>Loading...</div>}
          {sessions.map((s) => {
            const sc = STATUS_COLORS[s.status] ?? STATUS_COLORS.discovery;
            const isActive = activeSession?.id === s.id;
            return (
              <div
                key={s.id}
                onClick={() => selectSession(s.id)}
                style={{
                  padding: "10px 12px", cursor: "pointer",
                  borderBottom: "1px solid var(--border)",
                  background: isActive ? "var(--accent-dim)" : "transparent",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "var(--bg3)"; }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 500, color: isActive ? "var(--text)" : "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                    {s.title}
                  </div>
                  <button
                    className="btn btn-sm"
                    style={{ padding: "1px 5px", fontSize: 9, opacity: 0.5 }}
                    onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                  >
                    x
                  </button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <span className="badge" style={{ background: sc.bg, color: sc.color, border: "none", fontSize: 9 }}>
                    {s.status}
                  </span>
                  <span style={{ fontSize: 9, color: "var(--text3)", fontFamily: "var(--mono)" }}>
                    {timeAgo(s.updated_at)}
                  </span>
                </div>
              </div>
            );
          })}
          {!loading && sessions.length === 0 && (
            <div style={{ padding: 16, fontSize: 11, color: "var(--text3)", textAlign: "center" }}>
              No sessions yet. Create one above.
            </div>
          )}
        </div>
      </div>

      {/* ── Chat Area (right) ───────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {!activeSession ? (
          <div className="empty-state">
            <svg className="empty-state-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 8h24v20H18l-6 5v-5H8z" rx="2" />
              <line x1="14" y1="15" x2="26" y2="15" />
              <line x1="14" y1="20" x2="22" y2="20" />
            </svg>
            <div className="empty-state-title">Select or create a session</div>
            <div className="empty-state-sub">
              Describe a feature and the agent will ask questions before implementing.
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{
              padding: "10px 16px", borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "var(--bg2)", flexShrink: 0,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{activeSession.title}</div>
                <div style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--mono)" }}>
                  {activeSession.status} · {JSON.parse(activeSession.repos).join(", ")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {activeSession.status === "discovery" && (
                  <button
                    className="btn btn-green btn-sm"
                    disabled={implementing || activeSession.messages.length < 2}
                    onClick={triggerImplementation}
                  >
                    Implement Now
                  </button>
                )}
                {activeSession.status === "done" && activeSession.branch && (
                  <span className="badge badge-patched">{activeSession.branch}</span>
                )}
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              {activeSession.messages
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m, i) => (
                  <div key={i} style={{
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                    padding: "8px 12px",
                    borderRadius: 10,
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: m.role === "user" ? "#fff" : "var(--text2)",
                    background: m.role === "user" ? "var(--accent2)" : "var(--bg3)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}>
                    {m.content}
                  </div>
                ))}

              {/* Live text during chat streaming */}
              {chatStreaming && liveText && (
                <div style={{
                  alignSelf: "flex-start", maxWidth: "80%",
                  padding: "8px 12px", borderRadius: 10,
                  fontSize: 12, lineHeight: 1.6,
                  color: "var(--text2)", background: "var(--bg3)",
                  whiteSpace: "pre-wrap",
                }}>
                  {liveText}
                  <span style={{ opacity: 0.4 }}>|</span>
                </div>
              )}

              {/* Implementation progress */}
              {implementing && (
                <div style={{
                  padding: 12, borderRadius: 8,
                  border: "1px solid var(--border)", background: "var(--bg2)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div className="status-dot running" />
                    <span style={{ fontSize: 12, fontWeight: 500 }}>
                      {currentRepo && <span className="badge badge-component" style={{ marginRight: 6 }}>{currentRepo}</span>}
                      {phase ? `Phase: ${phase}` : "Starting implementation..."}
                    </span>
                  </div>
                  {toolChips.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {toolChips.map((name, i) => (
                        <span key={i} className="badge badge-component" style={{ fontSize: 8 }}>{name}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Implementation results */}
              {implResults && (
                <div style={{
                  padding: 12, borderRadius: 8,
                  border: "1px solid rgba(63,185,80,.2)", background: "var(--green-dim)",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--green)", marginBottom: 6 }}>
                    Implementation complete
                  </div>
                  {Object.entries(implResults).map(([repo, result]) => {
                    const r = result as Record<string, unknown>;
                    return (
                      <div key={repo} style={{ fontSize: 11, color: "var(--text2)", marginBottom: 4 }}>
                        <span className="badge badge-component" style={{ marginRight: 6 }}>{repo}</span>
                        {r.error
                          ? <span style={{ color: "var(--red)" }}>{r.error as string}</span>
                          : <>
                              {r.filesTouched as number} files · {r.branch as string}
                              {r.prUrl && (
                                <a href={r.prUrl as string} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", marginLeft: 8 }}>
                                  View PR
                                </a>
                              )}
                            </>
                        }
                      </div>
                    );
                  })}
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            {(activeSession.status === "discovery" || activeSession.status === "done") && !implementing && (
              <div style={{
                padding: "10px 16px", borderTop: "1px solid var(--border)",
                display: "flex", gap: 8, flexShrink: 0,
              }}>
                <textarea
                  placeholder={activeSession.status === "discovery" ? "Describe your feature or answer the agent's questions..." : "Ask the agent to refine the implementation..."}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={chatStreaming}
                  rows={2}
                  style={{
                    flex: 1, background: "var(--bg3)", border: "1px solid var(--border)",
                    borderRadius: 8, padding: "8px 12px", color: "var(--text)",
                    fontSize: 12, resize: "none", outline: "none", fontFamily: "var(--sans)",
                  }}
                />
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <button
                    className="btn btn-accent btn-sm"
                    disabled={chatStreaming || !chatInput.trim()}
                    onClick={sendChat}
                  >
                    Send
                  </button>
                  {chatStreaming && (
                    <button className="btn btn-red btn-sm" onClick={() => abortRef.current?.abort()}>
                      Stop
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
