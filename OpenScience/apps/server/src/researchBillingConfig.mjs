/** Deployment-owned billing policy; no user request can choose a payer or rate. */

/** @param {unknown} value @param {string} name */
function boolean(value, name) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0" || value == null || value === "") return false;
  throw new Error(`${name} must be true or false.`);
}

/**
 * Separate opt-in for revised charging rules: historical invoices retain the
 * original policy, and turning on a user-facing page never starts deductions.
 * @param {Record<string, any>} overrides
 * @param {Record<string, any>} credits
 * @param {Record<string, string | undefined>} [env]
 */
export function researchBillingSettings(overrides, credits, env = process.env) {
  /** @param {string} key @param {string} variable */
  const read = (key, variable) => overrides[key] ?? env[variable] ?? "";
  const enabled = boolean(read("researchBillingEnabled", "OPEN_SCIENCE_RESEARCH_BILLING_ENABLED"), "OPEN_SCIENCE_RESEARCH_BILLING_ENABLED");
  if (enabled && (!credits.evimedCreditsEnabled || credits.evimedCreditsPerCny !== 1)) {
    throw new Error("Research billing requires the EviMed wallet at one credit per CNY.");
  }
  return {
    researchBillingEnabled: enabled,
    researchCommerceEnabled: boolean(read("researchCommerceEnabled", "OPEN_SCIENCE_RESEARCH_COMMERCE_ENABLED"), "OPEN_SCIENCE_RESEARCH_COMMERCE_ENABLED"),
    researchCommerceTrustedOrigins: read("researchCommerceTrustedOrigins", "OPEN_SCIENCE_RESEARCH_COMMERCE_TRUSTED_ORIGINS"),
    researchCommerceRechargeUrl: read("researchCommerceRechargeUrl", "OPEN_SCIENCE_RESEARCH_COMMERCE_RECHARGE_URL"),
    researchCommerceMembershipUrl: read("researchCommerceMembershipUrl", "OPEN_SCIENCE_RESEARCH_COMMERCE_MEMBERSHIP_URL"),
    researchCommerceOrdersUrl: read("researchCommerceOrdersUrl", "OPEN_SCIENCE_RESEARCH_COMMERCE_ORDERS_URL"),
    researchCommerceRefundsUrl: read("researchCommerceRefundsUrl", "OPEN_SCIENCE_RESEARCH_COMMERCE_REFUNDS_URL"),
  };
}
