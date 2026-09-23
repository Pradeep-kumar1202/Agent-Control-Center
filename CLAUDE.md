# Feature Gap Dashboard — context for Claude

This file is auto-loaded by Claude Code when working in this directory. It exists so Claude picks up project context without re-deriving it every session. Before making changes, **also read `LEARNINGS.md`** — it contains the running iteration log and the "things we already tried and know don't work" list.

## What this project is

A local-only web dashboard at `/Users/pradeep.kumar/Documents/Agent-Control-Center/` that compares two payment SDK repos — `hyperswitch-web` (ReScript web SDK) and `hyperswitch-client-core` (ReScript mobile SDK) — and surfaces feature gaps the user can turn into local patches.

Stack:
- Server: Node + Express + better-sqlite3 + TypeScript. **Requires Node 22** —
  `better-sqlite3@11` has no prebuild for Node 26 and its source build fails.
  Pinned in `.nvmrc` + `engines`, and enforced by `scripts/preflight.mjs`, which
  `npm run dev` runs first. Run `nvm use 22` before starting; on the wrong Node
  the failure otherwise looks like a dashboard outage rather than a setup error.
- **All server-side git goes through `server/src/workspace/git.ts`.** Never call
  `simpleGit()` directly. `localGit()` disables hooks and refuses prompts, so a
  repo-supplied interactive hook cannot deadlock a run — `hyperswitch-client-core`
  ships a `prepare-commit-msg` that execs commitizen against `/dev/tty`, and
  `--no-verify` does *not* cover that hook. `publishGit()` deliberately leaves
  hooks enabled so this machine's global `core.hooksPath=/etc/git-guardian/hooks`
  **pre-push** secret scanner still runs; pushes must never use `localGit()`.
  Git diffs are stored byte-for-byte as git emits them — never `.trim()` a diff,
  and join multiple diffs with `concatDiffs`, not `join("\n")`. See LEARNINGS
  2026-08-12 for the corrupt-patch and deadlock incidents these prevent.
  Model calls go through `server/src/runtime/`, which drives whichever agent CLI
  a stage is assigned (`claude`, `codex`, `opencode`) using that CLI's own login
  — **no API key, no `ANTHROPIC_API_KEY`, never import `@anthropic-ai/sdk`**.
  Tool access is enforced with `--disallowed-tools`, **not** `--allowed-tools`:
  the latter only pre-approves and restricts nothing (measured — see LEARNINGS
  iteration 9). `server/src/scripts/probeAccessPolicy.ts` re-proves this per tier.
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

1. **No vendor SDKs. Subscription auth only, via CLI subprocesses.** Never
   `npm install @anthropic-ai/sdk` / `openai` / similar, and never put an API key
   in this repo. Every model call shells out to an agent CLI that already holds
   the user's own login: `claude`, `codex`, or `opencode`.

   **Which runtimes are permitted is data, not prose.** It lives in the
   `settings` table (see `server/src/runtime/settings.ts`) and is surfaced at
   `GET /runtimes/probe`. This wording exists because the old "Max plan only,
   `claude -p` only" rule flip-flopped twice — LEARNINGS 2026-04-10 declared it
   superseded by GitHub Models, the code silently reverted to `claude -p`, and
   runtime assignments cannot track that; a probed, persisted setting can.
2. **No false positives.** Quality is non-negotiable. A real gap buried in noise is worse than a smaller, trustworthy list.
3. **No token waste.** No bulk Opus+tools passes. Prefer deterministic filtering, cache hits, and on-demand escalation.
4. **Shared machine, scoped credentials only.** This box is shared across the team — never write per-user credentials, never write project context to `~/.claude`. All persistent project context goes in this repo (CLAUDE.md, LEARNINGS.md). GitHub publishing uses the already-authenticated `gh`/Git credential configuration and may push generated parent branches only to the canonical `juspay/hyperswitch-web` and `juspay/hyperswitch-client-core` repositories. Agent subprocesses must always use `runtime/agentEnv.ts`, which removes GitHub/SSH publishing credentials and disables direct GitHub Git/gh access; only the server publisher may retain push authority. The publisher must verify `origin`, refuse protected branches, use `--force-with-lease`, and never persist a token. Before any remote operation it must resolve an immutable branch commit, pass the fail-closed secret gate in `skills/secretScan.ts` over `origin/main..commit` plus PR metadata, recheck that the branch did not move, and push only that scanned commit. Reject sensitive files, compare against values captured from workspace `.env*` files without logging them, and require gitleaks. A missing or failed scanner means no push. Automatic publishing of submodule changes is blocked until separate canonical submodule PR orchestration exists; never restore the `.gitmodules`-to-fork shortcut. See the latest LEARNINGS.md entries for the superseding decisions.

## Known truths about the repos

- **Mobile SDK (hyperswitch-client-core) loads payment methods dynamically** from backend responses. Static extraction will never find payment-method names in mobile source. Every web payment method always looks "missing in mobile". These are structural false positives. Dropped at the data layer (not just UI) in `filter.ts` → `isStructuralFalsePositive`.
- **Mobile SDK shows generic backend-driven forms** for payment methods. Web renders dedicated input components per payment method (e.g. `blik_code_input`, `pix_payment_input`, `vpa_id_input`, `document_number_input`, `crypto_currency_networks`, `gift_card_form`). These will never exist as separate components in mobile. Dropped in `filter.ts` → `COMPONENT_NOISE_EXACT`.
- **Config props exist in both SDKs but under different names.** Example: mobile `merchant_display_name` ↔ web `business_name`. The LLM normalize pass can miss these cross-name mappings. The per-gap Verify button (Opus + tools) catches them — it greps the missing repo and finds the aliased name → verdict: false_positive → row deleted.

## How to work on this project

1. **Before any change, read `LEARNINGS.md`.** Check if the problem you're about to solve is already in the log under "what we know we can't do" or as a past iteration.
2. **After any change, append to `LEARNINGS.md`.** One entry per iteration: what we tried, what it cost, what it taught us, what's next. Never delete history.
3. **If you catch yourself proposing something already in the log, stop.** The log exists because we've caught ourselves circling.
4. **The current root problem is that extractors are too permissive.** Any fix that doesn't attack the extractor output will keep us circling. See LEARNINGS.md iteration 2 for why.
