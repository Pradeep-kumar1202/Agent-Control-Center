import { useEffect, useRef, useState } from "react";
import { api, type PreviewKind, type PreviewState } from "../api";

interface Props {
  repoKey: "web" | "mobile";
  branch: string;
  /** PR URL to surface in the drawer header, when one exists for this branch. */
  prUrl?: string | null;
  /** Warning text from the patches table when PR creation failed. */
  prWarning?: string | null;
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
export function PreviewDrawer({ repoKey, branch, prUrl, prWarning, onClose }: Props) {
  const kind = defaultKindFor(repoKey);
  const [state, setState] = useState<PreviewState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [shotTick, setShotTick] = useState(0);
  const [tapRipple, setTapRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const [mirrorPort, setMirrorPort] = useState<number | null>(null);
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50">
      <div className="w-full sm:w-[60vw] h-full bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
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

        {/* Viewport */}
        <div className="flex-1 min-h-0 flex flex-col">
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

          {/* Mobile-only nav bar: back/home buttons for the screenshot
              fallback. Hidden when ws-scrcpy is active because the iframe
              has its own touch/keyboard controls. */}
          {kind === "android-emulator" && state?.status === "ready" && !mirrorPort && (
            <div className="border-t border-slate-800 bg-slate-950/60 px-4 py-1.5 flex items-center gap-2">
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
              <button
                onClick={() =>
                  fetch("/api/preview/mobile/launch-app", { method: "POST" }).catch(() => {})
                }
                className="rounded border border-emerald-700 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
                title="Re-launch the hyperswitch demo app (use this if you ended up on the home screen)"
              >
                ↻ Relaunch app
              </button>
              <span className="text-[10px] text-slate-500 ml-auto">
                tip: click anywhere on the screen to tap
              </span>
            </div>
          )}

          {/* Log tail */}
          <div className="border-t border-slate-800 bg-slate-950/80">
            <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-800">
              logs ({logs.length} lines)
            </div>
            <pre className="px-4 py-2 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap max-h-56 overflow-y-auto">
              {logs.join("\n") || "(no output yet)"}
            </pre>
          </div>
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
