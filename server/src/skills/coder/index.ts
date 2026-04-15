/**
 * Coder skill — general-purpose coding tasks.
 *
 * Unlike the sdk-integrator skill, this doesn't require SDK documentation,
 * classification, or a specific integration pattern. It's a simple:
 *   Pick repos → describe task → generate → review loop.
 *
 * Architecture:
 *   - When both client-core + rn-packages are selected, uses combined mobile
 *     workspace (single coder for interface consistency), same as sdk-integrator.
 *   - When only one mobile repo is selected, scoped coder to that repo.
 *   - Web is always a separate coder call.
 *   - All generated code goes through the review loop with tool access.
 */

import type { Request, Response } from "express";
import {
  INTEGRATION_TARGET_CWD,
  REPOS,
  type ExtendedRepoKey,
} from "../../config.js";
import { ask } from "../../llm.js";
import type { SkillRepoResult } from "../registry.js";

// ── Shared helpers ──
import { sendSSE, initSSE } from "../shared/sse.js";
import { setupBranch, collectDiff, commitAndSave } from "../shared/git.js";
import {
  runReviewLoop,
  CODER_MODEL,
  CODER_TOOLS,
  CODER_TIMEOUT_MS,
  MOBILE_CODER_TIMEOUT_MS,
} from "../shared/coderLoop.js";
import type { RepoReviewLog, ReviewIssue } from "../shared/reviewer.js";

// ── Knowledge injection ──
import { loadMobileCoderKnowledge } from "../shared/knowledge.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CoderSpec {
  /** Which repos to work in. */
  repos: ExtendedRepoKey[];
  /** Free-form task description. */
  task: string;
  /** Optional extra context. */
  additionalContext?: string;
}

interface RepoResult extends SkillRepoResult {
  reviewLog: RepoReviewLog[];
}

// ─── Coder prompt builders ───────────────────────────────────────────────────

function buildCoderPrompt(task: string, repoDescription: string, additionalContext?: string): string {
  return `You are an expert coding assistant working in a payment SDK codebase.

## Repository

${repoDescription}

## Task

${task}

${additionalContext ? `## Additional Context\n\n${additionalContext}\n` : ""}

## Guidelines

1. **Follow existing patterns** — Before writing new code, READ similar existing files to match the conventions (naming, structure, imports).
2. **Prefer extending over creating** — If an existing function or switch statement can be extended with a small change, do that instead of writing entirely new code.
3. **Use existing helpers** — Search for reusable functions before writing new utilities.
4. **No debug logs** — Do not leave console.log or debug statements in production code.
5. **Clean code** — Follow the codebase's formatting and style conventions.

After completing the task, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}]}`;
}

function buildCombinedMobileCoderPrompt(task: string, additionalContext?: string): string {
  return buildCoderPrompt(
    task,
    `Your working directory contains TWO repositories:
- \`hyperswitch-client-core/\` — ReScript consumer SDK (hooks, modules, types, native view bindings)
- \`react-native-hyperswitch/\` — NPM packages with native iOS/Android modules (Swift, Kotlin, TypeScript bridge)

**Important:** If you modify native module interfaces in react-native-hyperswitch, the ReScript bindings in hyperswitch-client-core must match exactly.`,
    additionalContext,
  );
}

function buildSingleRepoCoderPrompt(task: string, repoKey: ExtendedRepoKey, additionalContext?: string): string {
  const descriptions: Record<ExtendedRepoKey, string> = {
    mobile: `Your working directory contains:
- \`hyperswitch-client-core/\` — ReScript consumer SDK (hooks, modules, types, native view bindings)`,
    rn_packages: `Your working directory contains:
- \`react-native-hyperswitch/\` — NPM packages with native iOS/Android modules (Swift, Kotlin, TypeScript bridge)`,
    web: `Your working directory contains:
- \`hyperswitch-web/\` — the web SDK repo (ReScript + React)`,
  };
  return buildCoderPrompt(task, descriptions[repoKey] || `Working in ${REPOS[repoKey].name}.`, additionalContext);
}

// ─── Review prompt builders (simpler than integration — no classification) ───

