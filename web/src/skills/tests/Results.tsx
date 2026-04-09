import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";

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
              <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
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
            </>
          )}
        </>
      )}
    </SkillShell>
  );
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
