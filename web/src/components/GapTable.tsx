import { useState } from "react";
import type { Gap, GapPrRow } from "../api";
import { PreviewButton } from "./PreviewButton";

interface Props {
  gaps: Gap[];
  verifying: Set<number>;
  patching: Set<number>;
  patchedGaps: Set<number>;
  patchBuildStatus: Map<number, "pass" | "fail" | "skipped">;
  /** Map from gap.id → branch name of the generated patch (if any) */
  patchBranches: Map<number, string>;
  /** Map from "canonical_name:category:missing_in" → linked PR rows */
  gapPrs: Map<string, GapPrRow[]>;
  onVerify: (id: number) => void;
  onPatch: (id: number) => void;
  onViewSource: (gap: Gap) => void;
  onAddPr: (gapId: number, prUrl: string) => Promise<void>;
  onRemovePr: (prId: number, gapId: number) => Promise<void>;
  onOpenPreview: (repoKey: "web" | "mobile", branch: string, gapId: number) => void;
}

const CATEGORY_LABEL: Record<Gap["category"], string> = {
  payment_method: "Payment method",
  config: "Config",
  component: "Component",
  backend_api: "Backend API",
};

function gapPrKey(g: Gap): string {
  return `${g.canonical_name}:${g.category}:${g.missing_in}`;
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
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-8 text-center text-slate-500">
        No gaps to show.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/30 overflow-x-auto">
      <table className="w-full text-sm min-w-[960px]">
        <thead className="bg-slate-900/80 text-slate-400 uppercase text-xs tracking-wider">
          <tr>
            <th className="text-left px-4 py-3">Category</th>
            <th className="text-left px-4 py-3">Feature</th>
            <th className="text-left px-4 py-3">Missing in</th>
            <th className="text-left px-4 py-3">Evidence</th>
            <th className="text-left px-4 py-3">Status</th>
            <th className="text-left px-4 py-3">Linked PRs</th>
            <th className="text-right px-4 py-3 min-w-[280px]">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {gaps.map((g) => {
            const isVerifying = verifying.has(g.id);
            const isPatching = patching.has(g.id);
            const hasPatched = patchedGaps.has(g.id);
            const prs = gapPrs.get(gapPrKey(g)) ?? [];
            return (
              <GapRow
                key={g.id}
                gap={g}
                isVerifying={isVerifying}
                isPatching={isPatching}
                hasPatched={hasPatched}
                buildStatus={patchBuildStatus.get(g.id)}
                patchBranch={patchBranches.get(g.id)}
                prs={prs}
                onVerify={onVerify}
                onPatch={onPatch}
                onViewSource={onViewSource}
                onAddPr={onAddPr}
                onRemovePr={onRemovePr}
                onOpenPreview={onOpenPreview}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Individual row ───────────────────────────────────────────────────────────

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
    if (!url) return;
    if (!url.startsWith("http")) {
      setPrError("Must be a valid URL");
      return;
    }
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
    try {
      await onRemovePr(prId, g.id);
    } finally {
      setRemovingPrId(null);
    }
  };

  return (
    <tr
      className={
        "hover:bg-slate-900/60 align-top " +
        (g.platform_specific ? "opacity-50" : "")
      }
    >
      <td className="px-4 py-3 text-slate-400">
        {CATEGORY_LABEL[g.category]}
      </td>
      <td className="px-4 py-3 font-mono text-slate-100">
        {g.canonical_name}
      </td>
      <td className="px-4 py-3">
        <MissingBadge side={g.missing_in} />
      </td>
      <td className="px-4 py-3 text-slate-400 font-mono text-xs">
        {g.evidence[0]?.file ?? "\u2014"}
      </td>
      <td className="px-4 py-3">
        <VerifiedBadge
          verified={g.verified === 1}
          platformSpecific={g.platform_specific === 1}
        />
      </td>

      {/* ── Linked PRs cell ── */}
      <td className="px-4 py-3">
        <div className="space-y-1">
          {prs.length > 0 && (
            <div className="space-y-1">
              {prs.map((pr) => (
                <div key={pr.id} className="flex items-center gap-1.5 group">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                  <a
                    href={pr.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-violet-300 hover:text-violet-100 hover:underline font-mono truncate max-w-[180px]"
                    title={pr.pr_url}
                  >
                    {prShortLabel(pr.pr_url)}
                  </a>
                  <button
                    onClick={() => removePr(pr.id)}
                    disabled={removingPrId === pr.id}
                    className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 text-xs transition"
                    title="Remove link"
                  >
                    {removingPrId === pr.id ? "…" : "×"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Link PR inline form */}
          {linkingPr ? (
            <div className="flex items-center gap-1 mt-1">
              <input
                autoFocus
                value={prInput}
                onChange={(e) => setPrInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPr();
                  if (e.key === "Escape") { setLinkingPr(false); setPrInput(""); setPrError(null); }
                }}
                placeholder="https://github.com/…/pull/…"
                className="rounded border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 w-44"
              />
              <button
                onClick={submitPr}
                disabled={addingPr || !prInput.trim()}
                className="rounded border border-violet-600 bg-violet-600/20 px-2 py-0.5 text-xs text-violet-300 hover:bg-violet-600/30 disabled:opacity-40 transition"
              >
                {addingPr ? "…" : "Add"}
              </button>
              <button
                onClick={() => { setLinkingPr(false); setPrInput(""); setPrError(null); }}
                className="text-xs text-slate-500 hover:text-slate-300 px-1"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setLinkingPr(true)}
              className="text-xs text-slate-500 hover:text-violet-400 transition mt-0.5"
              title="Link an open PR to this gap"
            >
              + Link PR
            </button>
          )}
          {prError && (
            <p className="text-xs text-red-400 mt-0.5">{prError}</p>
          )}
        </div>
      </td>

      {/* ── Actions cell ── */}
      <td className="px-4 py-3 text-right whitespace-nowrap">
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onViewSource(g)}
            className="rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition"
          >
            View
          </button>

          <button
            disabled={isVerifying || g.verified === 1}
            onClick={() => onVerify(g.id)}
            className={
              "rounded border px-3 py-1 text-xs font-medium transition " +
              (g.verified === 1
                ? "border-slate-800 text-slate-600 cursor-not-allowed"
                : isVerifying
                  ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300 cursor-wait"
                  : "border-slate-700 text-slate-300 hover:border-indigo-500 hover:text-indigo-300")
            }
          >
            {isVerifying ? "Checking\u2026" : g.verified === 1 ? "Verified" : "Verify"}
          </button>

          {hasPatched ? (
            <>
              <button
                onClick={() => onPatch(g.id)}
                className="rounded border border-emerald-700 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition"
              >
                Review{" "}
                {buildStatus === "pass" ? (
                  <span className="text-emerald-400 ml-1" title="Build passed">&#10003;</span>
                ) : buildStatus === "fail" ? (
                  <span className="text-red-400 ml-1" title="Build failed">&#10007;</span>
                ) : null}
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
              disabled={isPatching || g.platform_specific === 1}
              onClick={() => onPatch(g.id)}
              className={
                "rounded border px-3 py-1 text-xs font-medium transition " +
                (g.platform_specific === 1
                  ? "border-slate-800 text-slate-600 cursor-not-allowed"
                  : isPatching
                    ? "border-amber-500/50 bg-amber-500/10 text-amber-300 cursor-wait"
                    : "border-slate-700 text-slate-300 hover:border-amber-500 hover:text-amber-300")
              }
            >
              {isPatching ? "Generating\u2026" : "Generate Patch"}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a full GitHub PR URL into a compact label:
 *   https://github.com/juspay/hyperswitch-web/pull/423 → #423
 *   https://github.com/org/repo/pull/12                → #12
 *   anything else                                       → hostname/path tail
 */
function prShortLabel(url: string): string {
  try {
    const u = new URL(url);
    const prMatch = u.pathname.match(/\/pull\/(\d+)/);
    if (prMatch) {
      // "org/repo #123"
      const parts = u.pathname.split("/").filter(Boolean);
      const repo = parts[1] ?? parts[0] ?? "";
      return `${repo} #${prMatch[1]}`;
    }
    return u.pathname.split("/").slice(-2).join("/");
  } catch {
    return url.slice(0, 30);
  }
}

function MissingBadge({ side }: { side: "web" | "mobile" }) {
  const tone =
    side === "mobile"
      ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
      : "bg-sky-500/10 text-sky-300 border-sky-500/30";
  return (
    <span className={"inline-block rounded border px-2 py-0.5 text-xs font-medium " + tone}>
      {side}
    </span>
  );
}

function VerifiedBadge({
  verified,
  platformSpecific,
}: {
  verified: boolean;
  platformSpecific: boolean;
}) {
  if (platformSpecific) {
    return (
      <span className="inline-block rounded border px-2 py-0.5 text-xs font-medium bg-slate-500/10 text-slate-400 border-slate-500/30">
        platform-specific
      </span>
    );
  }
  if (verified) {
    return (
      <span className="inline-block rounded border px-2 py-0.5 text-xs font-medium bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
        verified
      </span>
    );
  }
  return (
    <span className="inline-block rounded border px-2 py-0.5 text-xs font-medium bg-slate-700/20 text-slate-500 border-slate-700">
      unverified
    </span>
  );
}
