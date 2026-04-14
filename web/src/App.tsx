import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Gap, type GapPrRow, type PatchDoneChunk, type PatchResponse, type PatchRow, type Report } from "./api";
import { AgentPanel } from "./components/AgentPanel";
import { DiffViewer } from "./components/DiffViewer";
import { GapTable } from "./components/GapTable";
import { PreviewDrawer } from "./components/PreviewDrawer";
import { SourceViewer } from "./components/SourceViewer";
import { SKILLS_REGISTRY, type SkillEnvelopeClient } from "./skills/registry";
import { ReviewHistory } from "./skills/review/History";
import { SkillHistory } from "./skills/shared/SkillHistory";
import { AchievementsPage } from "./skills/achievements/AchievementsPage";
import { DocsPage } from "./skills/docs/DocsPage";
import { FeatureAgent } from "./skills/feature/FeatureAgent";
import { PropsResults } from "./skills/props/Results";
import { TestsResults } from "./skills/tests/Results";

// ─── Types ────────────────────────────────────────────────────────────────────

type StatusFilter = "all" | "verified" | "unverified" | "platform_specific" | "patched";

type ActiveAgent = {
  gapId: number;
  gapName: string;
  mode: "patch" | "chat";
  existingPatchId?: number;
} | null;

const SKILL_HISTORY_CONFIG: Record<
  string,
  {
    name: string;
    formatLabel: (input: Record<string, unknown>) => string;
    ResultsComponent: React.ComponentType<{ result: SkillEnvelopeClient; onClose: () => void }>;
  }
> = {
  props: { name: "Add Prop", formatLabel: (i) => `Prop: ${i.propName ?? "?"}`, ResultsComponent: PropsResults },
  tests: { name: "Test Writer", formatLabel: (i) => `Tests for ${i.branch ?? "?"}`, ResultsComponent: TestsResults },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function patchRowToResponse(p: PatchRow): PatchResponse {
  return {
    patchId: p.id,
    branch: p.branch,
    repo: p.repo,
    filesTouched: p.files_touched,
    summary: p.summary,
    diff: p.diff ?? "",
    buildStatus: (p.build_status as PatchResponse["buildStatus"]) ?? undefined,
    buildLog: p.build_log ?? undefined,
    prUrl: p.pr_url ?? null,
    prNumber: p.pr_number ?? null,
    prWarning: p.pr_warning ?? null,
  };
}

// ─── Sidebar icons ────────────────────────────────────────────────────────────

function IconGrid() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <rect x="1" y="1" width="12" height="12" rx="2"/>
      <line x1="1" y1="5.5" x2="13" y2="5.5"/>
      <line x1="5" y1="5.5" x2="5" y2="13"/>
    </svg>
  );
}
function IconPlus() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <rect x="1" y="1" width="12" height="12" rx="2"/>
      <line x1="7" y1="4.5" x2="7" y2="9.5"/>
      <line x1="4.5" y1="7" x2="9.5" y2="7"/>
    </svg>
  );
}
function IconCheck() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="5.5"/>
      <polyline points="4.5,7 6.5,9 9.5,5"/>
    </svg>
  );
}
function IconGlobe() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="7" cy="7" r="5.5"/>
      <path d="M7 1.5c-1.5 2-2 3.5-2 5.5s.5 3.5 2 5.5M7 1.5c1.5 2 2 3.5 2 5.5s-.5 3.5-2 5.5" strokeWidth="1"/>
      <line x1="1.5" y1="7" x2="12.5" y2="7"/>
    </svg>
  );
}
function IconPR() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="3.5" cy="3.5" r="1.5"/>
      <circle cx="3.5" cy="10.5" r="1.5"/>
      <circle cx="10.5" cy="6.5" r="1.5"/>
      <line x1="3.5" y1="5" x2="3.5" y2="9"/>
      <path d="M5 3.5h2.5a1.5 1.5 0 011.5 1.5V7"/>
    </svg>
  );
}
function IconClock() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="7" cy="7" r="5.5"/>
      <polyline points="7,4 7,7 9,8.5"/>
    </svg>
  );
}
function IconList() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <line x1="3" y1="4" x2="11" y2="4"/>
      <line x1="3" y1="7" x2="11" y2="7"/>
      <line x1="3" y1="10" x2="8" y2="10"/>
    </svg>
  );
}
function IconFlow() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="1.5" width="4" height="3" rx="1"/>
      <rect x="9" y="5.5" width="4" height="3" rx="1"/>
      <rect x="1" y="9.5" width="4" height="3" rx="1"/>
      <path d="M5 3H7.5a1 1 0 011 1v2.5M5 11h2.5a1 1 0 001-1V8"/>
    </svg>
  );
}
function IconBolt() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="8.5,1.5 4.5,7 7,7 5.5,12.5 9.5,6.5 7,6.5"/>
    </svg>
  );
}
function IconGrid4() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <rect x="1.5" y="1.5" width="4" height="4" rx="1"/>
      <rect x="8.5" y="1.5" width="4" height="4" rx="1"/>
      <rect x="1.5" y="8.5" width="4" height="4" rx="1"/>
      <rect x="8.5" y="8.5" width="4" height="4" rx="1"/>
    </svg>
  );
}

