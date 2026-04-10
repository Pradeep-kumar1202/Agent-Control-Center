/**
 * PR Reviewer skill — Read-only comprehensive Opus review of a branch.
 *
 * Reviews against 7 dimensions:
 *  1. Correctness & logic errors
 *  2. Pattern consistency (ReScript types, naming, file placement)
 *  3. Test coverage (Cypress/Detox tests present?)
 *  4. Translation coverage (new UI strings without locale keys?)
 *  5. ReScript type safety (missing annotations, unsafe casts)
 *  6. Security (sensitive data exposure)
 *  7. Edge cases (payment failures, network errors, empty states)
 *
 * No branches are created — this is a pure read operation.
 */

import type { Request, Response } from "express";
import simpleGit from "simple-git";
import { REPOS } from "../../config.js";
import { askJson } from "../../llm.js";
import type { SkillEnvelope, SkillRepoResult } from "../registry.js";

export interface ReviewSpec {
  branch: string;
  baseBranch?: string;
  repo: "web" | "mobile" | "both";
}

export interface ReviewIssue {
  severity: "blocking" | "suggestion" | "nitpick";
  category:
    | "correctness"
    | "patterns"
    | "tests"
    | "translations"
    | "security"
    | "types"
    | "edge_cases";
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  verdict: "approve" | "request_changes" | "comment";
  issues: ReviewIssue[];
  missingTests: string[];
  missingTranslations: string[];
  statsAnalyzed: {
    filesReviewed: number;
    linesAdded: number;
    linesRemoved: number;
  };
}

async function getBranchDiff(
  repoDir: string,
  branch: string,
  baseBranch: string,
): Promise<{ diff: string; stat: string }> {
  const git = simpleGit(repoDir);

  // Handle GitHub PR URLs — fetch to FETCH_HEAD (no local ref created, no conflicts on re-run)
  if (branch.startsWith("https://github.com") || branch.startsWith("http://github.com")) {
    const prMatch = branch.match(/\/pull\/(\d+)/);
    if (!prMatch) {
      throw new Error(`Unrecognised GitHub URL — expected a /pull/<number> URL`);
    }
    const prNum = prMatch[1];
    try {
      await git.raw(["fetch", "origin", `pull/${prNum}/head`]);
    } catch (err) {
      throw new Error(
        `Could not fetch PR #${prNum} from origin. ` +
        `Make sure the workspace repo has network access to GitHub and the PR exists. ` +
        `(${(err as Error).message ?? err})`,
      );
    }
    // FETCH_HEAD now points to the PR tip — diff against base.
    // Three-dot (merge-base) is preferred; falls back to two-dot if there is no
    // common ancestor (e.g. shallow clone).
    let diff = "";
    let stat = "";
    try {
      diff = await git.diff([`${baseBranch}...FETCH_HEAD`]);
      stat = await git.diff([`${baseBranch}...FETCH_HEAD`, "--stat"]);
    } catch {
      diff = await git.diff([`${baseBranch}..FETCH_HEAD`]);
      stat = await git.diff([`${baseBranch}..FETCH_HEAD`, "--stat"]);
    }
    return { diff, stat };
  }

  // Regular branch name — ensure it exists locally or fetch from origin
  try {
    const branches = await git.branch(["-a"]);
    const exists = branches.all.some((b) =>
      b.replace("remotes/origin/", "").trim() === branch,
    );
    if (!exists) {
      await git.fetch("origin", branch);
    }
  } catch {
    // Proceed — branch may be local-only
  }

  // Three-dot diff with fallbacks
  let diff = "";
  let stat = "";
  try {
    diff = await git.diff([`${baseBranch}...${branch}`]);
    stat = await git.diff([`${baseBranch}...${branch}`, "--stat"]);
  } catch {
    try {
      diff = await git.diff([`${baseBranch}...origin/${branch}`]);
      stat = await git.diff([`${baseBranch}...origin/${branch}`, "--stat"]);
    } catch {
      try {
        diff = await git.diff([`${baseBranch}..${branch}`]);
        stat = await git.diff([`${baseBranch}..${branch}`, "--stat"]);
      } catch {
        throw new Error(
          `Could not diff "${branch}" against "${baseBranch}". ` +
          `Ensure the branch exists locally or is fetchable from origin.`,
        );
      }
    }
  }

  return { diff, stat };
}

