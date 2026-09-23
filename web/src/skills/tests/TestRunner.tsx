import { useRef, useState } from "react";
import { readNdjson } from "../../components/ndjson";

interface Props {
  branch: string;
  repo: "web" | "mobile";
  /** Specific test files to run (relative paths). If provided, only these run instead of the full suite. */
  testFiles?: string[];
}

interface TestRunChunk {
  type: "log" | "result" | "error" | "done";
  line?: string;
  exitCode?: number;
  success?: boolean;
  error?: string;
}

/**
 * "Run Tests" button + streaming output + pass/fail summary.
 *
 * Hits POST /api/skills/tests/run with the branch + repo, reads the NDJSON
 * stream, and renders each line in a scrollable log. When the final
 * {type:"result"} event arrives, shows a green/red pass/fail banner.
 */
export function TestRunner({ branch, repo, testFiles }: Props) {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<{ exitCode: number; success: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const onRun = async () => {
    setRunning(true);
    setLines([]);
    setResult(null);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const r = await fetch("/api/skills/tests/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch, repo, testFiles }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(`test run failed: HTTP ${r.status}`);
      }
      for await (const chunk of readNdjson<TestRunChunk>(r.body)) {
        if (chunk.type === "log" && chunk.line) {
          setLines((prev) => {
            const next = [...prev, chunk.line!];
            // Keep last 500 lines
            return next.length > 500 ? next.slice(-500) : next;
          });
          // Auto-scroll
          requestAnimationFrame(() => {
            if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
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
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="border-t border-slate-700 px-6 py-4 space-y-3">
      {/* Live emulator mirror for mobile tests — shows ws-scrcpy iframe so
          the user can watch Detox automating the app in real time */}
      {repo === "mobile" && (running || result) && (
        <div className="rounded border border-slate-800 overflow-hidden">
          <iframe
            src={`http://${window.location.hostname}:8000/`}
            title="emulator mirror (live test view)"
            className="w-full h-[400px] border-0 bg-black"
            allow="autoplay; fullscreen"
          />
        </div>
      )}
      {/* Button row */}
      <div className="flex items-center gap-3">
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
        {running && (
          <span className="text-xs text-slate-400 animate-pulse">running tests…</span>
        )}
        {result && !running && (
          <span
            className={
              "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium " +
              (result.success
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-red-500/40 bg-red-500/10 text-red-300")
            }
          >
            {result.success ? "✅ PASSED" : `❌ FAILED (exit ${result.exitCode})`}
          </span>
        )}
        {error && !running && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>

      {/* Streaming log output */}
      {lines.length > 0 && (
        <pre
          ref={logRef}
          className="max-h-72 overflow-y-auto rounded border border-slate-800 bg-slate-950/80 px-3 py-2 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap"
        >
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
