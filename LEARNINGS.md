# Feature Gap Dashboard — Learnings Log

This file is the running record of design decisions, experiments, and mistakes
for this project. It exists because we've caught ourselves circling the same
trade-offs multiple times. **Read this before proposing a change.**

## Rules

- Every iteration adds one entry to the log below.
- Each entry captures: **what we tried, what it cost, what it taught us, what's next**.
- Never delete entries. Superseded decisions stay visible so we don't re-propose them.
- If Claude proposes something that's already in the log, stop and re-read this file.

## Non-negotiable constraints

These never change. Every proposal is checked against all four:

1. **No API key.** Max plan only. Everything goes through `claude -p` (subprocess). No `@anthropic-ai/sdk`, no `ANTHROPIC_API_KEY`.
2. **No false positives.** Quality is non-negotiable. A real gap buried in noise is worse than a smaller, trustworthy list.
3. **No token waste.** No bulk Opus+tools passes. Prefer deterministic filtering, cache hits, and on-demand escalation.
4. **Local-only, shared machine.** No credentials on disk, no GitHub push. Patches are local branches + diff files.

## Known truths about the repos

- **Mobile SDK (hyperswitch-client-core) loads payment methods dynamically** from backend responses. Static extraction will *never* find payment-method names in the mobile code, so every web payment method always looks "missing in mobile". These are structural false positives — no amount of clever grepping fixes it. Dropped at the data layer in `filter.ts`.
- **Mobile SDK shows generic backend-driven forms** for all payment methods. Web builds dedicated input components per PM (`blik_code_input`, `pix_payment_input`, `vpa_id_input`, `document_number_input`, `crypto_currency_networks`, `gift_card_form`). These will never exist as separate components in mobile — the mobile SDK just renders whatever fields the backend tells it to show. Dropped in `filter.ts`.
- **Config props exist in both SDKs under different names.** Example: mobile's `merchant_display_name` ↔ web's `business_name`. The LLM normalize pass can miss cross-name mappings. The per-gap Verify button (Opus + tools) catches them by actually grepping the missing repo and finding the aliased name → verdict: `false_positive` → row deleted. This is why per-gap verification exists — to handle the cases deterministic filters can't.

---

## Iteration log

### 2026-04-09 — Iteration 1: Bulk Opus validation

**What:** Pipeline was extract (Sonnet × 8) → normalize (Opus × 4) → validate (Opus + Read/Grep/Glob, batched, ~8 batches × ~60s each) → insert survivors. Each claimed gap got fact-checked by Opus actually searching the missing repo.

**Result:** ~40 gaps shown after validation. Precision was high — most were real.

**Cost:** 11 minutes end-to-end. Significant Opus token burn. User: "i cant do it this way".

**Lesson:** Up-front bulk validation with tools is too expensive to run on every button click. The validate prompt and logic were fine; the problem was doing it for 240 items at once when only a few would ever be acted on.

**Next:** Move validation off the hot path.

---

### 2026-04-09 — Iteration 2: Lazy per-gap validation

