/**
 * Deterministic checks for the gap-analysis surface parsers.
 *
 *   npm run check:surface -w server
 *
 * Runs on small synthetic SDK trees in a temp dir, so it needs no workspace
 * clone and no network. Each check targets a failure we have actually had or
 * that the design exists to prevent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractBackendApiSurface, normalisePath } from "../analyzer/surface/backendApi.js";
import { extractConfigSurface } from "../analyzer/surface/config.js";
import { extractPaymentFlowSurface, stripLineComments } from "../analyzer/surface/paymentFlows.js";
import { canonicalName, diffSurface, SurfaceParseError } from "../analyzer/surface/index.js";
import { checkPatchable } from "../analyzer/patchGate.js";
import type { GapRow } from "../db.js";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failed++;
}
function throws(fn: () => unknown, match: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof SurfaceParseError && match.test((err as Error).message);
  }
}

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-check-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const keys = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const webPaymentType = (extra: string[] = []) => `
let allowedPaymentElementOptions = [
${[...keys(20, "opt"), ...extra].map((k) => `  "${k}",`).join("\n")}
]

let itemToObjMapper = (dict, logger) => {
  unknownKeysWarning(allowedPaymentElementOptions, dict, "options")
  {
    readOnly: getBoolWithWarning(dict, "readOnly", false, ~logger),
    sdkHandleConfirmPayment: dict
    ->getDictFromDict("sdkHandleConfirmPayment")
    ->getSdkHandleConfirmPaymentProps,
    nested: getDictFromDict(other, "notTopLevel"),
  }
}

let later = 1
`;
const webCardTheme = `
let itemToObjMapper = (dict, default, defaultRules, logger) => {
  unknownKeysWarning(["appearance", "locale", "clientSecret"], dict, "elements")
  {locale: getWarningString(dict, "locale", "auto", ~logger)}
}
`;
const mobileSdkTypes = (extra = "") => `
let parseConfigurationDict = (configObj: Dict.t<JSON.t>, displayPayButton) => {
  let placeholderDict = configObj->Dict.get("placeholder")->Option.getOr(Dict.make())
  {
${keys(15, "m").map((k) => `    ${k}: getBool(configObj, "${k}", false),`).join("\n")}
    merchantDisplayName: getString(configObj, "merchantDisplayName", ""),
    cardNumber: getOptionString(placeholderDict, "cardNumber"),
    readOnly: getBool(
      configObj,
      "readOnly",
      false,
    ),${extra}
  }
}

let parseSdkState = str => str
`;
const mobileLayout = `
let parseLayout = (configObj: Dict.t<JSON.t>) => configObj->Dict.get("paymentMethodLayout")
`;

console.log("surface parser checks");

// ── config parsing ─────────────────────────────────────────────────────────
{
  const web = tree({ "src/Types/PaymentType.res": webPaymentType(), "src/CardTheme.res": webCardTheme });
  const items = extractConfigSurface("web", web);
  const k = new Set(items.map((i) => i.key));
  check("web: allowlist keys are read", k.has("opt0") && k.has("opt19"));
  check("web: decoder keys are read (getX(dict, …) and dict->getX(…) across lines)", k.has("readOnly") && k.has("sdkHandleConfirmPayment"));
  check("web: keys read from other variables are ignored", !k.has("notTopLevel"));
  check("web: elements-level options are read", k.has("locale") && k.has("appearance"));
  const ro = items.find((i) => i.key === "readOnly")!;
  const expectedLine = webPaymentType().split("\n").findIndex((l) => l.includes('"readOnly", false')) + 1;
  check("evidence points at the declaring line", ro.line === expectedLine && ro.snippet.includes('"readOnly"'), `${ro.line} vs ${expectedLine}: ${ro.snippet}`);

  const mobile = tree({ "src/types/SdkTypes.res": mobileSdkTypes(), "src/types/LayoutTypes.res": mobileLayout });
  const m = new Set(extractConfigSurface("mobile", mobile).map((i) => i.key));
  check("mobile: multi-line getBool(\\n configObj,\\n \"key\") is read", m.has("readOnly"));
  check("mobile: nested dict reads (placeholderDict) are not top-level keys", !m.has("cardNumber") && m.has("placeholder"));
  check("mobile: parseLayout keys are read", m.has("paymentMethodLayout"));
}

// ── fail closed ────────────────────────────────────────────────────────────
{
  const renamed = tree({
    "src/Types/PaymentType.res": webPaymentType().replace("let itemToObjMapper", "let itemToObjMapperV2"),
    "src/CardTheme.res": webCardTheme,
  });
  check(
    "a renamed decoder fails the run instead of yielding an empty side",
    throws(() => extractConfigSurface("web", renamed), /itemToObjMapper.*not found/),
  );
  const missing = tree({ "src/CardTheme.res": webCardTheme });
  check("a missing declaration file fails the run", throws(() => extractConfigSurface("web", missing), /not found/));
  const thin = tree({
    "src/types/SdkTypes.res": "let parseConfigurationDict = (configObj, x) => {a: getBool(configObj, \"a\", false)}\n",
    "src/types/LayoutTypes.res": mobileLayout,
  });
  check("a surface far below its expected size fails the run", throws(() => extractConfigSurface("mobile", thin), /expected at least/));
}

// ── backend endpoints ──────────────────────────────────────────────────────
{
  check("interpolations become {}", normalisePath("/payments/${paymentIntentId}/confirm") === "payments/{}/confirm");
  check("named placeholders become {}", normalisePath("/v1/x/{id}/y") === "v1/x/{}/y");
  check("query strings and id+query adjacency collapse", normalisePath("/payments/${id}${query}?a=1") === "payments/{}");
  check("non-path literals are rejected", normalisePath("/${x}") === null);

  const web = tree({
    "src/Utilities/APIHelpers/APIUtils.res": `
let generate = () => {
  let path = switch apiCallType {
  | A => "payments/session_tokens"
  | B => \`payments/\${id}/calculate_tax\`
  | C => "payment_methods"
  | D => \`poll/status/\${id}\`
  | E => "v1/sdk/configs/web/sdk_config.json"
  | F => "payment_methods/auth/link"
  | G => "payment_methods/auth/exchange"
  | H => \`payouts/\${id}/confirm\`
  | I => \`payments/\${id}/eligibility\`
  | J => \`payments/\${id}/client\`
  }
}
`,
    "src/Utilities/PaymentHelpers.res": `
let a = \`\${endpoint}/payments/\${id}/confirm\`
let css = \`\${baseUrl}/app.css\`
let notUrl = \`\${name}/payments/x\`
`,
  });
  const k = new Set(extractBackendApiSurface("web", web).map((i) => i.key));
  check("web registry entries are read", k.has("payments/{}/calculate_tax") && k.has("payment_methods"));
  check("inline URL literals are read", k.has("payments/{}/confirm"));
  check("static assets are not endpoints", !k.has("app.css"));
  check("literals not rooted at a url/endpoint variable are ignored", !k.has("payments/x"));
}


// ── payment flows (next_action handling) ───────────────────────────────────
{
  const mobile = tree({
    "src/hooks/AllPaymentHooks.res": `
let handleApiRes = (~nextAction) => {
  switch nextAction->PaymentUtils.getActionType {
  | "three_ds_invoke" => a()
  | "third_party_sdk_session_token" => b()
  | "redirect_to_url" if redirectUrl !== "" => c()
  | _ => d()
  }
}
`,
    "src/headless/HeadlessCommon.res": `
let f = nextAction =>
  switch nextAction->PaymentUtils.getActionType {
  // | "qr_code_information" => handleQr(~nextAction)
  /*
  | "display_voucher_information" => v()
  */
  | "invoke_ddc" => e()
  | _ => ()
  }
