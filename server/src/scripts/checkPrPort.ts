import assert from "node:assert/strict";
import { lintAgents } from "../agents/loader.js";
import {
  deterministicPortabilityHints,
  parsePortSpec,
  parseTriageResult,
  resolvePortSpec,
  resolveTriageResult,
  PortSpecRepairFailedError,
  TriageRepairFailedError,
} from "../skills/prPort/index.js";

const dedicatedDiff = [
  "diff --git a/src/BlikCodeInput.res b/src/BlikCodeInput.res",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/BlikCodeInput.res",
  "@@ -0,0 +1,1 @@",
  "+let render = () => React.null",
].join("\n");

assert.deepEqual(lintAgents(), []);

const hints = deterministicPortabilityHints("web", "mobile", dedicatedDiff);
assert.equal(hints.length, 1);
assert.match(hints[0], /backend field metadata/);
assert.deepEqual(deterministicPortabilityHints("mobile", "web", dedicatedDiff), []);

const triage = parseTriageResult(JSON.stringify({
  featureName: "BLIK code entry",
  changeKind: "component",
  portability: "no",
  reasons: ["Mobile renders this backend-driven field generically"],
  portableFiles: [],
  skippedFiles: [{ path: "src/BlikCodeInput.res", why: "No dedicated mobile component" }],
}));
assert.equal(triage.portability, "no");

const contradictoryTriage = JSON.stringify({
  featureName: "Eligibility enhancement",
  changeKind: "api",
  portability: "yes",
  reasons: [],
  portableFiles: [],
  skippedFiles: [],
});
let repairCalls = 0;
const repairedTriage = await resolveTriageResult(contradictoryTriage, async (request) => {
  repairCalls++;
  assert.match(request.validationError, /named no portable files/);
  assert.equal(request.invalidOutput, contradictoryTriage);
  return JSON.stringify({
    featureName: "Eligibility enhancement",
    changeKind: "api",
    portability: "yes",
    reasons: [],
    portableFiles: [{ path: "src/Utilities/EligibilityHelpers.res", why: "Carries the portable eligibility behavior" }],
    skippedFiles: [],
  });
});
assert.equal(repairCalls, 1);
assert.equal(repairedTriage.diagnostics.repaired, true);
assert.equal(repairedTriage.triage.portableFiles.length, 1);

let unexpectedRepair = false;
const validWithoutRepair = await resolveTriageResult(JSON.stringify({
  featureName: "BLIK code entry",
  changeKind: "component",
  portability: "no",
  reasons: ["Mobile renders this backend-driven field generically"],
  portableFiles: [],
  skippedFiles: [{ path: "src/BlikCodeInput.res", why: "No dedicated mobile component" }],
}), async () => {
  unexpectedRepair = true;
  return "";
});
assert.equal(unexpectedRepair, false);
assert.equal(validWithoutRepair.diagnostics.attempted, false);

let failedRepairCalls = 0;
await assert.rejects(
  () => resolveTriageResult(contradictoryTriage, async () => {
    failedRepairCalls++;
    return contradictoryTriage;
  }),
  (err: unknown) => {
    assert.ok(err instanceof TriageRepairFailedError);
    assert.match(err.message, /remained invalid after one repair attempt/);
    assert.equal(err.diagnostics.attempted, true);
    assert.equal(err.diagnostics.repaired, false);
    assert.match(err.diagnostics.initialError ?? "", /named no portable files/);
    assert.match(err.diagnostics.repairError ?? "", /named no portable files/);
    return true;
  },
);
assert.equal(failedRepairCalls, 1);

assert.throws(
  () => parseTriageResult('{"featureName":"x","changeKind":"component","portability":"partial","reasons":[],"portableFiles":[],"skippedFiles":[]}'),
  /must explain/,
);

