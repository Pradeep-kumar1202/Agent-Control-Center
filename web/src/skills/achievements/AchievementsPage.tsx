import { useEffect, useState } from "react";
import { api } from "../../api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillBreakdownEntry {
  total: number;
  ok: number;
  partial: number;
  error: number;
}

interface AchievementsSummary {
  totalPatches: number;
  patchesPassed: number;
  patchesFailed: number;
  buildSuccessRate: number;
  totalPRs: number;
  totalSkillRuns: number;
  skillBreakdown: Record<string, SkillBreakdownEntry>;
  totalReviews: number;
  reviewBreakdown: Record<string, number>;
  totalGapsFound: number;
  gapsVerified: number;
  gapsDismissed: number;
  gapsPatched: number;
  firstActivityDate: string | null;
  lastActivityDate: string | null;
}

interface TimelineEntry {
  date: string;
  patches: number;
  skills: number;
  reviews: number;
}

interface ActivityItem {
  type: "patch" | "skill" | "review";
  title: string;
  description: string;
  status: string;
  timestamp: string;
  meta: {
    prUrl?: string | null;
    branch?: string;
    repo?: string;
    skillId?: string;
  };
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

const SKILL_LABELS: Record<string, string> = {
  props: "Add Prop",
  tests: "Test Writer",
  translations: "Translator",
  review: "PR Review",
  integration: "Integration",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function AchievementsPage() {
  const [summary, setSummary] = useState<AchievementsSummary | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [recent, setRecent] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, t, r] = await Promise.all([
          api.getAchievementsSummary(),
          api.getAchievementsTimeline(),
          api.getRecentActivity(),
        ]);
        if (!cancelled) {
          setSummary(s);
          setTimeline(t);
          setRecent(r);
        }
      } catch (err) {
        console.error("Failed to load achievements:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Loading achievements...</div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No data available</div>
        <div className="empty-state-sub">Run some skills or generate patches to see achievements.</div>
      </div>
    );
  }

  const hasActivity =
    summary.totalPatches > 0 ||
    summary.totalSkillRuns > 0 ||
    summary.totalReviews > 0;

  if (!hasActivity) {
    return (
      <div className="empty-state">
        <svg className="empty-state-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <rect x="6" y="6" width="28" height="28" rx="5" />
          <path d="M14 20l4 4 8-8" />
        </svg>
        <div className="empty-state-title">No achievements yet</div>
        <div className="empty-state-sub">
          Generate patches, run skills, and review PRs to track your progress here.
        </div>
      </div>
    );
  }

  const timelineMax = Math.max(
    1,
    ...timeline.map((t) => t.patches + t.skills + t.reviews),
  );

