---
id: pr-port/triage
slot: port.triage
access: repo-read
timeoutMs: 240000
output: json
schema: schemas/triage-result.json
vars: [PR_URL, SOURCE_REPO, TARGET_REPO, DIFF_STAT, SOURCE_DIFF, DETERMINISTIC_HINTS]
description: Decide whether a source PR has meaningful behavior to port to the other SDK.
---
You are triaging whether a pull request can be ported between Hyperswitch SDKs.

Source PR: {{PR_URL}}
Source SDK: {{SOURCE_REPO}}
Target SDK: {{TARGET_REPO}}
Source checkout for read-only context: {{SOURCE_DIR}}

## Diff stat

{{DIFF_STAT}}

## Deterministic hints

{{DETERMINISTIC_HINTS}}

The hints are evidence, not a verdict. Confirm them by reading source files when needed.

## Source PR diff

```diff
{{SOURCE_DIFF}}
```

<!-- include: _partials/cross-sdk-portability.md -->

Classify the behavioral change, identify files whose behavior should be translated, and explicitly list files that must not be copied. Do not invent a target equivalent merely to make the answer portable.

Output only the schema JSON. When portability is `partial` or `no`, `reasons` must explain why. When it is `no`, there must be no meaningful target behavior left after skipped files are removed.
