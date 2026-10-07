// The monthly figures the public pages and the API publish (flywheel F08, plan §8, 2026-10-06): `monthlyEvidenceFigures` for each of the
// last twelve months that have data.
//
// Hidden knowledge:
//
// - **Recomputed, then remembered for ten minutes.** The pass rate checks every published card's claims against its sources, which is
//   too much to do per page view and too little to be worth storing: the answer for all twelve months is built once, shared by every
//   request that arrives while it is being built (so a crowd costs one computation, not one each) and reused until it is ten minutes old.
//   Nothing is stored in a table — a figure that cannot be recomputed from the tables is not published (`evidenceFigures.mjs`).
// - **A month with no data says so.** The months run from the first month the tables have anything for (a card revision, a log entry or
//   a challenge) to the current one, newest first, at most twelve; a month inside that range with no claims, no corrections and no
//   challenges is `data: false` and the page writes “没有数据”, never 0.
// - **Months are Asia/Shanghai calendar months**, the platform's own day.
// - **Two more sections, each from a reader somebody else composes.** The medication-question bank's month (per-class accuracy and the share
//   of cited answers that cited an EviMed page: `questionBankSummary`, composed only where 循证 GEO and its question-bank lever are on) and the
//   prediction registry's calibration (`predictionCalibration`, composed only with its switches) are handed in as functions. A reader that is
//   absent, answers nothing or fails leaves its section out and the three figures as they were; a calibration that is not yet available says how
//   many predictions are scored and that the overall calibration is published from `PREDICTION_CALIBRATION_MIN_SCORED`. They are remembered for ten
//   minutes like the figures.

import { monthlyEvidenceFigures } from "./evidenceFigures.mjs";
import { PREDICTION_CALIBRATION_MIN_SCORED } from "./predictionRegistry.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

const MONTHS = 12;
const DEFAULT_TTL_MS = 600_000;

