import { useEffect, useMemo, useRef, useState } from "react";
import { readNdjson } from "../../components/ndjson";
import { usePreviewPanel } from "../../state/previewPanel";

interface Props {
  branch: string;
  repo: "web" | "mobile";
  /** Optional PR URL — persisted on the run row, shown in history. */
  prUrl?: string | null;
  /** Specific test files to run (relative paths). If omitted, runs all. */
  testFiles?: string[];
  /** Kick off automatically on mount. Used by the Form's "Run existing tests" mode. */
  autoRun?: boolean;
  /** Fires once the NDJSON stream closes (success or failure). Used to refresh history list. */
  onFinish?: () => void;
}

interface RunChunk {
  type: "log" | "result" | "error" | "done" | "run_id";
  line?: string;
  exitCode?: number;
  success?: boolean;
  error?: string;
  id?: number;
}

type TestStatus = "passed" | "failed" | "pending";

interface TestCase {
  name: string;
  status: TestStatus;
  /** Line offsets in the `testLines` array that belong to this test. */
  start: number;
  end: number;
}

/**
 * ▶ Run Tests + live output.
 *
 * Split into three panes matching the design:
 *   left  — parsed test case list with pass/fail/pending pills
 *   mid   — output for the selected test (or the full test log when nothing selected)
 *   right — live emulator mirror (mobile only)
 *
 * Prereq startup logs collapse above the panes so they don't drown out test
 * output. The full raw log lives in a collapsible section at the bottom.
 */
