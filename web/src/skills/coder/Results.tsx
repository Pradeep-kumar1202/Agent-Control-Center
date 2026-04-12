import { useState } from "react";
import type { SkillResultsProps, SkillRepoResultClient } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";
import type { ReviewResult } from "../../api";

interface ReviewLogEntry {
  iteration: number;
  review: ReviewResult;
}

// Mobile sub-repo keys and their display labels
const MOBILE_SUB_REPOS = [
  { key: "mobile", label: "client-core" },
  { key: "rn_packages", label: "rn-packages" },
] as const;

/**
 * Derive top-level tabs from result keys.
 * mobile + rn_packages → grouped as "mobile_group"
 */
function deriveTopTabs(resultKeys: string[]): string[] {
  const tabs: string[] = [];
  if (resultKeys.includes("mobile") || resultKeys.includes("rn_packages")) {
    tabs.push("mobile_group");
  }
  if (resultKeys.includes("web")) {
    tabs.push("web");
  }
  // Handle standalone mobile or rn_packages (when only one is present)
  // If both are present, they're grouped. If only one, still use group.
  return tabs;
}

function topTabLabel(key: string): string {
  if (key === "mobile_group") return "Mobile";
  if (key === "web") return "Web SDK";
  return key;
}

export function CoderResults({ result, onClose }: SkillResultsProps) {
  const allRepoKeys = Object.keys(result.results);
  const topTabs = deriveTopTabs(allRepoKeys);
  const [activeTab, setActiveTab] = useState(topTabs[0] ?? "");
  const [mobileSubTab, setMobileSubTab] = useState<string>(
    allRepoKeys.includes("mobile") ? "mobile" : "rn_packages",
  );
  const [expandedReview, setExpandedReview] = useState<number | null>(null);

  const task = (result.meta?.task as string) ?? "";
  const reviewLogs = (result.meta?.reviewLogs as Record<string, ReviewLogEntry[]>) ?? {};

  // Resolve which repo key to display
  const activeRepoKey = activeTab === "mobile_group" ? mobileSubTab : activeTab;
  const active = result.results[activeRepoKey];
  const activeReviewLog = reviewLogs[activeRepoKey] ?? [];

  const repoCount = allRepoKeys.length;
  const subtitle = `${repoCount} repo${repoCount > 1 ? "s" : ""}`;

  // Mobile combined file count
  const mobileFileCount = (result.results.mobile?.filesTouched ?? 0) + (result.results.rn_packages?.filesTouched ?? 0);
  const mobileHasError = result.results.mobile?.error || result.results.rn_packages?.error;

  return (
    <SkillShell
      title={task.length > 60 ? `${task.slice(0, 57)}...` : task || "Coder Task"}
      subtitle={subtitle}
      repoKeys={topTabs}
      activeRepo={activeTab}
      onRepoChange={(key) => {
        setActiveTab(key);
        setExpandedReview(null);
        if (key === "mobile_group") {
          setMobileSubTab(allRepoKeys.includes("mobile") ? "mobile" : "rn_packages");
        }
      }}
      onClose={onClose}
      repoTabLabel={(key) => (
        <>
          {topTabLabel(key)}
          {key === "mobile_group" ? (
            mobileHasError ? (
              <span className="ml-2 text-red-400 text-xs">error</span>
            ) : (
              <span className="ml-2 text-slate-600 text-xs">{mobileFileCount} files</span>
            )
          ) : result.results[key]?.error ? (
            <span className="ml-2 text-red-400 text-xs">error</span>
          ) : result.results[key] ? (
            <span className="ml-2 text-slate-600 text-xs">{result.results[key].filesTouched} files</span>
          ) : null}
        </>
      )}
      results={result.results}
    >
      {/* Mobile sub-tab bar */}
      {activeTab === "mobile_group" && allRepoKeys.includes("mobile") && allRepoKeys.includes("rn_packages") && (
        <div className="flex border-b border-slate-800 px-6 bg-slate-900/50">
          {MOBILE_SUB_REPOS.map((sub) => {
            const subResult = result.results[sub.key];
            return (
              <button
                key={sub.key}
                onClick={() => {
                  setMobileSubTab(sub.key);
                  setExpandedReview(null);
                }}
                className={
                  "px-3 py-1.5 text-xs font-medium border-b-2 transition " +
                  (mobileSubTab === sub.key
                    ? "border-indigo-500 text-indigo-300"
                    : "border-transparent text-slate-500 hover:text-slate-300")
                }
              >
                {sub.label}
                {subResult?.error ? (
                  <span className="ml-1.5 text-red-400">error</span>
                ) : subResult ? (
                  <span className="ml-1.5 text-slate-600">{subResult.filesTouched} files</span>
                ) : (
                  <span className="ml-1.5 text-slate-700">—</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <div className="flex-1 overflow-y-auto">
          {active.error ? (
            <div className="p-6 text-red-300">
              <div className="font-medium mb-2">Task failed</div>
              <pre className="text-xs whitespace-pre-wrap">{active.error}</pre>
            </div>
          ) : (
            <>
              {/* Summary */}
              <div className="border-b border-slate-800 px-6 py-4">
                <RepoSummary result={active} />
              </div>

              {/* Review log */}
              {activeReviewLog.length > 0 && (
                <div className="border-b border-slate-800 px-6 py-3">
                  <div className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wider">
                    Review Log ({activeReviewLog.length} pass{activeReviewLog.length > 1 ? "es" : ""})
                  </div>
                  {activeReviewLog.map((entry) => (
                    <div key={entry.iteration} className="mb-2">
                      <button
                        onClick={() =>
                          setExpandedReview(
                            expandedReview === entry.iteration ? null : entry.iteration,
                          )
                        }
                        className="flex items-center gap-2 text-xs w-full text-left hover:bg-slate-800/50 rounded px-2 py-1"
                      >
                        <span
                          className={
                            entry.review.approved
                              ? "text-emerald-400"
                              : "text-amber-400"
                          }
                        >
                          {entry.review.approved ? "Approved" : "Issues found"}
                        </span>
                        <span className="text-slate-600">
                          Pass {entry.iteration} |{" "}
                          {entry.review.issues.length} issue
                          {entry.review.issues.length !== 1 ? "s" : ""}
                        </span>
                        <span className="ml-auto text-slate-600">
                          {expandedReview === entry.iteration ? "^" : "v"}
                        </span>
                      </button>
                      {expandedReview === entry.iteration && (
                        <div className="mt-1 ml-2 space-y-1">
                          <div className="text-xs text-slate-400 px-2 py-1">
                            {entry.review.summary}
                          </div>
                          {entry.review.issues.map((issue, idx) => (
                            <div
                              key={idx}
                              className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <span
                                  className={
                                    issue.severity === "blocker"
                                      ? "text-red-400 font-medium"
                                      : issue.severity === "warning"
                                        ? "text-amber-400"
                                        : "text-slate-500"
                                  }
                                >
                                  [{issue.severity}]
                                </span>
                                <span className="text-slate-300 font-medium">
                                  {issue.check}
                                </span>
                              </div>
                              <div className="text-slate-400">
                                <code className="text-violet-300">{issue.file}</code>
                                : {issue.description}
                              </div>
                              <div className="text-slate-500 mt-1">
                                Fix: {issue.suggestedFix}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Diff */}
              <DiffSection diff={active.diff} />

              {/* Footer */}
              <CoderFooter active={active} />
            </>
          )}
        </div>
      )}
    </SkillShell>
  );
}

function RepoSummary({ result }: { result: SkillRepoResultClient }) {
  try {
    const braceStart = result.summary.indexOf("{");
    const braceEnd = result.summary.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      const parsed = JSON.parse(result.summary.slice(braceStart, braceEnd + 1));
      if (parsed.what && Array.isArray(parsed.files)) {
        return (
          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-100">{parsed.what}</div>
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-950 text-slate-500 uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-medium">File</th>
                    <th className="text-left px-3 py-2 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {parsed.files.map(
                    (f: { path: string; change: string }, i: number) => (
                      <tr key={i} className="hover:bg-slate-800/50">
                        <td className="px-3 py-2 font-mono text-indigo-300 whitespace-nowrap">
                          {f.path}
                        </td>
                        <td className="px-3 py-2 text-slate-400">{f.change}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      }
    }
  } catch {
    /* fall through */
  }
  return <div className="text-sm text-slate-300">{result.summary}</div>;
}

function CoderFooter({ active }: { active: SkillRepoResultClient }) {
  const [copied, setCopied] = useState(false);

  const workspacePath =
    active.repo === "web"
      ? "workspace/web/hyperswitch-web"
      : active.repo === "mobile"
        ? "workspace/mobile/hyperswitch-client-core"
        : active.repo === "rn_packages"
          ? "workspace/mobile/react-native-hyperswitch"
          : `workspace/${active.repo}`;

  if (!active.branch) return null;

  return (
    <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
      <span className="text-xs text-slate-500">Branch:</span>
      <code className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs text-indigo-300 font-mono">
        {active.branch}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(
            `cd ${workspacePath} && git checkout ${active.branch}`,
          );
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className={
          "rounded border px-3 py-1.5 text-xs transition " +
          (copied
            ? "border-emerald-500 text-emerald-300 bg-emerald-500/10"
            : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500")
        }
      >
        {copied ? "Copied!" : "Copy checkout cmd"}
      </button>
    </div>
  );
}
