/**
 * SDK Integrator skill — main handler.
 *
 * Two endpoints:
 *   POST /skills/sdk-integrator/classify  — Sonnet reads SDK doc, returns SdkClassification (JSON)
 *   POST /skills/sdk-integrator/generate  — Takes confirmed classification + spec, runs coder+reviewer (SSE)
 *
 * Architecture:
 *   - "mobile" target → single coder subprocess for BOTH hyperswitch-client-core
 *     and react-native-hyperswitch (cwd = workspace/mobile/)
 *   - "web" target → single coder subprocess for hyperswitch-web (cwd = workspace/web/)
 *   - Reviewer gets tool access (Read/Grep/Glob) to explore the codebase deeply
 *   - mobileSubRepos controls which sub-repos to include (default: both)
 */

import type { Request, Response } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  INTEGRATION_TARGET_CWD,
  REPOS,
  type IntegrationTarget,
  type ExtendedRepoKey,
} from "../../config.js";
import { askStream, askJson } from "../../llm.js";
import type { SkillRepoResult } from "../registry.js";

// ── Shared helpers ──
import { sendSSE, initSSE } from "../shared/sse.js";
import { setupBranch, collectDiff, commitAndSave } from "../shared/git.js";
import {
  runReviewLoop,
  forwardCoderChunk,
  CODER_MODEL,
  CODER_TOOLS,
  CODER_TIMEOUT_MS,
  MOBILE_CODER_TIMEOUT_MS,
} from "../shared/coderLoop.js";
import type { RepoReviewLog, ReviewIssue } from "../shared/reviewer.js";

// ── Integration-specific ──
import {
  deriveReferencePattern,
  deriveTargetFiles,
  makeIntegrationReviewPrompt,
  type SdkClassification,
} from "./reviewer.js";

// ── Knowledge injection ──
import { loadMobileIntegrationKnowledge } from "../shared/knowledge.js";

// ── Repo sync ──
import { ensureRepo } from "../../workspace/repoManager.js";

// ── Push + PR ──
import { pushBranchToFork, createPullRequest, forkSlug } from "../githubPr.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Sent to /classify — just the SDK doc + optional hint. */
export interface ClassifyRequest {
  sdkDoc: string;
  sdkTypeHint?: string;
}

/** Which sub-repos to include when target is "mobile". */
export type MobileSubRepo = "client_core" | "rn_packages";

/** Sent to /generate — the full spec with user-confirmed classification. */
export interface IntegrationSpec {
  sdkName: string;
  sdkDoc: string;
  classification: SdkClassification;
  /** User-facing targets: "web" | "mobile". "mobile" = both client-core + rn-packages. */
  targets: IntegrationTarget[];
  platforms: string[];
  /** Optional custom NPM package name. Defaults to `react-native-hyperswitch-${sdkName.toLowerCase()}`. */
  packageNameOverride?: string;
  /** Optional existing branch to extend (e.g. another integration still in progress).
   *  When set, the feature branch is created off this instead of main. */
  baseBranch?: string;
  additionalContext?: string;
  /** Which sub-repos to include for mobile. Defaults to both. */
  mobileSubRepos?: MobileSubRepo[];
}

interface RepoResult extends SkillRepoResult {
  reviewLog: RepoReviewLog[];
}

// ─── Package scaffolder (`create-react-native-library`) ─────────────────────

/**
 * Run `npx create-react-native-library@0.49.8` inside the rn_packages workspace
 * to bootstrap a new package under `packages/@juspay-tech/{pkgName}`. This is
 * what WORKFLOW_NATIVE_SDK_INTEGRATION.md Phase 1A.1 requires but the coder
 * can't do itself (no Bash tool). Running it here gives the coder a valid
 * builder-bob package skeleton to Edit on top of.
 *
 * Non-fatal on failure — if the package dir already exists (re-run) or the
 * scaffolder errors out, we log a warning and let the coder proceed. The
 * coder can still hand-author what's missing.
 */
async function scaffoldRnPackage(args: {
  rnPackagesDir: string;
  pkgName: string;
  sdkName: string;
  res: Response;
}): Promise<{ scaffolded: boolean; warning: string | null }> {
  const { rnPackagesDir, pkgName, sdkName, res } = args;
  const packagesDir = path.join(rnPackagesDir, "packages", "@juspay-tech");
  const pkgDir = path.join(packagesDir, pkgName);

  if (fs.existsSync(pkgDir)) {
    sendSSE(res, {
      type: "progress",
      repo: "mobile",
      message: `Package ${pkgName} already exists — skipping scaffold`,
    });
    return { scaffolded: false, warning: null };
  }

  sendSSE(res, {
    type: "phase",
    repo: "mobile",
    message: `Scaffolding ${pkgName} with create-react-native-library`,
  });

  fs.mkdirSync(packagesDir, { recursive: true });

  // Non-interactive mode is driven by CI=1 in env (set on spawn below) — the
  // 0.49.x CLI rejects a `--no-interactive` flag explicitly, so don't pass it.
  const cliArgs = [
    "create-react-native-library@0.49.8",
    pkgName,
    "--slug", `@juspay-tech/${pkgName}`,
    "--description", `React Native wrapper for ${sdkName} SDK`,
    // 0.49.x type options: turbo-module | fabric-view | nitro-module
    //                    | legacy-module | legacy-view | library
    // `legacy-module` matches the existing @juspay-tech packages (old-style
    // ViewManager + NativeModule), so the coder's Edit patterns apply cleanly.
    "--type", "legacy-module",
    "--languages", "kotlin-swift",
    "--example", "vanilla",
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npx", cliArgs, {
        cwd: packagesDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1" },
      });
      let stderr = "";
      child.stdout?.on("data", (b) => {
        const s = b.toString().trim();
        if (s) {
          sendSSE(res, { type: "text", repo: "mobile", message: s.slice(0, 200) });
        }
      });
      child.stderr?.on("data", (b) => (stderr += b.toString()));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`create-react-native-library exited ${code}: ${stderr.slice(0, 500)}`));
      });
    });
    sendSSE(res, {
      type: "progress",
      repo: "mobile",
      message: `Scaffold complete: packages/@juspay-tech/${pkgName}`,
    });
    return { scaffolded: true, warning: null };
  } catch (err) {
    const warning = `Scaffold failed: ${(err as Error).message}`;
    sendSSE(res, { type: "error", repo: "mobile", message: warning });
    return { scaffolded: false, warning };
  }
}

