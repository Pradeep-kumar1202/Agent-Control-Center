/**
 * Integration skill — Reviewer agent + SDK classification types.
 *
 * Generic reviewer infrastructure (types, JSON extraction, config) lives in
 * ../shared/reviewer.ts. This file contains integration-specific:
 *   - SdkClassification type and derivation helpers
 *   - Integration-specific review prompt builder
 *   - Review checks specific to native SDK integrations
 */

// Re-export shared types so integration/index.ts can import everything from here
export {
  type ReviewIssue,
  type ReviewResult,
  type RepoReviewLog,
  extractJsonFromText,
  REVIEWER_MODEL,
  REVIEWER_TIMEOUT_MS,
  REVIEWER_TOOLS,
} from "../shared/reviewer.js";

// ─── SDK Classification (the core data model) ───────────────────────────────

/** A single step in the API call chain that bootstraps the SDK. */
export interface ApiChainStep {
  /** API endpoint or action (e.g. "session_tokens", "post_session_tokens", "confirm", "SDK invocation"). */
  endpoint: string;
  /** What field in the response triggers the next step. */
  triggerField?: string;
  /** What trigger value means "proceed to next step". */
  triggerValue?: string;
  /** What data is extracted from this step's response for the SDK. */
  extractedData?: string[];
}

export type UiEntryPoint =
  | "branded_button"    // 1-click wallet button (PayPal, GPay, ApplePay)
  | "inline_widget"     // Renders inside payment sheet (Klarna)
  | "invisible"         // No UI, triggered programmatically (Netcetera, Kount)
  | "utility_ui"        // Utility with its own UI trigger (ScanCard camera)
  | "other";

export type ApiChainKnownPattern =
  | "session_direct"          // session_tokens → SDK (Google Pay, Apple Pay)
  | "session_post_session"    // session_tokens → post_session_tokens → SDK (PayPal)
  | "confirm_next_action"     // confirm → next_action handler (Netcetera, Plaid)
  | "no_api"                  // No API involvement (ScanCard, Kount)
  | "custom";                 // New pattern not in codebase

export type ConfirmTiming =
  | "post_sdk_with_data"      // SDK returns token → used in confirm body (GPay, ApplePay)
  | "post_sdk_status_only"    // SDK returns success → confirm called after (PayPal)
  | "pre_sdk"                 // Confirm first, SDK triggered by response (Netcetera)
  | "not_applicable"          // No confirm tied to SDK (ScanCard, Kount)
  | "custom";

export interface SdkClassification {
  // ── Technical detection (auto-detected from SDK doc) ──
  /** High-level integration pattern description. */
  pattern: string;
  /** How the SDK returns results. */
  callbackMechanism: string;
  /** Whether Android needs a dedicated Activity for deep link handling. */
  requiresActivity: boolean;
  /** Whether a custom URL scheme must be registered. */
  requiresUrlScheme: boolean;
  /** Whether the SDK provides native UI components (buttons, views). */
  hasNativeUI: boolean;
  /** Any other observations. */
  notes: string;

  // ── UI entry point ──
  uiEntryPoint: UiEntryPoint;
  /** Does the vendor SDK provide a native button component? */
  sdkProvidesButton?: boolean;

  // ── API chain ──
  apiChain: {
    /** Known pattern name if it matches one, or "custom" / "no_api". */
    knownPattern?: ApiChainKnownPattern;
    /** Ordered list of API steps. Empty for "no_api". */
    steps: ApiChainStep[];
    /** Free-form description for custom or complex chains. */
    description?: string;
  };

  // ── Confirm timing ──
  confirmTiming: ConfirmTiming;

  // ── Hyperswitch-specific (user fills in, agent can't detect from vendor doc) ──
  /** payment_method_type_wallet variant (e.g. "PAYPAL", "GOOGLE_PAY"). */
  walletVariant?: string;
  /** sdk_next_action.next_action value (e.g. "post_session_tokens"). */
  sdkNextAction?: string;
  /** next_action.type for post-confirm (e.g. "three_ds_invoke"). */
  nextActionType?: string;
  /** "invoke_sdk_client" or "redirect_to_url". */
  paymentExperience?: string;

  // ── Reference pattern (auto-derived from known pattern) ──
  /** Existing codebase file to use as a reference. */
  referencePattern?: string;
  /** Files the coder should wire into. */
  targetFiles: string[];
}

// ─── Target files derivation ─────────────────────────────────────────────────

