import { HttpError } from "./security.mjs";

/**
 * The vendor's 「GEO 查收录」 as a mention-only measuring channel (build spec
 * §7.4). One task asks one engine one question and answers only whether the
 * brand words appeared (收录) — no answer text, no citations. So a snapshot
 * from here carries `surface.mode = "inclusion"` and only mention-style cells
 * (M-01) are computed from it; accuracy and citation are `not_measurable` for
 * that engine, never zero.
 *
 * It is used for Baidu 文心 alone, until the probe host has a Baidu tab of its
 * own, and only when the market is configured and
 * `OPEN_SCIENCE_GEO_INCLUSION_ENGINES` lists `baidu` (the engine id of 百度文心). Each task costs one
 * 算力 from the platform account.
 *
 * @module geoInclusionClient
 */

/** The vendor's platform numbers for the engines it checks. */
export const INCLUSION_PLATFORMS = Object.freeze({
  deepseek: 1, doubao: 2, yuanbao: 3, qianwen: 4, baidu: 5, nami: 6, kimi: 7, zhipu: 8,
});

/** Engines this deployment may measure through the channel (spec §7.4). */
export const INCLUSION_ALLOWED_ENGINES = Object.freeze(["baidu"]);

/** Task status → snapshot status. 3 is "failed, refunded". */
const STATUS = Object.freeze({ 0: "pending", 1: "valid", 2: "valid", 3: "failed" });

/**
 * Whether the channel is on for this deployment.
 * @param {Record<string, any>} config @param {{ configured?: boolean } | null | undefined} market
 */
export function inclusionEnabled(config, market) {
  return market?.configured === true && (config?.geoInclusionEngines ?? []).some((engine) => INCLUSION_ALLOWED_ENGINES.includes(engine));
}

/**
 * @typedef {object} InclusionSnapshot
 * @property {string} engine
 * @property {{ mode: "inclusion" }} surface
 * @property {"pending" | "valid" | "failed"} status
 * @property {boolean | null} hit whether the brand words were found; null until known
 * @property {string} keywordRes the words the vendor matched
 * @property {string | null} screenshotUrl
 * @property {string | null} shareUrl
 * @property {string} requestId
 * @property {string | null} checkedAt
 * @property {string | null} inclusionDate
 */

export class GeoInclusionClient {
  /** @param {{ market: any, config: Record<string, any> }} options */
  constructor({ market, config }) {
    this.market = market;
    this.config = config ?? {};
  }

  get enabled() {
    return inclusionEnabled(this.config, this.market);
  }

  /** The engines this deployment measures through the channel. */
  engines() {
    if (!this.enabled) return [];
    return (this.config.geoInclusionEngines ?? []).filter((/** @type {string} */ engine) => INCLUSION_ALLOWED_ENGINES.includes(engine));
  }

  /** @param {string} engine */
  #platform(engine) {
    if (!this.enabled) throw new HttpError(503, "geo_inclusion_disabled", "The inclusion channel is not enabled for this deployment.");
    if (!this.engines().includes(engine)) throw new HttpError(400, "geo_inclusion_engine_not_allowed", "That engine is not measured through the inclusion channel.");
    return INCLUSION_PLATFORMS[/** @type {keyof typeof INCLUSION_PLATFORMS} */ (engine)];
  }

  /**
   * Submit one question for one engine.
   * @param {{ engine: string, keywords: string[], question: string, thirdId: string }} task
   * @returns {Promise<{ requestId: string, engine: string }>}
   */
  async submit({ engine, keywords, question, thirdId }) {
    const platform = this.#platform(engine);
    const { requestId } = await this.market.addInclusionTask({ platform, keywords, question, thirdId });
    return { requestId, engine };
  }

  /**
   * The task's result as a snapshot-like record.
   * @param {string} engine @param {string} requestId
   * @returns {Promise<InclusionSnapshot>}
   */
  async poll(engine, requestId) {
    this.#platform(engine);
    const task = await this.market.checkInclusionTask(requestId);
    const status = /** @type {"pending" | "valid" | "failed"} */ (STATUS[/** @type {0 | 1 | 2 | 3} */ (task.status)] ?? "failed");
    return {
      engine,
      surface: { mode: "inclusion" },
      status,
      hit: task.status === 1 ? true : task.status === 2 ? false : null,
      keywordRes: task.keywordRes ?? "",
      screenshotUrl: task.imgUrl ?? null,
      shareUrl: task.shareUrl ?? null,
      requestId: task.requestId ?? requestId,
      checkedAt: task.checkedAt ?? null,
      inclusionDate: task.inclusionDate ?? null,
    };
  }

  /** Cancel tasks still queued (the vendor refunds only those). @param {string[]} requestIds */
  async cancel(requestIds) {
    if (!this.enabled) throw new HttpError(503, "geo_inclusion_disabled", "The inclusion channel is not enabled for this deployment.");
    return this.market.cancelInclusionTasks(requestIds);
  }
}
