import { useEffect, useMemo, useRef, useState } from "react";
import { useJob, type JobEvent } from "../../jobs";
import { overrideHeader } from "../../settings/store";
import type { SkillEnvelopeClient, SkillFormProps } from "../registry";

interface ResolvedDirection {
  pr: { owner: string; repo: string; number: number; url: string };
  source: "web" | "mobile";
  target: "web" | "mobile";
}

type Phase =
  | "fetching"
  | "triaging"
  | "analysing"
  | "implementing"
  | "building"
  | "validating"
  | "verifying";

const PHASE_LABELS: Record<Phase, string> = {
  fetching: "Fetching the exact PR diff and pinning both repos…",
  triaging: "Checking whether the change is portable…",
  analysing: "Building the cross-SDK behavior specification…",
  implementing: "Implementing in the target SDK…",
  building: "Running the mandatory ReScript build…",
  validating: "Running deterministic patch validators…",
  verifying: "Verifying semantic parity…",
};

function repoLabel(repo: "web" | "mobile"): string {
  return repo === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
}

interface Progress {
  phase: Phase | null;
  toolChips: string[];
  triageNote: string | null;
  gateNotes: string[];
  workspace: { branch: string; sourceSha: string; targetBaseSha: string } | null;
  error: string | null;
}

/**
 * Fold the persisted event stream into what the panel shows. Pure, so a run
 * watched live and a run re-opened after a reload render identically.
 */
function progressOf(events: JobEvent[]): Progress {
  const p: Progress = { phase: null, toolChips: [], triageNote: null, gateNotes: [], workspace: null, error: null };
  for (const e of events) {
    switch (e.type) {
      case "phase_marker":
        p.phase = e.phase as Phase;
        break;
      case "tool_use": {
        const name = (e.tool as { name?: string } | undefined)?.name;
        if (name) p.toolChips = [...p.toolChips.slice(-19), name];
        break;
      }
      case "workspace_ready":
        p.workspace = {
          branch: String(e.branch),
          sourceSha: String(e.sourceSha),
          targetBaseSha: String(e.targetBaseSha),
        };
        break;
      case "triage_repair":
        p.triageNote = "Triage response was inconsistent — correcting it once…";
        break;
      case "triage_result": {
        const triage = e.triage as { portability?: string; reasons?: string[] };
        const repaired = e.repaired === true ? " (corrected once)" : "";
        p.triageNote =
          triage.portability === "yes"
            ? `Triage: portable${repaired}`
            : `Triage: ${triage.portability ?? "unknown"}${repaired}${triage.reasons?.[0] ? ` — ${triage.reasons[0]}` : ""}`;
        break;
      }
      case "spec_repair":
        p.gateNotes.push("Source specification contained an invalid path — correcting it once…");
        break;
      case "build_result":
        p.gateNotes.push(e.passed ? "Build passed" : "Build failed — work preserved on the branch");
        break;
      case "validators": {
        const report = e.report as { rejected?: boolean; findings?: unknown[] };
        p.gateNotes.push(report.rejected ? "Validators rejected the patch" : `${report.findings?.length ?? 0} validator finding(s)`);
        break;
      }
      case "warning":
        p.gateNotes.push(String(e.warning));
        break;
      case "error":
        p.error = String(e.error ?? "Agent failed");
        break;
    }
  }
  return p;
}

