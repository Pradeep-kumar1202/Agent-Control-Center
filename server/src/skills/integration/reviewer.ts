/**
 * Integration skill — Reviewer agent.
 *
 * After the coder agent implements an SDK integration, this module builds a
 * review prompt and parses the structured review result. The reviewer checks
 * the diff against the WORKFLOW_NATIVE_SDK_INTEGRATION.md and LEARNINGS.md
 * documents, flagging issues with severity and actionable fix descriptions.
 */

import type { Model } from "../../llm.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewIssue {
  /** File path relative to the repo root. */
  file: string;
  /** One of the 12 review checks that failed. */
  check: string;
  /** How serious is this? */
  severity: "blocker" | "warning" | "nit";
  /** Human-readable description of what's wrong. */
  description: string;
  /** Concrete suggested fix. */
  suggestedFix: string;
}

export interface ReviewResult {
  /** Did the implementation pass? True = no blockers or warnings. */
  approved: boolean;
  /** All issues found (may include nits even if approved). */
  issues: ReviewIssue[];
  /** Free-form summary of the review. */
  summary: string;
}

/** Auto-detected SDK classification from reading the vendor's documentation. */
export interface SdkClassification {
  /** High-level integration pattern (e.g. "browser-switch via ASWebAuthenticationSession + Chrome Custom Tabs"). */
  pattern: string;
  /** How the SDK returns results (e.g. "completion handler on iOS, deep link onNewIntent on Android"). */
  callbackMechanism: string;
  /** Whether Android needs a dedicated Activity for deep link handling. */
  requiresActivity: boolean;
  /** Whether a custom URL scheme must be registered. */
  requiresUrlScheme: boolean;
  /** Whether the SDK provides native UI components (buttons, views). */
  hasNativeUI: boolean;
  /** Any other observations relevant to the integration. */
  notes: string;
}

export interface ReviewContext {
  sdkName: string;
  /** Auto-detected classification of the SDK's integration pattern. */
  classification: SdkClassification;
  /** Which platforms were targeted (e.g. ["ios", "android", "rescript_mobile"]). */
  platforms: string[];
  /** The diff being reviewed. */
  diff: string;
  /** The repo being reviewed (mobile, rn_packages, web). */
  repoKey: string;
  /** The original SDK doc that was provided by the user. */
  sdkDoc: string;
  /** Additional user context. */
  additionalContext?: string;
  /** Previous review issues that were supposedly fixed (for re-review). */
  previousIssues?: ReviewIssue[];
}

// ─── Review checks ───────────────────────────────────────────────────────────

const REVIEW_CHECKS = `
## Review Checklist (check ALL that apply to the platforms targeted)

### Cross-platform checks
1. **Module name consistency** — The module name must match across iOS \`@objc(...)\`, iOS \`.mm\` \`RCT_EXTERN_MODULE(...)\`, Android \`NAME\` constant, and TypeScript \`NativeModules.X\`. The boilerplate name is always wrong.
2. **No debug logs** — No \`console.log\`, \`Console.log\`, \`consoleLog\`, or \`PAYPAL_DEBUG\` in production code.
3. **SDK types stay local** — SDK-specific callback types must live in the SDK's module file, NOT in shared types like \`PaymentConfirmTypes.res\`.
4. **\`require\` + \`try/catch\` for native modules** — ReScript bindings must use \`require\` + \`try/catch\` pattern (like ScanCardModule.res), NOT \`@module\` external.

### Android checks
5. **Unique URL scheme** — Every deep-link SDK must use \`\${applicationId}.{sdk_name}\`. NEVER reuse \`\${applicationId}.hyperswitch\`.
6. **Single AndroidManifest.xml** — No dual-manifest pattern (\`supportsNamespace()\` function in build.gradle).
7. **Activity-host owns SDK client** — The activity creating the SDK client must be the one receiving the deep link (for browser-switch SDKs).
8. **Main thread for UI** — SDK UI calls wrapped in \`mainHandler.post { }\`.

### iOS checks
9. **\`import {PodName}\` umbrella module** — Use the umbrella module name (e.g., \`import PayPal\`), NOT subspec names (e.g., \`import CorePayments\`). Check the modulemap.
10. **View props on UIView, not manager** — \`@objc dynamic var\` with \`didSet\` on the UIView. \`RCTViewManager\` only returns the view. \`RCT_EXPORT_VIEW_PROPERTY\` in \`.mm\`.
11. **\`DispatchQueue.main.async\`** — Any iOS SDK presenting UI must be wrapped in \`DispatchQueue.main.async { }\`.
12. **Callback type matches TS bridge** — \`RCTResponseSenderBlock\` for callbacks, \`RCTPromiseResolveBlock\` for promises. Must match what TypeScript sends.
`;

// ─── Prompt builder ──────────────────────────────────────────────────────────

function classificationSection(c: SdkClassification): string {
  return `## Auto-Detected SDK Classification

- **Pattern:** ${c.pattern}
- **Callback mechanism:** ${c.callbackMechanism}
- **Requires dedicated Activity (Android):** ${c.requiresActivity ? "yes" : "no"}
- **Requires URL scheme registration:** ${c.requiresUrlScheme ? "yes" : "no"}
- **Has native UI components:** ${c.hasNativeUI ? "yes" : "no"}
- **Notes:** ${c.notes}

Use this classification to determine which review checks are relevant. For example, URL scheme and Activity-host checks only apply if requiresUrlScheme / requiresActivity are true.`;
}

export function buildReviewPrompt(ctx: ReviewContext): string {
  const previousSection = ctx.previousIssues?.length
    ? `
## Previous Issues (supposedly fixed — verify they are actually resolved)

${ctx.previousIssues
  .map(
    (i, idx) =>
      `${idx + 1}. **[${i.severity}] ${i.check}** in \`${i.file}\`: ${i.description}
   Suggested fix: ${i.suggestedFix}`,
  )
  .join("\n")}
`
    : "";

  return `You are a senior reviewer for native SDK integrations in a React Native payment orchestrator.

You are reviewing a diff that implements the **${ctx.sdkName}** SDK integration targeting platforms: ${ctx.platforms.join(", ")}.

${classificationSection(ctx.classification)}

## Your task

Review the diff below against the integration workflow rules and known pitfalls. Output a structured JSON review.

${REVIEW_CHECKS}

${previousSection}

## SDK Documentation (for reference)

<sdk-doc>
${ctx.sdkDoc.slice(0, 8000)}
</sdk-doc>

${ctx.additionalContext ? `## Additional Context\n\n${ctx.additionalContext}\n` : ""}

## Diff to Review

\`\`\`diff
${ctx.diff.slice(0, 30000)}
\`\`\`

## Output Format

Return ONLY valid JSON (no fences, no explanation):

{
  "approved": true/false,
  "issues": [
    {
      "file": "relative/path/to/file",
      "check": "name of the check that failed (e.g. 'Module name consistency')",
      "severity": "blocker" | "warning" | "nit",
      "description": "what's wrong",
      "suggestedFix": "concrete fix"
    }
  ],
  "summary": "one paragraph summary"
}

Set "approved" to true ONLY if there are ZERO blockers and ZERO warnings. Nits are acceptable.
If the diff is empty or there's nothing to review, set approved to true with an empty issues array.`;
}

export const REVIEWER_MODEL: Model = "opus";
export const REVIEWER_TIMEOUT_MS = 300_000;
