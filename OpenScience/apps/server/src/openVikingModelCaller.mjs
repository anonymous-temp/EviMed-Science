import { createHash, timingSafeEqual } from "node:crypto";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { OPENVIKING_PROJECT_ID } from "./internalProjects.mjs";
import { openVikingKnowledgeModelKey } from "./openVikingLayout.mjs";
import { HttpError } from "./security.mjs";

/**
 * The OpenViking service as a caller of the model gateway.
 *
 * Hidden knowledge:
 *
 *  - **Why the engine calls us and not the provider.** From v0.5.0 the engine uses a language model of its own
 *    accord: it extracts memories when a session is committed, summarizes what is written back, and its Compile
 *    agent runs tens of rounds per task. Pointed at the provider, that is a provider key in a third-party
 *    container and spend no ledger sees. Pointed here, the key stays in this process and every call is reserved,
 *    settled and reported like any other (owner decision, 2026-10-12).
 *  - **Who the caller is.** Nothing in such a request names a user, an account, a session or a task — the
 *    engine's client sends a bearer and a body (recorded on the wire, both labs). The bearer is therefore the
 *    whole identity: a static service key from a file, compared in constant time. It is reachable only where
 *    this process listens for its internal gateways, and the engine is the only other holder (inside its
 *    `ov.conf`, readable by its uid alone).
 *  - **What a call is for.** Also only the bearer can say. The engine's root `vlm` (extraction and summaries)
 *    carries the service key itself and is booked `memory-extraction`; its Compile agent carries the key derived
 *    from it (`openVikingKnowledgeModelKey`) and is booked `knowledge`.
 *  - **Whose money.** The platform's: booked to the publisher account's internal project `evimed-openviking`, so
 *    no researcher's caps or bill ever see it, and held by one budget of its own per rolling day
 *    (`OPEN_SCIENCE_OPENVIKING_MODEL_DAILY_BUDGET_CNY`, counted from the ledger, never from a counter here: a
 *    restart loses nothing).
 *  - **A spent budget answers 402 with the body code `insufficient_quota`, and both are a choice.** What ends the
 *    attempt is the engine's own error classifier (`openviking/models/model_error.py`), and it changed between the
 *    two pins. v0.5.0 retried only what `classify_api_error` called transient, so any 4xx ended the commit or the
 *    compile round at once. From v0.5.1 an error whose status has no mapping (402 has none) and whose body names
 *    no known code is `UNKNOWN`, and `UNKNOWN` gets the full retry limit with back-off; only a body code the
 *    classifier knows (`insufficient_quota`, read from `error.code`, the shape `modelGateway.mjs` already writes)
 *    is `QUOTA_EXHAUSTED` and is not retried. A 429 or 5xx would be retried sixteen times in thirty seconds by
 *    every waiting commit and still fail (lab/memory/RESULTS.md §E-3), so the honest answer to "no money today"
 *    is the one that ends the attempt at once, on either version. What that costs is real — a refused extraction
 *    commit is archived as failed and extracted only if the control plane replays it — which is why the default
 *    budget is generous. Readiness and the metrics keep naming the condition `openviking_model_budget_exhausted`.
 *  - **Thinking off unless asked.** The gateway gives a request that names no reasoning the deployment's default,
 *    `high`. For this caller that is four times the cost and five times the latency of an extraction for nothing
 *    measurable, and nine times the cost of a write-back's summaries. So a request that does not say is held to
 *    off; one that does say is honoured.
 *  - **Its own body limit.** A Compile round resends its whole context: up to 240,000 characters of pages, tool
 *    calls and sources, about 0.7 MB of Chinese before JSON escaping. Four MiB is that with room and nothing more.
 *
 * Build to delete: the purpose split by derived key goes when the engine labels its own requests; the whole
 * module goes if the engine ever accepts per-user credentials the gateway already issues.
 *
 * @module openVikingModelCaller
 */

/** The purposes an engine call is booked under, and which bearer says so. */
export const OPENVIKING_MODEL_PURPOSES = Object.freeze(["memory-extraction", "knowledge"]);

/** The largest request body this caller may send. */
export const OPENVIKING_MODEL_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The body code of the spent-budget refusal: the one the engine's classifier maps to quota exhaustion and never retries. */
export const OPENVIKING_QUOTA_CODE = "insufficient_quota";

/** What the ledger's `module` column reads for these rows. */
export const OPENVIKING_USAGE_MODULE = "openviking";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A service key shorter than this is a placeholder, not a credential (`configure:production-state` writes 48 characters). */
const MIN_KEY_LENGTH = 24;
const digest = (/** @type {string} */ value) => createHash("sha256").update(value).digest();

/**
 * @param {{ config: Record<string, any>, usageLedger?: any, ensureOwner?: (() => Promise<{ userId: string, projectId: string }>) | null,
 *   now?: () => Date }} dependencies
 *   `ensureOwner` makes the internal project when missing (`internalProjects.ensureOpenVikingProject`).
 */
