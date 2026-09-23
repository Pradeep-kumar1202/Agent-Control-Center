import { useState } from "react";
import { api, type TestWriterSpec } from "../../api";
import type { SkillFormProps } from "../registry";

const REPO_OPTIONS = [
  { value: "web", label: "Web only", description: "Cypress tests in cypress-tests/cypress/e2e/" },
  { value: "mobile", label: "Mobile only", description: "Detox tests in detox-tests/e2e/" },
  { value: "both", label: "Both", description: "Cypress + Detox tests" },
] as const;

export function TestsForm({ onResult, onError }: SkillFormProps) {
  const [branch, setBranch] = useState("");
  const [repo, setRepo] = useState<"web" | "mobile" | "both">("both");
  const [featureDescription, setFeatureDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [generating, setGenerating] = useState(false);

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
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const canSubmit = branch.trim() && featureDescription.trim();

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">Test Writer</h2>
      <p className="text-sm text-slate-500 mb-6">
        Provide a feature branch and description — the AI will write Cypress and/or Detox e2e tests
        following each repo's existing test patterns.
      </p>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Branch or PR URL</label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feat/add-wallet-pay or https://github.com/juspay/.../pull/123"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
          <div className="text-xs text-slate-600 mt-1">Local branch name or GitHub PR URL</div>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Base Branch</label>
          <input
            type="text"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="main"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">Feature Description</label>
        <textarea
          value={featureDescription}
          onChange={(e) => setFeatureDescription(e.target.value)}
          rows={4}
          placeholder="Describe what the feature does — what user-facing behavior it adds, what payment flows it affects, and what edge cases exist. The AI will analyze the branch diff and write targeted tests."
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none resize-none"
        />
      </div>

      <div className="mb-6">
        <label className="block text-xs text-slate-400 mb-2">Target</label>
        <div className="flex flex-wrap gap-2">
          {REPO_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRepo(opt.value)}
              className={
                "rounded-lg border px-3 py-2 text-left transition " +
                (repo === opt.value
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-slate-700 hover:border-slate-500")
              }
            >
              <div className={
                "text-xs font-medium " +
                (repo === opt.value ? "text-emerald-200" : "text-slate-400")
              }>
                {opt.label}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={onSubmit}
        disabled={generating || !canSubmit}
        className={
          "rounded-lg px-5 py-2.5 font-medium text-white transition " +
          (generating
            ? "bg-emerald-700 cursor-wait"
            : !canSubmit
              ? "bg-slate-700 cursor-not-allowed text-slate-500"
              : "bg-emerald-600 hover:bg-emerald-500")
        }
      >
        {generating ? (
          <span className="inline-flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Writing tests…
          </span>
        ) : (
          "Generate Tests"
        )}
      </button>
    </div>
  );
}
