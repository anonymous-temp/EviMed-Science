/**
 * Whether each managed-job engine says it is ready, read from its own
 * `/health`.
 *
 * Hidden knowledge: the six specialist adapters answer `GET /health` on their
 * origin without a credential, and since 2026-10-04 say more than up or down:
 * `ready` (it can run what it advertises with what this deployment holds),
 * `serving` (the process and its model are up), `specialistSlots` (the
 * deployment-wide job cap and who holds it), `adapterManifest` and
 * `sourceEvidence` (labels of what the engine's source looked like; neither is
 * ever an input to `ready`). The audit probed this from outside; the product
 * never read it, so "an engine down" was invisible until a run met it.
 *
 * Three answers, and the third is the honest one for a network that says
 * nothing: `ready`, `degraded` (it answered, and said it is not ready), and
 * `unreachable` (it did not answer in time). `unreachable` is a statement about
 * the control plane's own reach, which is what a submitted job would also need;
 * it is never a statement about why.
 *
 * Bounded and never blocking: a snapshot is returned from memory at once, and a
 * stale one starts one refresh in the background. Nothing this reads is put into
 * a log, an error or a response except five scalar fields it names; an upstream
 * body is never echoed.
 *
 * @module availabilityEngineProbe
 */

import { MCP_MANAGED_JOB_BASE_NAMES } from "@evimed/domain";
import { engineHealthUrl } from "./deploymentComposition.mjs";

/** @typedef {{ state: "ready" | "degraded" | "unreachable", checkedAt: string, facts: Record<string, unknown> }} EngineHealth */

/** The only things taken from an adapter's answer. */
const SCALAR_FIELDS = Object.freeze(["ready", "serving", "adapterManifest", "sourceEvidence", "auditReceiptsReady"]);

/** @param {unknown} value @returns {boolean} */
const scalar = (value) => typeof value === "boolean" || (typeof value === "string" && value.length <= 64);

export class EngineHealthProbe {
  /**
   * @param {{ config: Record<string, any>, fetchImpl?: typeof fetch, ttlMs?: number, timeoutMs?: number, now?: () => number,
   *   report?: (code: string) => void }} dependencies
   */
  constructor({ config, fetchImpl = globalThis.fetch, ttlMs = 30_000, timeoutMs = 2_500, now = () => Date.now(), report = () => {} }) {
    this.config = config;
    this.fetch = fetchImpl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.report = report;
    /** @type {Map<string, EngineHealth>} */
    this.cache = new Map();
    this.checkedAt = 0;
    /** @type {Promise<void> | null} */
    this.refreshing = null;
  }

  /** The tools whose engines have a service to ask. */
  get tools() {
    return MCP_MANAGED_JOB_BASE_NAMES.filter((tool) => engineHealthUrl(this.config, tool) !== null);
  }

  /**
   * What is known now, without waiting. A stale snapshot starts a refresh and is
   * still returned: a label a few seconds old is better than a page that waits.
   * @returns {Map<string, EngineHealth>}
   */
  snapshot() {
    if (this.now() - this.checkedAt > this.ttlMs) void this.refresh().catch(() => {});
    return new Map(this.cache);
  }

  /**
   * Ask every engine now (the operator's export waits for this), at most one
   * round at a time.
   * @param {{ force?: boolean }} [options] @returns {Promise<Map<string, EngineHealth>>}
   */
  async refresh({ force = false } = {}) {
    if (!force && this.refreshing) {
      await this.refreshing;
      return new Map(this.cache);
    }
    if (!force && this.now() - this.checkedAt <= this.ttlMs && this.cache.size) return new Map(this.cache);
    this.refreshing = this.#round().finally(() => { this.refreshing = null; });
    await this.refreshing;
    return new Map(this.cache);
  }

  async #round() {
    const results = await Promise.all(this.tools.map(async (tool) => [tool, await this.#ask(tool)]));
    this.cache = new Map(/** @type {[string, EngineHealth][]} */ (results));
    this.checkedAt = this.now();
  }

  /** @param {string} tool @returns {Promise<EngineHealth>} */
  async #ask(tool) {
    const checkedAt = new Date(this.now()).toISOString();
    const url = engineHealthUrl(this.config, tool);
    try {
      const response = await this.fetch(/** @type {string} */ (url), {
        method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs),
      });
      /** @type {Record<string, unknown>} */
      let facts = {};
      try {
        /** @type {any} */
        const body = await response.json();
        if (body && typeof body === "object" && !Array.isArray(body)) {
          facts = Object.fromEntries(SCALAR_FIELDS.filter((field) => scalar(body[field])).map((field) => [field, body[field]]));
          const slots = body.specialistSlots;
          if (slots && typeof slots === "object") {
            const picked = Object.fromEntries(["limit", "running", "waiting"].filter((field) => Number.isSafeInteger(slots[field])).map((field) => [field, slots[field]]));
            if (Object.keys(picked).length) facts.specialistSlots = picked;
          }
        }
      } catch { /* an answer that is not JSON is read as an answer that is not ready */ }
      return { state: response.ok && facts.ready === true ? "ready" : "degraded", checkedAt, facts };
    } catch {
      this.report("availability_engine_unreachable");
      return { state: "unreachable", checkedAt, facts: {} };
    }
  }
}
