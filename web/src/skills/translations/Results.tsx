import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";

const RTL_LANGS = new Set(["ar", "he"]);

export function TranslationsResults({ result, onClose }: SkillResultsProps) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");
  const [showDiff, setShowDiff] = useState(false);

  const keyName = (result.meta?.keyName as string) ?? "";
  const englishValue = (result.meta?.englishValue as string) ?? "";
  const allTranslations = (result.meta?.allTranslations as Record<string, string>) ?? {};
  const rtlLangs = (result.meta?.rtlLangs as string[]) ?? [];
  const active = result.results[activeRepo];

  const translationEntries = Object.entries(allTranslations);

  return (
    <SkillShell
      title={`Translation: ${keyName}`}
      subtitle={`"${englishValue}" · ${translationEntries.length} languages`}
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
              <div className="font-medium mb-2">Translation failed</div>
              <pre className="text-xs whitespace-pre-wrap">{active.error}</pre>
            </div>
          ) : (
            <>
              {/* Translation table */}
              {!showDiff && translationEntries.length > 0 && (
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
                      <tr className="text-slate-500 uppercase tracking-wider">
                        <th className="text-left px-4 py-2 font-medium w-20">Lang</th>
                        <th className="text-left px-4 py-2 font-medium">Translation</th>
                        <th className="text-left px-4 py-2 font-medium w-16">Dir</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {translationEntries.map(([lang, value]) => (
                        <tr key={lang} className="hover:bg-slate-800/30">
                          <td className="px-4 py-2 font-mono text-sky-400 font-medium">{lang}</td>
                          <td
                            className="px-4 py-2 text-slate-300"
                            dir={RTL_LANGS.has(lang) ? "rtl" : "ltr"}
                          >
                            {value}
                          </td>
                          <td className="px-4 py-2">
                            {RTL_LANGS.has(lang) && (
                              <span className="rounded px-1.5 py-0.5 text-xs bg-amber-500/10 text-amber-400 border border-amber-500/30">
                                RTL
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Diff view */}
              {showDiff && <DiffSection diff={active.diff} />}

              {/* Footer */}
              <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
                <button
                  onClick={() => setShowDiff((v) => !v)}
                  className={
                    "rounded border px-3 py-1.5 text-xs transition " +
                    (showDiff
                      ? "border-sky-500 text-sky-300 bg-sky-500/10"
                      : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200")
                  }
                >
                  {showDiff ? "Show Translations" : `Show Diff (${active.filesTouched} files)`}
                </button>
                <span className="text-xs text-slate-500">Branch:</span>
                <code className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs text-sky-300 font-mono">
                  {active.branch}
                </code>
                <button
                  onClick={() => {
                    const repoDir = active.repo === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
                    navigator.clipboard.writeText(`cd workspace/${repoDir} && git checkout ${active.branch}`);
                  }}
                  className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500"
                >
                  Copy
                </button>
                {rtlLangs.length > 0 && (
                  <span className="text-xs text-slate-500">
                    RTL: {rtlLangs.join(", ")}
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </SkillShell>
  );
}
