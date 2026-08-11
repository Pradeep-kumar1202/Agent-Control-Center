import assert from "node:assert/strict";
import {
  deterministicPortabilityHints,
  parsePortSpec,
  parseTriageResult,
} from "../skills/prPort/index.js";

const dedicatedDiff = [
  "diff --git a/src/BlikCodeInput.res b/src/BlikCodeInput.res",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/BlikCodeInput.res",
  "@@ -0,0 +1,1 @@",
  "+let render = () => React.null",
].join("\n");

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
  notPorting: [{ path: "src/BlikCodeInput.res", why: "Do not recreate the dedicated component" }],
}), "/does/not/need/to/exist", dedicatedDiff);
assert.equal(spec.sourceFiles[0].path, "src/BlikCodeInput.res");
assert.equal(spec.reScriptGotchas.length, 0);

assert.throws(
  () => parsePortSpec(JSON.stringify({
    featureName: "escape",
    changeKind: "bugfix",
    behavior: "bad path",
    sourceFiles: [{ path: "../secret", role: "util", whatChanged: "bad" }],
    implementationSteps: ["bad"],
  }), "/tmp", dedicatedDiff),
  /escapes the source repo/,
);

console.log("pr-port deterministic checks: 9/9 passed");
