import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";
import { TestRunner } from "./TestRunner";

export function TestsResults({ result, onClose }: SkillResultsProps) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");

  const branch = (result.meta?.branch as string) ?? "";
  const active = result.results[activeRepo];

  return (
    <SkillShell
      title="Test Writer Results"
      subtitle={`Tests generated for branch: ${branch}`}
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
              <div className="font-medium mb-2">Test generation failed</div>
              <pre className="text-xs whitespace-pre-wrap">{active.error}</pre>
            </div>
          ) : (
            <>
              <div className="border-b border-slate-800 px-6 py-4">
                <TestSummary summary={active.summary} />
              </div>
              <DiffSection diff={active.diff} />
              {/* Branch + PR footer */}
              <div className="border-t border-slate-700 px-6 py-3 space-y-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500">Branch:</span>
                  <code className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs text-emerald-300 font-mono">
                    {active.branch}
                  </code>
                  <button
                    onClick={() => {
                      const repoDir = active.repo === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
                      navigator.clipboard.writeText(`cd workspace/${repoDir} && git checkout ${active.branch}`);
                    }}
                    className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500"
                  >
                    Copy checkout
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  {active.prUrl ? (
                    <>
                      <span className="text-xs text-slate-500">PR:</span>
                      <a
                        href={active.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 truncate text-xs text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
                      >
                        {active.prUrl}
                      </a>
                      <a
                        href={active.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition"
                      >
                        Open PR ↗
                      </a>
                    </>
                  ) : active.prWarning ? (
                    <>
                      <span className="text-xs text-slate-500">PR:</span>
                      <span className="flex-1 text-xs text-amber-400/80 truncate">{active.prWarning}</span>
                    </>
                  ) : null}
                </div>
              </div>
              {/* Run Tests — streams Cypress / Detox output inline.
                  Only runs the newly generated test file(s), not the entire suite. */}
              <TestRunner
                branch={active.branch}
                repo={active.repo as "web" | "mobile"}
                testFiles={parseTestFiles(active.summary)}
              />
            </>
          )}
        </>
      )}
    </SkillShell>
  );
}

/** Extract test file paths from the agent's JSON summary so we can pass
 *  them to the runner (run only the new files, not the entire suite). */
function parseTestFiles(summary: string): string[] {
  try {
    const braceStart = summary.indexOf("{");
    const braceEnd = summary.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      const parsed = JSON.parse(summary.slice(braceStart, braceEnd + 1));
      if (Array.isArray(parsed.files)) {
        return parsed.files
          .map((f: { path: string }) => f.path)
          .filter((p: string) => p.endsWith(".cy.ts") || p.endsWith(".test.ts"));
      }
    }
  } catch { /* fall through */ }
  return [];
}

function TestSummary({ summary }: { summary: string }) {
  try {
    const braceStart = summary.indexOf("{");
    const braceEnd = summary.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      const parsed = JSON.parse(summary.slice(braceStart, braceEnd + 1));
      if (parsed.what && Array.isArray(parsed.files)) {
        return (
          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-100">{parsed.what}</div>
            <div className="rounded-lg border border-slate-800 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-950 text-slate-500 uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-medium">File</th>
                    <th className="text-left px-3 py-2 font-medium">Coverage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {parsed.files.map((f: { path: string; change: string }, i: number) => (
                    <tr key={i} className="hover:bg-slate-800/50">
                      <td className="px-3 py-2 font-mono text-emerald-300 whitespace-nowrap">{f.path}</td>
                      <td className="px-3 py-2 text-slate-400">{f.change}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsed.notes && <div className="text-xs text-slate-500">{parsed.notes}</div>}
          </div>
        );
      }
    }
  } catch { /* fall through */ }
  return <div className="text-sm text-slate-300">{summary}</div>;
}
