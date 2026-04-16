# Hyperswitch SDK Agent Control Center

A local AI dashboard for comparing and maintaining the [hyperswitch-web](https://github.com/juspay/hyperswitch-web) and [hyperswitch-client-core](https://github.com/juspay/hyperswitch-client-core) SDKs.

## What it does

| Feature | Description |
|---------|-------------|
| **Gap Analysis** | Detects features present in one SDK but missing in the other — payment methods, config props, UI components, backend APIs |
| **Patch Generation** | AI generates a local branch + diff that adds the missing feature to the lagging repo |
| **Add Prop** | Adds a new integrator-facing prop to both SDKs in one click |
| **Test Writer** | Writes Cypress (web) and Detox (mobile) e2e tests for any branch or PR |
| **Translator** | Translates a new i18n key into all 32 supported languages, inserts it into every locale file with a minimal git diff |
| **PR Reviewer** | Comprehensive review of a branch or PR — correctness, patterns, test coverage, translations, type safety, security, edge cases |
| **Documentation** | Auto-generates internal dev notes for every skill run **and** a GitBook-ready copy that matches the voice and structure of [docs.hyperswitch.io](https://docs.hyperswitch.io/integration-guide/payment-experience/sdk-reference/react) — paste it straight into the official docs |
| **Skill History** | Every skill run (Add Prop, Test Writer, Translator, Review) is persisted — close the modal, refresh the page, results are still there |

Everything runs locally. Patches and PRs go only to the shared bot account's public forks; no cloud storage; no per-user credentials saved.

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 20+ | `node --version` |
| npm | 9+ | `npm --version` |
| Git | any | `git --version` |
| Claude CLI | latest | see below |

### Install the Claude CLI

```bash
npm install -g @anthropic-ai/claude-code
```

Log in with your Claude account:

```bash
claude login
```

A browser window opens — sign in with the same account as your Claude Pro or Max subscription. **No API key needed.** All AI calls shell out to `claude -p` and bill against your existing subscription.

> Claude Pro is sufficient for all features.

---

## Setup

### 1. Clone this repo

```bash
git clone https://github.com/Pradeep-kumar1202/Agent-Control-Center.git
cd Agent-Control-Center
```

### 2. One-shot bootstrap

```bash
npm run setup
```

This runs `npm install` across the root, server, and web workspaces, then clones both SDK repos into `workspace/` and initialises their submodules from the bot's **public HTTPS forks** at `github.com/pradeep120230-creator/sdk-agent-*`. No SSH key required.

If you'd rather do it step-by-step:

```bash
npm install                    # root + server + web deps
npm run sync -w server         # clone SDK repos + init submodules from bot forks
```

> **Why forks for submodules?** The upstream `juspay/hyperswitch-client-core` has `ios` and `android` submodules pointing at `git@github.com:` (SSH), which breaks on a fresh machine without SSH keys. `npm run setup` overrides those URLs in local `.git/config` only — the tracked `.gitmodules` stays pointing at juspay so your PRs compare cleanly against upstream.

### 3. Start the dashboard

```bash
npm run dev
```

This starts:
- **Frontend** → http://localhost:5173
- **Backend** → http://localhost:5174

Open **http://localhost:5173** in your browser. A curated list of ~23 verified gaps ships in the repo under `seed/` and auto-imports on first boot — you can start exploring Patch Generation and the skills immediately, without waiting for a full gap analysis.

---

## Using the AI skills

All skills (Test Writer, PR Review, Add Prop, Translator) live in the tabs at the top of the page.

For **Test Writer** and **PR Review**, the branch field accepts either:
- A local branch name: `feat/add-wallet-pay`
- A GitHub PR URL: `https://github.com/juspay/hyperswitch-web/pull/420`

### Official GitBook docs

Every successful skill run writes two markdown bodies into the **Documentation** tab:

1. **Internal notes** — _What it does / How it was implemented / Configuration / Testing notes_. Useful for PR reviewers and future maintainers.
2. **📘 Official GitBook copy** — a publish-ready block styled to match [docs.hyperswitch.io](https://docs.hyperswitch.io/integration-guide/payment-experience/sdk-reference/react). Click **Copy MD** to grab raw markdown for the official docs, or **Regen Official** to re-roll just the public copy without touching the internal notes.

The `tests` and `review` skills skip the official block (internal scaffolding, not public API). Docs created before this feature existed show a **Generate official doc** button to backfill on demand.

---

## Project layout

```
Agent-Control-Center/
├── server/src/
│   ├── skills/          AI skill backends (props, tests, translations, review, docs, integration)
│   ├── skills/docs/     Dual-body doc generation: internal notes + official GitBook copy
│   ├── routes/          Express routers (gaps, patches, skills, chat, docs, preview, …)
│   ├── analyzer/        Gap analysis pipeline (extract → normalize → derive)
│   ├── workspace/       Per-repo async mutex + git clone/pull manager
│   ├── scripts/         Standalone CLI entrypoints (`sync`, `analyze`)
│   └── llm.ts           Claude CLI wrapper (shells out to `claude -p`)
├── web/src/
│   ├── skills/          Skill UI (Form + Results per skill) + Docs page + Skill History
│   └── App.tsx          Registry-driven tab layout
├── seed/                Checked-in verified-gaps.json + dismissed-gaps.json (auto-imports on empty DB)
├── workspace/           Cloned SDK repos — git-ignored, populated by `npm run setup`
└── data/                SQLite DB + patch files — git-ignored, auto-created
```

---

## Troubleshooting

**`claude: command not found`**
```bash
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.zshrc or ~/.bashrc to persist
```

**Review / Test Writer: "no merge base"**
The workspace clone is shallow. Unshallow it:
```bash
cd workspace/hyperswitch-web     # or hyperswitch-client-core
git fetch --unshallow
```

**Port already in use**
```bash
lsof -ti:5173 | xargs kill
lsof -ti:5174 | xargs kill
npm run dev
```

**Gap analysis shows no results**
Run `npm run setup` if you haven't, then click Gap Analysis. On a fresh clone the seed file populates ~23 verified gaps automatically — if you've blown away `data/app.db`, delete it and restart so the seed re-imports.

**`ERR_MODULE_NOT_FOUND` for `workspace/mutex.js` on boot**
You cloned a version that predates the `/workspace`-anchored `.gitignore` fix and the `server/src/workspace/` source files were accidentally excluded. Pull the latest `main`.

**`setup` fails on a submodule**
Check the output for which submodule failed. All three submodules (`ios`, `android`, `shared-code`) have public HTTPS forks at `github.com/pradeep120230-creator/sdk-agent-*` — `setup` uses those so SSH keys aren't required. If you hit a network error, re-run `npm run sync -w server`.

---

## Logging out of the Claude CLI

When you're done (especially on a shared machine):

```bash
claude logout
```

This clears your session token from `~/.claude`. Run `claude login` again next time.

---

## What stays off GitHub

`.gitignore` excludes everything sensitive or machine-generated:

```
/workspace       ← SDK repo clones (populated by `npm run setup`). Leading slash is load-bearing — anchoring to repo root keeps `server/src/workspace/` (mutex.ts, repoManager.ts) tracked.
data/            ← SQLite DB and generated patch files
node_modules/
.env             ← not needed (no API key)
```
