import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";

interface ReviewIssue {
  severity: "blocking" | "suggestion" | "nitpick";
  category: string;
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

interface ReviewResult {
  summary: string;
  verdict: "approve" | "request_changes" | "comment";
  issues: ReviewIssue[];
  missingTests: string[];
  missingTranslations: string[];
  statsAnalyzed: { filesReviewed: number; linesAdded: number; linesRemoved: number };
}

function parseReviewResult(summary: string): ReviewResult | null {
  try {
    const braceStart = summary.indexOf("{");
    const braceEnd = summary.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      return JSON.parse(summary.slice(braceStart, braceEnd + 1)) as ReviewResult;
    }
  } catch { /* */ }
  return null;
}

export function ReviewResults({ result, onClose }: SkillResultsProps) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");
  const [showDiff, setShowDiff] = useState(false);

  const branch = (result.meta?.branch as string) ?? "";
  const active = result.results[activeRepo];
  const review = active ? parseReviewResult(active.summary) : null;

  return (
    <SkillShell
      title="PR Review"
      subtitle={`Branch: ${branch}`}
      repoKeys={repos.map(([k]) => k)}
      activeRepo={activeRepo}
      onRepoChange={setActiveRepo}
      onClose={onClose}
      results={result.results}
    >
      {active && (
        <>
          {active.error ? (
            <div className="p-6 text-red-300">
              <div className="font-medium mb-2">Review failed</div>
              <pre className="text-xs whitespace-pre-wrap">{active.error}</pre>
            </div>
          ) : review ? (
            <>
              {showDiff ? (
                <DiffSection diff={active.diff} />
              ) : (
                <div className="flex-1 overflow-auto p-6 space-y-5">
                  {/* Verdict + summary */}
                  <VerdictBanner verdict={review.verdict} summary={review.summary} stats={review.statsAnalyzed} />

                  {/* Issues */}
                  {review.issues.length > 0 && (
                    <IssuesList issues={review.issues} />
                  )}

                  {/* Missing tests */}
                  {review.missingTests.length > 0 && (
                    <MissingSection title="Missing Tests" items={review.missingTests} color="amber" />
                  )}

                  {/* Missing translations */}
                  {review.missingTranslations.length > 0 && (
                    <MissingSection title="Missing Translations" items={review.missingTranslations} color="sky" />
                  )}
                </div>
              )}

              {/* Footer */}
              <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
                <button
                  onClick={() => setShowDiff((v) => !v)}
                  className={
                    "rounded border px-3 py-1.5 text-xs transition " +
                    (showDiff
                      ? "border-violet-500 text-violet-300 bg-violet-500/10"
                      : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
                  }
                >
                  {showDiff ? "Show Review" : `Show Diff (${active.filesTouched} files)`}
                </button>
                <span className="flex-1" />
                <span className="text-xs text-slate-500">
                  {review.issues.filter((i) => i.severity === "blocking").length} blocking ·{" "}
                  {review.issues.filter((i) => i.severity === "suggestion").length} suggestions ·{" "}
                  {review.issues.filter((i) => i.severity === "nitpick").length} nitpicks
                </span>
              </div>
            </>
          ) : (
            <div className="p-6 text-slate-400 text-sm">{active.summary}</div>
          )}
        </>
      )}
    </SkillShell>
  );
}

function VerdictBanner({
  verdict,
  summary,
  stats,
}: {
  verdict: ReviewResult["verdict"];
  summary: string;
  stats: ReviewResult["statsAnalyzed"];
}) {
  const verdictStyle =
    verdict === "approve"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : verdict === "request_changes"
        ? "border-red-500/40 bg-red-500/10 text-red-300"
        : "border-amber-500/40 bg-amber-500/10 text-amber-300";

  const verdictLabel =
    verdict === "approve" ? "Approved" : verdict === "request_changes" ? "Changes Requested" : "Comment";

  return (
    <div className={`rounded-lg border px-4 py-3 ${verdictStyle}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-sm">{verdictLabel}</span>
        <span className="text-xs opacity-70">
          {stats.filesReviewed} files · +{stats.linesAdded} / −{stats.linesRemoved} lines
        </span>
      </div>
      <p className="text-sm opacity-90">{summary}</p>
    </div>
  );
}

const SEVERITY_STYLE: Record<ReviewIssue["severity"], string> = {
  blocking: "border-red-500/40 bg-red-500/5 text-red-300",
  suggestion: "border-amber-500/40 bg-amber-500/5 text-amber-300",
  nitpick: "border-slate-600 bg-slate-800/30 text-slate-400",
};

const SEVERITY_BADGE: Record<ReviewIssue["severity"], string> = {
  blocking: "bg-red-500/20 text-red-300 border-red-500/30",
  suggestion: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  nitpick: "bg-slate-700 text-slate-400 border-slate-600",
};

const CATEGORY_LABEL: Record<string, string> = {
  correctness: "Correctness",
  patterns: "Patterns",
  tests: "Tests",
  translations: "Translations",
  security: "Security",
  types: "Types",
  edge_cases: "Edge Cases",
};

function IssuesList({ issues }: { issues: ReviewIssue[] }) {
  // Group by severity
  const blocking = issues.filter((i) => i.severity === "blocking");
  const suggestions = issues.filter((i) => i.severity === "suggestion");
  const nitpicks = issues.filter((i) => i.severity === "nitpick");

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Issues</div>
      {[...blocking, ...suggestions, ...nitpicks].map((issue, i) => (
        <div key={i} className={`rounded-lg border px-4 py-3 ${SEVERITY_STYLE[issue.severity]}`}>
          <div className="flex items-start gap-2 mb-1">
            <span className={`rounded border px-1.5 py-0.5 text-xs font-medium shrink-0 ${SEVERITY_BADGE[issue.severity]}`}>
              {issue.severity}
            </span>
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-xs text-slate-500">
              {CATEGORY_LABEL[issue.category] ?? issue.category}
            </span>
            {issue.file && (
              <code className="text-xs text-slate-500 font-mono">
                {issue.file}{issue.line ? `:${issue.line}` : ""}
              </code>
            )}
          </div>
          <p className="text-sm">{issue.message}</p>
          {issue.suggestion && (
            <p className="text-xs mt-1.5 opacity-80 italic">{issue.suggestion}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function MissingSection({
  title,
  items,
  color,
}: {
  title: string;
  items: string[];
  color: "amber" | "sky";
}) {
  const style =
    color === "amber"
      ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
      : "border-sky-500/30 bg-sky-500/5 text-sky-300";

  return (
    <div className={`rounded-lg border px-4 py-3 ${style}`}>
      <div className="text-xs font-medium uppercase tracking-wider mb-2 opacity-70">{title}</div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm flex gap-2">
            <span className="opacity-50">•</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
