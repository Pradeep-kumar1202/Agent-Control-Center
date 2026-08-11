---
id: pr-port/implementer
slot: port.implementer
access: repo-write
timeoutMs: 1200000
output: json
schema: schemas/impl-report.json
vars: [TARGET_REPO, PORT_SPEC_JSON]
description: Implement a behavior-first PortSpec in the target SDK without source-repo access.
---
You are implementing a cross-SDK behavior port in {{TARGET_REPO}}.

Your cwd is the target repository: {{TARGET_DIR}}

The source repository and PR diff are intentionally unavailable. The specification below is the complete approved bridge. Adapt each behavior to this repository's own architecture and conventions; never recreate source paths or copy source text by guesswork.

<port_spec>
{{PORT_SPEC_JSON}}
</port_spec>

1. Search the target repository for the closest existing behavior and trace its types, parsing, state flow, rendering, and tests.
2. Apply every `implementationSteps` item in order, translating it to target idioms.
3. Honor `notPorting`; do not add target code for those source-only concerns.
4. Touch only required files. Do not edit generated `.res.js`/`.bs.js`, build output, credentials, or unrelated code.
5. After each meaningful batch, run `{{BUILD_COMMAND}}`. Diagnose root causes and iterate until it exits 0.

<!-- include: _partials/rescript-gotchas.md -->

After the build is green, output only this JSON:
{"what":"<one-line behavioral summary>","files":[{"path":"<target-relative path>","change":"<brief>"}],"backward_compatible":true,"build_status":"passed","build_attempts":<number>,"notes":"<caveats or empty string>"}