function IconDoc() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 1.5h6l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1v-10a1 1 0 011-1z"/>
      <path d="M9 1.5v3h3"/>
      <line x1="4.5" y1="7.5" x2="9.5" y2="7.5"/>
      <line x1="4.5" y1="10" x2="8" y2="10"/>
    </svg>
  );
}

function IconPlug() {
  return (
    <svg className="sidebar-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 1v3M9 1v3"/>
      <path d="M3 4h8v3a4 4 0 01-8 0V4z"/>
      <line x1="7" y1="10" x2="7" y2="13"/>
    </svg>
  );
}

function skillIcon(id: string) {
  if (id === "props")        return <IconPlus />;
  if (id === "tests")        return <IconCheck />;
  if (id === "translations") return <IconGlobe />;
  if (id === "review")       return <IconPR />;
  if (id === "integration")  return <IconPlug />;
  return <IconGrid />;
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mobile" | "web">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showPaymentMethods, setShowPaymentMethods] = useState(false);
  const [verifying, setVerifying] = useState<Set<number>>(new Set());
  const [patching, setPatching] = useState<Set<number>>(new Set());
  const [patchedGaps, setPatchedGaps] = useState<Set<number>>(new Set());
  const [patchBuildStatus, setPatchBuildStatus] = useState<Map<number, "pass" | "fail" | "skipped">>(new Map());
  const [patchData, setPatchData] = useState<Map<number, PatchResponse>>(new Map());
  const [activePatch, setActivePatch] = useState<{ patch: PatchResponse; gapName: string } | null>(null);
  const [activeAgent, setActiveAgent] = useState<ActiveAgent>(null);
  const [activeSourceGap, setActiveSourceGap] = useState<Gap | null>(null);
  const [activePreview, setActivePreview] = useState<{
    repoKey: "web" | "mobile";
    branch: string;
    prUrl?: string | null;
    prWarning?: string | null;
    patchId?: number | null;
    gapName?: string;
  } | null>(null);
  const [verifyAllProgress, setVerifyAllProgress] = useState<{
    current: number;
    total: number;
    currentName: string;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<string>("gaps");
  const [skillResults, setSkillResults] = useState<Map<string, SkillEnvelopeClient>>(new Map());
  const [gapPrs, setGapPrs] = useState<Map<string, GapPrRow[]>>(new Map());
  const [seedResetting, setSeedResetting] = useState(false);
  const verifyAllAbort = useRef(false);
  const pollTimer = useRef<number | null>(null);

  // ─── Data loading ──────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const latest = await api.latestReport();
      setReport(latest);
      if (latest && latest.status === "done") {
        const [list, patches, prRows] = await Promise.all([
          api.gaps(latest.id),
          api.listPatches(),
          api.listGapPrs(),
        ]);

        const prMap = new Map<string, GapPrRow[]>();
        for (const pr of prRows) {
          const key = `${pr.canonical_name}:${pr.category}:${pr.missing_in}`;
          const arr = prMap.get(key) ?? [];
          arr.push(pr);
          prMap.set(key, arr);
        }
        setGapPrs(prMap);
        setGaps(list);

        const patchedIds = new Set<number>();
        const buildMap = new Map<number, "pass" | "fail" | "skipped">();
        const dataMap = new Map<number, PatchResponse>();

        for (const p of patches) {
          const matchingGap = list.find(
            (g) => g.canonical_name === p.canonical_name && g.category === p.category && g.missing_in === p.missing_in,
          );
          const gapId = matchingGap?.id ?? p.gap_id;
          if (matchingGap) {
            patchedIds.add(gapId);
            if (p.build_status) buildMap.set(gapId, p.build_status as "pass" | "fail" | "skipped");
            dataMap.set(gapId, { ...patchRowToResponse(p), _patchId: p.id } as PatchResponse & { _patchId: number });
          }
        }
        setPatchedGaps(patchedIds);
        setPatchBuildStatus(buildMap);
        setPatchData(dataMap);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (report?.status === "running") {
      pollTimer.current = window.setInterval(refresh, 2000);
      return () => { if (pollTimer.current) window.clearInterval(pollTimer.current); };
    }
  }, [report?.status, refresh]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const onRun = async () => {
    try {
      await api.runAnalysis();
      setReport((r) =>
        r ? { ...r, status: "running" }
          : { id: 0, created_at: new Date().toISOString(), web_sha: "", mobile_sha: "", status: "running", error: null },
      );
      refresh();
    } catch (e) { setError((e as Error).message); }
  };

  const onSeedReset = async () => {
    if (!window.confirm("Reset analysis data to seed? Patches will be preserved.")) return;
    setSeedResetting(true);
    try { await api.seedReset(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setSeedResetting(false); }
  };

  const onVerifyGap = async (id: number) => {
    setVerifying((prev) => { const s = new Set(prev); s.add(id); return s; });
    try {
      const result = await api.validateGap(id);
      if (result.removed) setGaps((prev) => prev.filter((g) => g.id !== id));
      else setGaps((prev) => prev.map((g) => (g.id === id ? result.gap : g)));
    } catch (e) { setError((e as Error).message); }
    finally { setVerifying((prev) => { const s = new Set(prev); s.delete(id); return s; }); }
  };

  const onPatchGap = (id: number) => {
    const gap = gaps.find((g) => g.id === id);
    if (!gap) return;
    if (patchedGaps.has(id)) {
      const existing = patchData.get(id);
      const patchId = (existing as (PatchResponse & { _patchId?: number }) | undefined)?._patchId;
      setActiveAgent({ gapId: id, gapName: gap.canonical_name, mode: "chat", existingPatchId: patchId });
      return;
    }
    setActiveAgent({ gapId: id, gapName: gap.canonical_name, mode: "patch" });
    setPatching((prev) => { const s = new Set(prev); s.add(id); return s; });
  };

  const onVerifyAll = async () => {
    const unverified = gaps.filter((g) => g.verified === 0 && g.platform_specific === 0);
    if (unverified.length === 0) return;
    verifyAllAbort.current = false;
    setVerifyAllProgress({ current: 0, total: unverified.length, currentName: "" });

    for (let i = 0; i < unverified.length; i++) {
      if (verifyAllAbort.current) break;
      const g = unverified[i];
      setVerifyAllProgress({ current: i + 1, total: unverified.length, currentName: g.canonical_name });
      setVerifying((prev) => { const s = new Set(prev); s.add(g.id); return s; });
      try {
        const result = await api.validateGap(g.id);
        if (result.removed) setGaps((prev) => prev.filter((x) => x.id !== g.id));
        else setGaps((prev) => prev.map((x) => (x.id === g.id ? result.gap : x)));
      } catch (e) { setError((e as Error).message); break; }
      finally { setVerifying((prev) => { const s = new Set(prev); s.delete(g.id); return s; }); }
    }
    setVerifyAllProgress(null);
  };

  const onAddPr = async (gapId: number, prUrl: string) => {
    const newRow = await api.addGapPr(gapId, prUrl);
    const key = `${newRow.canonical_name}:${newRow.category}:${newRow.missing_in}`;
    setGapPrs((prev) => {
      const next = new Map(prev);
      next.set(key, [...(next.get(key) ?? []), newRow]);
      return next;
    });
  };

  const onRemovePr = async (prId: number) => {
    await api.removeGapPr(prId);
    setGapPrs((prev) => {
      const next = new Map(prev);
      for (const [key, prs] of next) {
        const filtered = prs.filter((p) => p.id !== prId);
        if (filtered.length !== prs.length) { next.set(key, filtered); break; }
      }
      return next;
    });
  };

  // ─── Derived state ─────────────────────────────────────────────────────────

  const status: "idle" | "running" | "done" | "failed" = report ? report.status : "idle";

  const categoryFilteredGaps = gaps.filter((g) => showPaymentMethods || g.category !== "payment_method");
  const sideFilteredGaps = categoryFilteredGaps.filter((g) => filter === "all" ? true : g.missing_in === filter);
  const visibleGaps = sideFilteredGaps.filter((g) => {
    switch (statusFilter) {
      case "verified":          return g.verified === 1;
      case "unverified":        return g.verified === 0 && g.platform_specific === 0;
      case "platform_specific": return g.platform_specific === 1;
      case "patched":           return patchedGaps.has(g.id);
      default:                  return true;
    }
  });

  const counts = {
    total:               categoryFilteredGaps.length,
    mobile:              categoryFilteredGaps.filter((g) => g.missing_in === "mobile").length,
    web:                 categoryFilteredGaps.filter((g) => g.missing_in === "web").length,
    verified:            gaps.filter((g) => g.verified === 1).length,
    unverified:          gaps.filter((g) => g.verified === 0 && g.platform_specific === 0).length,
    platformSpecific:    gaps.filter((g) => g.platform_specific === 1).length,
    patched:             patchedGaps.size,
    hiddenPaymentMethods:gaps.filter((g) => g.category === "payment_method").length,
  };

  const activeTabLabel =
    activeTab === "gaps"             ? "Gap Analysis"
    : activeTab === "review-history" ? "Review History"
    : activeTab === "skill-history"  ? "Skill History"
    : SKILLS_REGISTRY.find((s) => s.id === activeTab)?.name ?? activeTab;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="shell">

      {/* ══════════════════════════ TOPBAR ══════════════════════════════════ */}
      <header className="topbar">
        <div className="topbar-logo">S</div>
        <span className="topbar-title">SDK Agent</span>
        <div className="topbar-divider" />
        <span className="topbar-crumb">{activeTabLabel}</span>
        <div className="topbar-spacer" />
        <div className="topbar-status">
          <div className={`status-dot ${status}`} title={status} />
          {status === "done" && report && (
            <span className="topbar-sha">
              web {report.web_sha.slice(0, 7)} · mob {report.mobile_sha.slice(0, 7)}
            </span>
          )}
          {status === "running" && <span className="topbar-sha">Running…</span>}
        </div>
        <div className="topbar-actions">
          {status === "running" && (
            <button className="btn btn-red btn-sm" onClick={async () => { await api.cancelAnalysis(); refresh(); }}>
              Cancel
            </button>
          )}
          <button
            className={`btn btn-sm ${status !== "running" ? "btn-accent" : ""}`}
            disabled={status === "running"}
            onClick={onRun}
          >
            {status === "running" ? "Running…" : "Run analysis"}
          </button>
        </div>
        {error && (
          <div style={{
            position: "fixed", top: 48, left: 220, right: 0,
            padding: "6px 20px", background: "var(--red-dim)",
            borderBottom: "1px solid rgba(248,113,113,.2)",
            fontSize: 12, color: "var(--red)", zIndex: 100,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            {error}
            <button
              onClick={() => setError(null)}
              style={{ marginLeft: "auto", background: "none", border: "none", color: "inherit", cursor: "pointer", opacity: 0.6, fontSize: 14 }}
            >
              ✕
            </button>
          </div>
        )}
      </header>

      {/* ══════════════════════════ WORKSPACE ═══════════════════════════════ */}
      <div className="workspace">

        {/* ── Left sidebar ─────────────────────────────────────────────── */}
        <nav className="sidebar">

          <div className="sidebar-section-label">Analyze</div>
          <div className={`sidebar-item ${activeTab === "gaps" ? "active" : ""}`} onClick={() => setActiveTab("gaps")}>
            <IconGrid />
            <span className="sidebar-item-label">Gap Analysis</span>
            {counts.total > 0 && <span className="sidebar-badge">{counts.total}</span>}
          </div>

          <div className="sidebar-section-label">Agents</div>
          {SKILLS_REGISTRY.map((skill) => (
            <div
              key={skill.id}
              className={`sidebar-item ${activeTab === skill.id ? "active" : ""}`}
              onClick={() => setActiveTab(skill.id)}
            >
              {skillIcon(skill.id)}
              <span className="sidebar-item-label">{skill.name}</span>
            </div>
          ))}
          <div
            className={`sidebar-item ${activeTab === "feature-agent" ? "active" : ""}`}
            onClick={() => setActiveTab("feature-agent")}
          >
            <IconBolt />
            <span className="sidebar-item-label">Feature Agent</span>
          </div>

          <div className="sidebar-section-label">History</div>
          <div className={`sidebar-item ${activeTab === "review-history" ? "active" : ""}`} onClick={() => setActiveTab("review-history")}>
            <IconClock />
            <span className="sidebar-item-label">Review History</span>
          </div>
          <div className={`sidebar-item ${activeTab === "skill-history" ? "active" : ""}`} onClick={() => setActiveTab("skill-history")}>
            <IconList />
            <span className="sidebar-item-label">Skill History</span>
          </div>

          <div className="sidebar-section-label">Knowledge</div>
          <div
            className={`sidebar-item ${activeTab === "docs" ? "active" : ""}`}
            onClick={() => setActiveTab("docs")}
          >
            <IconDoc />
            <span className="sidebar-item-label">Documentation</span>
          </div>

          <div className="sidebar-section-label">Insights</div>
          <div
            className={`sidebar-item ${activeTab === "achievements" ? "active" : ""}`}
            onClick={() => setActiveTab("achievements")}
          >
            <IconGrid4 />
            <span className="sidebar-item-label">Achievements</span>
          </div>

          <div className="sidebar-section-label">Coming soon</div>
          <div className="sidebar-item soon">
            <IconFlow />
            <span className="sidebar-item-label">Workflows</span>
            <span className="sidebar-badge">soon</span>
          </div>
          <div className="sidebar-item soon">
            <IconBolt />
            <span className="sidebar-item-label">Triggers</span>
            <span className="sidebar-badge">soon</span>
          </div>

        </nav>

        {/* ── Main content ─────────────────────────────────────────────── */}
        <div className="main">

          {/* Page header — Gap Analysis */}
          {activeTab === "gaps" && (
            <div className="page-header">
              <div className="page-header-row">
                <div>
                  <div className="page-title">Gap Analysis</div>
                  <div className="page-subtitle">
                    hyperswitch-web ↔ hyperswitch-client-core
                    {report?.status === "done" && ` · ${counts.total} gap${counts.total !== 1 ? "s" : ""}`}
                  </div>
                </div>
                {report?.status === "done" && (
                  <div className="page-header-actions">
                    <button
                      className="btn btn-sm btn-green"
                      disabled={verifyAllProgress !== null || counts.unverified === 0}
                      onClick={onVerifyAll}
                    >
                      {verifyAllProgress
                        ? `Verifying ${verifyAllProgress.current}/${verifyAllProgress.total}…`
                        : `Verify all (${counts.unverified})`}
                    </button>
                    <button className="btn btn-sm" disabled={seedResetting} onClick={onSeedReset} title="Reset to seed data">
                      {seedResetting ? "Resetting…" : "↺ Seed"}
                    </button>
                  </div>
                )}
              </div>

              {report?.status === "done" && (
                <div className="filter-tabs">
                  <button
                    className={`filter-tab ${filter === "all" && statusFilter === "all" ? "active" : ""}`}
                    onClick={() => { setFilter("all"); setStatusFilter("all"); }}
                  >
                    All <span className="filter-tab-count">{counts.total}</span>
                  </button>
                  <button
                    className={`filter-tab ${filter === "mobile" ? "active" : ""}`}
                    onClick={() => { setFilter("mobile"); setStatusFilter("all"); }}
                  >
                    Mobile <span className="filter-tab-count">{counts.mobile}</span>
                  </button>
                  <button
                    className={`filter-tab ${filter === "web" ? "active" : ""}`}
                    onClick={() => { setFilter("web"); setStatusFilter("all"); }}
                  >
                    Web <span className="filter-tab-count">{counts.web}</span>
                  </button>
                  <div className="filter-tab-sep" />
                  <button
                    className={`filter-tab ${statusFilter === "verified" ? "active" : ""}`}
                    onClick={() => { setFilter("all"); setStatusFilter(statusFilter === "verified" ? "all" : "verified"); }}
                  >
                    Verified <span className="filter-tab-count">{counts.verified}</span>
                  </button>
                  <button
                    className={`filter-tab ${statusFilter === "unverified" ? "active" : ""}`}
                    onClick={() => { setFilter("all"); setStatusFilter(statusFilter === "unverified" ? "all" : "unverified"); }}
                  >
                    Unverified <span className="filter-tab-count">{counts.unverified}</span>
                  </button>
                  <button
                    className={`filter-tab ${statusFilter === "platform_specific" ? "active" : ""}`}
                    onClick={() => { setFilter("all"); setStatusFilter(statusFilter === "platform_specific" ? "all" : "platform_specific"); }}
                  >
                    Platform-specific <span className="filter-tab-count">{counts.platformSpecific}</span>
                  </button>
                  <button
                    className={`filter-tab ${statusFilter === "patched" ? "active" : ""}`}
                    onClick={() => { setFilter("all"); setStatusFilter(statusFilter === "patched" ? "all" : "patched"); }}
                  >
                    Patched <span className="filter-tab-count">{counts.patched}</span>
                  </button>
                  {counts.hiddenPaymentMethods > 0 && (
                    <>
                      <div className="filter-tab-sep" />
                      <button
                        className={`filter-tab ${showPaymentMethods ? "active" : ""}`}
                        onClick={() => setShowPaymentMethods((v) => !v)}
                      >
                        Payments <span className="filter-tab-count">{counts.hiddenPaymentMethods}</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Page header — Skill */}
          {SKILLS_REGISTRY.find((s) => s.id === activeTab) && (() => {
            const skill = SKILLS_REGISTRY.find((s) => s.id === activeTab)!;
            return (
              <div className="page-header">
                <div className="page-header-row" style={{ marginBottom: 16 }}>
                  <div>
                    <div className="page-title">{skill.name}</div>
                    <div className="page-subtitle">{skill.description}</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Page header — History */}
          {(activeTab === "review-history" || activeTab === "skill-history") && (
            <div className="page-header">
              <div className="page-header-row" style={{ marginBottom: 16 }}>
                <div>
                  <div className="page-title">
                    {activeTab === "review-history" ? "Review History" : "Skill History"}
                  </div>
                  <div className="page-subtitle">
                    {activeTab === "review-history" ? "All past PR reviews." : "All past agent skill runs."}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Page header — Feature Agent */}
          {activeTab === "feature-agent" && (
            <div className="page-header">
              <div className="page-header-row" style={{ marginBottom: 16 }}>
                <div>
                  <div className="page-title">Feature Agent</div>
                  <div className="page-subtitle">Build new features interactively across both SDKs.</div>
                </div>
              </div>
            </div>
          )}

          {/* Page header — Documentation */}
          {activeTab === "docs" && (
            <div className="page-header">
              <div className="page-header-row" style={{ marginBottom: 16 }}>
                <div>
                  <div className="page-title">Documentation</div>
                  <div className="page-subtitle">Auto-generated docs for all agent actions.</div>
                </div>
              </div>
            </div>
          )}

          {/* Page header — Achievements */}
          {activeTab === "achievements" && (
            <div className="page-header">
              <div className="page-header-row" style={{ marginBottom: 16 }}>
                <div>
                  <div className="page-title">Achievements</div>
                  <div className="page-subtitle">Everything accomplished via the dashboard.</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Page body ─────────────────────────────────────────────── */}
          <div className="page-body">

            {/* Skill views */}
            {SKILLS_REGISTRY.map((skill) => {
              if (activeTab !== skill.id) return null;
              const { FormComponent, ResultsComponent } = skill;
              const skillResult = skillResults.get(skill.id);
              return (
                <div key={skill.id} style={{ padding: 24 }}>
                  <FormComponent
                    onResult={(r) => setSkillResults((prev) => new Map(prev).set(skill.id, r))}
                    onError={(msg) => setError(msg)}
                  />
                  {skillResult && (
                    <ResultsComponent
                      result={skillResult}
                      onClose={() => setSkillResults((prev) => { const m = new Map(prev); m.delete(skill.id); return m; })}
                    />
                  )}
                </div>
              );
            })}

            {/* Review history */}
            {activeTab === "review-history" && (
              <div style={{ padding: 24 }}>
                <ReviewHistory />
              </div>
            )}

            {/* Skill history */}
            {activeTab === "skill-history" && (
              <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
                {Object.entries(SKILL_HISTORY_CONFIG).map(([id, cfg]) => (
                  <SkillHistory
                    key={id}
                    skillId={id}
                    skillName={cfg.name}
                    formatLabel={cfg.formatLabel}
                    ResultsComponent={cfg.ResultsComponent}
                  />
                ))}
              </div>
            )}

            {/* Feature Agent */}
            {activeTab === "feature-agent" && <FeatureAgent />}

            {/* Documentation */}
            {activeTab === "docs" && <DocsPage />}

            {/* Achievements */}
            {activeTab === "achievements" && <AchievementsPage />}

            {/* ── Gaps view ─────────────────────────────────────────── */}
            {activeTab === "gaps" && (
              <>
                {/* Verify-all progress banner */}
                {verifyAllProgress && (
                  <div className="verify-progress-bar" style={{ margin: "12px 24px 0" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--accent)" }}>
                        Verifying {verifyAllProgress.current}/{verifyAllProgress.total}
                        <span className="mono" style={{ fontSize: 10, color: "var(--text3)", marginLeft: 8 }}>
                          {verifyAllProgress.currentName}
                        </span>
                      </span>
                      <button className="btn btn-red btn-sm" onClick={() => { verifyAllAbort.current = true; }}>
                        Stop
                      </button>
                    </div>
                    <div className="progress-bar-track">
                      <div
                        className="progress-bar-fill fill-green"
                        style={{ width: `${(verifyAllProgress.current / verifyAllProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Running */}
                {status === "running" && (
                  <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <circle cx="20" cy="20" r="14" strokeDasharray="7 5" opacity="0.35"/>
                      <path d="M20 9v4M20 27v4M9 20h4M27 20h4" opacity="0.5"/>
                    </svg>
                    <div className="empty-state-title">Analysing repos…</div>
                    <div className="empty-state-sub">
                      Cloning and extracting features — takes ~1 minute. Cached runs are instant.
                    </div>
                  </div>
                )}

                {/* Failed */}
                {status === "failed" && report?.error && (
                  <div style={{ margin: 24, padding: 20, border: "1px solid rgba(248,113,113,.2)", borderRadius: 8, background: "var(--red-dim)", color: "var(--red)" }}>
                    <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Analysis failed</div>
                    <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", margin: 0, opacity: 0.85 }}>{report.error}</pre>
                  </div>
                )}

                {/* Done — gap table */}
                {report?.status === "done" && (
                  <>
                    {!showPaymentMethods && counts.hiddenPaymentMethods > 0 && (
                      <div style={{ margin: "10px 24px 0", padding: "5px 12px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 11, color: "var(--text3)" }}>
                        {counts.hiddenPaymentMethods} payment-method gap{counts.hiddenPaymentMethods !== 1 ? "s" : ""} hidden — mobile SDK loads payment methods dynamically.
                      </div>
                    )}
                    <div style={{ padding: "12px 24px 24px" }}>
                      <GapTable
                        gaps={visibleGaps}
                        verifying={verifying}
                        patching={patching}
                        patchedGaps={patchedGaps}
                        patchBuildStatus={patchBuildStatus}
                        patchBranches={new Map(Array.from(patchData.entries()).map(([id, p]) => [id, p.branch]))}
                        gapPrs={gapPrs}
                        onVerify={onVerifyGap}
                        onPatch={onPatchGap}
                        onViewSource={(g) => setActiveSourceGap(g)}
                        onAddPr={onAddPr}
                        onRemovePr={onRemovePr}
                        onOpenPreview={(repoKey, branch, gapId) => {
                          const p = gapId != null ? patchData.get(gapId) : undefined;
                          const gap = gaps.find((g) => g.id === gapId);
                          setActivePreview({
                            repoKey, branch,
                            prUrl: p?.prUrl ?? null,
                            prWarning: p?.prWarning ?? null,
                            patchId: p?.patchId ?? null,
                            gapName: gap?.canonical_name,
                          });
                        }}
                      />
                    </div>
                  </>
                )}

                {/* Idle */}
                {status === "idle" && (
                  <div className="empty-state">
                    <svg className="empty-state-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <rect x="6" y="6" width="28" height="28" rx="5"/>
                      <line x1="6" y1="15" x2="34" y2="15"/>
                      <line x1="16" y1="15" x2="16" y2="34"/>
                    </svg>
                    <div className="empty-state-title">No analysis yet</div>
                    <div className="empty-state-sub">
                      Compare hyperswitch-web and hyperswitch-client-core to find feature gaps.
                    </div>
                    <button className="btn btn-accent" onClick={onRun} style={{ marginTop: 8 }}>
                      Run gap analysis
                    </button>
                  </div>
                )}
              </>
            )}

          </div>{/* end page-body */}
        </div>{/* end main */}
      </div>{/* end workspace */}

      {/* ══════════════════════════ OVERLAYS ════════════════════════════════ */}

      {activePatch && (
        <DiffViewer
          patch={activePatch.patch}
          gapName={activePatch.gapName}
          onClose={() => setActivePatch(null)}
        />
      )}

      {activeAgent && (
        <AgentPanel
          gapId={activeAgent.gapId}
          gapName={activeAgent.gapName}
          mode={activeAgent.mode}
          existingPatchId={activeAgent.existingPatchId}
          onClose={() => {
            if (activeAgent.mode === "patch") {
              setPatching((prev) => { const s = new Set(prev); s.delete(activeAgent.gapId); return s; });
            }
            setActiveAgent(null);
          }}
          onPatchSuccess={(patch: PatchDoneChunk) => {
            const id = activeAgent.gapId;
            const patchResp: PatchResponse = {
              patchId: patch.patchId,
              branch: patch.branch,
              repo: patch.repo,
              filesTouched: patch.filesTouched,
              summary: patch.summary,
              diff: patch.diff,
              buildStatus: "pass",
              buildLog: patch.buildLog,
              prUrl: patch.prUrl ?? null,
              prNumber: patch.prNumber ?? null,
              prWarning: patch.prWarning ?? null,
            };
            setPatchedGaps((prev) => { const s = new Set(prev); s.add(id); return s; });
            setPatchBuildStatus((prev) => { const m = new Map(prev); m.set(id, "pass"); return m; });
            setPatchData((prev) => { const m = new Map(prev); m.set(id, patchResp); return m; });
            setPatching((prev) => { const s = new Set(prev); s.delete(id); return s; });
            setActiveAgent((prev) => prev ? { ...prev, mode: "chat", existingPatchId: patch.patchId } : null);
            refresh();
          }}
        />
      )}

      {activePreview && (
        <PreviewDrawer
          repoKey={activePreview.repoKey}
          branch={activePreview.branch}
          prUrl={activePreview.prUrl}
          prWarning={activePreview.prWarning}
          patchId={activePreview.patchId}
          gapName={activePreview.gapName}
          onClose={() => setActivePreview(null)}
        />
      )}

      {activeSourceGap && (
        <SourceViewer
          gap={activeSourceGap}
          patch={patchData.get(activeSourceGap.id) ?? null}
          onClose={() => setActiveSourceGap(null)}
        />
      )}

    </div>
  );
}