function buildCoderReviewPrompt(task: string, repoDescription: string): (diff: string, previousIssues?: ReviewIssue[]) => string {
  return (diff, previousIssues) => {
    const previousSection = previousIssues?.length
      ? `
## Previous Issues (supposedly fixed — verify they are actually resolved)

${previousIssues
  .map(
    (i, idx) =>
      `${idx + 1}. **[${i.severity}] ${i.check}** in \`${i.file}\`: ${i.description}
   Suggested fix: ${i.suggestedFix}`,
  )
  .join("\n")}
`
      : "";

    return `You are a senior code reviewer for a payment SDK codebase.

## Repository

${repoDescription}

## Original Task

${task}

## Your task

You have full access to the codebase via Read, Grep, and Glob tools. Do NOT just review the diff in isolation.

### Step 1: Read the diff below to understand what was changed.

### Step 2: Explore the codebase to verify quality.

Use your tools to:
- **Read similar existing files** to check the new code follows the same patterns, naming conventions, and structure.
- **Search for reusable functions** that already exist. Flag any case where existing code was duplicated instead of reused.
- **Check if an existing function could be extended** with a minimal change instead of writing entirely new code.
- **Verify wiring** — check that any new modules/components are properly connected into the existing architecture.
- **Check naming conventions** — are new file names, function names, type names consistent with existing patterns?

### Step 3: Review checklist

1. **No debug logs** — No \`console.log\`, \`Console.log\` in production code.
2. **Pattern consistency** — Does the code follow the same patterns as similar existing code?
3. **Reuse over duplication** — Are existing helpers/functions used where applicable?
4. **Error handling** — Are error cases handled properly?
5. **Type safety** — Are types used correctly?
6. **Clean diff** — No unrelated changes, no leftover boilerplate.

${previousSection}

## Diff to Review

\`\`\`diff
${diff.slice(0, 40000)}
\`\`\`

## Output Format

After your exploration, return ONLY valid JSON (no fences, no explanation):

{
  "approved": true/false,
  "issues": [
    {
      "file": "relative/path/to/file",
      "check": "name of the check that failed",
      "severity": "blocker" | "warning" | "nit",
      "description": "what's wrong",
      "suggestedFix": "concrete fix"
    }
  ],
  "summary": "one paragraph summary including what you explored and verified"
}

Set "approved" to true ONLY if there are ZERO blockers and ZERO warnings. Nits are acceptable.
If the diff is empty, set approved to true with an empty issues array.`;
  };
}

function buildCoderFixPrompt(task: string, issues: ReviewIssue[], diff: string): string {
  const blockersAndWarnings = issues.filter((i) => i.severity !== "nit");
  return `You were working on this task: ${task}

A reviewer found the following issues that MUST be fixed:

${blockersAndWarnings
  .map(
    (i, idx) =>
      `${idx + 1}. **[${i.severity}] ${i.check}** in \`${i.file}\`:
   Problem: ${i.description}
   Fix: ${i.suggestedFix}`,
  )
  .join("\n\n")}

## Current diff (for reference)

\`\`\`diff
${diff.slice(0, 20000)}
\`\`\`

Fix ALL the issues above. Use Edit/Write/Read/Glob/Grep tools. After fixing, output a brief summary of what you changed.`;
}

// ─── Execution helpers ───────────────────────────────────────────────────────

function makeSlug(task: string): string {
  return task
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/-$/, "")
    || "task";
}

/**
 * Run combined mobile coder (both client-core + rn-packages).
 */