function buildReviewPrompt(
  repoName: string,
  repoType: "web" | "mobile",
  branch: string,
  baseBranch: string,
  diff: string,
  stat: string,
): string {
  const repoSpecific =
    repoType === "web"
      ? `
## Web SDK Context (hyperswitch-web)
- Written in ReScript + React
- Payment types defined in src/Types/PaymentType.res
- Components in src/Components/
- Locale strings in shared-code/assets/v2/jsons/locales/
- Cypress e2e tests in cypress-tests/cypress/e2e/
- Utilities in src/Utilities/
`
      : `
## Mobile SDK Context (hyperswitch-client-core)
- Written in ReScript + React Native
- Config types in src/types/SdkTypes.res
- Native prop keys in src/types/NativeSdkPropsKeys.res
- Components in src/components/
- Locale strings in shared-code/assets/v2/jsons/locales/
- Detox e2e tests in detox-tests/e2e/
- Android native in android/, iOS native in ios/
`;

  return `You are doing a comprehensive code review of branch "${branch}" (base: "${baseBranch}") in ${repoName}.
${repoSpecific}
## Diff Stats
\`\`\`
${stat}
\`\`\`

## Full Diff
\`\`\`diff
${diff.length > 80000 ? diff.slice(0, 80000) + "\n... [diff truncated at 80k chars]" : diff}
\`\`\`

## Review Checklist

Review this diff against ALL of the following dimensions:

1. **Correctness**: Logic errors, off-by-one errors, missing null checks, incorrect conditions
2. **Pattern consistency**: Does it follow existing patterns in this repo?
   - ReScript: correct type usage, consistent naming (camelCase fields, PascalCase types)
   - File placement: new files in correct directories
   - Follows existing prop-wiring patterns (PaymentType.res, SdkTypes.res)
3. **Test coverage**: Are there Cypress (web) or Detox (mobile) tests for the new behavior?
   - If new UI behavior is added, tests should be in cypress-tests/ or detox-tests/
   - List specifically what tests are missing
4. **Translation coverage**: Are any new user-facing strings added WITHOUT a corresponding locale key?
   - Look for hardcoded strings in JSX/ReScript render code
   - New locale keys must be added to all 32 language files
5. **ReScript type safety**:
   - Missing type annotations on new functions/values
   - Unsafe casts or ignored type errors
   - Missing pattern match cases (non-exhaustive switches)
6. **Security**:
   - Sensitive data in logs or state
   - Unvalidated user input passed to APIs
   - Credentials or keys in source
7. **Edge cases**:
   - Payment failure scenarios handled?
   - Network error handling?
   - Empty/null state rendering?
   - Loading state while async operations run?

## Output Format

Return ONLY a JSON object matching this exact schema (no explanation, no markdown fences):
{
  "summary": "<2-3 sentence overall assessment>",
  "verdict": "approve" | "request_changes" | "comment",
  "issues": [
    {
      "severity": "blocking" | "suggestion" | "nitpick",
      "category": "correctness" | "patterns" | "tests" | "translations" | "security" | "types" | "edge_cases",
      "file": "<relative file path, optional>",
      "line": <line number, optional>,
      "message": "<clear description of the issue>",
      "suggestion": "<specific fix suggestion, optional>"
    }
  ],
  "missingTests": ["<description of missing test 1>", ...],
  "missingTranslations": ["<hardcoded string that needs a locale key>", ...],
  "statsAnalyzed": {
    "filesReviewed": <number>,
    "linesAdded": <number>,
    "linesRemoved": <number>
  }
}

Rules:
- "blocking": must be fixed before merge (logic bugs, security issues, missing critical tests)
- "suggestion": should be fixed but won't break anything (missing edge case handling, better patterns)
- "nitpick": optional improvements (style, naming, minor optimizations)
- "verdict" = "approve" only if zero blocking issues
- Be specific: include file paths and what exactly to look for
- If the diff is empty or trivial (docs-only), set verdict to "approve" with a brief summary`;
}

async function reviewRepo(
  repoKey: "web" | "mobile",
  spec: ReviewSpec,
): Promise<SkillRepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const baseBranch = spec.baseBranch ?? "main";
  const repoName =
    repoKey === "web" ? "hyperswitch-web" : "hyperswitch-client-core";

  const { diff, stat } = await getBranchDiff(repoDir, spec.branch, baseBranch);

  if (!diff) {
    return {
      repo: repoKey,
      branch: spec.branch,
      diff: "",
      filesTouched: 0,
      summary: JSON.stringify({
        summary: "No changes found between the specified branches.",
        verdict: "approve",
        issues: [],
        missingTests: [],
        missingTranslations: [],
        statsAnalyzed: { filesReviewed: 0, linesAdded: 0, linesRemoved: 0 },
      } satisfies ReviewResult),
    };
  }

  const prompt = buildReviewPrompt(repoName, repoKey, spec.branch, baseBranch, diff, stat);

  const reviewResult = await askJson<ReviewResult>(prompt, {
    model: "sonnet",
    timeoutMs: 300_000,
  });

  return {
    repo: repoKey,
    branch: spec.branch,
    // diff is the PR diff being reviewed (for display in UI)
    diff,
    filesTouched: reviewResult.statsAnalyzed.filesReviewed,
    summary: JSON.stringify(reviewResult),
  };
}

export async function handleReviewSkill(req: Request, res: Response): Promise<void> {
  const spec = req.body as ReviewSpec;
  if (!spec.branch || !spec.repo) {
    res.status(400).json({ error: "branch and repo are required" });
    return;
  }

  const results: Record<string, SkillRepoResult> = {};

  try {
    if (spec.repo === "web" || spec.repo === "both") {
      try {
        results.web = await reviewRepo("web", spec);
      } catch (err) {
        results.web = {
          repo: "web", branch: spec.branch, summary: "", diff: "", filesTouched: 0,
          error: (err as Error).message,
        };
      }
    }

    if (spec.repo === "mobile" || spec.repo === "both") {
      try {
        results.mobile = await reviewRepo("mobile", spec);
      } catch (err) {
        results.mobile = {
          repo: "mobile", branch: spec.branch, summary: "", diff: "", filesTouched: 0,
          error: (err as Error).message,
        };
      }
    }

    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);
    const envelope: SkillEnvelope = {
      skillId: "review",
      status: allError ? "error" : hasError ? "partial" : "ok",
      results,
      meta: { branch: spec.branch, baseBranch: spec.baseBranch ?? "main" },
    };
    res.json(envelope);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
