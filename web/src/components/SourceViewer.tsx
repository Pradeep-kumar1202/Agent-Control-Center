import { useEffect, useState } from "react";
import { api, type Gap, type PatchResponse } from "../api";

interface Props {
  gap: Gap;
  patch?: PatchResponse | null;
  onClose: () => void;
}

export function SourceViewer({ gap, patch, onClose }: Props) {
  const [source, setSource] = useState<{
    file: string | null;
    content: string | null;
    repo: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"source" | "patch">("source");

  useEffect(() => {
    api
      .getGapSource(gap.id)
      .then(setSource)
      .catch(() => setSource({ file: null, content: null, repo: gap.present_in }))
      .finally(() => setLoading(false));
  }, [gap.id, gap.present_in]);

  const hasPatch = patch && patch.diff;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-w-6xl w-full max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              {gap.canonical_name}
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              Present in{" "}
              <span className="text-indigo-300">{gap.present_in}</span>
              {" · "}
              Missing in{" "}
              <span className="text-amber-300">{gap.missing_in}</span>
              {" · "}
              {gap.category}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-500"
          >
            Close
          </button>
        </div>

        {/* Tabs */}
        {hasPatch && (
          <div className="flex border-b border-slate-800 px-6">
            <button
              onClick={() => setActiveTab("source")}
              className={
                "px-4 py-2 text-sm font-medium border-b-2 transition " +
                (activeTab === "source"
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              Reference Source ({gap.present_in})
            </button>
            <button
              onClick={() => setActiveTab("patch")}
              className={
                "px-4 py-2 text-sm font-medium border-b-2 transition " +
                (activeTab === "patch"
                  ? "border-amber-500 text-amber-300"
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              Generated Patch ({gap.missing_in})
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {activeTab === "source" && (
            <div className="p-4">
              {loading ? (
                <div className="text-center text-slate-500 py-8">
                  Loading source...
                </div>
              ) : source?.content ? (
                <>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {source.repo}/
                    </span>
                    <code className="text-xs text-indigo-300 font-mono">
                      {source.file}
                    </code>
                  </div>
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto bg-slate-950 rounded-lg border border-slate-800 p-4">
                    {source.content.split("\n").map((line, i) => (
                      <div key={i} className="flex">
                        <span className="select-none text-slate-600 w-10 text-right pr-3 flex-shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-slate-300">{line || " "}</span>
                      </div>
                    ))}
                  </pre>
                </>
              ) : (
                <div className="text-center text-slate-500 py-8">
                  No source file available for this gap.
                </div>
              )}
            </div>
          )}

          {activeTab === "patch" && hasPatch && (
            <div className="p-4">
              <div className="mb-2 text-xs text-slate-500">
                Branch:{" "}
                <code className="text-amber-300">{patch.branch}</code>
                {" · "}
                {patch.filesTouched} file
                {patch.filesTouched === 1 ? "" : "s"} touched
              </div>
              {patch.summary && (
                <div className="mb-3 text-sm text-slate-400 bg-slate-950 rounded-lg border border-slate-800 px-4 py-2">
                  {patch.summary}
                </div>
              )}
              <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto bg-slate-950 rounded-lg border border-slate-800 p-4">
                {patch.diff.split("\n").map((line, i) => (
                  <DiffLine key={i} line={line} />
                ))}
              </pre>
            </div>
          )}
        </div>

        {/* Rationale footer */}
        {gap.rationale && (
          <div className="border-t border-slate-700 px-6 py-3 text-xs text-slate-500">
            <span className="font-medium text-slate-400">Rationale:</span>{" "}
            {gap.rationale}
          </div>
        )}
      </div>
    </div>
  );
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
