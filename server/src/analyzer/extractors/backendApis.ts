import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MODEL_EXTRACT, REPOS, type RepoKey } from "../../config.js";
import { askJson } from "../../llm.js";
import type { ExtractedFeature } from "../types.js";

const exec = promisify(execFile);

interface Candidate {
  file: string;
  snippet: string;
}

/**
 * Extract Hyperswitch backend API endpoints the SDK calls.
 *
 * Strategy:
 *  1. Read the known API endpoint registry / utility file.
 *  2. Grep the whole tree for fetch URL patterns ("/payments", "/customers",
 *     "/refunds", etc.) and feed surrounding context to the LLM.
 *  3. LLM returns a structured list keyed by endpoint path + method.
 */
export async function extractBackendApis(
  repo: RepoKey,
): Promise<ExtractedFeature[]> {
  const root = REPOS[repo].dir;
  const candidates = await collectCandidates(repo, root);
  if (candidates.length === 0) return [];

  const prompt = buildPrompt(repo, candidates);
  console.log(
    `[extractor:backendApis] ${repo}: ${candidates.length} candidates → LLM`,
  );

  const result = await askJson<{ endpoints: ExtractedFeature[] }>(prompt, {
    model: MODEL_EXTRACT,
    timeoutMs: 240_000,
  });
  const list = result.endpoints ?? [];
  console.log(`[extractor:backendApis] ${repo}: extracted ${list.length}`);
  return list;
}

async function collectCandidates(
  repo: RepoKey,
  root: string,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  // Known API utility files.
  const seeds =
    repo === "web"
      ? [
          "src/Utilities/ApiEndpoint.res",
          "src/Utilities/PaymentHelpers.res",
          "src/Utilities/Utils.res",
        ]
      : [
          "src/utility/logics/APIUtils.res",
          "src/utility/logics/PaymentUtils.res",
          "src/utility/logics/Payment/PaymentUtils.res",
          "src/utility/logics/ThreeDsUtils.res",
        ];

  for (const rel of seeds) {
    const text = readSnippet(path.join(root, rel), 8000);
    if (text) candidates.push({ file: rel, snippet: text });
  }

  // Grep for endpoint string literals across src/. Use system grep — it's
  // available everywhere and we don't need ripgrep just for this.
  try {
    const { stdout } = await exec(
      "grep",
      [
        "-rEho",
        "--include=*.res",
        "/(payments|customers|refunds|payment_methods|payouts|sessions|setup_intents|three_ds|merchant_connector_account|configs|api_keys|disputes|payment_link|files)[^\"'`)\\s]*",
        "src",
      ],
      { cwd: root, maxBuffer: 4_000_000 },
    );
    const uniq = Array.from(
      new Set(
        stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ).slice(0, 200);

    if (uniq.length > 0) {
      candidates.push({
        file: "<grep results>",
        snippet: uniq.join("\n"),
      });
    }
  } catch {
    /* grep is best-effort */
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

  return `You are analyzing the ${repoLabel} repository to enumerate Hyperswitch backend API endpoints the SDK calls.

Below are seed files (the API utility) plus a list of grep matches for URL string literals:

${filesBlock}

Identify each distinct backend endpoint the SDK consumes. An endpoint is a logical path like "GET /payments/{id}", "POST /payments/{id}/confirm", "GET /payment_methods".

Normalize:
  - Strip query params and IDs (use {id} placeholder).
  - Combine variants like "/payments/{id}" and "/payments/{id}/" into one entry.
  - Skip external / non-Hyperswitch URLs (Stripe, Apple Pay JS, fonts.googleapis.com).

Output ONLY a JSON object:

{"endpoints":[{"name":"<METHOD /path>","file":"<relative path>","snippet":"<≤120 char literal>"}]}

CRITICAL JSON RULES:
  - Snippet values MUST NOT contain double-quote characters, newlines, or backslashes.
  - Keep snippets short (≤120 chars). The path itself is a fine snippet.

Examples of canonical names: GET /payments/{id}, POST /payments/{id}/confirm, GET /payment_methods, POST /customers/{id}/payment_methods, POST /payments/session_tokens.

If you can't determine the HTTP method, use ANY /path.`;
}
