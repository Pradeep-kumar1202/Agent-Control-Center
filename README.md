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

Everything runs locally. No cloud storage, no credentials saved, no pushes to GitHub.

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
git clone <your-github-repo-url>
cd feature-gap-dashboard
```

### 2. Install dependencies

```bash
npm install
```

Installs everything for the root workspace, server, and web in one step.

### 3. Start the dashboard

```bash
npm run dev
```

This starts:
- **Frontend** → http://localhost:5173
- **Backend** → http://localhost:5174

Open **http://localhost:5173** in your browser.

### 4. Clone the SDK repos (first run only)

Click **Run Gap Analysis** on the Dashboard tab — the server will automatically clone both SDK repos into `workspace/` (takes ~1–2 min on first run). Subsequent runs just pull the latest.

Or clone them manually upfront:

```bash
mkdir -p workspace
git clone https://github.com/juspay/hyperswitch-web workspace/hyperswitch-web
git clone https://github.com/juspay/hyperswitch-client-core workspace/hyperswitch-client-core
```

---

## Using the AI skills

All skills (Test Writer, PR Review, Add Prop, Translator) live in the tabs at the top of the page.

For **Test Writer** and **PR Review**, the branch field accepts either:
- A local branch name: `feat/add-wallet-pay`
- A GitHub PR URL: `https://github.com/juspay/hyperswitch-web/pull/420`

---

## Project layout

```
feature-gap-dashboard/
├── server/src/
│   ├── skills/          AI skill backends (props, tests, translations, review)
│   ├── routes/          Express routers
│   ├── analyzer/        Gap analysis pipeline
│   └── llm.ts           Claude CLI wrapper (shells out to `claude -p`)
├── web/src/
│   ├── skills/          Skill UI (Form + Results per skill)
│   └── App.tsx          Registry-driven tab layout
├── workspace/           Cloned SDK repos — git-ignored, auto-created
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
Run Gap Analysis first — it clones the repos. If repos exist but analysis is empty, try deleting `data/app.db` and re-running.

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
workspace/       ← SDK repo clones (re-cloned automatically on first run)
data/            ← SQLite DB and generated patch files
node_modules/
.env             ← not needed (no API key)
```
