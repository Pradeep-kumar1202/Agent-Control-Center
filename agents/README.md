# `agents/` — versioned prompt definitions

One Markdown file per pipeline stage. The workflow (a TypeScript state machine
in `server/src/routes/patches.ts`) decides *when* each stage runs; these files
define *what* each stage is told.

## Why these are files and not template literals

They used to be ~200 lines of template literal inside a 939-line route file.
Moving them here buys three things:

1. **Bisectable prompt history.** "Which prompt edit made patch quality worse"
   becomes a `git log -p agents/patch/implementer.md`, not an archaeology dig
   through a route file that also changed for unrelated reasons.
2. **Editable without a rebuild.** Tuning a prompt is a file edit, not a
   TypeScript change plus a restart.
3. **Runtime neutrality.** The dashboard drives Claude Code, Codex, and
   OpenCode. Prompt text that names Claude's tools by hand (`use Read, Glob,
   Grep`) is wrong on the other two, so runtime-specific phrasing is injected
   through reserved variables instead of hardcoded.

## Frontmatter

```yaml
---
id: patch/source-analyst      # stable identity, matches the path
slot: patch.source-analyst    # which settings assignment picks runtime + model
access: repo-read             # text-only | repo-read | repo-read-exec | repo-write
timeoutMs: 600000
output: json                  # text | json
schema: schemas/source-spec.json   # enforced natively where the runtime supports it
vars: [FEATURE_NAME, SOURCE_LABEL, SOURCE_ENTRY]
description: ...
---
```

`access` is a *safety* declaration and belongs to the code, not to user
settings: a user changing a model assignment must never be able to widen what
an agent is allowed to touch.

## Templating

`{{VAR}}` substitution and `<!-- include: _partials/x.md -->` includes. That is
the whole feature set — deliberately no conditionals and no loops. When a
prompt needs a branch, split it into two files; that is also the "focused
prompts beat comprehensive prompts" lesson from `LEARNINGS.md` applied to the
prompt library itself.

Two loader rules make this safe, and both fail loudly:

- a `{{VAR}}` in the body that is neither declared in `vars:` nor reserved
  **throws at load**;
- a declared var not supplied **throws at render**.

Emitting a literal `{{SPEC_JSON}}` into a live prompt is the worst failure mode
of templated prompts, so it is made impossible rather than unlikely.
`lintAgents()` runs at server boot, so a typo surfaces at `npm run dev` instead
of eight minutes into a patch run.

## Reserved variables

Always available, never declared in `vars:`, injected by the runtime layer so
no prompt file ever names a runtime:

| var | meaning |
|---|---|
| `TOOL_NOTES` | how this runtime exposes file/search/shell tools |
| `OUTPUT_NOTES` | how to emit structured output (empty when the runtime enforces a schema natively) |
| `BUILD_COMMAND` | the repo's build command |
| `BUILD_NOTES` | runtime-specific advice about running a long build |
| `SOURCE_DIR` / `TARGET_DIR` | absolute repo paths for the current job |

## Layering

| layer | lives in |
|---|---|
| Workflow — sequencing and gates | `server/src/routes/patches.ts` |
| Agent definition — one stage's prompt | `agents/patch/*.md` |
| Skill / reference — reusable knowledge | `agents/_partials/*.md` |
| Runtime adapter — execution | `server/src/runtime/adapters/*` |

Mandatory procedure lives in the workflow and is injected. It is never left to
the model to decide whether to load a gate.
