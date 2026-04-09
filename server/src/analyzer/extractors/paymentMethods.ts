import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { MODEL_EXTRACT, REPOS, type RepoKey } from "../../config.js";
import { askJson } from "../../llm.js";
import type { ExtractedFeature } from "../types.js";

export type { ExtractedFeature };

interface Candidate {
  file: string;
  snippet: string;
}

/**
 * Extract every payment method supported by the given SDK repo.
 *
 * Strategy:
 *  1. Static heuristics gather candidate files (cheap, deterministic).
 *  2. Send the candidate set to Claude (Sonnet) which returns a structured
 *     list of canonical payment-method names with evidence.
 *
 * The LLM is doing the *interpretation*, not the discovery — keeps token cost
 * bounded and lets the model handle all the messy ReScript naming variants.
 */
export async function extractPaymentMethods(
  repo: RepoKey,
): Promise<ExtractedFeature[]> {
  const root = REPOS[repo].dir;
  const candidates = await collectCandidates(repo, root);
  if (candidates.length === 0) {
    console.warn(`[extractor:paymentMethods] no candidates found for ${repo}`);
    return [];
  }

  const prompt = buildPrompt(repo, candidates);
  console.log(
    `[extractor:paymentMethods] ${repo}: ${candidates.length} candidates → LLM`,
  );

  const result = await askJson<{ payment_methods: ExtractedFeature[] }>(prompt, {
    model: MODEL_EXTRACT,
    timeoutMs: 240_000,
  });

  const list = result.payment_methods ?? [];
  console.log(`[extractor:paymentMethods] ${repo}: extracted ${list.length}`);
  return list;
}

async function collectCandidates(
  repo: RepoKey,
  root: string,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  if (repo === "web") {
    // Web: src/Payments/ has ~70 .res files; the filenames themselves are
    // strong signal. Plus a couple of registry files for cross-checking.
    const paymentFiles = await fg(["src/Payments/**/*.res"], {
      cwd: root,
      onlyFiles: true,
    });
    for (const f of paymentFiles) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }

    const registryGlobs = [
      "src/Utilities/PaymentMethodsRecord.res",
      "src/Payments/PaymentOptions.res",
      "src/Payments/PaymentMethodsRecord.res",
    ];
    for (const rel of registryGlobs) {
      const text = readSnippet(path.join(root, rel), 6000);
      if (text) candidates.push({ file: rel, snippet: text });
    }
  } else {
    // Mobile: explicit seed files known from the structural map.
    const seedFiles = [
      "src/types/SdkTypes.res",
      "src/types/AllApiDataTypes/PaymentMethodType.res",
      "src/types/AllApiDataTypes/AccountPaymentMethodType.res",
      "src/types/AllApiDataTypes/CustomerPaymentMethodType.res",
      "src/utility/logics/PaymentUtils.res",
      "src/utility/logics/Payment/PaymentUtils.res",
    ];
    for (const rel of seedFiles) {
      const text = readSnippet(path.join(root, rel), 6000);
      if (text) candidates.push({ file: rel, snippet: text });
    }

    // CHANGELOG often documents which methods got added recently.
    const changelog = readSnippet(path.join(root, "CHANGELOG.md"), 8000);
    if (changelog) candidates.push({ file: "CHANGELOG.md", snippet: changelog });

    // Also: any file under src/components matching *Wallet* or *Pay* — usually
    // a payment-method UI module.
    const walletFiles = await fg(
      ["src/components/**/*{Wallet,Pay,Klarna,Card,Bank}*.res"],
      { cwd: root, onlyFiles: true, caseSensitiveMatch: false },
    );
    for (const f of walletFiles.slice(0, 30)) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }
  }

  return candidates;
}

function readSnippet(absPath: string, maxBytes: number): string | null {
  try {
    const buf = fs.readFileSync(absPath);
    return buf.slice(0, maxBytes).toString("utf8");
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

  return `You are analyzing the ${repoLabel} repository to enumerate every payment method it supports.

Below are file paths and content snippets from the repo. Some are full file dumps, others are just filenames (which themselves are meaningful — e.g. "Klarna.res" implies Klarna support).

${filesBlock}

Identify every distinct **payment method** the SDK supports. Examples: cards, Apple Pay, Google Pay, Klarna, PayPal, Sofort, iDEAL, Boleto, ACH debit, BACS debit, SEPA debit, BLIK, Trustly, Paze, etc.

Do NOT include:
  - Generic concepts like "3DS", "tokenization", "saved cards", "wallets in general"
  - Internal infrastructure (loaders, themes, error handlers)
  - UI widgets that are not payment methods themselves

Output ONLY a single JSON object with this exact shape — no prose, no code fences, no commentary before or after:

{"payment_methods":[{"name":"<canonical_lower_snake_case>","file":"<relative path>","snippet":"<≤120 char evidence>"}]}

CRITICAL JSON RULES:
  - Snippet values MUST NOT contain double-quote characters. If you would
    quote something, use backticks or omit the quotes entirely.
  - Snippet values MUST NOT contain newlines or backslashes.
  - Keep snippets short (≤120 chars). The filename alone is a fine snippet.

Use lower_snake_case canonical names: apple_pay, google_pay, klarna, ach_debit, sepa_debit, ideal, card, etc. Merge variants (e.g. ApplePay.res and ApplePayLazy.res → one entry apple_pay).`;
}