export function PrPortForm({ onResult, onError }: SkillFormProps) {
  const [prUrl, setPrUrl] = useState("");
  const [direction, setDirection] = useState<ResolvedDirection | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const job = useJob("pr-port");
  const progress = useMemo(() => progressOf(job.events), [job.events]);
  const reported = useRef<number | null>(null);

  useEffect(() => {
    setDirection(null);
    setResolveError(null);
    if (!prUrl.trim() || !/\/pull\/\d+/.test(prUrl)) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/skills/pr-port/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prUrl: prUrl.trim() }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json() as ResolvedDirection & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not resolve PR URL");
        setDirection(body);
      }).catch((err: Error) => {
        if (err.name !== "AbortError") setResolveError(err.message);
      });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [prUrl]);

  // Report each finished run exactly once — including one that finished while
  // this page was closed and was re-attached on load.
  useEffect(() => {
    if (job.jobId === null || job.active || job.status === null) return;
    if (reported.current === job.jobId) return;
    if (job.result) {
      reported.current = job.jobId;
      onResult(job.result as SkillEnvelopeClient);
    } else if (job.error || progress.error) {
      reported.current = job.jobId;
      onError(job.error ?? progress.error ?? "The PR port ended without a result");
    }
  }, [job.jobId, job.active, job.status, job.result, job.error, progress.error, onResult, onError]);

  function submit(): void {
    if (!prUrl.trim() || resolveError || job.active) return;
    reported.current = null;
    void job.start({ prUrl: prUrl.trim() }, overrideHeader());
  }

  const running = job.active;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-100">Port a PR across SDKs</h2>
        <p className="mb-6 text-sm text-slate-500">
          Paste a web or mobile pull request. Direction is inferred from its repository. Each run works in its own
          checkout pinned to the PR's exact head, and keeps running if you close this tab.
        </p>

        <label className="mb-1 block text-xs text-slate-400">GitHub pull-request URL</label>
        <input
          value={prUrl}
          onChange={(event) => setPrUrl(event.target.value)}
          disabled={running}
          placeholder="https://github.com/juspay/hyperswitch-web/pull/123"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
        />

        {resolveError && <div className="mt-2 text-xs text-red-300">{resolveError}</div>}
        {direction && (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-3 text-xs">
            <span className="rounded border border-slate-700 px-2 py-1 font-mono text-slate-300">
              {repoLabel(direction.source)} #{direction.pr.number}
            </span>
            <span className="text-cyan-400">→</span>
            <span className="rounded border border-cyan-500/40 px-2 py-1 font-mono text-cyan-200">
              {repoLabel(direction.target)}
            </span>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={submit}
            disabled={running || !direction || Boolean(resolveError)}
            className={
              "rounded-lg px-5 py-2.5 text-sm font-medium text-white transition " +
              (running || !direction || resolveError
                ? "cursor-not-allowed bg-slate-700 text-slate-500"
                : "bg-cyan-600 hover:bg-cyan-500")
            }
          >
            {running ? "Porting…" : "Port this PR"}
          </button>
          {running && (
            <button
              onClick={() => void job.cancel()}
              title="Stops the agents. Work so far is committed to the port branch."
              className="rounded-lg border border-red-700 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40"
            >
              Cancel
            </button>
          )}
          {job.jobId !== null && <span className="ml-2 font-mono text-[11px] text-slate-600">job #{job.jobId}</span>}
        </div>
      </section>

      {running && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
            <span className="text-sm text-slate-200">
              {progress.phase ? PHASE_LABELS[progress.phase] : job.status === "queued" ? "Waiting for the repositories…" : "Starting…"}
            </span>
          </div>
          {progress.workspace && (
            <div className="mt-2 font-mono text-[11px] text-slate-500">
              {progress.workspace.branch} · source @ {progress.workspace.sourceSha.slice(0, 10)} · base @{" "}
              {progress.workspace.targetBaseSha.slice(0, 10)}
            </div>
          )}
          {(progress.triageNote || progress.gateNotes.length > 0) && (
            <div className="mt-2 space-y-1 text-xs text-slate-500">
              {progress.triageNote && <div>{progress.triageNote}</div>}
              {progress.gateNotes.map((note, i) => <div key={i}>{note}</div>)}
            </div>
          )}
          {progress.toolChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {progress.toolChips.map((tool, index) => (
                <span key={`${tool}-${index}`} className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">
                  {tool}
                </span>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
