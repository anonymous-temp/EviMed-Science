/**
 * The expectation check: what a request looked like it was commissioning.
 *
 * Hidden knowledge: the demotion of routing, and why it is safe.
 *
 * A router used to decide, before the run started, which specialist package a
 * session was bound to — and being wrong meant the whole session was wrong,
 * because a composition cannot be changed once it has produced content. Six
 * real requests for a clinical evidence review went to other pipelines because
 * they mentioned a meta-analysis, an adverse reaction, or a dataset.
 *
 * Under one composition nothing binds. The model plans, delegates and delivers,
 * and contracts attach to the *deliverables* it declares. So the classifier's
 * answer stopped being a decision and became an observation: "a reader of this
 * request would have expected a drug-evaluation report". It is compared against
 * what the run actually delivered, and a mismatch is one more input to the
 * question-by-question check — not a repair round of its own, and never a
 * reason to refuse a delivery.
 *
 * A wrong classification used to cost a whole session. It now costs one line in
 * a report the gate was going to write anyway.
 *
 * @module deliveryExpectation
 */

import { CONTRACT_KINDS, contractKindLabel, isContractKind, matchedClinicalTriggers } from "@evimed/domain";

/**
 * @typedef {object} DeliveryExpectation
 * @property {readonly string[]} contractKinds     what a reader of the request would expect
 * @property {'named'|'classified'|'trigger'|'none'} confidence
 * @property {string} reason
 * @property {readonly string[]} clinicalTriggers  medicines or scenarios the request itself named
 */

/** Nothing expected — the honest answer for "hello" or a bare question. */
export const NO_EXPECTATION = Object.freeze({
  contractKinds: Object.freeze([]),
  confidence: "none",
  reason: "no deliverable was implied by the request",
  clinicalTriggers: Object.freeze([]),
});

/**
 * Builds the expectation for one request.
 *
 * Naming a capability outranks a classification because naming it is an
 * instruction rather than a guess. Everything else is advisory.
 *
 * @param {{
 *   text: string,
 *   capabilities: readonly Record<string, any>[],
 *   classified?: { capabilityId?: string, contractKind?: string, reason?: string } | null,
 * }} input
 * @returns {DeliveryExpectation}
 */
export function buildExpectation({ text, capabilities, classified = null }) {
  const request = String(text ?? "");
  const clinicalTriggers = matchedClinicalTriggers(request);

  const named = namedCapability(request, capabilities);
  if (named) {
    return {
      contractKinds: kindsOf(named),
      confidence: "named",
      reason: `the request names the capability "${named.id}"`,
      clinicalTriggers,
    };
  }

  if (classified?.contractKind && isContractKind(classified.contractKind)) {
    return {
      contractKinds: [classified.contractKind],
      confidence: "classified",
      reason: classified.reason || "a classifier read the request as commissioning this",
      clinicalTriggers,
    };
  }
  if (classified?.capabilityId) {
    const capability = capabilities.find((candidate) => candidate.id === classified.capabilityId);
    if (capability) {
      return {
        contractKinds: kindsOf(capability),
        confidence: "classified",
        reason: classified.reason || `a classifier read the request as commissioning "${capability.id}"`,
        clinicalTriggers,
      };
    }
  }

  // The one thing the old regex net was actually for: a high-risk medicine named
  // in a request has to reach the clinical rules whatever else happens. It no
  // longer routes anything — the content triggers do that job on the output —
  // but recording it here keeps the reason visible in the ledger.
  if (clinicalTriggers.length) {
    return {
      contractKinds: [],
      confidence: "trigger",
      reason: `the request names ${clinicalTriggers.slice(0, 3).join("、")}, so clinical content rules apply to whatever it produces`,
      clinicalTriggers,
    };
  }

  return { ...NO_EXPECTATION, clinicalTriggers };
}

/** @param {Record<string, any>} capability @returns {string[]} */
function kindsOf(capability) {
  return (capability.produces ?? []).map((entry) => String(entry.contractKind)).filter(isContractKind);
}

/**
 * A request that names a capability by id or by title is an instruction.
 * @param {string} text @param {readonly Record<string, any>[]} capabilities
 * @returns {Record<string, any> | null}
 */
export function namedCapability(text, capabilities) {
  const request = String(text ?? "").toLowerCase();
  for (const capability of capabilities) {
    const id = String(capability.id ?? "").toLowerCase();
    const title = String(capability.title ?? "").toLowerCase();
    if (id && request.includes(id)) return capability;
    if (title && title.length >= 6 && request.includes(title)) return capability;
  }
  return null;
}

/**
 * Compares what was expected with what was delivered.
 *
 * The result is a notice, always. It is folded into the question-by-question
 * check the server already performs, where a human reading the report can weigh
 * it — which is the right place for a judgement a classifier made about a
 * sentence.
 *
 * @param {DeliveryExpectation} expectation
 * @param {readonly { contractKind: string, status: string }[]} delivered
 * @returns {{ matched: boolean, notices: string[] }}
 */
export function compareExpectation(expectation, delivered) {
  const accepted = delivered.filter((item) => item.status === "accepted").map((item) => item.contractKind);
  if (!expectation.contractKinds.length) {
    return { matched: true, notices: [] };
  }
  if (!accepted.length) {
    return {
      matched: false,
      notices: [
        `请求看起来是要一份${expectation.contractKinds.map(contractKindLabel).join(" 或 ")}（${expectation.reason}），但本次运行没有交付任何产物。`
        + "若这是一次直接回答，请确认回答本身已覆盖题面的每一问。",
      ],
    };
  }
  const matched = accepted.some((kind) => expectation.contractKinds.includes(kind));
  if (matched) return { matched: true, notices: [] };
  return {
    matched: false,
    notices: [
      `请求看起来是要一份${expectation.contractKinds.map(contractKindLabel).join(" 或 ")}（${expectation.reason}），`
      + `实际交付的是 ${[...new Set(accepted)].map(contractKindLabel).join("、")}。`
      + "这不一定是错的——一次运行可以合理地产出别的东西——但值得在逐问核对时确认题面每一问都被回答了。",
    ],
  };
}

/** Every contract kind an expectation may name, for the classifier's prompt. */
export const EXPECTABLE_CONTRACT_KINDS = CONTRACT_KINDS;
