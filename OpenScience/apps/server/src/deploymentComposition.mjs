/**
 * What this deployment offers a runtime, read from the same facts the runtime
 * is launched from.
 *
 * Hidden knowledge: the tool catalogue (`MCP_TOOL_BASE_NAMES`) says what the
 * source defines; `evimedMcpEnvironment` in `runtimeManager.mjs` decides, per
 * launch, which of those tools a runtime is actually given, by writing
 * `EVIMED_DISABLED_TOOLS` from the deployment's configuration and the account's
 * audience. Discovery that reads only the catalogue reports tools no runtime
 * here will ever have — the stale count the 2026-10-03 review found (40
 * audited against a 47-entry registry, "availability depends on deployment").
 *
 * This is that decision restated as a pure function of `config` and a user, so
 * the product can say "this tool is not offered here, and why" without
 * launching a runtime. A restatement can drift from what it restates, so
 * `test/deploymentComposition.test.mjs` runs the real `dshProfileInput` over a
 * matrix of configurations and requires the two to agree; it is the reason this
 * file may be trusted, and a change to the launch rules that this file does not
 * follow fails there.
 *
 * Two layers, because the launch rules only withhold what a deployment cannot
 * serve at all: `runtime` is the launch's own list (parity-tested), `engine` is
 * the one thing the launch deliberately keeps offering — a managed-job engine
 * whose adapter was never configured still lists its tool, and it answers
 * `adapter_unconfigured` — which the product nevertheless should not call
 * available.
 *
 * @module deploymentComposition
 */

import { MCP_MANAGED_JOB_BASE_NAMES, VCR_CAPABILITIES } from "@evimed/domain";
import { frontierGatewayProviderUrl } from "./frontierGateway.mjs";
import { frontierAudienceAllows } from "./frontierService.mjs";
import { geoGatewayProviderUrl } from "./geoGateway.mjs";
import { geoAudienceAllows } from "./geoService.mjs";
import { GEO_RUNTIME_TOOLS, VCR_ENGINE_TOOLS, VCR_RUNTIME_TOOLS, publicSourceGatewayProviderUrl } from "./runtimeManager.mjs";
import { vcrGatewayProviderUrl } from "./vcrGateway.mjs";
import { vcrAudienceAllows } from "./vcrService.mjs";

/**
 * The six managed-job tools and the adapter each one is served by
 * (`evimedAdapterEnvironment` in `runtimeManager.mjs`, `evimedAdapterUrls` in
 * `config.mjs`). The keys are the domain's own list; a test holds the two equal.
 * @type {Readonly<Record<string, string>>}
 */
export const ENGINE_TOOL_ADAPTER_KEYS = Object.freeze({
  meta_analysis: "metaAnalysis",
  mendelian_randomization: "mendelianRandomization",
  bibliometric_analysis: "bibliometricAnalysis",
  research_topic_selection: "researchTopicSelection",
  peer_review: "peerReview",
  drug_safety_analysis: "drugSafetyAnalysis",
});

/** The 「循证 GEO」 capabilities, by id. The VCR ones are the domain's `VCR_CAPABILITIES`. */
export const GEO_CAPABILITY_IDS = Object.freeze(["geo-insight", "geo-strategy", "geo-content", "geo-proposal"]);

/**
 * The module a capability is opened from, or null for an ordinary one. These
 * capabilities stay public (a bound conversation needs them) but are reachable
 * only from their module, so a module that is off or closed to the account
 * makes the capability itself unavailable rather than merely limited.
 * @param {string} capabilityId @returns {"geo" | "vcr" | null}
 */
export function moduleOfCapability(capabilityId) {
  if (GEO_CAPABILITY_IDS.includes(capabilityId)) return "geo";
  if (VCR_CAPABILITIES.includes(capabilityId)) return "vcr";
  return null;
}

/**
 * Whether a module is on for this account: `on`, `off` for the deployment, or
 * `not-open` when it is on but this account is outside its audience.
 * @param {Record<string, any>} config @param {{ id?: string } | null | undefined} user @param {"frontier" | "geo" | "vcr"} module
 * @returns {"on" | "off" | "not-open"}
 */
export function moduleState(config, user, module) {
  const enabled = module === "frontier" ? config.frontierEnabled : module === "geo" ? config.geoEnabled : config.vcrEnabled;
  if (!enabled) return "off";
  const allows = module === "frontier" ? frontierAudienceAllows : module === "geo" ? geoAudienceAllows : vcrAudienceAllows;
  return allows(config, user) ? "on" : "not-open";
}

/** @param {() => string} read @returns {string} a provider URL, or "" where the launch would refuse it */
function providerUrl(read) {
  try { return read(); } catch { return ""; }
}

/**
 * @typedef {object} DeclinedTool
 * @property {string} why one of operator-disabled, result-engine-missing, web-read-off, module-off, module-not-open,
 *   gateway-unconfigured, no-social-channel, engine-not-composed, adapter-unconfigured, engine-not-configured
 * @property {"runtime" | "engine"} layer
 * @property {"frontier" | "geo" | "vcr"} [module]
 */

/**
 * Whether a managed-job engine has anything to run: an adapter URL, or — in a
 * checkout that runs the sibling engines in place — an engine root.
 * @param {Record<string, any>} config @param {string} tool
 */
