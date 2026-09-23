import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import type { SkillRepoResultClient } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";

export function PropsResults({ result, onClose }: SkillResultsProps) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");
  const [copiedPr, setCopiedPr] = useState(false);

  const propName = (result.meta?.propName as string) ?? "";
  const active = result.results[activeRepo];

  return (
    <SkillShell
      title={`Prop: ${propName}`}
      subtitle={`Generated across ${repos.map(([k]) => k).join(" + ")}`}
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
              <div className="font-medium mb-2">Generation failed</div>
              <pre className="text-xs whitespace-pre-wrap">{active.error}</pre>
            </div>
          ) : (
            <>
              <div className="border-b border-slate-800 px-6 py-4">
                <RepoSummary result={active} />
              </div>
              <DiffSection diff={active.diff} />
              <PropFooter
                propName={propName}
                active={active}
                copiedPr={copiedPr}
                onCopiedPr={() => {
                  setCopiedPr(true);
                  setTimeout(() => setCopiedPr(false), 2000);
                }}
              />
            </>
          )}
        </>
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
                  {parsed.files.map((f: { path: string; change: string }, i: number) => (
                    <tr key={i} className="hover:bg-slate-800/50">
                      <td className="px-3 py-2 font-mono text-indigo-300 whitespace-nowrap">{f.path}</td>
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
  return <div className="text-sm text-slate-300">{result.summary}</div>;
}

function PropFooter({
  propName,
  active,
  copiedPr,
  onCopiedPr,
}: {
  propName: string;
  active: SkillRepoResultClient;
  copiedPr: boolean;
  onCopiedPr: () => void;
}) {
  const [branchCopied, setBranchCopied] = useState(false);
  const repoDir = active.repo === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
  return (
    <div className="border-t border-slate-700 px-6 py-3 space-y-2">
      {/* Branch name — prominent one-click-copy chip for easy paste into Test Generator */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-slate-500">Branch:</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(active.branch);
            setBranchCopied(true);
            setTimeout(() => setBranchCopied(false), 2000);
          }}
          title="Click to copy branch name — paste into Test Generator"
          className={
            "flex-1 rounded px-3 py-1.5 text-xs font-mono text-left transition " +
            (branchCopied
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500"
              : "bg-slate-800 text-indigo-300 border border-slate-700 hover:border-indigo-500 cursor-pointer")
          }
        >
          {branchCopied ? "Copied!" : active.branch}
        </button>
        <button
          onClick={() => navigator.clipboard.writeText(`cd workspace/${repoDir} && git checkout ${active.branch}`)}
          className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500"
        >
          Copy checkout cmd
        </button>
      </div>
      {/* PR link or fallback */}
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
        ) : (
          <>
            <span className="text-xs text-slate-500">PR:</span>
            <span className="flex-1 text-xs text-amber-400/80 truncate">
              {active.prWarning ?? "not opened"}
            </span>
            <button
              onClick={() => {
                const text = generatePropPR(propName, active);
                navigator.clipboard.writeText(text);
                onCopiedPr();
              }}
              className={
                "rounded border px-3 py-1.5 text-xs transition " +
                (copiedPr
                  ? "border-emerald-500 text-emerald-300 bg-emerald-500/10"
                  : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500")
              }
            >
              {copiedPr ? "Copied!" : "Copy PR Description"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function generatePropPR(propName: string, result: SkillRepoResultClient): string {
  const repoName = result.repo === "web" ? "hyperswitch-web" : "hyperswitch-client-core";
  return `feat: add ${propName} prop to ${repoName}

## Summary

- Adds the \`${propName}\` configuration prop to **${repoName}**
- ${result.summary.slice(0, 500)}

## Changes

- **Branch:** \`${result.branch}\`
- **Files touched:** ${result.filesTouched}

## Test plan

- [ ] Verify the new prop works with default value
- [ ] Test with prop set to true
- [ ] Test with prop set to false
- [ ] Verify backward compatibility

---
*Generated by Feature Gap Dashboard — Add Prop Skill*`;
}
