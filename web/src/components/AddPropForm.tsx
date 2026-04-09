import { useState } from "react";
import { api, type PropGenerateResponse, type PropSpec } from "../api";

interface Props {
  onResult: (result: PropGenerateResponse) => void;
  onError: (msg: string) => void;
}

const PLATFORMS = [
  { id: "web", label: "Web (ReScript)", description: "PaymentType.res + DynamicFields" },
  { id: "mobile", label: "Mobile (ReScript)", description: "SdkTypes.res + DynamicFieldsContext" },
  { id: "android_native", label: "Android Native", description: "PaymentSheet.kt + LaunchOptions.kt" },
  { id: "ios_native", label: "iOS Native", description: "PaymentSheetConfiguration.swift" },
];

const TYPES = [
  { value: "bool", label: "Boolean" },
  { value: "string", label: "String" },
  { value: "int", label: "Integer" },
  { value: "option<string>", label: "Optional String" },
];

export function AddPropForm({ onResult, onError }: Props) {
  const [propName, setPropName] = useState("");
  const [type, setType] = useState("bool");
  const [defaultVal, setDefaultVal] = useState("false");
  const [parentConfig, setParentConfig] = useState("");
  const [behavior, setBehavior] = useState("");
  const [platforms, setPlatforms] = useState<Set<string>>(
    new Set(["web", "mobile", "android_native", "ios_native"]),
  );
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");

  const togglePlatform = (id: string) => {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = async () => {
    if (!propName.trim() || !behavior.trim() || platforms.size === 0) return;

    const spec: PropSpec = {
      propName: propName.trim(),
      type,
      default: defaultVal.trim() || (type === "bool" ? "false" : '""'),
      parentConfig: parentConfig.trim() || undefined,
      behavior: behavior.trim(),
      platforms: Array.from(platforms),
    };

    setGenerating(true);
    setProgress("Sending agents into repos...");

    try {
      const result = await api.generateProp(spec);
      onResult(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setGenerating(false);
      setProgress("");
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-4">
        Add New Prop
      </h2>
      <p className="text-sm text-slate-500 mb-6">
        Define a configuration prop and the AI will implement it across both
        SDKs following each repo's existing patterns.
      </p>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Prop name */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Prop Name
          </label>
          <input
            type="text"
            value={propName}
            onChange={(e) => setPropName(e.target.value)}
            placeholder="alwaysShowBillingDetails"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">Type</label>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              if (e.target.value === "bool") setDefaultVal("false");
              else if (e.target.value === "string") setDefaultVal('""');
              else if (e.target.value === "int") setDefaultVal("0");
              else setDefaultVal("None");
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {/* Default value */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Default Value
          </label>
          <input
            type="text"
            value={defaultVal}
            onChange={(e) => setDefaultVal(e.target.value)}
            placeholder="false"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Parent config */}
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Parent Config{" "}
            <span className="text-slate-600">(optional)</span>
          </label>
          <input
            type="text"
            value={parentConfig}
            onChange={(e) => setParentConfig(e.target.value)}
            placeholder="billingAddress or leave empty for top-level"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Behavior */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">
          Behavior Description
        </label>
        <textarea
          value={behavior}
          onChange={(e) => setBehavior(e.target.value)}
          rows={3}
          placeholder="When true, always show billing/dynamic fields in the payment sheet regardless of whether they are pre-filled. When false (default), only show fields that are empty or partially filled."
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none resize-none"
        />
      </div>

      {/* Platforms */}
      <div className="mb-6">
        <label className="block text-xs text-slate-400 mb-2">
          Target Platforms
        </label>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              onClick={() => togglePlatform(p.id)}
              className={
                "rounded-lg border px-3 py-2 text-left transition " +
                (platforms.has(p.id)
                  ? "border-indigo-500 bg-indigo-500/10"
                  : "border-slate-700 hover:border-slate-500")
              }
            >
              <div
                className={
                  "text-xs font-medium " +
                  (platforms.has(p.id) ? "text-indigo-200" : "text-slate-400")
                }
              >
                {p.label}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                {p.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Submit */}
      <div className="flex items-center gap-3">
        <button
          onClick={onSubmit}
          disabled={
            generating ||
            !propName.trim() ||
            !behavior.trim() ||
            platforms.size === 0
          }
          className={
            "rounded-lg px-5 py-2.5 font-medium text-white transition " +
            (generating
              ? "bg-indigo-700 cursor-wait"
              : !propName.trim() || !behavior.trim() || platforms.size === 0
                ? "bg-slate-700 cursor-not-allowed text-slate-500"
                : "bg-indigo-600 hover:bg-indigo-500")
          }
        >
          {generating ? (
            <span className="inline-flex items-center gap-2">
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              Generating...
            </span>
          ) : (
            "Generate Prop"
          )}
        </button>
        {progress && (
          <span className="text-sm text-indigo-300">{progress}</span>
        )}
      </div>
    </div>
  );
}
