import { useEffect, useRef, useState } from "react";
import { api, type ChatMessageRow, type ChatStreamChunk } from "../api";
import { readNdjson } from "./ndjson";

interface Props {
  patchId: number;
  /** Shown in the header so the user knows which patch they're chatting with. */
  branch: string;
  canonicalName: string;
}

/**
 * In-drawer chat with the patch agent. Each user message spawns a fresh
 * `claude -p` on the server (see server/src/routes/chat.ts) primed with the
 * original patch diff, gap rationale, and full conversation history. The
 * response streams back as NDJSON, which we render as a live-growing
 * assistant bubble with tool-call chips for Grep/Read/Edit/Bash events.
 */
export function ChatPanel({ patchId, branch, canonicalName }: Props) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // The in-flight assistant bubble, accumulating text + tool_use events as
  // the NDJSON stream arrives. When the turn ends we persist this into
  // `messages` (or just refetch from the server, which is cheaper in terms
  // of state-management correctness).
  const [liveTurn, setLiveTurn] = useState<LiveTurnState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load: pull persisted history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { messages: m } = await api.getChatMessages(patchId);
        if (!cancelled) setMessages(m);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patchId]);

  // Auto-scroll to the bottom whenever new content arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, liveTurn]);

  const send = async () => {
    const message = input.trim();
    if (!message || streaming) return;
    setInput("");
    setError(null);

    // Optimistic user row — the server will also persist it, but showing it
    // now makes the UI feel instant.
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

    // Prepare the live turn so the UI has an empty assistant bubble to
    // stream into.
    setLiveTurn({ text: "", toolUses: [], error: null });
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
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
          setLiveTurn((prev) =>
            prev ? { ...prev, text: prev.text + chunk.text! } : prev,
          );
        } else if (chunk.type === "tool_use" && chunk.tool) {
          const tool = chunk.tool;
          setLiveTurn((prev) =>
            prev
              ? { ...prev, toolUses: [...prev.toolUses, tool] }
              : prev,
          );
        } else if (chunk.type === "error" && chunk.error) {
          setLiveTurn((prev) =>
            prev ? { ...prev, error: chunk.error ?? "unknown error" } : prev,
          );
        } else if (chunk.type === "done") {
          // stream ended cleanly — refetch the persisted history so we
          // replace the optimistic user row + in-flight live turn with
          // whatever the server actually wrote.
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setLiveTurn((prev) =>
          prev ? { ...prev, error: "cancelled" } : prev,
        );
      } else {
        setError((e as Error).message);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Refetch from server — this replaces our optimistic rows with the
      // real persisted state (including tool rows and any assistant text
      // we may have missed).
      try {
        const { messages: m } = await api.getChatMessages(patchId);
        setMessages(m);
      } catch { /* keep optimistic state */ }
      setLiveTurn(null);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const clearThread = async () => {
    if (streaming) return;
    if (!confirm("Clear the whole chat thread for this patch?")) return;
    try {
      await api.clearChat(patchId);
      setMessages([]);
      setLiveTurn(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Group rows by turn so we render "assistant text + its tool chips" as
  // one visual block per turn. User rows are always their own block.
  const turns = groupByTurn(messages);

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-900/60 border-l border-slate-800">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-200 truncate">
            Chat with the patch agent
          </div>
          <div className="text-[10px] text-slate-500 truncate">
            {canonicalName} · <code className="text-indigo-300">{branch}</code>
          </div>
        </div>
        <button
          onClick={clearThread}
          disabled={streaming || messages.length === 0}
          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-red-300 hover:border-red-500 disabled:opacity-40"
          title="Wipe all messages in this thread"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && !liveTurn && (
          <div className="text-xs text-slate-500 py-8 text-center">
            No messages yet. Ask me about the patch — I can investigate,
            edit files, and re-run the build.
          </div>
        )}
        {turns.map((turn) => (
          <TurnBlock key={turn.turn} turn={turn} />
        ))}
        {liveTurn && <LiveTurnBlock live={liveTurn} streaming={streaming} />}
        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-slate-800 px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={streaming ? "streaming response…" : "Ask the agent (Enter to send, Shift+Enter for newline)"}
            disabled={streaming}
            rows={2}
            className="flex-1 resize-none rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none disabled:opacity-60"
          />
          {streaming ? (
            <button
              onClick={cancel}
              className="rounded border border-red-600 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="rounded border border-fuchsia-600 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-300 hover:bg-fuchsia-500/20 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface LiveTurnState {
  text: string;
  toolUses: Array<{ name: string; input?: unknown; id?: string }>;
  error: string | null;
}

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
    if (!g) {
      g = { turn: m.turn, tools: [] };
      map.set(m.turn, g);
    }
    if (m.role === "user") g.user = m;
    else if (m.role === "assistant") g.assistant = m;
    else if (m.role === "tool") g.tools.push(m);
  }
  return Array.from(map.values()).sort((a, b) => a.turn - b.turn);
}

function TurnBlock({ turn }: { turn: TurnGroup }) {
  return (
    <div className="space-y-2">
      {turn.user && <UserBubble content={turn.user.content} />}
      {(turn.assistant || turn.tools.length > 0) && (
        <div className="space-y-1">
          {turn.tools.map((t) => (
            <ToolChip key={t.id} name={t.tool_name ?? "tool"} input={t.content} />
          ))}
          {turn.assistant && <AssistantBubble content={turn.assistant.content} />}
        </div>
      )}
    </div>
  );
}

function LiveTurnBlock({ live, streaming }: { live: LiveTurnState; streaming: boolean }) {
  return (
    <div className="space-y-1">
      {live.toolUses.map((t, i) => (
        <ToolChip key={`${t.id ?? i}`} name={t.name} input={stringifyInput(t.input)} />
      ))}
      {(live.text || streaming) && (
        <AssistantBubble content={live.text || (streaming ? "▍" : "")} streaming={streaming} />
      )}
      {live.error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {live.error}
        </div>
      )}
    </div>
  );
}

function stringifyInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-1.5 text-xs text-slate-100 whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] rounded-lg rounded-bl-sm border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 whitespace-pre-wrap">
        {content}
        {streaming && <span className="inline-block w-1 h-3 ml-0.5 bg-slate-400 animate-pulse align-middle" />}
      </div>
    </div>
  );
}

function ToolChip({ name, input }: { name: string; input: string }) {
  // Trim the input to a one-line preview so tool chips stay compact.
  const preview = input.replace(/\s+/g, " ").slice(0, 80);
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-950/80 px-2 py-0.5 text-[10px] text-slate-400 font-mono">
        <span className="text-indigo-400">🔧</span>
        <span className="text-slate-300">{name}</span>
        {preview && <span className="text-slate-500 truncate max-w-[40ch]">{preview}</span>}
      </div>
    </div>
  );
}
