import { useMemo, useState } from "react";
import { PrStatusChip } from "../../components/PrStatusChip";
import type { SkillResultsProps } from "../registry";
import { DiffSection } from "../shared/DiffSection";
import { SkillShell } from "../shared/SkillShell";

interface FileDecision { path: string; why: string }
interface Finding { level: "reject" | "warn"; rule?: string; message: string; file?: string }

interface PortMeta {
  outcome?: "pass" | "needs_review" | "non_portable" | "build_failed" | "rejected" | "error" | "cancelled";
  source?: "web" | "mobile";
  target?: "web" | "mobile";
  sourcePr?: { url?: string; owner?: string; repo?: string; number?: number };
  triage?: { portability?: string; reasons?: string[]; skippedFiles?: FileDecision[] };
  spec?: { featureName?: string; notPorting?: FileDecision[] };
  quality?: { findings?: Finding[]; stats?: { files: number; added: number; removed: number } };
  verifier?: { parsed?: boolean; issues?: string[] };
  buildStatus?: string;
  buildLog?: string;
}

const OUTCOME_STYLE: Record<string, string> = {
  pass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  needs_review: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  non_portable: "border-slate-600 bg-slate-800/50 text-slate-300",
  build_failed: "border-red-500/40 bg-red-500/10 text-red-300",
  rejected: "border-red-500/40 bg-red-500/10 text-red-300",
  error: "border-red-500/40 bg-red-500/10 text-red-300",
  cancelled: "border-slate-600 bg-slate-800/50 text-slate-400",
};

function displaySummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { what?: unknown; notes?: unknown };
    const what = typeof parsed.what === "string" ? parsed.what : raw;
    return typeof parsed.notes === "string" && parsed.notes.trim() ? `${what} ${parsed.notes}` : what;
  } catch {
    return raw;
  }
}

export function PrPortResults({ result, onClose }: SkillResultsProps) {
  const meta = (result.meta ?? {}) as PortMeta;
  const repos = Object.keys(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0] ?? meta.target ?? "");
  const [showDiff, setShowDiff] = useState(false);
  const active = result.results[activeRepo];
  const outcome = meta.outcome ?? (result.status === "ok" ? "pass" : result.status);

  const skipped = useMemo(() => {
    const all = [...(meta.triage?.skippedFiles ?? []), ...(meta.spec?.notPorting ?? [])];
    return [...new Map(all.map((entry) => [`${entry.path}:${entry.why}`, entry])).values()];
  }, [meta.triage, meta.spec]);

  const sourceLabel = meta.source === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
  const targetLabel = meta.target === "web" ? "hyperswitch-web" : "hyperswitch-client-core";

  return (
    <SkillShell
      title="PR Port"
      subtitle={`${sourceLabel} → ${targetLabel}`}
      repoKeys={repos}
      activeRepo={activeRepo}
      onRepoChange={setActiveRepo}
      onClose={onClose}
      results={result.results}
    >
      {active && (
        <div className="space-y-5 p-6">
          <div className={`rounded-lg border px-4 py-3 ${OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.error}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">{outcome.replaceAll("_", " ").toUpperCase()}</span>
              {meta.quality?.stats && (
                <span className="text-xs opacity-75">
                  {meta.quality.stats.files} files · +{meta.quality.stats.added} / −{meta.quality.stats.removed}
                </span>
              )}
            </div>
            {meta.triage?.reasons?.length ? (
              <p className="mt-1 text-sm opacity-90">{meta.triage.reasons.join(" ")}</p>
            ) : null}
          </div>

          {active.error && (
            <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-300">
              {active.error}
            </div>
          )}

          {active.summary && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Summary</div>
              <p className="text-sm leading-6 text-slate-300">{displaySummary(active.summary)}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {meta.sourcePr?.url && (
              <a href={meta.sourcePr.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">
                Source PR #{meta.sourcePr.number}
              </a>
            )}
            {active.branch && <span className="rounded border border-slate-700 px-2 py-1 font-mono text-slate-300">{active.branch}</span>}
            {active.filesTouched > 0 && <span className="text-slate-500">{active.filesTouched} target files</span>}
            {active.prUrl && <PrStatusChip prUrl={active.prUrl} prNumber={active.prNumber ?? null} />}
          </div>

          {active.prWarning && (
            <div className="rounded border border-amber-700/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
              {active.prWarning}
            </div>
          )}

          {skipped.length > 0 && (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Intentionally not ported</div>
              <div className="space-y-2">
                {skipped.map((entry) => (
                  <div key={`${entry.path}:${entry.why}`} className="rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                    <div className="font-mono text-xs text-slate-300">{entry.path}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{entry.why}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(meta.quality?.findings?.length ?? 0) > 0 && (
            <section>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Validator findings</div>
              <div className="space-y-2">
                {meta.quality!.findings!.map((finding, index) => (
                  <div
                    key={`${finding.rule ?? "finding"}-${index}`}
                    className={`rounded border px-3 py-2 text-xs ${finding.level === "reject" ? "border-red-800 bg-red-950/20 text-red-300" : "border-amber-800 bg-amber-950/20 text-amber-300"}`}
                  >
                    <span className="font-mono opacity-75">{finding.rule ?? finding.level}</span>
                    {finding.file ? <span className="ml-2 font-mono">{finding.file}</span> : null}
                    <div className="mt-1">{finding.message}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {meta.verifier && (
            <section className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Semantic verifier</div>
              {!meta.verifier.parsed ? (
                <div className="mt-2 text-xs text-amber-300">Output was unparseable; this run was not allowed to pass silently.</div>
              ) : meta.verifier.issues?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-300">
                  {meta.verifier.issues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              ) : (
                <div className="mt-2 text-xs text-emerald-300">No semantic issues reported.</div>
              )}
            </section>
          )}

          {meta.buildLog && (
            <details className="rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
              <summary className="cursor-pointer text-xs text-slate-400">ReScript build log</summary>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-500">{meta.buildLog}</pre>
            </details>
          )}

          {active.diff && (
            <section>
              <button
                onClick={() => setShowDiff((value) => !value)}
                className="mb-3 rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-cyan-600 hover:text-cyan-300"
              >
                {showDiff ? "Hide target diff" : `Show target diff (${active.filesTouched} files)`}
              </button>
              {showDiff && <DiffSection diff={active.diff} />}
            </section>
          )}
        </div>
      )}
    </SkillShell>
  );
}