**What:** Removed the validate pass entirely from `runAnalysis`. Normalize switched from Opus to Sonnet (it's a dedupe, not reasoning). All claimed gaps now inserted with `verified=0`. Added `POST /gaps/:id/validate` for on-demand Opus+tools validation of a single row. Added per-row "Verify" button and a "verified" badge in the UI. Payment methods hidden by default via a UI toggle.

**Result:** Cold run drops to ~1 min, cached run ~instant. But the table now shows **~240 unverified gaps**. The noise that Opus used to filter out is now sitting in front of the user.

**Cost:** Fast and cheap to run. But user workload spiked: verifying 240 rows one-by-one is not realistic, and the list looks overwhelming.

**Lesson:** **The root problem is that extractors are too permissive.** Moving the Opus filter from the hot path to on-demand didn't remove the noise — it just moved *who* has to deal with it from "tokens" to "the user's eyes". Any fix that doesn't attack the extractor output will keep us circling.

**What we now know we can't do:**
- ❌ Bulk Opus validate (too slow, burns tokens — see iteration 1)
- ❌ Show all 240 gaps and trust the user to verify (overwhelming — see iteration 2)
- ❌ Drop categories wholesale (loses real signal, we'd lose poll config, Click-to-Pay, installments, etc.)

**Next:** Attack the noise at the source. Specific candidates, in rough cost order:
1. **Deterministic post-extraction filter (no LLM).** Drop rows matching known noise patterns: internal helper names (`Utils`, `Helpers`, `Context`, `Provider`, `Internal`, `Base`), single-word framework plumbing (`index`, `types`, `config`), test/mock paths, names shorter than 4 chars. This is a 20-line function and should kill most of the obvious junk.
2. **Cross-side near-match filter.** If a web feature name has a string similarity > threshold against any mobile name (Levenshtein / trigram / token-Jaccard), consider it present on both sides — normalize is missing these. Again, no LLM.
3. **Tighter extractor prompts + globs.** Exclude `Utils/`, `Internal/`, `__tests__/`, `*.test.res`, `*.mock.res`, and explicitly tell the extractor to only output integrator-facing features, not internal types.
4. **Category-specific allowlist.** For `component`, only keep names ending in `Element`, `Button`, `Input`, `Field`, `Form`, `Sheet`, `Modal`, `Page`, `Screen`, etc. For `config`, only keep properties that appear as public prop types.
5. **Skip `payment_method` for the mobile side entirely at extract time**, not display time — that eliminates the structural false-positive source instead of hiding it.

**Hypothesis:** Steps 1 + 2 alone should take us from ~240 → ~60. Steps 3 + 4 should take us from ~60 → ~25–30. None of these cost LLM tokens. Then the per-row Verify button becomes realistic for the rows that survive.

---

### 2026-04-09 — Iteration 3: Deterministic prefilter (no LLM)

**What:** Added `server/src/analyzer/filter.ts` with two passes that run between extract and normalize:
1. **Canonical group collapse (config category):** sub-keys of the same API are merged into a single canonical feature per side. Groups: `appearance_*`/`color_*`/`font_*`/`shapes_*` → `appearance_api`; `layout_*` → `layout_config`; `wallets_*`/`google_pay_button_*`/`apple_pay_button_*` → `wallets_ui_config`; `fields_*`/billing/shipping → `billing_fields_config`; `display_saved_payment_methods*` etc → `saved_payment_methods_config`.
2. **Exact-match denylist:** drops generic UI primitives from `component` (`tab_bar`, `date_element`, `button_element`, `generic_*_element`, container shells like `checkout_view`, `payment_sheet`) and per-input styling cruft from `config` (`element_*`, `icon_style`, `placeholder_*`, `confirm_params_*`).

Also added a structural false-positive rule applied at gap-derive time: `payment_method` + `missing_in=mobile` is dropped (mobile loads payment methods dynamically — see "Known truths"). This eliminates the false-positive *source*, not just the UI display.

Filter runs **after** the extract cache, so tuning rules never invalidates extract.

Built `server/src/scripts/measureFilter.ts` to test the filter against cached JSON offline (no LLM calls). This is the right way to tune — every rule change can be measured in milliseconds against real data before touching the pipeline.

**Result (measured against cached extract from web@ffc6e457 / mobile@74c5e241):**

| Category       | Raw features | After prefilter | Naive gaps (raw) | Naive gaps (filtered) |
|---             |---           |---              |---               |---                    |
| payment_method | 44           | 44              | 2                | 2 (32 mobile FPs killed structurally) |
| config         | 134          | 44              | 110              | **32**                |
| component      | 62           | 42              | 58               | 40                    |
| backend_api    | 16           | 13              | 7                | 7                     |
| **Total**      | **256**      | **143**         | **203**          | **81**                |

Note: 81 is a *pessimistic* upper bound — the measurement script does naive name matching, not LLM normalize. The real pipeline still runs Sonnet normalize after prefilter, which catches more near-duplicates (`saved_payment_methods` ↔ `saved_payment_method`, `card_cvc_element` ↔ `cvc_widget`, `payment_methods_header_text` ↔ `payment_sheet_header_text`, etc.). Real surviving gap count after the full pipeline should be lower than 81.

Spot-checking surviving gaps shows clean signal:
- web missing: `netcetera_sdk_api_key`, `enable_partial_loading`, `primary_button_label`, `allows_delayed_payment_methods` (real mobile-only configs)
- mobile missing: `click_to_pay`, `installment_options`, `add_bank_account`, `save_details_checkbox`, `pay_now_button` (real web-only features)
- mobile missing API: `poll_status`, `three_ds_authentication` (real)

**Cost:** ~30 lines of filter code, zero LLM calls at filter time. Cold pipeline still ~1 min, cached pipeline still instant. Tuning the filter never re-runs extract.

**Lesson:**
- **Measuring against cached output before wiring is the right loop.** It took ~5 minutes to tune the filter rules against real data; previously each iteration cost 1+ minute of LLM calls per attempt.
- **Real noise was structural, not lexical.** I assumed "Utils/Helpers/Internal" patterns going in. Actual noise was decomposition mismatch (web exposes appearance as a structured object, mobile flattens to dozens of `color_*` keys) and generic UI primitives mobile lists as components. Hardcoded rules derived from real data beat clever pattern matching.
- **Cache the raw, filter on read.** Storing raw extractor output in the cache means every filter rule change is free to test. A re-run with new filter rules costs zero LLM calls.

**Next:**
- Smoke-test the wired pipeline against fresh repos to confirm real gap count drops as projected.
- Iteration 4 (cross-side string similarity) should catch what normalize misses — `payment_methods_header_text` ↔ `payment_sheet_header_text`, `card_widget` ↔ `card_cvc_element`, etc. Hypothesis: takes us from ~81 → ~40.
- Iteration 5 (tighten extractor globs/prompts) is now lower-priority — the prefilter caught most of what the extractor over-pulls.

---

### 2026-04-10 — Agent reliability overhaul: validators + multi-pass review

**Context change:** The project migrated from `claude -p` subprocess to GitHub Models API (OpenAI SDK → gpt-4.1). CLAUDE.md constraint #1 ("no API key, claude -p only") is superseded — now uses `GITHUB_TOKEN` with gpt-4.1 via OpenAI-compatible endpoint at `https://models.inference.ai.azure.com`.

**What we built:**

**`server/src/agents/validators.ts` (new file)**
A shared deterministic validation layer that runs after every LLM output, before writing to disk or returning to the user. Zero tokens. Catches the most common failure modes regardless of which model is used:
- `filterHallucinatedFilePaths`: drops review findings that cite files not present in the diff. The #1 LLM failure in review mode — inventing plausible-looking paths for issues it "knows about" but which aren't in this PR.
- `computeVerdict`: deterministic verdict gate from issue severity. Models have strong approval bias and will say "approve" even when they just listed blocking issues. This function ignores the stated verdict entirely.
- `deduplicateIssues`: merges findings from multiple passes by category + message prefix. Higher-severity version wins on conflict.
- `parseDiffStats`: extracts filesReviewed/linesAdded/linesRemoved from `git diff --stat` output. Was previously LLM-inferred (unreliable).
- `buildReviewSummary`: templated summary from facts — no extra LLM call, always accurate.
- `validateTranslations`: checks empty, English-leaked, too-long, and missing-placeholder translations before writing to locale files.
- `validateGeneratedTests`: checks generated test files exist on disk, contain describe/it blocks, have assertions, use correct framework patterns, no hardcoded credentials.

**PR Reviewer: single-pass → 3 parallel focused passes**
Previous: one large prompt asking for security + logic + patterns simultaneously. GPT-4.1 (and Claude) spread thin across 7 dimensions in one call.

New pipeline in `skills/review/index.ts`:
1. **Security pass** (opus, tools: Read/Grep): PCI patterns, credential exposure, 3DS integrity, amount mutation. Focused prompt — ignores style.
2. **Logic pass** (opus, tools: Read/Grep): null safety, async race conditions, error propagation, missing edge states. Can read surrounding file context via tools.
3. **Convention pass** (sonnet, no tools): naming, file placement, test coverage, i18n coverage. Cheaper model — pattern matching doesn't need deep reasoning.

All three run with `Promise.all` — wall time is max(pass1, pass2, pass3), not sum. Then deterministic merge → deduplicate → filter hallucinations → verdict gate → templated summary.

**Key principle confirmed again:** deterministic before LLM. Stats, verdict, summary — all now computed from data, not from model output.

**Translator: back-translation verification**
Added two quality gates in `skills/translations/index.ts`:
1. Deterministic (before writing to disk): `validateTranslations()` checks for empty strings, English leakage into non-English locales, strings >250% of English length, missing {placeholder} tokens. Empty translations block the write; others are surfaced as warnings.
2. Back-translation spot-check (1 Sonnet call, runs in parallel with repo writes): back-translates 5 key languages (de, fr, ja, ar, es) and flags semantic drift. Catches meaning-drift that passes the deterministic checks.

**Test Writer: post-generation validation**
Added `validateGeneratedTests()` in both `runWebTestAgent` and `runMobileTestAgent`:
- Parses file paths from agent summary JSON
- Checks each file exists, has describe/it blocks, has assertions, no hardcoded credentials
- Cypress: checks for cy. commands; Detox: checks for device./element()
- Result included in `summaryObj.validationStatus` and `validationIssues` — surfaced to user but doesn't block commit

Also strengthened prompts: explicit failure-path coverage required (declined payment, network error, loading state), config props tested both on/off, explicit "no hardcoded credentials" rule, every it() must have an assertion.

**Token cost:**
- Review: 3 parallel calls (was 1). Wall time similar (parallel). Slightly more tokens but focused prompts are shorter.
- Translator: +1 Sonnet back-translation call per translation run.
- Tests: 0 extra tokens (validation is deterministic).

**Lesson:** Focused prompts beat comprehensive prompts. The security pass finds security issues the combined prompt missed because it wasn't distracted by counting test coverage. The convention pass checks test coverage without being distracted by null safety. Separation of concerns applies to LLM prompts just as much as to code.

### 2026-04-11 — Iteration 5: Visual previews + real PRs (constraint #4 relaxed)

**Context shift:** Up to now, "patch" meant *generate a diff file on disk and let the user `git checkout` the local branch*. The user asked to also see the resulting build — both web (webpack dev server) and mobile (running APK on an Android emulator) — directly from the dashboard. That requires (a) a working Android boot path on this headless Linux box, (b) branches that exist somewhere reachable from the user's Mac so they can build there in the worst case, and (c) a much larger preview surface than the inline 420×128 strip the table cell could host.

The (b) requirement forced **constraint #4 to be relaxed**: GitHub push is now allowed, scoped to the shared `pradeep120230-creator` bot account, authenticated via `gh auth login` (token in `~/.config/gh/hosts.yml`, keyring-backed). No per-user credentials. CLAUDE.md updated to reflect the new boundary.

**What we built (three parts, all merged in this iteration):**

**Part B — Android emulator boot.** `npm run android` was failing with `process exited (code=1, signal=null)` because `react-native run-android` calls `adb devices` immediately and exits if nothing is connected. On a Mac, opening Android Studio side-effects an AVD boot. On this Linux box, nothing was running. Added `prepareAndroidDevice()` in `server/src/skills/previewManager.ts` that:
- Calls `adb start-server` (idempotent).
- Checks `adb devices`; if anything is connected, no-op (lets the user's own scrcpy/Studio session keep working).
- Otherwise spawns the AVD headlessly: `emulator -avd $PREVIEW_AVD -no-window -no-audio -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect`.
- Polls until `adb shell getprop sys.boot_completed` returns `1`, with a 180s timeout.
- Stores the emulator process at module scope so it survives across previews — boot is ~30s, paying it once per server lifetime is enough.
- The slot is created **before** the emulator boot, so all `[emulator]` log lines flow into the same ring buffer the UI is already polling.
- AVD name is configurable via `PREVIEW_AVD` env var (default `Medium_Phone`, which already exists at `~/.android/avd/`).
- Replaced the generic `process exited (code=1, signal=null)` error with a specific message that distinguishes "emulator failed to boot" from "build failed after emulator was up".
- `stopAllPreviews()` also tears down the emulator on server shutdown.
- **Verified end-to-end on this box**: Medium_Phone boots headless, adb sees `emulator-5554 device`, `getprop sys.boot_completed` → `1`. Boot takes ~30s on cold start.

**Part A — Real PRs against `juspay/*` upstream.** New `server/src/skills/githubPr.ts` (~280 lines, no octokit dep — gh CLI + simple-git only):
- `pushBranchToFork(repoDir, repoKey, branch)` adds/updates a `bot` git remote pointing at the parent fork (`https://github.com/pradeep120230-creator/sdk-agent-<repo>.git`) and force-pushes. Auth flows through gh's installed credential helper (`!/usr/bin/gh auth git-credential` registered for `https://github.com`), so simple-git just works without any token plumbing.
- `createPullRequest({repoKey, branch, title, body})` shells out to `gh pr create --repo juspay/<repo> --head pradeep120230-creator:<branch> --base main` and parses the URL it prints.
- `formatPrBody(...)` assembles a markdown body from the agent summary JSON, gap rationale, files-touched count, and a tail of the build log inside a `<details>` block.
- `routes/patches.ts` calls these after the existing `runRescriptBuild` passes and `commitWithSubmodules` finishes. PR creation failures don't fail the patch — they get logged into a new `pr_warning` column. PR success persists `pr_url` + `pr_number` on the `patches` table (three new migrated columns).
- DiffViewer.tsx surfaces the result: when `patch.prUrl` is set, the footer shows the PR URL + a green "Open PR ↗" button. When it isn't, it shows the warning and falls back to the old "Copy PR Description" button.

**Part A.2 — Submodule fork support.** Both repos use git submodules (`shared-code` for both, plus `android` and `ios` for mobile). Initial Part A handled this by skipping PR creation entirely if any submodule was touched, because pushing only the parent fork produces a PR whose submodule pointer points at a SHA that doesn't exist anywhere reachable. The user forked the three submodule upstreams (`juspay/hyperswitch-sdk-utils`, `juspay/hyperswitch-sdk-android`, `juspay/hyperswitch-sdk-ios` → `pradeep120230-creator/sdk-agent-hyperswitch-sdk-*`) and asked for full support. Added:
- `SUBMODULE_FORKS` map (configurable via `SHARED_CODE_FORK` / `ANDROID_FORK` / `IOS_FORK` env vars).
- `pushSubmoduleToFork({parentDir, subDir, branchName})` — adds/updates a `bot` remote inside the submodule and force-pushes its detached HEAD via refspec `HEAD:refs/heads/<branch>`. Returns the SHA we pushed (used in the PR body).
- `rewriteGitmodulesToForks(parentDir, submoduleDirs)` — regex rewrite of the `url = …` line for each affected submodule. Preserves everything else (path, branch, etc.). Sanity-checked against real `.gitmodules` content.
- `routes/patches.ts` flow: for each `commitResult.submodulesChanged`, push to the submodule fork, then rewrite `.gitmodules` and add a follow-up commit on the parent feature branch (`chore: point submodules at bot forks for build`), then push the parent. The PR body now has a `## Submodules` section listing each push and explicitly warning reviewers that the `.gitmodules` rewrite means **this branch is checkout-buildable, not directly upstream-mergeable**. To land it upstream, the submodule changes need their own PRs against the submodule upstream first; that's a future iteration.

**Part C — Larger preview surface + emulator mirror.** New `web/src/components/PreviewDrawer.tsx` — right-edge drawer (`60vw` desktop, full-width mobile, full-height) replacing the inline log strip:
- Header: branch, status pill, open-in-new-tab link, Retry/Stop&Close/Hide buttons.
- Viewport (large, dark): for `web-dev`, an iframe pointing at the dev server URL (`:9050`); for `android-emulator`, an `<img>` polling `/api/preview/mobile/screenshot?t=<tick>` every 500 ms.
- Log tail (~14 lines, scrollable, full drawer width).
- New endpoint `GET /preview/mobile/screenshot` in `routes/preview.ts` pipes `adb exec-out screencap -p` straight into the response as `image/png`. Tested through both the direct server (`:5174`) and the Vite dev proxy (`:5173/api/...`) — returns valid PNGs (95.7 KB for the Medium_Phone home screen).
- `PreviewButton.tsx` got an optional `onOpen` callback. When provided, it defers to the parent (drawer mode) instead of starting the preview inline. State is lifted to `App.tsx` and threaded through `GapTable` → `GapRow` → `PreviewButton`.

**Why `adb screencap` polling and not ws-scrcpy:** The original plan picked ws-scrcpy iframe for the embed. **ws-scrcpy was unpublished from npm in Aug 2023** and is only available via git clone (~100MB install with native modules). On a shared box with the user's stated goal of "see the visual effect", `adb screencap` polled at 2 fps gave us a working solution with **zero new dependencies**, using tooling that was already on the box. Trade-off: view-only, no touch input. The drawer is structured so the `<img>` can be swapped for an iframe later if real interaction becomes a requirement — that upgrade path is documented in the Part C code.

**Why we did not implement two-stage upstream PRs (parent depends on submodule PR landing first):** The user explicitly chose variant A ("optimize for build & test on my Mac / dashboard") over variant B ("land in juspay upstream"). Variant A is one PR per gap, point at bot forks via .gitmodules rewrite, done. Variant B requires per-gap orchestration of N+1 PRs with merge ordering, waiting for submodule PRs to land before opening parent PRs, etc. That's a meaningful extra system and was out of scope. If the dashboard's output ever needs to start landing upstream, this is the upgrade.

**Files touched:**
- `server/src/skills/previewManager.ts` — Android boot, log routing, error messages, `prepareAndroidDevice`, `stopAllPreviews` cleanup.
- `server/src/skills/githubPr.ts` (new) — push, PR, submodule push, .gitmodules rewrite, PR body formatter.
- `server/src/routes/patches.ts` — wired githubPr into the post-build flow with submodule-aware logic.
- `server/src/routes/preview.ts` — new screenshot endpoint.
- `server/src/db.ts` — three migrated columns: `pr_url`, `pr_number`, `pr_warning`. Updated `PatchRow` type.
- `web/src/components/PreviewDrawer.tsx` (new) — drawer with iframe/img viewport + log tail.
- `web/src/components/PreviewButton.tsx` — optional `onOpen` callback for drawer mode.
- `web/src/components/GapTable.tsx` + `GapRow` — threaded `onOpenPreview` callback.
- `web/src/components/DiffViewer.tsx` — "Open PR ↗" link when `prUrl` present, warning fallback otherwise.
- `web/src/App.tsx` — `activePreview` state, drawer render.
- `web/src/api.ts` — `prUrl` / `prNumber` / `prWarning` on `PatchResponse` and `PatchRow`.
- `.env.example` — `BOT_FORK_OWNER`, `WEB_FORK_REPO`, `MOBILE_FORK_REPO`, `SHARED_CODE_FORK`, `ANDROID_FORK`, `IOS_FORK`, `PREVIEW_AVD`.
- `CLAUDE.md` — constraint #4 amended: GitHub push allowed via shared bot only.

**Verification:**
- `tsc --noEmit` clean for both server and web after every step.
- Headless Android boot validated end-to-end (`adb devices` → `emulator-5554 device`, `sys.boot_completed=1`).
- Screenshot endpoint validated through both direct server hit and Vite dev proxy.
- gh auth, fork existence (all 5 forks: 2 parents + 3 submodules), `permissions.push: true` all confirmed via `gh api`.
- Regex rewrite of `.gitmodules` sanity-checked against the real client-core `.gitmodules` — all three sections rewritten correctly, branch lines preserved.

**What the next session needs to know:**
- The bot account is `pradeep120230-creator`. Forks live at `pradeep120230-creator/sdk-agent-hyperswitch-{web,client-core,sdk-utils,sdk-android,sdk-ios}`. Auth is via `gh auth login` (already done on this box, token in keyring).
- A patch that touches submodules will produce a PR with a `.gitmodules` rewrite — this is **intentional** and **not** suitable for direct upstream merge. Don't try to "fix" it by reverting the rewrite without also building the upstream-PR orchestrator.
- The Android preview path requires an AVD named `Medium_Phone` (or whatever `PREVIEW_AVD` is set to). If the AVD doesn't exist, `prepareAndroidDevice` will fail with a clear error. Don't paper over it by silently skipping.
- The mobile preview is **view-only** by design (zero new deps). Don't propose ws-scrcpy/scrcpy/noVNC unless the user explicitly asks for interactive preview — that's a separate iteration with significant install footprint.
- The patches table now has `pr_url`, `pr_number`, `pr_warning` columns. Any code that hand-types the patches schema needs to include them.

**Next iteration hooks (not done yet, listed for future awareness):**
- Two-stage upstream-merge PR orchestration (variant B) if the dashboard's output ever needs to land in juspay upstream.
- Touch-input on the mobile preview via `adb shell input tap X Y` mapped from drawer click coordinates. Trivial to add — `<img onClick>` → POST to `/preview/mobile/tap?x=&y=`.
- ws-scrcpy upgrade (interactive mirror) if 2 fps view-only is ever insufficient.

### 2026-04-11 — Iteration 6: Agent self-verification + baseline build fix

**Problem (user-visible):** Agent generates a patch, post-hoc `runRescriptBuild` fails, route returns 422, no PR. User saw "patch was created locally" (the .patch file exists on disk because it's written *before* the build check) but no PR appeared, with no clear error in the UI.

**Root causes (three layers, not one):**

1. **The agent had no feedback loop.** It edited blindly with Edit/Write/Read/Glob/Grep, never ran the build itself, the server checked after the fact and rejected. Every failed run cost a full Opus context window.
2. **The patches route's "default branch" detection was buggy.** `routes/patches.ts` did `const defaultBranch = (await git.branch()).current || "main"` which captures *whatever the workspace happens to be on* — not main. After the first failed run, the workspace stays on the failed feature branch, the next patch builds on top of stale state, fails, leaves the workspace on the new failed branch... infinite loop of accumulating broken state.
3. **`upstream juspay/hyperswitch-client-core:main` does not build out of the box.** The parent records `shared-code` submodule pointer at `d353de2` (Superposition #34, a feature branch SHA). `PaymentEventTypes.res` was added to shared-code's `main` *later*, and now lives at `0da6f77`. Files in `src/types/SdkTypes.res` reference `PaymentEventTypes.eventFromString` etc., so a fresh clone fails with `The module or file PaymentEventTypes can't be found`. Either juspay's CI doesn't run the ReScript mobile build, or this is a known broken state that hasn't been fixed.

**Fixes applied:**

**Layer 1 — agent self-verification (`routes/patches.ts`):**
- Added `Bash` to `allowedTools` for the patch agent.
- Bumped `timeoutMs` from 600s → 1500s to give the agent room to iterate.
- Rewrote the prompt with a hard requirement: after every meaningful edit, run `npm run --silent re:build 2>&1` via the Bash tool with `timeout: 240000` (Bash tool default of 120s is too short for a cold ReScript build). Up to 5 attempts. Don't output the JSON summary until the build is green. If unable to fix in 5 attempts, output `build_status: failed_after_retries` with the last build error tail in `notes` — better than pretending success.
- Added a "ReScript-specific gotchas" section to the prompt: every constructor of a record must be updated when adding a field, optional fields use `option<T>` + `Some/None`, switches must be exhaustive, etc. These are the failure modes the previous attempts hit.
- Kept the post-hoc `runRescriptBuild` as a server-side safety net — cheap, catches the rare case where the agent claims success but lies.

**Layer 2 — branch state hygiene (`routes/patches.ts:84-96`):**
- Replaced `const defaultBranch = (await git.branch()).current || "main"` with `const defaultBranch = "main"`. Always use main, never read from current state.
- Use `forceCheckoutBranch(targetDir, targetRepo, "main")` (submodule-safe) before creating the feature branch instead of `git.raw(["checkout", "--force", "HEAD"])` which preserved the stale branch.
- The outer `catch` already used the literal `"main"` for cleanup — no change needed there.

**Layer 3 — better error visibility (`web/src/api.ts:87`):**
- `jsonFetch` was throwing `Error("/gaps/X/patch → 422")` and discarding the response body. The patches route returns a rich `{error, diff, summary, patchPath}` payload on build failure but the React app never saw it.
- Now `jsonFetch` reads the JSON body on `!r.ok`, extracts `error` (or stringifies the body), and throws `Error("422: <real message>")`. The error banner now shows "ReScript build failed — patch rejected. The agent's edits introduced a syntax or type error" instead of an opaque code.

**Layer 4 — baseline build fix (one-time, local-only):**
- `git submodule update --remote shared-code` inside `workspace/hyperswitch-client-core` to fetch shared-code's latest origin/main.
- Committed the new submodule pointer to **local main** as `a78b62a chore(local): bump shared-code submodule to origin/main for build`. **Local-only — never push.** The commit message documents why.
- After the bump, `npm run re:build` from clean main passes in 688 ms (467 modules, exit 0).
- Local main is now one commit ahead of origin/main. `repoManager.ts` uses `git pull --ff-only`, which will fail silently when ahead and leave HEAD as-is — that's the right safety behavior. Our fix persists across `syncAllRepos()` runs.

**State cleanup performed in this iteration:**
- Wiped the `patches` table (2 stale rows from failed runs); `gaps`/`reports`/`gap_prs`/`dismissed_gaps` untouched.
- Deleted 3 stale `.patch` files from `data/patches/`.
- Deleted local feature branches `feat/gap-299-payment-method-order` and `feat/gap-305-hide-card-nickname-field` from the mobile workspace.
- Mobile workspace is now on main with the submodule bump committed.

**Verification:**
- Server `tsc --noEmit` clean.
- Web `tsc -p tsconfig.json --noEmit` clean.
- Mobile baseline `npm run re:build` from clean main → PASS (688 ms, exit 0). Same on cold cache.
- Web baseline (no submodule gymnastics needed there) — already passing.

**Trade-offs the next session should know:**
- **Bash access for the patch agent** widens the agent's blast radius — it can now run arbitrary shell commands cwd'd to the target repo. The workspace is disposable (we can re-clone), and the user explicitly accepted this trade for fewer wasted runs. Don't try to take Bash away.
- **Local main is ahead of origin/main** in `workspace/hyperswitch-client-core`. The chore commit is intentional. Do not `git reset --hard origin/main` or rebase it away — the build will start failing again. If juspay ever fixes their submodule pointer upstream, drop our local commit by checking that origin/main now also has a sane shared-code SHA (`git submodule status` should show no `+` prefix on shared-code).
- **The 5-attempt budget for the agent's build loop** is enforced by prompt only, not hard-stopped. The hard cap is the 1500s timeout. If you see runaway costs, consider injecting an external counter — but the simple version is working for now.
- **Patches route is now ~280 lines.** Most of it is the prompt + the post-build fork/PR/submodule push flow. Don't refactor it speculatively; the order of operations matters (build → commit → submodule push → .gitmodules rewrite → parent push → PR).

**Open follow-ups (future iterations, not done):**
- Submodule-bump self-healing in `repoManager.ts`: detect "PaymentEventTypes missing" pattern after sync and re-bump automatically. Skipped for now — manual fix is good enough for the immediate need.
- Surface `build_status: failed_after_retries` distinctly in the UI when the agent explicitly gives up — currently it just becomes a generic 422 with the build log.
- Two-stage upstream-merge PR orchestration (variant B from iteration 5) — still on the back burner.

<!-- Append new iterations below this line. Never edit history. -->
