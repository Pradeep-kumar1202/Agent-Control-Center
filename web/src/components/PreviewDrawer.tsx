import { useEffect, useRef, useState } from "react";
import { api, type ChatMessageRow, type ChatStreamChunk, type PreviewKind, type PreviewState } from "../api";
import { readNdjson } from "./ndjson";

interface Props {
  repoKey: "web" | "mobile";
  branch: string;
  /** PR URL to surface in the drawer header, when one exists for this branch. */
  prUrl?: string | null;
  /** Warning text from the patches table when PR creation failed. */
  prWarning?: string | null;
  /** Patch row ID — required for chat. Undefined hides the chat panel. */
  patchId?: number | null;
  /** Canonical name of the gap, shown in the chat panel header. */
  gapName?: string;
  onClose: () => void;
}

/** Map a click on the rendered img element to the emulator's pixel coords. */
function clickToEmulatorCoords(e: React.MouseEvent<HTMLImageElement>): { x: number; y: number } | null {
  const img = e.currentTarget;
  // naturalWidth/Height match the device resolution because adb screencap
  // returns the raw framebuffer.
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const rect = img.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // The img uses object-contain, so the actual pixels live in a centered
  // sub-rect of the element. Compute that sub-rect.
  const containerRatio = rect.width / rect.height;
  const imgRatio = img.naturalWidth / img.naturalHeight;
  let renderedW: number;
  let renderedH: number;
  let offsetX: number;
  let offsetY: number;
  if (imgRatio > containerRatio) {
    // letterboxed top/bottom
    renderedW = rect.width;
    renderedH = rect.width / imgRatio;
    offsetX = 0;
    offsetY = (rect.height - renderedH) / 2;
  } else {
    // pillarboxed left/right
    renderedH = rect.height;
    renderedW = rect.height * imgRatio;
    offsetX = (rect.width - renderedW) / 2;
    offsetY = 0;
  }
  const localX = cx - offsetX;
  const localY = cy - offsetY;
  if (localX < 0 || localY < 0 || localX > renderedW || localY > renderedH) return null;
  return {
    x: (localX / renderedW) * img.naturalWidth,
    y: (localY / renderedH) * img.naturalHeight,
  };
}

const KIND_LABEL: Record<PreviewKind, string> = {
  "web-dev": "Web preview",
  "android-emulator": "Android preview",
};

function defaultKindFor(repoKey: "web" | "mobile"): PreviewKind {
  return repoKey === "web" ? "web-dev" : "android-emulator";
}

/**
 * Right-edge drawer (~60% viewport) hosting the live preview for a feature
 * branch. For `web`, we iframe the dev server on :9050. For `mobile`, we
 * poll a PNG screenshot of the running emulator at ~2 fps via the
 * `/preview/mobile/screenshot` endpoint (view-only — no touch input).
 *
 * Logs from previewManager are tailed live below the viewport so the user
 * can watch builds and emulator boot output without leaving the drawer.
 */
