/**
 * Prove the Markdown agent definitions are a faithful port of the inline
 * prompts still living in routes/patches.ts.
 *
 * The comparison is mechanical on purpose. Transcribing the originals by hand
 * into an expected-value string would only prove the transcription matches the
 * transcription. Instead this reads patches.ts, extracts the template literals,
 * and rewrites their `${...}` interpolations into `{{VAR}}` tokens using an
 * explicit mapping — so what gets compared is the real source against the real
 * .md body, with the templating as the only difference.
 *
 * Run before and after the port. It must stay green until step 8, which is
 * where prompts are deliberately reworded and re-benchmarked.
 *
 *   npx tsx server/src/scripts/verifyAgentPort.ts
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config.js";
import { loadAgent } from "../agents/loader.js";

const PATCHES_TS = path.join(PROJECT_ROOT, "server", "src", "routes", "patches.ts");

let failures = 0;

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.log(`  ✗ ${label}\n${detail.replace(/^/gm, "      ")}`);
}

/**
 * Extract the template literal that begins at `startMarker` and runs to the
 * first backtick that terminates it. Nested `${...}` may contain backticks, so
 * this tracks interpolation depth rather than scanning for the next backtick.
 */
function extractTemplate(src: string, startMarker: string): string | null {
  const at = src.indexOf(startMarker);
  if (at < 0) return null;
  const open = src.indexOf("`", at);
  if (open < 0) return null;

  let i = open + 1;
  let depth = 0;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { out += src[i] + src[i + 1]; i += 2; continue; }
    if (depth === 0 && ch === "`") return out;
    if (ch === "$" && src[i + 1] === "{") { depth++; out += "${"; i += 2; continue; }
    if (depth > 0 && ch === "}") { depth--; out += "}"; i++; continue; }
    out += ch;
    i++;
  }
  return null;
}

/** Rewrite `${expr}` -> `{{VAR}}` for the known interpolations. */
function tokenize(tpl: string, mapping: Record<string, string>): string {
  let out = tpl;
  for (const [expr, varName] of Object.entries(mapping)) {
    out = out.split("${" + expr + "}").join(`{{${varName}}}`);
  }
  return out;
}

function diffFirst(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `first difference at line ${i + 1}:\n  source: ${JSON.stringify(al[i] ?? "<eof>")}\n  md    : ${JSON.stringify(bl[i] ?? "<eof>")}`;
    }
  }
  return "(identical)";
}

function compare(label: string, fromSource: string | null, mdBody: string): void {
  if (fromSource === null) {
    fail(label, "could not locate the template literal in patches.ts — did it move or get deleted?");
    return;
  }
  const a = fromSource.trim();
  const b = mdBody.trim();
  if (a === b) ok(label);
  else fail(label, diffFirst(a, b));
}

function main(): void {
  if (!fs.existsSync(PATCHES_TS)) {
    console.log(`patches.ts not found at ${PATCHES_TS} — nothing to compare against.`);
    console.log("If the inline builders have already been deleted, this check has served its purpose.");
    return;
  }
  const src = fs.readFileSync(PATCHES_TS, "utf8");

  console.log("\nAgent definition port fidelity (agents/*.md vs routes/patches.ts)\n");

  // ── analyst ──
  const analyst = extractTemplate(src, "const analystPrompt =");
  compare(
    "patch/source-analyst",
    analyst && tokenize(analyst, {
      "gap.canonical_name": "FEATURE_NAME",
      "sourceLabel": "SOURCE_LABEL",
      "sourceDir": "SOURCE_DIR",
      "sourceEntryPath": "SOURCE_ENTRY",
    }),
    loadAgent("patch/source-analyst").body,
  );

  // ── implementer (spec-based) ──
  const impl = extractTemplate(src, "function buildSpecBasedImplementerPrompt");
  compare(
    "patch/implementer",
    impl && tokenize(impl, {
      "repoLabel": "REPO_LABEL",
      "targetDir": "TARGET_DIR",
      "gap.canonical_name": "FEATURE_NAME",
      "JSON.stringify(spec, null, 2)": "SPEC_JSON",
    }),
    loadAgent("patch/implementer").body,
  );

  // ── verifier ──
  // Not byte-identical by construction: the original interpolates two
  // conditional blocks (`specSection` and a ternary checklist). The template
  // language has no conditionals on purpose, so both are hoisted into vars the
  // workflow computes. Everything OUTSIDE those two holes must still match.
  // Anchor on the `return`, not the function: buildVerifierPrompt builds
  // `specSection` from its own template literal first, which would otherwise be
  // the one extracted.
  const verifierFn = src.slice(src.indexOf("function buildVerifierPrompt"));
  const verifier = extractTemplate(verifierFn, "return ");
  if (verifier === null) {
    fail("patch/verifier", "could not locate buildVerifierPrompt in patches.ts");
  } else {
    const tokenized = tokenize(verifier, {
      "gap.canonical_name": "FEATURE_NAME",
      "targetDir": "TARGET_DIR",
      "repoLabel": "REPO_LABEL",
      "specSection": "SPEC_SECTION",
    })
      // collapse the inline ternary checklist into its hoisted variable
      .replace(/\$\{spec \?[\s\S]*?\n`\}/, "{{CHECKLIST}}");
    compare("patch/verifier (skeleton)", tokenized, loadAgent("patch/verifier").body);
  }

  console.log(
    failures === 0
      ? "\nPort is faithful — rendered prompts match the inline originals.\n"
      : `\n${failures} definition(s) DIVERGE from patches.ts.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
