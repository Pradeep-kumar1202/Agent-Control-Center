/**
 * ReviewHistory — shows the list of past PR reviews stored in SQLite.
 * Click any row to reopen the full analysis without re-running the review.
 */

import { useEffect, useState } from "react";
import { api, type ReviewHistoryRow, type SkillEnvelope } from "../../api";
import { ReviewResults } from "./Results";

function VerdictBadge({ verdict }: { verdict: ReviewHistoryRow["verdict"] }) {
  const styles: Record<string, string> = {
    approve: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    request_changes: "bg-red-500/15 text-red-300 border-red-500/30",
    comment: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    error: "bg-slate-700 text-slate-400 border-slate-600",
  };
  const labels: Record<string, string> = {
    approve: "Approved",
    request_changes: "Changes Requested",
    comment: "Comment",
    error: "Error",
  };
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${styles[verdict] ?? styles.error}`}
    >
      {labels[verdict] ?? verdict}
    </span>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ReviewHistory() {
  const [rows, setRows] = useState<ReviewHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<SkillEnvelope | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listReviews();
      setRows(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openReview = async (id: number) => {
    setLoadingId(id);
    try {
      const full = await api.getReview(id);
      if (!full.result_json) throw new Error("No result data stored");
      const envelope = JSON.parse(full.result_json) as SkillEnvelope;
      setOpenResult(envelope);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingId(null);
    }
  };

  const deleteReview = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await api.deleteReview(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-slate-500 text-sm">
        Loading review history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-red-300 text-sm">
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-16 text-center text-slate-500 text-sm">
        No reviews yet. Run a PR review from the{" "}
        <span className="text-violet-400">PR Review</span> tab to see history here.
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Branch</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Repo</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Verdict</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Reviewed</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.id}
                onClick={() => openReview(row.id)}
                className={
                  "border-b border-slate-800/60 cursor-pointer transition " +
                  (loadingId === row.id
                    ? "bg-slate-800/40 opacity-60"
                    : "hover:bg-slate-800/40") +
                  (i === rows.length - 1 ? " border-b-0" : "")
                }
              >
                <td className="px-4 py-3 font-mono text-xs text-slate-200 max-w-xs truncate">
                  {row.branch}
                </td>
                <td className="px-4 py-3 text-slate-400 text-xs">{row.repo}</td>
                <td className="px-4 py-3">
                  <VerdictBadge verdict={row.verdict} />
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {formatDate(row.reviewed_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={(e) => deleteReview(e, row.id)}
                    disabled={deletingId === row.id}
                    className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-500 hover:border-red-700 hover:text-red-400 transition disabled:opacity-40"
                  >
                    {deletingId === row.id ? "…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reopen the full ReviewResults component with the stored envelope */}
      {openResult && (
        <ReviewResults
          result={{
            skillId: openResult.skillId,
            status: openResult.status,
            results: Object.fromEntries(
              Object.entries(openResult.results).map(([k, v]) => [k, v]),
            ),
            meta: openResult.meta,
          }}
          onClose={() => setOpenResult(null)}
        />
      )}
    </>
  );
}