/** `YYYY-MM` of an instant in Asia/Shanghai. @param {Date} instant */
export function evidencePublicMonth(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

/** @param {string} month @param {number} delta */
function shiftMonth(month, delta) {
  const [year, index] = month.split("-").map(Number);
  const total = year * 12 + (index - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** @param {any} entry one row of the bank's summary, reduced to the numbers a reader is shown */
const bankRow = (entry) => ({
  answers: Number(entry?.answers ?? 0), judged: Number(entry?.judged ?? 0), decided: Number(entry?.decided ?? 0), correct: Number(entry?.correct ?? 0), wrong: Number(entry?.wrong ?? 0),
  rate: typeof entry?.rate === "number" ? entry.rate : null, cited: Number(entry?.cited ?? 0), citedEviMed: Number(entry?.citedEviMed ?? 0),
  eviMedCitedShare: typeof entry?.eviMedCitedShare === "number" ? entry.eviMedCitedShare : null,
});

/** The bank's month as the public page and API carry it: classes and the whole, with which assistants were asked. @param {any} summary */
function publicBank(summary) {
  return {
    month: String(summary.month), bankVersion: summary.bankVersion ?? null,
    classes: (Array.isArray(summary.classes) ? summary.classes : []).map((/** @type {any} */ entry) => ({ class: String(entry.class), label: String(entry.label ?? entry.class), ...bankRow(entry) })),
    overall: bankRow(summary.overall),
    coverage: Object.fromEntries(Object.entries(summary.coverage ?? {}).map(([engine, mark]) => [engine, { state: String(/** @type {any} */ (mark)?.state ?? "") }])),
  };
}

/** The calibration as the public page and API carry it, with the number it waits for. @param {any} value */
function publicCalibration(value) {
  const base = { scored: Number(value?.scored ?? 0), minScored: PREDICTION_CALIBRATION_MIN_SCORED };
  if (value?.available !== true) return { available: false, ...base };
  const number = (/** @type {unknown} */ entry) => (typeof entry === "number" && Number.isFinite(entry) ? entry : null);
  return {
    available: true, ...base,
    probability: {
      n: Number(value.probability?.n ?? 0), brierMean: number(value.probability?.brierMean),
      bins: (Array.isArray(value.probability?.bins) ? value.probability.bins : []).map((/** @type {any} */ bin) => ({ from: Number(bin.from), to: Number(bin.to), n: Number(bin.n), meanPredicted: number(bin.meanPredicted), observedRate: number(bin.observedRate) })),
    },
    estimate: { n: Number(value.estimate?.n ?? 0), meanAbsoluteError: number(value.estimate?.meanAbsoluteError), coverage: { n: Number(value.estimate?.coverage?.n ?? 0), rate: number(value.estimate?.coverage?.rate) } },
  };
}

/**
 * @param {{ database: any, now?: () => Date, ttlMs?: number, figures?: (query: { month: string }) => Promise<any>,
 *   questionBank?: ((query: { month: string }) => Promise<any>) | null, predictionCalibration?: (() => Promise<any>) | null, report?: (code: string) => void }} options
 *   `figures` is the month's computation; the default is the domain's own, over the database. `questionBank` and `predictionCalibration` are the
 *   readers of the two optional sections; absent, the section is not there. `report` hears a section whose reader failed.
 */
export function createEvidencePublicMetrics({ database, now = () => new Date(), ttlMs = DEFAULT_TTL_MS, figures = (query) => monthlyEvidenceFigures(database, query), questionBank = null, predictionCalibration = null, report = () => {} }) {
  const counters = { computed: 0, cacheHits: 0, failures: 0, sectionFailures: 0 };
  /** @type {{ at: number, value: any[] } | null} */
  let cached = null;
  /** @type {Promise<any[]> | null} */
  let building = null;

  async function build() {
    await migrateEvidenceZones(database);
    const first = (await database.query(
      `SELECT least(
         (SELECT min(recorded_at) FROM evimed_frontier.evidence_card_revisions),
         (SELECT min(occurred_at) FROM evimed_frontier.evidence_change_log),
         (SELECT min(created_at) FROM evimed_frontier.evidence_challenges)) AS first`)).rows[0]?.first;
    if (!first) return [];
    const current = evidencePublicMonth(now());
    const earliest = evidencePublicMonth(new Date(first));
    /** @type {{ month: string, data: boolean, figures: any }[]} */
    const months = [];
    for (let back = 0; back < MONTHS; back += 1) {
      const month = shiftMonth(current, -back);
      if (month < earliest) break;
      const value = await figures({ month });
      const data = value.verification.claims > 0 || value.corrections.entries > 0 || value.challenges.filed > 0;
      months.push({ month, data, figures: data ? value : null });
    }
    return months;
  }

  /**
   * An optional section: its reader's answer remembered for the ttl and shared by every request that arrives while it is being read. A reader
   * that is absent, answers nothing or throws is a section that is not there; the failure is counted and nothing else on the page moves.
   * @param {(() => Promise<any>) | null} read
   */
  function section(read) {
    /** @type {{ at: number, value: any } | null} */
    let kept = null;
    /** @type {Promise<any> | null} */
    let reading = null;
    return async () => {
      if (!read) return null;
      if (kept && now().getTime() - kept.at < ttlMs) return kept.value;
      if (!reading) {
        reading = read().catch(() => { counters.sectionFailures += 1; report("evidence_public_section_failed"); return null; })
          .then((value) => { kept = { at: now().getTime(), value }; return value; })
          .finally(() => { reading = null; });
      }
      return reading;
    };
  }

  // The bank's month is the current one, or the one before while the current has no answers yet.
  const bank = section(questionBank ? async () => {
    const current = evidencePublicMonth(now());
    for (const month of [current, shiftMonth(current, -1)]) {
      const summary = await questionBank({ month });
      if (summary?.available === true && Number(summary.overall?.answers) > 0) return publicBank(summary);
    }
    return null;
  } : null);
  const calibration = section(predictionCalibration ? async () => {
    const value = await predictionCalibration();
    return value ? publicCalibration(value) : null;
  } : null);

  return {
    /** The last twelve months, newest first, each with its figures or `data: false`. */
    async months() {
      if (cached && now().getTime() - cached.at < ttlMs) { counters.cacheHits += 1; return cached.value; }
      if (!building) {
        building = build().then((value) => { cached = { at: now().getTime(), value }; counters.computed += 1; return value; })
          .catch((error) => { counters.failures += 1; throw error; })
          .finally(() => { building = null; });
      }
      return building;
    },
    /** The question bank's latest month, or null where there is none to show. */
    questionBank: bank,
    /** The prediction registry's calibration (or how many predictions are scored so far), or null where the registry is not composed. */
    predictionCalibration: calibration,
    stats: () => ({ ...counters }),
  };
}
