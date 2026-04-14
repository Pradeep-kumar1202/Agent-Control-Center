import { useState } from "react";
import type { Gap, GapPrRow } from "../api";
import { PreviewButton } from "./PreviewButton";

interface Props {
  gaps: Gap[];
  verifying: Set<number>;
  patching: Set<number>;
  patchedGaps: Set<number>;
  patchBuildStatus: Map<number, "pass" | "fail" | "skipped">;
  patchBranches: Map<number, string>;
  gapPrs: Map<string, GapPrRow[]>;
  onVerify: (id: number) => void;
  onPatch: (id: number) => void;
  onViewSource: (gap: Gap) => void;
  onAddPr: (gapId: number, prUrl: string) => Promise<void>;
  onRemovePr: (prId: number, gapId: number) => Promise<void>;
  onOpenPreview: (repoKey: "web" | "mobile", branch: string, gapId: number) => void;
}

function gapPrKey(g: Gap): string {
  return `${g.canonical_name}:${g.category}:${g.missing_in}`;
}

function categoryBadgeClass(cat: Gap["category"]): string {
  switch (cat) {
    case "payment_method": return "badge badge-payment";
    case "config": return "badge badge-config";
    case "component": return "badge badge-component";
    case "backend_api": return "badge badge-backend";
  }
}

function categoryLabel(cat: Gap["category"]): string {
  switch (cat) {
    case "payment_method": return "payment";
    case "config": return "config";
    case "component": return "component";
    case "backend_api": return "backend api";
  }
}

function evidenceFile(g: Gap): string {
  const f = g.evidence[0]?.file;
  if (!f) return "—";
  return f.split("/").pop() ?? f;
}

function prShortLabel(url: string): string {
  try {
    const u = new URL(url);
    const prMatch = u.pathname.match(/\/pull\/(\d+)/);
    if (prMatch) {
      const parts = u.pathname.split("/").filter(Boolean);
      const repo = parts[1] ?? parts[0] ?? "";
      return `${repo} #${prMatch[1]}`;
    }
    return u.pathname.split("/").slice(-2).join("/");
  } catch {
    return url.slice(0, 30);
  }
}

