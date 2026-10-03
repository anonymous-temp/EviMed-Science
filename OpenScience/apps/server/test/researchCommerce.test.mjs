import assert from "node:assert/strict";
import test from "node:test";

import { createResearchCommerce, checkResearchCommerceConformance } from "../src/researchCommerce.mjs";

const configured = {
  researchCommerceEnabled: true,
  researchCommerceTrustedOrigins: ["https://account.evimed.com"],
  researchCommerceRechargeUrl: "https://account.evimed.com/recharge",
  researchCommerceMembershipUrl: "https://account.evimed.com/membership",
  researchCommerceOrdersUrl: "https://account.evimed.com/orders",
  researchCommerceRefundsUrl: "https://account.evimed.com/refunds",
};

test("hosted handoff exposes only trusted deployment URLs and truthful contract status", () => {
  const service = createResearchCommerce(configured);
  assert.deepEqual(service.links(), {
    rechargeUrl: configured.researchCommerceRechargeUrl,
    membershipUrl: configured.researchCommerceMembershipUrl,
    ordersUrl: configured.researchCommerceOrdersUrl,
    refundsUrl: configured.researchCommerceRefundsUrl,
  });
  assert.equal(service.status().currency, "CNY");
  assert.equal(service.status().creditsPerCny, 1);
  assert.equal(service.status().features.recharge.status, "configured");
  assert.equal(service.status().features.recharge.verified, false);
  assert.equal(service.status().upstreamContracts.orderStatus, "not_verified");
  assert.ok(Object.isFrozen(service.links()));
});

test("disabled and unconfigured commerce never expose active URLs", () => {
  const service = createResearchCommerce({ ...configured, researchCommerceEnabled: false });
  assert.equal(service.status().features.recharge.status, "disabled");
  assert.deepEqual(Object.values(service.links()), [null, null, null, null]);
  assert.equal(createResearchCommerce({ researchCommerceEnabled: true }).status().features.recharge.status, "unconfigured");
});

test("unsafe destinations, credentials, token queries, fragments, and origin confusion are refused", () => {
  for (const url of [
    "http://account.evimed.com/recharge", "https://account.evimed.com.evil.com/recharge",
    "https://account.evimed.com@evil.com/recharge", "https://user:test-only-secret@account.evimed.com/recharge",
    "https://account.evimed.com/recharge?token=secret", "https://account.evimed.com/recharge#secret",
    "https://account.evimed.com/recharge?", "https://account.evimed.com/recharge#",
    "https://account.evimed.com:8443/recharge", "https://127.0.0.1/recharge", "https://[::1]/recharge",
    "https://localhost/recharge", "https://account.local/recharge", "https://account.internal/recharge",
    "https://account.evimed.com\\@evil.com/recharge", "javascript:alert(1)",
  ]) {
    const service = createResearchCommerce({ ...configured, researchCommerceRechargeUrl: url });
    assert.equal(service.links().rechargeUrl, null, url);
    assert.equal(service.status().features.recharge.status, "invalid_configuration", url);
    assert.equal(service.links().ordersUrl, configured.researchCommerceOrdersUrl);
  }
});

test("the allowlist requires literal HTTPS origins, and configuration is snapshotted", () => {
  for (const origin of ["*", "https://*.evimed.com", "http://account.evimed.com", "https://account.evimed.com/path",
    "https://account.evimed.com?token=secret", "https://127.0.0.1"]) {
    assert.equal(createResearchCommerce({ ...configured, researchCommerceTrustedOrigins: [origin] }).links().rechargeUrl, null);
  }
  const config = { ...configured, researchCommerceTrustedOrigins: "https://account.evimed.com,https://support.evimed.com" };
  const service = createResearchCommerce(config);
  config.researchCommerceRechargeUrl = "https://evil.com";
  const status = service.status();
  status.features.recharge.status = "disabled";
  assert.equal(service.links().rechargeUrl, configured.researchCommerceRechargeUrl);
  assert.equal(service.status().features.recharge.status, "configured");
});

test("release conformance refuses missing handoffs and unverified automatic commerce", () => {
  assert.equal(checkResearchCommerceConformance(configured, { requiredHandoffs: ["recharge", "membership"] }).ok, true);
  const missing = checkResearchCommerceConformance({ ...configured, researchCommerceRefundsUrl: "" }, { requiredHandoffs: ["refunds"] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.issues, [{ code: "research_commerce_handoff_unavailable", action: "refunds" }]);
  const automatic = checkResearchCommerceConformance(configured, { requireAutomaticCommerce: true });
  assert.equal(automatic.ok, false);
  assert.equal(automatic.issues.length, 6);
  assert.ok(automatic.issues.every((issue) => issue.code === "research_commerce_upstream_contract_unverified"));
});
