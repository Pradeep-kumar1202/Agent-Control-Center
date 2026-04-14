import { useState, useRef } from "react";
import type { SkillFormProps, SkillEnvelopeClient } from "../registry";
import { readNdjson } from "../../components/ndjson";

type DocSource = "text" | "url";
type Phase = "reading_docs" | "analysing" | "implementing" | "verifying" | null;

const PHASE_LABELS: Record<string, string> = {
  reading_docs: "Reading document...",
  analysing: "Analysing codebase patterns...",
  implementing: "Implementing integration...",
  verifying: "Verifying implementation...",
};

export function IntegrationForm({ onResult, onError }: SkillFormProps) {
  const [docSource, setDocSource] = useState<DocSource>("text");
  const [docContent, setDocContent] = useState("");
  const [description, setDescription] = useState("");
  const [targetWeb, setTargetWeb] = useState(true);
  const [targetMobile, setTargetMobile] = useState(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);
  const [toolChips, setToolChips] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  async function onSubmit() {
    if (!docContent.trim()) {
      onError("Please provide document content or URL");
      return;
    }
    const targetRepos: string[] = [];
    if (targetWeb) targetRepos.push("web");
    if (targetMobile) targetRepos.push("mobile");
    if (targetRepos.length === 0) {
      onError("Select at least one target repo");
      return;
    }

    setRunning(true);
    setPhase(null);
    setCurrentRepo(null);
    setToolChips([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch("/api/skills/integration/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentSource: docSource,
          documentContent: docContent,
          targetRepos,
          description,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        onError(`Request failed: ${resp.status}`);
        setRunning(false);
        return;
      }

      let envelope: SkillEnvelopeClient | null = null;

      for await (const chunk of readNdjson<Record<string, unknown>>(resp.body)) {
        if (chunk.type === "phase_marker") {
          setPhase(chunk.phase as Phase);
        } else if (chunk.type === "repo_marker") {
          setCurrentRepo(chunk.repo as string);
        } else if (chunk.type === "tool_use") {
          const tool = chunk.tool as { name: string } | undefined;
          if (tool?.name) {
            setToolChips((prev) => [...prev.slice(-19), tool.name]);
          }
        } else if (chunk.type === "skill_done") {
          envelope = (chunk as { envelope: SkillEnvelopeClient }).envelope;
        } else if (chunk.type === "error") {
          onError(chunk.error as string);
        }
      }

      if (envelope) {
        onResult(envelope);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError((err as Error).message);
      }
    } finally {
      setRunning(false);
      setPhase(null);
      abortRef.current = null;
    }
  }

  function onCancel() {
    abortRef.current?.abort();
    setRunning(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="gap-table-wrap" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Source toggle */}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text3)", width: 60 }}>Source:</span>
          <button
            className={`filter-tab ${docSource === "text" ? "active" : ""}`}
            onClick={() => setDocSource("text")}
            disabled={running}
          >
            Paste text
          </button>
          <button
            className={`filter-tab ${docSource === "url" ? "active" : ""}`}
            onClick={() => setDocSource("url")}
            disabled={running}
          >
            URL
          </button>
        </div>

        {/* Document input */}
        {docSource === "text" ? (
          <textarea
            placeholder="Paste the payment method documentation here..."
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            disabled={running}
            rows={8}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 12px",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--mono)",
              resize: "vertical",
              outline: "none",
            }}
          />
        ) : (
          <input
            type="text"
            placeholder="https://docs.example.com/payment-method-spec"
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            disabled={running}
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 12px",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--mono)",
              outline: "none",
            }}
          />
        )}

        {/* Description */}
        <div>
          <label style={{ fontSize: 11, color: "var(--text3)", display: "block", marginBottom: 4 }}>
            Additional context (optional)
          </label>
          <input
            type="text"
            placeholder="e.g., This is a redirect-based payment method for Brazil"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={running}
            style={{
              width: "100%",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 12px",
              color: "var(--text)",
              fontSize: 12,
              outline: "none",
              fontFamily: "var(--sans)",
            }}
          />
        </div>

        {/* Target repos */}
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text3)" }}>Target:</span>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text2)", cursor: "pointer" }}>
            <input type="checkbox" checked={targetWeb} onChange={(e) => setTargetWeb(e.target.checked)} disabled={running} />
            Web SDK
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text2)", cursor: "pointer" }}>
            <input type="checkbox" checked={targetMobile} onChange={(e) => setTargetMobile(e.target.checked)} disabled={running} />
            Mobile SDK
          </label>
        </div>

        {/* Submit */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className="btn btn-accent"
            disabled={running || !docContent.trim()}
            onClick={onSubmit}
          >
            {running ? "Running..." : "Analyze & Implement"}
          </button>
          {running && (
            <button className="btn btn-red btn-sm" onClick={onCancel}>Cancel</button>
          )}
        </div>
      </div>

      {/* Streaming progress */}
      {running && (
        <div className="gap-table-wrap" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="status-dot running" />
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
              {currentRepo && <span className="badge badge-component" style={{ marginRight: 6 }}>{currentRepo}</span>}
              {phase ? PHASE_LABELS[phase] : "Starting..."}
            </span>
          </div>

          {/* Tool chips */}
          {toolChips.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {toolChips.map((name, i) => (
                <span key={i} className="badge badge-component" style={{ fontSize: 9 }}>{name}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
