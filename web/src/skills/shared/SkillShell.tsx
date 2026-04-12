/**
 * Reusable modal shell for skill results — handles the outer overlay,
 * container, header, and repo tab bar. Skill-specific content is passed as
 * children below the tab bar.
 */

import type { ReactNode } from "react";
import type { SkillRepoResultClient } from "../registry";

interface SkillShellProps {
  title: string;
  subtitle?: string;
  repoKeys: string[];
  activeRepo: string;
  onRepoChange: (key: string) => void;
  onClose: () => void;
  repoTabLabel?: (key: string, result: SkillRepoResultClient) => ReactNode;
  results: Record<string, SkillRepoResultClient>;
  children: ReactNode;
}

export function SkillShell({
  title,
  subtitle,
  repoKeys,
  activeRepo,
  onRepoChange,
  onClose,
  repoTabLabel,
  results,
  children,
}: SkillShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-w-5xl w-full max-h-[90vh] flex flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
            {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
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
          {repoKeys.map((key) => {
            const result = results[key];
            return (
              <button
                key={key}
                onClick={() => onRepoChange(key)}
                className={
                  "px-4 py-2 text-sm font-medium border-b-2 transition " +
                  (activeRepo === key
                    ? "border-indigo-500 text-indigo-300"
                    : "border-transparent text-slate-500 hover:text-slate-300")
                }
              >
                {repoTabLabel ? repoTabLabel(key, result) : (
                  <>
                    {key === "web" ? "Web SDK" : key === "mobile" ? "Mobile SDK" : key === "rn_packages" ? "NPM Packages" : key}
                    {result?.error ? (
                      <span className="ml-2 text-red-400 text-xs">error</span>
                    ) : result ? (
                      <span className="ml-2 text-slate-600 text-xs">{result.filesTouched} files</span>
                    ) : null}
                  </>
                )}
              </button>
            );
          })}
        </div>

        {/* Content area */}
        {children}
      </div>
    </div>
  );
}
