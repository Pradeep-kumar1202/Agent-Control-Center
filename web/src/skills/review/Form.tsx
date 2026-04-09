import { useState } from "react";
import { api, type ReviewSpec } from "../../api";
import type { SkillFormProps } from "../registry";

const REPO_OPTIONS = [
  { value: "web", label: "Web only", description: "hyperswitch-web (ReScript + React)" },
  { value: "mobile", label: "Mobile only", description: "hyperswitch-client-core (ReScript + RN)" },
  { value: "both", label: "Both", description: "Review in both repos" },
] as const;

export function ReviewForm({ onResult, onError }: SkillFormProps) {
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [repo, setRepo] = useState<"web" | "mobile" | "both">("web");
  const [generating, setGenerating] = useState(false);

  const canSubmit = branch.trim();

  const onSubmit = async () => {
    if (!canSubmit) return;

    const spec: ReviewSpec = {
      branch: branch.trim(),
      baseBranch: baseBranch.trim() || "main",
      repo,
    };

    setGenerating(true);
    try {
      const result = await api.generateReview(spec);
      onResult(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">PR Reviewer</h2>
      <p className="text-sm text-slate-500 mb-6">
        Provide a branch to review. Opus will do a comprehensive review covering correctness, patterns,
        test coverage, translations, type safety, security, and edge cases.
      </p>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Branch to Review</label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="feat/add-wallet-pay or https://github.com/juspay/.../pull/123"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
          <div className="text-xs text-slate-600 mt-1">Branch name (e.g. <code className="text-slate-500">feat/my-feature</code>) or GitHub PR URL</div>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Base Branch</label>
          <input
            type="text"
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="main"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-xs text-slate-400 mb-2">Repository</label>
        <div className="flex flex-wrap gap-2">
          {REPO_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRepo(opt.value)}
              className={
                "rounded-lg border px-3 py-2 text-left transition " +
                (repo === opt.value
                  ? "border-violet-500 bg-violet-500/10"
                  : "border-slate-700 hover:border-slate-500")
              }
            >
              <div className={
                "text-xs font-medium " +
                (repo === opt.value ? "text-violet-200" : "text-slate-400")
              }>
                {opt.label}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">{opt.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3">
        <div className="text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-400">Review dimensions</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-2">
            {[
              "Correctness & logic errors",
              "Pattern consistency",
              "Test coverage (Cypress/Detox)",
              "Translation coverage",
              "ReScript type safety",
              "Security concerns",
              "Edge cases handling",
            ].map((item) => (
              <div key={item} className="flex items-center gap-1.5">
                <span className="text-violet-500">•</span> {item}
              </div>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={onSubmit}
        disabled={generating || !canSubmit}
        className={
          "rounded-lg px-5 py-2.5 font-medium text-white transition " +
          (generating
            ? "bg-violet-700 cursor-wait"
            : !canSubmit
              ? "bg-slate-700 cursor-not-allowed text-slate-500"
              : "bg-violet-600 hover:bg-violet-500")
        }
      >
        {generating ? (
          <span className="inline-flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Reviewing…
          </span>
        ) : (
          "Review PR"
        )}
      </button>
    </div>
  );
}
