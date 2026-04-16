/**
 * Builds the Sonnet prompt that generates GitBook-ready copy matching the
 * voice and structure of https://docs.hyperswitch.io/integration-guide/
 * payment-experience/sdk-reference/react.
 *
 * The prompt is anchored by three things in order of importance:
 *   1. A hard do/don't style list derived from the live docs.
 *   2. A markdown skeleton the model fills in.
 *   3. A single concrete before/after few-shot — the thing that actually
 *      pulls the output into the right register.
 */

export interface BuildOfficialPromptArgs {
  featureName: string;
  repoKey: "web" | "mobile";
  skillId?: string;
  summary: string;
  filesChanged: string[];
  diff: string;
}

export function buildOfficialPrompt(args: BuildOfficialPromptArgs): string {
  const filesSection = args.filesChanged.length > 0
    ? `\nFiles changed:\n${args.filesChanged.map((f) => `- ${f}`).join("\n")}`
    : "";

  const skillHint = skillHintFor(args.skillId);

  return `You are writing reference documentation for the public Hyperswitch React SDK, published at https://docs.hyperswitch.io/integration-guide/payment-experience/sdk-reference/react.

Your output will be pasted directly into GitBook and must read like it was written by the same person who wrote the rest of that reference.

# Style rules (follow exactly)

- Second-person, imperative, terse. Prefer "Use \`X\` to …" or "The \`X\` <component|hook|method> <does Y>."
- No marketing language. Banned words: "easy", "simply", "powerful", "seamless", "robust".
- No filler preamble ("In this section we will …"). Start with the heading.
- Every code block includes its imports. Language tags: \`\`\`tsx, \`\`\`jsx, \`\`\`js, \`\`\`bash.
- Do **not** annotate code blocks with filenames above them.
- Tables use GitHub-flavoured markdown. Two-column \`| Parameter | Description |\` is the default. Use five columns \`| Name | Type | Required | Default | Description |\` only when you have real type info in the diff.
- Callouts are plain **bold** prose, never GitBook \`{% hint %}\` syntax:
    - \`**Info:** …\` — dependency or side-effect notes.
    - \`**Important:** …\` — a blocking constraint or behavior a caller must know.
    - \`**(Deprecated)**\` as an inline label next to a method name.
- Drop sections that don't apply. A pure option/config change skips Usage. A new hook without options skips the table. Never write "N/A" or "None."
- Output **only** the markdown. No preamble, no trailing notes, no explanation of what you wrote.

# Skeleton (fill what applies, drop what doesn't)

\`\`\`
## <FeatureName>

<1–2 sentence overview — "Use \`X\` to …" or "The \`X\` <thing> <does Y>.">

### Usage

\`\`\`tsx
import { ... } from "@juspay-tech/react-hyper-js";

// complete working snippet using the feature in the context it ships in
\`\`\`

### Options  (or: ### Parameters, ### API)

| Parameter | Description |
|-----------|-------------|
| optionName | Plain-English explanation, 1 sentence. |

### Notes

**Info:** <any dependency>
**Important:** <any blocking constraint>
\`\`\`

${skillHint}

# Example (this is exactly the register to match)

## Internal-style input the model was given
> Added \`showCardBrand\` boolean prop to the UnifiedCheckout card widget.
> When true, the card brand logo appears next to the card number input.
> Default is true. Parses from merchant init config alongside other
> appearance options in \`PaymentType.res\`.

## Official output (what you should produce)

## showCardBrand

Use \`showCardBrand\` to control whether the detected card-brand logo
appears inside the card number field of the \`<UnifiedCheckout />\` widget.

### Usage

\`\`\`tsx
import { HyperElements, UnifiedCheckout } from "@juspay-tech/react-hyper-js";

export default function Checkout() {
  const options = {
    showCardBrand: false,
  };

  return (
    <HyperElements options={{ clientSecret }}>
      <UnifiedCheckout options={options} />
    </HyperElements>
  );
}
\`\`\`

### Options

| Parameter | Description |
|-----------|-------------|
| showCardBrand | Boolean. When \`true\` (default), the brand logo is rendered inside the card number input as the user types. Set to \`false\` to hide it. |

### Notes

**Info:** The brand is detected from the first digits of the card number; changing this prop at runtime takes effect on the next keystroke.

# End of example.

# Now generate documentation for:

Feature: ${args.featureName}
Repository: ${repoLabel(args.repoKey)}
Summary from the implementing agent: ${args.summary}
${filesSection}

Diff (first 3000 chars):
\`\`\`
${args.diff.slice(0, 3000)}
\`\`\`

Output ONLY the official-style markdown. No preamble.`;
}

function repoLabel(repoKey: "web" | "mobile"): string {
  return repoKey === "web"
    ? "hyperswitch-web (React / ReScript web SDK)"
    : "hyperswitch-client-core (React Native / ReScript mobile SDK)";
}

function skillHintFor(skillId: string | undefined): string {
  switch (skillId) {
    case "props":
      return "# Skill hint\n\nThis feature adds or modifies a configuration option. Favor an **Options** table with the prop name + a behavioral description. Show Usage only if the prop needs a non-trivial container component to demonstrate.";
    case "translations":
      return "# Skill hint\n\nThis feature adds or edits localization strings. The Usage block typically shows how to pass \`locale\` into the SDK options. The table lists the new/changed keys with their English source and target locale(s).";
    case "integration":
      return "# Skill hint\n\nThis feature adds an end-to-end integration (new component, new hook, new payment method wiring). The Usage block should show a complete working snippet that a merchant could paste. Include an API or Parameters table for any public-facing methods.";
    default:
      return "# Skill hint\n\nChoose the section mix that best fits the feature: at minimum the heading + overview, then whichever of Usage / Options / Notes actually carry information.";
  }
}
