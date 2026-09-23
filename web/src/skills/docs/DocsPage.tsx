import { useEffect, useState } from "react";
import { api } from "../../api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DocSummary {
  id: number;
  source_type: string;
  source_id: number;
  skill_id: string | null;
  title: string;
  files_json: string;
  created_at: string;
  updated_at: string;
}

interface DocFull extends DocSummary {
  content: string;
}

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

/** Simple markdown to HTML renderer for the subset we generate. */
function renderMarkdown(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h4 style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px;">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="font-size:13px;font-weight:600;color:var(--text);margin:16px 0 8px;">$1</h3>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0;">&#x2022; $1</div>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg4);padding:1px 4px;border-radius:3px;font-family:var(--mono);font-size:10px;">$1</code>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DocsPage() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedContent, setExpandedContent] = useState<string>("");
  const [regenerating, setRegenerating] = useState<number | null>(null);

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
      return;
    }
    try {
      const doc = await api.getDoc(id);
      setExpandedContent((doc as DocFull).content);
      setExpandedId(id);
    } catch { /* */ }
  }

  async function onDelete(id: number) {
    try {
      await api.deleteDoc(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      if (expandedId === id) setExpandedId(null);
    } catch { /* */ }
  }

  async function onRegenerate(id: number) {
    setRegenerating(id);
    try {
      await api.regenerateDoc(id);
      await loadDocs();
    } catch { /* */ }
    setRegenerating(null);
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
                    {isExpanded && (
                      <tr key={`${doc.id}-content`}>
                        <td colSpan={4} style={{ padding: "12px 20px", background: "var(--bg3)" }}>
                          <div
                            style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.7 }}
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(expandedContent) }}
                          />
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