export function deriveTargetFiles(c: SdkClassification): string[] {
  const files: string[] = [];
  const name = c.walletVariant || "Sdk";

  switch (c.apiChain.knownPattern) {
    case "session_direct":
      files.push(
        "ButtonElement.res (add wallet variant case)",
        "ButtonHook.res (handle SDK response)",
        `${name}Module.res (native module binding)`,
      );
      if (c.hasNativeUI) files.push(`${name}ButtonView*.res (native button view)`);
      break;

    case "session_post_session":
      files.push(
        "ButtonElement.res (add wallet variant case)",
        `${name}Hooks.res (post_session_tokens flow — follow PaypalHooks.res)`,
        `${name}Module.res (native module binding)`,
        `${name}Types.res (request/response types)`,
      );
      if (c.hasNativeUI) files.push(`${name}ButtonView*.res (native button view)`);
      break;

    case "confirm_next_action":
      files.push(
        "AllPaymentHooks.res (add next_action handler in handleApiRes)",
        `${name}Hooks.res (SDK invocation + polling — follow NetceteraThreeDsHooks.res)`,
        `${name}Module.res (native module binding)`,
      );
      break;

    case "no_api":
      files.push(`${name}Module.res (native module binding)`);
      break;

    case "custom":
      files.push(
        `${name}Module.res (native module binding)`,
        "AllPaymentHooks.res (if new hooks needed)",
        `${name}Hooks.res (custom flow)`,
      );
      break;

    default:
      files.push(`${name}Module.res (native module binding)`);
      break;
  }

  return files;
}

export function deriveReferencePattern(c: SdkClassification): string {
  switch (c.apiChain.knownPattern) {
    case "session_direct":
      return "ButtonElement.res GOOGLE_PAY/APPLE_PAY case";
    case "session_post_session":
      return "PaypalHooks.res (session → post_session_tokens → SDK)";
    case "confirm_next_action":
      return "NetceteraThreeDsHooks.res (confirm → next_action → SDK)";
    case "no_api":
      return "ScanCardModule.res (standalone utility, no API chain)";
    case "custom":
      return "AllPaymentHooks.res (study existing hooks, implement new pattern)";
    default:
      return "ScanCardModule.res";
  }
}

// ─── Integration-specific review checks ──────────────────────────────────────

export const INTEGRATION_REVIEW_CHECKS = `
## Review Checklist (check ALL that apply)

### Cross-platform checks
1. **Module name consistency** — The module name must match across iOS \`@objc(...)\`, iOS \`.mm\` \`RCT_EXTERN_MODULE(...)\`, Android \`NAME\` constant, and TypeScript \`NativeModules.X\`.
2. **No debug logs** — No \`console.log\`, \`Console.log\`, \`consoleLog\` in production code.
3. **SDK types stay local** — SDK-specific callback types must live in the SDK's module file, NOT in shared types like \`PaymentConfirmTypes.res\`.
4. **\`require\` + \`try/catch\` for native modules** — ReScript bindings must use \`require\` + \`try/catch\` pattern (like ScanCardModule.res), NOT \`@module\` external.

### Android checks
5. **Unique URL scheme** — Every deep-link SDK must use \`\${applicationId}.{sdk_name}\`. NEVER reuse \`\${applicationId}.hyperswitch\`.
6. **Single AndroidManifest.xml** — No dual-manifest pattern.
7. **Activity-host owns SDK client** — The activity creating the SDK client must be the one receiving the deep link.
8. **Main thread for UI** — SDK UI calls wrapped in \`mainHandler.post { }\`.

### iOS checks
9. **\`import {PodName}\` umbrella module** — Use the umbrella module name, NOT subspec names.
10. **View props on UIView, not manager** — \`@objc dynamic var\` with \`didSet\` on the UIView. \`RCTViewManager\` only returns the view.
11. **\`DispatchQueue.main.async\`** — Any iOS SDK presenting UI must be wrapped in \`DispatchQueue.main.async { }\`.
12. **Callback type matches TS bridge** — \`RCTResponseSenderBlock\` for callbacks, \`RCTPromiseResolveBlock\` for promises.

### API chain checks
13. **API chain completeness** — Every step in the classified API chain must be implemented (session_tokens extraction, post_session_tokens call if needed, next_action handler, etc.).
14. **Data flow between steps** — Data extracted from one API step must be correctly passed to the next (e.g., session_token → clientId, post_session_tokens response → orderId).
15. **Error handling per step** — Each API call in the chain must have error handling. What happens if post_session_tokens fails? What if next_action is missing?
16. **No-API SDKs stay simple** — If apiChain is "no_api", there should be NO unnecessary API wiring, hooks, or session token handling.
`;

