import { getValidateCache, putValidateCache } from "../cache.js";
import { MODEL_REASON, REPOS, type RepoKey } from "../config.js";
import { askJson } from "../llm.js";
import type { Category, ExtractedFeature } from "./types.js";

/**
 * A claimed gap awaiting validation: feature X is present in `present_in`
 * but not (yet) found in `missing_in`. The validator's job is to *confirm
 * the absence by actually looking* in the missing repo.
 */
export interface ClaimedGap {
  category: Category;
  canonical_name: string;
  missing_in: RepoKey;
  present_in: RepoKey;
  evidence_present: ExtractedFeature; // the smoking gun in `present_in`
}

export type Verdict = "confirmed" | "false_positive" | "platform_specific";

export interface ValidationResult {
  canonical_name: string;
  verdict: Verdict;
  /** Where in the missing repo Opus found it (only set on false_positive). */
  found_in_missing?: string;
  severity: "low" | "medium" | "high";
  rationale: string;
}

const BATCH_SIZE = 24;

/**
 * Validate a batch of claimed gaps by giving Opus tool access to the
 * `missing_in` repo. Opus uses Read/Grep/Glob to either:
 *  - confirm the gap (verdict=confirmed)
 *  - find the feature under another name → drop it (verdict=false_positive)
 *  - flag inherently platform-bound features (verdict=platform_specific)
 *
 * Calls are batched per missing-repo so we set cwd once per batch.
 */
export async function validateGaps(
  claims: ClaimedGap[],
  shas: { web: string; mobile: string },
): Promise<Map<string, ValidationResult>> {
  const results = new Map<string, ValidationResult>();

  // Per-gap cache lookup BEFORE any LLM call. Anything cached for the
  // current SHA of the missing repo is free.
  const uncached: ClaimedGap[] = [];
  for (const c of claims) {
    const sha = shas[c.missing_in];
    const hit = getValidateCache<ValidationResult>(c.missing_in, sha, c.canonical_name);
    if (hit) {
      results.set(keyOf(c.canonical_name, c.missing_in), hit);
    } else {
      uncached.push(c);
    }
  }
  console.log(
    `[validate] cache: ${claims.length - uncached.length}/${claims.length} hits, validating ${uncached.length} fresh`,
  );
  if (uncached.length === 0) return results;

  // Bucket by missing repo so each batch shares one cwd.
  const byRepo: Record<RepoKey, ClaimedGap[]> = { web: [], mobile: [] };
  for (const c of uncached) byRepo[c.missing_in].push(c);

  for (const repo of ["web", "mobile"] as const) {
    const items = byRepo[repo];
    if (items.length === 0) continue;
    const repoSha = shas[repo];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      console.log(
        `[validate] checking ${batch.length} claimed gaps in ${repo} (batch ${
          Math.floor(i / BATCH_SIZE) + 1
        }/${Math.ceil(items.length / BATCH_SIZE)})`,
      );

      try {
        const batchResults = await validateBatch(batch, repo);
        for (const r of batchResults) {
          results.set(keyOf(r.canonical_name, repo), r);
          putValidateCache(repo, repoSha, r.canonical_name, r);
        }
      } catch (err) {
        console.error(
          `[validate] batch failed in ${repo}:`,
          (err as Error).message,
        );
        // On batch failure, default-confirm everything in the batch so we
        // don't silently drop real gaps. Do NOT cache these — we want to
        // retry next run.
        for (const c of batch) {
          results.set(keyOf(c.canonical_name, repo), {
            canonical_name: c.canonical_name,
            verdict: "confirmed",
            severity: "medium",
            rationale: "Validation skipped (batch error). Default-confirmed.",
          });
        }
      }
    }
  }

  return results;
}

function keyOf(name: string, missingIn: RepoKey): string {
  return `${missingIn}::${name}`;
}

export function lookupVerdict(
  results: Map<string, ValidationResult>,
  name: string,
  missingIn: RepoKey,
): ValidationResult | undefined {
  return results.get(keyOf(name, missingIn));
}

async function validateBatch(
  claims: ClaimedGap[],
  missingRepo: RepoKey,
): Promise<ValidationResult[]> {
  const cwd = REPOS[missingRepo].dir;
  const repoLabel =
    missingRepo === "web"
      ? "hyperswitch-web (the web SDK)"
      : "hyperswitch-client-core (the mobile SDK)";

  const prompt = `You are validating claimed feature gaps in the ${repoLabel} repository.

Your current working directory IS the ${missingRepo} repo. You have access to the Glob, Grep, and Read tools — USE THEM. Do not guess. Actually look.

For each claim below, the gap-finder believes the feature is missing from ${missingRepo} (it exists in the other repo). Your job:

  - Use Glob/Grep to look for the feature under that name OR any plausible alias.
  - Open files with Read if you need to confirm.
  - Decide one verdict per claim:
      "confirmed"        - feature is genuinely absent from this repo
      "false_positive"   - you found it (under this name or another). Set found_in_missing to the file path.
      "platform_specific" - the feature inherently cannot exist in this platform
                            (e.g. Apple Pay → web is moot since web has its own Apple Pay JS;
                            biometric auth → web is impossible).

Severity guidance:
  high   = core payment flow / common payment method missing (Klarna, ACH, SEPA, 3DS, etc.)
  medium = useful integrator config or secondary widget
  low    = edge case, minor cosmetic option, or rarely-used endpoint

CLAIMS (${claims.length}):
${JSON.stringify(
  claims.map((c, idx) => ({
    idx,
    cat: c.category,
    name: c.canonical_name,
    other: c.evidence_present.file,
  })),
)}

Output ONLY a JSON object — no prose, no code fences, no commentary:

{"results":[{"canonical_name":"<name>","verdict":"confirmed|false_positive|platform_specific","found_in_missing":"<path or omit>","severity":"low|medium|high","rationale":"<≤200 chars>"}]}

There must be exactly ${claims.length} entries, one per claim, in the same order as the input.`;

  const result = await askJson<{ results: ValidationResult[] }>(prompt, {
    model: MODEL_REASON,
    timeoutMs: 600_000,
    cwd,
    allowedTools: ["Glob", "Grep", "Read"],
  });

  return result.results ?? [];
}
