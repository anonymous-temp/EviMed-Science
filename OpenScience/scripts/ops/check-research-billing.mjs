#!/usr/bin/env node
// Configuration evidence only: never contact a wallet or read a secret file.
import { pathToFileURL } from "node:url";
import { createResearchCommerce, checkResearchCommerceConformance, RESEARCH_COMMERCE_ACTIONS } from "../../apps/server/src/researchCommerce.mjs";

/** @param {unknown} value */
function safeWalletEndpoint(value) {
  if (typeof value !== "string") return false;
  try {
    const origin = new URL(value).origin;
    return createResearchCommerce({ researchCommerceEnabled: true, researchCommerceTrustedOrigins: [origin],
      researchCommerceRechargeUrl: value }).links().rechargeUrl !== null;
  } catch { return false; }
}

/**
 * A passing configuration check is not authorization to release payments and
 * never proves provider connectivity, user mapping, or exactly-once charging.
 * @param {Record<string, unknown>} [config]
 * @param {{requireBilling?:boolean, requiredHandoffs?:Array<"recharge"|"membership"|"orders"|"refunds">,
 * requirePrecision?:boolean, requireAutomaticCommerce?:boolean}} [options]
 */
export function checkResearchBillingReadiness(config = {}, options = {}) {
  const { requireBilling = false, requiredHandoffs = [], requirePrecision = false, requireAutomaticCommerce = false } = options;
  const policyEnabled = config.researchBillingEnabled === true;
  const walletEnabled = config.evimedCreditsEnabled === true;
  const conversionConfigured = config.evimedCreditsPerCny === 1;
  const deductConfigured = safeWalletEndpoint(config.evimedCreditsUrl);
  const balanceConfigured = safeWalletEndpoint(config.evimedCreditsBalanceUrl);
  const issues = [];
  if (requireBilling || policyEnabled) {
    if (!walletEnabled) issues.push({ code: "research_billing_wallet_disabled" });
    if (!policyEnabled) issues.push({ code: "research_billing_policy_disabled" });
    if (!conversionConfigured) issues.push({ code: "research_billing_conversion_invalid" });
    if (!deductConfigured) issues.push({ code: "research_billing_deduct_endpoint_invalid" });
    if (!balanceConfigured) issues.push({ code: "research_billing_balance_endpoint_invalid" });
  }
  if (requirePrecision) issues.push({ code: "research_billing_precision_contract_unverified" });
  const commerce = createResearchCommerce(config).status();
  issues.push(...checkResearchCommerceConformance(config, { requiredHandoffs, requireAutomaticCommerce }).issues);
  return {
    ok: issues.length === 0,
    assessment: "configuration_only",
    endToEndVerified: false,
    billing: { status: !policyEnabled ? "disabled" : walletEnabled && conversionConfigured && deductConfigured && balanceConfigured
      ? "configured_compatibility" : "invalid_configuration",
      policyEnabled, walletEnabled, conversionConfigured, deductConfigured, balanceConfigured,
      currency: "CNY", creditsPerCny: 1, walletAuthority: "evimed",
      walletContract: "legacy-integer-floor", credentialReadiness: "not_checked" },
    commerce,
    waivers: ["platform_overhead", "unconfirmed_provider_usage", "failed_platform_task", "canceled_task", "fractional_cny_remainder"],
    limitations: ["integer_wallet_amounts_only", "precision_contract_unverified", "credentials_not_checked",
      "connectivity_not_checked", "user_identity_mapping_not_checked", "exactly_once_settlement_not_checked",
      "holds_not_supported", "membership_entitlements_not_supported", "checkout_not_supported", "refunds_not_supported"],
    issues,
  };
}

/** Only public deployment settings, not credentials or secret paths.
 * @param {Record<string,string|undefined>} env */
export function researchBillingReadinessConfig(env) {
  /** @param {string} key */
  const bool = (key) => {
    const value = env[key];
    if (value == null || value === "" || value === "false" || value === "0") return false;
    if (value === "true" || value === "1") return true;
    throw new Error("research_billing_configuration_invalid");
  };
  const rate = env.OPEN_SCIENCE_EVIMED_CREDITS_PER_CNY;
  return {
    evimedCreditsEnabled: bool("OPEN_SCIENCE_EVIMED_CREDITS_ENABLED"),
    researchBillingEnabled: bool("OPEN_SCIENCE_RESEARCH_BILLING_ENABLED"),
    evimedCreditsPerCny: rate == null || rate === "" ? 1 : Number(rate),
    evimedCreditsUrl: env.OPEN_SCIENCE_EVIMED_CREDITS_URL ?? "",
    evimedCreditsBalanceUrl: env.OPEN_SCIENCE_EVIMED_CREDITS_BALANCE_URL ?? "",
    researchCommerceEnabled: bool("OPEN_SCIENCE_RESEARCH_COMMERCE_ENABLED"),
    researchCommerceTrustedOrigins: env.OPEN_SCIENCE_RESEARCH_COMMERCE_TRUSTED_ORIGINS ?? "",
    researchCommerceRechargeUrl: env.OPEN_SCIENCE_RESEARCH_COMMERCE_RECHARGE_URL ?? "",
    researchCommerceMembershipUrl: env.OPEN_SCIENCE_RESEARCH_COMMERCE_MEMBERSHIP_URL ?? "",
    researchCommerceOrdersUrl: env.OPEN_SCIENCE_RESEARCH_COMMERCE_ORDERS_URL ?? "",
    researchCommerceRefundsUrl: env.OPEN_SCIENCE_RESEARCH_COMMERCE_REFUNDS_URL ?? "",
  };
}

/** @param {string[]} args */
export function parseResearchBillingReadinessArgs(args) {
  const options = { requireBilling: false, requirePrecision: false, requireAutomaticCommerce: false,
    requiredHandoffs: /** @type {Array<"recharge"|"membership"|"orders"|"refunds">} */ ([]), help: false };
  const seen = new Set();
  for (const argument of args) {
    const name = argument.split("=")[0];
    if (seen.has(name)) throw new Error("research_billing_check_arguments_invalid");
    seen.add(name);
    if (argument === "--require-billing") options.requireBilling = true;
    else if (argument === "--require-precision") options.requirePrecision = true;
    else if (argument === "--require-automatic-commerce") options.requireAutomaticCommerce = true;
    else if (argument === "--help") options.help = true;
    else if (argument.startsWith("--require-handoffs=")) {
      const actions = argument.slice("--require-handoffs=".length).split(",");
      if (!actions.length || new Set(actions).size !== actions.length
        || actions.some(action => !RESEARCH_COMMERCE_ACTIONS.includes(/** @type {any} */ (action)))) {
        throw new Error("research_billing_check_arguments_invalid");
      }
      options.requiredHandoffs = /** @type {typeof options.requiredHandoffs} */ (actions);
    } else throw new Error("research_billing_check_arguments_invalid");
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseResearchBillingReadinessArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/ops/check-research-billing.mjs [--require-billing] [--require-handoffs=recharge,membership,orders,refunds] [--require-precision] [--require-automatic-commerce]\nChecks public configuration only; never proves end-to-end payment readiness.");
    } else {
      const report = checkResearchBillingReadiness(researchBillingReadinessConfig(process.env), options);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
    }
  } catch {
    // Never serialize supplied arguments, endpoint URLs, or environment values.
    console.error(JSON.stringify({ ok: false, code: "research_billing_check_input_invalid" }));
    process.exitCode = 2;
  }
}
