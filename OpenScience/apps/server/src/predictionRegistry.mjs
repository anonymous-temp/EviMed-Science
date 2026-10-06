/**
 * The prediction registry (evidence-flywheel plan §5.2, F25, 2026-10-06): the platform's estimate of a trial's primary endpoint, filed
 * before the result exists, time-stamped, immutable, and scored when the frontier publishes the result — in code, against a value
 * the existing verified-extraction path bonded to a quotation.
 *
 * It is the evolution module's prospective registration, not a second registry: a registration is an `evolution-prospective` record
 * with the module's own lifecycle words (`waiting-publication` → `scored`), its publication match is the module's
 * (`matchProspectivePublication` tells this registry of every paper the feed publishes), and each score is an observation on the method
 * that made the prediction. What it adds is the shape of a prediction a virtual clinical study or an agenda files — an estimate with
 * an interval, or a probability — and the rules of who may read it when.
 *
 * Hidden knowledge:
 *
 * - **A registration is a row, never an overwrite.** The id is a hash of the canonical payload (the caller's `filedAt` and `engineJobId`
 *   included), so a retry of the same filing finds its row and a second filing of the same trial, endpoint and source — a revised
 *   estimate — is another row. Nothing here updates a prediction; the only later write is the score, beside it.
 * - **The chronology that counts is ours.** `filedAt` is what the filer says; `recordedAt` is when this registry took the row, and only
 *   a prediction recorded before the result's first public date is scored. A prediction filed after the result is stored as such and
 *   never scored: it is not a prediction.
 * - **Nothing about an individual prediction is readable before its trial has a published result** (plan ruling 10), except by its owner
 *   and by operators; to everyone else it does not exist (`prediction_not_found`, not a refusal that confirms it). After the result
 *   an individual prediction is shown only as predicted against actual, with the time it was recorded. The overall calibration is
 *   exported by `predictionCalibration()` only once `PREDICTION_CALIBRATION_MIN_SCORED` scored predictions exist, and says how many
 *   there are until then.
 * - **A model proposes the published value, code decides whether it is the paper's.** `createQuoteBondedPublishedValue` accepts a proposer
 *   (the model call) and returns a value only when its quotation is in the preserved text and prints that very number
 *   (`prospectiveNumericQuoteMatches`, the module's own bond), and a "primary endpoint met" judgement only with a quotation that is in the
 *   text. No proposer is composed in the server yet; without one a matched registration stays waiting and says why (see the report).
 * - **Tenant rows stay the tenant's.** Registrations are documents of the filing account, in the project of the study or agenda, so the
 *   ledger's own scoping isolates them; the cross-account reads this file makes (the registrations a paper wakes, the scored ones the
 *   calibration counts) are the control plane's, and expose a prediction only through the view rules above.
 *
 * Build to delete: a published result that carries its own machine-readable primary-endpoint value needs no proposer.
 *
 * @module predictionRegistry
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@evimed/domain";
import { identifierKeys, identifierKeysInText } from "@evimed/domain/entity-keys";
import { HttpError } from "./security.mjs";
import { prospectiveNumericQuoteMatches } from "./evolutionProspectiveScore.mjs";

/** Who may file a prediction: a virtual clinical study, or an agenda (the programme's or a researcher's). */
export const PREDICTION_SOURCES = Object.freeze(["vcr", "agenda"]);
/** The fewest scored predictions before the overall calibration is published (plan §5.2, F25). */
export const PREDICTION_CALIBRATION_MIN_SCORED = 30;
/** The lifecycle words, the module's own plus the two ends a registration alone can reach. */
export const PREDICTION_STATUSES = Object.freeze(["waiting-publication", "scored", "ineligible-after-result"]);
/** What became of a published paper that named a registered trial, closed so the counter's label set is. */
export const PREDICTION_PUBLICATION_OUTCOMES = Object.freeze(["scored", "extractor_unavailable", "extraction_failed", "no_publication_date", "ineligible_after_result", "error"]);
/** The most scored predictions the calibration reads; past it the curve is of the latest. */
const CALIBRATION_READ_LIMIT = 5000;
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
  if (!PREDICTION_SOURCES.includes(input.source)) throw invalid("source is vcr or agenda");
  const link = input.source === "vcr" ? "studyId" : "agendaId";
  const linked = text(input[link], 200);
  if (!linked) throw invalid(`${link} names the ${input.source === "vcr" ? "study" : "agenda"}`);
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
    source: input.source, [link]: linked, accountId, projectId, registryId: registryKey.slice("reg:".length), registryKey,
    endpoint, endpointKey: endpoint.toLowerCase().replace(/\s+/g, " "), prediction,
    ...(input.methodId != null ? { methodId: input.methodId } : {}), ...(input.engineJobId != null ? { engineJobId: input.engineJobId } : {}), ...(input.receiptId != null ? { receiptId: input.receiptId } : {}),
    filedAt: new Date(filedAt).toISOString(),
  };
  return { payload, payloadHash: sha(payload) };
}

