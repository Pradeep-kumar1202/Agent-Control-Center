import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Gap, type GapPrRow, type PatchResponse, type PatchRow, type Report } from "./api";
import { DiffViewer } from "./components/DiffViewer";
import { GapTable } from "./components/GapTable";
import { PreviewDrawer } from "./components/PreviewDrawer";
import { RunButton } from "./components/RunButton";
import { SourceViewer } from "./components/SourceViewer";
import { SKILLS_REGISTRY, type SkillEnvelopeClient } from "./skills/registry";
import { ReviewHistory } from "./skills/review/History";
import { SkillHistory } from "./skills/shared/SkillHistory";
import { PropsResults } from "./skills/props/Results";
import { TestsResults } from "./skills/tests/Results";

const SKILL_HISTORY_CONFIG: Record<string, { name: string; formatLabel: (input: Record<string, unknown>) => string; ResultsComponent: React.ComponentType<{ result: SkillEnvelopeClient; onClose: () => void }> }> = {
  props: { name: "Add Prop", formatLabel: (i) => `Prop: ${i.propName ?? "?"}`, ResultsComponent: PropsResults },
  tests: { name: "Test Writer", formatLabel: (i) => `Tests for ${i.branch ?? "?"}`, ResultsComponent: TestsResults },
};

type StatusFilter = "all" | "verified" | "unverified" | "platform_specific" | "patched";

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
  const [activePatch, setActivePatch] = useState<{
    patch: PatchResponse;
    gapName: string;
  } | null>(null);
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
  /** Map from "canonical_name:category:missing_in" → linked PR rows */
  const [gapPrs, setGapPrs] = useState<Map<string, GapPrRow[]>>(new Map());
  const verifyAllAbort = useRef(false);
  const pollTimer = useRef<number | null>(null);

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

        // Build PR map keyed by identity triple (stable across re-runs)
        const prMap = new Map<string, GapPrRow[]>();
        for (const pr of prRows) {
          const key = `${pr.canonical_name}:${pr.category}:${pr.missing_in}`;
          const arr = prMap.get(key) ?? [];
          arr.push(pr);
          prMap.set(key, arr);
        }
        setGapPrs(prMap);
        setGaps(list);

        // Match patches to current gaps by (canonical_name, category, missing_in)
        // because gap IDs change across re-runs but these fields stay stable.
        const patchedIds = new Set<number>();
        const buildMap = new Map<number, "pass" | "fail" | "skipped">();
        const dataMap = new Map<number, PatchResponse>();

        for (const p of patches) {
          // Find the current gap that matches this patch's original gap identity
          const matchingGap = list.find(
            (g) =>
              g.canonical_name === p.canonical_name &&
              g.category === p.category &&
              g.missing_in === p.missing_in,
          );
          const gapId = matchingGap?.id ?? p.gap_id;

          // Only track if this gap exists in the current report
          if (matchingGap) {
            patchedIds.add(gapId);
            if (p.build_status) {
              buildMap.set(gapId, p.build_status as "pass" | "fail" | "skipped");
            }
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

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while a report is running.
  useEffect(() => {
    if (report?.status === "running") {
      pollTimer.current = window.setInterval(refresh, 2000);
      return () => {
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      };
    }
  }, [report?.status, refresh]);

  const onRun = async () => {
    try {
      await api.runAnalysis();
      // Optimistically flip to running so the UI starts polling immediately.
      setReport((r) =>
        r
          ? { ...r, status: "running" }
          : {
              id: 0,
              created_at: new Date().toISOString(),
              web_sha: "",
              mobile_sha: "",
              status: "running",
              error: null,
            },
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const status: "idle" | "running" | "done" | "failed" = report
    ? report.status
    : "idle";

  const onVerifyGap = async (id: number) => {
    setVerifying((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const result = await api.validateGap(id);
      if (result.removed) {
        // false positive — drop it from the list
        setGaps((prev) => prev.filter((g) => g.id !== id));
      } else {
        setGaps((prev) => prev.map((g) => (g.id === id ? result.gap : g)));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const onPatchGap = async (id: number) => {
    const gap = gaps.find((g) => g.id === id);
    if (!gap) return;

    // If already patched, open review instead of regenerating
    if (patchedGaps.has(id)) {
      onReviewPatch(id);
      return;
    }

    setPatching((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      const result = await api.generatePatch(id);
      setPatchedGaps((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      if (result.buildStatus) {
        setPatchBuildStatus((prev) => {
          const next = new Map(prev);
          next.set(id, result.buildStatus!);
          return next;
        });
      }
      setPatchData((prev) => {
        const next = new Map(prev);
        next.set(id, result);
        return next;
      });
      setActivePatch({ patch: result, gapName: gap.canonical_name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPatching((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const onReviewPatch = async (gapId: number) => {
    const gap = gaps.find((g) => g.id === gapId);
    if (!gap) return;

    // Check if we already have patch data with diff in memory
    const existing = patchData.get(gapId);
    if (existing && existing.diff) {
      setActivePatch({ patch: existing, gapName: gap.canonical_name });
      return;
    }

    // Need to fetch the full diff from server
    try {
      const patches = await api.listPatches();
      // Match by canonical_name since gap_id may differ across re-runs
      const row = patches.find(
        (p) =>
          p.canonical_name === gap.canonical_name &&
          p.category === gap.category &&
          p.missing_in === gap.missing_in,
      );
      if (row) {
        const fullRow = await api.getPatch(row.id);
        const patch = patchRowToResponse(fullRow);
        setPatchData((prev) => {
          const next = new Map(prev);
          next.set(gapId, patch);
          return next;
        });
        setActivePatch({ patch, gapName: gap.canonical_name });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onVerifyAll = async () => {
    const unverified = gaps.filter(
      (g) => g.verified === 0 && g.platform_specific === 0,
    );
    if (unverified.length === 0) return;

    verifyAllAbort.current = false;
    setVerifyAllProgress({ current: 0, total: unverified.length, currentName: "" });

    for (let i = 0; i < unverified.length; i++) {
      if (verifyAllAbort.current) break;
      const g = unverified[i];
      setVerifyAllProgress({ current: i + 1, total: unverified.length, currentName: g.canonical_name });
      setVerifying((prev) => {
        const next = new Set(prev);
        next.add(g.id);
        return next;
      });
      try {
        const result = await api.validateGap(g.id);
        if (result.removed) {
          setGaps((prev) => prev.filter((x) => x.id !== g.id));
        } else {
          setGaps((prev) => prev.map((x) => (x.id === g.id ? result.gap : x)));
        }
      } catch (e) {
        setError((e as Error).message);
        break;
      } finally {
        setVerifying((prev) => {
          const next = new Set(prev);
          next.delete(g.id);
          return next;
        });
      }
    }
    setVerifyAllProgress(null);
  };

  const onCancelVerifyAll = () => {
    verifyAllAbort.current = true;
  };

  const onAddPr = async (gapId: number, prUrl: string) => {
    const newRow = await api.addGapPr(gapId, prUrl);
    const key = `${newRow.canonical_name}:${newRow.category}:${newRow.missing_in}`;
    setGapPrs((prev) => {
      const next = new Map(prev);
      const arr = [...(next.get(key) ?? []), newRow];
      next.set(key, arr);
      return next;
    });
  };

  const onRemovePr = async (prId: number, _gapId: number) => {
    await api.removeGapPr(prId);
    setGapPrs((prev) => {
      const next = new Map(prev);
      for (const [key, prs] of next) {
        const filtered = prs.filter((p) => p.id !== prId);
        if (filtered.length !== prs.length) {
          next.set(key, filtered);
          break;
        }
      }
      return next;
    });
  };

  // Payment methods are loaded dynamically from backend responses in the
  // mobile SDK, so static extraction always flags them as missing even when
  // they aren't. Hide them by default; user can opt back in with the toggle.
  const categoryFilteredGaps = gaps.filter(
    (g) => showPaymentMethods || g.category !== "payment_method",
  );

  const sideFilteredGaps = categoryFilteredGaps.filter((g) =>
    filter === "all" ? true : g.missing_in === filter,
  );

  const visibleGaps = sideFilteredGaps.filter((g) => {
    switch (statusFilter) {
      case "verified":
        return g.verified === 1;
      case "unverified":
        return g.verified === 0 && g.platform_specific === 0;
      case "platform_specific":
        return g.platform_specific === 1;
      case "patched":
        return patchedGaps.has(g.id);
      default:
        return true;
    }
  });

  const counts = {
    total: categoryFilteredGaps.length,
    mobile: categoryFilteredGaps.filter((g) => g.missing_in === "mobile")
      .length,
    web: categoryFilteredGaps.filter((g) => g.missing_in === "web").length,
    hiddenPaymentMethods: gaps.filter((g) => g.category === "payment_method")
      .length,
  };

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Agent Orchestrator
        </h1>
        <p className="text-slate-400 mt-1">
          hyperswitch-web ↔ hyperswitch-client-core
        </p>
        <div className="flex gap-1 mt-4 border-b border-slate-800">
          <button
            onClick={() => setActiveTab("gaps")}
            className={
              "px-4 py-2 text-sm font-medium border-b-2 transition " +
              (activeTab === "gaps"
                ? "border-indigo-500 text-indigo-300"
                : "border-transparent text-slate-500 hover:text-slate-300")
            }
          >
            Gap Analysis
          </button>
          {SKILLS_REGISTRY.map((skill) => (
            <button
              key={skill.id}
              onClick={() => setActiveTab(skill.id)}
              className={
                "px-4 py-2 text-sm font-medium border-b-2 transition " +
                (activeTab === skill.id
                  ? skill.activeTabClass
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              {skill.name}
            </button>
          ))}
          <button
            onClick={() => setActiveTab("review-history")}
            className={
              "px-4 py-2 text-sm font-medium border-b-2 transition " +
              (activeTab === "review-history"
                ? "border-violet-400 text-violet-300"
                : "border-transparent text-slate-500 hover:text-slate-300")
            }
          >
            Review History
          </button>
          <button
            onClick={() => setActiveTab("skill-history")}
            className={
              "px-4 py-2 text-sm font-medium border-b-2 transition " +
              (activeTab === "skill-history"
                ? "border-teal-400 text-teal-300"
                : "border-transparent text-slate-500 hover:text-slate-300")
            }
          >
            Skill History
          </button>
        </div>
      </header>

      {SKILLS_REGISTRY.map((skill) => {
        if (activeTab !== skill.id) return null;
        const { FormComponent, ResultsComponent } = skill;
        const skillResult = skillResults.get(skill.id);
        return (
          <div key={skill.id}>
            <FormComponent
              onResult={(r) => setSkillResults((prev) => new Map(prev).set(skill.id, r))}
              onError={(msg) => setError(msg)}
            />
            {skillResult && (
              <ResultsComponent
                result={skillResult}
                onClose={() => {
                  // Keep the result in memory so re-opening the tab shows
                  // the last result. The data is also persisted in skill_runs
                  // DB table, so even on page refresh the History tab has it.
                  setSkillResults((prev) => {
                    const next = new Map(prev);
                    next.delete(skill.id);
                    return next;
                  });
                }}
              />
            )}
          </div>
        );
      })}

      {activeTab === "review-history" && (
        <div className="mt-2">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Review History</h2>
            <p className="text-slate-400 text-sm mt-0.5">
              All past PR reviews. Click any row to reopen the full analysis.
            </p>
          </div>
          <ReviewHistory />
        </div>
      )}

      {activeTab === "skill-history" && (
        <div className="mt-2 space-y-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Skill History</h2>
            <p className="text-slate-400 text-sm mt-0.5">
              All past skill runs. Click "View" to reopen the full results with diff, PR link, and branch.
            </p>
          </div>
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

      {activeTab === "gaps" && (<>
      <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-400">Status</div>
            <div className="text-lg font-medium">
              <StatusPill status={status} />
              {report?.status === "done" && (
                <span className="ml-3 text-sm text-slate-500 font-mono">
                  web {report.web_sha.slice(0, 8)} · mobile{" "}
                  {report.mobile_sha.slice(0, 8)}
                </span>
              )}
            </div>
            {error && (
              <div className="text-sm text-red-400 mt-1">{error}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {status === "running" && (
              <button
                onClick={async () => {
                  await api.cancelAnalysis();
                  refresh();
                }}
                className="rounded-lg border border-red-700 bg-red-950/40 hover:bg-red-900/40 text-red-300 px-4 py-2.5 text-sm font-medium"
              >
                Cancel
              </button>
            )}
            <RunButton status={status} onClick={onRun} />
          </div>
        </div>

        {report?.status === "done" && (
          <div className="grid grid-cols-3 gap-4 mt-6">
            <Stat label="Total gaps" value={counts.total} />
            <Stat label="Missing in mobile" value={counts.mobile} />
            <Stat label="Missing in web" value={counts.web} />
          </div>
        )}
        {report?.status === "done" && (
          <div className="grid grid-cols-4 gap-4 mt-4">
            <MiniStat label="Verified" value={gaps.filter((g) => g.verified === 1).length} total={gaps.length} color="emerald" active={statusFilter === "verified"} onClick={() => setStatusFilter(statusFilter === "verified" ? "all" : "verified")} />
            <MiniStat label="Unverified" value={gaps.filter((g) => g.verified === 0 && g.platform_specific === 0).length} total={gaps.length} color="slate" active={statusFilter === "unverified"} onClick={() => setStatusFilter(statusFilter === "unverified" ? "all" : "unverified")} />
            <MiniStat label="Platform-specific" value={gaps.filter((g) => g.platform_specific === 1).length} total={gaps.length} color="amber" active={statusFilter === "platform_specific"} onClick={() => setStatusFilter(statusFilter === "platform_specific" ? "all" : "platform_specific")} />
            <MiniStat label="Patched" value={patchedGaps.size} total={gaps.length} color="indigo" active={statusFilter === "patched"} onClick={() => setStatusFilter(statusFilter === "patched" ? "all" : "patched")} />
          </div>
        )}
      </section>

      {report?.status === "done" && (
        <>
          {/* Verify All progress bar */}
          {verifyAllProgress && (
            <div className="mb-3 rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-indigo-200">
                  Verifying {verifyAllProgress.current}/{verifyAllProgress.total}
                  <span className="text-indigo-400 ml-2 font-mono text-xs">
                    {verifyAllProgress.currentName}
                  </span>
                </span>
                <button
                  onClick={onCancelVerifyAll}
                  className="rounded border border-red-700 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/30"
                >
                  Stop
                </button>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${(verifyAllProgress.current / verifyAllProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FilterPill
                label="All"
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              <FilterPill
                label={`Missing in mobile (${counts.mobile})`}
                active={filter === "mobile"}
                onClick={() => setFilter("mobile")}
              />
              <FilterPill
                label={`Missing in web (${counts.web})`}
                active={filter === "web"}
                onClick={() => setFilter("web")}
              />
              <div className="w-px h-5 bg-slate-700 mx-1" />
              <button
                onClick={onVerifyAll}
                disabled={verifyAllProgress !== null || gaps.filter((g) => g.verified === 0 && g.platform_specific === 0).length === 0}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition " +
                  (verifyAllProgress !== null
                    ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300 cursor-wait"
                    : gaps.filter((g) => g.verified === 0 && g.platform_specific === 0).length === 0
                      ? "border-slate-800 text-slate-600 cursor-not-allowed"
                      : "border-emerald-700 text-emerald-300 hover:border-emerald-500 hover:bg-emerald-500/10")
                }
              >
                {verifyAllProgress
                  ? "Verifying…"
                  : `Verify All (${gaps.filter((g) => g.verified === 0 && g.platform_specific === 0).length})`}
              </button>
            </div>
            <FilterPill
              label={
                showPaymentMethods
                  ? `Hide payment methods (${counts.hiddenPaymentMethods})`
                  : `Show payment methods (${counts.hiddenPaymentMethods})`
              }
              active={showPaymentMethods}
              onClick={() => setShowPaymentMethods((v) => !v)}
            />
          </div>
          {!showPaymentMethods && counts.hiddenPaymentMethods > 0 && (
            <div className="mb-3 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-2 text-xs text-slate-500">
              {counts.hiddenPaymentMethods} payment-method gap
              {counts.hiddenPaymentMethods === 1 ? "" : "s"} hidden — the mobile
              SDK loads payment methods dynamically from backend, so static
              detection is unreliable here.
            </div>
          )}
          <GapTable
            gaps={visibleGaps}
            verifying={verifying}
            patching={patching}
            patchedGaps={patchedGaps}
            patchBuildStatus={patchBuildStatus}
            patchBranches={
              new Map(
                Array.from(patchData.entries()).map(([id, p]) => [id, p.branch]),
              )
            }
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
                repoKey,
                branch,
                prUrl: p?.prUrl ?? null,
                prWarning: p?.prWarning ?? null,
                patchId: p?.patchId ?? null,
                gapName: gap?.canonical_name,
              });
            }}
          />
        </>
      )}

      {activePatch && (
        <DiffViewer
          patch={activePatch.patch}
          gapName={activePatch.gapName}
          onClose={() => setActivePatch(null)}
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

      {status === "running" && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-8 text-center text-slate-500">
          Cloning repos and extracting features — this takes ~1 minute (cached runs are instant)…
        </div>
      )}

      {status === "failed" && report?.error && (
        <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-red-300">
          <div className="font-medium mb-2">Analysis failed</div>
          <pre className="text-xs whitespace-pre-wrap">{report.error}</pre>
        </div>
      )}
      </>)}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "done"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : status === "running"
        ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
        : status === "failed"
          ? "bg-red-500/10 text-red-300 border-red-500/30"
          : "bg-slate-500/10 text-slate-400 border-slate-500/30";
  return (
    <span
      className={
        "inline-block rounded border px-2 py-0.5 text-xs font-medium " + tone
      }
    >
      {status}
    </span>
  );
}

function MiniStat({
  label,
  value,
  total,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  total: number;
  color: "emerald" | "slate" | "amber" | "indigo";
  active?: boolean;
  onClick?: () => void;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const tones: Record<string, string> = {
    emerald: "text-emerald-300 bg-emerald-500",
    slate: "text-slate-400 bg-slate-500",
    amber: "text-amber-300 bg-amber-500",
    indigo: "text-indigo-300 bg-indigo-500",
  };
  const [textColor, barColor] = [
    tones[color].split(" ")[0],
    tones[color].split(" ")[1],
  ];
  const activeBorders: Record<string, string> = {
    emerald: "border-emerald-500 ring-1 ring-emerald-500/30",
    slate: "border-slate-500 ring-1 ring-slate-500/30",
    amber: "border-amber-500 ring-1 ring-amber-500/30",
    indigo: "border-indigo-500 ring-1 ring-indigo-500/30",
  };
  return (
    <button
      onClick={onClick}
      className={
        "rounded-lg border bg-slate-950 px-3 py-2 text-left transition cursor-pointer hover:bg-slate-900 " +
        (active ? activeBorders[color] : "border-slate-800")
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">{label}</span>
        <span className={`text-sm font-semibold ${textColor}`}>{value}</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </button>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-full border px-3 py-1 text-xs font-medium transition " +
        (active
          ? "border-indigo-500 bg-indigo-500/20 text-indigo-200"
          : "border-slate-700 text-slate-400 hover:border-slate-500")
      }
    >
      {label}
    </button>
  );
}