const spec = parsePortSpec(JSON.stringify({
  featureName: "BLIK code entry",
  changeKind: "component",
  behavior: "Collect a BLIK code before confirmation.",
  sourceFiles: [{ path: "src/BlikCodeInput.res", role: "component", whatChanged: "Added the input" }],
  implementationSteps: ["Map the backend field to the existing generic input"],
  typeDefinition: null,
  configKey: null,
  defaultValue: null,
  reScriptGotchas: [],
  notPorting: [{ path: "src/BlikCodeInput.res", why: "Do not recreate the dedicated component" }],
}), "/does/not/need/to/exist", dedicatedDiff);
assert.equal(spec.sourceFiles[0].path, "src/BlikCodeInput.res");
assert.equal(spec.typeDefinition, undefined);
assert.equal(spec.reScriptGotchas.length, 0);

const externalSkillSpec = JSON.stringify({
  featureName: "Eligibility enhancement",
  changeKind: "api",
  behavior: "Gate confirmation on eligibility.",
  sourceFiles: [{
    path: "/Users/pradeep.kumar/.codex/skills/design-sdk-change/SKILL.md",
    role: "guidance",
    whatChanged: "Loaded external skill guidance",
  }],
  implementationSteps: ["Implement the eligibility behavior"],
  typeDefinition: null,
  configKey: null,
  defaultValue: null,
  reScriptGotchas: [],
  notPorting: [],
});
const validRepairedSpec = JSON.stringify({
  featureName: "Eligibility enhancement",
  changeKind: "api",
  behavior: "Gate confirmation on eligibility.",
  sourceFiles: [{ path: "src/BlikCodeInput.res", role: "component", whatChanged: "Carries the source behavior" }],
  implementationSteps: ["Implement the eligibility behavior"],
  typeDefinition: null,
  configKey: null,
  defaultValue: null,
  reScriptGotchas: [],
  notPorting: [],
});
let specRepairCalls = 0;
const repairedSpec = await resolvePortSpec(
  externalSkillSpec,
  "/does/not/need/to/exist",
  dedicatedDiff,
  async (request) => {
    specRepairCalls++;
    assert.match(request.validationError, /escapes the source repo/);
    assert.equal(request.invalidOutput, externalSkillSpec);
    return validRepairedSpec;
  },
);
assert.equal(specRepairCalls, 1);
assert.equal(repairedSpec.diagnostics.repaired, true);
assert.equal(repairedSpec.spec.sourceFiles[0].path, "src/BlikCodeInput.res");

let unexpectedSpecRepair = false;
const validSpecWithoutRepair = await resolvePortSpec(
  validRepairedSpec,
  "/does/not/need/to/exist",
  dedicatedDiff,
  async () => {
    unexpectedSpecRepair = true;
    return "";
  },
);
assert.equal(unexpectedSpecRepair, false);
assert.equal(validSpecWithoutRepair.diagnostics.attempted, false);

let failedSpecRepairCalls = 0;
await assert.rejects(
  () => resolvePortSpec(
    externalSkillSpec,
    "/does/not/need/to/exist",
    dedicatedDiff,
    async () => {
      failedSpecRepairCalls++;
      return externalSkillSpec;
    },
  ),
  (err: unknown) => {
    assert.ok(err instanceof PortSpecRepairFailedError);
    assert.match(err.message, /remained invalid after one repair attempt/);
    assert.equal(err.diagnostics.attempted, true);
    assert.equal(err.diagnostics.repaired, false);
    assert.match(err.diagnostics.initialError ?? "", /escapes the source repo/);
    assert.match(err.diagnostics.repairError ?? "", /escapes the source repo/);
    return true;
  },
);
assert.equal(failedSpecRepairCalls, 1);

assert.throws(
  () => parsePortSpec(JSON.stringify({
    ...JSON.parse(validRepairedSpec) as Record<string, unknown>,
    notPorting: [{ path: "/Users/pradeep.kumar/.codex/skills/design-sdk-change/SKILL.md", why: "External guidance" }],
  }), "/tmp", dedicatedDiff),
  /notPorting\[0\] escapes the source repo/,
);

