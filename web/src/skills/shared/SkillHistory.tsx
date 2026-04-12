import { useEffect, useState, type ComponentType } from "react";
import { api, type SkillRunSummary, type SkillRunRow } from "../../api";
import type { SkillResultsProps, SkillEnvelopeClient } from "../registry";

interface Props {
  skillId: string;
  skillName: string;
  /** One-line label derived from the input spec (e.g., "Prop: showCardBrand"). */
  formatLabel: (input: Record<string, unknown>) => string;
  /** The same Results component the skill uses for live results. */
  ResultsComponent: ComponentType<SkillResultsProps>;
}

/**
 * Generic history table for any skill. Lists past runs from the
 * `skill_runs` DB table; clicking a row re-opens the Results modal
 * with the persisted envelope.
 */
export function SkillHistory({
  skillId,
  skillName,
  formatLabel,
  ResultsComponent,
}: Props) {
  const [runs, setRuns] = useState<SkillRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeResult, setActiveResult] = useState<SkillEnvelopeClient | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.listSkillRuns(skillId);
      setRuns(data);
    } catch { /* */ }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, [skillId]);

  const onView = async (run: SkillRunSummary) => {
    try {
      const full = await api.getSkillRun(skillId, run.id) as SkillRunRow;
      const envelope = JSON.parse(full.result_json) as SkillEnvelopeClient;
      setActiveResult(envelope);
    } catch (e) {
      alert(`Failed to load run: ${(e as Error).message}`);
    }
  };

  const onDelete = async (run: SkillRunSummary) => {
    if (!confirm(`Delete this ${skillName} run?`)) return;
    try {
      await api.deleteSkillRun(skillId, run.id);
      setRuns((prev) => prev.filter((r) => r.id !== run.id));
    } catch { /* */ }
  };

  const parseLabel = (inputJson: string): string => {
    try {
      return formatLabel(JSON.parse(inputJson));
    } catch {
      return "(unknown)";
    }
  };

  const timeAgo = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const statusBadge = (status: string) => {
    const cls =
      status === "ok"
        ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/40"
        : status === "partial"
          ? "bg-amber-500/10 text-amber-300 border-amber-500/40"
          : "bg-red-500/10 text-red-300 border-red-500/40";
    return (
      <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/30">
      <div className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          {skillName} History
        </h3>
        <button
          onClick={load}
          className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-slate-200"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="px-4 py-8 text-center text-xs text-slate-500">Loading...</div>
      )}

      {!loading && runs.length === 0 && (
        <div className="px-4 py-8 text-center text-xs text-slate-500">
          No {skillName.toLowerCase()} runs yet.
        </div>
      )}

      {!loading && runs.length > 0 && (
        <div className="divide-y divide-slate-800">
          {runs.map((run) => (
            <div
              key={run.id}
              className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-800/30 transition"
            >
              {statusBadge(run.status)}
              <span className="flex-1 text-xs text-slate-300 truncate">
                {parseLabel(run.input_json)}
              </span>
              <span className="text-[10px] text-slate-500 whitespace-nowrap">
                {timeAgo(run.created_at)}
              </span>
              <button
                onClick={() => onView(run)}
                className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-indigo-300 hover:border-indigo-500"
              >
                View
              </button>
              <button
                onClick={() => onDelete(run)}
                className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400 hover:text-red-300 hover:border-red-500"
              >
                Del
              </button>
            </div>
          ))}
        </div>
      )}

      {activeResult && (
        <ResultsComponent
          result={activeResult}
          onClose={() => setActiveResult(null)}
        />
      )}
    </div>
  );
}