/**
 * The score of one prediction against the published result, in code: the Brier score of a probability against whether the primary endpoint was
 * met, and for an estimate its absolute error and whether the published value fell inside the stated interval. A kind of score the prediction
 * or the result cannot give is absent, never zero.
 * @param {{ estimate?: number, interval?: number[], probability?: number }} prediction
 * @param {{ value?: number, met?: boolean }} actual
 * @returns {{ brier?: number, absoluteError?: number, covered?: boolean }}
 */
export function scorePrediction(prediction, actual) {
  return {
    ...(finite(prediction.probability) && typeof actual.met === "boolean" ? { brier: (prediction.probability - (actual.met ? 1 : 0)) ** 2 } : {}),
    ...(finite(prediction.estimate) && finite(actual.value) ? { absoluteError: Math.abs(prediction.estimate - actual.value) } : {}),
    ...(Array.isArray(prediction.interval) && finite(actual.value) ? { covered: actual.value >= prediction.interval[0] && actual.value <= prediction.interval[1] } : {}),
  };
}

/**
 * What anyone but the owner and an operator may see of a prediction: nothing until its result is published, and after it only the
 * prediction beside the actual, with the time it was recorded. No account, study, project, method or job leaves here.
 * @param {any} record the stored registration @returns {Record<string, any> | null}
 */
export function publicPredictionView(record) {
  if (record?.status !== "scored" || !record.actual) return null;
  return {
    registryId: record.registryId, endpoint: record.endpoint, source: record.source,
    predicted: record.prediction, actual: { value: record.actual.value ?? null, met: record.actual.met ?? null, quote: record.actual.quote ?? null, sourceUrl: record.actual.sourceUrl ?? null, firstPublicAt: record.actual.firstPublicAt },
    score: record.score, registeredAt: record.recordedAt, payloadHash: record.payloadHash,
  };
}

/**
 * The accepted form of a published value: the proposer (a model) names a value with the quotation that prints it, and an optional
 * judgement that the primary endpoint was met with its own quotation. Code accepts the value only when the quotation is in the preserved
 * text and the number is printed in it (the evolution module's bond, `prospectiveNumericQuoteMatches`), and the judgement only when its
 * quotation is in the text; anything else is `ok: false` with a reason, and nothing is scored.
 *
 * @param {{ propose: (input: { registration: any, paper: any, source: string }) => Promise<{ value?: number, quote?: string, met?: boolean, metQuote?: string } | null> }} options
 * @returns {(input: { registration: any, paper: any }) => Promise<{ ok: true, value?: number, met?: boolean, quote: string | null, metQuote: string | null } | { ok: false, reason: string }>}
 */
export function createQuoteBondedPublishedValue({ propose }) {
  return async ({ registration, paper }) => {
    const source = typeof paper?.excerpt === "string" ? paper.excerpt : "";
    if (!source) return { ok: false, reason: "no_preserved_text" };
    const proposed = await propose({ registration, paper, source });
    if (!proposed) return { ok: false, reason: "nothing_proposed" };
    const value = finite(proposed.value) && typeof proposed.quote === "string" && source.includes(proposed.quote) && prospectiveNumericQuoteMatches(proposed.quote, proposed.value, source) ? proposed.value : undefined;
    const met = typeof proposed.met === "boolean" && typeof proposed.metQuote === "string" && proposed.metQuote.trim() && source.includes(proposed.metQuote) ? proposed.met : undefined;
    if (value === undefined && met === undefined) return { ok: false, reason: "quotation_not_bonded" };
    return { ok: true, ...(value !== undefined ? { value } : {}), ...(met !== undefined ? { met } : {}), quote: value !== undefined ? /** @type {string} */ (proposed.quote) : null, metQuote: met !== undefined ? /** @type {string} */ (proposed.metQuote) : null };
  };
}

