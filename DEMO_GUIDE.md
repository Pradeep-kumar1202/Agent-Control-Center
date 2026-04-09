# Feature Gap Dashboard — Project Documentation & Demo Guide

## What is this?

A **local-only web dashboard** that automatically finds feature gaps between two payment SDK repositories:

- **hyperswitch-web** — the web (JavaScript/ReScript) SDK
- **hyperswitch-client-core** — the mobile (ReScript) SDK

Both repos are part of the same product (Hyperswitch payment orchestration), but they've been developed independently. Features get added to one SDK and sometimes never make it to the other. This tool finds those gaps, verifies them with AI, and can even generate patches to fill them.

## What can it do?

### 1. Automated Feature Gap Detection (one click)
Click **"Run Gap Analysis"** and the system:
- Clones/pulls both repos locally
- Uses AI to extract features across 4 categories: **configs**, **components**, **backend APIs**, and **payment methods**
- Normalizes naming differences across repos (e.g. `card_holder_name` in web = `cardHolder` in mobile)
- Applies deterministic noise filters to remove false positives
- Shows a clean table of genuine feature gaps

### 2. Per-Gap AI Verification
Each gap row has a **"Verify"** button that:
- Sends an AI agent into the missing repo with file-reading tools
- The agent actually searches the codebase to confirm the feature is truly absent
- If found under a different name → **auto-removes** the row (false positive)
- If confirmed missing → marks it with a green **"verified"** badge
- If it's platform-specific (can't exist on that platform) → marks it accordingly

### 3. AI-Powered Patch Generation
Each gap row has a **"Generate Patch"** button that:
- Creates a git branch in the target repo (`feat/gap-<id>-<name>`)
- Sends an AI agent with full code editing capabilities into the repo
- The agent reads the reference implementation from the other repo
- Implements the missing feature following the target repo's conventions
- Shows a **color-coded diff viewer** with the changes
- Provides a copyable git command to checkout the branch locally

Everything stays **100% local** — no credentials, no GitHub pushes, no API keys needed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React)                       │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌───────────┐ │
│  │ Run Gap  │  │ Filter   │  │  Verify    │  │ Generate  │ │
│  │ Analysis │  │ Pills    │  │  Button    │  │ Patch     │ │
│  └────┬─────┘  └──────────┘  └─────┬──────┘  └─────┬─────┘ │
│       │                            │                │        │
│       ▼                            ▼                ▼        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Vite Dev Server (port 5173)                │   │
│  │            Proxies /api → localhost:5174              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node/Express Server (port 5174)            │
│                                                              │
│  Routes:                                                     │
│    POST /analyze          → Run full gap analysis            │
│    POST /analyze/cancel   → Kill running analysis            │
│    GET  /reports/latest   → Latest report status             │
│    GET  /gaps             → List gaps for a report           │
│    POST /gaps/:id/validate → AI-verify one gap               │
│    POST /gaps/:id/patch   → AI-generate patch for one gap    │
│    GET  /patches/:id      → Get patch details + diff         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   SQLite DB   │  │  SHA Cache   │  │  Patch Files     │  │
│  │  data/app.db  │  │ data/cache/  │  │  data/patches/   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              LLM Layer (llm.ts)                       │   │
│  │   Shells out to `claude -p` (Claude CLI)              │   │
│  │   Uses Max plan login — NO API key needed             │   │
│  └────────┬─────────────────┬────────────────┬──────────┘   │
│           │                 │                │               │
│           ▼                 ▼                ▼               │
│     ┌──────────┐     ┌──────────┐     ┌──────────┐         │
│     │  Sonnet  │     │  Sonnet  │     │   Opus   │         │
│     │ Extract  │     │Normalize │     │ Validate │         │
│     │ (cheap)  │     │ (cheap)  │     │ + Patch  │         │
│     └──────────┘     └──────────┘     │(powerful)│         │
│                                       └──────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Local Workspace                            │
│  workspace/hyperswitch-web/          (cloned via git)        │
│  workspace/hyperswitch-client-core/  (cloned via git)        │
└─────────────────────────────────────────────────────────────┘
```

---

## How AI is Used (the interesting part for the demo)

### The LLM Layer (`server/src/llm.ts`)

We call Claude through the **Claude CLI** (`claude -p`), not through an API. This means:
- No API key or `ANTHROPIC_API_KEY` needed
- Uses the logged-in **Claude Max plan** subscription
- Each call spawns a subprocess: `claude -p --model <model> --output-format text`
- We track all active subprocesses so the Cancel button can kill them

### Three tiers of AI usage

| Tier | Model | Tools | Purpose | Cost |
|------|-------|-------|---------|------|
| **Extract** | Sonnet (fast, cheap) | None | Read file contents, identify features | ~8 calls per run |
| **Normalize** | Sonnet | None | Cross-repo name matching, dedup | ~4 calls per run |
| **Verify** | Opus (powerful) | Glob, Grep, Read | Search codebase to confirm gap | 1 call per gap (on demand) |
| **Patch** | Opus | Edit, Write, Read, Glob, Grep | Implement missing feature | 1 call per patch (on demand) |

### How each AI agent works

#### Extract Agent (Sonnet, no tools)
```
Input:  File contents from the repo (we read them ourselves, pass to the prompt)
Prompt: "Here are the ReScript files from the payments directory. List every
         payment method you find with its name, file path, and a code snippet."
