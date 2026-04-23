import { useEffect, useRef, useState } from "react";
import { api, PR_STATES, type PrState } from "../api";

interface Props {
  prUrl: string;
  prNumber?: number | null;
  /**
   * Initial state. Pass `undefined` to let the chip fetch its own state on
   * mount (cheap; /api/pr-states returns the full map). Pass `null` or a
   * concrete PrState if the parent already has it (avoids the extra fetch).
   */
  initialState?: PrState | null;
  /** Notifies the parent when the state changes so it can update any local map. */
  onStateChange?: (state: PrState | null) => void;
}

// Tiny in-module cache so N chips mounting together share one fetch.
let cachedMap: Promise<Record<string, { state: PrState; updated_at: string }>> | null = null;
let cachedAt = 0;
async function loadPrStates() {
  const now = Date.now();
  if (!cachedMap || now - cachedAt > 30_000) {
    cachedAt = now;
    cachedMap = api.listPrStates().catch(() => ({} as Record<string, { state: PrState; updated_at: string }>));
  }
  return cachedMap;
}

const LABELS: Record<PrState, string> = {
  draft: "Draft",
  awaiting_review: "Awaiting review",
  changes_requested: "Changes requested",
  approved: "Approved",
  merged: "Merged",
  tested: "Tested",
};

const DOT_BG: Record<PrState, string> = {
  draft: "bg-slate-400",
  awaiting_review: "bg-sky-400",
  changes_requested: "bg-amber-400",
  approved: "bg-emerald-400",
  merged: "bg-violet-400",
  tested: "bg-teal-400",
};

const CHIP_BORDER: Record<PrState, string> = {
  draft: "border-slate-600 hover:border-slate-400",
  awaiting_review: "border-sky-700 hover:border-sky-500",
  changes_requested: "border-amber-700 hover:border-amber-500",
  approved: "border-emerald-700 hover:border-emerald-500",
  merged: "border-violet-700 hover:border-violet-500",
  tested: "border-teal-700 hover:border-teal-500",
};

function deriveNumberLabel(prUrl: string, prNumber?: number | null): string {
  if (typeof prNumber === "number" && prNumber > 0) return `#${prNumber}`;
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? `#${m[1]}` : "PR";
}

export function PrStatusChip({ prUrl, prNumber, initialState, onStateChange }: Props) {
  const [state, setState] = useState<PrState | null>(initialState ?? null);
  const [open, setOpen] = useState(false);
  const [flashError, setFlashError] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialState !== undefined) {
      setState(initialState);
      return;
    }
    let cancelled = false;
    loadPrStates().then((map) => {
      if (cancelled) return;
      setState(map[prUrl]?.state ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [initialState, prUrl]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const commit = async (next: PrState | null) => {
    const prev = state;
    setState(next);
    setOpen(false);
    try {
      await api.setPrState(prUrl, next);
      // Invalidate the shared cache so other chips mounting after this change
      // don't read a stale map.
      cachedMap = null;
      cachedAt = 0;
      onStateChange?.(next);
    } catch {
      setState(prev);
      setFlashError(true);
      setTimeout(() => setFlashError(false), 1000);
    }
  };

  const borderCls = state
    ? CHIP_BORDER[state]
    : "border-slate-700 hover:border-slate-500";
  const flashCls = flashError ? "border-rose-500 bg-rose-500/10" : "";

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={state ? `PR status: ${LABELS[state]} — click to change` : "Set PR status"}
        className={`inline-flex items-center gap-2 rounded border px-2.5 py-1 text-xs transition ${borderCls} ${flashCls}`}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${state ? DOT_BG[state] : "ring-1 ring-slate-500"}`}
        />
        <span className={state ? "text-slate-100" : "text-slate-400"}>
          {state ? LABELS[state] : "Set PR status"}
        </span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className="text-slate-500"
          aria-hidden
        >
          <path d="M1 2.5 L4 5.5 L7 2.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={prUrl}
        className="text-xs font-mono text-slate-400 hover:text-indigo-300"
      >
        {deriveNumberLabel(prUrl, prNumber)}
      </a>

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        title="Open PR on GitHub"
        className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-700 text-slate-400 hover:text-indigo-300 hover:border-indigo-500"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path
            d="M3 1 H9 V7 M9 1 L3.5 6.5 M1 4 V9 H6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-1 w-52 rounded-md border border-slate-700 bg-slate-900 p-1 shadow-lg"
        >
          {PR_STATES.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={state === s}
              onClick={() => commit(s)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                state === s
                  ? "bg-slate-800 text-slate-100"
                  : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${DOT_BG[s]}`} />
              <span>{LABELS[s]}</span>
              {state === s && (
                <span className="ml-auto text-[10px] text-slate-500">current</span>
              )}
            </button>
          ))}
          {state !== null && (
            <>
              <div className="my-1 h-px bg-slate-800" />
              <button
                onClick={() => commit(null)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <span className="inline-block h-2 w-2 rounded-full ring-1 ring-slate-500" />
                Clear status
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
