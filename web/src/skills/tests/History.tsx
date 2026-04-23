import { useEffect, useState } from "react";
import { api, type TestRunSummary, type TestRunFull, type TestRunStatus } from "../../api";

interface Props {
  repo: "web" | "mobile";
  branch: string;
  /** Bump this number after a run finishes to trigger a refetch. */
  refreshKey?: number;
}

/** Past Detox / Cypress runs for a given repo+branch. Click to replay logs. */
export function TestHistory({ repo, branch, refreshKey = 0 }: Props) {
  const [runs, setRuns] = useState<TestRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [openDetail, setOpenDetail] = useState<TestRunFull | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listTestRuns({ repo, branch, limit: 20 })
      .then((r) => {
        if (!cancelled) {
          setRuns(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [repo, branch, refreshKey]);

  const toggleOpen = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      setOpenDetail(null);
      return;
    }
    setOpenId(id);
    setOpenDetail(null);
    setLoadingDetail(true);
    try {
      const row = await api.getTestRun(id);
      setOpenDetail(row);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingDetail(false);
    }
  };

  if (error) {
    return (
      <div className="px-6 py-3 text-xs text-red-400">history: {error}</div>
    );
  }
  if (!runs) {
    return (
      <div className="px-6 py-3 text-xs text-slate-500 animate-pulse">loading history…</div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="px-6 py-3 text-xs text-slate-600">
        No past runs for {repo}/{branch} yet.
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <div className="text-xs text-slate-400 mb-2 font-medium">
        Past runs ({runs.length})
      </div>
      <div className="space-y-1">
        {runs.map((r) => (
          <div key={r.id} className="rounded border border-slate-800 bg-slate-950/60">
            <button
              onClick={() => void toggleOpen(r.id)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-900/60"
            >
              <StatusBadge status={r.status} />
              <span className="text-[11px] text-slate-500 font-mono w-32 truncate">
                {formatTime(r.started_at)}
              </span>
              <span className="text-[11px] text-slate-600">
                {r.repo === "web" ? "Cypress" : "Detox"}
              </span>
              <span className="text-xs flex-1 text-slate-300">
                {(r.pass_count ?? 0) > 0 || (r.fail_count ?? 0) > 0 ? (
                  <>
                    <span className="text-emerald-400">{r.pass_count ?? 0} passed</span>
                    <span className="text-slate-600 mx-1">·</span>
                    <span className={r.fail_count ? "text-red-400" : "text-slate-500"}>
                      {r.fail_count ?? 0} failed
                    </span>
                  </>
                ) : (
                  <span className="text-slate-600">—</span>
                )}
              </span>
              {r.pr_url && (
                <a
                  href={r.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[11px] text-emerald-400 hover:text-emerald-300 truncate max-w-[200px]"
                >
                  PR
                </a>
              )}
              <span className="text-slate-600 text-xs">{openId === r.id ? "▾" : "▸"}</span>
            </button>
            {openId === r.id && (
              <div className="border-t border-slate-800 px-3 py-2 bg-slate-950/80">
                {loadingDetail && (
                  <div className="text-[11px] text-slate-500 animate-pulse">loading…</div>
                )}
                {openDetail && (
                  <ReplayLog logs={openDetail.logs_ndjson} errorMessage={openDetail.error_message} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReplayLog({
  logs,
  errorMessage,
}: {
  logs: string | null;
  errorMessage: string | null;
}) {
  const lines: string[] = [];
  if (logs) {
    for (const raw of logs.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const obj = JSON.parse(raw) as { type?: string; line?: string; error?: string };
        if (obj.type === "log" && obj.line) lines.push(obj.line);
        else if (obj.type === "error" && obj.error) lines.push(`[error] ${obj.error}`);
      } catch {
        /* skip malformed */
      }
    }
  }
  return (
    <>
      {errorMessage && (
        <div className="text-[11px] text-red-400 mb-1">{errorMessage}</div>
      )}
      {lines.length === 0 ? (
        <div className="text-[11px] text-slate-600">no logs captured</div>
      ) : (
        <pre className="max-h-80 overflow-y-auto text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap">
          {lines.join("\n")}
        </pre>
      )}
    </>
  );
}

function StatusBadge({ status }: { status: TestRunStatus }) {
  const map: Record<TestRunStatus, { bg: string; fg: string; label: string }> = {
    running: { bg: "bg-amber-500/20", fg: "text-amber-300", label: "running" },
    passed: { bg: "bg-emerald-500/20", fg: "text-emerald-300", label: "passed" },
    failed: { bg: "bg-red-500/20", fg: "text-red-300", label: "failed" },
    error: { bg: "bg-slate-700/50", fg: "text-slate-300", label: "error" },
  };
  const s = map[status] ?? map.error;
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.bg} ${s.fg}`}>
      {s.label}
    </span>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
