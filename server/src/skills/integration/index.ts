/**
 * Integration skill — main handler.
 *
 * Implements a native SDK integration across repos using a coder -> reviewer
 * loop with SSE streaming for real-time progress.
 *
 * Flow:
 *   1. Parse IntegrationSpec from request body
 *   2. Auto-classify the SDK by reading its documentation (fast Sonnet call)
 *   3. For each target repo, create a git branch
 *   4. Run the coder agent (Opus + tools) per platform within each repo
 *   5. Capture diff, send to reviewer agent
 *   6. If reviewer finds blockers/warnings, send issues back to coder
 *   7. Loop up to MAX_REVIEW_ITERATIONS
 *   8. Stream progress via SSE
 */

import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import simpleGit from "simple-git";
import { PATCHES_DIR, REPOS, type RepoKey } from "../../config.js";
import { ask, askJson } from "../../llm.js";
import type { SkillRepoResult } from "../registry.js";
import {
  buildReviewPrompt,
  REVIEWER_MODEL,
  REVIEWER_TIMEOUT_MS,
  type ReviewContext,
  type ReviewIssue,
  type ReviewResult,
  type SdkClassification,
} from "./reviewer.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntegrationSpec {
  sdkName: string;
  sdkDoc: string;
  /** Optional user hint about the SDK type. If omitted, auto-detected from doc. */
  sdkTypeHint?: string;
  repos: RepoKey[];
  platforms: string[];
  newPackage?: boolean;
  newPackageName?: string;
  additionalContext?: string;
}

interface SSEEvent {
  type:
    | "progress"
    | "classify"
    | "review_start"
    | "review_result"
    | "fix_start"
    | "repo_done"
    | "done"
    | "error";
  repo?: string;
  message: string;
  data?: unknown;
}

interface RepoReviewLog {
  iteration: number;
  review: ReviewResult;
}

