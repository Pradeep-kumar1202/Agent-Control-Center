import type { Gap } from "../api";

interface Props {
  gaps: Gap[];
  verifying: Set<number>;
  patching: Set<number>;
  patchedGaps: Set<number>;
  patchBuildStatus: Map<number, "pass" | "fail" | "skipped">;
  onVerify: (id: number) => void;
  onPatch: (id: number) => void;
  onViewSource: (gap: Gap) => void;
}

const CATEGORY_LABEL: Record<Gap["category"], string> = {
  payment_method: "Payment method",
  config: "Config",
  component: "Component",
  backend_api: "Backend API",
};

export function GapTable({
  gaps,
  verifying,
  patching,
  patchedGaps,
  patchBuildStatus,
  onVerify,
  onPatch,
  onViewSource,
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
      <table className="w-full text-sm min-w-[900px]">
        <thead className="bg-slate-900/80 text-slate-400 uppercase text-xs tracking-wider">
          <tr>
            <th className="text-left px-4 py-3">Category</th>
            <th className="text-left px-4 py-3">Feature</th>
            <th className="text-left px-4 py-3">Missing in</th>
            <th className="text-left px-4 py-3">Evidence</th>
            <th className="text-left px-4 py-3">Status</th>
            <th className="text-right px-4 py-3 min-w-[280px]">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {gaps.map((g) => {
            const isVerifying = verifying.has(g.id);
            const isPatching = patching.has(g.id);
            const hasPatched = patchedGaps.has(g.id);
            return (
              <tr
                key={g.id}
                className={
                  "hover:bg-slate-900/60 " +
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
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    {/* View source button */}
                    <button
                      onClick={() => onViewSource(g)}
                      className="rounded border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition"
                    >
                      View
                    </button>

                    {/* Verify button */}
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
                      {isVerifying
                        ? "Checking\u2026"
                        : g.verified === 1
                          ? "Verified"
                          : "Verify"}
                    </button>

                    {/* Generate Patch / Review button */}
                    {hasPatched ? (
                      <button
                        onClick={() => onPatch(g.id)}
                        className="rounded border border-emerald-700 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition"
                      >
                        Review {patchBuildStatus.get(g.id) === "pass" ? <span className="text-emerald-400 ml-1" title="Build passed">&#10003;</span> : patchBuildStatus.get(g.id) === "fail" ? <span className="text-red-400 ml-1" title="Build failed">&#10007;</span> : null}
                      </button>
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
          })}
        </tbody>
      </table>
    </div>
  );
}

function MissingBadge({ side }: { side: "web" | "mobile" }) {
  const tone =
    side === "mobile"
      ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
      : "bg-sky-500/10 text-sky-300 border-sky-500/30";
  return (
    <span
      className={
        "inline-block rounded border px-2 py-0.5 text-xs font-medium " + tone
      }
    >
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
