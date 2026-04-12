import { useRef, useState } from "react";
import {
  generateIntegration,
  type IntegrationSpec,
  type IntegrationSSEEvent,
  type IntegrationEnvelope,
  type SdkClassification,
} from "../../api";
import type { SkillFormProps } from "../registry";

const REPOS = [
  { id: "mobile", label: "Mobile SDK", description: "hyperswitch-client-core (ReScript + native)" },
  { id: "rn_packages", label: "NPM Packages", description: "react-native-hyperswitch (Swift/Kotlin/TS)" },
  { id: "web", label: "Web SDK", description: "hyperswitch-web (ReScript)" },
] as const;

const PLATFORMS = [
  { id: "ios", label: "iOS Native", description: "Swift + .mm bridge" },
  { id: "android", label: "Android Native", description: "Kotlin module" },
  { id: "rescript_mobile", label: "ReScript Mobile", description: "Module + view bindings" },
  { id: "rescript_web", label: "ReScript Web", description: "Web component" },
] as const;

const SDK_TYPE_HINTS = [
  { value: "", label: "Auto-detect from documentation" },
  { value: "simple callback", label: "Simple Callback (e.g., ScanCard)" },
  { value: "browser switch / deep link", label: "Browser Switch (e.g., PayPal, Klarna)" },
  { value: "activity result / intent", label: "Activity Result (e.g., Google Pay)" },
  { value: "iframe / webview", label: "Iframe / WebView embed" },
  { value: "JS-only / script tag", label: "JS-only SDK (no native code)" },
];

interface ProgressEntry {
  repo?: string;
  message: string;
  type: IntegrationSSEEvent["type"];
  timestamp: number;
  classification?: SdkClassification;
}