export function PreviewDrawer({ repoKey, branch, prUrl, prWarning, patchId, gapName, onClose }: Props) {
  const kind = defaultKindFor(repoKey);
  const [state, setState] = useState<PreviewState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shotTick, setShotTick] = useState(0);
  const [tapRipple, setTapRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const [mirrorPort, setMirrorPort] = useState<number | null>(null);
  // Collapsed by default for recording — viewport gets all vertical space.
  // User can expand if they want to debug logs during a run.
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [recompileBusy, setRecompileBusy] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const shotTimer = useRef<number | null>(null);
  const rippleId = useRef(0);

  // Initial state fetch + start if needed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await api.getPreview(repoKey);
        if (cancelled) return;
        if (existing && existing.branch === branch) {
          setState(existing);
        } else {
          const started = await api.startPreview(repoKey, branch, kind);
          if (cancelled) return;
          setState(started);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoKey, branch, kind]);

  // Poll preview state + logs while not stopped.
  useEffect(() => {
    if (!state || state.status === "stopped" || state.status === "failed") {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    pollTimer.current = window.setInterval(async () => {
      try {
        const [s, l] = await Promise.all([
          api.getPreview(repoKey),
          api.getPreviewLogs(repoKey),
        ]);
        if (s) setState(s);
        setLogs(l.lines.slice(-200));
      } catch { /* */ }
    }, 1500);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [state, repoKey]);

  // Fetch the ws-scrcpy mirror URL once the android preview is ready.
  // Spinning ws-scrcpy up on-demand can take a second or two — we handle
  // the transient failure by keeping the screenshot poll running as a
  // fallback until mirrorPort is populated.
  useEffect(() => {
    if (kind !== "android-emulator" || state?.status !== "ready") {
      setMirrorPort(null);
      setMirrorError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/preview/mobile/mirror-url");
        const j = await r.json();
        if (cancelled) return;
        if (r.ok && j.port) setMirrorPort(j.port);
        else setMirrorError(j.error ?? "mirror unavailable");
      } catch (e) {
        if (!cancelled) setMirrorError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, state?.status]);

  // Screenshot fallback — only active while mirror isn't up. Once ws-scrcpy
  // takes over we stop hammering adb screencap.
  useEffect(() => {
    const shouldPoll =
      kind === "android-emulator" &&
      state?.status === "ready" &&
      mirrorPort === null;
    if (!shouldPoll) {
      if (shotTimer.current) {
        clearInterval(shotTimer.current);
        shotTimer.current = null;
      }
      return;
    }
    shotTimer.current = window.setInterval(() => setShotTick((t) => t + 1), 500);
    return () => {
      if (shotTimer.current) {
        clearInterval(shotTimer.current);
        shotTimer.current = null;
      }
    };
  }, [kind, state?.status, mirrorPort]);

  const onStop = async () => {
    try {
      const r = await api.stopPreview(repoKey);
      if (r.state) setState(r.state);
    } catch { /* */ }
    // Intentionally NOT calling onClose — leave the drawer open so the user
    // can read final logs and use Restart without re-mounting.
  };

  const onRetry = async () => {
    setError(null);
    try {
      const s = await api.startPreview(repoKey, branch, kind);
      setState(s);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const statusPill = (() => {
    if (error) return <Pill tone="red">error</Pill>;
    if (!state) return <Pill tone="slate">connecting…</Pill>;
    if (state.status === "starting") return <Pill tone="amber">starting</Pill>;
    if (state.status === "ready") return <Pill tone="emerald">ready</Pill>;
    if (state.status === "failed") return <Pill tone="red">failed</Pill>;
    return <Pill tone="slate">{state.status}</Pill>;
  })();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="w-full lg:w-[92vw] xl:w-[88vw] h-full bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-100 truncate">
              {KIND_LABEL[kind]} — <code className="text-indigo-300">{branch}</code>
            </h2>
            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
              {statusPill}
              {state?.url && (
                <a
                  href={state.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-300 hover:text-emerald-200 underline"
                >
                  open in new tab ↗
                </a>
              )}
              {prUrl && (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-emerald-600 bg-emerald-500/10 px-2 py-0.5 text-emerald-300 hover:bg-emerald-500/20"
                >
                  Open PR ↗
                </a>
              )}
              {!prUrl && prWarning && (
                <span
                  className="rounded border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-amber-300 truncate max-w-[40ch]"
                  title={prWarning}
                >
                  PR not opened: {prWarning.length > 40 ? prWarning.slice(0, 40) + "…" : prWarning}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(state?.status === "failed" || state?.status === "stopped") && (
              <button
                onClick={onRetry}
                className="rounded border border-emerald-600 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
                title="Re-run npm run android — installs the APK and launches the demo app again. The emulator stays up."
              >
                ↻ Restart preview
              </button>
            )}
            {state?.status !== "stopped" && state?.status !== "failed" && (
              <button
                onClick={onStop}
                className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:border-red-500 hover:text-red-300"
              >
                Stop
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500"
            >
              Hide
            </button>
          </div>
        </div>

        {/* Body: viewport column (left) + chat panel (right) */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* Viewport column */}
        <div className="flex-1 min-h-0 flex flex-col lg:w-[65%]">
          <div className="flex-1 min-h-0 bg-slate-950 flex items-center justify-center overflow-hidden">
            {error && (
              <div className="text-sm text-red-400 max-w-md text-center px-4">
                {error}
              </div>
            )}
            {!error && state?.status !== "ready" && (
              <div className="text-sm text-slate-500 text-center px-4">
                {state?.status === "failed" ? state.error : "Waiting for preview to become ready…"}
              </div>
            )}
            {!error && state?.status === "ready" && kind === "web-dev" && state.url && (
              <iframe
                src={state.url}
                title="web preview"
                className="w-full h-full border-0 bg-white"
              />
            )}
            {!error && state?.status === "ready" && kind === "android-emulator" && mirrorPort && (
              <iframe
                src={`http://${window.location.hostname}:${mirrorPort}/`}
                title="emulator mirror (ws-scrcpy)"
                className="w-full h-full border-0 bg-black"
                allow="autoplay; fullscreen"
              />
            )}
            {!error && state?.status === "ready" && kind === "android-emulator" && !mirrorPort && (
              <div className="relative">
                <div className="absolute top-2 left-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 z-10">
                  {mirrorError ? `mirror: ${mirrorError}` : "starting live mirror…"}
                </div>
                <img
                  src={`/api/preview/mobile/screenshot?t=${shotTick}`}
                  alt="emulator screen — click to tap"
                  className="max-h-full max-w-full object-contain cursor-crosshair select-none block"
                  draggable={false}
                  onClick={async (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    const localY = e.clientY - rect.top;
                    const coords = clickToEmulatorCoords(e);
                    // eslint-disable-next-line no-console
                    console.log("[preview tap]", {
                      naturalW: e.currentTarget.naturalWidth,
                      naturalH: e.currentTarget.naturalHeight,
                      localXY: [localX, localY],
                      emuXY: coords,
                    });
                    if (!coords) {
                      console.warn("[preview tap] no coords — outside image or naturalWidth=0");
                      return;
                    }
                    // Render the ripple immediately so the user sees a hit even
                    // if the screenshot poll takes a moment to refresh.
                    const id = ++rippleId.current;
                    setTapRipple({ x: localX, y: localY, id });
                    setTimeout(() => {
                      setTapRipple((cur) => (cur && cur.id === id ? null : cur));
                    }, 600);
                    try {
                      const r = await fetch("/api/preview/mobile/tap", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ x: coords.x, y: coords.y }),
                      });
                      // eslint-disable-next-line no-console
                      console.log("[preview tap] →", r.status, await r.json().catch(() => ({})));
                      // Force an immediate screenshot refresh instead of waiting
                      // for the next 500 ms poll tick.
                      setShotTick((t) => t + 1);
                    } catch (err) {
                      // eslint-disable-next-line no-console
                      console.error("[preview tap] fetch failed", err);
                    }
                  }}
                />
                {tapRipple && (
                  <span
                    key={tapRipple.id}
                    className="pointer-events-none absolute h-6 w-6 -ml-3 -mt-3 rounded-full border-2 border-fuchsia-400 bg-fuchsia-400/30 animate-ping"
                    style={{ left: tapRipple.x, top: tapRipple.y }}
                  />
                )}
              </div>
            )}
          </div>

          {/* Mobile nav bar — always visible when android preview is ready.
              Back/Home/Apps are only for the screenshot fallback (ws-scrcpy
              iframe has its own touch + key controls), but Reload JS,
              Compile & reload, and Relaunch app are always relevant. */}
          {kind === "android-emulator" && state?.status === "ready" && (
            <div className="border-t border-slate-800 bg-slate-950/60 px-4 py-1.5 flex items-center gap-2 flex-wrap">
              {!mirrorPort && (
                <>
                  <button
                    onClick={() =>
                      fetch("/api/preview/mobile/key", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ keycode: "KEYCODE_BACK" }),
                      }).catch(() => {})
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300"
                    title="Send back key (KEYCODE_BACK)"
                  >
                    ◀ Back
                  </button>
                  <button
                    onClick={() =>
                      fetch("/api/preview/mobile/key", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ keycode: "KEYCODE_HOME" }),
                      }).catch(() => {})
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300"
                    title="Send home key"
                  >
                    ● Home
                  </button>
                  <button
                    onClick={() =>
                      fetch("/api/preview/mobile/key", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ keycode: "KEYCODE_APP_SWITCH" }),
                      }).catch(() => {})
                    }
                    className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300"
                    title="App switcher"
                  >
                    ▣ Apps
                  </button>
                </>
              )}
              <button
                onClick={() =>
                  fetch("/api/preview/mobile/launch-app", { method: "POST" }).catch(() => {})
                }
                className="rounded border border-emerald-700 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                title="Re-launch the hyperswitch demo app (use this if you ended up on the home screen)"
              >
                ↻ Relaunch app
              </button>
              <button
                onClick={async () => {
                  setReloadBusy(true);
                  try { await fetch("/api/preview/mobile/metro-reload", { method: "POST" }); } catch { /* */ }
                  setReloadBusy(false);
                }}
                disabled={reloadBusy}
                className="rounded border border-sky-700 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
                title="Tell Metro to broadcast a reload — app re-fetches the current JS bundle without restarting. Use after a chat-agent edit that was followed by re:build."
              >
                {reloadBusy ? "reloading…" : "↻ Reload JS"}
              </button>
              <button
                onClick={async () => {
                  setRecompileBusy(true);
                  try {
                    const r = await fetch("/api/preview/mobile/recompile", { method: "POST" });
                    if (!r.ok) {
                      const body = await r.json().catch(() => ({}));
                      setError((body as { error?: string }).error ?? `recompile failed (${r.status})`);
                    }
                  } catch (e) {
                    setError((e as Error).message);
                  }
                  setRecompileBusy(false);
                }}
                disabled={recompileBusy}
                className="rounded border border-fuchsia-700 bg-fuchsia-500/10 px-2 py-0.5 text-[10px] text-fuchsia-300 hover:bg-fuchsia-500/20 disabled:opacity-50"
                title="Run yarn re:build in the mobile workspace, then tell Metro to reload. One click to apply any manual edits to the running app."
              >
                {recompileBusy ? "compiling…" : "⟳ Compile & reload"}
              </button>
              {!mirrorPort && (
                <span className="text-[10px] text-slate-500 ml-auto">
                  click screen to tap
                </span>
              )}
            </div>
          )}

          {/* Log tail — collapsible. Default is collapsed during recording
              so the viewport gets maximum vertical space. One click to
              expand when you need to debug a build. */}
          <div className="border-t border-slate-800 bg-slate-950/80">
            <button
              onClick={() => setLogsExpanded((v) => !v)}
              className="w-full px-4 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300 border-b border-slate-800 flex items-center justify-between"
              title={logsExpanded ? "Hide logs" : "Show logs"}
            >
              <span>logs ({logs.length} lines)</span>
              <span className="text-slate-400">{logsExpanded ? "▼ collapse" : "▶ expand"}</span>
            </button>
            {logsExpanded && (
              <pre className="px-4 py-2 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto">
                {logs.join("\n") || "(no output yet)"}
              </pre>
            )}
          </div>
        </div>

        {/* ── Chat panel (right side) ────────────────────────────────── */}
        {patchId != null && patchId > 0 && (
          <PreviewChatPanel patchId={patchId} gapName={gapName} />
        )}

        </div>
      </div>
    </div>
  );
}