  return (
    <div style={{ padding: "16px 24px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Summary Cards ───────────────────────────────────────────── */}
      <div className="ach-cards">
        <SummaryCard
          label="Patches"
          value={summary.totalPatches}
          color="var(--green)"
          sub={`${summary.patchesPassed} passed · ${summary.patchesFailed} failed`}
        />
        <SummaryCard
          label="PRs Created"
          value={summary.totalPRs}
          color="var(--accent)"
          sub="across patches & skills"
        />
        <SummaryCard
          label="Skills Run"
          value={summary.totalSkillRuns}
          color="var(--blue)"
          sub={Object.entries(summary.skillBreakdown)
            .map(([id, e]) => `${SKILL_LABELS[id] ?? id}: ${e.total}`)
            .join(" · ") || "none"}
        />
        <SummaryCard
          label="Reviews"
          value={summary.totalReviews}
          color="var(--accent)"
          sub={Object.entries(summary.reviewBreakdown)
            .map(([v, n]) => `${v}: ${n}`)
            .join(" · ") || "none"}
        />
        <SummaryCard
          label="Gaps Analyzed"
          value={summary.totalGapsFound}
          color="var(--amber)"
          sub={`${summary.gapsVerified} verified · ${summary.gapsDismissed} dismissed · ${summary.gapsPatched} patched`}
        />
        <SummaryCard
          label="Build Success"
          value={`${summary.buildSuccessRate}%`}
          color={summary.buildSuccessRate >= 80 ? "var(--green)" : summary.buildSuccessRate >= 50 ? "var(--amber)" : "var(--red)"}
          sub={`${summary.patchesPassed}/${summary.totalPatches} builds green`}
        />
      </div>

      {/* ── Activity Timeline ───────────────────────────────────────── */}
      <div className="ach-section">
        <div className="ach-section-label">Activity — Last 30 days</div>
        <div className="ach-timeline">
          {timeline.map((t) => {
            const total = t.patches + t.skills + t.reviews;
            const pct = (total / timelineMax) * 100;
            return (
              <div key={t.date} className="ach-timeline-bar" title={`${t.date}: ${total} action${total !== 1 ? "s" : ""}`}>
                <div className="ach-timeline-fill" style={{ height: `${Math.max(pct, total > 0 ? 4 : 0)}%` }}>
                  {t.reviews > 0 && (
                    <div style={{ flex: t.reviews, background: "var(--accent)", borderRadius: "1px 1px 0 0" }} />
                  )}
                  {t.skills > 0 && (
                    <div style={{ flex: t.skills, background: "var(--blue)" }} />
                  )}
                  {t.patches > 0 && (
                    <div style={{ flex: t.patches, background: "var(--green)", borderRadius: "0 0 1px 1px" }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="ach-timeline-legend">
          <span><span className="ach-legend-dot" style={{ background: "var(--green)" }} /> Patches</span>
          <span><span className="ach-legend-dot" style={{ background: "var(--blue)" }} /> Skills</span>
          <span><span className="ach-legend-dot" style={{ background: "var(--accent)" }} /> Reviews</span>
        </div>
      </div>

      {/* ── Bottom Row: Skill Breakdown + Recent Activity ───────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Skill Breakdown */}
        <div className="ach-section">
          <div className="ach-section-label">Skill Breakdown</div>
          {Object.entries(summary.skillBreakdown).length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text3)", padding: 12 }}>No skills run yet.</div>
          ) : (
            <table className="ach-breakdown-table">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Runs</th>
                  <th>Success</th>
                  <th style={{ width: "30%" }}>Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(summary.skillBreakdown).map(([id, entry]) => {
                  const rate = entry.total > 0 ? Math.round((entry.ok / entry.total) * 100) : 0;
                  return (
                    <tr key={id}>
                      <td style={{ fontWeight: 500, color: "var(--text)" }}>{SKILL_LABELS[id] ?? id}</td>
                      <td className="mono">{entry.total}</td>
                      <td>
                        <span style={{ color: "var(--green)", fontSize: 10 }}>{entry.ok}</span>
                        {entry.partial > 0 && <span style={{ color: "var(--amber)", fontSize: 10, marginLeft: 4 }}>{entry.partial}</span>}
                        {entry.error > 0 && <span style={{ color: "var(--red)", fontSize: 10, marginLeft: 4 }}>{entry.error}</span>}
                      </td>
                      <td>
                        <div className="progress-bar-track" style={{ height: 3 }}>
                          <div
                            className={`progress-bar-fill ${rate >= 80 ? "fill-green" : rate >= 50 ? "fill-amber" : "fill-red"}`}
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent Activity */}
        <div className="ach-section">
          <div className="ach-section-label">Recent Activity</div>
          {recent.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text3)", padding: 12 }}>No activity yet.</div>
          ) : (
            <div className="ach-activity-feed">
              {recent.map((item, i) => (
                <div key={i} className="ach-activity-item">
                  <ActivityIcon type={item.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="ach-activity-title">{item.title}</div>
                    <div className="ach-activity-desc">{item.description}</div>
                  </div>
                  <ActivityStatusBadge type={item.type} status={item.status} />
                  <div className="ach-activity-time">{timeAgo(item.timestamp)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SummaryCard({ label, value, color, sub }: {
  label: string;
  value: number | string;
  color: string;
  sub: string;
}) {
  return (
    <div className="ach-card">
      <div className="ach-card-label">{label}</div>
      <div className="ach-card-value mono" style={{ color }}>{value}</div>
      <div className="ach-card-sub">{sub}</div>
    </div>
  );
}

function ActivityIcon({ type }: { type: string }) {
  if (type === "patch") return <div className="ach-activity-icon" style={{ background: "var(--green-dim)", color: "var(--green)" }}>P</div>;
  if (type === "skill") return <div className="ach-activity-icon" style={{ background: "var(--blue-dim)", color: "var(--blue)" }}>S</div>;
  if (type === "review") return <div className="ach-activity-icon" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>R</div>;
  return <div className="ach-activity-icon">?</div>;
}

function ActivityStatusBadge({ type, status }: { type: string; status: string }) {
  let bg = "var(--bg4)";
  let color = "var(--text3)";
  if (type === "patch") {
    if (status === "pass") { bg = "var(--green-dim)"; color = "var(--green)"; }
    else if (status === "fail") { bg = "var(--red-dim)"; color = "var(--red)"; }
  } else if (type === "skill") {
    if (status === "ok") { bg = "var(--green-dim)"; color = "var(--green)"; }
    else if (status === "partial") { bg = "var(--amber-dim)"; color = "var(--amber)"; }
    else if (status === "error") { bg = "var(--red-dim)"; color = "var(--red)"; }
  } else if (type === "review") {
    if (status === "approve") { bg = "var(--green-dim)"; color = "var(--green)"; }
    else if (status === "request_changes") { bg = "var(--red-dim)"; color = "var(--red)"; }
    else if (status === "comment") { bg = "var(--amber-dim)"; color = "var(--amber)"; }
  }
  return (
    <span className="badge" style={{ background: bg, color, border: "none", fontSize: 9 }}>
      {status}
    </span>
  );
}
