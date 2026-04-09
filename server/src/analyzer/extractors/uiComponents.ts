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
 * Extract user-visible UI components / widgets exposed by the SDK.
 *
 * "User-visible" = something a customer of the merchant would actually see
 * (the payment element, a card form, an Apple Pay button, etc.). We exclude
 * internal helpers like loaders, theme providers, error boundaries.
 */
export async function extractUiComponents(
  repo: RepoKey,
): Promise<ExtractedFeature[]> {
  const root = REPOS[repo].dir;
  const candidates = await collectCandidates(repo, root);
  if (candidates.length === 0) return [];

  const prompt = buildPrompt(repo, candidates);
  console.log(
    `[extractor:uiComponents] ${repo}: ${candidates.length} candidates → LLM`,
  );

  const result = await askJson<{ components: ExtractedFeature[] }>(prompt, {
    model: MODEL_EXTRACT,
    timeoutMs: 240_000,
  });
  const list = result.components ?? [];
  console.log(`[extractor:uiComponents] ${repo}: extracted ${list.length}`);
  return list;
}

async function collectCandidates(
  repo: RepoKey,
  root: string,
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  if (repo === "web") {
    // Top-level *Element.res files = user-facing entry points.
    const topElements = await fg(["src/*Element*.res", "src/*Form*.res"], {
      cwd: root,
      onlyFiles: true,
      caseSensitiveMatch: false,
    });
    for (const f of topElements) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }
    // src/Components/ — names only.
    const components = await fg(["src/Components/**/*.res"], {
      cwd: root,
      onlyFiles: true,
    });
    for (const f of components.slice(0, 80)) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }
  } else {
    // Mobile: pages/ + components/ subdirs are public surface.
    const pages = await fg(["src/pages/**/*.res"], {
      cwd: root,
      onlyFiles: true,
    });
    for (const f of pages.slice(0, 40)) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }

    const components = await fg(
      [
        "src/components/elements/**/*.res",
        "src/components/modules/**/*.res",
        "src/components/tabs/**/*.res",
        "src/components/dynamic/**/*.res",
      ],
      { cwd: root, onlyFiles: true },
    );
    for (const f of components.slice(0, 80)) {
      candidates.push({ file: f, snippet: path.basename(f, ".res") });
    }
  }

  return candidates;
}

function buildPrompt(repo: RepoKey, candidates: Candidate[]): string {
  const repoLabel =
    repo === "web"
      ? "hyperswitch-web (the web SDK)"
      : "hyperswitch-client-core (the mobile SDK)";

  const filesBlock = candidates
    .map((c) => `### ${c.file}\n${c.snippet}`)
    .join("\n\n");

  return `You are analyzing the ${repoLabel} repository to enumerate user-visible **UI widgets** the SDK exposes.

A widget is something the END user (the merchant's customer) actually sees and interacts with: the payment element, a card input form, an Apple Pay button, a saved-payment-methods list, the express checkout widget, etc.

Below are file paths from the repo (filenames are meaningful — e.g. "PaymentElement.res" implies a Payment Element widget):

${filesBlock}

EXCLUDE:
  - Internal helpers (loaders, themes, error boundaries, providers)
  - Layout primitives (BoxRow, FlexCol, etc.)
  - Files that are clearly utility / state / hooks

Output ONLY a JSON object:

{"components":[{"name":"<lower_snake_case>","file":"<relative path>","snippet":"<≤120 char filename or short note>"}]}

CRITICAL JSON RULES:
  - Snippet values MUST NOT contain double-quote characters, newlines, or backslashes.
  - Keep snippets short (≤120 chars). Filename is a fine snippet.

Use lower_snake_case canonical names: payment_element, card_form, express_checkout, saved_payment_methods, payment_methods_management, billing_address_form, card_widget, payment_button, etc. Merge near-duplicates (PaymentElement.res + PaymentElementV2.res → one entry).`;
}