/** @param {number[]} values */
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * The registry, off unless its switch is on and the evolution module that holds the records is composed.
 *
 * @param {{
 *   config: any, evolution: any,
 *   isOperator?: (viewer: { id: string }) => boolean,
 *   extractPublished?: ((input: { registration: any, paper: any }) => Promise<any>) | null,
 *   now?: () => Date, report?: (message: string) => void }} dependencies
 */
export function createPredictionRegistry({ config, evolution, isOperator = () => false, extractPublished = null, now = () => new Date(), report = () => {} }) {
  const enabled = config?.predictionRegistryEnabled === true && Boolean(evolution);
  const counters = { registered: 0, scored: 0, outcomes: /** @type {Record<string, number>} */ (Object.fromEntries(PREDICTION_PUBLICATION_OUTCOMES.map((outcome) => [outcome, 0]))) };
  const database = () => evolution.documents?.database ?? null;
  const off = () => new HttpError(404, "prediction_registry_disabled", "The prediction registry is not enabled.");

  /** @param {string} id */
  async function row(id) {
    const db = database();
    if (!db) throw new HttpError(404, "prediction_not_found", "No such prediction registration.");
    const found = (await db.query("SELECT id,user_id,payload FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND id=$1 AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($2::text[])", [id, [...PREDICTION_SOURCES]])).rows[0];
    return found ? { id: found.id, userId: found.user_id, record: found.payload } : null;
  }

  /**
   * File a prediction: checked, stamped, hashed and stored once. Another filing of the same trial, endpoint and source is another row.
   * @param {any} input `{ source, studyId | agendaId, projectId, accountId, registryId, endpoint, estimate?, interval?, probability?, engineJobId?, receiptId?, methodId?, filedAt }`
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

  /**
   * An agenda's prediction (the programme's, or a researcher's) through the same door, the account being the agenda's.
   * @param {any} input `register`'s, with `agendaId` and without `source`
   */
  const registerAgendaPrediction = (input) => register({ ...input, source: "agenda" });

  /**
   * One registration as the viewer may see it: all of it to its owner and to an operator, the predicted-against-actual view to anyone once it is
   * scored, and to anyone else — before the result — nothing, answered as if there were no such registration.
   * @param {{ id: string, viewer: { id: string } }} input
   */
  async function read({ id, viewer }) {
    if (!enabled) throw off();
    const found = await row(id);
    if (!found) throw new HttpError(404, "prediction_not_found", "No such prediction registration.");
    if (found.userId === viewer?.id || (viewer && isOperator(viewer))) return { view: "full", id: found.id, ...found.record };
    const shown = publicPredictionView(found.record);
    if (!shown) throw new HttpError(404, "prediction_not_found", "No such prediction registration.");
    return { view: "public", id: found.id, ...shown };
  }

  /** The viewer's own registrations, newest first. @param {{ viewer: { id: string }, limit?: number }} input */
  async function listOwn({ viewer, limit = 50 }) {
    if (!enabled) throw off();
    const db = database();
    if (!db || !viewer?.id) return [];
    const rows = (await db.query("SELECT id,payload FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND user_id=$1 AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($2::text[]) ORDER BY created_at DESC,id LIMIT $3",
      [viewer.id, [...PREDICTION_SOURCES], Math.max(1, Math.min(200, limit))])).rows;
    return rows.map((/** @type {any} */ entry) => ({ id: entry.id, ...entry.payload }));
  }

  /** Every scored prediction, as the public sees it: predicted against actual, newest result first. @param {{ limit?: number }} [options] */
  async function publicScored({ limit = 50 } = {}) {
    if (!enabled) throw off();
    const db = database();
    if (!db) return [];
    const rows = (await db.query("SELECT payload FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($1::text[]) AND payload->>'status'='scored' ORDER BY payload->'actual'->>'firstPublicAt' DESC LIMIT $2",
      [[...PREDICTION_SOURCES], Math.max(1, Math.min(200, limit))])).rows;
    return rows.map((/** @type {any} */ entry) => publicPredictionView(entry.payload));
  }

  /**
   * The overall calibration of every scored prediction, only once enough exist for it to say anything: before that, how many there are. The
   * curve bins the probabilities by tenths against how often the endpoint was met; the estimates are summarized by their absolute error and the share
   * of published values inside their stated interval.
   * @returns {Promise<{ available: false, scored: number } | { available: true, scored: number, probability: { n: number, brierMean: number | null, bins: { from: number, to: number, n: number, meanPredicted: number, observedRate: number }[] },
   *   estimate: { n: number, meanAbsoluteError: number | null, coverage: { n: number, rate: number | null } } }>}
   */
  async function predictionCalibration() {
    const db = enabled ? database() : null;
    if (!db) return { available: false, scored: 0 };
    const scored = (await db.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($1::text[]) AND payload->>'status'='scored'", [[...PREDICTION_SOURCES]])).rows[0].n;
    if (scored < PREDICTION_CALIBRATION_MIN_SCORED) return { available: false, scored };
    const rows = (await db.query("SELECT payload->'prediction' AS prediction, payload->'actual' AS actual, payload->'score' AS score FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($1::text[]) AND payload->>'status'='scored' ORDER BY payload->'actual'->>'firstPublicAt' DESC LIMIT $2",
      [[...PREDICTION_SOURCES], CALIBRATION_READ_LIMIT])).rows;
    const probabilistic = rows.filter((/** @type {any} */ entry) => finite(entry.prediction?.probability) && typeof entry.actual?.met === "boolean");
    const bins = [];
    for (let tenth = 0; tenth < 10; tenth += 1) {
      const inBin = probabilistic.filter((/** @type {any} */ entry) => (entry.prediction.probability >= tenth / 10 && (entry.prediction.probability < (tenth + 1) / 10 || (tenth === 9 && entry.prediction.probability === 1))));
      if (inBin.length) bins.push({ from: tenth / 10, to: (tenth + 1) / 10, n: inBin.length, meanPredicted: /** @type {number} */ (mean(inBin.map((/** @type {any} */ entry) => entry.prediction.probability))),
        observedRate: inBin.filter((/** @type {any} */ entry) => entry.actual.met).length / inBin.length });
    }
    const errors = rows.map((/** @type {any} */ entry) => entry.score?.absoluteError).filter(finite);
    const covers = rows.map((/** @type {any} */ entry) => entry.score?.covered).filter((/** @type {unknown} */ value) => typeof value === "boolean");
    return {
      available: true, scored,
      probability: { n: probabilistic.length, brierMean: mean(probabilistic.map((/** @type {any} */ entry) => entry.score?.brier).filter(finite)), bins },
      estimate: { n: errors.length, meanAbsoluteError: mean(errors), coverage: { n: covers.length, rate: covers.length ? covers.filter(Boolean).length / covers.length : null } },
    };
  }

  /** The observation a score leaves on the method that made the prediction (the module's own observation records). @param {any} record @param {Record<string, any>} score */
  async function observe(record, score) {
    const methodId = record.methodId ?? `${record.source}:unspecified`;
    const id = `evolution-observation-${sha(["prediction-score", methodId, record.registryKey, record.endpointKey, record.payloadHash]).slice(0, 32)}`;
    await evolution.save("observation", id, { kind: "prediction-score", methodId, source: record.source, scoreKinds: Object.keys(score).sort(), ...score, at: now().toISOString(), origin: "tool-result" });
  }

  /**
   * Told by the evolution module of every paper the feed publishes (`matchProspectivePublication`): the registrations naming a trial the paper
   * names are scored against the value extracted from it, if they were recorded before it was public. Never throws: the evolution loop that
   * told us goes on whatever happens here.
   * @param {{ paper: any, eventId?: string }} input
   */
  async function onPublication({ paper }) {
    if (!enabled) return { matched: 0 };
    try {
      const db = database();
      if (!db || !paper) return { matched: 0 };
      const keys = identifierKeysInText([paper.identity, paper.title, paper.url, paper.excerpt].filter((part) => typeof part === "string").join("\n")).filter((key) => key.startsWith("reg:"));
      if (!keys.length) return { matched: 0 };
      const waiting = (await db.query("SELECT id,user_id,payload FROM evimed_product.documents WHERE kind='knowledge' AND deleted_at IS NULL AND payload->>'recordType'='evolution-prospective' AND payload->>'source' = ANY($1::text[]) AND payload->>'status'='waiting-publication' AND payload->>'registryKey' = ANY($2::text[])",
        [[...PREDICTION_SOURCES], keys])).rows;
      const publicAt = Date.parse(paper.firstPublicAt ?? paper.publishedAt ?? "");
      for (const entry of waiting) {
        /** @param {string} outcome */
        const done = (outcome) => { counters.outcomes[outcome] += 1; };
        try {
          const record = entry.payload;
          if (!Number.isFinite(publicAt)) { done("no_publication_date"); continue; }
          // Only a prediction recorded before the result was public is a prediction.
          if (Date.parse(record.recordedAt) >= publicAt) {
            const current = await evolution.get(entry.id, entry.user_id);
            await evolution.save("prospective", entry.id, { ...record, status: "ineligible-after-result", reason: "recorded_after_publication", judgedAt: now().toISOString() }, current, entry.user_id);
            done("ineligible_after_result"); continue;
          }
          if (!extractPublished) { done("extractor_unavailable"); continue; }
          const published = await extractPublished({ registration: { id: entry.id, ...record }, paper });
          if (!published?.ok) { done("extraction_failed"); continue; }
          const score = scorePrediction(record.prediction, published);
          if (!Object.keys(score).length) { done("extraction_failed"); continue; }
          const current = await evolution.get(entry.id, entry.user_id);
          await evolution.save("prospective", entry.id, { ...record, status: "scored", score: { ...score, scoredAt: now().toISOString() },
            actual: { ...(finite(published.value) ? { value: published.value } : {}), ...(typeof published.met === "boolean" ? { met: published.met } : {}), quote: published.quote ?? null, metQuote: published.metQuote ?? null,
              sourceUrl: typeof paper.url === "string" ? paper.url : null, paperId: paper.id ?? null, firstPublicAt: new Date(publicAt).toISOString(), textHash: sha(String(paper.excerpt ?? "")) } }, current, entry.user_id);
          await observe(record, score);
          counters.scored += 1; done("scored");
        } catch (error) {
          counters.outcomes.error += 1;
          report(`prediction registry ${entry.id}: ${typeof error?.code === "string" ? error.code : "failed"}`);
        }
      }
      return { matched: waiting.length };
    } catch (error) {
      counters.outcomes.error += 1;
      report(`prediction registry publication: ${typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "failed"}`);
      return { matched: 0 };
    }
  }

  return { enabled, register, registerAgendaPrediction, read, listOwn, publicScored, predictionCalibration, onPublication, status: () => ({ enabled, counters: structuredClone(counters) }) };
}

/** The operator-metric families of the registry, with the module off and nothing to read reporting zero. @param {ReturnType<typeof createPredictionRegistry> | null} registry @param {any} config */
export function predictionRegistryMetricFamilies(registry, config) {
  const status = registry?.status();
  return [
    { name: "open_science_prediction_registry_enabled", type: "gauge", help: "Whether the prediction registry is switched on (OPEN_SCIENCE_PREDICTION_REGISTRY_ENABLED).", series: [{ value: config?.predictionRegistryEnabled === true ? 1 : 0 }] },
    { name: "open_science_prediction_registrations_total", type: "counter", help: "Predictions registered by this process.", series: [{ value: status?.counters.registered ?? 0 }] },
    { name: "open_science_prediction_scored_total", type: "counter", help: "Registered predictions scored against a published result by this process.", series: [{ value: status?.counters.scored ?? 0 }] },
    { name: "open_science_prediction_publication_outcomes_total", type: "counter", help: "Registrations a published paper woke, by what became of them.",
      series: PREDICTION_PUBLICATION_OUTCOMES.map((outcome) => ({ value: status?.counters.outcomes[outcome] ?? 0, labels: { outcome } })) },
  ];
}
