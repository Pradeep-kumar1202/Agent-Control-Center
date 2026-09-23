/**
 * Payment-method capability, compared as the backend `next_action` types each
 * SDK can complete.
 *
 * Comparing payment-method NAMES was the wrong question: mobile renders
 * whatever the backend's method list says, so every web method looked
 * "missing in mobile" (LEARNINGS, known truths). What actually decides
 * whether a method works on a platform is whether the SDK handles the
 * `next_action` the backend returns for it after confirm — a redirect, a QR
 * code to display, a voucher, a wallet SDK to invoke, a 3DS challenge. A
 * missing handler breaks every method that relies on it.
 *
 * Both idioms are read on BOTH SDKs:
 *   web     `intent.nextAction.type_ === "qr_code_information"`   (if/else chains)
 *   mobile  `switch nextAction->PaymentUtils.getActionType { | "three_ds_invoke" => … }`
 *
 * Whole-line comments are stripped first: client-core carries commented-out
 * arms (HeadlessCommon.res) that must not count as handled.
 */

import { lineAt, lineTextAt, listFiles, readSource, requireAtLeast } from "./source.js";
import type { Side, SurfaceItem } from "./types.js";

const SOURCE_DIRS = ["src", "shared-code/sdk-utils"];

/** `nextAction.type_ == "x"` / `nextActionType === "x"` and the reversed form. */
const COMPARISON = /\b(?:nextAction\.type_|nextActionType|actionType)\s*={2,3}\s*"([a-z_]+)"|"([a-z_]+)"\s*={2,3}\s*(?:nextAction\.type_|nextActionType|actionType)\b/g;
/** A switch whose scrutinee is the next-action type. */
const ACTION_SWITCH = /switch\s+[^{\n]*(?:getActionType|nextAction\.type_|nextActionType)[^{\n]*\{/g;
const ARM = /^\s*\|\s*"([a-z_]+)"/gm;

export function extractPaymentFlowSurface(side: Side, repoDir: string): SurfaceItem[] {
  const out = new Map<string, SurfaceItem>();
  for (const dir of SOURCE_DIRS) {
    for (const rel of listFiles(repoDir, dir, ".res")) {
      const { text } = readSource(repoDir, rel);
      const code = stripLineComments(text);
      const add = (type: string, offset: number) => {
        const key = `next_action/${type}`;
        if (!out.has(key)) out.set(key, { key, file: rel, line: lineAt(text, offset), snippet: lineTextAt(text, offset) });
      };
      for (const m of code.matchAll(COMPARISON)) add(m[1] ?? m[2], m.index ?? 0);
      for (const m of code.matchAll(ACTION_SWITCH)) {
        const start = (m.index ?? 0) + m[0].length;
        const body = code.slice(start, matchingBrace(code, start - 1));
        for (const arm of body.matchAll(ARM)) add(arm[1], start + (arm.index ?? 0) + arm[0].indexOf('"'));
      }
    }
  }
  return requireAtLeast([...out.values()], 3, `${side} next_action handlers`);
}

/**
 * Blank out whole-line `//` comments and `/* … *\/` blocks, preserving
 * offsets (so line numbers stay exact). Trailing `// …` after code is left
 * alone: URLs inside strings contain `//`, and a trailing comment cannot hide
 * an arm on its own line.
 */
export function stripLineComments(text: string): string {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  return blanked.replace(/^[ \t]*\/\/.*$/gm, (c) => " ".repeat(c.length));
}

/** Offset just past the `}` matching the `{` at `open` (or end of text). */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // skip string literal
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return text.length;
}
