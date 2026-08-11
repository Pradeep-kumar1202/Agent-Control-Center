import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { loadLocalOverride, saveLocalOverride, type AgentSettings, type Profile } from "./store";

/**
 * Runtime configuration.
 *
 * Three cards, in the order a first-time user needs them: what is installed,
 * which model each stage uses, and how hard the patch pipeline should try.
 *
 * Every model field is an editable combobox rather than a plain select. The
 * three runtimes expose very different catalogs (claude-code has none to
 * enumerate, codex ships a real one, opencode lists 51), and those lists change
 * faster than this UI will — so discovery seeds suggestions and never
 * constrains input.
 */

interface RuntimeInfo {
  id: "claude-code" | "codex" | "opencode";
  installed: boolean;
  version?: string;
  models: string[];
  error?: string;
  accessPolicies: string[];
  notes: string[];
}

interface PatchQuality {
  repairRounds: number;
  criticPasses: string[];
  crossRuntimeVerify: boolean;
}

const EMPTY: AgentSettings = { profiles: {}, assignments: {} };

export default function SettingsPage() {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [slots, setSlots] = useState<string[]>([]);
  const [saved, setSaved] = useState<AgentSettings>(EMPTY);
  const [draft, setDraft] = useState<AgentSettings>(EMPTY);
  const [quality, setQuality] = useState<PatchQuality>({ repairRounds: 2, criticPasses: ["security"], crossRuntimeVerify: false });
  const [useLocal, setUseLocal] = useState(() => loadLocalOverride() !== null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});

  useEffect(() => {
    void (async () => {
      try {
        const [s, p] = await Promise.all([api.getSettings(), api.probeRuntimes()]);
        // Normalise everything the render path indexes into. A settings page
        // that crashes takes the whole app down with it, so it should tolerate
        // a partial payload rather than trust one.
        const agents = {
          profiles: s.agents?.profiles ?? {},
          assignments: s.agents?.assignments ?? {},
        };
        setSaved(agents);
        const local = loadLocalOverride();
        setDraft(local?.profiles ? local : agents);
        setSlots(s.slots ?? []);
        setQuality({
          repairRounds: s.patchQuality?.repairRounds ?? 2,
          criticPasses: s.patchQuality?.criticPasses ?? [],
          crossRuntimeVerify: s.patchQuality?.crossRuntimeVerify ?? false,
        });
        setRuntimes(p.runtimes ?? []);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const profileNames = Object.keys(draft.profiles);

  const setProfile = (name: string, next: Profile | null) => {
    setDraft((d) => {
      const profiles = { ...d.profiles };
      if (next === null) delete profiles[name];
      else profiles[name] = next;
      return { ...d, profiles };
    });
  };

  const assign = (slot: string, profile: string) => {
    setDraft((d) => {
      const assignments = { ...d.assignments };
      if (!profile) delete assignments[slot];
      else assignments[slot] = profile;
      return { ...d, assignments };
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (useLocal) {
        // Local override never touches the server default.
        saveLocalOverride(draft);
        setSaved(draft);
        setWarnings([]);
      } else {
        saveLocalOverride(null);
        const res = await api.putSettings({ agents: draft, patchQuality: quality });
        setSaved(res.agents);
        setWarnings(res.warnings ?? []);
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testRoute = async (name: string) => {
    const p = draft.profiles[name];
    if (!p) return;
    setTests((t) => ({ ...t, [name]: { ok: false, text: "testing…" } }));
    try {
      const r = await api.testRuntimeRoute(p);
      setTests((t) => ({
        ...t,
        [name]: r.ok
          ? { ok: true, text: `ok (${r.latencyMs} ms)` }
          : { ok: false, text: r.error ?? "failed" },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [name]: { ok: false, text: (e as Error).message } }));
    }
  };

  const allModels = useMemo(() => {
    const byRuntime: Record<string, string[]> = {};
    for (const r of runtimes) byRuntime[r.id] = r.models;
    return byRuntime;
  }, [runtimes]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {/* ── Runtimes ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Runtimes</h3>
          <button
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            onClick={() => void api.probeRuntimes(true).then((p) => setRuntimes(p.runtimes))}
          >
            Re-probe
          </button>
        </div>
        <div className="space-y-2">
          {runtimes.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${r.installed ? "bg-emerald-500" : "bg-red-500"}`} />
              <span className="w-28 font-mono text-xs text-slate-200">{r.id}</span>
              <span className="w-52 truncate text-xs text-slate-500">{r.version ?? r.error ?? "not installed"}</span>
              <span className="text-xs text-slate-500">{r.models.length} models</span>
              <span className="ml-auto flex flex-wrap gap-1">
                {(r.notes ?? []).map((n) => (
                  <span key={n} className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400">{n}</span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Profiles ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Profiles</h3>
          <button
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
            onClick={() => setProfile(`profile${profileNames.length + 1}`, { runtime: "claude-code", invocation: "sonnet" })}
          >
            + Add profile
          </button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          A named runtime + model you can point any stage at. Model is free text — the list only suggests.
        </p>
        <div className="space-y-2">
          {profileNames.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-xs text-slate-500">
              No profiles yet. Add one, then assign it below — nothing runs until at least one stage is assigned.
            </p>
          )}
          {profileNames.map((name) => {
            const p = draft.profiles[name];
            const t = tests[name];
            return (
              <div key={name} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">
                <input
                  className="w-28 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  value={name}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft((d) => {
                      const profiles: Record<string, Profile> = {};
                      for (const [k, v] of Object.entries(d.profiles)) profiles[k === name ? next : k] = v;
                      const assignments = Object.fromEntries(
                        Object.entries(d.assignments).map(([s, pn]) => [s, pn === name ? next : pn]),
                      );
                      return { profiles, assignments };
                    });
                  }}
                />
                <select
                  className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                  value={p.runtime}
                  onChange={(e) => setProfile(name, { ...p, runtime: e.target.value as Profile["runtime"] })}
                >
                  {runtimes.map((r) => (
                    <option key={r.id} value={r.id} disabled={!r.installed}>
                      {r.id}{r.installed ? "" : " (not installed)"}
                    </option>
                  ))}
                </select>
                <input
                  list={`models-${p.runtime}`}
                  className="min-w-[14rem] flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  placeholder="model, e.g. litellm/open-large"
                  value={p.invocation}
                  onChange={(e) => setProfile(name, { ...p, invocation: e.target.value })}
                />
                <datalist id={`models-${p.runtime}`}>
                  {(allModels[p.runtime] ?? []).map((m) => <option key={m} value={m} />)}
                </datalist>
                <input
                  className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
                  placeholder="effort"
                  value={p.effort ?? ""}
                  onChange={(e) => setProfile(name, { ...p, effort: e.target.value || undefined })}
                />
                <button
                  className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-indigo-500"
                  onClick={() => void testRoute(name)}
                >
                  Test
                </button>
                {t && (
                  <span className={`max-w-[18rem] truncate text-xs ${t.ok ? "text-emerald-400" : "text-red-400"}`} title={t.text}>
                    {t.text}
                  </span>
                )}
                <button
                  className="rounded-md px-2 py-1 text-xs text-slate-500 hover:text-red-400"
                  onClick={() => setProfile(name, null)}
                  aria-label={`remove ${name}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Assignments ──────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-200">Stage assignments</h3>
        <p className="mb-3 text-xs text-slate-500">
          <span className="font-mono text-slate-400">default</span> covers every unassigned stage. Assign individual
          stages only where they genuinely need a different model.
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {["default", ...slots].map((slot) => (
            <label key={slot} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-1.5">
              <span className={`flex-1 truncate font-mono text-xs ${slot === "default" ? "text-indigo-300" : "text-slate-400"}`}>
                {slot}
              </span>
              <select
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none"
                value={draft.assignments[slot] ?? ""}
                onChange={(e) => assign(slot, e.target.value)}
              >
                <option value="">{slot === "default" ? "— none —" : "— use default —"}</option>
                {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ))}
        </div>
      </section>

      {/* ── Patch quality ────────────────────────────────────────── */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Patch quality</h3>
        <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            Repair rounds
            <input
              type="number" min={0} max={5}
              className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 focus:border-indigo-500 focus:outline-none"
              value={quality.repairRounds}
              onChange={(e) => setQuality((q) => ({ ...q, repairRounds: Number(e.target.value) }))}
            />
          </label>
          {(["security", "logic", "convention"] as const).map((pass) => (
            <label key={pass} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={quality.criticPasses.includes(pass)}
                onChange={(e) =>
                  setQuality((q) => ({
                    ...q,
                    criticPasses: e.target.checked
                      ? [...q.criticPasses, pass]
                      : q.criticPasses.filter((p) => p !== pass),
                  }))
                }
              />
              critic: {pass}
            </label>
          ))}
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={quality.crossRuntimeVerify}
              onChange={(e) => setQuality((q) => ({ ...q, crossRuntimeVerify: e.target.checked }))}
            />
            cross-runtime verify
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Each extra critic pass is another tool-enabled call on every patch. Costs show up per stage in run telemetry.
        </p>
      </section>

      {/* ── Save bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={useLocal} onChange={(e) => setUseLocal(e.target.checked)} />
          Only for this browser
        </label>
        <span className="text-xs text-slate-500">
          {useLocal
            ? "Saved locally; the shared default is untouched."
            : "Saved as the shared default for everyone using this dashboard."}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {savedAt && <span className="text-xs text-emerald-400">saved {savedAt}</span>}
          <button
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
            disabled={!dirty || busy}
            onClick={() => setDraft(saved)}
          >
            Discard
          </button>
          <button
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            disabled={!dirty || busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          {warnings.map((w) => <div key={w}>• {w}</div>)}
        </div>
      )}
    </div>
  );
}
