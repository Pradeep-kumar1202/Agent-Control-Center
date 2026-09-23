import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { MODEL_EXTRACT, REPOS, type RepoKey } from "../../config.js";
import { askJson } from "../../llm.js";
import type { ExtractedFeature } from "../types.js";

interface Candidate {
  file: string;
  snippet: string;
}

/**
 * Extract integrator-facing config / props from the SDK's public type surface.
 *
 * "Integrator-facing" = something a developer using the SDK would set when
 * embedding it (theme, appearance, layout, locale, customer info hooks,
 * billing/shipping config flags, etc.). Internal-only types are excluded.
 */
export async function extractConfigProps(
  repo: RepoKey,
): Promise<ExtractedFeature[]> {
  const root = REPOS[repo].dir;
  const candidates = await collectCandidates(repo, root);
  if (candidates.length === 0) return [];

  const prompt = buildPrompt(repo, candidates);
  console.log(
    `[extractor:configProps] ${repo}: ${candidates.length} candidates → LLM`,
  );

  const result = await askJson<{ config: ExtractedFeature[] }>(prompt, {
    model: MODEL_EXTRACT,
    timeoutMs: 240_000,
  });
  const list = result.config ?? [];
  console.log(`[extractor:configProps] ${repo}: extracted ${list.length}`);
  return list;
}

async function collectCandidates(
  repo: RepoKey,
  root: string,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  const seedGlobs =
    repo === "web"
      ? [
          "src/Types/PaymentType.res",
          "src/Types/PaymentConfirmTypes.res",
          "src/Types/ElementType.res",
          "src/Types/RecoilAtomTypes.res",
          "src/Types/UnifiedPaymentsTypesV2.res",
          "src/Utilities/RecoilAtoms.res",
        ]
      : [
          "src/types/SdkTypes.res",
          "src/types/WalletType.res",
          "src/types/LayoutTypes.res",
          "src/types/ExternalThreeDsTypes.res",
          "src/types/AllApiDataTypes/PaymentMethodType.res",
        ];

  for (const rel of seedGlobs) {
    const text = readSnippet(path.join(root, rel), 6000);
    if (text) candidates.push({ file: rel, snippet: text });
  }

  // Catch-all for any remaining type files we missed.
  const typesGlob = repo === "web" ? "src/Types/*.res" : "src/types/*.res";
  const allTypes = await fg([typesGlob], { cwd: root, onlyFiles: true });
  for (const f of allTypes.slice(0, 8)) {
    if (candidates.find((c) => c.file === f)) continue;
    const text = readSnippet(path.join(root, f), 4000);
    if (text) candidates.push({ file: f, snippet: text });
  }

  return candidates;
}

function readSnippet(absPath: string, maxBytes: number): string | null {
  try {
    return fs.readFileSync(absPath).slice(0, maxBytes).toString("utf8");
  } catch {
    return null;
  }
}

function buildPrompt(repo: RepoKey, candidates: Candidate[]): string {
  const repoLabel =
    repo === "web"
      ? "hyperswitch-web (the web SDK)"
      : "hyperswitch-client-core (the mobile SDK)";

  const filesBlock = candidates
    .map((c) => `### ${c.file}\n${c.snippet}`)
    .join("\n\n");

  return `You are analyzing the ${repoLabel} repository to enumerate integrator-facing **configuration options / props**.

These are options a developer would set when embedding the SDK in their app — things like theme, appearance variables, layout style, locale, business country, billing collection toggles, customer hooks, fonts, etc. They are part of the SDK's PUBLIC surface.

Below are the type definition files from the repo:

${filesBlock}

Identify each integrator-facing config option. EXCLUDE:
  - Internal state types not exposed to integrators
  - Payment method enums (handled separately)
  - Pure response/request DTOs returned by the backend
  - Implementation helpers

Output ONLY a JSON object — no prose, no code fences:

{"config":[{"name":"<lower_snake_case>","file":"<relative path>","snippet":"<≤120 char field signature>"}]}

CRITICAL JSON RULES:
  - Snippet values MUST NOT contain double-quote characters, newlines, or backslashes.
  - Use backticks if you must indicate a string literal. Otherwise omit quoting entirely.
  - Keep snippets short (≤120 chars).

Use lower_snake_case canonical names: appearance_theme, layout, billing_address_collection, default_values, locale, business_country, fonts, custom_method_names, etc.`;
}