Output: JSON array of {name, file, snippet}
```
- Runs 8 times in parallel (4 categories × 2 repos)
- **Cached by git SHA** — same commit = zero calls on re-run

#### Normalize Agent (Sonnet, no tools)
```
Input:  Two feature lists (web + mobile) for one category
Prompt: "Map naming variants across repos. 'card_holder_name' = 'cardHolder'.
         Collapse sub-fields into parents. Output one canonical list."
Output: JSON array of {canonical_name, web: Feature|null, mobile: Feature|null}
```
- Where `web = null` or `mobile = null` → that's a gap
- **Cached by both SHAs** — same commits = zero calls

#### Verify Agent (Opus, with tools)
```
Input:  One claimed gap (e.g., "click_to_pay missing in mobile")
Tools:  Glob (find files), Grep (search content), Read (read files)
CWD:    Set to the missing repo's directory
Prompt: "Feature 'click_to_pay' is claimed missing from this repo.
         USE your tools to actually look. Search under that name and
         any plausible alias. Report: confirmed / false_positive / platform_specific."
Output: JSON verdict with rationale
```
- Opus can actually browse the filesystem to check
- Only runs when you click "Verify" — not on every analysis run
- **Cached by repo SHA** — verify once, free forever at that commit

#### Patch Agent (Opus, with write tools)
```
Input:  Gap details + reference implementation from the other repo
Tools:  Edit, Write, Read, Glob, Grep
CWD:    Set to the missing repo's directory
Prompt: "Implement 'click_to_pay' in this repo. Here's how it looks in the
         web SDK: [code]. Follow this repo's conventions. Only touch
         necessary files."
Output: Modified files on disk → we capture as git diff
```
- Creates a real git branch with real code changes
- You can checkout the branch and review/modify the code

### Deterministic Filters (no AI, instant)

Between extraction and normalization, we run **zero-cost deterministic filters** (`server/src/analyzer/filter.ts`):

1. **Canonical group collapse**: `appearance_theme`, `appearance_variables`, `color_primary`, `color_background`, `font_family` → all become ONE feature called `appearance_api`. Both repos have this, so it's not flagged as a gap.

2. **UI primitive denylist**: `tab_bar`, `date_element`, `button_element`, `generic_button_element` → dropped. These are infrastructure, not integrator features.

3. **Payment-method-specific form fields**: `blik_code_input`, `pix_payment_input`, `vpa_id_input` → dropped. Mobile shows generic backend-driven forms, so these web-specific input components will never exist in mobile.

4. **Structural false positive rule**: Payment methods "missing in mobile" are always false positives because the mobile SDK loads payment methods dynamically from the backend — you won't find payment method names in its source code.

These filters reduced raw gaps from **~240 → ~75** without any AI call.

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | React + Vite + Tailwind CSS | Fast dev, good DX |
| Backend | Node.js + Express + TypeScript | Simple, typed |
| Database | SQLite (better-sqlite3) | Zero config, local file |
| Git ops | simple-git | Clone, pull, branch, diff |
| AI | Claude CLI (`claude -p`) | No API key, uses Max plan |
| Caching | SHA-keyed JSON files on disk | Same commits = zero AI calls |

### Key files

```
feature-gap-dashboard/
├── CLAUDE.md                  # AI assistant context (auto-loaded)
├── LEARNINGS.md               # Iteration log — what worked, what didn't
├── DEMO_GUIDE.md              # This file
├── data/
│   ├── app.db                 # SQLite database
│   ├── cache/
│   │   ├── extract/           # Cached extractor outputs (by repo SHA)
│   │   ├── normalize/         # Cached normalize outputs (by both SHAs)
│   │   └── validate/          # Cached validation verdicts (by repo SHA)
│   └── patches/               # Generated .patch files
├── workspace/
│   ├── hyperswitch-web/       # Cloned web repo
│   └── hyperswitch-client-core/ # Cloned mobile repo
├── server/
│   └── src/
│       ├── index.ts           # Express server entry
│       ├── config.ts          # Paths, ports, model selection
│       ├── db.ts              # SQLite schema + types
│       ├── llm.ts             # Claude CLI wrapper (ask, askJson)
│       ├── cache.ts           # SHA-keyed disk cache
│       ├── analyzer/
│       │   ├── index.ts       # Pipeline orchestrator
│       │   ├── filter.ts      # Deterministic noise filters
│       │   ├── normalize.ts   # Cross-repo name matching (Sonnet)
│       │   ├── validate.ts    # Per-gap verification (Opus + tools)
│       │   ├── types.ts       # Shared types
│       │   └── extractors/    # Per-category feature extractors
│       │       ├── paymentMethods.ts
│       │       ├── configProps.ts
│       │       ├── uiComponents.ts
│       │       └── backendApis.ts
│       └── routes/
│           ├── analyze.ts     # POST /analyze, GET /reports, GET /gaps
│           ├── gaps.ts        # POST /gaps/:id/validate
│           └── patches.ts     # POST /gaps/:id/patch, GET /patches/:id
└── web/
    └── src/
        ├── App.tsx            # Main dashboard
        ├── api.ts             # Typed API client
        └── components/
            ├── GapTable.tsx    # Gap table with Verify + Patch buttons
            ├── DiffViewer.tsx  # Modal showing color-coded diff
            └── RunButton.tsx   # Run analysis button with spinner
