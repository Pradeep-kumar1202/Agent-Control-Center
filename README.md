# Hyperswitch SDK Agent Control Center

A local agentic dashboard for comparing, maintaining, and porting changes between
[`hyperswitch-web`](https://github.com/juspay/hyperswitch-web) and
[`hyperswitch-client-core`](https://github.com/juspay/hyperswitch-client-core).

The dashboard owns the workflow, Git branches, build gates, history, and UI. AI
work is delegated to a locally installed agent CLI selected in **Settings**:
Claude Code, Codex, or OpenCode. Each CLI uses its own existing authentication
and provider configuration; the dashboard does not store model credentials.

> The orchestration and workspace are local, but prompts are sent to the model
> provider configured in the selected CLI. Workflows can also commit, push to
> the configured bot forks, and open upstream pull requests when GitHub access
> is configured.

## What it does

| Feature | Description |
|---|---|
| **Gap Analysis** | Compares both SDKs for missing payment methods, configuration fields, components, and backend APIs. |
| **Gap Verification** | Checks an individual candidate gap against the supposedly missing repository before it is trusted. |
| **Patch Generation** | Analyses the source implementation, implements the gap on a feature branch, runs a mandatory ReScript build, verifies behavior, and optionally opens a PR. |
| **PR Port** | Accepts a web or mobile PR URL, infers the direction, rejects non-portable changes early, and ports the behavior into the other SDK. |
| **Add Prop** | Adds an integrator-facing configuration prop across both SDKs using their existing patterns. |
| **Test Writer** | Generates Cypress or Detox tests for a local branch or GitHub PR. |
| **Translator** | Adds an i18n key to all supported locale files with a minimal diff. |
| **PR Reviewer** | Runs focused security, logic, and convention reviews against a branch or PR. |
| **Integration Agent** | Implements a payment method or flow from external integration documentation. |
| **Feature Agent** | Provides an interactive agent workflow for developing a feature across the SDKs. |
| **Preview Panel** | Runs the selected patch branch in the web dev server or Android emulator and provides mock-server/config controls. |
| **History and Documentation** | Persists skill runs and reviews, and generates internal plus GitBook-ready documentation for supported changes. |

## Agent runtimes and models

The application routes stable agent **slots** such as `patch.implementer` or
`port.verifier` to named profiles. A profile contains:

- a runtime: `claude-code`, `codex`, or `opencode`;
- the exact model invocation passed to that runtime;
- an optional reasoning-effort value.

Model strings are intentionally free-form. Examples include `sonnet` for
Claude Code or `litellm/open-large` for OpenCode. The Settings page probes the
installed CLIs and offers discovered models as suggestions, but it does not
restrict the value.

### Runtime capabilities

| Runtime | Executable | Supported access policies | Additional readable repositories |
|---|---|---|---|
| Claude Code | `claude` | text-only, read, read + commands, write | Yes |
| Codex | `codex` | read, read + commands, write | Yes |
| OpenCode | `opencode` | read, read + commands, write | No |

Capabilities are checked before strict multi-stage workflows start. Assigning a
runtime that cannot enforce a stage's requested access fails visibly instead of
silently widening permissions.

### Global settings and browser overrides

The server stores a shared default in `data/app.db`. The **Only for this
browser** option stores a complete profile/assignment override in browser
`localStorage` and sends it with supported requests.

The browser override **replaces** the shared settings for that request; it is
not merged with them. Give the override a `default` assignment or explicitly
assign every stage the workflow needs. For example, PR Port requires:

```text
port.triage
port.source-analyst
port.implementer
port.verifier
```

PR Port resolves and freezes all four choices before the run begins. If a slot
is missing and there is no default, the server returns
`AGENTS_NOT_CONFIGURED` (HTTP 428) before doing any repository work.

At present, PR Port is the strict workflow that threads the browser-local
override end to end. Older routes use the shared server settings through the
compatibility layer, so configure their profiles as the shared default until
those routes finish migrating.

## Prerequisites

| Tool | Requirement | Check |
|---|---|---|
| Node.js | **22.x** | `node --version` |
| npm | Version bundled with Node 22 | `npm --version` |
| Git | Any recent version | `git --version` |
| Agent CLI | At least one of Claude Code, Codex, or OpenCode | See below |
| GitHub CLI | Optional; needed to open PRs automatically | `gh --version` |
| Android SDK + emulator | Optional; needed for mobile Preview | `adb devices` |

### Use Node 22

The server uses `better-sqlite3`, a native Node module. This repository is
developed and tested on Node 22; using Node 26 produces a native ABI mismatch.

With `nvm`:

```bash
nvm install 22
nvm use 22
node --version
```

Run `nvm use 22` in each new shell before installing dependencies or starting
the dashboard.

### Install and authenticate an agent CLI

Install at least one runtime. These commands follow the current official setup
guides:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex (macOS/Linux installer)
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# OpenCode
curl -fsSL https://opencode.ai/install | bash
```

Official documentation:

- [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started)
- [Codex CLI](https://developers.openai.com/codex/cli/)
- [OpenCode setup](https://opencode.ai/docs/)

Run the selected executable once and complete its authentication/configuration
flow:

```bash
claude
codex
opencode
```

For OpenCode, configure the provider that owns the model invocation. For
example, `litellm/open-large` requires an OpenCode provider named `litellm` and
working credentials for that route. The Dashboard's **Test** button checks a
profile with a live short request before a long workflow consumes time.

## Setup

### 1. Clone the dashboard

```bash
git clone https://github.com/Pradeep-kumar1202/Agent-Control-Center.git
cd Agent-Control-Center
nvm use 22
```

### 2. Install dashboard dependencies and sync SDK repositories

```bash
npm run setup
```

`npm run setup` installs the root/server/web workspaces, then clones or updates:

```text
workspace/hyperswitch-web
workspace/hyperswitch-client-core
```

Submodules are initialized from their upstream GitHub repositories over HTTPS.
Bot forks are used only as push targets for generated changes.

### 3. Install dependencies in both SDK workspaces

The mandatory ReScript build gate requires `node_modules` inside the target SDK
repository. The sync step deliberately does not install those dependencies.

```bash
npm ci --prefix workspace/hyperswitch-web
npm ci --prefix workspace/hyperswitch-client-core
```

### 4. Start the dashboard

```bash
npm run dev
```

This starts:

- frontend: <http://localhost:5173>
- backend: <http://localhost:5174>
- health check: <http://localhost:5174/health>

The checked-in seed data is imported into an empty database on first boot, so
you can inspect verified gap examples without immediately running a complete
analysis.

## First-run model configuration

1. Open **System → Settings**.
2. Select **Re-probe** and confirm the runtime you installed is detected.
3. Add a profile containing the runtime, model invocation, and optional effort.
4. Select **Test** beside the profile and resolve any authentication/model error.
5. Assign the profile as `default`, or assign individual stages.
6. Choose whether the configuration is shared or **Only for this browser**.
7. Save.

Using a Claude Code default is the quickest way to cover every access policy.
Codex and OpenCode cannot enforce the tool-free policy used by the analysis
extract/normalize stages, so do not assign those slots to those runtimes. They
can still run repository-backed workflows such as PR Port and can be selected
for implementation or verification stages individually.

## Main workflows

### Generate a patch from a gap

1. Run or load Gap Analysis.
2. Verify the candidate gap.
3. Generate the patch from its row.
4. The source analyst studies the SDK where the feature already exists.
5. The implementer edits a `feat/gap-*` branch in the missing SDK.
6. The server runs `npm run --silent re:build` as a hard gate.
7. A read-only verifier checks the implementation against the source spec.
8. On success, the dashboard commits the branch and attempts to push/open a PR.

The `.patch` artifact is saved under `data/patches/`, and the run is recorded in
SQLite. A failed ReScript build keeps a `build_failed` record and branch so it
can be inspected or repaired.

> Current limitation: the original gap-patch route still uses its legacy
> three-agent prompt path. PR Port uses the newer deterministic validators and
> non-silent verifier behavior; the gap-patch route has not yet adopted the
> repair/critic controls shown in Settings. Treat every generated change as a
> review candidate, even when its build is green.

### Port an existing PR across SDKs

Open **Agents → PR Port** and paste a recognized `/pull/<number>` URL from
`hyperswitch-web`, `hyperswitch-client-core`, or their configured bot forks.

The workflow:

1. validates the URL and infers web → mobile or mobile → web;
2. fetches the exact source PR diff;
3. performs deterministic checks and a read-only portability triage;
4. stops with reasons before creating a branch when the change is not portable;
5. produces a structured cross-SDK implementation specification;
6. creates a `port/pr-*` branch and implements in the target SDK;
7. runs the ReScript build, deterministic patch validators, and semantic verifier;
8. opens a normal PR on pass or a draft PR for `needs_review`, when GitHub is available.

Build and validator failures preserve the target branch and report rather than
deleting the work. The target workspace must be on a clean `main` checkout when
the run starts.

### Preview a generated gap patch

Use the **Preview** action on the generated patch row/result. That action passes
the patch's repository and branch into the global Preview Panel; the server then
checks out that branch before running the ReScript build and dev server.

The top-bar **Preview** button is only a global panel toggle. On first use it
defaults to `mobile` + `main`, and later it reuses its last context. Therefore,
do not use the top-bar button as the initial entry point when you specifically
want to test a generated patch.

Patch generation returns the shared workspace checkout to `main` after saving
the result. This is expected. Starting a patch-specific Preview should check the
generated branch back out. If the panel shows or compiles `main`, close it and
reopen Preview from the patch row, then confirm the displayed branch name.

## GitHub PR creation

Automatic PR creation uses the `gh` CLI and the shared bot fork configuration.
Authenticate only the approved bot account:

```bash
gh auth login
gh auth status
```

Defaults can be overridden in `.env`:

```bash
BOT_FORK_OWNER=pradeep120230-creator
WEB_FORK_REPO=sdk-agent-hyperswitch-web
MOBILE_FORK_REPO=sdk-agent-hyperswitch-client-core
SHARED_CODE_FORK=sdk-agent-hyperswitch-sdk-utils
ANDROID_FORK=sdk-agent-hyperswitch-sdk-android
IOS_FORK=sdk-agent-hyperswitch-sdk-ios
```

If pushing or `gh pr create` fails, the workflow returns a `prWarning`; the local
branch and generated diff remain available.

## Optional headless profile seeding

The server can seed agent settings from environment variables on the first boot
of an empty settings database:

```bash
ACC_PROFILE_FAST="claude-code:sonnet"
ACC_PROFILE_CODING="opencode:litellm/open-large:high"
ACC_ASSIGN_DEFAULT="fast"
ACC_ASSIGN_PATCH_IMPLEMENTER="coding"
```

Profile names are derived from `ACC_PROFILE_<NAME>`. Assignment names convert
underscores to dots, so `ACC_ASSIGN_PATCH_IMPLEMENTER` assigns
`patch.implementer`. This is a one-time seed: after profiles exist in SQLite,
the database is the source of truth and later environment changes do not
overwrite it.

## Useful development commands

```bash
npm run dev                         # server + frontend in watch mode
npm run dev:server                  # backend only
npm run dev:web                     # frontend only
npm run build                       # TypeScript + production web build
npm run sync -w server              # sync both SDK repositories/submodules
npm run analyze -w server           # run analysis from the command line
npm run check:pr-port -w server     # build server + deterministic PR Port checks
```

## Project layout

```text
Agent-Control-Center/
├── agents/                         versioned Markdown agent definitions and JSON schemas
│   ├── patch/                      gap-patch prompts
│   ├── pr-port/                    PR Port triage/analysis/implementation/verification
│   ├── _partials/                  reusable SDK knowledge
│   └── schemas/                    structured-output contracts
├── server/src/
│   ├── agents/                     agent loader and deterministic validators
│   ├── analyzer/                   extract → normalize → derive/verify gap pipeline
│   ├── routes/                     Express APIs and NDJSON streaming routes
│   ├── runtime/                    runtime adapters, settings, access policies, event normalization
│   ├── skills/                     skill workflows, Git/submodule helpers, preview, PR creation
│   ├── workspace/                  repository synchronization and per-repo mutexes
│   └── db.ts                       SQLite schema and persistence
├── web/src/
│   ├── components/                 gap, patch, chat, diff, and Preview UI
│   ├── settings/                   runtime profiles and stage assignments
│   ├── skills/                     registry-driven skill forms/results/history
│   └── App.tsx                     application shell and navigation
├── seed/                            checked-in initial gap data
├── workspace/                       cloned SDK repositories; Git-ignored
└── data/                            SQLite, cache, and patch artifacts; Git-ignored
```

See [`agents/README.md`](agents/README.md) for the prompt frontmatter,
templating, schema, and layering conventions.

## Troubleshooting

### `better_sqlite3.node` was compiled against a different Node version

Switch to Node 22 and rebuild the native dependency:

```bash
nvm use 22
npm rebuild better-sqlite3
npm run dev
```

If it still fails, run `npm install` again while Node 22 is active.

### `AGENTS_NOT_CONFIGURED` / HTTP 428

Open **Settings** and assign every slot named in the error, or set a default
profile. If **Only for this browser** is enabled, update that complete local
override or disable it so the request uses the shared settings.

### Runtime unavailable or model authentication failed

1. Run the CLI directly and complete its login/provider setup.
2. Return to **Settings → Re-probe**.
3. Use **Test** beside the profile.
4. Confirm the model invocation exactly matches what the CLI accepts.

For OpenCode/LiteLLM, a blocked or unauthorized provider key must be fixed in
that provider configuration; the dashboard cannot unblock it.

### `node_modules not installed` in an SDK workspace

```bash
npm ci --prefix workspace/hyperswitch-web
npm ci --prefix workspace/hyperswitch-client-core
```

After dependency installation, confirm the SDK worktrees are clean before
starting a workflow that creates a branch.

### Preview compiles `main` instead of the patch branch

Open Preview from the patch row/result rather than the top bar. Confirm the
branch shown in the panel is the generated `feat/gap-*` branch rather than
`main`.
The top-bar Preview defaults to `main` until it has received patch context.

### Review or Test Writer reports `no merge base`

The workspace clone may be shallow:

```bash
cd workspace/hyperswitch-web       # or workspace/hyperswitch-client-core
git fetch --unshallow
```

### Port already in use

```bash
lsof -ti:5173 | xargs kill
lsof -ti:5174 | xargs kill
npm run dev
```

### Submodule setup failed

Re-run:

```bash
npm run sync -w server
```

The sync command converts SSH submodule URLs to upstream HTTPS in local Git
configuration. It does not edit the tracked `.gitmodules` files.

### PR creation failed or `gh` is missing

Install the [GitHub CLI](https://cli.github.com/), authenticate the approved bot
account, and retry the push/PR step manually if needed. The dashboard preserves
the local branch and reports the failure as `prWarning`.

## Local data and credentials

The following paths are intentionally excluded from Git:

```text
/workspace       cloned SDK repositories and generated branches
/data            SQLite database, analysis cache, and patch files
/node_modules    installed dependencies
/.env            local environment configuration
```

The dashboard stores runtime/model **names**, not provider secrets. Claude Code,
Codex, OpenCode, and `gh` keep their own authentication outside this repository.
Browser-local agent settings contain only profile and assignment metadata.
