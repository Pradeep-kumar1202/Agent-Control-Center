import { useState } from "react";
import type { SkillResultsProps, SkillRepoResultClient } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";
import type { ReviewResult, SdkClassification, UiEntryPoint, ApiChainKnownPattern, ConfirmTiming } from "../../api";

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
 * Derive the top-level tabs from result keys.
 * - `mobile` and `rn_packages` are grouped under a single "Mobile SDK" tab
 * - `web` stays as "Web SDK"
 */
function deriveTopTabs(resultKeys: string[]): string[] {
  const tabs: string[] = [];
  if (resultKeys.includes("mobile") || resultKeys.includes("rn_packages")) {
    tabs.push("mobile_group");
  }
  if (resultKeys.includes("web")) {
    tabs.push("web");
  }
  return tabs;
}

function topTabLabel(key: string): string {
  if (key === "mobile_group") return "Mobile SDK";
  if (key === "web") return "Web SDK";
  return key;
}

export function SdkIntegratorResults({ result, onClose }: SkillResultsProps) {
  const allRepoKeys = Object.keys(result.results);
  const topTabs = deriveTopTabs(allRepoKeys);
  const [activeTab, setActiveTab] = useState(topTabs[0] ?? "");
  const [mobileSubTab, setMobileSubTab] = useState<string>("mobile");
  const [expandedReview, setExpandedReview] = useState<number | null>(null);

  const sdkName = (result.meta?.sdkName as string) ?? "";
  const classification = result.meta?.classification as SdkClassification | undefined;
  const reviewLogs = (result.meta?.reviewLogs as Record<string, ReviewLogEntry[]>) ?? {};
  const prompts = (result.meta?.prompts as Record<string, string>) ?? {};
  const [promptExpanded, setPromptExpanded] = useState(false);

  // Resolve which repo key to actually display
  const activeRepoKey = activeTab === "mobile_group" ? mobileSubTab : activeTab;
  const active = result.results[activeRepoKey];
  const activeReviewLog = reviewLogs[activeRepoKey] ?? [];
  // Mobile prompt is shared across client-core and rn_packages (one combined prompt).
  const activePrompt =
    prompts[activeRepoKey] ||
    (activeTab === "mobile_group" ? prompts.mobile : undefined);

  // Count total repos for subtitle
  const repoCount = allRepoKeys.length;
  const subtitleParts: string[] = [];
  if (classification?.uiEntryPoint) subtitleParts.push(formatUiEntry(classification.uiEntryPoint));
  if (classification?.apiChain?.knownPattern) subtitleParts.push(formatApiChain(classification.apiChain.knownPattern));
  if (classification?.confirmTiming) subtitleParts.push(formatConfirmTiming(classification.confirmTiming));
  subtitleParts.push(`${repoCount} repo${repoCount > 1 ? "s" : ""}`);
  const subtitle = subtitleParts.join(" | ");

  // Mobile file count across both sub-repos
  const mobileFileCount = (result.results.mobile?.filesTouched ?? 0) + (result.results.rn_packages?.filesTouched ?? 0);
  const mobileHasError = result.results.mobile?.error || result.results.rn_packages?.error;

  return (
    <SkillShell
      title={`Integration: ${sdkName}`}
      subtitle={subtitle}
      repoKeys={topTabs}
      activeRepo={activeTab}
      onRepoChange={(key) => {
        setActiveTab(key);
        setExpandedReview(null);
        // Reset mobile sub-tab when switching to mobile group
        if (key === "mobile_group") setMobileSubTab("mobile");
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
      {activeTab === "mobile_group" && (
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
                    ? "border-orange-500 text-orange-300"
                    : "border-transparent text-slate-500 hover:text-slate-300")
                }
              >
                {sub.label}
                {subResult?.error ? (
                  <span className="ml-1.5 text-red-400">error</span>
                ) : subResult ? (
                  <span className="ml-1.5 text-slate-600">{subResult.filesTouched} files</span>
                ) : (
                  <span className="ml-1.5 text-slate-700">{"\u2014"}</span>
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
              <div className="font-medium mb-2">Generation failed</div>
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

              {/* Coder prompt */}
              {activePrompt && (
                <div className="border-b border-slate-800 px-6 py-3">
                  <button
                    onClick={() => setPromptExpanded((v) => !v)}
                    className="flex items-center gap-2 text-xs w-full text-left hover:text-slate-200"
                  >
                    <span className="text-slate-500">{promptExpanded ? "v" : ">"}</span>
                    <span className="text-slate-500 font-medium uppercase tracking-wider">
                      Coder Prompt
                    </span>
                    <span className="text-slate-600">
                      ({activePrompt.length.toLocaleString()} chars)
                    </span>
                  </button>
                  {promptExpanded && (
                    <pre className="mt-2 rounded border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300 font-mono whitespace-pre-wrap max-h-[32rem] overflow-y-auto">
                      {activePrompt}
                    </pre>
                  )}
                </div>
              )}

              {/* Diff */}
              <DiffSection diff={active.diff} />

              {/* Footer */}
              <IntegrationFooter sdkName={sdkName} active={active} />
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
                        <td className="px-3 py-2 font-mono text-orange-300 whitespace-nowrap">
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

function IntegrationFooter({
  sdkName: _sdkName,
  active,
}: {
  sdkName: string;
  active: SkillRepoResultClient;
}) {
  const [copied, setCopied] = useState(false);

  // Map repo key to workspace path (namespaced directories)
  const workspacePath =
    active.repo === "web"
      ? "workspace/web/hyperswitch-web"
      : active.repo === "mobile"
        ? "workspace/mobile/hyperswitch-client-core"
        : active.repo === "rn_packages"
          ? "workspace/mobile/react-native-hyperswitch"
          : `workspace/${active.repo}`;

  return (
    <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
      <span className="text-xs text-slate-500">Branch:</span>
      <code className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs text-orange-300 font-mono">
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

// ─── Formatting helpers ──────────────────────────────────────────────────────

const UI_ENTRY_LABELS: Record<UiEntryPoint, string> = {
  native_view: "Native View",
  custom_trigger_button: "Custom Trigger Button",
  invisible: "Invisible",
  utility_ui: "Utility UI",
  other: "Other",
};

const API_CHAIN_LABELS: Record<ApiChainKnownPattern, string> = {
  session_direct: "Session Direct",
  session_post_session: "Session+PostSession",
  confirm_next_action: "Confirm+NextAction",
  no_api: "No API",
  custom: "Custom Chain",
};

const CONFIRM_TIMING_LABELS: Record<ConfirmTiming, string> = {
  post_sdk_with_data: "Post-SDK w/ Data",
  post_sdk_status_only: "Post-SDK Status",
  pre_sdk: "Pre-SDK",
  not_applicable: "N/A",
  custom: "Custom",
};

function formatUiEntry(v: UiEntryPoint): string {
  return UI_ENTRY_LABELS[v] ?? v;
}

function formatApiChain(v: ApiChainKnownPattern): string {
  return API_CHAIN_LABELS[v] ?? v;
}

function formatConfirmTiming(v: ConfirmTiming): string {
  return CONFIRM_TIMING_LABELS[v] ?? v;
}
