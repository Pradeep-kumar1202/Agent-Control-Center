/**
 * Cross-runtime smoke test.
 *
 * Proves each adapter really produces the normalized event stream the rest of
 * the app depends on — text arrives, tool calls arrive with the Claude-shaped
 * names the UI switches on, usage is reported, and exactly one terminal event
 * is emitted. Everything below was captured from real CLI output rather than
 * assumed, and this is what keeps that true across CLI upgrades.
 *
 *   npx tsx server/src/scripts/probeRuntimes.ts            # probe only
 *   npx tsx server/src/scripts/probeRuntimes.ts --run      # also make live calls
 *
 * `--run` spends a small amount of quota on each configured runtime.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeCodeRuntime } from "../runtime/adapters/claudeCode.js";
import { codexRuntime } from "../runtime/adapters/codex.js";
import { opencodeRuntime } from "../runtime/adapters/opencode.js";
import {
  UnsupportedRuntimeCapabilityError,
  type AgentEvent, type AgentRuntime, type ResolvedAgentRequest, type RuntimeId,
} from "../runtime/types.js";

/** Model used per runtime for the live check. Overridable via env. */
const PROBE_MODEL: Record<RuntimeId, string> = {
  "claude-code": process.env.PROBE_CLAUDE_MODEL ?? "sonnet",
  "codex": process.env.PROBE_CODEX_MODEL ?? "gpt-5.4",
  // litellm/open-large currently 401s ("Key is blocked"), so the default is a
  // model that actually works. Override once the key is unblocked.
  "opencode": process.env.PROBE_OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free",
};

const RUNTIMES: AgentRuntime[] = [claudeCodeRuntime, codexRuntime, opencodeRuntime];

let failures = 0;
const check = (cond: boolean, label: string, detail = ""): void => {
  if (cond) console.log(`    ✓ ${label}`);
  else { failures++; console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

async function collect(rt: AgentRuntime, req: ResolvedAgentRequest): Promise<{
  events: AgentEvent[]; text: string; terminals: number; error?: string;
}> {
  const events: AgentEvent[] = [];
  let text = "";
  let terminals = 0;
  let error: string | undefined;
  for await (const ev of rt.run(req)) {
    events.push(ev);
    if (ev.type === "text") text += ev.text;
    if (ev.type === "done") terminals++;
    if (ev.type === "error") { terminals++; error = ev.error; }
  }
  return { events, text, terminals, error };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--run");

  console.log("\nRuntime probe\n");
  const statuses = await Promise.all(RUNTIMES.map((r) => r.probe()));
  for (const s of statuses) {
    console.log(
      `  ${s.id.padEnd(12)} ${s.installed ? "installed" : "MISSING  "} ` +
      `${(s.version ?? "").padEnd(22)} ${s.models.length} model(s)` +
      `${s.error ? `  (${s.error.split("\n")[0].slice(0, 60)})` : ""}`,
    );
  }

  // Capability boundaries must be hard errors, not silent downgrades.
  console.log("\nCapability boundaries\n");
  const dummy = (over: Partial<ResolvedAgentRequest>): ResolvedAgentRequest => ({
    slot: "analysis.extract", prompt: "x", access: "repo-read",
    model: { runtime: "codex", invocation: "gpt-5.4" }, ...over,
  } as ResolvedAgentRequest);

  for (const [rt, label] of [[codexRuntime, "codex"], [opencodeRuntime, "opencode"]] as const) {
    let threw = false;
    try {
      await collect(rt, dummy({ access: "text-only", model: { runtime: label, invocation: "x" } }));
    } catch (e) { threw = e instanceof UnsupportedRuntimeCapabilityError; }
    check(threw, `${label}: text-only rejected rather than silently widened`);
  }
  let readDirsThrew = false;
  try {
    await collect(opencodeRuntime, dummy({
      readDirs: ["/tmp"], model: { runtime: "opencode", invocation: "x" },
    }));
  } catch (e) { readDirsThrew = e instanceof UnsupportedRuntimeCapabilityError; }
  check(readDirsThrew, "opencode: cross-repo readDirs rejected (no --add-dir equivalent)");

  if (!live) {
    console.log("\n(pass --run to make live calls)\n");
    process.exit(failures === 0 ? 0 : 1);
  }

  // ── live calls ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-runtime-probe-"));
  fs.writeFileSync(path.join(dir, "marker.txt"), "PROBE_MARKER_OK\n");

  for (const rt of RUNTIMES) {
    const status = statuses.find((s) => s.id === rt.id)!;
    console.log(`\n${rt.id} — live (${PROBE_MODEL[rt.id]})\n`);
    if (!status.installed) { console.log("    (skipped — not installed)"); continue; }

    try {
      const res = await collect(rt, {
        slot: "analysis.extract",
        prompt: "Read the file marker.txt in the current directory and reply with its exact contents.",
        access: "repo-read",
        cwd: dir,
        timeoutMs: 180_000,
        model: { runtime: rt.id, invocation: PROBE_MODEL[rt.id] },
      });

      if (res.error) {
        failures++;
        console.log(`    ✗ run failed — ${res.error.split("\n")[0].slice(0, 160)}`);
        continue;
      }
      check(res.terminals === 1, "exactly one terminal event", `got ${res.terminals}`);
      check(res.text.includes("PROBE_MARKER_OK"), "file contents reached the model", JSON.stringify(res.text.slice(0, 90)));

      const tools = res.events.filter((e) => e.type === "tool_use") as Extract<AgentEvent, { type: "tool_use" }>[];
      check(tools.length > 0, "emitted at least one tool_use");
      const names = new Set(tools.map((t) => t.tool.name));
      check(
        [...names].every((n) => /^(Read|Glob|Grep|Bash|Edit|Write)$/.test(n)),
        "tool names normalized to the UI's vocabulary",
        [...names].join(", "),
      );

      // Text must not be duplicated — the OpenCode snapshot trap.
      const firstIdx = res.text.indexOf("PROBE_MARKER_OK");
      check(
        res.text.indexOf("PROBE_MARKER_OK", firstIdx + 1) === -1,
        "no duplicated text (part-snapshot dedupe)",
      );

      const usage = res.events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }> | undefined;
      check(usage !== undefined && (usage.usage.inputTokens ?? 0) > 0, "reported token usage");
    } catch (err) {
      failures++;
      console.log(`    ✗ threw — ${(err as Error).message.split("\n")[0].slice(0, 160)}`);
    }
  }

  console.log(failures === 0 ? "\nAll runtime checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
