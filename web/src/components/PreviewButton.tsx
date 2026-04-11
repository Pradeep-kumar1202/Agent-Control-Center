import { useEffect, useRef, useState } from "react";
import { api, type PreviewKind, type PreviewState } from "../api";

interface Props {
  repoKey: "web" | "mobile";
  branch: string;
  /** When provided, clicking the button opens the drawer instead of starting inline. */
  onOpen?: () => void;
}

const KIND_LABEL: Record<PreviewKind, string> = {
  "web-dev": "Web preview",
  "android-emulator": "Android preview",
};

function defaultKindFor(repoKey: "web" | "mobile"): PreviewKind {
  return repoKey === "web" ? "web-dev" : "android-emulator";
}

export function PreviewButton({ repoKey, branch, onOpen }: Props) {
  const kind = defaultKindFor(repoKey);
  const [state, setState] = useState<PreviewState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  // On mount, ask the server whether a preview is already running for this repo.
  useEffect(() => {
    let cancelled = false;
    api
      .getPreview(repoKey)
      .then((s) => {
        if (cancelled) return;
        if (s && s.branch === branch) setState(s);
      })
      .catch(() => { /* ignore */ });
    return () => {
      cancelled = true;
    };
  }, [repoKey, branch]);

  // Poll while a preview for THIS branch is starting.
  useEffect(() => {
    const isOurs = state && state.branch === branch;
    if (!isOurs || state.status !== "starting") {
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
        setLogs(l.lines.slice(-15));
      } catch { /* */ }
    }, 1500);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [state, repoKey, branch]);

  const onStart = async () => {
    setError(null);
    // When the parent provides onOpen (drawer mode), defer to it — the
    // drawer will start the preview itself and show the live screen.
    if (onOpen) {
      onOpen();
      return;
    }
    try {
      const s = await api.startPreview(repoKey, branch, kind);
      setState(s);
      setExpanded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onStop = async () => {
    try {
      const r = await api.stopPreview(repoKey);
      if (r.state) setState(r.state);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onCopyTunnel = async () => {
    if (!state?.url) return;
    const port = new URL(state.url).port || "9050";
    const cmd = `ssh -L ${port}:localhost:${port} sdk@<linux-host>`;
    try {
      await navigator.clipboard.writeText(cmd);
    } catch { /* clipboard may be blocked */ }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const isOurs = state && state.branch === branch;

  // Idle (no preview, or preview is for a different branch).
  if (!isOurs) {
    return (
      <button
        onClick={onStart}
        title={`Start ${KIND_LABEL[kind]}`}
        className="rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300 transition"
      >
        Preview
      </button>
    );
  }

  if (state.status === "starting") {
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <button
          disabled
          className="rounded border border-fuchsia-500/50 bg-fuchsia-500/10 px-3 py-1 text-xs font-medium text-fuchsia-300 cursor-wait"
        >
          Starting…
        </button>
        {expanded && logs.length > 0 && (
          <pre className="max-w-[420px] max-h-32 overflow-y-auto rounded bg-slate-950/80 border border-slate-800 p-2 text-[10px] leading-tight text-slate-400 font-mono whitespace-pre-wrap text-left">
            {logs.join("\n")}
          </pre>
        )}
      </div>
    );
  }

  if (state.status === "ready") {
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          {state.url ? (
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-emerald-600 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition"
              title="Open dev server"
            >
              Open ↗
            </a>
          ) : (
            <span
              className="rounded border border-emerald-600 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300"
              title="APK installed on emulator — switch to scrcpy / emulator window"
            >
              On emulator
            </span>
          )}
          {state.url && (
            <button
              onClick={onCopyTunnel}
              title="Copy SSH port-forward command"
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500 transition"
            >
              tunnel
            </button>
          )}
          <button
            onClick={onStop}
            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-red-500 hover:text-red-300 transition"
            title="Stop dev server"
          >
            stop
          </button>
        </div>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="inline-flex flex-col items-end gap-1">
        <button
          onClick={onStart}
          className="rounded border border-red-600 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/20 transition"
          title={state.error ?? "Preview failed"}
        >
          Retry
        </button>
        {state.error && (
          <p className="max-w-[260px] text-[10px] text-red-400 text-right">
            {state.error}
          </p>
        )}
      </div>
    );
  }

  // stopped
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={onStart}
        className="rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-fuchsia-500 hover:text-fuchsia-300 transition"
      >
        Preview
      </button>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