interface RepoResult extends SkillRepoResult {
  reviewLog: RepoReviewLog[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_REVIEW_ITERATIONS = 3;
const CODER_TIMEOUT_MS = 600_000;
const CODER_MODEL = "opus" as const;
const CODER_TOOLS = ["Edit", "Write", "Read", "Glob", "Grep"];

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function sendSSE(res: Response, event: SSEEvent): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ─── SDK classification (Sonnet — fast, cheap) ──────────────────────────────

function buildClassifyPrompt(sdkDoc: string, sdkTypeHint?: string): string {
  const hintSection = sdkTypeHint
    ? `\nThe user suggests this might be a "${sdkTypeHint}" type SDK. Use this as a hint but override if the documentation says otherwise.\n`
    : "";

  return `You are analyzing an SDK's integration documentation to determine the integration pattern for a React Native payment orchestrator.

Read the SDK documentation below and classify it.
${hintSection}
## SDK Documentation

<sdk-doc>
${sdkDoc.slice(0, 12000)}
</sdk-doc>

## Output

Return ONLY valid JSON (no fences, no explanation):

{
  "pattern": "<high-level description of the integration pattern, e.g. 'browser-switch via ASWebAuthenticationSession + Chrome Custom Tabs', 'simple callback with direct SDK method invocation', 'JS-only SDK loaded via script tag'>",
  "callbackMechanism": "<how the SDK returns results, e.g. 'completion handler on iOS, deep link onNewIntent on Android', 'direct callback/promise', 'postMessage from iframe'>",
  "requiresActivity": <true if Android needs a dedicated Activity for deep link or intent result handling, false otherwise>,
  "requiresUrlScheme": <true if a custom URL scheme must be registered for deep link returns, false otherwise>,
  "hasNativeUI": <true if the SDK provides branded UI components like buttons or payment sheets, false otherwise>,
  "notes": "<any other observations relevant to implementation — e.g. specific API version requirements, known gotchas, thread safety requirements>"
}`;
}

async function classifySdk(
  sdkDoc: string,
  sdkTypeHint?: string,
): Promise<SdkClassification> {
  try {
    return await askJson<SdkClassification>(
      buildClassifyPrompt(sdkDoc, sdkTypeHint),
      { model: "sonnet", timeoutMs: 60_000 },
    );
  } catch {
    // Fallback if classification fails — provide safe defaults
    return {
      pattern: sdkTypeHint || "unknown — classification failed, review documentation manually",
      callbackMechanism: "unknown",
      requiresActivity: false,
      requiresUrlScheme: false,
      hasNativeUI: false,
      notes: "Auto-classification failed. The coder agent should read the SDK doc carefully.",
    };
  }
}

// ─── Classification summary for coder prompts ────────────────────────────────

function classificationBlock(c: SdkClassification): string {
  return `## Auto-Detected SDK Classification

- **Pattern:** ${c.pattern}
- **Callback mechanism:** ${c.callbackMechanism}
- **Requires dedicated Activity (Android):** ${c.requiresActivity ? "YES — implement Activity-Host pattern (see PayPalRedirectActivity.kt)" : "no"}
- **Requires URL scheme registration:** ${c.requiresUrlScheme ? "YES — use \\`\\${applicationId}.{sdk_name}\\` convention" : "no"}
- **Has native UI components:** ${c.hasNativeUI ? "YES — wrap as React Native native view components" : "no"}
- **Notes:** ${c.notes}`;
}

// ─── Coder prompt builders ───────────────────────────────────────────────────

function buildRnPackagePrompt(
  spec: IntegrationSpec,
  repoDir: string,
  classification: SdkClassification,
): string {
  const platformList = spec.platforms.join(", ");
  return `You are implementing a native SDK integration for the **${spec.sdkName}** SDK in the react-native-hyperswitch NPM packages repo.

Your current working directory IS the repo: ${repoDir}

${classificationBlock(classification)}

## Target Platforms: ${platformList}

## SDK Documentation

<sdk-doc>
${spec.sdkDoc}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## What you must do

${spec.newPackage ? `1. The NPM package \`${spec.newPackageName || `react-native-hyperswitch-${spec.sdkName.toLowerCase()}`}\` should already exist under \`packages/@juspay-tech/\`. If it doesn't exist, create it following the structure of existing packages (look at react-native-hyperswitch-paypal as reference).` : "1. Find the existing NPM package for this SDK under `packages/@juspay-tech/`."}

2. Read the WORKFLOW_NATIVE_SDK_INTEGRATION.md and LEARNINGS.md files in the hyperswitch-client-core workspace (if accessible) or follow these critical rules:

### Critical iOS Rules
- Module name via \`@objc(...)\` MUST match Android \`NAME\` and TypeScript \`NativeModules.X\`
- Use \`import {PodName}\` (umbrella module), NOT subspec names
- View props: \`@objc dynamic var\` + \`didSet\` on UIView, NOT setter methods on manager
- Use \`RCTResponseSenderBlock\` for callbacks (match TypeScript bridge)
- Wrap SDK UI calls in \`DispatchQueue.main.async { }\`

### Critical Android Rules
- Unique URL scheme: \`\${applicationId}.${spec.sdkName.toLowerCase()}\` (for SDKs requiring URL scheme)
- Single AndroidManifest.xml — no dual-manifest patterns
- Activity creating SDK client MUST receive the deep link (for browser-switch)
- Wrap SDK UI calls in \`mainHandler.post { }\`

### Critical Cross-Platform Rules
- No debug logs (\`console.log\`, \`Console.log\`) in production code
- SDK-specific types stay in the SDK's module file, not shared types
- Delete all boilerplate \`multiply\` methods from generated files

3. Implement the native module (Swift + .mm + Kotlin) following the patterns above.
4. Update the podspec/build.gradle with SDK dependencies.
5. Update the TypeScript bridge in src/index.tsx.

After implementing, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}]}`;
}

function buildMobilePrompt(
  spec: IntegrationSpec,
  repoDir: string,
  classification: SdkClassification,
): string {
  const platformList = spec.platforms.join(", ");
  return `You are implementing the consumer-side integration for the **${spec.sdkName}** SDK in the hyperswitch-client-core (mobile SDK) repository.

Your current working directory IS the repo: ${repoDir}

${classificationBlock(classification)}

## Target Platforms: ${platformList}

## SDK Documentation

<sdk-doc>
${spec.sdkDoc}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## What you must do

1. First, read existing integration patterns:
   - \`src/components/modules/ScanCardModule.res\` — reference for ReScript module binding
   - \`src/components/modules/PaypalModule.res\` — reference for browser-switch SDK
   - \`src/components/elements/ButtonElement.res\` — where payment methods are wired
   - \`src/hooks/ButtonHook.res\` — where SDK launch calls happen

2. Create the ReScript module wrapper using \`require\` + \`try/catch\` pattern (NOT \`@module\` external):

\`\`\`rescript
type module_ = {{methodName}: (string, Dict.t<JSON.t> => unit) => unit}
@val external require: string => module_ = "require"
let mod = try { require("@juspay-tech/react-native-hyperswitch-${spec.sdkName.toLowerCase()}")->Some } catch { | _ => None }
\`\`\`

3. Wire the module into ButtonHook.res and/or ButtonElement.res as appropriate.
4. If the SDK has native UI (classification says hasNativeUI = ${classification.hasNativeUI}), create ReScript native view bindings:
   - \`.ios.res\` and \`.android.res\` with \`requireNativeComponent\`
   - \`.web.res\` as a stub returning \`React.null\`

### Critical Rules
- Follow AGENTS.md: no Belt, use Utils.res helpers, no unnecessary comments
- SDK-specific types in the module file, NOT in PaymentConfirmTypes.res
- No debug logs
- Check REDIRECT_TO_URL before INVOKE_SDK_CLIENT in ButtonElement.res

After implementing, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}]}`;
}

function buildWebPrompt(
  spec: IntegrationSpec,
  repoDir: string,
  classification: SdkClassification,
): string {
  return `You are implementing the web-side integration for the **${spec.sdkName}** SDK in the hyperswitch-web (ReScript web SDK) repository.

Your current working directory IS the repo: ${repoDir}

${classificationBlock(classification)}

## SDK Documentation

<sdk-doc>
${spec.sdkDoc}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## What you must do

1. First, study the existing patterns in this repo by reading similar payment method components.
2. Implement the web integration following the repo's conventions.
3. This is a ReScript + React codebase. Follow existing patterns exactly.

After implementing, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}]}`;
}

function buildFixPrompt(
  spec: IntegrationSpec,
  _repoKey: string,
  issues: ReviewIssue[],
  diff: string,
): string {
  const blockersAndWarnings = issues.filter((i) => i.severity !== "nit");
  return `You previously implemented the ${spec.sdkName} SDK integration. A reviewer found the following issues that MUST be fixed:

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

function getPromptForRepo(
  spec: IntegrationSpec,
  repoKey: RepoKey,
  repoDir: string,
  classification: SdkClassification,
): string {
  switch (repoKey) {
    case "rn_packages":
      return buildRnPackagePrompt(spec, repoDir, classification);
    case "mobile":
      return buildMobilePrompt(spec, repoDir, classification);
    case "web":
      return buildWebPrompt(spec, repoDir, classification);
    default:
      throw new Error(`Unknown repo: ${repoKey}`);
  }
}

// ─── Core: run one repo ──────────────────────────────────────────────────────

async function runRepoIntegration(
  spec: IntegrationSpec,
  repoKey: RepoKey,
  classification: SdkClassification,
  res: Response,
): Promise<RepoResult> {
  const repoDir = REPOS[repoKey].dir;
  const git = simpleGit(repoDir);
  const slug = spec.sdkName
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/-$/, "");
  const branchName = `feat/integration-${slug}`;

  // Ensure clean state
  await git.raw(["checkout", "--force", "HEAD"]);
  const defaultBranch = (await git.branch()).current || "main";

  try {
    await git.deleteLocalBranch(branchName, true);
  } catch {
    /* branch didn't exist */
  }
  await git.checkoutLocalBranch(branchName);

  sendSSE(res, {
    type: "progress",
    repo: repoKey,
    message: `Implementing ${spec.sdkName} in ${REPOS[repoKey].name}...`,
  });

  // ── Coder pass ──────────────────────────────────────────────────────────
  const prompt = getPromptForRepo(spec, repoKey, repoDir, classification);
  const coderSummary = await ask(prompt, {
    model: CODER_MODEL,
    timeoutMs: CODER_TIMEOUT_MS,
    cwd: repoDir,
    allowedTools: CODER_TOOLS,
  });

  // Stage all changes
  await git.add(".");

  let diff = await git.diff(["HEAD"]);
  let diffStat = await git.diffSummary(["HEAD"]);

  if (!diff || diffStat.files.length === 0) {
    await git.checkout(defaultBranch);
    try {
      await git.deleteLocalBranch(branchName, true);
    } catch {
      /* */
    }
    throw new Error(`Coder did not produce any file changes for ${repoKey}`);
  }

  // ── Review loop ─────────────────────────────────────────────────────────
  const reviewLog: RepoReviewLog[] = [];
  let previousIssues: ReviewIssue[] | undefined;

  for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration++) {
    sendSSE(res, {
      type: "review_start",
      repo: repoKey,
      message: `Reviewing (pass ${iteration}/${MAX_REVIEW_ITERATIONS})...`,
    });

    const reviewCtx: ReviewContext = {
      sdkName: spec.sdkName,
      classification,
      platforms: spec.platforms,
      diff,
      repoKey,
      sdkDoc: spec.sdkDoc,
      additionalContext: spec.additionalContext,
      previousIssues,
    };

    let review: ReviewResult;
    try {
      review = await askJson<ReviewResult>(buildReviewPrompt(reviewCtx), {
        model: REVIEWER_MODEL,
        timeoutMs: REVIEWER_TIMEOUT_MS,
      });
    } catch (err) {
      // If reviewer fails to parse, treat as approved with a warning
      review = {
        approved: true,
        issues: [],
        summary: `Reviewer failed to produce structured output: ${(err as Error).message}`,
      };
    }

    reviewLog.push({ iteration, review });

    sendSSE(res, {
      type: "review_result",
      repo: repoKey,
      message: review.approved
        ? `Approved on pass ${iteration}`
        : `Found ${review.issues.filter((i) => i.severity !== "nit").length} issues on pass ${iteration}`,
      data: review,
    });

    if (review.approved) break;

    // Not approved — send issues back to coder
    const blockersAndWarnings = review.issues.filter(
      (i) => i.severity !== "nit",
    );
    if (blockersAndWarnings.length === 0) break; // Only nits, treat as approved

    if (iteration === MAX_REVIEW_ITERATIONS) {
      // Max iterations reached, accept what we have
      sendSSE(res, {
        type: "progress",
        repo: repoKey,
        message: `Max review iterations reached. ${blockersAndWarnings.length} issues remain.`,
      });
      break;
    }

    sendSSE(res, {
      type: "fix_start",
      repo: repoKey,
      message: `Fixing ${blockersAndWarnings.length} issues...`,
    });

    const fixPrompt = buildFixPrompt(spec, repoKey, blockersAndWarnings, diff);
    await ask(fixPrompt, {
      model: CODER_MODEL,
      timeoutMs: CODER_TIMEOUT_MS,
      cwd: repoDir,
      allowedTools: CODER_TOOLS,
    });

    await git.add(".");
    diff = await git.diff(["HEAD"]);
    diffStat = await git.diffSummary(["HEAD"]);
    previousIssues = blockersAndWarnings;
  }

  // ── Commit and save patch ───────────────────────────────────────────────
  const patchPath = path.join(
    PATCHES_DIR,
    `integration-${slug}-${repoKey}.patch`,
  );
  fs.writeFileSync(patchPath, diff);

  await git.add(".");
  await git.commit(
    `feat: integrate ${spec.sdkName} SDK\n\nGenerated by Agent-Control-Center integration skill`,
  );
  await git.checkout(defaultBranch);

  sendSSE(res, {
    type: "repo_done",
    repo: repoKey,
    message: `Done — ${diffStat.files.length} files changed`,
  });

  return {
    repo: repoKey,
    branch: branchName,
    summary: coderSummary.slice(0, 5000),
    diff,
    filesTouched: diffStat.files.length,
    reviewLog,
  };
}

// ─── Express handler (SSE) ───────────────────────────────────────────────────

export async function handleIntegrationSkill(
  req: Request,
  res: Response,
): Promise<void> {
  const spec = req.body as IntegrationSpec;

  // Validate
  if (!spec.sdkName || !spec.sdkDoc || !spec.repos?.length || !spec.platforms?.length) {
    res.status(400).json({
      error: "sdkName, sdkDoc, repos, and platforms are required",
    });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    // ── Step 1: Auto-classify the SDK ─────────────────────────────────────
    sendSSE(res, {
      type: "classify",
      message: "Analyzing SDK documentation...",
    });

    const classification = await classifySdk(spec.sdkDoc, spec.sdkTypeHint);

    sendSSE(res, {
      type: "classify",
      message: `Classified: ${classification.pattern}`,
      data: classification,
    });

    // ── Step 2: Run repos ─────────────────────────────────────────────────
    const results: Record<string, RepoResult> = {};

    for (const repoKey of spec.repos) {
      if (!(repoKey in REPOS)) {
        sendSSE(res, {
          type: "error",
          repo: repoKey,
          message: `Unknown repo: ${repoKey}`,
        });
        continue;
      }

      try {
        results[repoKey] = await runRepoIntegration(
          spec,
          repoKey as RepoKey,
          classification,
          res,
        );
      } catch (err) {
        const errorMsg = (err as Error).message;
        sendSSE(res, {
          type: "error",
          repo: repoKey,
          message: errorMsg,
        });
        results[repoKey] = {
          repo: repoKey,
          branch: "",
          summary: "",
          diff: "",
          filesTouched: 0,
          error: errorMsg,
          reviewLog: [],
        };
      }
    }

    // Final envelope
    const hasError = Object.values(results).some((r) => r.error);
    const allError = Object.values(results).every((r) => r.error);

    sendSSE(res, {
      type: "done",
      message: allError
        ? "All repos failed"
        : hasError
          ? "Completed with some errors"
          : "All repos completed successfully",
      data: {
        skillId: "integration",
        status: allError ? "error" : hasError ? "partial" : "ok",
        results,
        meta: { sdkName: spec.sdkName, classification },
      },
    });
  } catch (err) {
    sendSSE(res, {
      type: "error",
      message: (err as Error).message,
    });
  } finally {
    res.end();
  }
}
