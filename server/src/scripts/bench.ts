/**
 * Patch-generation benchmark harness.
 *
 * Why this exists: a quality report is observability, not proof. Before any
 * prompt, verifier, critic or repair change lands, we need a recorded baseline
 * of what the current pipeline actually produces, so later changes can be
 * judged against it instead of argued about. This follows the same "measure
 * against cached output before wiring" loop LEARNINGS iteration 3 established
 * for the extractor filter.
 *
 * Commands
 *   cases                       resolve bench/cases.json against the DB, print a table
 *   run --label <l> [--pilot | --case <id>]...   run patch generation per case, record everything
 *   report --label <l>          pass-criteria table for one label
 *   compare <labelA> <labelB>   side-by-side
 *
 * Requires the dashboard server to be running (default http://localhost:5174,
 * override with BENCH_BASE_URL). Driving the real HTTP route is deliberate —
 * it exercises the exact production code path rather than a reimplementation
 * of it.
 *
 *   npm run dev -w server                            # in one terminal
 *   npx tsx server/src/scripts/bench.ts run --pilot --label baseline-claude
 *
 * Case definitions and human ratings are version-controlled under bench/.
 * Run artifacts are large and land in data/bench/ (gitignored).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, PROJECT_ROOT, REPOS, type RepoKey } from "../config.js";
import { db } from "../db.js";

const BASE_URL = process.env.BENCH_BASE_URL ?? "http://localhost:5174";
const CASES_PATH = path.join(PROJECT_ROOT, "bench", "cases.json");
const RATINGS_PATH = path.join(PROJECT_ROOT, "bench", "ratings.json");
const RUNS_DIR = path.join(DATA_DIR, "bench", "runs");

// ─── types ───────────────────────────────────────────────────────────────────

interface BenchCase {
  id: string;
  pilot?: boolean;
  category: string;
  canonicalName: string;
  missingIn: RepoKey;
  presentIn: RepoKey;
  why?: string;
}

interface RepoEnv {
  sha: string;
  submodules: Record<string, string>;
}

/** Everything we can record without a human or the (not-yet-built) validators. */
interface RunRecord {
  caseId: string;
  label: string;
  gapId: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  env: Partial<Record<RepoKey, RepoEnv>>;
  terminal: "patch_done" | "build_failed" | "error" | "no_terminal";
  patchId: number | null;
  branch: string | null;
  repo: string | null;
  filesTouched: number | null;
  buildStatus: string | null;
  buildLogTail: string | null;
  diffPath: string | null;
  diffBytes: number;
  phases: Array<{ phase: string; atMs: number }>;
  toolCalls: Record<string, number>;
  textChars: number;
  /** Parsed from the verifier's own JSON when the stream carried it. */
  verifier: { parsed: boolean; passed: boolean | null; issues: string[] };
  prUrl: string | null;
  prWarning: string | null;
  error: string | null;
}

// ─── small helpers ───────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | null {
  try { return git(cwd, ...args); } catch { return null; }
}

/**
 * True when the command exits 0, regardless of what it printed.
 *
 * Needed because `tryGit` returns stdout, and several git commands succeed with
 * EMPTY output — `git cat-file -e <sha>` being the one that bit: `!tryGit(...)`
 * is true for a successful check, so every submodule was reported missing and
 * silently skipped, quietly voiding the reset-to-baseline guarantee.
 */
function gitOk(cwd: string, ...args: string[]): boolean {
  try { git(cwd, ...args); return true; } catch { return false; }
}

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fallback; }
}

function loadCases(): BenchCase[] {
  const raw = readJson<{ cases?: BenchCase[] }>(CASES_PATH, {});
  if (!raw.cases?.length) throw new Error(`no cases found in ${CASES_PATH}`);
  return raw.cases;
}

function runDir(label: string): string {
  return path.join(RUNS_DIR, label);
}

/** Base SHA of a repo plus every submodule pointer, so a run is reproducible. */
function captureRepoEnv(repoKey: RepoKey): RepoEnv {
  const dir = REPOS[repoKey].dir;
  const sha = git(dir, "rev-parse", "HEAD");
  const submodules: Record<string, string> = {};
  const status = tryGit(dir, "submodule", "status") ?? "";
  for (const line of status.split("\n")) {
    const m = line.trim().match(/^[+\-U ]?([0-9a-f]{40})\s+(\S+)/);
    if (m) submodules[m[2]] = m[1];
  }
  return { sha, submodules };
}

