import { useEffect, useRef, useState } from "react";
import { readNdjson } from "../../components/ndjson";
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
  fetching: "Fetching the exact PR diff…",
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

export function PrPortForm({ onResult, onError }: SkillFormProps) {
  const [prUrl, setPrUrl] = useState("");
  const [direction, setDirection] = useState<ResolvedDirection | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [toolChips, setToolChips] = useState<string[]>([]);
  const [triageNote, setTriageNote] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  async function submit(): Promise<void> {
    if (!prUrl.trim() || resolveError) return;
    setRunning(true);
    setPhase(null);
    setToolChips([]);
    setTriageNote(null);
    setGateNote(null);

    const controller = new AbortController();
    abortRef.current = controller;
    let finalEnvelope: SkillEnvelopeClient | null = null;
    let streamError: string | null = null;

    try {
      const response = await fetch("/api/skills/pr-port/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...overrideHeader() },
        body: JSON.stringify({ prUrl: prUrl.trim() }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as { error?: string; slots?: string[] };
        const suffix = body.slots?.length ? ` Configure these slots in Settings: ${body.slots.join(", ")}.` : "";
        throw new Error((body.error ?? `Request failed: ${response.status}`) + suffix);
      }

      for await (const chunk of readNdjson<Record<string, unknown>>(response.body)) {
        if (chunk.type === "phase_marker") {
          setPhase(chunk.phase as Phase);
        } else if (chunk.type === "tool_use") {
          const tool = chunk.tool as { name?: string } | undefined;
          if (tool?.name) setToolChips((prev) => [...prev.slice(-19), tool.name!]);
        } else if (chunk.type === "triage_result") {
          const triage = chunk.triage as { portability?: string; reasons?: string[] };
          setTriageNote(
            triage.portability === "yes"
              ? "Triage: portable"
              : `Triage: ${triage.portability ?? "unknown"}${triage.reasons?.[0] ? ` — ${triage.reasons[0]}` : ""}`,
          );
        } else if (chunk.type === "build_result") {
          setGateNote(chunk.passed ? "Build passed" : "Build failed — preserving the branch");
        } else if (chunk.type === "validators") {
          const report = chunk.report as { rejected?: boolean; findings?: unknown[] };
          setGateNote(report.rejected ? "Validators rejected the patch" : `${report.findings?.length ?? 0} validator finding(s)`);
        } else if (chunk.type === "error") {
          streamError = String(chunk.error ?? "Agent failed");
        } else if (chunk.type === "port_done") {
          finalEnvelope = (chunk as { envelope: SkillEnvelopeClient }).envelope;
        }
      }

      if (finalEnvelope) onResult(finalEnvelope);
      else if (streamError) onError(streamError);
      else onError("The PR port stream ended without a result");
    } catch (err) {
      if ((err as Error).name !== "AbortError") onError((err as Error).message);
    } finally {
      setRunning(false);
      setPhase(null);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="mb-1 text-lg font-semibold text-slate-100">Port a PR across SDKs</h2>
        <p className="mb-6 text-sm text-slate-500">
          Paste a web or mobile pull request. Direction is inferred from its repository; non-portable changes stop before a target branch is created.
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
            onClick={() => void submit()}
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
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-red-700 px-3 py-2 text-xs text-red-300 hover:bg-red-950/40"
            >
              Cancel
            </button>
          )}
        </div>
      </section>

      {running && (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
            <span className="text-sm text-slate-200">{phase ? PHASE_LABELS[phase] : "Starting…"}</span>
          </div>
          {(triageNote || gateNote) && (
            <div className="mt-2 space-y-1 text-xs text-slate-500">
              {triageNote && <div>{triageNote}</div>}
              {gateNote && <div>{gateNote}</div>}
            </div>
          )}
          {toolChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {toolChips.map((tool, index) => (
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
