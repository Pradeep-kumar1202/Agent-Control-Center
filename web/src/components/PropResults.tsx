import { useState } from "react";
import type { PropGenerateResponse, PropRepoResult } from "../api";

interface Props {
  result: PropGenerateResponse;
  onClose: () => void;
}

export function PropResults({ result, onClose }: Props) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");
  const [copiedPr, setCopiedPr] = useState(false);

  const active = result.results[activeRepo];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-w-5xl w-full max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              Prop: {result.propName}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Generated across{" "}
              {repos.map(([k]) => k).join(" + ")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-500"
          >
            Close
          </button>
        </div>

        {/* Repo tabs */}
        <div className="flex border-b border-slate-800 px-6">
          {repos.map(([key, r]) => (
            <button
              key={key}
              onClick={() => setActiveRepo(key)}
              className={
                "px-4 py-2 text-sm font-medium border-b-2 transition " +
                (activeRepo === key
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              {key === "web" ? "Web SDK" : "Mobile SDK"}
              {r.error ? (
                <span className="ml-2 text-red-400 text-xs">error</span>
              ) : (
                <span className="ml-2 text-slate-600 text-xs">
                  {r.filesTouched} files
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        {active && (
          <>
            {active.error ? (
              <div className="p-6 text-red-300">
                <div className="font-medium mb-2">Generation failed</div>
                <pre className="text-xs whitespace-pre-wrap">
                  {active.error}
                </pre>
              </div>
            ) : (
              <>
                {/* Summary card */}
                <div className="border-b border-slate-800 px-6 py-4">
                  <RepoSummary result={active} />
                </div>

                {/* Diff */}
                <div className="flex-1 overflow-auto p-4">
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto">
                    {active.diff.split("\n").map((line, i) => (
                      <DiffLine key={i} line={line} />
                    ))}
                  </pre>
                </div>

                {/* Footer */}
                <div className="border-t border-slate-700 px-6 py-3 flex items-center gap-3">
                  <span className="text-xs text-slate-500">Branch:</span>
                  <code className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-xs text-indigo-300 font-mono">
                    {active.branch}
                  </code>
                  <button
                    onClick={() => {
                      const repoDir =
                        active.repo === "web"
                          ? "hyperswitch-web"
                          : "hyperswitch-client-core";
                      navigator.clipboard.writeText(
                        `cd workspace/${repoDir} && git checkout ${active.branch}`,
                      );
                    }}
                    className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:border-slate-500"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => {
                      const prText = generatePropPR(result.propName, active);
                      navigator.clipboard.writeText(prText);
                      setCopiedPr(true);
                      setTimeout(() => setCopiedPr(false), 2000);
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
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RepoSummary({ result }: { result: PropRepoResult }) {
  // Try to parse structured summary
  try {
    const braceStart = result.summary.indexOf("{");
    const braceEnd = result.summary.lastIndexOf("}");
    if (braceStart >= 0 && braceEnd > braceStart) {
      const parsed = JSON.parse(result.summary.slice(braceStart, braceEnd + 1));
      if (parsed.what && Array.isArray(parsed.files)) {
        return (
          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-100">
              {parsed.what}
            </div>
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
                        <td className="px-3 py-2 text-slate-400">
                          {f.change}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            {parsed.notes && (
              <div className="text-xs text-slate-500">{parsed.notes}</div>
            )}
          </div>
        );
      }
    }
  } catch {
    /* fall through to plain text */
  }
  return <div className="text-sm text-slate-300">{result.summary}</div>;
}

function generatePropPR(propName: string, result: PropRepoResult): string {
  const repoName =
    result.repo === "web"
      ? "hyperswitch-web"
      : "hyperswitch-client-core";
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

function DiffLine({ line }: { line: string }) {
  let color = "text-slate-400";
  if (line.startsWith("+") && !line.startsWith("+++")) {
    color = "text-emerald-400";
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    color = "text-red-400";
  } else if (line.startsWith("@@")) {
    color = "text-indigo-400";
  } else if (line.startsWith("diff ") || line.startsWith("index ")) {
    color = "text-slate-500";
  }
  return <div className={color}>{line || " "}</div>;
}