export function IntegrationForm({ onResult, onError }: SkillFormProps) {
  const [sdkName, setSdkName] = useState("");
  const [sdkDoc, setSdkDoc] = useState("");
  const [sdkTypeHint, setSdkTypeHint] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [repos, setRepos] = useState<Set<string>>(new Set(["mobile", "rn_packages"]));
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(["ios", "android", "rescript_mobile"]));
  const [newPackage, setNewPackage] = useState(false);
  const [newPackageName, setNewPackageName] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);

  const toggleSet = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSdkDoc(reader.result as string);
    reader.readAsText(file);
  };

  const onSubmit = () => {
    if (!sdkName.trim() || !sdkDoc.trim() || repos.size === 0 || platforms.size === 0) return;

    const spec: IntegrationSpec = {
      sdkName: sdkName.trim(),
      sdkDoc: sdkDoc.trim(),
      sdkTypeHint: sdkTypeHint || undefined,
      repos: Array.from(repos) as IntegrationSpec["repos"],
      platforms: Array.from(platforms),
      newPackage,
      newPackageName: newPackage ? newPackageName.trim() || undefined : undefined,
      additionalContext: additionalContext.trim() || undefined,
    };

    setGenerating(true);
    setProgress([]);

    abortRef.current = generateIntegration(
      spec,
      (event: IntegrationSSEEvent) => {
        const entry: ProgressEntry = {
          repo: event.repo,
          message: event.message,
          type: event.type,
          timestamp: Date.now(),
        };
        if (event.type === "classify" && event.data) {
          entry.classification = event.data as SdkClassification;
        }
        setProgress((prev) => [...prev, entry]);
        setTimeout(() => progressEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      },
      (envelope: IntegrationEnvelope) => {
        setGenerating(false);
        onResult({
          skillId: "integration",
          status: envelope.status,
          results: envelope.results,
          meta: {
            sdkName: envelope.meta?.sdkName,
            classification: envelope.meta?.classification,
            reviewLogs: Object.fromEntries(
              Object.entries(envelope.results).map(([k, v]) => [k, v.reviewLog]),
            ),
          },
        });
      },
      (msg: string) => {
        setGenerating(false);
        onError(msg);
      },
    );
  };

  const onCancel = () => {
    abortRef.current?.abort();
    setGenerating(false);
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">SDK Integration</h2>
      <p className="text-sm text-slate-500 mb-6">
        Paste a vendor's SDK documentation and the AI will analyze the integration pattern, implement it, and review the result.
      </p>

      {/* SDK Name */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">SDK Name</label>
        <input
          type="text"
          value={sdkName}
          onChange={(e) => setSdkName(e.target.value)}
          placeholder="PayPal, Klarna, Google Pay..."
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
        />
      </div>

      {/* SDK Documentation */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs text-slate-400">SDK Documentation</label>
          <label className="text-xs text-orange-400 hover:text-orange-300 cursor-pointer">
            Upload .md
            <input type="file" accept=".md,.txt,.markdown" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
        <textarea
          value={sdkDoc}
          onChange={(e) => setSdkDoc(e.target.value)}
          rows={8}
          placeholder="Paste the vendor's SDK integration documentation here, or upload a .md file..."
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none resize-none font-mono"
        />
      </div>

      {/* Target Repos */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-2">Target Repos</label>
        <div className="flex flex-wrap gap-2">
          {REPOS.map((r) => (
            <button
              key={r.id}
              onClick={() => setRepos((prev) => toggleSet(prev, r.id))}
              className={
                "rounded-lg border px-3 py-2 text-left transition " +
                (repos.has(r.id)
                  ? "border-orange-500 bg-orange-500/10"
                  : "border-slate-700 hover:border-slate-500")
              }
            >
              <div className={"text-xs font-medium " + (repos.has(r.id) ? "text-orange-200" : "text-slate-400")}>
                {r.label}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">{r.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Target Platforms */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-2">Target Platforms</label>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlatforms((prev) => toggleSet(prev, p.id))}
              className={
                "rounded-lg border px-3 py-2 text-left transition " +
                (platforms.has(p.id)
                  ? "border-orange-500 bg-orange-500/10"
                  : "border-slate-700 hover:border-slate-500")
              }
            >
              <div className={"text-xs font-medium " + (platforms.has(p.id) ? "text-orange-200" : "text-slate-400")}>
                {p.label}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">{p.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* New Package toggle */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => setNewPackage(!newPackage)}
          className={
            "rounded border px-3 py-1.5 text-xs transition " +
            (newPackage
              ? "border-orange-500 bg-orange-500/10 text-orange-200"
              : "border-slate-700 text-slate-400 hover:border-slate-500")
          }
        >
          {newPackage ? "New Package" : "Existing Package"}
        </button>
        {newPackage && (
          <input
            type="text"
            value={newPackageName}
            onChange={(e) => setNewPackageName(e.target.value)}
            placeholder="react-native-hyperswitch-{name}"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
          />
        )}
      </div>

      {/* Advanced: SDK type hint + additional context */}
      <div className="mb-6">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-slate-500 hover:text-slate-300 mb-2 flex items-center gap-1"
        >
          <span className="text-slate-600">{showAdvanced ? "v" : ">"}</span>
          Advanced options
        </button>
        {showAdvanced && (
          <div className="space-y-3 pl-3 border-l border-slate-800">
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                SDK Type Hint <span className="text-slate-600">(auto-detected if empty)</span>
              </label>
              <select
                value={sdkTypeHint}
                onChange={(e) => setSdkTypeHint(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-orange-500 focus:outline-none"
              >
                {SDK_TYPE_HINTS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Additional Context <span className="text-slate-600">(optional)</span>
              </label>
              <textarea
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                rows={2}
                placeholder="Any extra instructions, API keys config, or notes..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none resize-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* Progress display */}
      {progress.length > 0 && (
        <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950 p-3 max-h-48 overflow-y-auto">
          {progress.map((p, i) => (
            <div key={i} className="flex items-start gap-2 text-xs py-0.5">
              <span className={
                p.type === "error" ? "text-red-400" :
                p.type === "classify" ? "text-cyan-400" :
                p.type === "review_result" ? "text-violet-400" :
                p.type === "repo_done" ? "text-emerald-400" :
                p.type === "done" ? "text-emerald-300 font-medium" :
                "text-slate-500"
              }>
                {p.type === "error" ? "x" :
                 p.type === "classify" ? "?" :
                 p.type === "review_result" ? "R" :
                 p.type === "repo_done" ? "+" :
                 p.type === "done" ? "+" :
                 ">"}
              </span>
              {p.repo && <span className="text-orange-400 font-mono">[{p.repo}]</span>}
              <span className="text-slate-300">{p.message}</span>
            </div>
          ))}
          <div ref={progressEndRef} />
        </div>
      )}

      {/* Submit / Cancel */}
      <div className="flex gap-3">
        <button
          onClick={generating ? onCancel : onSubmit}
          disabled={!generating && (!sdkName.trim() || !sdkDoc.trim() || repos.size === 0 || platforms.size === 0)}
          className={
            "rounded-lg px-5 py-2.5 font-medium text-white transition " +
            (generating
              ? "bg-red-700 hover:bg-red-600"
              : !sdkName.trim() || !sdkDoc.trim() || repos.size === 0 || platforms.size === 0
                ? "bg-slate-700 cursor-not-allowed text-slate-500"
                : "bg-orange-600 hover:bg-orange-500")
          }
        >
          {generating ? (
            <span className="inline-flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              Cancel
            </span>
          ) : (
            "Generate Integration"
          )}
        </button>
      </div>
    </div>
  );
}