// ─── Integration review prompt builder ───────────────────────────────────────

export interface IntegrationReviewContext {
  sdkName: string;
  classification: SdkClassification;
  platforms: string[];
  sdkDoc: string;
  additionalContext?: string;
}

function classificationSection(c: SdkClassification): string {
  const chainDesc = c.apiChain.description
    || (c.apiChain.knownPattern === "no_api" ? "No API calls — standalone SDK"
      : c.apiChain.steps.map((s, i) => `  ${i + 1}. ${s.endpoint}${s.triggerField ? ` → extract ${s.extractedData?.join(", ") || "data"}` : ""}`).join("\n"));

  return `## SDK Classification (user-confirmed)

- **Pattern:** ${c.pattern}
- **UI Entry Point:** ${c.uiEntryPoint}${c.sdkProvidesButton ? " (SDK provides native button)" : ""}
- **API Chain:** ${c.apiChain.knownPattern || "custom"}
${chainDesc}
- **Confirm Timing:** ${c.confirmTiming}
- **Callback mechanism:** ${c.callbackMechanism}
- **Requires Activity (Android):** ${c.requiresActivity ? "yes" : "no"}
- **Requires URL scheme:** ${c.requiresUrlScheme ? "yes" : "no"}
- **Has native UI:** ${c.hasNativeUI ? "yes" : "no"}
${c.walletVariant ? `- **Wallet variant:** ${c.walletVariant}` : ""}
${c.sdkNextAction ? `- **sdk_next_action:** ${c.sdkNextAction}` : ""}
${c.nextActionType ? `- **next_action.type:** ${c.nextActionType}` : ""}
${c.paymentExperience ? `- **Payment experience:** ${c.paymentExperience}` : ""}
- **Reference pattern:** ${c.referencePattern || "none"}
- **Target files:** ${c.targetFiles.join(", ")}
- **Notes:** ${c.notes}`;
}

/**
 * Build the integration-specific review prompt. Returns a function that
 * takes (diff, previousIssues) — matching the RunReviewLoop interface.
 */
export function makeIntegrationReviewPrompt(
  ctx: IntegrationReviewContext,
): (diff: string, previousIssues?: import("../shared/reviewer.js").ReviewIssue[]) => string {
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

    return `You are a senior reviewer for native SDK integrations in a React Native payment orchestrator.

You are reviewing an implementation of the **${ctx.sdkName}** SDK integration targeting platforms: ${ctx.platforms.join(", ")}.

${classificationSection(ctx.classification)}

## Your task

You have full access to the codebase via Read, Grep, and Glob tools. Do NOT just review the diff in isolation.

### Step 1: Read the diff below to understand what was implemented.

### Step 2: Explore the codebase to verify quality.

Use your tools to:
- **Read similar existing files** (e.g. if implementing PayPal hooks, read GooglePayHooks.res or existing wallet hooks). Check that the new code follows the same patterns, naming conventions, and structure.
- **Search for reusable functions** that already exist. Grep for common helpers in Utils.res, AllPaymentHooks.res, ButtonElement.res, etc. Flag any case where existing code was duplicated instead of reused.
- **Check if an existing function could be extended** with a minimal change to support the new SDK, instead of writing entirely new code. A one-line addition to an existing switch statement is better than a new function.
- **Verify module wiring** — check that switch cases in ButtonElement.res, AllPaymentHooks.res, or relevant routing files actually reference the new module correctly.
- **Check naming conventions** — are new file names, function names, type names consistent with existing patterns in the codebase?
- **Verify the native module interface** — if both hyperswitch-client-core and react-native-hyperswitch were modified, check that the ReScript bindings in client-core match the actual native module methods in react-native-hyperswitch.

### Step 3: Run the review checklist.

${INTEGRATION_REVIEW_CHECKS}

${previousSection}

## SDK Documentation (for reference)

<sdk-doc>
${ctx.sdkDoc.slice(0, 8000)}
</sdk-doc>

${ctx.additionalContext ? `## Additional Context\n\n${ctx.additionalContext}\n` : ""}

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
If the diff is empty or there's nothing to review, set approved to true with an empty issues array.`;
  };
}
