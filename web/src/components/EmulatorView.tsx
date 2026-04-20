import { useEffect, useRef, useState } from "react";
import { api, type PreviewKind, type PreviewState } from "../api";

interface Props {
  repoKey: "web" | "mobile";
  branch: string;
  /** Auto-start the preview on mount. Default true. */
  autoStart?: boolean;
  /** Height mode — "fill" uses flex-1 min-h-0; "fixed" uses a fixed aspect box. */
  heightMode?: "fill" | "fixed";
}

/** Map a click on the rendered img to the emulator's pixel coords. */
function clickToEmulatorCoords(
  e: React.MouseEvent<HTMLImageElement>,
): { x: number; y: number } | null {
  const img = e.currentTarget;
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const rect = img.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const containerRatio = rect.width / rect.height;
  const imgRatio = img.naturalWidth / img.naturalHeight;
  let renderedW: number;
  let renderedH: number;
  let offsetX: number;
  let offsetY: number;
  if (imgRatio > containerRatio) {
    renderedW = rect.width;
    renderedH = rect.width / imgRatio;
    offsetX = 0;
    offsetY = (rect.height - renderedH) / 2;
  } else {
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

function defaultKindFor(repoKey: "web" | "mobile"): PreviewKind {
  return repoKey === "web" ? "web-dev" : "android-emulator";
}

/**
 * Live emulator / web-preview viewport. Handles preview start/stop/status,
 * log tailing, scrcpy iframe preference with screenshot fallback, and
 * mobile device controls (Back/Home/Apps/Reload JS/Recompile).
 *
 * Extracted from the old PreviewDrawer so the PreviewPanel's Emulator tab
 * can drop it in without re-implementing any of the ADB plumbing.
 */
export function EmulatorView({ repoKey, branch, autoStart = true, heightMode = "fill" }: Props) {
  const kind = defaultKindFor(repoKey);
  const [state, setState] = useState<PreviewState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shotTick, setShotTick] = useState(0);
  const [tapRipple, setTapRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const [mirrorPort, setMirrorPort] = useState<number | null>(null);
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
          return;
        }
        if (!autoStart) {
          setState(existing);
          return;
        }
        const started = await api.startPreview(repoKey, branch, kind);
        if (cancelled) return;
        setState(started);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoKey, branch, kind, autoStart]);

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
      } catch {
        /* */
      }
    }, 1500);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [state, repoKey]);

  // Fetch ws-scrcpy mirror URL once android preview is ready.
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

  // Screenshot fallback while scrcpy spins up.
  useEffect(() => {
    const shouldPoll =
      kind === "android-emulator" && state?.status === "ready" && mirrorPort === null;
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
    } catch {
      /* */
    }
  };

  const onStart = async () => {
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
    if (!state) return <Pill tone="slate">idle</Pill>;
    if (state.status === "starting") return <Pill tone="amber">starting</Pill>;
    if (state.status === "ready") return <Pill tone="emerald">ready</Pill>;
    if (state.status === "failed") return <Pill tone="red">failed</Pill>;
    if (state.status === "stopped") return <Pill tone="slate">stopped</Pill>;
    return <Pill tone="slate">{state.status}</Pill>;
  })();

  const viewportClass =
    heightMode === "fixed"
      ? "relative bg-slate-950 flex items-center justify-center overflow-hidden h-[560px]"
      : "flex-1 min-h-0 bg-slate-950 flex items-center justify-center overflow-hidden";

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Action strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Target</span>
        <code className="text-xs text-indigo-300">
          {repoKey}
          <span className="text-slate-600"> · </span>
          {branch}
        </code>
        {statusPill}
        <div className="flex-1" />
        {(state?.status === "stopped" || state?.status === "failed" || !state) && (
          <button
            onClick={onStart}
            className="rounded border border-emerald-600 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"
          >
            ▶ Start
          </button>
        )}
        {state?.status !== "stopped" && state?.status !== "failed" && state && (
          <button
            onClick={onStop}
            className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:border-red-500 hover:text-red-300"
          >
            ■ Stop
          </button>
        )}
        {state?.url && (
          <a
            href={state.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-emerald-300 hover:text-emerald-200 underline"
          >
            open ↗
          </a>
        )}
      </div>

      {/* Viewport */}
      <div className={viewportClass}>
        {error && (
          <div className="text-sm text-red-400 max-w-md text-center px-4">{error}</div>
        )}
        {!error && (!state || (state.status !== "ready")) && (
          <div className="flex flex-col items-center gap-3 text-center px-4">
            <div className="text-sm text-slate-500">
              {state?.status === "failed"
                ? state.error
                : state?.status === "stopped"
                  ? "Preview stopped."
                  : state?.status === "starting"
                    ? "Starting preview… (this takes ~30s for web, ~60s for the Android emulator)"
                    : "No preview running."}
            </div>
            {state?.status !== "starting" && (
              <button
                onClick={onStart}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 inline-flex items-center gap-2 shadow-lg"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
                  <polygon points="3,2 11,7 3,12" />
                </svg>
                Start preview
              </button>
            )}
            {state?.status === "starting" && (
              <div className="h-4 w-4 rounded-full border-2 border-slate-600 border-t-emerald-400 animate-spin" />
            )}
          </div>
        )}
        {!error && state?.status === "ready" && kind === "web-dev" && state.url && (
          <iframe
            src={state.url}
            title="web preview"
            className="w-full h-full border-0 bg-white"
          />
        )}
        {!error &&
          state?.status === "ready" &&
          kind === "android-emulator" &&
          mirrorPort && (
            <iframe
              src={`http://${window.location.hostname}:${mirrorPort}/`}
              title="emulator mirror (ws-scrcpy)"
              className="w-full h-full border-0 bg-black"
              allow="autoplay; fullscreen"
            />
          )}
        {!error &&
          state?.status === "ready" &&
          kind === "android-emulator" &&
          !mirrorPort && (
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
                  if (!coords) return;
                  const id = ++rippleId.current;
                  setTapRipple({ x: localX, y: localY, id });
                  setTimeout(() => {
                    setTapRipple((cur) => (cur && cur.id === id ? null : cur));
                  }, 600);
                  try {
                    await fetch("/api/preview/mobile/tap", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ x: coords.x, y: coords.y }),
                    });
                    setShotTick((t) => t + 1);
                  } catch {
                    /* */
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

      {/* Mobile control bar */}
      {kind === "android-emulator" && state?.status === "ready" && (
        <div className="border-t border-slate-800 bg-slate-950/60 px-3 py-1.5 flex items-center gap-2 flex-wrap">
          {!mirrorPort && (
            <>
              <ControlButton
                onClick={() => sendKey("KEYCODE_BACK")}
                title="Send back key"
              >
                ◀ Back
              </ControlButton>
              <ControlButton onClick={() => sendKey("KEYCODE_HOME")} title="Send home key">
                ● Home
              </ControlButton>
              <ControlButton
                onClick={() => sendKey("KEYCODE_APP_SWITCH")}
                title="App switcher"
              >
                ▣ Apps
              </ControlButton>
            </>
          )}
          <button
            onClick={() =>
              fetch("/api/preview/mobile/launch-app", { method: "POST" }).catch(() => {})
            }
            className="rounded border border-emerald-700 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
            title="Re-launch the demo app"
          >
            ↻ Relaunch app
          </button>
          <button
            onClick={async () => {
              setReloadBusy(true);
              try {
                await fetch("/api/preview/mobile/metro-reload", { method: "POST" });
              } catch {
                /* */
              }
              setReloadBusy(false);
            }}
            disabled={reloadBusy}
            className="rounded border border-sky-700 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
            title="Tell Metro to broadcast a reload"
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
            title="re:build + reload the running app"
          >
            {recompileBusy ? "compiling…" : "⟳ Compile & reload"}
          </button>
          {!mirrorPort && (
            <span className="text-[10px] text-slate-500 ml-auto">click screen to tap</span>
          )}
        </div>
      )}

      {/* Log tail — collapsible */}
      <div className="border-t border-slate-800 bg-slate-950/80 shrink-0">
        <button
          onClick={() => setLogsExpanded((v) => !v)}
          className="w-full px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 hover:text-slate-300 border-b border-slate-800 flex items-center justify-between"
        >
          <span>logs ({logs.length})</span>
          <span className="text-slate-400">{logsExpanded ? "▼" : "▶"}</span>
        </button>
        {logsExpanded && (
          <pre className="px-3 py-2 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
            {logs.join("\n") || "(no output yet)"}
          </pre>
        )}
      </div>
    </div>
  );
}

function sendKey(keycode: string): void {
  void fetch("/api/preview/mobile/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keycode }),
  }).catch(() => {});
}

function ControlButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300"
    >
      {children}
    </button>
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
