/**
 * The numbers an extracted value carries, held against each other (algorithm round E2): the rows of `evidence_items` read as the domain's
 * `extractedValueConsistency` wants them, and its findings turned into the notes a run reads in the answer of a write and a person reads
 * as a ⚠ on the card.
 *
 * Hidden knowledge:
 *
 * - **Advice, never a refusal.** The value is saved and cited as it was read; a finding is a sentence about two numbers that do not agree
 *   (owner rulings 2026-09-17, 2026-10-10: a verdict never withholds a delivery). Nothing reads a finding to decide a pool, a card or a
 *   result.
 * - **Nothing is stored.** The check is a pure function of the rows, so the page recomputes it from the study's evidence items each time it
 *   is read: a finding appears for a value saved before this check existed, and disappears when the value is replaced by a corrected one.
 *   A card carries the findings of the evidence it cites.
 * - **The parameter vocabulary is the pipeline's, copied by name.** Which quantity is a ratio (interval symmetric on the log scale), which
 *   a difference or a mean (symmetric on the plain scale), which has a null and which is a share of people lives in `QUANTITIES`, keyed by
 *   the names of `VCR_PARAMETER_KINDS`/the registry's extraction; a test holds every name to that list. A parameter that is in none of them
 *   is held to the one check that needs nothing about it: the estimate is inside its own interval, and the counts fit.
 * - **A p-value comes from two places.** A registry states it as text (`detail.pValue`, "<0.001"), parsed here by its format; a run states it
 *   as a number with its relation, and the platform keeps it only when the number is in the quotation (`addEvidenceItem`), like every other
 *   number on the item.
 * - **Counts of participants are sizes.** A registry's enrolment and participant-flow rows carry the count as their value; they are read
 *   as the sample size of the arm or the trial they describe, which is what the arms-against-total check compares.
 *
 * @module vcrValueChecks
 */

import { extractedValueConsistency } from "@evimed/domain";

import { PARAMETER_LABELS } from "./vcrViewsKit.mjs";

/**
 * What each parameter's interval looks like and what no effect is for it. `scale` is the scale on which a published interval is symmetric
 * about its estimate; `nullValue` the value that means no effect.
 * @type {Readonly<Record<string, { scale: 'log' | 'identity', nullValue: number | null }>>}
 */
export const QUANTITIES = Object.freeze({
  hazard_ratio: { scale: "log", nullValue: 1 },
  odds_ratio: { scale: "log", nullValue: 1 },
  risk_ratio: { scale: "log", nullValue: 1 },
  mean_difference: { scale: "identity", nullValue: 0 },
  risk_difference: { scale: "identity", nullValue: 0 },
  mean_value: { scale: "identity", nullValue: null },
  least_squares_mean: { scale: "identity", nullValue: null },
});

/** The parameters that are a share of people which `events / sampleSize` must come to (a survival at a time is not: censoring). */
export const RATE_PARAMETERS = Object.freeze(["control_event_rate", "response_rate", "dropout_rate", "screen_failure_rate"]);

/** The parameters whose value is itself a count of people, read as the sample size of the arm or the trial. */
const COUNT_OF_PEOPLE = /^(?:enrollment_|arm_)/;

/** @param {unknown} value @returns {number | null} */
function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A printed p-value, by its format: a number with its relation, or the registry's text ("0.0123", "<0.001", "= .03").
 * @param {unknown} printed @param {unknown} [relation]
 * @returns {{ pValue: number, pRelation: '=' | '<' | '>' } | null}
 */
export function parsePrintedP(printed, relation = null) {
  const bound = (/** @type {unknown} */ word) => (word === "<" || word === "≤" ? "<" : word === ">" || word === "≥" ? ">" : "=");
  if (typeof printed === "number") {
    return Number.isFinite(printed) && printed >= 0 && printed <= 1 ? { pValue: printed, pRelation: bound(relation) } : null;
  }
  const match = /^\s*([<>≤≥]?)\s*=?\s*(\d*\.?\d+(?:e-?\d+)?)\s*$/i.exec(String(printed ?? ""));
  const parsed = match ? Number(match[2]) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? { pValue: parsed, pRelation: bound(match?.[1]) } : null;
}

/**
 * An evidence item's row as the consistency check reads it.
 * @param {Record<string, any>} row a stored `evidence_items` row
 * @returns {Parameters<typeof extractedValueConsistency>[0][number]}
 */
export function extractedValueOfRow(row) {
  const parameter = String(row.parameter ?? "");
  const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
  const quantity = QUANTITIES[parameter];
  const value = finite(row.value);
  const count = COUNT_OF_PEOPLE.test(parameter) ? value : null;
  const printed = parsePrintedP(detail.pValue, detail.pRelation);
  return {
    id: String(row.id ?? ""),
    label: PARAMETER_LABELS[parameter] ?? null,
    arm: row.arm ?? null,
    armRole: row.arm_role ?? row.armRole ?? null,
    ...(quantity ? { scale: quantity.scale, nullValue: quantity.nullValue } : {}),
    rate: RATE_PARAMETERS.includes(parameter),
    value: count === null ? value : null,
    unit: row.unit ?? null,
    ciLow: finite(row.ci_low ?? row.ciLow),
    ciHigh: finite(row.ci_high ?? row.ciHigh),
    ciLevel: finite(detail.confidenceLevel),
    ...(printed ?? {}),
    sampleSize: finite(row.sample_size ?? row.sampleSize) ?? count,
    // A count of participants with the event is its own events: it cannot be more than the people it was counted among.
    events: finite(row.events) ?? (parameter === "participants_with_event" ? value : null),
    trial: String(row.precedent_id ?? row.source_ref ?? ""),
    set: [parameter, row.endpoint_key, detail.outcome, detail.timeFrame, detail.period].map((part) => String(part ?? "")).join("|"),
    planned: row.enrollment_kind === "estimated",
  };
}

/**
 * Is this row a stored extraction that carries numbers (not a refused one, not a paper's "does not report it")?
 * @param {Record<string, any>} row
 */
function carriesNumbers(row) {
  const verification = String(row.locator?.verification ?? "");
  return (verification === "verified" || verification === "reported_unverified") && (finite(row.value) !== null || finite(row.sample_size) !== null);
}

/**
 * Every disagreement among the numbers of some evidence rows, newest row first (so of two rows for one arm the newer is the one compared),
 * each once. `only` keeps the findings that name one of those evidence ids.
 * @param {readonly Record<string, any>[]} rows
 * @param {{ only?: ReadonlySet<string> | null }} [options]
 * @returns {ReturnType<typeof extractedValueConsistency>}
 */
export function evidenceValueFindings(rows, { only = null } = {}) {
  const at = (/** @type {Record<string, any>} */ row) => { const time = new Date(row.created_at ?? 0).getTime(); return Number.isFinite(time) ? time : 0; };
  const newestFirst = rows.filter(carriesNumbers).sort((a, b) => at(b) - at(a));
  const seen = new Set();
  return extractedValueConsistency(newestFirst.map(extractedValueOfRow)).filter((finding) => {
    if (only && !finding.ids.some((id) => only.has(id))) return false;
    const key = `${finding.code}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
