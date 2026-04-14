import { useState } from "react";
import type { SkillResultsProps } from "../registry";
import { SkillShell } from "../shared/SkillShell";
import { DiffSection } from "../shared/DiffSection";

export function IntegrationResults({ result, onClose }: SkillResultsProps) {
  const repos = Object.entries(result.results);
  const [activeRepo, setActiveRepo] = useState(repos[0]?.[0] ?? "");

  const active = result.results[activeRepo];

  return (
    <SkillShell
      title="Integration Agent"
      subtitle={`Integrated across ${repos.map(([k]) => k).join(" + ")}`}
      repoKeys={repos.map(([k]) => k)}
      activeRepo={activeRepo}
      onRepoChange={setActiveRepo}
      onClose={onClose}
      results={result.results}
    >
      {active && (
        <>
          {active.error ? (
            <div style={{ padding: 24, color: "var(--red)" }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>Integration failed</div>
              <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{active.error}</pre>
            </div>
          ) : (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Summary */}
              <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.6 }}>
                {active.summary}
              </div>

              {/* Branch + files */}
              <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11 }}>
                <span className="badge badge-component">{active.branch}</span>
                <span style={{ color: "var(--text3)" }}>
                  {active.filesTouched} file{active.filesTouched !== 1 ? "s" : ""} changed
                </span>
              </div>

              {/* PR link */}
              {active.prUrl && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <a
                    href={active.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 12, color: "var(--accent)" }}
                  >
                    View PR
                  </a>
                </div>
              )}
              {active.prWarning && (
                <div style={{ fontSize: 11, color: "var(--amber)" }}>{active.prWarning}</div>
              )}

              {/* Diff */}
              {active.diff && <DiffSection diff={active.diff} />}
            </div>
          )}
        </>
      )}
    </SkillShell>
  );
}
