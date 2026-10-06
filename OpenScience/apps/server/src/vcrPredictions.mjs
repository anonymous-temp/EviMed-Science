/**
 * The 虚拟临研 side of the prediction registry (flywheel plan §5.6, F25, 2026-10-06): a study files the prediction one of its trial
 * scenarios makes of a registered trial's primary endpoint, with the timestamp the registry keeps it under until the trial reports.
 *
 * The registry and the scoring belong to the learning package; this module only reads a number out of an engine result and hands it
 * over. Hidden knowledge:
 *
 * - **The number is read, never typed.** The request names a scenario, a registered trial, an endpoint and a *path* into the
 *   scenario's result; the estimate and its interval (or a success probability) are what the engine's own result holds there. A body
 *   that carries a number — `estimate`, `interval`, `probability`, `value`, or any other key — is refused whole by name
 *   (`vcr_prediction_number_refused` for the first four, `vcr_payload_invalid` for the rest), so a prediction can never be a figure a person
 *   or a run chose; the platform principle that the model never types a number holds at the one place a number leaves the module.
 * - **It must have come from an engine job.** A result with no execution behind it (a manual card, a stale copy) has no engine job id
 *   and no receipt, and is refused (`vcr_prediction_not_from_engine`); so is a result the engine called not estimable. The receipt id
 *   is the execution's, the engine job id the one the engine ran it under.
 * - **A prediction is filed once.** The same scenario result, trial and endpoint asked for again is the filing that exists: the
 *   study's schedule marks hold one claim per prediction (`prediction:<trial>:<endpoint>:<receipt>`), taken before the registry is
 *   asked and released if it refuses, so a retry after a failure is possible and a double click is not a second filing.
 * - **Nothing here is public.** The registry decides what is ever shown (no individual prediction before the trial reports; the
 *   calibration curve after thirty scored ones); this module shows nothing and stores nothing but the claim.
 * - **Off is a 404 by name.** With no registry given the module is absent, whatever the study.
 *
 * @module vcrPredictions
 */

import { readNumberPath } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { registryOfId } from "./vcrFrontierEvents.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";

/** Body keys that would be a number someone chose: refused by their own code, not as unknown fields. */
export const VCR_PREDICTION_NUMBER_KEYS = Object.freeze(["estimate", "interval", "probability", "value"]);

/** The measures that are a probability of success: what a prediction by probability reads. */
export const VCR_PREDICTION_PROBABILITY_MEASURES = Object.freeze(["power", "assurance", "power_at_prior_mean"]);

const BODY_KEYS = Object.freeze(["scenarioId", "registryId", "endpoint", "resultPath"]);
const SCENARIO_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** What a path into a result may be made of: names, dots, indices and the `measure(name)` selector; nothing that computes. */
const RESULT_PATH = /^[A-Za-z0-9_.()=,\s-]{1,160}$/;

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The estimate and interval — or the success probability — a measure of an engine result states. Nothing is computed: a value, the two
 * ends of the interval the engine wrote, the name the interval carries.
 * @param {Record<string, any>} measure
 * @returns {{ estimate: number, interval: { low: number, high: number, kind: string | null } } | { probability: number } | null}
 */
export function predictionOfMeasure(measure) {
  const value = finite(measure.value);
  if (value === null) return null;
  const interval = object(measure.interval);
  const low = finite(interval.low);
  const high = finite(interval.high);
  if (low !== null && high !== null && low <= high) return { estimate: value, interval: { low, high, kind: typeof interval.kind === "string" ? interval.kind : null } };
  if (VCR_PREDICTION_PROBABILITY_MEASURES.includes(String(measure.name)) && value >= 0 && value <= 1) return { probability: value };
  return null;
}

/**
 * @param {{ store: any, registry?: { register: (prediction: Record<string, any>) => Promise<any> } | null, now?: () => Date }} dependencies
 */
