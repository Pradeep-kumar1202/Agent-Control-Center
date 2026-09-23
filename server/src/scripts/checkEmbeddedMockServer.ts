import assert from "node:assert/strict";
import { buildPaymentIntentClientResponse } from "../skills/embeddedMockServer.js";

const upstream = {
  sdk_authorization: "sdk_auth_fixture",
  client_secret: "client_secret_fixture",
  payment_id: "pay_fixture",
};

const response = buildPaymentIntentClientResponse(
  upstream,
  "publishable_fixture",
  "profile_fixture",
);

assert.deepEqual(response, {
  publishableKey: "publishable_fixture",
  sdkAuthorization: "sdk_auth_fixture",
  clientSecret: "client_secret_fixture",
  paymentId: "pay_fixture",
  profileId: "profile_fixture",
});

assert.equal(
  buildPaymentIntentClientResponse(upstream, "publishable_fixture", "").profileId,
  null,
  "an absent profile ID must remain JSON null for existing clients",
);

assert.throws(
  () => buildPaymentIntentClientResponse(
    { client_secret: "client_secret_fixture", payment_id: "pay_fixture" },
    "publishable_fixture",
    "profile_fixture",
  ),
  /missing required field sdk_authorization/,
  "an incomplete upstream response must not become HTTP 200-compatible JSON",
);

console.log("embedded mock-server response contract checks passed");