// ─── Push + PR helper ───────────────────────────────────────────────────────

interface PrOutcome {
  prUrl: string | null;
  prNumber: number | null;
  prWarning: string | null;
}

/**
 * Force-push a feature branch to the bot fork and open a PR against that
 * fork's own main. Emits SSE events so the UI shows live progress. Non-fatal
 * on failure — returns a warning instead of throwing.
 */
async function pushAndOpenPr(args: {
  repoKey: ExtendedRepoKey;
  repoDir: string;
  branch: string;
  sdkName: string;
  res: Response;
}): Promise<PrOutcome> {
  const { repoKey, repoDir, branch, sdkName, res } = args;
  const label = String(repoKey);

  sendSSE(res, {
    type: "phase",
    repo: label,
    message: `Pushing to ${forkSlug(repoKey)}`,
  });

  try {
    await pushBranchToFork(repoDir, repoKey, branch);
  } catch (err) {
    const warning = `Push failed: ${(err as Error).message}`;
    sendSSE(res, { type: "error", repo: label, message: warning });
    return { prUrl: null, prNumber: null, prWarning: warning };
  }

  sendSSE(res, {
    type: "phase",
    repo: label,
    message: `Opening PR on ${forkSlug(repoKey)}`,
  });

  try {
    const { prUrl, prNumber } = await createPullRequest({
      repoKey,
      branch,
      title: `integrate ${sdkName} SDK`,
      body:
        `## Summary\n\nIntegrate the **${sdkName}** SDK into this repo.\n\n` +
        `## Generated by\n\nAgent-Control-Center sdk-integrator skill.\n\n` +
        `---\n*Automated PR. Reviewer: please verify the implementation matches existing patterns in this repo.*\n`,
    });
    sendSSE(res, {
      type: "progress",
      repo: label,
      message: `PR opened: ${prUrl}`,
      data: { prUrl, prNumber },
    });
    return { prUrl, prNumber, prWarning: null };
  } catch (err) {
    const warning = `PR creation failed: ${(err as Error).message}`;
    sendSSE(res, { type: "error", repo: label, message: warning });
    return { prUrl: null, prNumber: null, prWarning: warning };
  }
}

// ─── SDK classification (Sonnet — fast, cheap) ──────────────────────────────

