import { useCallback, useEffect, useRef, useState } from "react";
import { api, type HyperswitchCredentials, type MockServerState } from "../api";
import { usePreviewPanel, type PreviewPanelTab } from "../state/previewPanel";
import { EmulatorView } from "./EmulatorView";

type RepoKey = "web" | "mobile";

const TABS: { id: PreviewPanelTab; label: string }[] = [
  { id: "emulator", label: "Emulator" },
  { id: "config", label: "JSON Config" },
  { id: "server", label: "Server" },
];

/**
 * Global Preview Panel — right-edge drawer with three tabs.
 *
 * Opened via `usePreviewPanel().open()`. One instance is mounted in App.tsx;
 * every skill reuses it.
 */
export function PreviewPanel() {
  const { state, close, setCtx } = usePreviewPanel();
  const [tab, setTab] = useState<PreviewPanelTab>(state.ctx.initialTab ?? "emulator");
  const [mockState, setMockState] = useState<MockServerState | null>(null);

  // Sync initial tab when a new open() specifies one.
  useEffect(() => {
    if (state.open && state.ctx.initialTab) setTab(state.ctx.initialTab);
  }, [state.open, state.ctx.initialTab]);

  // Fetch mock-server status periodically while the panel is open. Used by
  // the header status pill (green if either the emulator preview or the
  // mock server is running) and the Server tab body.
  useEffect(() => {
    if (!state.open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.getMockServer();
        if (!cancelled) setMockState(s);
      } catch {
        /* */
      }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [state.open]);

  const onSetRepo = useCallback((repoKey: RepoKey) => setCtx({ repoKey }), [setCtx]);

  if (!state.open) return null;

  const headerRunning = mockState?.running === true;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={close}>
      <div
        className="w-full sm:w-[520px] md:w-[640px] lg:w-[720px] h-full bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-400">📱</span>
            <h2 className="text-[11px] uppercase tracking-wider text-slate-400">Preview Panel</h2>
            <StatusPill running={headerRunning} />
          </div>
          <button
            onClick={close}
            className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-200 hover:border-slate-500"
          >
            Hide
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 px-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition " +
                (tab === t.id
                  ? "border-indigo-500 text-indigo-300"
                  : "border-transparent text-slate-500 hover:text-slate-300")
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "emulator" && (
            <EmulatorTab
              repoKey={state.ctx.repoKey}
              branch={state.ctx.branch}
              onSetRepo={onSetRepo}
              onBranchGone={state.ctx.onBranchGone}
            />
          )}
          {tab === "config" && <JsonConfigTab mockState={mockState} onMockState={setMockState} />}
          {tab === "server" && <ServerTab mockState={mockState} onMockState={setMockState} />}
        </div>
      </div>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function EmulatorTab({
  repoKey,
  branch,
  onSetRepo,
  onBranchGone,
}: {
  repoKey: RepoKey;
  branch: string;
  onSetRepo: (r: RepoKey) => void;
  onBranchGone?: () => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Platform</span>
        <div className="flex rounded border border-slate-700 overflow-hidden text-[12px]">
          <button
            onClick={() => onSetRepo("mobile")}
            className={
              "px-3 py-1 " +
              (repoKey === "mobile"
                ? "bg-indigo-600/30 text-indigo-200"
                : "text-slate-400 hover:text-slate-200")
            }
          >
            Mobile
          </button>
          <button
            onClick={() => onSetRepo("web")}
            className={
              "px-3 py-1 border-l border-slate-700 " +
              (repoKey === "web"
                ? "bg-indigo-600/30 text-indigo-200"
                : "text-slate-400 hover:text-slate-200")
            }
          >
            Web
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {/* Remount on repoKey/branch change so state resets cleanly. */}
        <EmulatorView key={`${repoKey}:${branch}`} repoKey={repoKey} branch={branch} onBranchGone={onBranchGone} />
      </div>
    </div>
  );
}

const DEFAULT_BILLING_PAYLOAD = {
  amount: 2999,
  currency: "USD",
  authentication_type: "three_ds",
  customer_id: "hyperswitch_demo_customer_id",
  capture_method: "automatic",
  email: "pradeep.kumar@juspay.in",
  request_external_three_ds_authentication: true,
  billing: {
    address: {
      line1: "1467",
      line2: "Harrison Street",
      line3: "Harrison Street",
      city: "San Fransico",
      state: "California",
      zip: "94122",
      country: "US",
      first_name: "joseph",
      last_name: "Doe",
    },
  },
  shipping: {
    address: {
      line1: "1467",
      line2: "Harrison Street",
      line3: "Harrison Street",
      city: "San Fransico",
      state: "California",
      zip: "94122",
      country: "US",
      first_name: "joseph",
      last_name: "Doe",
    },
  },
};

function JsonConfigTab({
  mockState,
  onMockState,
}: {
  mockState: MockServerState | null;
  onMockState: (s: MockServerState) => void;
}) {
  const [text, setText] = useState<string>(() =>
    mockState?.paymentIntentBody
      ? JSON.stringify(mockState.paymentIntentBody, null, 2)
      : "{\n  \n}",
  );
  const [hydrated, setHydrated] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedAt, setAppliedAt] = useState<number | null>(null);

  // Hydrate editor once from server state so we don't clobber user typing.
  useEffect(() => {
    if (!hydrated && mockState) {
      setText(JSON.stringify(mockState.paymentIntentBody ?? {}, null, 2));
      setHydrated(true);
    }
  }, [hydrated, mockState]);

  const parsed = (() => {
    try {
      const v = JSON.parse(text);
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      return v as Record<string, unknown>;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!text.trim()) {
      setParseError("body cannot be empty — use {} for default");
      return;
    }
    try {
      const v = JSON.parse(text);
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        setParseError("body must be a JSON object");
      } else {
        setParseError(null);
      }
    } catch (e) {
      setParseError((e as Error).message);
    }
  }, [text]);

  const onApply = async () => {
    if (!parsed) return;
    setApplying(true);
    try {
      const s = await api.setMockServerConfig(parsed);
      onMockState(s);
      setAppliedAt(Date.now());
    } catch (e) {
      setParseError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 p-4 overflow-y-auto">
      <CredentialsSection />

      <div className="mt-5 mb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Payment Intent Body
          </div>
          <button
            type="button"
            onClick={() => setText(JSON.stringify(DEFAULT_BILLING_PAYLOAD, null, 2))}
            title="Replace editor contents with the default billing + shipping payload"
            className="rounded border border-slate-700 px-2 py-1 text-[10px] font-medium text-slate-300 hover:border-indigo-500 hover:text-indigo-200"
          >
            Load default billing
          </button>
        </div>
        <div className="text-[11px] text-slate-500">
          Merged into <code className="text-slate-400">/create-payment-intent</code> responses.
          Empty <code>{"{}"}</code> uses the defaults (<code>amount:100, currency:USD</code>).
          Changes apply instantly — no server restart.
        </div>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="min-h-[200px] w-full rounded border border-slate-700 bg-slate-950 p-3 text-[12px] font-mono text-slate-200 focus:border-indigo-500 focus:outline-none resize-y"
      />

      <div className="mt-2 flex items-center gap-3">
        {parseError ? (
          <span className="text-[11px] text-red-400">✗ {parseError}</span>
        ) : (
          <span className="text-[11px] text-emerald-400">✓ Valid JSON</span>
        )}
        {appliedAt && (
          <span className="text-[11px] text-slate-500">
            Saved {new Date(appliedAt).toLocaleTimeString()}
            {mockState?.running
              ? " — next request uses this body"
              : " — will activate when server starts"}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onApply}
          disabled={!parsed || applying}
          title={
            mockState?.running
              ? "Apply config — next /create-payment-intent call uses this body"
              : "Save config — will take effect when the server starts"
          }
          className={
            "rounded px-4 py-2 text-[12px] font-medium transition " +
            (!parsed || applying
              ? "bg-slate-800 text-slate-600 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-500")
          }
        >
          {applying ? "Applying…" : mockState?.running ? "Save & Apply" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * Hyperswitch credentials editor. Overrides the .env values at runtime —
 * the mock merchant server on :5252 AND the Cypress runner both read
 * through a single `getCredentials()` helper on the server, so edits here
 * propagate without restarting anything.
 */
function CredentialsSection() {
  const [creds, setCreds] = useState<HyperswitchCredentials | null>(null);
  const [draft, setDraft] = useState<Partial<HyperswitchCredentials>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Partial<Record<keyof HyperswitchCredentials, boolean>>>({});

  useEffect(() => {
    let cancelled = false;
    api.getMockServerCredentials()
      .then((c) => { if (!cancelled) setCreds(c); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const field = (key: keyof HyperswitchCredentials, label: string, placeholder: string, masked = true) => {
    const effective = draft[key] !== undefined ? draft[key]! : creds?.[key] ?? "";
    const show = !masked || reveal[key];
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-slate-500">{label}</label>
          {masked && (
            <button
              type="button"
              onClick={() => setReveal((r) => ({ ...r, [key]: !r[key] }))}
              className="text-[10px] text-slate-500 hover:text-slate-300"
            >
              {show ? "hide" : "show"}
            </button>
          )}
        </div>
        <input
          type={show ? "text" : "password"}
          value={effective}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-[12px] font-mono text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
        />
      </div>
    );
  };

  const onSave = async () => {
    if (Object.keys(draft).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setMockServerCredentials(draft);
      setCreds(updated);
      setDraft({});
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="rounded border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Hyperswitch Credentials</div>
        {savedAt && (
          <span className="text-[10px] text-emerald-400">
            saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="text-[11px] text-slate-500 mb-3">
        Overrides apply instantly to the mock merchant server on :5252 and to Cypress env.
        Leave a field empty to fall back to the dashboard's <code className="text-slate-400">.env</code>.
      </div>
      <div className="grid grid-cols-1 gap-2">
        {field("publishableKey",  "Publishable Key", "pk_snd_…")}
        {field("secretKey",       "Secret Key",       "snd_…")}
        {field("profileId",       "Profile ID",       "pro_…", false)}
        {field("netceteraApiKey", "Netcetera API Key","…")}
        {field("baseUrl",         "Sandbox URL",      "https://sandbox.hyperswitch.io", false)}
      </div>
      {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft({})}
            className="rounded border border-slate-700 px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={
            "rounded px-3 py-1.5 text-[11px] font-medium transition " +
            (!dirty || saving
              ? "bg-slate-800 text-slate-600 cursor-not-allowed"
              : "bg-indigo-600 text-white hover:bg-indigo-500")
          }
        >
          {saving ? "Saving…" : "Save Credentials"}
        </button>
      </div>
    </div>
  );
}

function ServerTab({
  mockState,
  onMockState,
}: {
  mockState: MockServerState | null;
  onMockState: (s: MockServerState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const sinceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const t = await api.tailMockServerLogs(sinceRef.current);
        if (cancelled) return;
        if (t.lines.length > 0) {
          setLogs((prev) => [...prev, ...t.lines].slice(-200));
        }
        sinceRef.current = t.total;
      } catch {
        /* */
      }
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const onStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.startMockServer();
      onMockState(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.stopMockServer();
      onMockState(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const port = mockState?.port ?? 5252;
  const running = mockState?.running === true;
  const url = `http://localhost:${port}/create-payment-intent`;

  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-4 overflow-y-auto">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Server URL</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-[12px] text-slate-300 truncate">
            {url}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(url).catch(() => {})}
            className="rounded border border-slate-700 px-3 py-2 text-[11px] text-slate-300 hover:border-slate-500"
          >
            Copy
          </button>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">
          Android emulator reaches this at <code>http://10.0.2.2:{port}/create-payment-intent</code> —
          MainActivity.kt is already pointed there.
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Port</div>
        <input
          readOnly
          value={port}
          className="w-28 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-[12px] text-slate-300"
        />
      </div>

      <div className="flex items-center gap-2">
        {running ? (
          <button
            onClick={onStop}
            disabled={busy}
            className="flex-1 rounded bg-red-600 px-4 py-2.5 text-[13px] font-medium text-white hover:bg-red-500 disabled:bg-slate-700"
          >
            {busy ? "Stopping…" : "■ Stop"}
          </button>
        ) : (
          <button
            onClick={onStart}
            disabled={busy}
            className="flex-1 rounded bg-emerald-600 px-4 py-2.5 text-[13px] font-medium text-white hover:bg-emerald-500 disabled:bg-slate-700"
          >
            {busy ? "Starting…" : "▶ Start"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
          Serving Endpoint
        </div>
        <div className="rounded border border-indigo-500/40 bg-indigo-500/5 px-3 py-2">
          <div className="text-[12px] font-mono text-indigo-300">/create-payment-intent</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Body keys: {summarizeBody(mockState?.paymentIntentBody)}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Server Logs</div>
          <button
            onClick={() => {
              setLogs([]);
              sinceRef.current = 0;
            }}
            className="text-[11px] text-slate-500 hover:text-slate-300"
          >
            Clear
          </button>
        </div>
        <pre className="flex-1 min-h-[120px] rounded border border-slate-800 bg-slate-950 p-3 text-[11px] leading-tight text-slate-400 font-mono whitespace-pre-wrap overflow-y-auto">
          {logs.length === 0 ? "No logs yet…" : logs.join("\n")}
        </pre>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function summarizeBody(body: Record<string, unknown> | undefined): string {
  if (!body) return "(none)";
  const keys = Object.keys(body);
  if (keys.length === 0) return "defaults only (amount:100, currency:USD)";
  return keys.join(", ");
}

function StatusPill({ running }: { running: boolean }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] " +
        (running
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
          : "border-slate-600 bg-slate-700/40 text-slate-400")
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + (running ? "bg-emerald-400" : "bg-slate-500")} />
      {running ? "Running" : "Stopped"}
    </span>
  );
}