export function GapTable({
  gaps,
  verifying,
  patching,
  patchedGaps,
  patchBuildStatus,
  patchBranches,
  gapPrs,
  onVerify,
  onPatch,
  onViewSource,
  onAddPr,
  onRemovePr,
  onOpenPreview,
}: Props) {
  if (gaps.length === 0) {
    return (
      <div className="gap-table-wrap">
        <div className="gap-table-empty">No gaps to show.</div>
      </div>
    );
  }

  return (
    <div className="gap-table-wrap">
      <table className="gap-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Feature</th>
            <th>Missing in</th>
            <th>Evidence</th>
            <th>Status</th>
            <th>Linked PRs</th>
            <th style={{ textAlign: "right", minWidth: 280 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {gaps.map((g) => (
            <GapRow
              key={g.id}
              gap={g}
              isVerifying={verifying.has(g.id)}
              isPatching={patching.has(g.id)}
              hasPatched={patchedGaps.has(g.id)}
              buildStatus={patchBuildStatus.get(g.id)}
              patchBranch={patchBranches.get(g.id)}
              prs={gapPrs.get(gapPrKey(g)) ?? []}
              onVerify={onVerify}
              onPatch={onPatch}
              onViewSource={onViewSource}
              onAddPr={onAddPr}
              onRemovePr={onRemovePr}
              onOpenPreview={onOpenPreview}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GapRow({
  gap: g,
  isVerifying,
  isPatching,
  hasPatched,
  buildStatus,
  patchBranch,
  prs,
  onVerify,
  onPatch,
  onViewSource,
  onAddPr,
  onRemovePr,
  onOpenPreview,
}: {
  gap: Gap;
  isVerifying: boolean;
  isPatching: boolean;
  hasPatched: boolean;
  buildStatus: "pass" | "fail" | "skipped" | undefined;
  patchBranch: string | undefined;
  prs: GapPrRow[];
  onVerify: (id: number) => void;
  onPatch: (id: number) => void;
  onViewSource: (gap: Gap) => void;
  onAddPr: (gapId: number, prUrl: string) => Promise<void>;
  onRemovePr: (prId: number, gapId: number) => Promise<void>;
  onOpenPreview: (repoKey: "web" | "mobile", branch: string, gapId: number) => void;
}) {
  const [linkingPr, setLinkingPr] = useState(false);
  const [prInput, setPrInput] = useState("");
  const [prError, setPrError] = useState<string | null>(null);
  const [addingPr, setAddingPr] = useState(false);
  const [removingPrId, setRemovingPrId] = useState<number | null>(null);

  const submitPr = async () => {
    const url = prInput.trim();
    if (!url || !url.startsWith("http")) { setPrError("Must be a valid URL"); return; }
    setAddingPr(true);
    setPrError(null);
    try {
      await onAddPr(g.id, url);
      setPrInput("");
      setLinkingPr(false);
    } catch (e) {
      setPrError((e as Error).message);
    } finally {
      setAddingPr(false);
    }
  };

  const removePr = async (prId: number) => {
    setRemovingPrId(prId);
    try { await onRemovePr(prId, g.id); }
    finally { setRemovingPrId(null); }
  };

  // Status badge
  let statusBadge: React.ReactNode;
  if (g.platform_specific === 1) {
    statusBadge = <span className="badge badge-platform">platform</span>;
  } else if (hasPatched) {
    statusBadge = (
      <span className="badge badge-patched">
        patched
        {buildStatus === "pass" && <span style={{ marginLeft: 4, color: "var(--green)" }}>✓</span>}
        {buildStatus === "fail" && <span style={{ marginLeft: 4, color: "var(--red)" }}>✗</span>}
      </span>
    );
  } else if (g.verified === 1) {
    statusBadge = <span className="badge badge-verified">verified</span>;
  } else {
    statusBadge = <span className="badge badge-unverified">unverified</span>;
  }

  return (
    <tr className={g.platform_specific === 1 ? "dimmed" : ""}>
      {/* Category */}
      <td>
        <span className={categoryBadgeClass(g.category)}>{categoryLabel(g.category)}</span>
      </td>

      {/* Feature name */}
      <td>
        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{g.canonical_name}</span>
      </td>

      {/* Missing in */}
      <td>
        <span className={`badge ${g.missing_in === "mobile" ? "badge-mobile" : "badge-web"}`}>
          {g.missing_in}
        </span>
      </td>

      {/* Evidence */}
      <td>
        <span className="mono" style={{ fontSize: 10, color: "var(--text3)" }} title={g.evidence[0]?.file}>
          {evidenceFile(g)}
        </span>
      </td>

      {/* Status */}
      <td>{statusBadge}</td>

      {/* Linked PRs */}
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {prs.map((pr) => (
            <div key={pr.id} style={{ display: "flex", alignItems: "center", gap: 5 }} className="group">
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, display: "inline-block" }} />
              <a
                href={pr.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mono"
                style={{ fontSize: 10, color: "var(--accent)", textDecoration: "none", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={pr.pr_url}
                onMouseOver={(e) => (e.currentTarget.style.textDecoration = "underline")}
                onMouseOut={(e) => (e.currentTarget.style.textDecoration = "none")}
              >
                {prShortLabel(pr.pr_url)}
              </a>
              <button
                onClick={() => removePr(pr.id)}
                disabled={removingPrId === pr.id}
                style={{ marginLeft: 2, fontSize: 11, color: "var(--text3)", cursor: "pointer", background: "none", border: "none", padding: 0, opacity: 0.5, transition: "opacity .15s" }}
                title="Remove link"
                onMouseOver={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseOut={(e) => (e.currentTarget.style.opacity = "0.5")}
              >
                {removingPrId === pr.id ? "…" : "×"}
              </button>
            </div>
          ))}

          {linkingPr ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
              <input
                autoFocus
                value={prInput}
                onChange={(e) => setPrInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPr();
                  if (e.key === "Escape") { setLinkingPr(false); setPrInput(""); setPrError(null); }
                }}
                placeholder="https://github.com/…/pull/…"
                style={{
                  borderRadius: 4, border: "1px solid var(--border2)", background: "var(--bg3)",
                  padding: "2px 6px", fontSize: 10, color: "var(--text)", width: 140,
                  outline: "none", fontFamily: "var(--mono)",
                }}
                onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border2)")}
              />
              <button
                className="btn btn-sm"
                style={{ borderColor: "var(--accent)", color: "var(--accent)", fontSize: 10 }}
                onClick={submitPr}
                disabled={addingPr || !prInput.trim()}
              >
                {addingPr ? "…" : "Add"}
              </button>
              <button
                onClick={() => { setLinkingPr(false); setPrInput(""); setPrError(null); }}
                style={{ fontSize: 11, color: "var(--text3)", cursor: "pointer", background: "none", border: "none" }}
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setLinkingPr(true)}
              style={{ fontSize: 10, color: "var(--text3)", cursor: "pointer", background: "none", border: "none", textAlign: "left", padding: 0, marginTop: prs.length > 0 ? 2 : 0 }}
              onMouseOver={(e) => (e.currentTarget.style.color = "var(--accent)")}
              onMouseOut={(e) => (e.currentTarget.style.color = "var(--text3)")}
            >
              + Link PR
            </button>
          )}
          {prError && <p style={{ fontSize: 10, color: "var(--red)", margin: "2px 0 0" }}>{prError}</p>}
        </div>
      </td>

      {/* Actions */}
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
          <button
            className="btn btn-sm"
            onClick={() => onViewSource(g)}
          >
            View
          </button>

          <button
            className="btn btn-sm"
            disabled={isVerifying || g.verified === 1}
            onClick={() => onVerify(g.id)}
            style={
              g.verified === 1
                ? { borderColor: "var(--border)", color: "var(--text3)", cursor: "default" }
                : isVerifying
                  ? { borderColor: "rgba(124,106,247,.4)", color: "var(--accent)", cursor: "wait" }
                  : {}
            }
          >
            {isVerifying ? "Checking…" : g.verified === 1 ? "Verified" : "Verify"}
          </button>

          {hasPatched ? (
            <>
              <button
                className="btn btn-sm btn-green"
                onClick={() => onPatch(g.id)}
              >
                Chat
                {buildStatus === "pass" && <span style={{ color: "var(--green)" }}>✓</span>}
                {buildStatus === "fail" && <span style={{ color: "var(--red)" }}>✗</span>}
              </button>
              {patchBranch && (
                <PreviewButton
                  repoKey={g.missing_in}
                  branch={patchBranch}
                  onOpen={() => onOpenPreview(g.missing_in, patchBranch, g.id)}
                />
              )}
            </>
          ) : (
            <button
              className={`btn btn-sm ${!g.platform_specific && !isPatching ? "btn-amber" : ""}`}
              disabled={isPatching || g.platform_specific === 1}
              onClick={() => onPatch(g.id)}
              style={
                g.platform_specific === 1
                  ? { borderColor: "var(--border)", color: "var(--text3)", cursor: "default" }
                  : isPatching
                    ? { borderColor: "rgba(245,158,11,.3)", color: "var(--amber)", cursor: "wait" }
                    : {}
              }
            >
              {isPatching ? "Generating…" : "Generate Patch"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
