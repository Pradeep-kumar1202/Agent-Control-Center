import { useState } from "react";
import { api, type TranslationSpec } from "../../api";
import type { SkillFormProps } from "../registry";

export function TranslationsForm({ onResult, onError }: SkillFormProps) {
  const [keyName, setKeyName] = useState("");
  const [englishValue, setEnglishValue] = useState("");
  const [context, setContext] = useState("");
  const [generating, setGenerating] = useState(false);

  const canSubmit = keyName.trim() && englishValue.trim() && context.trim();

  const onSubmit = async () => {
    if (!canSubmit) return;

    const spec: TranslationSpec = {
      keyName: keyName.trim(),
      englishValue: englishValue.trim(),
      context: context.trim(),
    };

    setGenerating(true);
    try {
      const result = await api.generateTranslations(spec);
      onResult(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
      <h2 className="text-lg font-semibold text-slate-100 mb-1">Translator</h2>
      <p className="text-sm text-slate-500 mb-6">
        Provide a new i18n key and its English value. The AI will translate it into all 32 supported
        languages and insert only the new key into each locale file with a minimal git diff.
      </p>

      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Translation Key Name</label>
          <input
            type="text"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="saveCardForFuturePayments"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none font-mono"
          />
          <div className="text-xs text-slate-600 mt-1">
            camelCase key used in code — e.g. <code className="text-slate-500">localeString.saveCardForFuturePayments</code>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">English Value</label>
          <input
            type="text"
            value={englishValue}
            onChange={(e) => setEnglishValue(e.target.value)}
            placeholder="Save card for future payments"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Context</label>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="Label for a checkbox shown in the payment sheet. Allows users to save their card details for faster checkout next time."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-500 focus:outline-none resize-none"
          />
          <div className="text-xs text-slate-600 mt-1">
            Where and how the string is used — helps ensure accurate, context-appropriate translations.
          </div>
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3">
        <div className="text-xs text-slate-500 space-y-1">
          <div className="font-medium text-slate-400">What this does</div>
          <div>• Translates into all 32 language files (en, de, fr, es, it, pt, ru, ar, he, ja, zh + 21 more)</div>
          <div>• Inserts only the new key at the end of each JSON file — minimal git diff</div>
          <div>• Creates branches <code className="text-slate-400">feat/translate-{"{key}"}-web</code> and <code className="text-slate-400">feat/translate-{"{key}"}-mobile</code></div>
          <div>• Updates both <code className="text-slate-400">hyperswitch-web</code> and <code className="text-slate-400">hyperswitch-client-core</code></div>
        </div>
      </div>

      <button
        onClick={onSubmit}
        disabled={generating || !canSubmit}
        className={
          "rounded-lg px-5 py-2.5 font-medium text-white transition " +
          (generating
            ? "bg-sky-700 cursor-wait"
            : !canSubmit
              ? "bg-slate-700 cursor-not-allowed text-slate-500"
              : "bg-sky-600 hover:bg-sky-500")
        }
      >
        {generating ? (
          <span className="inline-flex items-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Translating…
          </span>
        ) : (
          "Generate Translations"
        )}
      </button>
    </div>
  );
}