assert.throws(
  () => parsePortSpec(JSON.stringify({
    featureName: "escape",
    changeKind: "bugfix",
    behavior: "bad path",
    sourceFiles: [{ path: "../secret", role: "util", whatChanged: "bad" }],
    implementationSteps: ["bad"],
    typeDefinition: null,
    configKey: null,
    defaultValue: null,
    reScriptGotchas: [],
    notPorting: [],
  }), "/tmp", dedicatedDiff),
  /escapes the source repo/,
);

// ─── placeholder triage must never become a verdict ─────────────────────────
//
// Verbatim output from the run that cancelled hyperswitch-web#1593 ("eligibility
// feature enhancement with surcharge calculation", 29 files). The model had not
// finished thinking: it wrote a status line into `featureName` and a note about
// which skill it was consulting into `reasons`. Every structural rule passed —
// `no` requires non-empty `reasons` and no `portableFiles` — so a placeholder
// ended a run over a perfectly portable feature.
const observedPlaceholder = JSON.stringify({
  featureName: "Eligibility check triage in progress",
  changeKind: "component",
  portability: "no",
  reasons: [
    "I’m using the design-sdk-change skill to verify which eligibility, surcharge, and confirm-blocking behaviors belong in hyperswitch-client-core rather than mapping the web file layout mechanically.",
  ],
  portableFiles: [],
  skippedFiles: [],
});
assert.throws(() => parseTriageResult(observedPlaceholder), /states a status|narrates your process/);

assert.throws(
  () => parseTriageResult(JSON.stringify({
    featureName: "Analyzing the surcharge flow",
    changeKind: "api", portability: "partial",
    reasons: ["Surcharge totals are backend-driven"],
    portableFiles: [{ path: "src/A.res", why: "carries the behavior" }], skippedFiles: [],
  })),
  /states a status/,
);

assert.throws(
  () => parseTriageResult(JSON.stringify({
    featureName: "Surcharge calculation", changeKind: "api", portability: "partial",
    reasons: ["Let me check how the mobile SDK handles totals"],
    portableFiles: [{ path: "src/A.res", why: "carries the behavior" }], skippedFiles: [],
  })),
  /narrates your process/,
);

// Domain vocabulary must NOT be mistaken for status noise.
//
// Verbatim from the second #1593 run, which this guard wrongly rejected: a
// "pending eligibility message" is a real UI state, and "surcharge disclosure"
// prose is exactly the finding we want. Rejecting a correct answer is a worse
// failure than the placeholder it was written to catch.
const domainWords = parseTriageResult(JSON.stringify({
  featureName: "Eligibility enhancement with surcharge calculation",
  changeKind: "api",
  portability: "partial",
  reasons: [
    "The pending eligibility message and localized surcharge disclosure are observable behaviors that belong in the mobile SDK",
    "Web-only DOM styling for the disclosure banner is under review and stays behind",
  ],
  portableFiles: [{ path: "src/Utilities/PaymentUtils.res", why: "Surcharge computation is platform-independent" }],
  skippedFiles: [],
}));
assert.equal(domainWords.portability, "partial");
assert.equal(domainWords.reasons.length, 2);

// Declining costs the whole run, so it must be justified file by file.
assert.throws(
  () => parseTriageResult(JSON.stringify({
    featureName: "Web-only checkbox styling", changeKind: "component", portability: "no",
    reasons: ["Pure DOM presentation"], portableFiles: [], skippedFiles: [],
  })),
  /named no skipped files/,
);

// ...and a properly evidenced decline is still accepted.
const evidencedDecline = parseTriageResult(JSON.stringify({
  featureName: "Web checkbox ARIA handling", changeKind: "component", portability: "no",
  reasons: ["Every changed file is DOM/ARIA presentation with no backend contract"],
  portableFiles: [],
  skippedFiles: [{ path: "src/Components/Checkbox.res", why: "Web-specific DOM and ARIA; mobile renders backend-described fields" }],
}));
assert.equal(evidencedDecline.portability, "no");
assert.equal(evidencedDecline.skippedFiles.length, 1);

console.log("pr-port deterministic and repair checks passed");