export function createOpenVikingModelCaller({ config, usageLedger = null, ensureOwner = null, now = () => new Date() }) {
  const key = !config.openVikingModelKeyError && typeof config.openVikingModelKey === "string" ? config.openVikingModelKey : "";
  const usable = key.length >= MIN_KEY_LENGTH;
  /** @type {[Buffer, string][]} */
  const bearers = usable ? [[digest(key), "memory-extraction"], [digest(openVikingKnowledgeModelKey(key)), "knowledge"]] : [];
  const budgetCny = Number.isFinite(Number(config.openVikingModelDailyBudgetCny)) ? Math.max(0, Number(config.openVikingModelDailyBudgetCny)) : 0;
  /** Observable counters (principle 15). */
  const counters = {
    admitted: Object.fromEntries(OPENVIKING_MODEL_PURPOSES.map((purpose) => [purpose, 0])),
    refused: Object.fromEntries(OPENVIKING_MODEL_PURPOSES.map((purpose) => [purpose, 0])),
    ownerFailures: 0,
  };
  /** @type {{ userId: string, projectId: string } | null} */
  let owner = null;
  /** @type {string | null} */
  let lastRefusalAt = null;

  async function resolveOwner() {
    if (owner) return owner;
    // With no durable ledger nothing that references the project is written (a deployment on the file store, where
    // the platform account does not exist either): the name alone is what the usage file records.
    if (!usageLedger) return { userId: PLATFORM_PUBLISHER_USER_ID, projectId: OPENVIKING_PROJECT_ID };
    if (!ensureOwner) throw new HttpError(503, "openviking_model_owner_unavailable", "The engine's model calls have no account to be booked to.");
    try {
      owner = await ensureOwner();
    } catch (error) {
      counters.ownerFailures += 1;
      // 503, not 4xx: the engine retries it, and an account that could not be read a moment ago usually can be.
      throw new HttpError(503, "openviking_model_owner_unavailable",
        `The engine's model calls have no account to be booked to (${typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "unreadable"}).`);
    }
    return owner;
  }

  /** What the two purposes have committed in the rolling day: settled cost plus what is still reserved or uncertain. */
  async function spent(at = now()) {
    if (!usageLedger || !owner) return null;
    const since = new Date(at.getTime() - DAY_MS);
    const sums = await Promise.all(OPENVIKING_MODEL_PURPOSES.map((purpose) => usageLedger.purposeSpend({ ...owner, purpose, since })));
    return Math.round(sums.reduce((total, value) => total + Number(value || 0), 0) * 10_000) / 10_000;
  }

  return {
    /** Whether a service key is loaded: off, no bearer is the engine's and every such request is refused as unknown. */
    configured: usable,
    counters,

    /**
     * The caller a bearer stands for, or null when it is not the engine's.
     * @param {string} token
     * @returns {{ service: "openviking", purpose: string, maxBodyBytes: number } | null}
     */
    identify(token) {
      if (!bearers.length || typeof token !== "string" || !token) return null;
      const presented = digest(token);
      let purpose = null;
      // Every candidate is compared, whichever matches first: the time taken says nothing about which key was tried.
      for (const [expected, name] of bearers) if (timingSafeEqual(presented, expected)) purpose = name;
      return purpose ? { service: "openviking", purpose, maxBodyBytes: OPENVIKING_MODEL_MAX_BODY_BYTES } : null;
    },

    /**
     * Admit one call: the account it is booked to, after the day's budget was asked whether it can still afford it.
     * A question, not a hold — the reservation itself is the ledger's, made by the gateway right after — so two calls
     * admitted in the same instant can together pass the line by one reservation.
     * @param {{ purpose: string }} caller @param {number} estimatedCost what the gateway is about to reserve, in CNY
     * @returns {Promise<{ userId: string, projectId: string }>}
     */
    async admit(caller, estimatedCost) {
      const account = await resolveOwner();
      if (budgetCny > 0 && usageLedger) {
        const committed = await spent();
        if (committed != null && committed + Math.max(0, Number(estimatedCost) || 0) > budgetCny) {
          counters.refused[caller.purpose] += 1;
          lastRefusalAt = now().toISOString();
          throw new HttpError(402, OPENVIKING_QUOTA_CODE,
            "The engine's model budget for this day is spent; nothing was sent to the provider.");
        }
      }
      counters.admitted[caller.purpose] += 1;
      return account;
    },

    /** For readiness and the metrics: the budget, what is committed against it, and what was refused. */
    async status() {
      let spentCny = null;
      try {
        if (usable && usageLedger) {
          if (!owner && ensureOwner) await resolveOwner();
          spentCny = await spent();
        }
      } catch {
        spentCny = null;
      }
      const exhausted = budgetCny > 0 && spentCny != null && spentCny >= budgetCny;
      return {
        configured: usable,
        ...(usable ? {} : { code: String(config.openVikingModelKeyError || "openviking_model_key_missing") }),
        budgetCny,
        spentCny,
        ...(exhausted ? { warning: "openviking_model_budget_exhausted" } : {}),
        admitted: { ...counters.admitted },
        refused: { ...counters.refused },
        ...(lastRefusalAt ? { lastRefusalAt } : {}),
      };
    },
  };
}
