/**
 * Runtime settings API.
 *
 * `POST /runtimes/probe/route` is the load-bearing endpoint here, not polish:
 * it turns "the patch run died eight minutes in" into "this model's key is
 * blocked" in about two seconds. The live LiteLLM 401 is exactly the failure it
 * exists to surface.
 */

import { Router } from "express";
import {
  getAgentSettings, setAgentSettings, validateAgentSettings,
  probeAll, RUNTIMES, supportsAccess,
  type RuntimeId,
} from "../runtime/index.js";
import { getSetting, setSetting, type AgentSettings } from "../runtime/settings.js";
import { ACCESS_POLICIES, AGENT_SLOTS, type AccessPolicy } from "../runtime/types.js";

export const settingsRouter = Router();

/**
 * Probes shell out to three CLIs; cache briefly so a settings page render is cheap.
 *
 * The cache holds the ENRICHED payload, not the raw probe result. Caching the
 * raw value and enriching only on the miss path meant a cache hit returned
 * objects without `accessPolicies`/`notes` — so the page rendered once, then
 * every reload within the TTL crashed on `notes.map` and (with no error
 * boundary) blanked the entire app.
 */
type ProbePayload = ReturnType<typeof enrich>;
let probeCache: { at: number; value: ProbePayload[] } | null = null;
const PROBE_TTL_MS = 60_000;

function enrich(r: Awaited<ReturnType<typeof probeAll>>[number]) {
  return {
    ...r,
    // Capability facts the UI shows as badges, so a user picks with eyes open.
    accessPolicies: (ACCESS_POLICIES as readonly AccessPolicy[]).filter((a) => supportsAccess(r.id, a)),
    notes: NOTES[r.id] ?? [],
  };
}

settingsRouter.get("/settings", (_req, res) => {
  const agents = getAgentSettings();
  const assigned = new Set(Object.keys(agents.assignments));
  res.json({
    agents,
    patchQuality: getSetting("patch.quality", {
      repairRounds: 2,
      criticPasses: ["security"],
      crossRuntimeVerify: false,
    }),
    slots: AGENT_SLOTS,
    accessPolicies: ACCESS_POLICIES,
    // Surface what is NOT configured, so the UI can prompt rather than fail later.
    unassignedSlots: agents.assignments.default
      ? []
      : AGENT_SLOTS.filter((s) => !assigned.has(s)),
  });
});

settingsRouter.put("/settings", (req, res) => {
  const body = req.body as { agents?: AgentSettings; patchQuality?: unknown };

  if (body.agents) {
    const v = validateAgentSettings(body.agents);
    if (!v.ok) return res.status(400).json({ error: v.errors.join("; "), errors: v.errors });
    setAgentSettings(body.agents);
  }
  if (body.patchQuality) setSetting("patch.quality", body.patchQuality);

  const agents = getAgentSettings();
  const warnings: string[] = [];

  // Warn where a choice is legal but defeats its own purpose.
  const impl = agents.assignments["patch.implementer"] ?? agents.assignments.default;
  const verify = agents.assignments["patch.verifier"] ?? agents.assignments.default;
  if (impl && verify && agents.profiles[impl]?.runtime === agents.profiles[verify]?.runtime) {
    warnings.push(
      "patch.implementer and patch.verifier use the same runtime — cross-runtime verification adds no adversarial value",
    );
  }
  for (const [slot, name] of Object.entries(agents.assignments)) {
    const p = agents.profiles[name];
    if (slot === "analysis.extract" && p && !supportsAccess(p.runtime, "text-only")) {
      warnings.push(
        `${slot} is assigned to ${p.runtime}, which cannot run without tools — this tier exists to be cheap`,
      );
    }
  }

  res.json({ agents, warnings });
});

settingsRouter.get("/runtimes/probe", async (req, res) => {
  const fresh = req.query.refresh === "1";
  if (!fresh && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return res.json({ runtimes: probeCache.value, cached: true });
  }
  const value = (await probeAll()).map(enrich);
  probeCache = { at: Date.now(), value };
  res.json({ runtimes: value, cached: false });
});

const NOTES: Record<RuntimeId, string[]> = {
  "claude-code": ["enforces access via a tool denylist", "streams live text"],
  "codex": ["schema-enforced JSON output", "streams completed steps, not live text", "cannot run tool-free"],
  "opencode": ["no schema enforcement — parse-and-repair", "no cross-repo reads", "cannot run tool-free"],
};

/**
 * Live one-token round trip against a candidate route.
 *
 * Deliberately at `repo-read` rather than the cheapest tier, so it exercises
 * the real sandbox/permission path a working run would take.
 */
settingsRouter.post("/runtimes/probe/route", async (req, res) => {
  const { runtime, invocation, effort } = req.body as {
    runtime?: RuntimeId; invocation?: string; effort?: string;
  };
  if (!runtime || !RUNTIMES[runtime]) return res.status(400).json({ error: "unknown runtime" });
  if (!invocation) return res.status(400).json({ error: "invocation (model) is required" });

  const started = Date.now();
  try {
    let text = "";
    let error: string | undefined;
    for await (const ev of RUNTIMES[runtime].run({
      slot: "analysis.extract",
      prompt: "Reply with exactly: OK",
      access: "repo-read",
      timeoutMs: 60_000,
      model: { runtime, invocation, effort },
    })) {
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") error = ev.error;
    }
    const latencyMs = Date.now() - started;
    if (error) {
      return res.status(502).json({
        ok: false, code: "MODEL_UNAUTHORIZED", latencyMs,
        // Verbatim: "Authentication Error, Key is blocked" is far more useful
        // than a generic failure message.
        error,
      });
    }
    res.json({ ok: true, latencyMs, reply: text.trim().slice(0, 200) });
  } catch (err) {
    res.status(502).json({
      ok: false, latencyMs: Date.now() - started,
      code: (err as { code?: string }).code ?? "RUNTIME_ERROR",
      error: (err as Error).message,
    });
  }
});

export default settingsRouter;
