import { isIP } from "node:net";
import { SIMULATED_WALLET_PAGES } from "@evimed/domain";

/** @typedef {"recharge" | "membership" | "orders" | "refunds"} CommerceAction */
/** @typedef {"disabled" | "unconfigured" | "invalid_configuration" | "configured"} CommerceStatus */

export const RESEARCH_COMMERCE_ACTIONS = Object.freeze(/** @type {CommerceAction[]} */ (["recharge", "membership", "orders", "refunds"]));

const CONFIG_KEYS = Object.freeze({
  recharge: "researchCommerceRechargeUrl",
  membership: "researchCommerceMembershipUrl",
  orders: "researchCommerceOrdersUrl",
  refunds: "researchCommerceRefundsUrl",
});

/**
 * A hosted page link is not an API contract or proof of a successful purchase.
 * No user information, session credential, amount, or return URL is appended.
 * Queries and fragments are rejected even when supplied by an operator.
 * @param {unknown} value
 * @returns {URL | null}
 */
function trustedHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[?#\\\s]/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
    return url;
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {Set<string>} */
function trustedOrigins(value) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const origins = new Set();
  for (const entry of entries) {
    const url = trustedHttpsUrl(entry);
    // An allowlist entry must be an origin, never a URL path or wildcard.
    if (url && url.pathname === "/") origins.add(url.origin);
  }
  return origins;
}

/**
 * The commerce of a deployment whose wallet is simulated (2026-10-04): the
 * destinations are pages of this platform (`SIMULATED_WALLET_PAGES`), not anyone's
 * checkout, so there is no origin to trust and nothing to configure — and the
 * configured commerce settings are not consulted, because a real checkout beside
 * a simulated wallet is exactly the mix-up the simulation must make impossible.
 * What a simulated wallet does is take a top-up and list its orders, so those two
 * report `simulated`, which is never `configured`: a release check that requires a
 * real handoff is not satisfied by a page that moves no money. Membership and
 * refunds have nothing behind them here (2026-10-07: their pages were a sentence
 * saying so), so they have no link and report `disabled` — the real hosted
 * handoffs of a deployment that is not simulated are untouched.
 */
const SIMULATED_ACTIONS = Object.freeze(["recharge", "orders"]);

function createSimulatedCommerce() {
  const links = Object.freeze({
    rechargeUrl: SIMULATED_WALLET_PAGES.recharge,
    membershipUrl: null,
    ordersUrl: SIMULATED_WALLET_PAGES.orders,
    refundsUrl: null,
  });
  return Object.freeze({
    links() { return links; },
    status() {
      return { enabled: true, currency: "CNY", creditsPerCny: 1, walletAuthority: "simulated", simulated: true,
        mode: "simulated", features: Object.fromEntries(RESEARCH_COMMERCE_ACTIONS.map((action) =>
          [action, { status: SIMULATED_ACTIONS.includes(action) ? "simulated" : "disabled", method: "simulated", verified: false }])),
        upstreamContracts: { checkout: "simulated", membershipEntitlements: "simulated",
          orderStatus: "simulated", refunds: "simulated", holds: "simulated", monetaryPrecision: "simulated" } };
    },
  });
}

/**
 * Resolve deployment-owned links once. This service never calls a provider or
 * creates a local wallet, payment, order, membership, or refund record.
 * @param {Record<string, unknown>} [config]
 */
export function createResearchCommerce(config = {}) {
  if (config.evimedCreditsSimulated === true && config.evimedCreditsEnabled === true) return createSimulatedCommerce();
  const enabled = config.researchCommerceEnabled === true;
  const origins = trustedOrigins(config.researchCommerceTrustedOrigins);
  const features = Object.fromEntries(RESEARCH_COMMERCE_ACTIONS.map((action) => {
    const value = config[CONFIG_KEYS[action]];
    const url = trustedHttpsUrl(value);
    /** @type {CommerceStatus} */
    const status = !enabled ? "disabled" : !value ? "unconfigured"
      : url && origins.has(url.origin) ? "configured" : "invalid_configuration";
    return [action, Object.freeze({ status, method: "hosted_handoff", verified: false,
      url: status === "configured" ? url.href : null })];
  }));
  const links = Object.freeze({
    rechargeUrl: features.recharge.url,
    membershipUrl: features.membership.url,
    ordersUrl: features.orders.url,
    refundsUrl: features.refunds.url,
  });
  return Object.freeze({
    links() { return links; },
    status() {
      return { enabled, currency: "CNY", creditsPerCny: 1, walletAuthority: "evimed",
        mode: "hosted_handoff", features: Object.fromEntries(RESEARCH_COMMERCE_ACTIONS.map((action) =>
          [action, { status: features[action].status, method: "hosted_handoff", verified: false }])),
        upstreamContracts: { checkout: "not_verified", membershipEntitlements: "not_verified",
          orderStatus: "not_verified", refunds: "not_verified", holds: "not_verified", monetaryPrecision: "not_verified" } };
    },
  });
}

/**
 * Release checks distinguish valid hosted links from verified commerce APIs.
 * Automatic commerce remains unavailable until real upstream contracts and
 * conformance evidence are implemented; a configured URL never satisfies it.
 * @param {Record<string, unknown>} config
 * @param {{ requiredHandoffs?: CommerceAction[], requireAutomaticCommerce?: boolean }} [options]
 */
export function checkResearchCommerceConformance(config, { requiredHandoffs = [], requireAutomaticCommerce = false } = {}) {
  const service = createResearchCommerce(config);
  const status = service.status();
  const issues = [];
  for (const action of requiredHandoffs) {
    if (!RESEARCH_COMMERCE_ACTIONS.includes(action) || status.features[action]?.status !== "configured") {
      issues.push({ code: "research_commerce_handoff_unavailable", action });
    }
  }
  if (requireAutomaticCommerce) {
    for (const contract of Object.keys(status.upstreamContracts)) {
      issues.push({ code: "research_commerce_upstream_contract_unverified", contract });
    }
  }
  return { ok: issues.length === 0, mode: status.mode, issues };
}