// ─── Embedded Chat Panel ─────────────────────────────────────────────────────

function PreviewChatPanel({ patchId, gapName }: { patchId: number; gapName?: string }) {
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [livePhase, setLivePhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load existing messages
  useEffect(() => {
    api.getChatMessages(patchId)
      .then((res) => setMessages(res.messages))
      .catch(() => {});
  }, [patchId]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveText]);

  async function runTestInDemo() {
    if (streaming) return;
    setError(null);
    setLiveText("");
    setLiveTools([]);
    setLivePhase("checkout");

    const syntheticUser: ChatMessageRow = {
      id: -Date.now(),
      patch_id: patchId,
      turn: (messages[messages.length - 1]?.turn ?? -1) + 1,
      role: "user",
      content: "Test this feature in the demo app.",
      tool_name: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, syntheticUser]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let accumulated = "";

    try {
      const r = await api.testFeatureInDemo(patchId, ctrl.signal);
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      type TestFeatureChunk = {
        type: string;
        phase?: string;
        text?: string;
        tool?: { name: string };
        error?: string;
        buildLogTail?: string;
      };
      for await (const chunk of readNdjson<TestFeatureChunk>(r.body)) {
        if (chunk.type === "phase_marker" && chunk.phase) {
          setLivePhase(chunk.phase);
        } else if (chunk.type === "text" && chunk.text) {
          accumulated += chunk.text;
          setLiveText((prev) => prev + chunk.text!);
        } else if (chunk.type === "tool_use" && chunk.tool) {
          setLiveTools((prev) => [...prev.slice(-9), chunk.tool!.name]);
        } else if (chunk.type === "recompile_done") {
          setLivePhase("relaunched");
        } else if (chunk.type === "error" && chunk.error) {
          setError(chunk.error);
        } else if (chunk.type === "done") {
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Preserve the agent's behavioural summary as a real assistant message
      // so the developer can read "I set X = ... the app should now show Y"
      // after the stream ends. Without this, the text disappears on phase
      // reset and the user is left with a silent recompile.
      const trimmed = accumulated.trim();
      if (trimmed) {
        const assistantMsg: ChatMessageRow = {
          id: -Date.now() - 1,
          patch_id: patchId,
          turn: syntheticUser.turn,
          role: "assistant",
          content: trimmed,
          tool_name: null,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        // Agent produced no text at all — leave a visible marker so the user
        // doesn't just see a silent relaunch.
        const fallback: ChatMessageRow = {
          id: -Date.now() - 1,
          patch_id: patchId,
          turn: syntheticUser.turn,
          role: "assistant",
          content: "App rebuilt and relaunched on the emulator. (No behaviour summary was produced — check the emulator to see what changed.)",
          tool_name: null,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, fallback]);
      }
      setLiveText("");
      setLiveTools([]);
      // Keep the livePhase banner at "relaunched" for a moment so the user
      // sees the emulator is ready; clear after a short delay.
      setTimeout(() => setLivePhase(null), 4000);
    }
  }

  async function sendChat() {
    const msg = chatInput.trim();
    if (!msg || streaming) return;
    setChatInput("");
    setError(null);
    setLiveText("");
    setLiveTools([]);

    // Optimistic add
    const userMsg: ChatMessageRow = {
      id: -Date.now(),
      patch_id: patchId,
      turn: (messages[messages.length - 1]?.turn ?? -1) + 1,
      role: "user",
      content: msg,
      tool_name: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch(`/api/patches/${patchId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: msg }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);

      for await (const chunk of readNdjson<ChatStreamChunk>(r.body)) {
        if (chunk.type === "text" && chunk.text) {
          setLiveText((prev) => prev + chunk.text!);
        } else if (chunk.type === "tool_use" && chunk.tool) {
          setLiveTools((prev) => [...prev.slice(-9), chunk.tool!.name]);
        } else if (chunk.type === "error" && chunk.error) {
          setError(chunk.error);
        } else if (chunk.type === "done") {
          break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
      try {
        const { messages: m } = await api.getChatMessages(patchId);
        setMessages(m);
      } catch { /* keep optimistic */ }
      setLiveText("");
      setLiveTools([]);
    }
  }

  return (
    <div className="hidden lg:flex flex-col lg:w-[35%] border-l border-slate-800 bg-slate-950/40">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
        <span className="text-xs font-medium text-slate-300">Agent Chat</span>
        {gapName && <span className="text-[10px] text-slate-500 truncate flex-1">{gapName}</span>}
        <button
          onClick={() => void runTestInDemo()}
          disabled={streaming}
          title="Edit the demo app to exercise the patched feature, then recompile + relaunch"
          className="shrink-0 rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
        >
          Test in demo app
        </button>
      </div>
      {livePhase && (
        <div className="px-3 py-1 border-b border-slate-800 text-[10px] text-emerald-300/80 bg-emerald-500/5">
          {livePhase === "checkout" && "Checking out patch branch…"}
          {livePhase === "editing_demo_app" && "Agent editing demo app…"}
          {livePhase === "recompile" && "Rebuilding + relaunching app on emulator…"}
          {livePhase === "relaunched" && "App relaunched — check the emulator."}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && !streaming && (
          <div className="text-[11px] text-slate-500 text-center py-8">
            Chat with the agent that generated this patch. Ask it to fix issues or refine the implementation.
          </div>
        )}
        {messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m, i) => (
            <div
              key={i}
              className={`max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap break-words ${
                m.role === "user"
                  ? "ml-auto bg-indigo-600/80 text-white"
                  : "bg-slate-800/80 text-slate-300"
              }`}
            >
              {m.content}
            </div>
          ))}

        {/* Live streaming text */}
        {streaming && liveText && (
          <div className="max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed bg-slate-800/80 text-slate-300 whitespace-pre-wrap">
            {liveText}
            <span className="opacity-40 animate-pulse">|</span>
          </div>
        )}

        {/* Tool chips */}
        {streaming && liveTools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {liveTools.map((name, i) => (
              <span key={i} className="inline-flex rounded border border-slate-700 bg-slate-800/50 px-1.5 py-0.5 text-[9px] text-slate-400">
                {name}
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="text-[10px] text-red-400 px-2">{error}</div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-slate-800 shrink-0 flex gap-2">
        <textarea
          placeholder="Ask the agent..."
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendChat();
            }
          }}
          disabled={streaming}
          rows={2}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-2.5 py-1.5 text-[11px] text-slate-200 resize-none outline-none placeholder-slate-600 focus:border-indigo-500/50"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={() => void sendChat()}
            disabled={streaming || !chatInput.trim()}
            className="rounded border border-indigo-500/50 bg-indigo-500/20 px-2 py-1 text-[10px] text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-40"
          >
            Send
          </button>
          {streaming && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="rounded border border-red-500/50 bg-red-500/10 px-2 py-1 text-[10px] text-red-300"
            >
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: "slate" | "amber" | "emerald" | "red";
  children: React.ReactNode;
}) {
  const cls = {
    slate: "bg-slate-700/40 text-slate-300 border-slate-600",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/40",
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40",
    red: "bg-red-500/10 text-red-300 border-red-500/40",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}
