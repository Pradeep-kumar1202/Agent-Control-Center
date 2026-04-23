import { useState } from "react";
import { api, type TestWriterSpec } from "../../api";
import { usePreviewPanel } from "../../state/previewPanel";
import type { SkillFormProps } from "../registry";
import { TestRunner } from "./TestRunner";
import { TestHistory } from "./History";

const REPO_OPTIONS = [
  { value: "web", label: "Web", description: "Cypress" },
  { value: "mobile", label: "Mobile", description: "Detox" },
] as const;

/**
 * Test Writer skill page.
 *
 * Laid out to match the reference design: a single workspace with a branch
 * input, primary **Run All** action (+ secondary **Generate Tests**), and a
 * 3-column live area below — test case list · selected test output · live
 * emulator. The Generate form lives in a collapsible panel so it doesn't
 * dominate the page when you're here to run existing tests on a PR.
 */
export function TestsForm({ onResult, onError }: SkillFormProps) {
  const [branch, setBranch] = useState("");
  const [repo, setRepo] = useState<"web" | "mobile">("mobile");
  const [featureDescription, setFeatureDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [generating, setGenerating] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [runContext, setRunContext] = useState<
    { branch: string; repo: "web" | "mobile"; prUrl: string | null } | null
  >(null);
  const [historyKey, setHistoryKey] = useState(0);
  const previewPanel = usePreviewPanel();

  const onSubmit = async () => {
    if (!branch.trim() || !featureDescription.trim()) return;
    const spec: TestWriterSpec = {
      branch: branch.trim(),
      repo,
      featureDescription: featureDescription.trim(),
      baseBranch: baseBranch.trim() || "main",
    };
    setGenerating(true);
    try {
      const result = await api.generateTests(spec);
      onResult(result);
      setGenOpen(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const canGenerate = branch.trim() && featureDescription.trim();
  const canRun = branch.trim().length > 0;

  const onRunAll = async () => {
    if (!canRun || resolving) return;
    const raw = branch.trim();
    setResolving(true);
    try {
      let resolvedBranch = raw;
      let prUrl: string | null = null;
      if (/^https?:\/\/github\.com\/.+\/pull\/\d+/.test(raw)) {
        const r = await api.resolvePrUrl(raw);
        resolvedBranch = r.branch;
        prUrl = r.prUrl;
      }
      setRunContext({ branch: resolvedBranch, repo, prUrl });
      setHistoryKey((k) => k + 1);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ─── Action bar ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[280px] space-y-2">
          <label className="block text-xs text-slate-400">Branch or PR URL</label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feat/add-wallet-pay or https://github.com/juspay/.../pull/123"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            {REPO_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setRepo(opt.value)}
                className={
                  "rounded border px-3 py-1 text-xs transition " +
                  (repo === opt.value
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                    : "border-slate-700 text-slate-400 hover:border-slate-500")
                }
              >
                {opt.label} <span className="text-slate-600">· {opt.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 pt-5">
          <button
            type="button"
            onClick={() =>
              previewPanel.open({
                repoKey: repo,
                branch: branch.trim() || baseBranch.trim() || "main",
                initialTab: "emulator",
              })
            }
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:border-emerald-500 hover:text-emerald-300"
            title="Open the global Preview Panel"
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => setGenOpen((v) => !v)}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:border-slate-500"
          >
            {genOpen ? "Close generate panel" : "Generate Tests"}
          </button>
          <button
            type="button"
            onClick={onRunAll}
            disabled={!canRun || resolving}
            className={
              "rounded-lg px-4 py-2 text-xs font-semibold text-white transition " +
              (resolving
                ? "bg-emerald-700 cursor-wait"
                : !canRun
                  ? "bg-slate-700 cursor-not-allowed text-slate-500"
                  : "bg-emerald-600 hover:bg-emerald-500")
            }
          >
            {resolving ? "Resolving…" : "▶ Run All"}
          </button>
        </div>
      </div>

      {/* ─── Generate panel (collapsible) ──────────────────────────────── */}
      {genOpen && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <div className="text-sm font-medium text-slate-200">Generate new tests</div>
          <div className="text-xs text-slate-500">
            The AI analyzes the branch diff and writes targeted Cypress/Detox tests following each
            repo's existing patterns. Tests land on a new branch and a PR is opened against the bot fork.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Base branch</label>
              <input
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Feature branch</label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feat/add-wallet-pay"
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Feature description</label>
            <textarea
              value={featureDescription}
              onChange={(e) => setFeatureDescription(e.target.value)}
              rows={3}
              placeholder="Describe what the feature does — user-facing behavior, payment flows affected, edge cases."
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none resize-none"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setGenOpen(false)}
              className="rounded px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={generating || !canGenerate}
              className={
                "rounded px-4 py-1.5 text-xs font-semibold text-white transition " +
                (generating
                  ? "bg-emerald-700 cursor-wait"
                  : !canGenerate
                    ? "bg-slate-700 cursor-not-allowed text-slate-500"
                    : "bg-emerald-600 hover:bg-emerald-500")
              }
            >
              {generating ? "Writing tests…" : "Generate"}
            </button>
          </div>
        </div>
      )}

      {/* ─── Live workspace — 3-column test runner ─────────────────────── */}
      {runContext ? (
        <TestRunner
          key={`${runContext.repo}:${runContext.branch}:${historyKey}`}
          branch={runContext.branch}
          repo={runContext.repo}
          prUrl={runContext.prUrl}
          autoRun
          onFinish={() => setHistoryKey((k) => k + 1)}
        />
      ) : (
        <EmptyWorkspace repo={repo} />
      )}

      {/* ─── History ───────────────────────────────────────────────────── */}
      {runContext && (
        <TestHistory
          repo={runContext.repo}
          branch={runContext.branch}
          refreshKey={historyKey}
        />
      )}
    </div>
  );
}

/**
 * Quiet placeholder shown before the user has run anything. The emulator
 * lives in the global Preview panel (topbar → Preview) so it isn't
 * duplicated here.
 */
function EmptyWorkspace(_: { repo: "web" | "mobile" }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)] grid-cols-1">
      <div className="rounded border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-600">
        Paste a branch or PR URL and click <span className="text-slate-400">Run All</span> to
        execute the suite. Tests discovered on disk will appear here with their pass/fail status.
      </div>
      <div className="rounded border border-slate-800 bg-slate-950/80 p-4 text-xs text-slate-600 min-h-[240px] flex items-center justify-center">
        Test output will stream into this pane.
      </div>
    </div>
  );
}