```

---

## Demo Script (suggested flow)

### Setup (before recording)
- Both servers running: `npm run dev` in both `server/` and `web/`
- Browser open to `http://localhost:5173`
- Dashboard shows "idle" state (or a previous completed report)

### Demo flow

**1. "Here's the problem"** (~30 seconds)
> "We have two SDKs — web and mobile — for the same payment product. Features get added to one and sometimes never make it to the other. Finding these gaps manually means reading thousands of lines of ReScript across both repos. This dashboard automates that."

**2. Run Gap Analysis** (~1 minute wait)
- Click the **Run Gap Analysis** button
- While it runs, explain: "The system clones both repos, then uses Claude Sonnet to extract features across four categories — payment methods, configs, UI components, and backend APIs. It runs 8 extraction calls in parallel, then normalizes naming differences across repos."
- Point out: "This is cached by git commit SHA, so if the repos haven't changed, re-running is instant — zero AI calls."

**3. Review the results** (~1 minute)
- Show the gap count and the filter pills (All / Missing in mobile / Missing in web)
- Show the payment methods toggle: "Payment methods are hidden by default because the mobile SDK loads them dynamically from the backend — static analysis can't detect them, so they'd all be false positives."
- Scroll through some gaps: "Each row shows what's missing and where. But these are unverified — the AI found them through name matching, not by actually searching the code."

**4. Verify a gap** (~30 seconds)
- Pick gap #179 (`hide_card_nickname_field`) or any config gap
- Click **Verify**
- Explain: "This sends Claude Opus — the most powerful model — into the mobile repo with actual file-reading tools. It searches for this feature under any name or alias. If it finds it, the row is auto-removed as a false positive. If confirmed missing, it gets a green badge."
- Wait for the result (~15 seconds)

**5. Generate a patch** (~2 minutes)
- On the same verified gap, click **Generate Patch**
- Explain: "Now Opus gets write access to the mobile repo. It reads the reference implementation from the web SDK, understands the mobile SDK's code conventions, and implements the feature. It creates a real git branch with real code changes."
- Wait for the diff viewer to open (~1-2 minutes)
- Walk through the diff: "Here's what it changed — it added the config option to the types file and wired it into the dynamic fields component. This follows the exact same pattern the mobile SDK uses for other config flags."
- Show the branch checkout command at the bottom

**6. Key takeaways** (~30 seconds)
> "Three things make this practical:
> 1. **It's local-only** — no API keys, no GitHub access, runs on a shared machine using the Claude Max subscription.
> 2. **It's token-efficient** — extraction and normalization use the cheaper Sonnet model. The expensive Opus model only runs when you explicitly click Verify or Generate Patch. And everything is cached by git SHA.
> 3. **Quality over quantity** — deterministic filters remove ~60% of noise before any AI call. Then per-gap verification catches what the filters miss. You never see false positives in your final results."

---

## Numbers to mention

- **Raw extraction**: ~256 features across both repos
- **After deterministic filter**: ~143 features (no AI cost)
- **After normalization**: ~75 candidate gaps
- **After structural false-positive removal**: ~40-50 actionable gaps
- **Cold run time**: ~1 minute (Sonnet extraction + normalization)
- **Cached run time**: instant (same git SHAs = zero AI calls)
- **Per-gap verification**: ~15 seconds (Opus)
- **Per-gap patch generation**: ~1-2 minutes (Opus with write tools)

---

## Design decisions worth mentioning

1. **Why Claude CLI instead of API?** No API key needed. The team's Max plan subscription covers everything. `claude -p` shells out to the locally installed CLI.

2. **Why two models?** Sonnet is fast and cheap — good for bulk extraction. Opus is powerful and can use tools — needed for verification (searching code) and patching (writing code). Using Opus for everything would cost 10x more tokens.

3. **Why lazy verification?** Our first design validated all ~90 gaps up front with Opus. It took 11 minutes and burned through tokens. Lazy verification means you only pay for the gaps you care about.

4. **Why deterministic filters?** We learned through iteration that ~60% of "gaps" were noise — appearance sub-keys listed as separate features, generic UI primitives, platform-specific form inputs. A 30-line filter function eliminated them for free. See `LEARNINGS.md` for the full iteration history.

5. **Why SHA-based caching?** If neither repo has new commits, every AI call is skippable. This makes re-runs and demos essentially free.