function buildClassifyPrompt(sdkDoc: string, sdkTypeHint?: string): string {
  const hintSection = sdkTypeHint
    ? `\nThe user suggests this might be a "${sdkTypeHint}" type SDK. Use this as a hint but override if the documentation says otherwise.\n`
    : "";

  return `You are analyzing an SDK's integration documentation to classify it for a React Native payment orchestrator.

Read the SDK documentation below and classify it along multiple dimensions.
${hintSection}
## SDK Documentation

<sdk-doc>
${sdkDoc.slice(0, 12000)}
</sdk-doc>

## Classification Dimensions

### 1. UI Entry Point — How does the user interact with this SDK?
- "native_view": Vendor ships a native view (button or inline widget) that you wrap as a React Native ViewManager. The view itself — rendered by the vendor's native code — is what the user sees. Google Pay, Apple Pay (button-shaped native view), Klarna (panel-shaped native view with ref-based authorize).
- "custom_trigger_button": Vendor gives only a bridge/launch API, no native view. You build your own React Native button; tapping it calls the vendor's launch function. PayPal.
- "invisible": No UI at all, bridge module called programmatically (3DS authentication, fraud fingerprinting).
- "utility_ui": ViewManager for a helper surface that is not a payment entry (card scanner camera).
- "other": Something else

### 2. API Chain — What sequence of API calls bootstraps this SDK?
Known patterns in the codebase:
- "session_direct": session_tokens API → SDK invocation (Google Pay, Apple Pay). Session response has all needed data.
- "session_post_session": session_tokens → post_session_tokens → SDK (PayPal). Session response has sdk_next_action.next_action = "post_session_tokens", second call returns order data.
- "confirm_next_action": confirm payment → handle next_action from response (Netcetera 3DS, Plaid). SDK is triggered by the confirm response.
- "no_api": No API involvement, SDK runs independently (card scanner, device fingerprinting).
- "custom": A new pattern not matching any above — describe it.

For each step provide: endpoint name, trigger field/value, extracted data.

### 3. Confirm Timing — When does payment confirm happen relative to SDK invocation?
- "post_sdk_with_data": SDK provides data (token) that is used IN the confirm call body (Google Pay, Apple Pay)
- "post_sdk_status_only": SDK completes its flow, then confirm is called separately (PayPal)
- "pre_sdk": Confirm happens first, SDK is triggered by the confirm response (Netcetera 3DS)
- "not_applicable": No confirm tied to this SDK at all (card scanner, fraud fingerprint)
- "custom": Something else

## Output

Return ONLY valid JSON (no fences, no explanation):

{
  "pattern": "<high-level description>",
  "callbackMechanism": "<how SDK returns results>",
  "requiresActivity": <boolean>,
  "requiresUrlScheme": <boolean>,
  "hasNativeUI": <boolean>,
  "notes": "<observations>",
  "uiEntryPoint": "<native_view | custom_trigger_button | invisible | utility_ui | other>",
  "sdkProvidesButton": <boolean or null if unknown>,
  "apiChain": {
    "knownPattern": "<session_direct | session_post_session | confirm_next_action | no_api | custom>",
    "steps": [
      {
        "endpoint": "<API endpoint or action name>",
        "triggerField": "<field that triggers this step, if any>",
        "triggerValue": "<value of trigger field>",
        "extractedData": ["<field1>", "<field2>"]
      }
    ],
    "description": "<free-form description if custom or complex>"
  },
  "confirmTiming": "<post_sdk_with_data | post_sdk_status_only | pre_sdk | not_applicable | custom>"
}

If you cannot determine a dimension from the documentation, use "other" or "custom" and explain in "notes". The user will fill in Hyperswitch-specific fields (walletVariant, sdkNextAction, nextActionType, paymentExperience) manually — do NOT guess those.`;
}

async function classifySdkFromDoc(
  sdkDoc: string,
  sdkTypeHint?: string,
): Promise<SdkClassification> {
  const base = await askJson<Partial<SdkClassification>>(
    buildClassifyPrompt(sdkDoc, sdkTypeHint),
    { model: "sonnet", timeoutMs: 0 },
  );

  // Fill in defaults for any missing fields
  const classification: SdkClassification = {
    pattern: base.pattern || "unknown",
    callbackMechanism: base.callbackMechanism || "unknown",
    requiresActivity: base.requiresActivity ?? false,
    requiresUrlScheme: base.requiresUrlScheme ?? false,
    hasNativeUI: base.hasNativeUI ?? false,
    notes: base.notes || "",
    uiEntryPoint: base.uiEntryPoint || "other",
    sdkProvidesButton: base.sdkProvidesButton,
    apiChain: base.apiChain || { knownPattern: "custom", steps: [], description: "Classification incomplete" },
    confirmTiming: base.confirmTiming || "custom",
    targetFiles: [],
  };

  // Auto-derive reference pattern and target files
  classification.referencePattern = deriveReferencePattern(classification);
  classification.targetFiles = deriveTargetFiles(classification);

  return classification;
}

// ─── Classification summary for coder prompts ────────────────────────────────

function classificationBlock(c: SdkClassification): string {
  const chainSteps = c.apiChain.steps.length > 0
    ? c.apiChain.steps.map((s, i) =>
      `  ${i + 1}. **${s.endpoint}**${s.triggerField ? ` (trigger: ${s.triggerField} = ${s.triggerValue})` : ""}${s.extractedData?.length ? ` → extract: ${s.extractedData.join(", ")}` : ""}`
    ).join("\n")
    : "  (no API steps)";

  return `## SDK Classification (user-confirmed)

### UI & Flow
- **UI Entry Point:** ${c.uiEntryPoint}${c.sdkProvidesButton ? " — SDK provides native button component" : ""}
- **API Chain:** ${c.apiChain.knownPattern || "custom"}${c.apiChain.description ? ` — ${c.apiChain.description}` : ""}
${chainSteps}
- **Confirm Timing:** ${c.confirmTiming}

### Technical Details
- **Pattern:** ${c.pattern}
- **Callback mechanism:** ${c.callbackMechanism}
- **Requires dedicated Activity (Android):** ${c.requiresActivity ? "YES — implement Activity-Host pattern" : "no"}
- **Requires URL scheme registration:** ${c.requiresUrlScheme ? "YES — use \\`\\${applicationId}.{sdk_name}\\` convention" : "no"}
- **Has native UI components:** ${c.hasNativeUI ? "YES — wrap as React Native native view" : "no"}

### Hyperswitch Wiring
${c.walletVariant ? `- **Wallet variant:** ${c.walletVariant} (add this case in ButtonElement.res switch)` : "- **Wallet variant:** not set"}
${c.sdkNextAction ? `- **sdk_next_action value:** "${c.sdkNextAction}" (check this in session response)` : ""}
${c.nextActionType ? `- **next_action.type:** "${c.nextActionType}" (handle this in AllPaymentHooks.res handleApiRes)` : ""}
${c.paymentExperience ? `- **Payment experience:** ${c.paymentExperience}` : ""}
- **Reference pattern:** ${c.referencePattern || "none"} — READ THIS FILE FIRST
- **Target files to create/edit:** ${c.targetFiles.join(", ")}
- **Notes:** ${c.notes}`;
}

