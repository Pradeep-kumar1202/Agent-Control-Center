import { useRef, useState } from "react";
import {
  generateCoderTask,
  type CoderSpec,
  type CoderSSEEvent,
  type CoderEnvelope,
} from "../../api";
import type { SkillFormProps } from "../registry";

// ─── Constants ───────────────────────────────────────────────────────────────

const REPOS = [
  { id: "mobile", label: "client-core", description: "hyperswitch-client-core (ReScript hooks, modules)" },
  { id: "rn_packages", label: "rn-packages", description: "react-native-hyperswitch (native iOS/Android)" },
  { id: "web", label: "Web SDK", description: "hyperswitch-web (ReScript + React)" },
] as const;

interface ProgressEntry {
  repo?: string;
  message: string;
  type: CoderSSEEvent["type"];
  timestamp: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CoderForm({ onResult, onError }: SkillFormProps) {
  const [repos, setRepos] = useState<Set<string>>(new Set(["mobile"]));
  const [task, setTask] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  const toggleSet = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const onGenerate = () => {
    if (!task.trim() || repos.size === 0) return;

    const spec: CoderSpec = {
      repos: Array.from(repos) as CoderSpec["repos"],
      task: task.trim(),
      additionalContext: additionalContext.trim() || undefined,
    };

    setGenerating(true);
    setProgress([]);

    abortRef.current = generateCoderTask(
      spec,
      (event: CoderSSEEvent) => {
        const entry: ProgressEntry = {
          repo: event.repo,
          message: event.message,
          type: event.type,
          timestamp: Date.now(),
        };
        setProgress((prev) => [...prev, entry]);
        setTimeout(() => progressEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      },
      (envelope: CoderEnvelope) => {
        setGenerating(false);
        onResult({
          skillId: "coder",
          status: envelope.status,
          results: envelope.results,
          meta: {
            task: envelope.meta?.task,
            reviewLogs: Object.fromEntries(
              Object.entries(envelope.results).map(([k, v]) => [k, v.reviewLog]),
            ),
          },
        });
      },
      (msg: string) => {
        setGenerating(false);
        onError(msg);
      },
    );
  };

  const onCancel = () => {
    abortRef.current?.abort();
    setGenerating(false);
  };

  const isGenerating = generating || progress.length > 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">Coder</h2>
      <p className="text-sm text-slate-500 mb-4">
        General-purpose coding: bug fixes, refactors, feature changes. No SDK docs or classification needed.
      </p>

      {!isGenerating && (
        <>
          {/* Task Description */}
          <div className="mb-4">
            <label className="block text-xs text-slate-400 mb-1">Task Description</label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={5}
              placeholder="Describe what you want to do: fix a bug, refactor some code, add a feature..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none resize-none"
            />
          </div>

          {/* Target Repos */}
          <div className="mb-4">
            <label className="block text-xs text-slate-400 mb-2">Repos</label>
            <div className="flex flex-wrap gap-2">
              {REPOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRepos((prev) => toggleSet(prev, r.id))}
                  className={
                    "rounded-lg border px-3 py-2 text-left transition " +
                    (repos.has(r.id)
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-700 hover:border-slate-500")
                  }
                >
                  <div className={"text-xs font-medium " + (repos.has(r.id) ? "text-indigo-200" : "text-slate-400")}>
                    {r.label}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">{r.description}</div>
                </button>
              ))}
            </div>
            {repos.has("mobile") && repos.has("rn_packages") && (
              <div className="mt-2 text-xs text-indigo-300/70 ml-1">
                Both mobile repos selected — single coder will work across both for interface consistency
              </div>
            )}
          </div>

          {/* Advanced */}
          <div className="mb-6">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-slate-500 hover:text-slate-300 mb-2 flex items-center gap-1"
            >
              <span className="text-slate-600">{showAdvanced ? "v" : ">"}</span>
              Additional context
            </button>
            {showAdvanced && (
              <div className="pl-3 border-l border-slate-800">
                <textarea
                  value={additionalContext}
                  onChange={(e) => setAdditionalContext(e.target.value)}
                  rows={3}
                  placeholder="Extra instructions, links to relevant files, constraints..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none resize-none"
                />
              </div>
            )}
          </div>

          {/* Generate button */}
          <button
            onClick={onGenerate}
            disabled={!task.trim() || repos.size === 0}
            className={
              "rounded-lg px-5 py-2.5 font-medium text-white transition " +
              (!task.trim() || repos.size === 0
                ? "bg-slate-700 cursor-not-allowed text-slate-500"
                : "bg-indigo-600 hover:bg-indigo-500")
            }
          >
            Generate
          </button>
        </>
      )}

      {/* Progress */}
      {isGenerating && (
        <>
          {progress.length > 0 && (
            <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950 p-3 max-h-64 overflow-y-auto">
              {progress.map((p, i) => (
                <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                  <span className={
                    p.type === "error" ? "text-red-400" :
                    p.type === "review_result" ? "text-violet-400" :
                    p.type === "repo_done" ? "text-emerald-400" :
                    p.type === "done" ? "text-emerald-300 font-medium" :
                    "text-slate-500"
                  }>
                    {p.type === "error" ? "x" :
                     p.type === "review_result" ? "R" :
                     p.type === "repo_done" ? "+" :
                     p.type === "done" ? "+" :
                     ">"}
                  </span>
                  {p.repo && <span className="text-indigo-400 font-mono">[{p.repo}]</span>}
                  <span className="text-slate-300">{p.message}</span>
                </div>
              ))}
              <div ref={progressEndRef} />
            </div>
          )}

          {generating && (
            <button
              onClick={onCancel}
              className="rounded-lg px-5 py-2.5 font-medium text-white bg-red-700 hover:bg-red-600 transition"
            >
              <span className="inline-flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Cancel
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
