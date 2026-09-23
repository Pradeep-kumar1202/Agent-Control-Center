---
id: pr-port/triage
slot: port.triage
access: repo-read
timeoutMs: 240000
output: json
schema: schemas/triage-result.json
vars: [PR_URL, SOURCE_REPO, TARGET_REPO, DIFF_STAT, SOURCE_DIFF, DETERMINISTIC_HINTS]
description: Scope which behaviors in a source PR need an equivalent in the other SDK.
---
You are scoping a feature so another SDK can gain the same capability.

Source PR: {{PR_URL}}
Source SDK: {{SOURCE_REPO}}
Target SDK: {{TARGET_REPO}}
Source checkout for read-only context: {{SOURCE_DIR}}

## Your job

Answer one question: **what capability did this PR add, and which parts of it
should {{TARGET_REPO}} also have?**

You are scoping, not deciding the outcome. A later stage reads both
repositories and does the real work; your output tells it where to look and
what to leave alone. Getting the scope roughly right is far more useful than
being conservative.

Think in terms of behavior and backend contracts, never file layout. The two
SDKs are architecturally different, so "there is no file like this in the other
repo" says nothing about whether the behavior belongs there.

## Diff stat

{{DIFF_STAT}}

## Deterministic hints

{{DETERMINISTIC_HINTS}}

These are zero-cost structural observations, not a verdict. Confirm or
contradict them by reading source files.

## Source PR diff

```diff
{{SOURCE_DIFF}}
```

<!-- include: _partials/cross-sdk-portability.md -->

## Choosing `portability`

- `yes` — the capability belongs in the target SDK. Most feature PRs are this.
- `partial` — some belongs, some is source-only presentation or platform glue.
  This is the normal answer when a PR mixes logic with UI.
- `no` — reserved for the rare case where **nothing** observable is left after
  removing source-only concerns. Choosing this ends the run, so it needs
  file-level evidence: list every source file in `skippedFiles` with the reason
  it has no target counterpart. A `no` with an empty `skippedFiles` is rejected.

Do not invent a target equivalent just to make something look portable, and do
not decline something merely because it will take work.

## Output

Output only the schema JSON, and only once you have reached your conclusion.

`featureName` must name the capability (e.g. "Installment plan selection"), not
describe your activity. Every entry in `reasons` must state a finding about the
code — cite the behavior or file it concerns. Text such as "analyzing…", "in
progress", "I'm checking…", or a description of which tools or skills you are
consulting is rejected by the parser and wastes the whole run. If you are not
finished, keep working; do not emit a placeholder.