// ─── Pattern-specific flow instructions ──────────────────────────────────────

function getFlowInstructions(c: SdkClassification, sdkName: string): string {
  switch (c.apiChain.knownPattern) {
    case "session_direct":
      return `### Flow: session_tokens → SDK (like Google Pay / Apple Pay)
1. Read how ButtonElement.res handles the ${c.walletVariant || "GOOGLE_PAY"} case
2. Session response already has all data needed — extract it and pass to native module
3. After SDK returns data, call processRequest() / handleWalletPayments() with the token`;

    case "session_post_session":
      return `### Flow: session_tokens → post_session_tokens → SDK (like PayPal)
1. READ \`hyperswitch-client-core/src/hooks/PaypalHooks.res\` — this is your reference implementation
2. Check \`sdk_next_action.next_action\` in session response for "${c.sdkNextAction || "post_session_tokens"}"
3. If present, call POST /payments/{id}/post_session_tokens to get order data
4. Extract the needed fields (e.g., order_id) from post_session_tokens response
5. Pass session_token (as clientId) + extracted data to native module
6. After SDK completes, call processRequest() to confirm`;

    case "confirm_next_action":
      return `### Flow: confirm → next_action handler (like Netcetera 3DS)
1. READ \`hyperswitch-client-core/src/hooks/NetceteraThreeDsHooks.res\` — this is your reference implementation
2. In AllPaymentHooks.res, add a case in handleApiRes for next_action.type = "${c.nextActionType || "unknown"}"
3. Extract SDK params from next_action.next_action_data
4. Invoke native module with extracted params
5. Handle SDK result (success/failure) and call retrievePayment() or appropriate handler`;

    case "no_api":
      return `### Flow: No API chain (like ScanCard)
1. READ \`hyperswitch-client-core/src/components/modules/ScanCardModule.res\` — this is your reference
2. This SDK has NO API involvement — do NOT wire into session_tokens, post_session_tokens, or confirm flows
3. Just implement the native module binding and expose it as a ReScript module
4. The module should be callable from wherever it's needed in the UI`;

    case "custom":
      return `### Flow: Custom API chain
The user described this flow as: ${c.apiChain.description || "see API chain steps above"}
1. Study AllPaymentHooks.res for how existing hooks are structured
2. Implement the custom chain as described
3. Create new hooks file if needed: ${sdkName}Hooks.res`;

    default:
      return "";
  }
}

// ─── Coder prompt builders ───────────────────────────────────────────────────