/**
 * Return the repo to the recorded baseline state before a run.
 *
 * Every case starts from a byte-identical tree, which is the actual
 * requirement behind "identical clean worktrees". We reset in place rather
 * than using `git worktree add` because each worktree would need its own
 * submodule init and its own multi-GB node_modules for the ReScript build
 * gate to run at all — the cost dwarfs the isolation benefit for a serial
 * benchmark, and the repo lock already serialises access.
 *
 * `git clean -fd` (no -x) leaves ignored paths alone, so node_modules and the
 * ReScript build cache survive.
 */
function resetToBaseline(repoKey: RepoKey, env: RepoEnv): void {
  const dir = REPOS[repoKey].dir;
  tryGit(dir, "checkout", "--force", "main");
  tryGit(dir, "reset", "--hard", env.sha);
  tryGit(dir, "clean", "-fd");

  // Submodules are restored to the SHAs captured from the live working tree,
  // NOT to the parent's recorded pointers, and deliberately without running
  // `git submodule update`.
  //
  // Two reasons. First, `hyperswitch-client-core@main` does not compile
  // against its own recorded shared-code pointer — it needs a newer one — so
  // a working tree necessarily carries a local submodule bump (the same
  // situation LEARNINGS iteration 6 describes). Resetting to the recorded
  // pointer would guarantee a red build on every single case and the whole
  // benchmark would measure nothing. Second, `submodule update` would try to
  // fetch the recorded SHA from the bot fork, which is behind upstream and
  // does not have it — a slow network round trip that ends in failure.
  for (const [subPath, subSha] of Object.entries(env.submodules)) {
    const subDir = path.join(dir, subPath);
    if (!fs.existsSync(path.join(subDir, ".git"))) continue;
    if (!gitOk(subDir, "cat-file", "-e", `${subSha}^{commit}`)) {
      console.warn(`  ! ${repoKey}/${subPath}: baseline commit ${subSha.slice(0, 10)} missing locally`);
      continue;
    }
    tryGit(subDir, "reset", "--hard", subSha);
    tryGit(subDir, "clean", "-fd");
  }
  // Drop leftover feature branches so a re-run of the same case starts clean.
  for (const b of (tryGit(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads") ?? "").split("\n")) {
    if (b.startsWith("feat/gap-")) tryGit(dir, "branch", "-D", b);
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

interface GapRow {
  id: number;
  category: string;
  canonical_name: string;
  missing_in: string;
  present_in: string;
}

async function fetchGaps(): Promise<GapRow[]> {
  const res = await fetch(`${BASE_URL}/gaps`);
  if (!res.ok) throw new Error(`GET /gaps -> ${res.status}. Is the server running at ${BASE_URL}?`);
  return (await res.json()) as GapRow[];
}

function matchGap(gaps: GapRow[], c: BenchCase): GapRow | undefined {
  return gaps.find(
    (g) =>
      g.canonical_name === c.canonicalName &&
      g.category === c.category &&
      g.missing_in === c.missingIn,
  );
}

/**
 * Delete any existing patch for this gap so the case can be re-run.
 *
 * `patches` carries UNIQUE(gap_id), so without this a second run of the same
 * gap gets a 409. That constraint is exactly what makes "run this gap on
 * runtime A, then again on runtime B" impossible, and dropping it is part of
 * the telemetry work — until then the harness clears the rows itself.
 *
 * Done against SQLite directly because the server exposes no DELETE route for
 * patches. Safe alongside a running server: the DB is WAL-mode, so a second
 * process can write while the server holds its own connection.
 */
function clearExistingPatch(gapId: number): number {
  const rows = db
    .prepare("SELECT id, diff_path FROM patches WHERE gap_id = ?")
    .all(gapId) as Array<{ id: number; diff_path: string | null }>;
  for (const r of rows) {
    db.prepare("DELETE FROM chat_messages WHERE patch_id = ?").run(r.id);
    if (r.diff_path && fs.existsSync(r.diff_path)) {
      try { fs.unlinkSync(r.diff_path); } catch { /* */ }
    }
  }
  db.prepare("DELETE FROM patches WHERE gap_id = ?").run(gapId);
  return rows.length;
}

// ─── the run ─────────────────────────────────────────────────────────────────

async function runCase(c: BenchCase, gap: GapRow, label: string): Promise<RunRecord> {
  const env: Partial<Record<RepoKey, RepoEnv>> = {
    [c.missingIn]: captureRepoEnv(c.missingIn),
    [c.presentIn]: captureRepoEnv(c.presentIn),
  };
  resetToBaseline(c.missingIn, env[c.missingIn]!);
  clearExistingPatch(gap.id);

  const started = Date.now();
  const rec: RunRecord = {
    caseId: c.id,
    label,
    gapId: gap.id,
    startedAt: new Date(started).toISOString(),
    endedAt: "",
    durationMs: 0,
    env,
    terminal: "no_terminal",
    patchId: null, branch: null, repo: null, filesTouched: null,
    buildStatus: null, buildLogTail: null,
    diffPath: null, diffBytes: 0,
    phases: [], toolCalls: {}, textChars: 0,
    verifier: { parsed: false, passed: null, issues: [] },
    prUrl: null, prWarning: null, error: null,
  };

  let verifierText = "";
  let sawVerifyPhase = false;

  const res = await fetch(`${BASE_URL}/gaps/${gap.id}/patch/stream`, { method: "POST" });
  if (!res.ok || !res.body) {
    rec.terminal = "error";
    rec.error = `POST /gaps/${gap.id}/patch/stream -> ${res.status} ${await res.text().catch(() => "")}`;
    rec.endedAt = new Date().toISOString();
    rec.durationMs = Date.now() - started;
    return rec;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let diff = "";

  const handle = (chunk: Record<string, unknown>): void => {
    const type = chunk.type as string;
    switch (type) {
      case "phase_marker": {
        const phase = String(chunk.phase);
        rec.phases.push({ phase, atMs: Date.now() - started });
        if (phase === "verifying") sawVerifyPhase = true;
        break;
      }
      case "text": {
        const t = String(chunk.text ?? "");
        rec.textChars += t.length;
        if (sawVerifyPhase) verifierText += t;
        break;
      }
      case "tool_use": {
        const name = String((chunk.tool as { name?: string } | undefined)?.name ?? "unknown");
        rec.toolCalls[name] = (rec.toolCalls[name] ?? 0) + 1;
        break;
      }
      case "build_failed": {
        rec.terminal = "build_failed";
        rec.patchId = Number(chunk.patchId) || null;
        rec.branch = (chunk.branch as string) ?? null;
        rec.repo = (chunk.repo as string) ?? null;
        rec.filesTouched = Number(chunk.filesTouched) || null;
        rec.buildStatus = "fail";
        rec.buildLogTail = String(chunk.buildLog ?? "").slice(-4000);
        diff = String(chunk.diff ?? "");
        break;
      }
      case "patch_done": {
        rec.terminal = "patch_done";
        rec.patchId = Number(chunk.patchId) || null;
        rec.branch = (chunk.branch as string) ?? null;
        rec.repo = (chunk.repo as string) ?? null;
        rec.filesTouched = Number(chunk.filesTouched) || null;
        rec.buildStatus = (chunk.buildStatus as string) ?? null;
        rec.buildLogTail = String(chunk.buildLog ?? "").slice(-4000);
        rec.prUrl = (chunk.prUrl as string) ?? null;
        rec.prWarning = (chunk.prWarning as string) ?? null;
        diff = String(chunk.diff ?? "");
        break;
      }
      case "error": {
        if (rec.terminal === "no_terminal") rec.terminal = "error";
        rec.error = String(chunk.error ?? "");
        break;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line) as Record<string, unknown>); } catch { /* ignore noise */ }
    }
  }

  // The verifier is instructed to emit {"pass":bool,"issues":[]}. Recording
  // whether that even parsed is the point: today an unparseable verdict is
  // silently treated as a pass, so the baseline must capture how often that
  // actually happens.
  const m = verifierText.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { pass?: boolean; issues?: string[] };
      rec.verifier = {
        parsed: true,
        passed: parsed.pass ?? null,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch { /* leave parsed:false */ }
  }

  const dir = runDir(label);
  fs.mkdirSync(dir, { recursive: true });
  if (diff) {
    const diffPath = path.join(dir, `${c.id}.patch`);
    fs.writeFileSync(diffPath, diff.endsWith("\n") ? diff : diff + "\n");
    rec.diffPath = diffPath;
    rec.diffBytes = Buffer.byteLength(diff);
  }
  rec.endedAt = new Date().toISOString();
  rec.durationMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

// ─── pass criteria ───────────────────────────────────────────────────────────

type Tri = "yes" | "no" | "?";

interface Criteria {
  applies: Tri;
  builds: Tri;
  behaviorWired: Tri;      // filled once patchValidators lands (step 1)
  noForbiddenChanges: Tri; // filled once patchValidators lands (step 1)
  reviewerHealth: Tri;
  humanDisposition: string;
}

/**
 * `git apply --check --reverse` against the repo the patch was produced in.
 * Reverse (not plain --check) because the patch describes a delta that is
 * already present in the tree; reverse-applying proves it exactly and
 * invertibly matches. A full clean-worktree apply at the recorded base SHA
 * lands with the validators in step 1.
 */
function patchApplies(rec: RunRecord): Tri {
  if (!rec.diffPath || !fs.existsSync(rec.diffPath)) return "?";
  const repoKey = (rec.repo as RepoKey) ?? null;
  if (!repoKey || !REPOS[repoKey]) return "?";
  const dir = REPOS[repoKey].dir;
  if (!tryGit(dir, "rev-parse", "--verify", rec.branch ?? "HEAD")) return "?";
  const before = tryGit(dir, "rev-parse", "--abbrev-ref", "HEAD");
  try {
    if (rec.branch) tryGit(dir, "checkout", "--force", rec.branch);
    const out = tryGit(dir, "apply", "--check", "--reverse", "--", rec.diffPath);
    return out === null ? "no" : "yes";
  } finally {
    if (before) tryGit(dir, "checkout", "--force", before);
  }
}

function criteriaFor(rec: RunRecord, ratings: Record<string, string>): Criteria {
  return {
    applies: patchApplies(rec),
    builds: rec.buildStatus === "pass" ? "yes" : rec.buildStatus === "fail" ? "no" : "?",
    behaviorWired: "?",
    noForbiddenChanges: "?",
    reviewerHealth: !rec.verifier.parsed ? "?" : rec.verifier.passed ? "yes" : "no",
    humanDisposition: readDisposition(ratings[`${rec.label}/${rec.caseId}`]),
  };
}

/**
 * A rating is either a bare disposition string or `{disposition, evidence[]}`.
 * The richer form exists so the reasoning behind a call survives next to it —
 * a bare "reject" six months from now is unreviewable.
 */
function readDisposition(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const d = (entry as { disposition?: unknown }).disposition;
    if (typeof d === "string") return d;
  }
  return "—";
}

function loadRecords(label: string): RunRecord[] {
  const dir = runDir(label);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<RunRecord | null>(path.join(dir, f), null))
    .filter((r): r is RunRecord => r !== null);
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}

function printReport(label: string): void {
  const ratings = readJson<Record<string, string>>(RATINGS_PATH, {});
  const recs = loadRecords(label).sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (!recs.length) {
    console.log(`no runs recorded under label "${label}" (${runDir(label)})`);
    return;
  }
  console.log(`\nlabel: ${label}   (${recs.length} case(s))\n`);
  console.log(
    pad("case", 38) + pad("terminal", 13) + pad("appl", 6) + pad("bld", 5) +
    pad("wired", 7) + pad("clean", 7) + pad("rev", 5) + pad("mins", 6) + "human",
  );
  console.log("-".repeat(110));
  for (const r of recs) {
    const c = criteriaFor(r, ratings);
    console.log(
      pad(r.caseId, 38) + pad(r.terminal, 13) + pad(c.applies, 6) + pad(c.builds, 5) +
      pad(c.behaviorWired, 7) + pad(c.noForbiddenChanges, 7) + pad(c.reviewerHealth, 5) +
      pad((r.durationMs / 60000).toFixed(1), 6) + c.humanDisposition,
    );
    if (r.error) console.log(`${" ".repeat(38)}error: ${r.error.slice(0, 140)}`);
  }
  const verifierUnparsed = recs.filter((r) => r.terminal === "patch_done" && !r.verifier.parsed).length;
  console.log(
    `\nverifier verdict unparseable on ${verifierUnparsed}/${recs.filter((r) => r.terminal === "patch_done").length}` +
    ` completed run(s) — those silently count as PASS today.`,
  );
  console.log(`"wired" and "clean" stay "?" until patchValidators lands (step 1).`);
  console.log(`Fill human dispositions in ${path.relative(PROJECT_ROOT, RATINGS_PATH)} keyed "${label}/<caseId>".\n`);
}

function printCompare(a: string, b: string): void {
  const ratings = readJson<Record<string, string>>(RATINGS_PATH, {});
  const ra = new Map(loadRecords(a).map((r) => [r.caseId, r]));
  const rb = new Map(loadRecords(b).map((r) => [r.caseId, r]));
  const ids = [...new Set([...ra.keys(), ...rb.keys()])].sort();
  if (!ids.length) return void console.log("nothing to compare");
  console.log(`\n${a}  vs  ${b}\n`);
  console.log(pad("case", 38) + pad(`${a} (t/bld/rev)`, 30) + `${b} (t/bld/rev)`);
  console.log("-".repeat(110));
  const fmt = (r: RunRecord | undefined) => {
    if (!r) return "—";
    const c = criteriaFor(r, ratings);
    return `${r.terminal}/${c.builds}/${c.reviewerHealth}`;
  };
  for (const id of ids) console.log(pad(id, 38) + pad(fmt(ra.get(id)), 30) + fmt(rb.get(id)));
  console.log();
}

// ─── cli ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const multi = (name: string): string[] => {
    const out: string[] = [];
    argv.forEach((a, i) => { if (a === `--${name}`) out.push(argv[i + 1]); });
    return out;
  };

  if (cmd === "cases") {
    const cases = loadCases();
    const gaps = await fetchGaps();
    console.log();
    for (const c of cases) {
      const g = matchGap(gaps, c);
      console.log(
        `${g ? String(g.id).padStart(3) : "  ?"}  ${c.pilot ? "[pilot]" : "       "}  ` +
        `${pad(c.id, 40)}${g ? "" : "  ← NOT FOUND in DB"}`,
      );
    }
    console.log(`\n${cases.length} case(s), ${gaps.length} gap(s) in DB.\n`);
    return;
  }

  if (cmd === "run") {
    const label = flag("label");
    if (!label) throw new Error("--label <name> is required");
    const only = new Set(multi("case"));
    const pilotOnly = argv.includes("--pilot");

    let cases = loadCases();
    if (only.size) cases = cases.filter((c) => only.has(c.id));
    else if (pilotOnly) cases = cases.filter((c) => c.pilot);
    if (!cases.length) throw new Error("no cases selected");

    const gaps = await fetchGaps();
    console.log(`\nrunning ${cases.length} case(s) under label "${label}" against ${BASE_URL}\n`);

    for (const [i, c] of cases.entries()) {
      const gap = matchGap(gaps, c);
      if (!gap) {
        console.log(`[${i + 1}/${cases.length}] ${c.id} — SKIPPED (no matching gap in DB)`);
        continue;
      }
      process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} (gap ${gap.id}) … `);
      const rec = await runCase(c, gap, label);
      console.log(
        `${rec.terminal} in ${(rec.durationMs / 60000).toFixed(1)}m` +
        `${rec.buildStatus ? ` build=${rec.buildStatus}` : ""}` +
        `${rec.filesTouched ? ` files=${rec.filesTouched}` : ""}` +
        `${rec.error ? ` — ${rec.error.slice(0, 100)}` : ""}`,
      );
    }
    printReport(label);
    return;
  }

  if (cmd === "report") {
    const label = flag("label");
    if (!label) throw new Error("--label <name> is required");
    printReport(label);
    return;
  }

  if (cmd === "compare") {
    const [, a, b] = argv;
    if (!a || !b) throw new Error("usage: bench compare <labelA> <labelB>");
    printCompare(a, b);
    return;
  }

  console.log(`usage:
  bench cases
  bench run --label <name> [--pilot | --case <id> ...]
  bench report --label <name>
  bench compare <labelA> <labelB>`);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