async function runCombinedMobile(
  spec: CoderSpec,
  res: Response,
): Promise<Record<string, RepoResult>> {
  const slug = makeSlug(spec.task);
  const branchName = `feat/coder-${slug}`;
  const cwd = INTEGRATION_TARGET_CWD.mobile;

  const mobileSetup = await setupBranch("mobile", branchName);
  const rnSetup = await setupBranch("rn_packages", branchName);

  sendSSE(res, {
    type: "progress",
    repo: "mobile",
    message: `Working on task across client-core + rn-packages...`,
  });

  // Load codebase knowledge for system prompt injection
  const knowledge = await loadMobileCoderKnowledge();

  const coderSummary = await ask(
    buildCombinedMobileCoderPrompt(spec.task, spec.additionalContext),
    {
      model: CODER_MODEL,
      timeoutMs: MOBILE_CODER_TIMEOUT_MS,
      cwd,
      allowedTools: CODER_TOOLS,
      system: knowledge || undefined,
    },
  );

  const mobileResult = await collectDiff(mobileSetup.git);
  const rnResult = await collectDiff(rnSetup.git);
  const totalFiles = mobileResult.fileCount + rnResult.fileCount;

  if (totalFiles === 0) {
    await mobileSetup.git.checkout(mobileSetup.defaultBranch);
    await rnSetup.git.checkout(rnSetup.defaultBranch);
    try { await mobileSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    try { await rnSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Coder did not produce any file changes");
  }

  // Review loop
  const combinedDiffGetter = async () => {
    const parts: string[] = [];
    const md = await collectDiff(mobileSetup.git);
    if (md.diff) parts.push(`# hyperswitch-client-core\n${md.diff}`);
    const rn = await collectDiff(rnSetup.git);
    if (rn.diff) parts.push(`# react-native-hyperswitch\n${rn.diff}`);
    return parts.join("\n\n");
  };

  const repoDesc = `Two repositories:\n- hyperswitch-client-core (ReScript)\n- react-native-hyperswitch (native modules)`;
  const reviewPromptBuilder = buildCoderReviewPrompt(spec.task, repoDesc);
  const fixPromptBuilder = (issues: ReviewIssue[], diff: string) =>
    buildCoderFixPrompt(spec.task, issues, diff);

  const { reviewLog } = await runReviewLoop({
    targetLabel: "mobile",
    cwd,
    getDiff: combinedDiffGetter,
    buildReviewPrompt: reviewPromptBuilder,
    buildFixPrompt: fixPromptBuilder,
    res,
    system: knowledge || undefined,
  });

  // Final diffs and commits
  const finalMobile = await collectDiff(mobileSetup.git);
  const finalRn = await collectDiff(rnSetup.git);

  if (finalMobile.diff) {
    await commitAndSave(mobileSetup.git, mobileSetup.defaultBranch, spec.task.slice(0, 72), "mobile", slug, finalMobile.diff, "coder");
  } else {
    await mobileSetup.git.checkout(mobileSetup.defaultBranch);
    try { await mobileSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
  }

  if (finalRn.diff) {
    await commitAndSave(rnSetup.git, rnSetup.defaultBranch, spec.task.slice(0, 72), "rn_packages", slug, finalRn.diff, "coder");
  } else {
    await rnSetup.git.checkout(rnSetup.defaultBranch);
    try { await rnSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
  }

  sendSSE(res, {
    type: "repo_done",
    repo: "mobile",
    message: `Done — ${finalMobile.fileCount + finalRn.fileCount} files changed`,
  });

  return {
    mobile: {
      repo: "mobile",
      branch: finalMobile.diff ? branchName : "",
      summary: coderSummary.slice(0, 5000),
      diff: finalMobile.diff,
      filesTouched: finalMobile.fileCount,
      reviewLog,
    },
    rn_packages: {
      repo: "rn_packages",
      branch: finalRn.diff ? branchName : "",
      summary: coderSummary.slice(0, 5000),
      diff: finalRn.diff,
      filesTouched: finalRn.fileCount,
      reviewLog,
    },
  };
}

/**
 * Run single-repo coder.
 */
async function runSingleRepo(
  spec: CoderSpec,
  repoKey: ExtendedRepoKey,
  res: Response,
): Promise<RepoResult> {
  const slug = makeSlug(spec.task);
  const branchName = `feat/coder-${slug}`;

  // Determine cwd
  let cwd: string;
  if (repoKey === "web") {
    cwd = INTEGRATION_TARGET_CWD.web;
  } else if (repoKey === "mobile") {
    cwd = INTEGRATION_TARGET_CWD.mobile;
  } else {
    // rn_packages alone — still use mobile workspace so paths resolve
    cwd = INTEGRATION_TARGET_CWD.mobile;
  }

  const { git, defaultBranch } = await setupBranch(repoKey, branchName);

  sendSSE(res, {
    type: "progress",
    repo: repoKey,
    message: `Working on task in ${REPOS[repoKey].name}...`,
  });

  // Load codebase knowledge for mobile repos only
  const knowledge = repoKey !== "web" ? await loadMobileCoderKnowledge() : "";

  const coderSummary = await ask(
    buildSingleRepoCoderPrompt(spec.task, repoKey, spec.additionalContext),
    {
      model: CODER_MODEL,
      timeoutMs: CODER_TIMEOUT_MS,
      cwd,
      allowedTools: CODER_TOOLS,
      system: knowledge || undefined,
    },
  );

  const initial = await collectDiff(git);
  if (!initial.diff || initial.fileCount === 0) {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error(`Coder did not produce any file changes for ${REPOS[repoKey].name}`);
  }

  // Review loop
  const diffGetter = async () => {
    const r = await collectDiff(git);
    return r.diff;
  };

  const repoDesc = `Repository: ${REPOS[repoKey].name}`;
  const reviewPromptBuilder = buildCoderReviewPrompt(spec.task, repoDesc);
  const fixPromptBuilder = (issues: ReviewIssue[], diff: string) =>
    buildCoderFixPrompt(spec.task, issues, diff);

  const { reviewLog } = await runReviewLoop({
    targetLabel: repoKey,
    cwd,
    getDiff: diffGetter,
    buildReviewPrompt: reviewPromptBuilder,
    buildFixPrompt: fixPromptBuilder,
    res,
    system: knowledge || undefined,
  });

  const final = await collectDiff(git);
  if (final.diff) {
    await commitAndSave(git, defaultBranch, spec.task.slice(0, 72), repoKey, slug, final.diff, "coder");
  } else {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  }

  sendSSE(res, {
    type: "repo_done",
    repo: repoKey,
    message: `Done — ${final.fileCount} files changed`,
  });

  return {
    repo: repoKey,
    branch: final.diff ? branchName : "",
    summary: coderSummary.slice(0, 5000),
    diff: final.diff,
    filesTouched: final.fileCount,
    reviewLog,
  };
}

// ─── Generate endpoint (SSE) ─────────────────────────────────────────────────

export async function handleCoderSkill(
  req: Request,
  res: Response,
): Promise<void> {
  const spec = req.body as CoderSpec;

  if (!spec.task?.trim() || !spec.repos?.length) {
    res.status(400).json({
      error: "task and repos are required",
    });
    return;
  }

  initSSE(res);

  const results: Record<string, RepoResult> = {};

  try {
    // Check if both mobile repos are selected — use combined coder
    const hasMobile = spec.repos.includes("mobile");
    const hasRnPackages = spec.repos.includes("rn_packages");
    const hasWeb = spec.repos.includes("web");
    const useCombinedMobile = hasMobile && hasRnPackages;

    if (useCombinedMobile) {
      const mobileResults = await runCombinedMobile(spec, res);
      Object.assign(results, mobileResults);
    } else {
      // Run single-repo for each selected mobile repo
      if (hasMobile) {
        try {
          results.mobile = await runSingleRepo(spec, "mobile", res);
        } catch (err) {
          const errorMsg = (err as Error).message;
          sendSSE(res, { type: "error", repo: "mobile", message: errorMsg });
          results.mobile = {
            repo: "mobile",
            branch: "",
            summary: "",
            diff: "",
            filesTouched: 0,
            error: errorMsg,
            reviewLog: [],
          };
        }
      }
      if (hasRnPackages) {
        try {
          results.rn_packages = await runSingleRepo(spec, "rn_packages", res);
        } catch (err) {
          const errorMsg = (err as Error).message;
          sendSSE(res, { type: "error", repo: "rn_packages", message: errorMsg });
          results.rn_packages = {
            repo: "rn_packages",
            branch: "",
            summary: "",
            diff: "",
            filesTouched: 0,
            error: errorMsg,
            reviewLog: [],
          };
        }
      }
    }

    if (hasWeb) {
      try {
        results.web = await runSingleRepo(spec, "web", res);
      } catch (err) {
        const errorMsg = (err as Error).message;
        sendSSE(res, { type: "error", repo: "web", message: errorMsg });
        results.web = {
          repo: "web",
          branch: "",
          summary: "",
          diff: "",
          filesTouched: 0,
          error: errorMsg,
          reviewLog: [],
        };
      }
    }

    const allResults = Object.values(results);
    const hasError = allResults.some((r) => r.error);
    const allError = allResults.length > 0 && allResults.every((r) => r.error);

    sendSSE(res, {
      type: "done",
      message: allError ? "All repos failed" : hasError ? "Completed with some errors" : "All repos completed successfully",
      data: {
        skillId: "coder",
        status: allError ? "error" : hasError ? "partial" : "ok",
        results,
        meta: { task: spec.task },
      },
    });
  } catch (err) {
    sendSSE(res, { type: "error", message: (err as Error).message });
  } finally {
    res.end();
  }
}