function buildCombinedMobilePrompt(spec: IntegrationSpec, includeClientCore: boolean, includeRnPackages: boolean): string {
  const c = spec.classification;
  const flowInstructions = getFlowInstructions(c, spec.sdkName);
  const pkgName = spec.packageNameOverride || `react-native-hyperswitch-${spec.sdkName.toLowerCase()}`;

  const repoList: string[] = [];
  if (includeClientCore) repoList.push("- `hyperswitch-client-core/` — ReScript consumer SDK (hooks, modules, types, native view bindings)");
  if (includeRnPackages) repoList.push("- `react-native-hyperswitch/` — NPM packages with native iOS/Android modules (Swift, Kotlin, TypeScript bridge)");

  const parts: string[] = [];
  parts.push(`You are implementing a native SDK integration for the **${spec.sdkName}** SDK.${includeClientCore && includeRnPackages ? " You are working across TWO repositories in a single session." : ""}

Your working directory contains:
${repoList.join("\n")}

${classificationBlock(c)}

## Target Platforms: ${spec.platforms.join(", ")}

## SDK Documentation

<sdk-doc>
${spec.sdkDoc}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## What you must do`);

  if (includeRnPackages) {
    parts.push(`
### ${includeClientCore ? "Part 1: " : ""}Native Module (react-native-hyperswitch)

1. Find or create the NPM package \`${pkgName}\` under \`react-native-hyperswitch/packages/@juspay-tech/\`. A builder-bob skeleton may already be scaffolded — if so, Edit on top of it. Otherwise use react-native-hyperswitch-paypal as reference.

2. Implement the native module following these critical rules:

#### iOS Rules
- Module name via \`@objc(...)\` MUST match Android \`NAME\` and TypeScript \`NativeModules.X\`
- Use \`import {PodName}\` (umbrella module), NOT subspec names
- View props: \`@objc dynamic var\` + \`didSet\` on UIView, NOT setter methods on manager
- Wrap SDK UI calls in \`DispatchQueue.main.async { }\`

#### Android Rules
${c.requiresUrlScheme ? `- URL scheme: \`\${applicationId}.${spec.sdkName.toLowerCase()}\`` : "- No URL scheme needed for this SDK"}
${c.requiresActivity ? "- Implement Activity-Host pattern (see PayPalRedirectActivity.kt)" : "- No dedicated Activity needed"}
- Wrap SDK UI calls in \`mainHandler.post { }\`

#### Cross-Platform Rules
- No debug logs in production code
- SDK-specific types stay in the SDK's module file
- Delete all boilerplate \`multiply\` methods

3. Update podspec/build.gradle with SDK dependencies.
4. Update TypeScript bridge in src/index.tsx.`);
  }

  if (includeClientCore) {
    parts.push(`
### ${includeRnPackages ? "Part 2: " : ""}ReScript Consumer Bindings (hyperswitch-client-core)

${includeRnPackages ? `0. **READ \`react-native-hyperswitch/packages/@juspay-tech/${pkgName}/src/index.tsx\`** — this is the TypeScript bridge you wrote (or updated) in Part 1. Before writing any ReScript, enumerate EVERY item from it:
   - exported event names (e.g. \`onInitialized\`, \`onLoaded\`, \`onAuthorized\`, \`onResize\`, \`onError\`, …)
   - exported native-view prop names (e.g. \`category\`, \`returnURL\`, …)
   - exported imperative method names + argument lists (e.g. \`initialize(clientToken, returnURL)\`, \`load()\`, \`authorize()\`)
   - every field on every callback-payload type (e.g. \`approved\`, \`authToken\`, \`finalizeRequired\`, \`errorMessage\`)

   The ReScript type definitions you write below MUST be a 1:1 mirror of this list. Missing any event, prop, method, or payload field is a review failure.

` : ""}1. READ the reference pattern file: **${c.referencePattern || "hyperswitch-client-core/src/components/modules/ScanCardModule.res"}**

${flowInstructions}

2. Create the ReScript module wrapper. It must expose the **complete** TS surface enumerated in step 0:
   - Every event → field on the module's \`event\` record type AND a prop on the \`@react.component\` that wraps it
   - Every callback-payload field → field on the event record with the correct option wrapping
   - Every native-view prop → prop on the ReScript component
   - Every imperative method → method on the \`element\` ref type with matching argument order and types

   Use the \`require\` + \`try/catch\` pattern (see ScanCardModule.res as shape reference — yours will be larger):

\`\`\`rescript
type module_ = { /* complete type signature covering all of step 0 */ }
@val external require: string => module_ = "require"
let mod = try { require("@juspay-tech/${pkgName}")->Some } catch { | _ => None }
\`\`\`

3. Wire the module into the appropriate files: ${c.targetFiles.join(", ")}
${c.hasNativeUI ? `4. Create native view bindings (.ios.res, .android.res with requireNativeComponent, .web.res stub)` : ""}`);
  }

  if (includeClientCore && includeRnPackages) {
    parts.push(`
### Critical: Interface Consistency

The native module methods you create in Part 1 MUST exactly match what the ReScript bindings call in Part 2. If your Swift method is \`startPayment(clientId:orderId:callback:)\`, the TypeScript bridge must expose the same signature, and the ReScript binding must call it with the same parameter names/types.

**Interface consistency is bidirectional.** The ReScript module type is not a subset of the TS bridge — it is a full mirror. If the TS bridge exports an event, prop, callback-payload field, or imperative method that ReScript does not expose, that's a completeness bug. Do NOT silently drop events, props, or payload fields to minimize the diff. If Part 1 added \`onResize\` / \`finalizeRequired\` / a \`category\` prop, Part 2's ReScript types must surface all of them.`);
  }

  parts.push(`
### Output

After implementing, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path from working dir>", "change": "<what changed>"}]}`);

  return parts.join("\n");
}

function buildWebPrompt(spec: IntegrationSpec): string {
  return `You are implementing the web-side integration for the **${spec.sdkName}** SDK in the hyperswitch-web (ReScript web SDK) repository.

Your current working directory contains:
- \`hyperswitch-web/\` — the web SDK repo

${classificationBlock(spec.classification)}

## SDK Documentation

<sdk-doc>
${spec.sdkDoc}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## What you must do

1. Study existing patterns in \`hyperswitch-web/\` by reading similar payment method components.
2. Implement the web integration following the repo's conventions.
3. This is a ReScript + React codebase. Follow existing patterns exactly.

After implementing, output a JSON summary:
{"what": "<one-line description>", "files": [{"path": "<relative path>", "change": "<what changed>"}]}`;
}

function buildIntegrationFixPrompt(
  spec: IntegrationSpec,
  issues: ReviewIssue[],
  diff: string,
): string {
  const blockersAndWarnings = issues.filter((i) => i.severity !== "nit");
  return `You previously implemented the **${spec.sdkName}** SDK integration. A reviewer has raised the issues below.

You have the full original spec (classification + SDK doc) and tool access (Read/Grep/Glob) to verify the reviewer's claims against the actual code and requirements.

${classificationBlock(spec.classification)}

## Target Platforms: ${spec.platforms.join(", ")}

## SDK Documentation (original requirements)

<sdk-doc>
${spec.sdkDoc.slice(0, 10000)}
</sdk-doc>

${spec.additionalContext ? `## Additional Context\n\n${spec.additionalContext}\n` : ""}

## Reviewer Issues

${blockersAndWarnings
  .map(
    (i, idx) =>
      `${idx + 1}. **[${i.severity}] ${i.check}** in \`${i.file}\`
   Problem: ${i.description}
   Reviewer's suggested fix: ${i.suggestedFix}`,
  )
  .join("\n\n")}

## Current diff (for reference)

\`\`\`diff
${diff.slice(0, 20000)}
\`\`\`

## What you must do

For each issue above, independently judge whether the reviewer is correct given the spec and the current code:

- **If the issue is valid** — fix it using Edit/Write/Read/Glob/Grep.
- **If the issue is invalid** (reviewer misread the code, the spec explicitly requires the current behavior, the "fix" would break another part of the integration) — do NOT change the code. Instead record a rebuttal.

Rebut sparingly — fixing is the default. Only reject when you can point to a concrete reason grounded in the spec or the code. A generic "this looks fine" is not a rebuttal.

## Output Format

After you finish, return ONLY valid JSON (no fences, no explanation around it):

{
  "fixed": [
    { "file": "<file from issue>", "check": "<check name from issue>" }
  ],
  "rebuttals": [
    { "file": "<file from issue>", "check": "<check name from issue>", "reason": "<why this issue is invalid — cite spec or code>" }
  ],
  "summary": "<one-line description of what you changed>"
}

Every issue above must appear in either \`fixed\` or \`rebuttals\` — use the exact \`file\` and \`check\` strings from the issue list.`;
}