function engineConfigured(config, tool) {
  const key = ENGINE_TOOL_ADAPTER_KEYS[tool];
  if (!key) return true;
  if (String(config.evimedAdapterUrls?.[key] ?? "").trim()) return true;
  const root = key === "metaAnalysis" ? config.metaAgentRoot : config.specialistAgents?.[key]?.root;
  return String(root ?? "").trim().length > 0;
}

/**
 * The tools a runtime of this account is NOT given, with why. Mirrors
 * `evimedMcpEnvironment` rule by rule, in its order; see the module comment.
 * @param {Record<string, any>} config @param {{ id?: string } | null | undefined} user
 * @returns {Map<string, DeclinedTool>}
 */
export function declinedTools(config, user) {
  /** @type {Map<string, DeclinedTool>} */
  const declined = new Map();
  /** @param {string} tool @param {string} why @param {"runtime" | "engine"} [layer] @param {"frontier" | "geo" | "vcr"} [module] */
  const decline = (tool, why, layer = "runtime", module) => {
    if (!declined.has(tool)) declined.set(tool, { why, layer, ...(module ? { module } : {}) });
  };
  for (const tool of String(config.evimedDisabledTools ?? "").split(",").map((item) => item.trim()).filter(Boolean)) decline(tool, "operator-disabled");

  // Everything below that rides the public-source gateway's token is offered only
  // where that gateway has an address, which is where the launch gives it one.
  const gateway = providerUrl(() => publicSourceGatewayProviderUrl(config)) !== "";
  const resultEngine = config.resultsEnabled && config.stateStore === "postgres"
    && (String(config.resultEngineUrl ?? "").trim() || (config.vcrEnabled && config.vcrEngineConfigured));
  if (!(gateway && resultEngine)) decline("research_calculate", "result-engine-missing");
  if (config.webReadEnabled === false) decline("web_read", "web-read-off");

  /** @param {"frontier" | "geo" | "vcr"} module @param {string} gatewayUrl @returns {boolean} whether the module's tools are given an address */
  const addressed = (module, gatewayUrl) => gateway && gatewayUrl !== "" && moduleState(config, user, module) === "on";
  /** @param {"frontier" | "geo" | "vcr"} module @param {string} gatewayUrl @returns {string} */
  const whyNot = (module, gatewayUrl) => {
    const state = moduleState(config, user, module);
    if (state === "off") return "module-off";
    if (state === "not-open") return "module-not-open";
    return gateway && gatewayUrl !== "" ? "" : "gateway-unconfigured";
  };

  const frontierUrl = providerUrl(() => frontierGatewayProviderUrl(config));
  if (!addressed("frontier", frontierUrl)) decline("frontier_search", whyNot("frontier", frontierUrl), "runtime", "frontier");

  const geoUrl = providerUrl(() => geoGatewayProviderUrl(config));
  if (!addressed("geo", geoUrl)) {
    for (const tool of GEO_RUNTIME_TOOLS) decline(tool, whyNot("geo", geoUrl), "runtime", "geo");
  } else if (!String(config.geoSocialUrl ?? "").trim()) {
    decline("social_posts_search", "no-social-channel", "runtime", "geo");
  }

  const vcrUrl = providerUrl(() => vcrGatewayProviderUrl(config));
  const vcrEngineComposed = config.vcrEngineConfigured ?? Boolean(String(config.vcrEngineUrl ?? "").trim());
  if (!addressed("vcr", vcrUrl)) {
    for (const tool of VCR_RUNTIME_TOOLS) decline(tool, whyNot("vcr", vcrUrl), "runtime", "vcr");
  } else if (!vcrEngineComposed) {
    for (const tool of VCR_ENGINE_TOOLS) decline(tool, "engine-not-composed", "runtime", "vcr");
  }

  if (!String(config.evimedAdapterUrls?.patentSearch ?? "").trim()) decline("patent_search", "adapter-unconfigured");

  for (const tool of MCP_MANAGED_JOB_BASE_NAMES) {
    if (!engineConfigured(config, tool)) decline(tool, "engine-not-configured", "engine");
  }
  return declined;
}

/**
 * The adapter URL a managed-job engine's own `/health` is read from: the call
 * URL's origin plus `/health` (the specialist adapter answers it on its root,
 * unauthenticated). Null where the engine has no adapter URL — a checkout's
 * in-place engine has no service to ask.
 * @param {Record<string, any>} config @param {string} tool @returns {string | null}
 */
export function engineHealthUrl(config, tool) {
  const key = ENGINE_TOOL_ADAPTER_KEYS[tool];
  const value = String(config.evimedAdapterUrls?.[key] ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return new URL("/health", url.origin).href;
  } catch {
    return null;
  }
}

/**
 * Who this deployment is, for the export's header: the release it was built as
 * and the shape of its runtime. Nothing here is a secret or an address.
 * @param {Record<string, any>} config
 */
export function deploymentIdentity(config) {
  return {
    releaseId: config.releaseManifest?.app?.releaseId ?? null,
    runtimeMode: String(config.runtimeMode ?? "kernel"),
    runtimeProvider: String(config.runtimeProvider ?? "docker"),
  };
}
