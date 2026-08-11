import assert from "node:assert/strict";
import { forkSlug } from "../skills/githubPr.js";
import { getBranchDiff } from "../skills/prDiff.js";
import {
  parsePrUrl,
  repoKeyForFullSlug,
  resolvePortDirection,
} from "../skills/prUrl.js";

const web = resolvePortDirection("https://github.com/juspay/hyperswitch-web/pull/123/files?x=1#diff");
assert.equal(web.pr.url, "https://github.com/juspay/hyperswitch-web/pull/123");
assert.equal(web.source, "web");
assert.equal(web.target, "mobile");

const mobile = resolvePortDirection("http://www.github.com/juspay/hyperswitch-client-core/pull/9");
assert.equal(mobile.source, "mobile");
assert.equal(mobile.target, "web");

assert.equal(repoKeyForFullSlug(forkSlug("web")), "web");
assert.equal(repoKeyForFullSlug(forkSlug("mobile")), "mobile");
assert.equal(repoKeyForFullSlug("someone/unrelated"), null);
assert.equal(parsePrUrl("https://gitlab.com/juspay/hyperswitch-web/pull/1"), null);
assert.equal(parsePrUrl("https://github.com/juspay/hyperswitch-web/issues/1"), null);

assert.throws(
  () => resolvePortDirection("https://github.com/someone/unrelated/pull/1"),
  /not recognised/,
);
await assert.rejects(
  () => getBranchDiff(".", "https://www.github.com/juspay/hyperswitch-client-core/pull/416", "main", "web"),
  /belongs to mobile, but the selected workspace repo is web/,
);

console.log("prUrl checks: 11/11 passed");