// ─── Run mobile integration (single coder, two repos) ───────────────────────

async function runMobileIntegration(
  spec: IntegrationSpec,
  res: Response,
): Promise<Record<string, RepoResult>> {
  const slug = spec.sdkName
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/-$/, "");
  const branchName = `feat/integration-${slug}`;
  const cwd = INTEGRATION_TARGET_CWD.mobile;

  // Determine which sub-repos to include
  const subRepos = spec.mobileSubRepos ?? ["client_core", "rn_packages"];
  const includeClientCore = subRepos.includes("client_core");
  const includeRnPackages = subRepos.includes("rn_packages");

  if (!includeClientCore && !includeRnPackages) {
    throw new Error("At least one mobile sub-repo must be selected");
  }

  // Ensure repos are cloned before touching them
  if (includeClientCore) await ensureRepo("mobile");
  if (includeRnPackages) await ensureRepo("rn_packages");

  // Setup branches in selected repos
  const mobileSetup = includeClientCore ? await setupBranch("mobile", branchName, spec.baseBranch) : null;
  const rnSetup = includeRnPackages ? await setupBranch("rn_packages", branchName, spec.baseBranch) : null;

  const repoLabel = includeClientCore && includeRnPackages
    ? "client-core + rn-packages"
    : includeClientCore
      ? "client-core"
      : "rn-packages";

  sendSSE(res, {
    type: "progress",
    repo: "mobile",
    message: `Implementing ${spec.sdkName} across ${repoLabel}...`,
  });

  // Pre-scaffold the rn_packages package. The coder has no Bash tool, so it
  // can't run `create-react-native-library` itself — we do it here and let the
  // coder Edit on top of the generated skeleton. `scaffoldRnPackage` is
  // idempotent: it no-ops when the package directory already exists.
  if (includeRnPackages && rnSetup) {
    const pkgName =
      spec.packageNameOverride ||
      `react-native-hyperswitch-${spec.sdkName.toLowerCase()}`;
    await scaffoldRnPackage({
      rnPackagesDir: REPOS.rn_packages.dir,
      pkgName,
      sdkName: spec.sdkName,
      res,
    });
  }

  sendSSE(res, {
    type: "phase",
    repo: "mobile",
    message: `Coding ${repoLabel}`,
  });

  // Load codebase knowledge for system prompt injection
  const knowledge = await loadMobileIntegrationKnowledge();

  // Build the coder prompt once and emit it so the UI can surface what the
  // agent was actually asked to do.
  const mobilePrompt = buildCombinedMobilePrompt(spec, includeClientCore, includeRnPackages);
  sendSSE(res, {
    type: "coder_prompt",
    repo: "mobile",
    message: "Mobile coder prompt",
    data: { prompt: mobilePrompt },
  });

  // Single coder call (streamed so UI sees tool-level activity)
  let coderSummary = "";
  await askStream(
    mobilePrompt,
    {
      model: CODER_MODEL,
      timeoutMs: includeClientCore && includeRnPackages ? MOBILE_CODER_TIMEOUT_MS : CODER_TIMEOUT_MS,
      cwd,
      allowedTools: CODER_TOOLS,
      system: knowledge || undefined,
    },
    (chunk) => {
      forwardCoderChunk(res, "mobile", chunk);
      if (chunk.type === "text" && chunk.text) coderSummary += chunk.text;
    },
  );

  // Collect diffs from selected repos
  const mobileResult = mobileSetup ? await collectDiff(mobileSetup.git) : { diff: "", fileCount: 0 };
  const rnResult = rnSetup ? await collectDiff(rnSetup.git) : { diff: "", fileCount: 0 };

  const totalFiles = mobileResult.fileCount + rnResult.fileCount;
  if (totalFiles === 0) {
    // Cleanup branches
    if (mobileSetup) {
      await mobileSetup.git.checkout(mobileSetup.defaultBranch);
      try { await mobileSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    }
    if (rnSetup) {
      await rnSetup.git.checkout(rnSetup.defaultBranch);
      try { await rnSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    }
    throw new Error("Coder did not produce any file changes for mobile");
  }

  // Combined diff getter for review
  const combinedDiffGetter = async () => {
    const parts: string[] = [];
    if (mobileSetup) {
      const md = await collectDiff(mobileSetup.git);
      if (md.diff) parts.push(`# hyperswitch-client-core\n${md.diff}`);
    }
    if (rnSetup) {
      const rn = await collectDiff(rnSetup.git);
      if (rn.diff) parts.push(`# react-native-hyperswitch\n${rn.diff}`);
    }
    return parts.join("\n\n");
  };

  // Build review + fix prompts
  const reviewPromptBuilder = makeIntegrationReviewPrompt({
    sdkName: spec.sdkName,
    classification: spec.classification,
    platforms: spec.platforms,
    sdkDoc: spec.sdkDoc,
    additionalContext: spec.additionalContext,
  });

  const fixPromptBuilder = (issues: ReviewIssue[], diff: string) =>
    buildIntegrationFixPrompt(spec, issues, diff);

  // Review loop
  const { reviewLog } = await runReviewLoop({
    targetLabel: "mobile",
    cwd,
    getDiff: combinedDiffGetter,
    buildReviewPrompt: reviewPromptBuilder,
    buildFixPrompt: fixPromptBuilder,
    res,
    system: knowledge || undefined,
  });

  // Collect final diffs after review fixes
  const finalMobile = mobileSetup ? await collectDiff(mobileSetup.git) : { diff: "", fileCount: 0 };
  const finalRn = rnSetup ? await collectDiff(rnSetup.git) : { diff: "", fileCount: 0 };

  // Commit and save patches per-repo, then push + open PR for each
  let mobilePr: PrOutcome = { prUrl: null, prNumber: null, prWarning: null };
  if (mobileSetup) {
    if (finalMobile.diff) {
      await commitAndSave(mobileSetup.git, mobileSetup.defaultBranch, `integrate ${spec.sdkName} SDK`, "mobile", slug, finalMobile.diff, "integration");
      mobilePr = await pushAndOpenPr({
        repoKey: "mobile",
        repoDir: REPOS.mobile.dir,
        branch: branchName,
        sdkName: spec.sdkName,
        res,
      });
    } else {
      await mobileSetup.git.checkout(mobileSetup.defaultBranch);
      try { await mobileSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    }
  }

  let rnPr: PrOutcome = { prUrl: null, prNumber: null, prWarning: null };
  if (rnSetup) {
    if (finalRn.diff) {
      await commitAndSave(rnSetup.git, rnSetup.defaultBranch, `integrate ${spec.sdkName} SDK`, "rn_packages", slug, finalRn.diff, "integration");
      rnPr = await pushAndOpenPr({
        repoKey: "rn_packages",
        repoDir: REPOS.rn_packages.dir,
        branch: branchName,
        sdkName: spec.sdkName,
        res,
      });
    } else {
      await rnSetup.git.checkout(rnSetup.defaultBranch);
      try { await rnSetup.git.deleteLocalBranch(branchName, true); } catch { /* */ }
    }
  }

  sendSSE(res, {
    type: "repo_done",
    repo: "mobile",
    message: `Done — ${finalMobile.fileCount + finalRn.fileCount} files changed across ${repoLabel}`,
  });

  const results: Record<string, RepoResult> = {};

  if (includeClientCore) {
    results.mobile = {
      repo: "mobile",
      branch: finalMobile.diff ? branchName : "",
      summary: coderSummary.slice(0, 5000),
      diff: finalMobile.diff,
      filesTouched: finalMobile.fileCount,
      reviewLog,
      prUrl: mobilePr.prUrl,
      prNumber: mobilePr.prNumber,
      prWarning: mobilePr.prWarning,
    };
  }

  if (includeRnPackages) {
    results.rn_packages = {
      repo: "rn_packages",
      branch: finalRn.diff ? branchName : "",
      summary: coderSummary.slice(0, 5000),
      diff: finalRn.diff,
      filesTouched: finalRn.fileCount,
      reviewLog,
      prUrl: rnPr.prUrl,
      prNumber: rnPr.prNumber,
      prWarning: rnPr.prWarning,
    };
  }

  return results;
}

// ─── Run web integration (single coder, single repo) ────────────────────────

async function runWebIntegration(
  spec: IntegrationSpec,
  res: Response,
): Promise<RepoResult> {
  const slug = spec.sdkName
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .slice(0, 40)
    .replace(/-$/, "");
  const branchName = `feat/integration-${slug}`;
  const repoKey: ExtendedRepoKey = "web";
  const cwd = INTEGRATION_TARGET_CWD.web;

  await ensureRepo("web");
  const { git, defaultBranch } = await setupBranch(repoKey, branchName, spec.baseBranch);

  sendSSE(res, {
    type: "progress",
    repo: "web",
    message: `Implementing ${spec.sdkName} in Web SDK...`,
  });
  sendSSE(res, {
    type: "phase",
    repo: "web",
    message: "Coding hyperswitch-web",
  });

  const webPrompt = buildWebPrompt(spec);
  sendSSE(res, {
    type: "coder_prompt",
    repo: "web",
    message: "Web coder prompt",
    data: { prompt: webPrompt },
  });

  let coderSummary = "";
  await askStream(
    webPrompt,
    {
      model: CODER_MODEL,
      timeoutMs: CODER_TIMEOUT_MS,
      cwd,
      allowedTools: CODER_TOOLS,
    },
    (chunk) => {
      forwardCoderChunk(res, "web", chunk);
      if (chunk.type === "text" && chunk.text) coderSummary += chunk.text;
    },
  );

  const initial = await collectDiff(git);
  if (!initial.diff || initial.fileCount === 0) {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
    throw new Error("Coder did not produce any file changes for web");
  }

  // Build review + fix prompts
  const reviewPromptBuilder = makeIntegrationReviewPrompt({
    sdkName: spec.sdkName,
    classification: spec.classification,
    platforms: spec.platforms,
    sdkDoc: spec.sdkDoc,
    additionalContext: spec.additionalContext,
  });

  const fixPromptBuilder = (issues: ReviewIssue[], diff: string) =>
    buildIntegrationFixPrompt(spec, issues, diff);

  // Review loop
  const diffGetter = async () => {
    const r = await collectDiff(git);
    return r.diff;
  };

  const { reviewLog } = await runReviewLoop({
    targetLabel: "web",
    cwd,
    getDiff: diffGetter,
    buildReviewPrompt: reviewPromptBuilder,
    buildFixPrompt: fixPromptBuilder,
    res,
  });

  // Collect final diff and commit
  const final = await collectDiff(git);
  let webPr: PrOutcome = { prUrl: null, prNumber: null, prWarning: null };
  if (final.diff) {
    await commitAndSave(git, defaultBranch, `integrate ${spec.sdkName} SDK`, repoKey, slug, final.diff, "integration");
    webPr = await pushAndOpenPr({
      repoKey: "web",
      repoDir: REPOS.web.dir,
      branch: branchName,
      sdkName: spec.sdkName,
      res,
    });
  } else {
    await git.checkout(defaultBranch);
    try { await git.deleteLocalBranch(branchName, true); } catch { /* */ }
  }

  sendSSE(res, {
    type: "repo_done",
    repo: "web",
    message: `Done — ${final.fileCount} files changed`,
  });

  return {
    repo: repoKey,
    branch: final.diff ? branchName : "",
    summary: coderSummary.slice(0, 5000),
    diff: final.diff,
    filesTouched: final.fileCount,
    reviewLog,
    prUrl: webPr.prUrl,
    prNumber: webPr.prNumber,
    prWarning: webPr.prWarning,
  };
}

// ─── Classify endpoint (regular JSON) ────────────────────────────────────────

export async function handleClassifySkill(
  req: Request,
  res: Response,
): Promise<void> {
  const { sdkDoc, sdkTypeHint } = req.body as ClassifyRequest;

  if (!sdkDoc) {
    res.status(400).json({ error: "sdkDoc is required" });
    return;
  }

  try {
    const classification = await classifySdkFromDoc(sdkDoc, sdkTypeHint);
    res.json(classification);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ─── Generate endpoint (SSE) ─────────────────────────────────────────────────

export async function handleSdkIntegratorSkill(
  req: Request,
  res: Response,
): Promise<void> {
  const spec = req.body as IntegrationSpec;

  // Support both "targets" (new) and "repos" (legacy) field names
  const targets: IntegrationTarget[] =
    spec.targets ??
    (req.body as Record<string, unknown>).repos as IntegrationTarget[] ??
    [];

  if (!spec.sdkName || !spec.sdkDoc || !targets.length || !spec.platforms?.length || !spec.classification) {
    res.status(400).json({
      error: "sdkName, sdkDoc, targets, platforms, and classification are required",
    });
    return;
  }

  initSSE(res);

  const results: Record<string, RepoResult> = {};

  try {
    for (const target of targets) {
      try {
        if (target === "mobile") {
          const mobileResults = await runMobileIntegration(spec, res);
          Object.assign(results, mobileResults);
        } else if (target === "web") {
          results.web = await runWebIntegration(spec, res);
        } else {
          sendSSE(res, { type: "error", repo: target, message: `Unknown target: ${target}` });
        }
      } catch (err) {
        const errorMsg = (err as Error).message;
        sendSSE(res, { type: "error", repo: target, message: errorMsg });

        if (target === "mobile") {
          const subRepos = spec.mobileSubRepos ?? ["client_core", "rn_packages"];
          const emptyResult: RepoResult = {
            repo: "",
            branch: "",
            summary: "",
            diff: "",
            filesTouched: 0,
            error: errorMsg,
            reviewLog: [],
          };
          if (subRepos.includes("client_core")) {
            results.mobile = { ...emptyResult, repo: "mobile" };
          }
          if (subRepos.includes("rn_packages")) {
            results.rn_packages = { ...emptyResult, repo: "rn_packages" };
          }
        } else {
          results[target] = {
            repo: target,
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

    const allResults = Object.values(results);
    const hasError = allResults.some((r) => r.error);
    const allError = allResults.length > 0 && allResults.every((r) => r.error);

    sendSSE(res, {
      type: "done",
      message: allError ? "All targets failed" : hasError ? "Completed with some errors" : "All targets completed successfully",
      data: {
        skillId: "sdk-integrator",
        status: allError ? "error" : hasError ? "partial" : "ok",
        results,
        meta: { sdkName: spec.sdkName, classification: spec.classification },
      },
    });
  } catch (err) {
    sendSSE(res, { type: "error", message: (err as Error).message });
  } finally {
    res.end();
  }
}
