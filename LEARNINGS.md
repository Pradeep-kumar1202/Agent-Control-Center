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

<!-- Append new iterations below this line. Never edit history. -->