export function TestRunner({ branch, repo, prUrl, testFiles, autoRun, onFinish }: Props) {
  const previewPanel = usePreviewPanel();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<{ exitCode: number; success: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [prereqOpen, setPrereqOpen] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | TestStatus>("all");
  const abortRef = useRef<AbortController | null>(null);

  const onRun = async () => {
    setRunning(true);
    setLines([]);
    setResult(null);
    setError(null);
    setRunId(null);
    setPrereqOpen(true);
    setSelectedIdx(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch("/api/skills/tests/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch, repo, testFiles, prUrl }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`test run failed: HTTP ${r.status}`);
      }
      let sawNonPrereq = false;
      for await (const chunk of readNdjson<RunChunk>(r.body)) {
        if (chunk.type === "run_id" && typeof chunk.id === "number") {
          setRunId(chunk.id);
        } else if (chunk.type === "log" && chunk.line) {
          const line = chunk.line;
          if (!line.startsWith("[prereq]") && !sawNonPrereq) {
            sawNonPrereq = true;
            setPrereqOpen(false);
          }
          setLines((prev) => {
            const next = [...prev, line];
            return next.length > 1200 ? next.slice(-1200) : next;
          });
        } else if (chunk.type === "result") {
          setResult({ exitCode: chunk.exitCode ?? 1, success: chunk.success ?? false });
        } else if (chunk.type === "error") {
          setError(chunk.error ?? "unknown error");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onFinish?.();
    }
  };

  const onCancel = () => abortRef.current?.abort();

  useEffect(() => {
    if (autoRun) void onRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Partition stream into prereq logs, test log lines, and parsed test cases.
  const { prereqLines, testLines, cases, counts } = useMemo(() => {
    const prereqLines: string[] = [];
    const testLines: string[] = [];
    const cases: TestCase[] = [];

    for (const line of lines) {
      if (line.startsWith("[prereq]") || line.startsWith("[preview]")) {
        prereqLines.push(line);
        continue;
      }
      const idx = testLines.length;
      testLines.push(line);
      const parsed = parseTestLine(line);
      if (parsed) {
        // Close the previous test case's span
        if (cases.length > 0) cases[cases.length - 1].end = idx - 1;
        cases.push({ name: parsed.name, status: parsed.status, start: idx, end: idx });
      } else if (cases.length > 0) {
        cases[cases.length - 1].end = idx;
      }
    }

    const counts = {
      passed: cases.filter((c) => c.status === "passed").length,
      failed: cases.filter((c) => c.status === "failed").length,
      pending: cases.filter((c) => c.status === "pending").length,
    };
    return { prereqLines, testLines, cases, counts };
  }, [lines]);

  const visibleCases = useMemo(() => {
    if (filter === "all") return cases.map((c, i) => ({ ...c, _origIndex: i }));
    return cases
      .map((c, i) => ({ ...c, _origIndex: i }))
      .filter((c) => c.status === filter);
  }, [cases, filter]);

  const midContent = useMemo(() => {
    if (selectedIdx !== null && cases[selectedIdx]) {
      const c = cases[selectedIdx];
      return testLines.slice(c.start, c.end + 1).join("\n");
    }
    return testLines.join("\n");
  }, [selectedIdx, cases, testLines]);

  return (
    <div className="border-t border-slate-700 px-6 py-4 space-y-3">
      {/* Button row + summary chips */}
      <div className="flex items-center gap-3 flex-wrap">
        {running ? (
          <button
            onClick={onCancel}
            className="rounded border border-red-600 bg-red-500/10 px-4 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onRun}
            className="rounded border border-emerald-600 bg-emerald-500/10 px-4 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
          >
            ▶ Run Tests
          </button>
        )}
        <span className="text-xs text-slate-500">
          {repo === "web" ? "Cypress" : "Detox"} · <span className="text-slate-300">{branch}</span>
        </span>
        {running && <span className="text-xs text-slate-400 animate-pulse">running…</span>}
        {result && !running && (
          <span
            className={
              "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium " +
              (result.success
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-red-500/40 bg-red-500/10 text-red-300")
            }
          >
            {result.success ? "✓ PASSED" : `✗ FAILED (exit ${result.exitCode})`}
          </span>
        )}
        {runId !== null && <span className="text-xs text-slate-500">history #{runId}</span>}
        {error && !running && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {/* Prereq logs — collapsed once tests start streaming. */}
      {prereqLines.length > 0 && (
        <div className="rounded border border-slate-800 bg-slate-950/60">
          <button
            onClick={() => setPrereqOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200"
          >
            <span>
              <span className="mr-2">{prereqOpen ? "▾" : "▸"}</span>
              Prereqs ({prereqLines.length} lines)
            </span>
            <span className="text-slate-600">
              {running && !testLines.length ? "starting environment…" : ""}
            </span>
          </button>
          {prereqOpen && (
            <pre className="max-h-40 overflow-y-auto px-3 pb-2 text-[11px] leading-tight text-slate-500 font-mono whitespace-pre-wrap border-t border-slate-800">
              {prereqLines.join("\n")}
            </pre>
          )}
        </div>
      )}

      {/* Filter chips — passed/failed/pending tally */}
      <div className="flex items-center gap-2 text-xs">
        <FilterChip
          label={`all ${cases.length}`}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <FilterChip
          label={`✓ ${counts.passed} passed`}
          tone="emerald"
          active={filter === "passed"}
          onClick={() => setFilter("passed")}
        />
        <FilterChip
          label={`✗ ${counts.failed} failed`}
          tone="red"
          active={filter === "failed"}
          onClick={() => setFilter("failed")}
        />
        <FilterChip
          label={`◦ ${counts.pending} pending`}
          tone="amber"
          active={filter === "pending"}
          onClick={() => setFilter("pending")}
        />
      </div>

      {/* 2-column layout: test case list · selected test output.
          Emulator is intentionally NOT inlined here — use the top-bar
          Preview panel for the live mirror so there's one emulator surface
          in the app, not two inconsistent ones. */}
      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)] grid-cols-1">
        {/* Col 1 — test case list */}
        <div className="rounded border border-slate-800 bg-slate-950/60 overflow-hidden">
          <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-slate-800">
            Test cases {visibleCases.length > 0 && `(${visibleCases.length})`}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {visibleCases.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-slate-600">
                {cases.length === 0 ? "waiting for tests…" : "nothing matches this filter"}
              </div>
            ) : (
              visibleCases.map((c) => (
                <button
                  key={c._origIndex}
                  onClick={() => setSelectedIdx(c._origIndex)}
                  className={
                    "w-full flex items-start gap-2 px-3 py-1.5 text-left text-xs border-b border-slate-800/60 transition " +
                    (selectedIdx === c._origIndex
                      ? "bg-slate-800/80"
                      : "hover:bg-slate-800/40")
                  }
                >
                  <StatusIcon status={c.status} />
                  <span className="flex-1 text-slate-300 leading-tight break-words">{c.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Col 2 — selected test log (or full log) */}
        <div className="rounded border border-slate-800 bg-slate-950/80 overflow-hidden flex flex-col">
          <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-slate-800 flex items-center justify-between">
            <span>
              {selectedIdx !== null && cases[selectedIdx]
                ? cases[selectedIdx].name
                : "full test output"}
            </span>
            {selectedIdx !== null && (
              <button
                onClick={() => setSelectedIdx(null)}
                className="text-slate-600 hover:text-slate-300"
              >
                clear
              </button>
            )}
          </div>
          <pre className="flex-1 min-h-[300px] max-h-[420px] overflow-y-auto px-3 py-2 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap">
            {midContent || (running ? "(streaming…)" : "(no output yet)")}
          </pre>
        </div>

      </div>

      {/* Link out to the global Preview panel for the live emulator / web mirror. */}
      <div className="flex justify-end">
        <button
          onClick={() =>
            previewPanel.open({ repoKey: repo, branch, initialTab: "emulator" })
          }
          className="text-[11px] text-slate-400 hover:text-emerald-300 inline-flex items-center gap-1.5"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="1" width="8" height="12" rx="1.5"/>
            <line x1="6" y1="11" x2="8" y2="11"/>
          </svg>
          Open live preview →
        </button>
      </div>

      {/* Raw log — collapsible, for when you really need everything */}
      <div className="rounded border border-slate-800 bg-slate-950/60">
        <button
          onClick={() => setRawOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200"
        >
          <span>
            <span className="mr-2">{rawOpen ? "▾" : "▸"}</span>
            Full log ({lines.length} lines)
          </span>
        </button>
        {rawOpen && (
          <pre className="max-h-72 overflow-y-auto px-3 pb-2 text-[11px] leading-tight text-slate-500 font-mono whitespace-pre-wrap border-t border-slate-800">
            {lines.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Extract a test case from a single log line. Supports:
 *   ✓ test name (123ms)          — Mocha/Cypress pass
 *   ✗ test name                  — Cypress fail
 *   ✔ test name                  — some reporters
 *   ✘ test name                  — some reporters
 *   1) test name                 — Mocha failure header
 *   - test name                  — Mocha pending
 *   PASS … › test name           — Jest/Detox pass
 *   FAIL … › test name           — Jest/Detox fail
 * Returns null for lines that aren't test-result markers.
 */
function parseTestLine(raw: string): { name: string; status: TestStatus } | null {
  // Strip common prefixes ([stderr], ANSI escapes already gone in our stream)
  const line = raw.replace(/^\[stderr\]\s*/, "").trimEnd();
  const trimmed = line.trimStart();

  // Tick / cross forms
  const tick = trimmed.match(/^(✓|✔)\s+(.+?)(?:\s+\(\d+ms\))?$/);
  if (tick) return { name: tick[2].trim(), status: "passed" };
  const cross = trimmed.match(/^(✗|✘)\s+(.+?)(?:\s+\(\d+ms\))?$/);
  if (cross) return { name: cross[2].trim(), status: "failed" };

  // Mocha pending
  const pending = trimmed.match(/^-\s+(.{3,})$/);
  if (pending && !pending[1].startsWith("-")) {
    return { name: pending[1].trim(), status: "pending" };
  }

  // Jest/Detox describe-style: "  ✓ it description" is caught above; also the
  // flat summary line sometimes looks like "  ○ skipped test name".
  const skipped = trimmed.match(/^○\s+(.+)$/);
  if (skipped) return { name: skipped[1].trim(), status: "pending" };

  return null;
}

function StatusIcon({ status }: { status: TestStatus }) {
  if (status === "passed") {
    return <span className="text-emerald-400 text-xs leading-4 w-3 inline-block">✓</span>;
  }
  if (status === "failed") {
    return <span className="text-red-400 text-xs leading-4 w-3 inline-block">✗</span>;
  }
  return <span className="text-amber-400 text-xs leading-4 w-3 inline-block">◦</span>;
}

function FilterChip({
  label,
  tone,
  active,
  onClick,
}: {
  label: string;
  tone?: "emerald" | "red" | "amber";
  active: boolean;
  onClick: () => void;
}) {
  const toneCls =
    tone === "emerald"
      ? "text-emerald-300 border-emerald-500/40"
      : tone === "red"
        ? "text-red-300 border-red-500/40"
        : tone === "amber"
          ? "text-amber-300 border-amber-500/40"
          : "text-slate-300 border-slate-700";
  return (
    <button
      onClick={onClick}
      className={
        "rounded border px-2 py-0.5 transition " +
        toneCls +
        (active ? " bg-slate-800/80" : " bg-transparent hover:bg-slate-800/40")
      }
    >
      {label}
    </button>
  );
}
