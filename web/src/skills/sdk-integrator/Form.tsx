import { useRef, useState } from "react";
import {
  classifySdk,
  generateIntegration,
  type IntegrationSpec,
  type IntegrationSSEEvent,
  type IntegrationEnvelope,
  type SdkClassification,
  type UiEntryPoint,
  type ApiChainKnownPattern,
  type ConfirmTiming,
} from "../../api";
import type { SkillFormProps } from "../registry";

// ─── Constants ───────────────────────────────────────────────────────────────

const TARGETS = [
  { id: "mobile", label: "Mobile SDK", description: "hyperswitch-client-core + react-native-hyperswitch" },
  { id: "web", label: "Web SDK", description: "hyperswitch-web (ReScript)" },
] as const;

const MOBILE_SUB_REPOS = [
  { id: "client_core", label: "client-core", description: "ReScript hooks, modules, types" },
  { id: "rn_packages", label: "rn-packages", description: "Native iOS/Android modules + TS bridge" },
] as const;

const PLATFORMS = [
  { id: "ios", label: "iOS Native", description: "Swift + .mm bridge" },
  { id: "android", label: "Android Native", description: "Kotlin module" },
  { id: "rescript_mobile", label: "ReScript Mobile", description: "Module + view bindings" },
  { id: "rescript_web", label: "ReScript Web", description: "Web component" },
] as const;

const UI_ENTRY_POINTS: { value: UiEntryPoint; label: string; example: string }[] = [
  { value: "native_view", label: "Native View", example: "Google Pay, Apple Pay, Klarna" },
  { value: "custom_trigger_button", label: "Custom Trigger Button", example: "PayPal (RN button → launch)" },
  { value: "invisible", label: "Invisible / Programmatic", example: "Netcetera 3DS, Kount" },
  { value: "utility_ui", label: "Utility UI", example: "ScanCard camera" },
  { value: "other", label: "Other", example: "" },
];

const API_CHAIN_PATTERNS: { value: ApiChainKnownPattern; label: string; example: string }[] = [
  { value: "session_direct", label: "Session Direct", example: "session_tokens -> SDK (GPay, ApplePay)" },
  { value: "session_post_session", label: "Session + Post Session", example: "session_tokens -> post_session_tokens -> SDK (PayPal)" },
  { value: "confirm_next_action", label: "Confirm + Next Action", example: "confirm -> next_action handler (Netcetera, Plaid)" },
  { value: "no_api", label: "No API", example: "SDK runs independently (ScanCard, Kount)" },
  { value: "custom", label: "Custom", example: "New pattern not in codebase" },
];

const CONFIRM_TIMINGS: { value: ConfirmTiming; label: string; example: string }[] = [
  { value: "post_sdk_with_data", label: "Post-SDK with Data", example: "SDK returns token used in confirm (GPay)" },
  { value: "post_sdk_status_only", label: "Post-SDK Status Only", example: "SDK completes, then confirm (PayPal)" },
  { value: "pre_sdk", label: "Pre-SDK", example: "Confirm first, SDK from response (Netcetera)" },
  { value: "not_applicable", label: "Not Applicable", example: "No confirm (ScanCard)" },
  { value: "custom", label: "Custom", example: "Something else" },
];

type Step = "input" | "classify" | "generate";

