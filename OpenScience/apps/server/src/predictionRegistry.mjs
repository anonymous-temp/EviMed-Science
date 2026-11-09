/**
 * The prediction registry (evidence-flywheel plan §5.2, F25, 2026-10-06): the platform's estimate of a trial's primary endpoint, filed before the result exists, time-stamped
 * and immutable. It is the evolution module's prospective registration, not a second registry: a filing is an `evolution-prospective` record, status `waiting-publication`.
 * Scoring a filing against a published result was an experiment and left with the online engine (2026-11-04), and everything that waited for a score went with it, so online a
 * filing is filed and nothing more: no read, no calibration.
 *
 * Hidden knowledge:
 *
 * - **A registration is a row, never an overwrite.** The id is a hash of the canonical payload (the caller's `filedAt` and `engineJobId` included), so a retry of the same filing
 *   finds its row and a second filing of the same trial, endpoint and source — a revised estimate — is another row. Nothing here updates a prediction.
 * - **`filedAt` is what the filer says;** `recordedAt` is when this registry took the row.
 * - **Tenant rows stay the tenant's.** Registrations are documents of the filing account, in the project of the study, so the ledger's own scoping isolates them.
 *
 * @module predictionRegistry
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@evimed/domain";
import { identifierKeys } from "@evimed/domain/entity-keys";
import { HttpError } from "./security.mjs";

/** Who may file a prediction: a virtual clinical study. */
export const PREDICTION_SOURCES = Object.freeze(["vcr"]);
/** How far into the future a filing's own clock may be before it is refused. */
const CLOCK_SKEW_MS = 5 * 60_000;

const sha = (/** @type {unknown} */ value) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
const invalid = (/** @type {string} */ detail) => new HttpError(400, "prediction_invalid", `Invalid prediction registration: ${detail}.`);
/** @param {unknown} value @returns {value is number} */
const finite = (value) => typeof value === "number" && Number.isFinite(value);
/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null);

/**
 * A registration, checked and normalized: its identity in the registry, the endpoint, the prediction itself (an estimate, an interval
 * around it, a probability of success) and where it came from. Closed formats only; nothing here reads prose.
 * @param {any} input @param {Date} recordedAt
 */
export function normalizePrediction(input, recordedAt) {
  if (!input || typeof input !== "object") throw invalid("a registration is an object");
  if (!PREDICTION_SOURCES.includes(input.source)) throw invalid("source is vcr");
  const linked = text(input.studyId, 200);
  if (!linked) throw invalid("studyId names the study");
  const accountId = text(input.accountId, 200);
  const projectId = text(input.projectId, 200);
  if (!accountId || !projectId) throw invalid("accountId and projectId name who files it and where");
  const registryKey = identifierKeys({ registryIds: [input.registryId] })[0] ?? null;
  if (!registryKey) throw invalid("registryId is a trial registry number");
  const endpoint = text(input.endpoint, 200);
  if (!endpoint) throw invalid("endpoint names the primary endpoint");
  const hasEstimate = input.estimate != null, hasProbability = input.probability != null;
  if (!hasEstimate && !hasProbability) throw invalid("an estimate or a probability is required");
  if (hasEstimate && !finite(input.estimate)) throw invalid("estimate is a finite number");
  if (hasProbability && (!finite(input.probability) || input.probability < 0 || input.probability > 1)) throw invalid("probability is from 0 to 1");
  if (input.interval != null) {
    if (!hasEstimate || !Array.isArray(input.interval) || input.interval.length !== 2 || !input.interval.every(finite) || input.interval[0] > input.interval[1]
      || input.estimate < input.interval[0] || input.estimate > input.interval[1]) throw invalid("interval is [low, high] around the estimate");
  }
  const filedAt = Date.parse(input.filedAt ?? "");
  if (!Number.isFinite(filedAt)) throw invalid("filedAt is a time");
  if (filedAt > recordedAt.getTime() + CLOCK_SKEW_MS) throw invalid("filedAt is not in the future");
  for (const key of ["engineJobId", "receiptId", "methodId"]) if (input[key] != null && !text(input[key], 200)) throw invalid(`${key} is a short identifier`);
  const prediction = { ...(hasEstimate ? { estimate: input.estimate } : {}), ...(input.interval != null ? { interval: [input.interval[0], input.interval[1]] } : {}), ...(hasProbability ? { probability: input.probability } : {}) };
  const payload = {
    source: input.source, studyId: linked, accountId, projectId, registryId: registryKey.slice("reg:".length), registryKey,
    endpoint, endpointKey: endpoint.toLowerCase().replace(/\s+/g, " "), prediction,
    ...(input.methodId != null ? { methodId: input.methodId } : {}), ...(input.engineJobId != null ? { engineJobId: input.engineJobId } : {}), ...(input.receiptId != null ? { receiptId: input.receiptId } : {}),
    filedAt: new Date(filedAt).toISOString(),
  };
  return { payload, payloadHash: sha(payload) };
}

/**
 * The registry, off unless its switch is on and the evolution module that holds the records is composed.
 *
 * @param {{
 *   config: any, evolution: any,
 *   now?: () => Date }} dependencies
 */
export function createPredictionRegistry({ config, evolution, now = () => new Date() }) {
  const enabled = config?.predictionRegistryEnabled === true && Boolean(evolution);
  const counters = { registered: 0 };
  const off = () => new HttpError(404, "prediction_registry_disabled", "The prediction registry is not enabled.");

  /**
   * File a prediction: checked, stamped, hashed and stored once. Another filing of the same trial, endpoint and source is another row.
   * @param {any} input `{ source, studyId, projectId, accountId, registryId, endpoint, estimate?, interval?, probability?, engineJobId?, receiptId?, methodId?, filedAt }`
   */
  async function register(input) {
    if (!enabled) throw off();
    const recordedAt = now();
    const { payload, payloadHash } = normalizePrediction(input, recordedAt);
    const id = `evolution-prospective-${sha(payload)}`;
    const prior = await evolution.get(id, payload.accountId);
    if (prior) return { id, status: prior.payload.status, payloadHash: prior.payload.payloadHash, recordedAt: prior.payload.recordedAt, existing: true };
    const saved = await evolution.save("prospective", id, { ...payload, registryVersion: 1, payloadHash, recordedAt: recordedAt.toISOString(), status: "waiting-publication", registrationEligible: true, origin: "platform-inference" }, null, payload.accountId);
    counters.registered += 1;
    return { id, status: saved.payload.status, payloadHash, recordedAt: saved.payload.recordedAt, existing: false };
  }

  return { enabled, register, status: () => ({ enabled, counters: structuredClone(counters) }) };
}

/** The operator-metric families of the registry, with the module off and nothing to read reporting zero. @param {ReturnType<typeof createPredictionRegistry> | null} registry @param {any} config */
export function predictionRegistryMetricFamilies(registry, config) {
  const status = registry?.status();
  return [
    { name: "open_science_prediction_registry_enabled", type: "gauge", help: "Whether the prediction registry is switched on (OPEN_SCIENCE_PREDICTION_REGISTRY_ENABLED).", series: [{ value: config?.predictionRegistryEnabled === true ? 1 : 0 }] },
    { name: "open_science_prediction_registrations_total", type: "counter", help: "Predictions registered by this process.", series: [{ value: status?.counters.registered ?? 0 }] },
  ];
}