`,
  });
  const m = extractPaymentFlowSurface("mobile", mobile);
  const mk = new Set(m.map((i) => i.key));
  check("switch arms on the next_action type are read (incl. guarded arms)", mk.has("next_action/three_ds_invoke") && mk.has("next_action/redirect_to_url") && mk.has("next_action/invoke_ddc"));
  check("commented-out arms (// and /* */) do not count as handled", !mk.has("next_action/qr_code_information") && !mk.has("next_action/display_voucher_information"));
  const ddc = m.find((i) => i.key === "next_action/invoke_ddc")!;
  check("comment stripping preserves line numbers", ddc.line === 8 && ddc.snippet.startsWith('| "invoke_ddc"'), `${ddc.line}: ${ddc.snippet}`);

  const web = tree({
    "src/Utilities/PaymentHelpers.res": `
if intent.nextAction.type_ == "redirect_to_url" { a() }
else if intent.nextAction.type_ === "qr_code_information" { b() }
else if "display_voucher_information" === nextActionType { c() }
// else if intent.nextAction.type_ === "invoke_hidden_iframe" { d() }
let url = "https://example.com/next" // a URL is not a comment
`,
  });
  const wk = new Set(extractPaymentFlowSurface("web", web).map((i) => i.key));
  check("==/=== comparisons are read in both operand orders", wk.has("next_action/redirect_to_url") && wk.has("next_action/qr_code_information") && wk.has("next_action/display_voucher_information"));
  check("a commented-out comparison does not count as handled", !wk.has("next_action/invoke_hidden_iframe"));
  check("stripping leaves URLs in strings intact", stripLineComments('let u = "https://x.io/a"').includes("https://x.io/a"));
}


// ── patch gate ─────────────────────────────────────────────────────────────
{
  const flows = (mobileArms: string[]) => ({
    web: tree({
      "src/Utilities/PaymentHelpers.res": ["redirect_to_url", "qr_code_information", "three_ds_invoke", "invoke_ddc"]
        .map((t) => `if intent.nextAction.type_ === "${t}" { x() }`)
        .join("\n"),
    }),
    mobile: tree({
      "src/hooks/AllPaymentHooks.res": `switch nextAction->PaymentUtils.getActionType {\n${mobileArms.map((t) => `  | "${t}" => x()`).join("\n")}\n  | _ => ()\n}\n`,
    }),
  });
  const row = (over: Partial<GapRow>): GapRow => ({
    id: 1, report_id: 1, category: "payment_method", canonical_name: "next_action/qr_code_information",
    missing_in: "mobile", present_in: "web", rationale: "r", severity: "medium", platform_specific: 0, verified: 1,
    evidence: JSON.stringify([{ name: "next_action/qr_code_information", file: "f", line: 1, snippet: "s" }]),
    ...over,
  });
  const open = flows(["redirect_to_url", "three_ds_invoke", "invoke_ddc"]);
  const r1 = checkPatchable(row({ verified: 0 }), open);
  check("an unverified gap cannot be patched", !r1.ok && r1.code === "GAP_NOT_VERIFIED");
  const r2 = checkPatchable(row({ platform_specific: 1 }), open);
  check("a platform-specific gap cannot be patched", !r2.ok && r2.code === "GAP_PLATFORM_SPECIFIC");
  check("a verified gap that still exists can be patched", checkPatchable(row({}), open).ok);
  const closed = flows(["redirect_to_url", "three_ds_invoke", "invoke_ddc", "qr_code_information"]);
  const r3 = checkPatchable(row({}), closed);
  check(
    "a gap closed upstream is refused, citing where it now lives",
    !r3.ok && r3.code === "GAP_CLOSED" && r3.error.includes("src/hooks/AllPaymentHooks.res:"),
    r3.ok ? "ok" : r3.error,
  );
}

// ── comparison ─────────────────────────────────────────────────────────────
{
  const item = (key: string, file = "f.res", line = 1) => ({ key, file, line, snippet: key });
  const dirs = { web: tree({}), mobile: tree({ "src/hooks/NetceteraThreeDsHooks.res": "let uri = threeDsData.threeDsAuthenticationUrl" }) };

  const d = diffSurface(
    "config",
    {
      web: [item("business"), item("readOnly"), item("loader"), item("clientSecret"), item("hideCardNicknameField")],
      mobile: [item("merchantDisplayName"), item("hide_card_nickname_field"), item("stickyPayButton")],
    },
    dirs,
  );
  const gap = (k: string) => d.gaps.find((g) => g.key === k);
  check("an equivalence suppresses the renamed pair", !gap("business") && !gap("merchantDisplayName"));
  check("names compare case/separator-insensitively", !gap("hideCardNicknameField"));
  check("an unmatched key is a gap with its declared identity", gap("readOnly")?.canonicalName === "read_only" && gap("readOnly")?.missingIn === "mobile");
  check("a platform-scoped key stays visible, flagged", gap("loader")?.platformSpecific === true);
  check("a not-surface key is excluded, with its reason", !gap("clientSecret") && d.excluded.some((e) => e.key === "clientSecret"));
  check(
    "a stale equivalence row is reported",
    d.tableWarnings.some((w) => w.includes("paymentSheetHeaderLabel") && w.includes("no longer declared in mobile")),
  );

  const api = diffSurface("backend_api", { web: [item("payments/{}/3ds/authentication")], mobile: [item("health")] }, dirs);
  check("implicit presence holds when its evidence is in the code", !api.gaps.some((g) => g.key === "payments/{}/3ds/authentication"));
  const noEvidence = diffSurface("backend_api", { web: [item("payments/{}/3ds/authentication")], mobile: [] }, { web: dirs.web, mobile: tree({}) });
  check(
    "implicit presence without evidence becomes a gap and a table warning",
    noEvidence.gaps.some((g) => g.key === "payments/{}/3ds/authentication") &&
      noEvidence.tableWarnings.some((w) => w.includes("threeDsAuthenticationUrl")),
  );

  check("canonical names: camelCase → snake_case", canonicalName("config", "netceteraSDKApiKey") === "netcetera_sdk_api_key");
  check("canonical names: API paths unchanged", canonicalName("backend_api", "payments/{}/confirm") === "payments/{}/confirm");
}

if (failed > 0) {
  console.error(`\n${failed} surface check(s) failed.`);
  process.exit(1);
}
console.log("All surface checks passed.");