interface ProgressEntry {
  repo?: string;
  message: string;
  type: IntegrationSSEEvent["type"];
  data?: unknown;
  timestamp: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SdkIntegratorForm({ onResult, onError }: SkillFormProps) {
  // Step 1 state
  const [sdkName, setSdkName] = useState("");
  const [sdkDoc, setSdkDoc] = useState("");
  const [targets, setTargets] = useState<Set<string>>(new Set(["mobile"]));
  const [mobileSubRepos, setMobileSubRepos] = useState<Set<string>>(new Set(["client_core", "rn_packages"]));
  const [platforms, setPlatforms] = useState<Set<string>>(new Set(["ios", "android", "rescript_mobile"]));
  const [packageNameOverride, setPackageNameOverride] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(new Set());

  // Step 2 state
  const [classification, setClassification] = useState<SdkClassification | null>(null);
  const [classifying, setClassifying] = useState(false);

  // Step 3 state
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const progressEndRef = useRef<HTMLDivElement>(null);
  // Accumulate coder_prompt SSE payloads (keyed by repo) so onResult can pass them through.
  const promptsRef = useRef<Record<string, string>>({});

  // Current step
  const step: Step = generating || progress.length > 0
    ? "generate"
    : classification
      ? "classify"
      : "input";

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

  // Step 1 → Step 2: Classify via AI
  const onClassify = async () => {
    if (!sdkName.trim() || !sdkDoc.trim()) return;
    setClassifying(true);
    try {
      const result = await classifySdk(sdkDoc.trim());
      setClassification(result);
    } catch (e) {
      onError(`Classification failed: ${(e as Error).message}`);
    } finally {
      setClassifying(false);
    }
  };

  // Step 1 → Step 2: Manual classification (skip AI)
  const onManualClassify = () => {
    setClassification({
      pattern: "",
      callbackMechanism: "",
      requiresActivity: false,
      requiresUrlScheme: false,
      hasNativeUI: false,
      notes: "",
      uiEntryPoint: "other",
      apiChain: { knownPattern: "no_api", steps: [] },
      confirmTiming: "not_applicable",
      targetFiles: [],
    });
  };

  // Step 2 → Step 1: Go back
  const onBackToInput = () => {
    setClassification(null);
    setProgress([]);
  };

  // Step 2 → Step 3: Generate
  const onGenerate = () => {
    if (!classification || targets.size === 0 || platforms.size === 0) return;

    const spec: IntegrationSpec = {
      sdkName: sdkName.trim(),
      sdkDoc: sdkDoc.trim(),
      classification,
      targets: Array.from(targets) as IntegrationSpec["targets"],
      platforms: Array.from(platforms),
      packageNameOverride: packageNameOverride.trim() || undefined,
      baseBranch: baseBranch.trim() || undefined,
      additionalContext: additionalContext.trim() || undefined,
      mobileSubRepos: targets.has("mobile")
        ? Array.from(mobileSubRepos) as IntegrationSpec["mobileSubRepos"]
        : undefined,
    };

    setGenerating(true);
    setProgress([]);
    promptsRef.current = {};

    abortRef.current = generateIntegration(
      spec,
      (event: IntegrationSSEEvent) => {
        if (event.type === "coder_prompt" && event.repo) {
          const text = (event.data as { prompt?: string } | undefined)?.prompt;
          if (text) promptsRef.current[event.repo] = text;
        }
        const entry: ProgressEntry = {
          repo: event.repo,
          message: event.message,
          type: event.type,
          data: event.data,
          timestamp: Date.now(),
        };
        setProgress((prev) => [...prev, entry]);
        setTimeout(() => progressEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      },
      (envelope: IntegrationEnvelope) => {
        setGenerating(false);
        onResult({
          skillId: "sdk-integrator",
          status: envelope.status,
          results: envelope.results,
          meta: {
            sdkName: envelope.meta?.sdkName,
            classification: envelope.meta?.classification,
            reviewLogs: Object.fromEntries(
              Object.entries(envelope.results).map(([k, v]) => [k, v.reviewLog]),
            ),
            prompts: { ...promptsRef.current },
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
      <p className="text-sm text-slate-500 mb-4">
        Paste a vendor's SDK documentation, analyze the integration pattern, confirm/edit the classification, then generate.
      </p>

      {/* Step indicator */}
      <StepIndicator current={step} classifying={classifying} />

      {/* ── Step 1: Input ────────────────────────────────────────── */}
      {step === "input" && (
        <>
          {/* Section: SDK Info */}
          <SectionHeader title="SDK Info" subtitle="Name and vendor documentation." />

          <div className="mb-5">
            <label className="block text-xs text-slate-400 mb-1">SDK Name</label>
            <input
              type="text"
              value={sdkName}
              onChange={(e) => setSdkName(e.target.value)}
              placeholder="PayPal, Klarna, Google Pay..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none"
            />
          </div>

          <div className="mb-6">
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

          {/* Section: Integration Targets */}
          <SectionHeader
            title="Integration Targets"
            subtitle="Which SDKs, sub-repos, and native platforms to generate for."
          />

          <div className="mb-5">
            <label className="block text-xs text-slate-400 mb-2">Target SDKs</label>
            <div className="flex flex-wrap gap-2">
              {TARGETS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setTargets((prev) => toggleSet(prev, r.id))}
                  className={
                    "rounded-lg border px-3 py-2 text-left transition " +
                    (targets.has(r.id)
                      ? "border-orange-500 bg-orange-500/10"
                      : "border-slate-700 hover:border-slate-500")
                  }
                >
                  <div className={"text-xs font-medium " + (targets.has(r.id) ? "text-orange-200" : "text-slate-400")}>
                    {r.label}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">{r.description}</div>
                </button>
              ))}
            </div>

            {/* Mobile sub-repo selection */}
            {targets.has("mobile") && (
              <div className="mt-2 ml-4 pl-3 border-l border-orange-500/30 space-y-1">
                {MOBILE_SUB_REPOS.map((sub) => (
                  <label
                    key={sub.id}
                    className="flex items-center gap-2 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={mobileSubRepos.has(sub.id)}
                      onChange={() => setMobileSubRepos((prev) => toggleSet(prev, sub.id))}
                      className="accent-orange-500"
                    />
                    <span className={"text-xs " + (mobileSubRepos.has(sub.id) ? "text-orange-200" : "text-slate-500")}>
                      {sub.label}
                    </span>
                    <span className="text-xs text-slate-600 group-hover:text-slate-500">{sub.description}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="mb-6">
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

          {/* Section: Options */}
          <SectionHeader
            title="Options"
            subtitle="Customise the package name or add context. Safe to leave everything blank."
          />

          {/* Package name override — only when rn_packages is selected */}
          {targets.has("mobile") && mobileSubRepos.has("rn_packages") && (
            <div className="mb-5">
              <label className="block text-xs text-slate-400 mb-1">
                NPM Package Name <span className="text-slate-600">(optional — auto-derived from SDK name)</span>
              </label>
              <input
                type="text"
                value={packageNameOverride}
                onChange={(e) => setPackageNameOverride(e.target.value)}
                placeholder={`react-native-hyperswitch-${sdkName.trim().toLowerCase() || "{sdk-name}"}`}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none font-mono"
              />
              <p className="mt-1 text-xs text-slate-600">
                Leave blank unless the package already exists under a non-standard name. The scaffolder runs automatically if the package doesn't exist yet.
              </p>
            </div>
          )}

          {/* Base branch — extend an existing feature branch instead of main */}
          <div className="mb-5">
            <label className="block text-xs text-slate-400 mb-1">
              Base Branch <span className="text-slate-600">(optional — defaults to main)</span>
            </label>
            <input
              type="text"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder="main"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-orange-500 focus:outline-none font-mono"
            />
            <p className="mt-1 text-xs text-slate-600">
              Fill in when extending work that already exists on another feature branch (e.g. adding a new payment method to a package being built in another PR). The feature branch is created off this branch instead of main, and the scaffolder skips if the package already exists.
            </p>
          </div>

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

          {/* Analyze / Manual buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClassify}
              disabled={classifying || !sdkName.trim() || !sdkDoc.trim() || targets.size === 0 || platforms.size === 0}
              className={
                "rounded-lg px-5 py-2.5 font-medium text-white transition " +
                (classifying
                  ? "bg-cyan-700 cursor-wait"
                  : !sdkName.trim() || !sdkDoc.trim() || targets.size === 0 || platforms.size === 0
                    ? "bg-slate-700 cursor-not-allowed text-slate-500"
                    : "bg-cyan-600 hover:bg-cyan-500")
              }
            >
              {classifying ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner />
                  Analyzing SDK...
                </span>
              ) : (
                "Analyze SDK"
              )}
            </button>
            <button
              onClick={onManualClassify}
              disabled={classifying || !sdkName.trim() || targets.size === 0 || platforms.size === 0}
              className={
                "rounded-lg px-5 py-2.5 font-medium transition border " +
                (classifying || !sdkName.trim() || targets.size === 0 || platforms.size === 0
                  ? "border-slate-700 text-slate-600 cursor-not-allowed"
                  : "border-slate-600 text-slate-300 hover:border-slate-400 hover:text-slate-100")
              }
            >
              Configure Manually
            </button>
          </div>
        </>
      )}

      {/* ── Step 2: Classification Confirmation ──────────────────── */}
      {step === "classify" && classification && (
        <>
          <ClassificationCard
            classification={classification}
            onChange={setClassification}
          />

          <div className="flex gap-3 mt-6">
            <button
              onClick={onBackToInput}
              className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 hover:border-slate-500 transition"
            >
              Back
            </button>
            <button
              onClick={onGenerate}
              className="rounded-lg px-5 py-2.5 font-medium text-white bg-orange-600 hover:bg-orange-500 transition"
            >
              Generate Integration
            </button>
          </div>
        </>
      )}

      {/* ── Step 3: Generation Progress ──────────────────────────── */}
      {step === "generate" && (
        <>
          {progress.length > 0 && (
            <div className="mb-4 rounded-lg border border-slate-800 bg-slate-950 p-3 max-h-96 overflow-y-auto font-mono">
              {progress.map((p, i) => {
                // tool_result is noisy — only render if it signals an error
                if (p.type === "tool_result") {
                  const errored = (p.data as { isError?: boolean } | undefined)?.isError === true;
                  if (!errored) return null;
                }

                // coder_prompt: render as a collapsible row that expands to show the full prompt text.
                if (p.type === "coder_prompt") {
                  const promptText = (p.data as { prompt?: string } | undefined)?.prompt ?? "";
                  const expanded = expandedPrompts.has(i);
                  return (
                    <div key={i} className="py-1">
                      <button
                        onClick={() =>
                          setExpandedPrompts((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                        className="flex items-start gap-2 text-xs w-full text-left hover:text-slate-200"
                      >
                        <span className="text-slate-500">{expanded ? "v" : ">"}</span>
                        {p.repo && <span className="text-orange-400/70">[{p.repo}]</span>}
                        <span className="text-slate-400">
                          {p.message} <span className="text-slate-600">({promptText.length.toLocaleString()} chars)</span>
                        </span>
                      </button>
                      {expanded && (
                        <pre className="mt-1 rounded border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300 font-mono whitespace-pre-wrap max-h-96 overflow-y-auto">
                          {promptText}
                        </pre>
                      )}
                    </div>
                  );
                }

                const isPhase = p.type === "phase";
                const rowClass = isPhase
                  ? "flex items-start gap-2 text-xs py-1 mt-1 border-t border-slate-800 pt-1.5"
                  : "flex items-start gap-2 text-xs py-0.5";

                const iconAndColor = (() => {
                  switch (p.type) {
                    case "error": return { icon: "x", color: "text-red-400" };
                    case "phase": return { icon: "▸", color: "text-orange-400 font-semibold" };
                    case "tool_use": return { icon: "⚙", color: "text-cyan-400" };
                    case "tool_result": return { icon: "!", color: "text-red-300" };
                    case "text": return { icon: " ", color: "text-slate-400" };
                    case "review_start": return { icon: "R", color: "text-violet-300" };
                    case "review_result": return { icon: "R", color: "text-violet-400" };
                    case "fix_start": return { icon: "F", color: "text-amber-400" };
                    case "repo_done": return { icon: "+", color: "text-emerald-400" };
                    case "done": return { icon: "+", color: "text-emerald-300 font-medium" };
                    default: return { icon: ">", color: "text-slate-500" };
                  }
                })();

                return (
                  <div key={i} className={rowClass}>
                    <span className={iconAndColor.color}>{iconAndColor.icon}</span>
                    {p.repo && !isPhase && <span className="text-orange-400/70">[{p.repo}]</span>}
                    <span className={isPhase ? "text-orange-200" : "text-slate-300"}>
                      {p.message}
                    </span>
                  </div>
                );
              })}
              <div ref={progressEndRef} />
            </div>
          )}

          {generating && (
            <button
              onClick={onCancel}
              className="rounded-lg px-5 py-2.5 font-medium text-white bg-red-700 hover:bg-red-600 transition"
            >
              <span className="inline-flex items-center gap-2">
                <Spinner />
                Cancel
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3 mt-5 first:mt-0">
      <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div>}
      <div className="mt-2 h-px bg-slate-800" />
    </div>
  );
}

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ current, classifying }: { current: Step; classifying: boolean }) {
  const steps: { key: Step; label: string }[] = [
    { key: "input", label: "1. SDK Details" },
    { key: "classify", label: "2. Confirm Classification" },
    { key: "generate", label: "3. Generate" },
  ];

  return (
    <div className="flex items-center gap-1 mb-6">
      {steps.map((s, i) => {
        const isActive = s.key === current;
        const isPast = steps.findIndex((x) => x.key === current) > i;
        const isClassifying = s.key === "classify" && classifying && current === "input";
        return (
          <div key={s.key} className="flex items-center gap-1">
            {i > 0 && <div className={"w-6 h-px " + (isPast ? "bg-orange-500" : "bg-slate-700")} />}
            <div
              className={
                "rounded-full px-3 py-1 text-xs font-medium transition " +
                (isActive
                  ? "bg-orange-500/20 text-orange-300 border border-orange-500"
                  : isPast
                    ? "bg-orange-500/10 text-orange-400 border border-orange-500/50"
                    : isClassifying
                      ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/50"
                      : "text-slate-600 border border-slate-800")
              }
            >
              {isClassifying ? "Analyzing..." : s.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Classification Card ─────────────────────────────────────────────────────

function ClassificationCard({
  classification: c,
  onChange,
}: {
  classification: SdkClassification;
  onChange: (c: SdkClassification) => void;
}) {
  const [showTechnical, setShowTechnical] = useState(false);

  const update = (patch: Partial<SdkClassification>) =>
    onChange({ ...c, ...patch });

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-950/20 p-4 space-y-5">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full bg-cyan-400" />
        <h3 className="text-sm font-medium text-cyan-200">SDK Classification</h3>
        <span className="text-xs text-slate-500 ml-auto">Edit any field before generating</span>
      </div>

      {/* Pattern summary */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">Pattern Summary</label>
        <input
          type="text"
          value={c.pattern}
          onChange={(e) => update({ pattern: e.target.value })}
          className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none"
        />
      </div>

      {/* 3-column classification dimensions */}
      <div className="grid grid-cols-3 gap-4">
        {/* UI Entry Point */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">UI Entry Point</label>
          {UI_ENTRY_POINTS.map((opt) => (
            <label
              key={opt.value}
              className={
                "flex items-start gap-2 rounded px-2 py-1 cursor-pointer transition " +
                (c.uiEntryPoint === opt.value
                  ? "bg-cyan-500/10 border border-cyan-500/30"
                  : "hover:bg-slate-800/50 border border-transparent")
              }
            >
              <input
                type="radio"
                name="uiEntryPoint"
                checked={c.uiEntryPoint === opt.value}
                onChange={() => update({ uiEntryPoint: opt.value })}
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-xs text-slate-200">{opt.label}</div>
                {opt.example && <div className="text-xs text-slate-600">{opt.example}</div>}
              </div>
            </label>
          ))}
        </div>

        {/* API Chain Pattern */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">API Chain</label>
          {API_CHAIN_PATTERNS.map((opt) => (
            <label
              key={opt.value}
              className={
                "flex items-start gap-2 rounded px-2 py-1 cursor-pointer transition " +
                (c.apiChain.knownPattern === opt.value
                  ? "bg-cyan-500/10 border border-cyan-500/30"
                  : "hover:bg-slate-800/50 border border-transparent")
              }
            >
              <input
                type="radio"
                name="apiChainPattern"
                checked={c.apiChain.knownPattern === opt.value}
                onChange={() =>
                  update({
                    apiChain: { ...c.apiChain, knownPattern: opt.value },
                  })
                }
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-xs text-slate-200">{opt.label}</div>
                <div className="text-xs text-slate-600">{opt.example}</div>
              </div>
            </label>
          ))}
          {c.apiChain.knownPattern === "custom" && (
            <textarea
              value={c.apiChain.description ?? ""}
              onChange={(e) =>
                update({ apiChain: { ...c.apiChain, description: e.target.value } })
              }
              rows={2}
              placeholder="Describe the custom API chain..."
              className="w-full mt-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none resize-none"
            />
          )}
        </div>

        {/* Confirm Timing */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Confirm Timing</label>
          {CONFIRM_TIMINGS.map((opt) => (
            <label
              key={opt.value}
              className={
                "flex items-start gap-2 rounded px-2 py-1 cursor-pointer transition " +
                (c.confirmTiming === opt.value
                  ? "bg-cyan-500/10 border border-cyan-500/30"
                  : "hover:bg-slate-800/50 border border-transparent")
              }
            >
              <input
                type="radio"
                name="confirmTiming"
                checked={c.confirmTiming === opt.value}
                onChange={() => update({ confirmTiming: opt.value })}
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-xs text-slate-200">{opt.label}</div>
                <div className="text-xs text-slate-600">{opt.example}</div>
              </div>
            </label>
          ))}
          {c.confirmTiming === "custom" && (
            <textarea
              value={c.notes.includes("[confirm-timing]")
                ? c.notes.split("[confirm-timing]")[1]?.split("[/confirm-timing]")[0]?.trim() ?? ""
                : ""}
              onChange={(e) => {
                // Store custom confirm timing description in notes with a tag
                const stripped = c.notes.replace(/\[confirm-timing\].*?\[\/confirm-timing\]/s, "").trim();
                const newNotes = e.target.value
                  ? `${stripped} [confirm-timing]${e.target.value}[/confirm-timing]`.trim()
                  : stripped;
                update({ notes: newNotes });
              }}
              rows={2}
              placeholder="Describe the custom confirm timing..."
              className="w-full mt-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none resize-none"
            />
          )}
        </div>
      </div>

      {/* Hyperswitch-specific fields */}
      <div>
        <div className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wider">
          Hyperswitch-specific (fill in if known)
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Wallet Variant</label>
            <input
              type="text"
              value={c.walletVariant ?? ""}
              onChange={(e) => update({ walletVariant: e.target.value || undefined })}
              placeholder="PAYPAL, GOOGLE_PAY..."
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">sdk_next_action</label>
            <input
              type="text"
              value={c.sdkNextAction ?? ""}
              onChange={(e) => update({ sdkNextAction: e.target.value || undefined })}
              placeholder="post_session_tokens..."
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">next_action.type</label>
            <input
              type="text"
              value={c.nextActionType ?? ""}
              onChange={(e) => update({ nextActionType: e.target.value || undefined })}
              placeholder="three_ds_invoke..."
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Payment Experience</label>
            <input
              type="text"
              value={c.paymentExperience ?? ""}
              onChange={(e) => update({ paymentExperience: e.target.value || undefined })}
              placeholder="invoke_sdk_client..."
              className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Derived: reference pattern + target files */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Reference Pattern</label>
          <div className="text-xs text-orange-300 font-mono bg-slate-950 rounded border border-slate-800 px-2 py-1.5">
            {c.referencePattern || "\u2014"}
          </div>
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Target Files</label>
          <div className="text-xs text-slate-300 bg-slate-950 rounded border border-slate-800 px-2 py-1.5 max-h-20 overflow-y-auto">
            {c.targetFiles.length > 0
              ? c.targetFiles.map((f, i) => (
                  <div key={i} className="font-mono text-orange-300/80">{f}</div>
                ))
              : <span className="text-slate-600">None derived</span>
            }
          </div>
        </div>
      </div>

      {/* API chain steps (read-only display) */}
      {c.apiChain.steps.length > 0 && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">API Chain Steps</label>
          <div className="space-y-1">
            {c.apiChain.steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="text-slate-600 font-mono w-4">{i + 1}.</span>
                <span className="text-cyan-300 font-mono">{step.endpoint}</span>
                {step.triggerField && (
                  <span className="text-slate-500">
                    trigger: {step.triggerField}{step.triggerValue ? ` = ${step.triggerValue}` : ""}
                  </span>
                )}
                {step.extractedData && step.extractedData.length > 0 && (
                  <span className="text-slate-500">
                    extract: {step.extractedData.join(", ")}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Technical Details (collapsible) */}
      <div>
        <button
          onClick={() => setShowTechnical(!showTechnical)}
          className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1"
        >
          <span className="text-slate-600">{showTechnical ? "v" : ">"}</span>
          Technical Details
        </button>
        {showTechnical && (
          <div className="mt-2 space-y-3 pl-3 border-l border-slate-800">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Callback Mechanism</label>
              <input
                type="text"
                value={c.callbackMechanism}
                onChange={(e) => update({ callbackMechanism: e.target.value })}
                placeholder="Deep link, delegate, completion handler..."
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.requiresActivity}
                  onChange={(e) => update({ requiresActivity: e.target.checked })}
                  className="accent-cyan-500"
                />
                <span className="text-xs text-slate-400">Requires Activity <span className="text-slate-600">(Android)</span></span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.requiresUrlScheme}
                  onChange={(e) => update({ requiresUrlScheme: e.target.checked })}
                  className="accent-cyan-500"
                />
                <span className="text-xs text-slate-400">Requires URL Scheme</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.hasNativeUI}
                  onChange={(e) => update({ hasNativeUI: e.target.checked })}
                  className="accent-cyan-500"
                />
                <span className="text-xs text-slate-400">Has Native UI</span>
              </label>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Notes</label>
              <textarea
                value={c.notes}
                onChange={(e) => update({ notes: e.target.value })}
                rows={2}
                placeholder="Additional observations or instructions for the agent..."
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none resize-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
