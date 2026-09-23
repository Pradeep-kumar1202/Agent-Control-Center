/**
 * Backend endpoints each SDK calls, as normalised path templates
 * (`payments/{}/confirm`).
 *
 * Two sources, both deterministic:
 *  - web's endpoint registry, the `let path = switch apiCallType` map in
 *    src/Utilities/APIHelpers/APIUtils.res (paths there are joined to the
 *    base URL later, so they never appear as a full URL literal);
 *  - every template literal in the SDK source of the form
 *    `${<url-ish var>}/path…` — how mobile builds every call, and how web
 *    builds the calls outside the registry (confirm, complete_authorize…).
 *
 * The variable-name heuristic (url/Url/endpoint/baseUrl) is the one place a
 * call could be missed; the equivalence table records calls whose URL comes
 * from a backend response instead (e.g. mobile's 3DS authentication URL).
 */

import {
  lineAt,
  lineTextAt,
  listFiles,
  readSource,
  requireAtLeast,
  SurfaceParseError,
} from "./source.js";
import type { Side, SurfaceItem } from "./types.js";

const SOURCE_DIRS: Record<Side, string[]> = {
  web: ["src", "shared-code/sdk-utils"],
  mobile: ["src", "shared-code/sdk-utils"],
};

const URL_LITERAL = /`\$\{[^}]*(?:[Uu]rl|URL|[Ee]ndpoint)[^}]*\}(\/[^`]*)`/g;
/** Static assets fetched from the CDN are not backend API calls. */
const ASSET = /\.(css|js|html|svg|png|jpe?g|gif|woff2?)$|^assets\//;

export function extractBackendApiSurface(side: Side, repoDir: string): SurfaceItem[] {
  const out = new Map<string, SurfaceItem>();
  if (side === "web") addWebRegistry(repoDir, out);

  for (const dir of SOURCE_DIRS[side]) {
    for (const rel of listFiles(repoDir, dir, ".res")) {
      const file = readSource(repoDir, rel);
      for (const m of file.text.matchAll(URL_LITERAL)) {
        const key = normalisePath(m[1]);
        if (!key || ASSET.test(key) || out.has(key)) continue;
        const offset = m.index ?? 0;
        out.set(key, {
          key,
          file: rel,
          line: lineAt(file.text, offset),
          snippet: lineTextAt(file.text, offset),
        });
      }
    }
  }
  return requireAtLeast([...out.values()], side === "web" ? 10 : 6, `${side} backend endpoints`);
}

function addWebRegistry(repoDir: string, out: Map<string, SurfaceItem>): void {
  const rel = "src/Utilities/APIHelpers/APIUtils.res";
  const file = readSource(repoDir, rel);
  const anchor = file.text.indexOf("let path = switch apiCallType");
  if (anchor < 0) {
    throw new SurfaceParseError(`web endpoint registry (\`let path = switch apiCallType\`) not found in ${rel}`);
  }
  const end = file.text.indexOf("\n  }", anchor);
  const block = file.text.slice(anchor, end < 0 ? undefined : end);
  let found = 0;
  for (const m of block.matchAll(/\|\s*[A-Za-z0-9_]+\s*=>\s*[`"]([^`"]+)[`"]/g)) {
    const key = normalisePath(`/${m[1]}`);
    if (!key || ASSET.test(key)) continue;
    found++;
    const offset = anchor + (m.index ?? 0);
    if (!out.has(key)) {
      out.set(key, { key, file: rel, line: lineAt(file.text, offset), snippet: lineTextAt(file.text, offset) });
    }
  }
  requireAtLeast(Array(found), 5, "web endpoint registry entries");
}

/**
 * `/payments/${id}/confirm?x=1` → `payments/{}/confirm`. Every interpolation
 * and every named placeholder becomes `{}`; adjacent placeholders (a path
 * segment built from two variables, or an id followed by a query-string
 * variable) collapse to one.
 */
export function normalisePath(raw: string): string | null {
  let p = raw.replace(/\$\{[^}]*\}/g, "{}").replace(/\{[A-Za-z_]*\}/g, "{}");
  p = p.split("?")[0].replace(/(\{\})+/g, "{}").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!/^[a-z]/.test(p)) return null;
  return p;
}
