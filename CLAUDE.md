# Feature Gap Dashboard — context for Claude

This file is auto-loaded by Claude Code when working in this directory. It exists so Claude picks up project context without re-deriving it every session. Before making changes, **also read `LEARNINGS.md`** — it contains the running iteration log and the "things we already tried and know don't work" list.

## What this project is

A local-only web dashboard at `/home/sdk/sdk/pradeep.kumar/feature-gap-dashboard/` that compares two payment SDK repos — `hyperswitch-web` (ReScript web SDK) and `hyperswitch-client-core` (ReScript mobile SDK) — and surfaces feature gaps the user can turn into local patches.

Stack:
- Server: Node + Express + better-sqlite3 + TypeScript. Shells out to `claude -p` with `--permission-mode bypassPermissions`, `--allowed-tools`, and a `cwd` option. Uses the logged-in Max plan session — **no API key, no `ANTHROPIC_API_KEY`, never import `@anthropic-ai/sdk`**.
- Web: Vite + React + Tailwind, proxies `/api` to `http://localhost:5174`.
- Data: SQLite at `data/app.db`, SHA-keyed disk cache at `data/cache/{extract,normalize,validate}/`, patches at `data/patches/`.
- Workspace clones: `workspace/hyperswitch-web` and `workspace/hyperswitch-client-core`, synced via simple-git.

Current pipeline:
1. `syncAllRepos()` clones or pulls both repos.
2. Extract per-category × per-repo in parallel — 8 Sonnet calls. Categories: `payment_method`, `config`, `component`, `backend_api`. Extractors in `server/src/analyzer/extractors/`. Cached by repo SHA.
3. Normalize per-category — 4 Sonnet calls that collapse near-duplicates. Cached by both SHAs.
4. Derive gaps (one side null) and insert ALL of them with `verified=0`. No Opus validation on the hot path.
5. Per-gap `POST /gaps/:id/validate` runs Opus + Read/Grep/Glob on one row, cwd-pinned to the missing repo. Verdicts: `confirmed` (verified=1), `platform_specific` (kept+dimmed), `false_positive` (row deleted).

## Hard constraints (non-negotiable)

Every proposal must be checked against all four:

1. **No API key.** Max plan only. Everything goes through `claude -p` subprocess.
2. **No false positives.** Quality is non-negotiable. A real gap buried in noise is worse than a smaller, trustworthy list.
3. **No token waste.** No bulk Opus+tools passes. Prefer deterministic filtering, cache hits, and on-demand escalation.
4. **Shared machine, scoped credentials only.** This box is shared across the team — never write per-user credentials, never write project context to `~/.claude`. All persistent project context goes in this repo (CLAUDE.md, LEARNINGS.md). **GitHub push is now allowed via the shared `pradeep120230-creator` bot account only**, authenticated via `gh auth login` (token in `~/.config/gh/hosts.yml`, marked as `keyring`). The patches route uses this to push feature branches to bot forks under `pradeep120230-creator/sdk-agent-*` and open PRs against `juspay/*`. See LEARNINGS.md iteration 5 for the full story. **Do not** generate per-user PATs, do not write tokens into the repo, do not push from any account other than the bot.

## Known truths about the repos

- **Mobile SDK (hyperswitch-client-core) loads payment methods dynamically** from backend responses. Static extraction will never find payment-method names in mobile source. Every web payment method always looks "missing in mobile". These are structural false positives. Dropped at the data layer (not just UI) in `filter.ts` → `isStructuralFalsePositive`.
- **Mobile SDK shows generic backend-driven forms** for payment methods. Web renders dedicated input components per payment method (e.g. `blik_code_input`, `pix_payment_input`, `vpa_id_input`, `document_number_input`, `crypto_currency_networks`, `gift_card_form`). These will never exist as separate components in mobile. Dropped in `filter.ts` → `COMPONENT_NOISE_EXACT`.
- **Config props exist in both SDKs but under different names.** Example: mobile `merchant_display_name` ↔ web `business_name`. The LLM normalize pass can miss these cross-name mappings. The per-gap Verify button (Opus + tools) catches them — it greps the missing repo and finds the aliased name → verdict: false_positive → row deleted.

## How to work on this project

1. **Before any change, read `LEARNINGS.md`.** Check if the problem you're about to solve is already in the log under "what we know we can't do" or as a past iteration.
2. **After any change, append to `LEARNINGS.md`.** One entry per iteration: what we tried, what it cost, what it taught us, what's next. Never delete history.
3. **If you catch yourself proposing something already in the log, stop.** The log exists because we've caught ourselves circling.
4. **The current root problem is that extractors are too permissive.** Any fix that doesn't attack the extractor output will keep us circling. See LEARNINGS.md iteration 2 for why.
