import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkResearchBillingReadiness, parseResearchBillingReadinessArgs, researchBillingReadinessConfig } from "../../../scripts/ops/check-research-billing.mjs";

const config = {
  evimedCreditsEnabled: true, researchBillingEnabled: true, evimedCreditsPerCny: 1,
  evimedCreditsUrl: "https://wallet.evimed.com/deduct", evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance",
  researchCommerceEnabled: true, researchCommerceTrustedOrigins: ["https://account.evimed.com"],
  researchCommerceRechargeUrl: "https://account.evimed.com/recharge",
  researchCommerceMembershipUrl: "https://account.evimed.com/membership",
};

test("compatibility checks never imply end-to-end or precision readiness", () => {
  const report = checkResearchBillingReadiness(config, { requireBilling: true, requiredHandoffs: ["recharge", "membership"] });
  assert.equal(report.ok, true);
  assert.equal(report.assessment, "configuration_only");
  assert.equal(report.endToEndVerified, false);
  assert.equal(report.billing.status, "configured_compatibility");
  assert.equal(report.billing.walletContract, "legacy-integer-floor");
  assert.ok(report.waivers.includes("fractional_cny_remainder"));
  assert.ok(report.limitations.includes("exactly_once_settlement_not_checked"));
  assert.ok(!JSON.stringify(report).includes("https://"));
});

test("disabled defaults are a report, while require-billing enforces opt-ins", () => {
  assert.equal(checkResearchBillingReadiness().ok, true);
  assert.equal(checkResearchBillingReadiness().billing.status, "disabled");
  const required = checkResearchBillingReadiness({}, { requireBilling: true });
  assert.equal(required.ok, false);
  assert.ok(required.issues.some(issue => issue.code === "research_billing_wallet_disabled"));
  assert.ok(required.issues.some(issue => issue.code === "research_billing_policy_disabled"));
});

test("conversion must be exactly one and endpoints safe HTTPS", () => {
  for (const rate of [0, 2, true, "1", Number.NaN]) {
    const report = checkResearchBillingReadiness({ ...config, evimedCreditsPerCny: rate }, { requireBilling: true });
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(issue => issue.code === "research_billing_conversion_invalid"));
  }
  for (const url of ["", "http://wallet.evimed.com/deduct", "http://127.0.0.1/deduct", "https://user:test-only-secret@wallet.evimed.com/deduct",
    "https://wallet.evimed.com/deduct?token=secret", "https://wallet.evimed.com/deduct#secret", "https://127.0.0.1/deduct", "https://wallet.local/deduct"]) {
    const report = checkResearchBillingReadiness({ ...config, evimedCreditsUrl: url }, { requireBilling: true });
    assert.equal(report.ok, false, url);
    assert.ok(report.issues.some(issue => issue.code === "research_billing_deduct_endpoint_invalid"));
    assert.ok(!JSON.stringify(report).includes("secret"));
  }
});

test("untrusted handoffs fail and fabricated precision/checkout flags never pass", () => {
  assert.equal(checkResearchBillingReadiness({ ...config, researchCommerceRechargeUrl: "https://evil.com/recharge" },
    { requiredHandoffs: ["recharge"] }).ok, false);
  const fabricated = { ...config, walletContract: "precision-v1", precisionVerified: true, automaticCommerceVerified: true };
  const precision = checkResearchBillingReadiness(fabricated, { requirePrecision: true });
  assert.equal(precision.ok, false);
  assert.ok(precision.issues.some(issue => issue.code === "research_billing_precision_contract_unverified"));
  const automatic = checkResearchBillingReadiness(fabricated, { requireAutomaticCommerce: true });
  assert.equal(automatic.ok, false);
  assert.ok(automatic.issues.some(issue => issue.contract === "refunds"));
});

test("argument parser rejects malformed, duplicate, and unknown requirements", () => {
  assert.deepEqual(parseResearchBillingReadinessArgs(["--require-billing", "--require-handoffs=recharge,membership"]).requiredHandoffs,
    ["recharge", "membership"]);
  for (const args of [["--require-billing=false"], ["--require-handoffs="], ["--require-handoffs=recharge,recharge"],
    ["--require-handoffs=unknown"], ["--require-handoffs", "recharge"], ["--require-billing", "--require-billing"], ["--unknown=secret"]]) {
    assert.throws(() => parseResearchBillingReadinessArgs(args), /arguments_invalid/);
  }
});

test("environment mapping never requests credentials and rejects bad boolean settings", () => {
  const env = new Proxy({ OPEN_SCIENCE_EVIMED_CREDITS_PER_CNY: "1", OPEN_SCIENCE_RESEARCH_BILLING_ENABLED: "true" }, {
    get(target, key) {
      assert.ok(!/(API_KEY|TOKEN|SECRET|PASSWORD)/.test(String(key)));
      return target[key];
    },
  });
  assert.equal(researchBillingReadinessConfig(env).evimedCreditsPerCny, 1);
  assert.equal(researchBillingReadinessConfig(env).researchBillingEnabled, true);
  assert.throws(() => researchBillingReadinessConfig({ OPEN_SCIENCE_RESEARCH_BILLING_ENABLED: "secret-invalid-value" }), /configuration_invalid/);
});

test("CLI emits sanitized JSON and distinct failure exit codes without secret access", () => {
  const script = fileURLToPath(new URL("../../../scripts/ops/check-research-billing.mjs", import.meta.url));
  const env = { PATH: process.env.PATH, OPEN_SCIENCE_EVIMED_API_KEY_FILE: "/nonexistent/secret-file",
    OPEN_SCIENCE_EVIMED_API_KEY: "secret-value" };
  const defaultResult = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(defaultResult.status, 0);
  assert.equal(JSON.parse(defaultResult.stdout).endToEndVerified, false);
  const required = spawnSync(process.execPath, [script, "--require-billing"], { env, encoding: "utf8" });
  assert.equal(required.status, 1);
  const malformed = spawnSync(process.execPath, [script, "--token=secret-value"], { env, encoding: "utf8" });
  assert.equal(malformed.status, 2);
  assert.equal(JSON.parse(malformed.stderr).code, "research_billing_check_input_invalid");
  for (const result of [defaultResult, required, malformed]) assert.ok(!`${result.stdout}${result.stderr}`.includes("secret"));
});
