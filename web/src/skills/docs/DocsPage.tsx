import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type DocFull, type DocSummary } from "../../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const SOURCE_LABELS: Record<string, string> = {
  patch: "Patch",
  skill: "Skill",
  integration: "Integration",
  feature: "Feature",
};

const SOURCE_COLORS: Record<string, { bg: string; color: string }> = {
  patch: { bg: "var(--green-dim)", color: "var(--green)" },
  skill: { bg: "var(--blue-dim)", color: "var(--blue)" },
  integration: { bg: "var(--amber-dim)", color: "var(--amber)" },
  feature: { bg: "var(--accent-dim)", color: "var(--accent)" },
};

// Skills that never produce public copy — show a "scaffolding" placeholder
// instead of a Generate button. Must stay in sync with NO_OFFICIAL_DOC_SKILLS
// in server/src/skills/docs/generator.ts.
const NO_OFFICIAL_SKILLS = new Set(["tests", "review"]);

// ─── Markdown renderer ───────────────────────────────────────────────────────

/** Themed GitHub-flavoured markdown renderer used by both doc blocks. */
function DocMarkdown({ source }: { source: string }) {
  return (
    <div className="doc-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h3 style={H1}>{children}</h3>,
          h2: ({ children }) => <h3 style={H2}>{children}</h3>,
          h3: ({ children }) => <h4 style={H3}>{children}</h4>,
          h4: ({ children }) => <h5 style={H4}>{children}</h5>,
          p: ({ children }) => <p style={P}>{children}</p>,
          ul: ({ children }) => <ul style={UL}>{children}</ul>,
          ol: ({ children }) => <ol style={UL}>{children}</ol>,
          li: ({ children }) => <li style={LI}>{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" style={A}>{children}</a>
          ),
          strong: ({ children }) => <strong style={STRONG}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "");
            return isBlock
              ? <code className={className} style={CODE_BLOCK}>{children}</code>
              : <code style={CODE_INLINE}>{children}</code>;
          },
          pre: ({ children }) => <pre style={PRE}>{children}</pre>,
          table: ({ children }) => (
            <div style={TABLE_WRAP}>
              <table style={TABLE}>{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead style={THEAD}>{children}</thead>,
          th: ({ children }) => <th style={TH}>{children}</th>,
          td: ({ children }) => <td style={TD}>{children}</td>,
          blockquote: ({ children }) => <blockquote style={BLOCKQUOTE}>{children}</blockquote>,
          hr: () => <hr style={HR} />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Inline style objects — kept close to the component so the markdown visuals
// match the rest of the dashboard without polluting global CSS.
const H1: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "var(--text)", margin: "18px 0 10px" };
const H2: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "16px 0 8px" };
const H3: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--text)", margin: "14px 0 6px" };
const H4: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text2)", margin: "12px 0 4px", textTransform: "uppercase", letterSpacing: 0.3 };
const P: React.CSSProperties = { fontSize: 12, color: "var(--text2)", margin: "6px 0", lineHeight: 1.7 };
const UL: React.CSSProperties = { margin: "4px 0 8px", paddingLeft: 20 };
const LI: React.CSSProperties = { fontSize: 12, color: "var(--text2)", lineHeight: 1.7 };
const A: React.CSSProperties = { color: "var(--blue)", textDecoration: "underline" };
const STRONG: React.CSSProperties = { color: "var(--text)", fontWeight: 600 };
const CODE_INLINE: React.CSSProperties = { background: "var(--bg4)", padding: "1px 5px", borderRadius: 3, fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" };
const CODE_BLOCK: React.CSSProperties = { fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" };
const PRE: React.CSSProperties = { background: "var(--bg4)", border: "1px solid var(--border)", borderRadius: 4, padding: 10, overflowX: "auto", margin: "8px 0", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5 };
const TABLE_WRAP: React.CSSProperties = { overflowX: "auto", margin: "8px 0" };
const TABLE: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12 };
const THEAD: React.CSSProperties = { background: "var(--bg4)" };
const TH: React.CSSProperties = { border: "1px solid var(--border)", padding: "6px 10px", textAlign: "left", color: "var(--text)", fontWeight: 600 };
const TD: React.CSSProperties = { border: "1px solid var(--border)", padding: "6px 10px", color: "var(--text2)", lineHeight: 1.6, verticalAlign: "top" };
const BLOCKQUOTE: React.CSSProperties = { borderLeft: "3px solid var(--border)", margin: "8px 0", padding: "2px 12px", color: "var(--text3)" };
const HR: React.CSSProperties = { border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" };

// ─── Component ───────────────────────────────────────────────────────────────

export function DocsPage() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<DocFull | null>(null);
  const [regenerating, setRegenerating] = useState<number | null>(null);
  const [regeneratingOfficial, setRegeneratingOfficial] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    loadDocs();
  }, []);

  async function loadDocs() {
    try {
      const rows = await api.listDocs();
      setDocs(rows);
    } catch (err) {
      console.error("Failed to load docs:", err);
    } finally {
      setLoading(false);
    }
  }

  async function onSearch(q: string) {
    setSearch(q);
    if (!q.trim()) {
      loadDocs();
      return;
    }
    try {
      const rows = await api.searchDocs(q);
      setDocs(rows);
    } catch { /* */ }
  }

  async function onExpand(id: number) {
    if (expandedId === id) {
      setExpandedId(null);
      setExpanded(null);
      return;
    }
    try {
      const doc = await api.getDoc(id);
      setExpanded(doc);
      setExpandedId(id);
    } catch { /* */ }
  }

  async function onDelete(id: number) {
    try {
      await api.deleteDoc(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      if (expandedId === id) {
        setExpandedId(null);
        setExpanded(null);
      }
    } catch { /* */ }
  }

  async function onRegenerate(id: number) {
    setRegenerating(id);
    try {
      const doc = await api.regenerateDoc(id);
      if (expandedId === id) setExpanded(doc);
      await loadDocs();
    } catch { /* */ }
    setRegenerating(null);
  }

  async function onRegenerateOfficial(id: number) {
    setRegeneratingOfficial(id);
    try {
      const doc = await api.regenerateOfficialDoc(id);
      if (expandedId === id) setExpanded(doc);
    } catch { /* */ }
    setRegeneratingOfficial(null);
  }

  async function onCopyOfficial(id: number, markdown: string) {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch (err) {
      console.error("clipboard write failed:", err);
    }
  }

  const filtered = typeFilter === "all"
    ? docs
    : docs.filter((d) => d.source_type === typeFilter);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Loading documentation...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Search + Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search docs..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          style={{
            flex: 1,
            background: "var(--bg3)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 12px",
            color: "var(--text)",
            fontSize: 12,
            outline: "none",
            fontFamily: "var(--sans)",
          }}
        />
        <div style={{ display: "flex", gap: 4 }}>
          {["all", "patch", "skill", "integration", "feature"].map((t) => (
            <button
              key={t}
              className={`filter-tab ${typeFilter === t ? "active" : ""}`}
              onClick={() => setTypeFilter(t)}
            >
              {t === "all" ? "All" : SOURCE_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      </div>

      {/* Doc count */}
      <div style={{ fontSize: 11, color: "var(--text3)" }}>
        {filtered.length} document{filtered.length !== 1 ? "s" : ""}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="empty-state">
          <svg className="empty-state-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <rect x="8" y="4" width="24" height="32" rx="3" />
            <line x1="14" y1="12" x2="26" y2="12" />
            <line x1="14" y1="18" x2="26" y2="18" />
            <line x1="14" y1="24" x2="22" y2="24" />
          </svg>
          <div className="empty-state-title">No documentation yet</div>
          <div className="empty-state-sub">
            Documentation is auto-generated when agents complete patches or skill runs.
          </div>
        </div>
      )}

      {/* Doc cards */}
      {filtered.length > 0 && (
        <div className="gap-table-wrap">
          <table className="gap-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Created</th>
                <th style={{ width: 120 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((doc) => {
                const sc = SOURCE_COLORS[doc.source_type] ?? { bg: "var(--bg4)", color: "var(--text3)" };
                const isExpanded = expandedId === doc.id;
                const full = isExpanded ? expanded : null;
                return (
                  <>
                    <tr
                      key={doc.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => onExpand(doc.id)}
                    >
                      <td style={{ fontWeight: 500, color: "var(--text)" }}>
                        {doc.title}
                        {doc.skill_id && (
                          <span className="badge badge-component" style={{ marginLeft: 6 }}>
                            {doc.skill_id}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="badge" style={{ background: sc.bg, color: sc.color, border: "none" }}>
                          {SOURCE_LABELS[doc.source_type] ?? doc.source_type}
                        </span>
                      </td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text3)" }}>
                        {timeAgo(doc.created_at)}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                          <button
                            className="btn btn-sm"
                            disabled={regenerating === doc.id}
                            onClick={() => onRegenerate(doc.id)}
                          >
                            {regenerating === doc.id ? "..." : "Regen"}
                          </button>
                          <button
                            className="btn btn-sm btn-red"
                            onClick={() => onDelete(doc.id)}
                          >
                            Del
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && full && (
                      <tr key={`${doc.id}-content`}>
                        <td colSpan={4} style={{ padding: "12px 20px", background: "var(--bg3)" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {/* Internal block */}
                            <div style={CARD}>
                              <div style={CARD_HEADER}>
                                <span style={CARD_LABEL}>Internal notes</span>
                              </div>
                              <div style={CARD_BODY}>
                                <DocMarkdown source={full.content} />
                              </div>
                            </div>

                            {/* Official block */}
                            <OfficialBlock
                              doc={full}
                              copied={copied === doc.id}
                              regenerating={regeneratingOfficial === doc.id}
                              onCopy={() => onCopyOfficial(doc.id, full.official_content ?? "")}
                              onRegenerate={() => onRegenerateOfficial(doc.id)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Official block ─────────────────────────────────────────────────────────

function OfficialBlock({
  doc,
  copied,
  regenerating,
  onCopy,
  onRegenerate,
}: {
  doc: DocFull;
  copied: boolean;
  regenerating: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const skipped = NO_OFFICIAL_SKILLS.has(doc.skill_id ?? "");
  const empty = !doc.official_content;

  return (
    <div style={{ ...CARD, borderColor: "var(--blue-dim)" }}>
      <div style={{ ...CARD_HEADER, background: "var(--blue-dim)" }}>
        <span style={{ ...CARD_LABEL, color: "var(--blue)" }}>
          📘 Official GitBook copy
        </span>
        {!skipped && !empty && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" onClick={onCopy}>
              {copied ? "Copied ✓" : "Copy MD"}
            </button>
            <button className="btn btn-sm" disabled={regenerating} onClick={onRegenerate}>
              {regenerating ? "..." : "Regen Official"}
            </button>
          </div>
        )}
      </div>
      <div style={CARD_BODY}>
        {skipped ? (
          <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>
            No official doc — this skill produces internal scaffolding, not public API.
          </div>
        ) : empty ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>
              No official copy yet for this doc.
            </span>
            <button className="btn btn-sm" disabled={regenerating} onClick={onRegenerate}>
              {regenerating ? "Generating…" : "Generate official doc"}
            </button>
          </div>
        ) : (
          <DocMarkdown source={doc.official_content ?? ""} />
        )}
      </div>
    </div>
  );
}

const CARD: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg2)",
  overflow: "hidden",
};
const CARD_HEADER: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg4)",
};
const CARD_LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text2)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const CARD_BODY: React.CSSProperties = {
  padding: "10px 14px 14px",
};
