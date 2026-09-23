/**
 * Extract a JSON value from agent output.
 *
 * Agents are asked for bare JSON, but every runtime occasionally wraps it in a
 * fence or prefixes a sentence. This is deliberately the ONLY such extractor in
 * the server — it previously existed twice (`skills/prPort/index.ts` and
 * `llm.ts`), and two copies of a parser is two sets of accepted-shape rules that
 * drift apart silently.
 *
 * Extraction is not validation. Callers must still parse the result into a
 * known shape with a strict parser; `pipeline.resolveWithRepair` is how that is
 * done for agent stages. Returning `unknown` rather than a generic `<T>` is on
 * purpose: a cast here would let a structurally-wrong-but-valid JSON object
 * flow downstream typed as something it is not.
 */

/**
 * Find the first balanced JSON value in `text`.
 *
 * Two candidates are tried in order: the contents of a ``` fence, then the
 * first balanced `{...}` / `[...]` span. Brace counting is string- and
 * escape-aware, so a `}` inside a string literal does not close the value early.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = fenced ? [fenced[1].trim()] : [];

  const start = text.search(/[[{]/);
  if (start >= 0) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next candidate */ }
  }
  throw new Error("agent output was not valid JSON");
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