export function createVcrPredictions({ store, registry = null, now = () => new Date() }) {
  if (!store) throw new TypeError("The prediction filing needs the VCR store.");
  if (typeof registry?.register !== "function") return null;
  const counters = { filed: 0, existing: 0, refused: 0, failed: 0 };

  /** @param {number} status @param {string} code @param {string} message */
  const refuse = (status, code, message) => { counters.refused += 1; return new HttpError(status, code, message); };

  return {
    counters,

    /**
     * File the prediction of one trial scenario of a study. The caller has established who may ask: the study's lead, or the programme.
     * @param {any} study @param {{ id: string }} actor @param {unknown} body
     */
    async file(study, actor, body) {
      const asked = object(body);
      const number = VCR_PREDICTION_NUMBER_KEYS.find((key) => Object.hasOwn(asked, key));
      if (number) throw refuse(422, "vcr_prediction_number_refused", "预测的数不由请求给出：它只从引擎结果的指定位置读取。");
      const stray = Object.keys(asked).find((key) => !BODY_KEYS.includes(key));
      if (stray) throw refuse(400, "vcr_payload_invalid", `This request takes only: ${BODY_KEYS.join(", ")}.`);
      const scenarioId = String(asked.scenarioId ?? "");
      const registered = registryOfId(asked.registryId);
      const endpoint = typeof asked.endpoint === "string" ? asked.endpoint.replace(/\s+/g, " ").trim() : "";
      const resultPath = typeof asked.resultPath === "string" ? asked.resultPath.trim().replace(/\.value$/, "") : "";
      if (!SCENARIO_ID.test(scenarioId)) throw refuse(400, "vcr_payload_invalid", "scenarioId is the id of one of the study's trial scenarios.");
      if (!registered) throw refuse(400, "vcr_payload_invalid", "registryId is the registration number of the trial, as its registry writes it.");
      if (!endpoint || [...endpoint].length > 120) throw refuse(400, "vcr_payload_invalid", "endpoint is the primary endpoint, one line of at most 120 characters.");
      if (!RESULT_PATH.test(resultPath)) throw refuse(400, "vcr_payload_invalid", "resultPath names a measure of the scenario's result, for example measure(power).");

      const scenario = (await store.trialScenarios(study.id, 200)).find((/** @type {any} */ row) => String(row.id) === scenarioId);
      if (!scenario) throw refuse(404, "vcr_prediction_scenario_not_found", "Trial scenario not found.");
      const result = (await store.results(study.id, "trial_scenario")).find((/** @type {any} */ row) =>
        String(row.subjectId ?? "").replace(/^[a-z_]+:/, "").replace(/@\d+$/, "") === scenarioId);
      const execution = result?.executionId ? await store.one(`SELECT id, receipt FROM ${VCR_SCHEMA}.executions WHERE id = $1 AND study_id = $2`, [result.executionId, study.id]) : null;
      if (!result || !execution || result.conclusion === "not_estimable") {
        throw refuse(409, "vcr_prediction_not_from_engine", "这个情景还没有引擎算出的、可估计的结果；有了再登记预测。");
      }
      const measure = object(readNumberPath({ measures: result.measures, counts: result.counts, diagnostics: result.diagnostics }, resultPath));
      const read = predictionOfMeasure(measure);
      if (!read) throw refuse(422, "vcr_prediction_unreadable", "结果里这个位置没有“估计值加区间”或“成功概率”：换一个指标，例如 measure(power) 或带区间的效应估计。");

      const claim = `prediction:${registered.registryId}:${endpoint}:${execution.id}`.slice(0, 200);
      const claimed = await store.one(`INSERT INTO ${VCR_SCHEMA}.schedule_marks (study_id, key, user_id, kind, state, detail)
        VALUES ($1, $2, $3, 'notice', 'done', $4::jsonb) ON CONFLICT (study_id, key) DO NOTHING RETURNING key`,
      [study.id, claim, study.userId, JSON.stringify({ scenarioId, resultPath, by: String(actor.id) })]);
      if (!claimed) { counters.existing += 1; return { filed: false, existing: true, registryId: registered.registryId, endpoint }; }
      try {
        const filed = await registry.register({
          source: "vcr", registryId: registered.registryId, endpoint, ...read,
          engineJobId: object(execution.receipt).engineJobId == null ? null : String(object(execution.receipt).engineJobId),
          receiptId: String(execution.id), filedAt: now().toISOString(), accountId: String(study.userId), studyId: String(study.id),
        });
        counters.filed += 1;
        await store.audit({ studyId: study.id, userId: study.userId, actor: String(actor.id), action: "vcr.prediction.file", object: claim, detail: { scenarioId, resultPath } });
        return { filed: true, existing: false, registryId: registered.registryId, endpoint, ...(filed?.id ? { id: String(filed.id) } : {}) };
      } catch (error) {
        // The registry did not take it: the claim goes, so a retry is a filing and not an "already filed".
        counters.failed += 1;
        await store.query(`DELETE FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2`, [study.id, claim]).catch(() => null);
        throw error;
      }
    },
  };
}
