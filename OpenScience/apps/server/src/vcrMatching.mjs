/**
 * 「虚拟临床研究」's two-way matching: a trial looking for patients and a patient
 * looking for trials are the same evaluation run from two ends (plan §7.1).
 *
 * Hidden knowledge:
 *
 * - **The verdict is computed, never generated.** The model's whole job here is
 *   to turn free text into located facts and to answer the criteria that are
 *   only decidable by reading language. Every combination, every threshold,
 *   every window and every overall summary is arithmetic in this file
 *   (principle 1). Wornow et al. measured why: clinicians found GPT-4's
 *   explanations coherent in 97% of its *correct* judgments and still 75% of
 *   its *wrong* ones — a wrong judgment arrives wearing a good argument, so the
 *   argument cannot be what we check.
 * - **Four states, three of them logic.** `satisfied` / `not_satisfied` /
 *   `unknown` are Kleene's strong three-valued logic, and the truth tables
 *   below are that algebra exactly. `pending_recheck` is not a fourth truth
 *   value: it is an `unknown` that carries a date on which it will stop being
 *   unknown (a washout that ends on 11-03). It never rounds up to `satisfied`
 *   before that date, which is the whole point of having it — without it the
 *   only ways to record "will qualify soon" are to lie now or to forget.
 * - **`not_applicable` is a boolean beside the state, not a state.** Folding it
 *   into `unknown` is one of TrialGPT's own named error classes (26.9% of its
 *   criterion-level errors were "insufficient information" confused with "not
 *   applicable"), and the two demand opposite actions: one says go find a
 *   document, the other says stop looking.
 * - **Absence of evidence is not evidence of absence.** A washout requirement
 *   with no treatment history is `unknown`, never `satisfied`. But a *recorded
 *   denial* ("否认心梗史") and a *recorded event outside the window* ("7 个月前
 *   心梗") are both positive evidence that the window is clear, and both read
 *   `satisfied`. Those three readings are the minimal-edit perturbation set
 *   C2-19 exists to pin down.
 * - **A fact must be findable where it says it is.** The model hands back a
 *   document id, a character span and the surface form it read; this module
 *   re-reads the span. If the bytes are not there, the fact is void and every
 *   criterion that leaned on it falls back to `unknown` (C2-17). This is the
 *   only defence against a fabricated laboratory value, because a fabricated
 *   value looks exactly like a real one everywhere else.
 * - **Time travel is a filter, not a promise.** Replaying a historical match
 *   uses `visible_at <= asOf` and nothing else (AC-15). The three clocks are
 *   kept apart because a result recorded on Tuesday about Monday's blood draw
 *   was not knowable on Monday, and evaluating history with it manufactures a
 *   tool that cannot exist.
 * - **No imported accuracy threshold.** Evaluation describes the current
 *   cases. Independent rater agreement, when measured, is reported separately
 *   and does not establish a clinical accuracy ceiling (AC-36).
 *
 * @module vcrMatching
 */

import { clinicalFactPolarity, clinicalFactView, clinicalUnitToken, clinicalUnitInQuote, convertClinicalUnit } from "@evimed/domain";
import { createHash } from 'node:crypto';
import {
  canonicalScenarioJson, VCR_CRITERION_STATES, VCR_CRITERION_TYPES, VCR_ELIGIBILITY_SUMMARIES, VCR_MISSING_REASONS, validateRequirement,
} from "@evimed/domain";

/** Stable persisted input identity, including JSON date normalization. @param {any} value */
export const matchingInputDigest = value => createHash('sha256').update(canonicalScenarioJson(JSON.parse(JSON.stringify(value ?? null)))).digest('hex');
export const VCR_PRIVATE_MATCHING_PROVENANCE_KEYS = Object.freeze(['inputFactIds', 'inputLanguageIds', 'inputFactHashes', 'inputCriterionHashes', 'inputLanguageHashes', 'inputReferencesComplete']);
/** Only model/configuration identities belong in a public assessment projection. @param {any} provenance */
export function publicMatchingProvenance(provenance) {
  return provenance == null ? null : Object.fromEntries(Object.entries(provenance).filter(([key]) => !VCR_PRIVATE_MATCHING_PROVENANCE_KEYS.includes(key)));
}

/**
 * Why a criterion is `unknown` for a reason the evaluator itself found, on top
 * of the domain's own reasons for a missing fact. Each one says what would have
 * to change: a criterion written outside the grammar is the protocol step's to
 * fix, a code the vocabulary cannot read is the field map's, a number with no
 * unit cannot be compared to one that names a unit, and a fact with no date
 * cannot decide a question about a window (contract §2.2).
 */
export const VCR_EVALUATOR_UNKNOWN_REASONS = Object.freeze([
  "criterion_malformed", "coding_unmapped", "coding_version_unavailable", "unit_missing", "unit_mismatch", "undated", "evaluation_error", "conflicting_evidence",
]);
/** Every reason a gap may carry. */
const GAP_REASONS = Object.freeze([...VCR_MISSING_REASONS, ...VCR_EVALUATOR_UNKNOWN_REASONS]);

/** The three truth values, plus the deferral. Spelled out so a reader of this file need not look. */
export const SATISFIED = "satisfied";
export const NOT_SATISFIED = "not_satisfied";
export const UNKNOWN = "unknown";
export const PENDING_RECHECK = "pending_recheck";

/** Every state this module may produce, in the order a funnel shows them. */
export const VCR_MATCHING_STATES = Object.freeze([SATISFIED, NOT_SATISFIED, UNKNOWN, PENDING_RECHECK]);

/**
 * Why a model-extracted fact was thrown away. A void fact never becomes a
 * `not_satisfied`: it becomes an `unknown` with the reason attached, because a
 * fact we could not confirm is a fact we do not have.
 */
export const VCR_FACT_VOID_REASONS = Object.freeze([
  "locator_missing", "document_unavailable", "span_out_of_range", "quote_mismatch",
  "surface_missing", "value_not_in_span", "date_not_in_span", "not_yet_visible", "polarity_not_assertive",
]);

/** Polarities that may be reasoned from. A family history or a plan is not a finding. */
export const VCR_ASSERTIVE_POLARITIES = Object.freeze(["affirmed", "negated"]);

/** The layers a criterion-level error is stratified by (plan §7.1, attachment C2 failure modes). */
export const VCR_ERROR_LAYERS = Object.freeze(["time", "number", "negation", "logic", "applicability", "other"]);

/** How a criterion type maps onto an error layer, for the stratified confusion report. */
const LAYER_BY_TYPE = Object.freeze({
  time_window: "time", lab: "number", biomarker: "number", performance_status: "number",
  prior_treatment: "negation", concomitant_medication: "negation", comorbidity: "negation",
  pregnancy: "applicability", demographic: "applicability", consent_capacity: "other",
  diagnosis: "logic", other: "other",
});

// ---------------------------------------------------------------------------
// Kleene's strong three-valued logic, plus the deferral (C2-15)
// ---------------------------------------------------------------------------

/**
 * `pending_recheck` is an `unknown` wearing a date. Every truth table below
 * folds it to `unknown` to decide the value — so `F ∧ P` is a definite `F` and
 * `T ∨ P` is a definite `T`, exactly as they would be with `U`. When the value
 * comes out indeterminate the date is put back **only if every indeterminate
 * part was a deferral**: `P ∧ U` is a plain unknown, because a document is
 * still owed and a date does not settle that. Read as `P` it would hide the
 * gap, and a subject would wait for a washout to end while the missing
 * document that also blocks them went unasked.
 * @param {string} state
 */
const truth = (state) => (state === PENDING_RECHECK ? UNKNOWN : state);

/** @param {string[]} states @param {string} value */
const restorePending = (states, value) =>
  (value === UNKNOWN && states.includes(PENDING_RECHECK) && !states.includes(UNKNOWN) ? PENDING_RECHECK : value);

/**
 * Kleene AND: false wins, then true, then unknown.
 * @param {...string} states @returns {string}
 */
export function kleeneAnd(...states) {
  const values = states.map(truth);
  if (!values.length) return SATISFIED; // the empty conjunction is true
  if (values.includes(NOT_SATISFIED)) return NOT_SATISFIED;
  if (values.every((value) => value === SATISFIED)) return SATISFIED;
  return restorePending(states, UNKNOWN);
}

/**
 * Kleene OR: true wins, then false, then unknown.
 * @param {...string} states @returns {string}
 */
export function kleeneOr(...states) {
  const values = states.map(truth);
  if (!values.length) return NOT_SATISFIED; // the empty disjunction is false
  if (values.includes(SATISFIED)) return SATISFIED;
  if (values.every((value) => value === NOT_SATISFIED)) return NOT_SATISFIED;
  return restorePending(states, UNKNOWN);
}

/**
 * Kleene NOT: `unknown` is its own negation, and so is a deferral — the date
 * on which the evidence arrives does not move because the sentence was
 * inverted.
 * @param {string} state @returns {string}
 */
export function kleeneNot(state) {
  if (state === SATISFIED) return NOT_SATISFIED;
  if (state === NOT_SATISFIED) return SATISFIED;
  return state === PENDING_RECHECK ? PENDING_RECHECK : UNKNOWN;
}

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {number|null} */
export function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const DAY_MS = 86_400_000;

/** @param {number} from @param {number} to */
export function daysBetween(from, to) { return (to - from) / DAY_MS; }

/**
 * The start of a look-back window. Calendar months, not 30-day blocks: 「近 6
 * 个月」 on 2026-09-28 begins on 2026-03-28, and an event on 2026-02-28 is
 * outside it. Thirty-day arithmetic would have moved that boundary by nine
 * days and flipped C2-19's third case.
 * @param {{ days?: number, months?: number, years?: number }} window @param {number} anchor
 * @returns {number|null}
 */
export function windowStart(window, anchor) {
  if (!window || typeof window !== "object") return null;
  if (window.days == null && window.months == null && window.years == null) return null;
  const at = new Date(anchor);
  const years = Number(window.years);
  if (Number.isFinite(years)) at.setUTCFullYear(at.getUTCFullYear() - years);
  // Calendar months overflow the way JavaScript's do: 8-31 minus one month is
  // 3 March, not 31 February. Protocols write 「近 6 个月」 and mean the same
  // day six months back, which this gives; the month-end case is off by up to
  // three days and is called out in the criterion's own note when it matters.
  const months = Number(window.months);
  if (Number.isFinite(months)) at.setUTCMonth(at.getUTCMonth() - months);
  const days = Number(window.days);
  return at.getTime() - (Number.isFinite(days) ? days : 0) * DAY_MS;
}

/**
 * Is this fact inside the window? `null` means the fact carries no date and the
 * window needs one — which is an `unknown`, never a pass.
 * @param {any} fact @param {any} window @param {number} anchor
 * @returns {boolean|null}
 */
export function withinWindow(fact, window, anchor) {
  if (!window) return true;
  const start = windowStart(window, Number.isFinite(instant(window.anchorDate)) ? instant(window.anchorDate) : anchor);
  if (start === null) return true;
  const at = instant(fact?.occurredAt);
  if (at === null) return null;
  const end = Number.isFinite(instant(window.anchorDate)) ? instant(window.anchorDate) : anchor;
  return at >= start && at <= end;
}

// ---------------------------------------------------------------------------
// Evidence: a fact must be findable where it says it is (C2-17)
// ---------------------------------------------------------------------------

/** Numbers as they appear in a Chinese or English chart, thousands separators and all. */
const NUMERAL = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/** @param {string} text @returns {number[]} */
function numeralsIn(text) {
  return [...String(text ?? "").matchAll(NUMERAL)].map((match) => Number(match[0].replaceAll(",", "")));
}

/**
 * Re-read the span the model says it read.
 *
 * The check is deliberately literal: the document's own bytes between `start`
 * and `end` must equal the quote, the quote must contain the surface form the
 * fact claims, and a numeric fact's value must be one of the numbers actually
 * printed there. A model that invents 「肌酐 1.2 mg/dL」 for a patient whose
 * chart says 2.4 fails the last of those three and nothing else would have
 * caught it.
 *
 * @param {any} fact
 * @param {{ documents?: Map<string, any> | Record<string, any>, asOf?: number|string|Date }} context
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifyFactEvidence(fact, context = {}) {
  const asOf = instant(context.asOf) ?? Number.POSITIVE_INFINITY;
  if (!VCR_ASSERTIVE_POLARITIES.includes(String(fact?.polarity ?? "affirmed"))) {
    return { ok: false, reason: "polarity_not_assertive" };
  }
  const visibleAt = instant(fact?.visibleAt);
  if (visibleAt !== null && visibleAt > asOf) return { ok: false, reason: "not_yet_visible" };

  // A structured fact comes out of a frozen snapshot and is located by column,
  // not by character span: the data plane already holds the bytes it came from.
  if (String(fact?.extractedBy ?? "model") !== "model") return { ok: true, reason: null };

  const source = fact?.source;
  if (!source || typeof source !== "object" || !source.documentId
    || !Number.isInteger(source.start) || !Number.isInteger(source.end)) {
    return { ok: false, reason: "locator_missing" };
  }
  const documents = context.documents instanceof Map
    ? context.documents
    : new Map(Object.entries(context.documents ?? {}));
  const document = documents.get(String(source.documentId));
  if (!document) return { ok: false, reason: "document_unavailable" };
  const text = String(document.text ?? "");
  if (source.start < 0 || source.end > text.length || source.start >= source.end) {
    return { ok: false, reason: "span_out_of_range" };
  }
  const span = text.slice(source.start, source.end);
  if (typeof source.quote === "string" && source.quote !== span) return { ok: false, reason: "quote_mismatch" };

  const surfaces = [fact?.surface, ...(Array.isArray(fact?.surfaceForms) ? fact.surfaceForms : [])]
    .filter((item) => typeof item === "string" && item.trim());
  if (!surfaces.length) return { ok: false, reason: "surface_missing" };
  if (!surfaces.some((surface) => span.includes(surface))) return { ok: false, reason: "value_not_in_span" };

  if (typeof fact?.value === "number" && Number.isFinite(fact.value)) {
    if (!numeralsIn(span).some((number) => Math.abs(number - fact.value) < 1e-9)) {
      return { ok: false, reason: "value_not_in_span" };
    }
  }
  if (typeof fact?.dateSurface === "string" && fact.dateSurface.trim() && !span.includes(fact.dateSurface)) {
    return { ok: false, reason: "date_not_in_span" };
  }
  if (clinicalUnitInQuote(fact.unit,span) === false) return {ok:false,reason:'unit_not_in_span'};
  const original = fact.clinical?.laboratory;
  if (original?.originalValue != null && !numeralsIn(span).some(number => Math.abs(number-original.originalValue)<1e-9)) return {ok:false,reason:'value_not_in_span'};
  if (original?.originalUnit && clinicalUnitInQuote(original.originalUnit,span) === false) return {ok:false,reason:'unit_not_in_span'};
  return { ok: true, reason: null };
}

/**
 * Split the model's facts into the ones a judgment may rest on and the ones
 * that are void, each with its reason. Both halves are returned: a void fact is
 * a measurable event, and silently dropping it would hide the extraction's
 * error rate.
 *
 * @param {readonly any[]} facts
 * @param {{ documents?: Map<string, any> | Record<string, any>, asOf?: number|string|Date }} context
 * @returns {{ facts: any[], voided: { factId: string, variable: string, reason: string }[] }}
 */
export function admissibleFacts(facts, context = {}) {
  /** @type {any[]} */
  const kept = [];
  /** @type {{ factId: string, variable: string, reason: string }[]} */
  const voided = [];
  for (const fact of facts ?? []) {
    const verdict = verifyFactEvidence(fact, context);
    if (verdict.ok) kept.push(fact);
    else voided.push({ factId: String(fact?.id ?? ""), variable: String(fact?.variable ?? ""), reason: verdict.reason });
  }
  return { facts: kept, voided };
}

/**
 * The as-of view: only what the platform could see by `asOf` (AC-15, C2-18).
 * A fact with no `visibleAt` is treated as always visible, which is right for
 * structured rows frozen into a snapshot and is why an extraction without the
 * clock is refused upstream rather than defaulted here.
 * @param {readonly any[]} facts @param {number|string|Date} asOf
 */
export function factsVisibleAt(facts, asOf) {
  const at = instant(asOf);
  if (at === null) return [...(facts ?? [])];
  return (facts ?? []).filter((fact) => {
    const visibleAt = instant(fact?.visibleAt);
    return visibleAt === null || visibleAt <= at;
  });
}

// ---------------------------------------------------------------------------
// Requirement evaluation
// ---------------------------------------------------------------------------

/** @typedef {{ state: string, evidence: any[], missing: { variable: string, reason: string }[], recheckAt: string|null }} RequirementVerdict */

/** @param {string} state @param {Partial<RequirementVerdict>} [extra] @returns {RequirementVerdict} */
const verdict = (state, extra = {}) =>
  ({ state, evidence: extra.evidence ?? [], missing: extra.missing ?? [], recheckAt: extra.recheckAt ?? null });

/**
 * An `unknown` that says why. Every path of the evaluator that cannot decide
 * ends here, so the reason a coordinator reads is the reason the code had.
 * @param {string} variable @param {string} reason @param {any[]} [evidence]
 */
const unknownBecause = (variable, reason, evidence = []) => verdict(UNKNOWN, { missing: [{ variable, reason }], evidence });

/**
 * What a judgment cites.
 *
 * A fact read out of free text cites the sentence and the character span. A
 * fact read out of a frozen snapshot has no sentence, so it cites the cell —
 * `age = 67 year` with the snapshot id and the column beside it. That is a
 * rendering of the stored value, not a quotation of anything, and it is
 * checkable in the same way: open the snapshot at that field. Leaving the quote
 * empty instead would make every structured judgment look unanchored, which is
 * the one thing an anchoring check must not do.
 * @param {any} fact
 */
const citation = (fact) => {
  const spoken = fact?.source?.quote ?? fact?.surface ?? null;
  // A cell of the subject table is read to judge and is not written down: its evidence names the column and not the value, so a
  // reader who may see a candidate's states may not read the candidate's age off them (`vcrMatchingTable.mjs`).
  const rendered = fact?.hideValue === true
    ? `${String(fact?.variable ?? "")}（数据表列 ${String(fact?.snapshot?.field ?? "")}）`
    : `${String(fact?.variable ?? "")} = ${String(fact?.value ?? "")}${fact?.unit ? ` ${fact.unit}` : ""}`;
  return {
    factId: String(fact?.id ?? ""),
    variable: String(fact?.variable ?? ""),
    quote: spoken ? String(spoken) : rendered,
    quoteKind: spoken ? "verbatim" : "snapshot_cell",
    locator: fact?.source
      ? { documentId: String(fact.source.documentId ?? ""), start: fact.source.start ?? null, end: fact.source.end ?? null }
      : { snapshotId: String(fact?.snapshot?.id ?? ""), field: String(fact?.snapshot?.field ?? String(fact?.variable ?? "")) },
    occurredAt: fact?.occurredAt ?? null,
    visibleAt: fact?.visibleAt ?? null,
    polarity: String(fact?.polarity ?? "affirmed"),
  };
};

/** The earliest of several deferral dates: the first moment the whole thing could change. */
const earliest = (dates) => {
  const times = dates.filter(Boolean).map((date) => instant(date)).filter((time) => time !== null);
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
};

/**
 * Evaluate one structured requirement against the subject's admissible facts.
 *
 * The grammar is closed (`validateRequirement` in the domain, contract §2.2) and
 * so is what the evaluator does with anything outside it: a requirement the
 * grammar does not admit is `unknown` with the reason `criterion_malformed` —
 * never a guess at what it meant, never a verdict. Everything a protocol says
 * that does not fit becomes `language`, is answered by the model with a located
 * quote, and is marked as such in the judgment, so the share of a study's
 * criteria that code could not decide is a number the evaluation report carries
 * rather than a thing nobody counted.
 *
 * @param {any} node
 * @param {{ facts: readonly any[], asOf: number, documents?: any, modelJudgments?: Record<string, any>, criterionId?: string, unitConverter?: (value: number, from: string, to: string, variable?: string) => number|null }} context
 * @returns {RequirementVerdict}
 */
export function evaluateRequirement(node, context) {
  if (!node || typeof node !== "object") return unknownBecause("", "criterion_malformed");
  if (validateRequirement(node).length) return unknownBecause(typeof node?.variable === "string" ? node.variable : "", "criterion_malformed");
  return evaluateNode(node, context);
}

/** @param {any} node @param {any} context @returns {RequirementVerdict} */
function evaluateNode(node, context) {
  if (['present', 'absent', 'compare', 'elapsed_since'].includes(node.op)) {
    const competing = factsFor(context, String(node.variable)).filter(fact => fact.conflicts?.length);
    if (competing.length) return unknownBecause(String(node.variable), 'conflicting_evidence', competing.map(citation));
  }
  switch (node.op) {
    case "all": case "any": {
      const parts = (Array.isArray(node.operands) ? node.operands : []).map((child) => evaluateNode(child, context));
      const states = parts.map((part) => part.state);
      const state = node.op === "all" ? kleeneAnd(...states) : kleeneOr(...states);
      return verdict(state, {
        evidence: parts.flatMap((part) => part.evidence),
        missing: state === SATISFIED || state === NOT_SATISFIED ? [] : parts.flatMap((part) => part.missing),
        recheckAt: state === PENDING_RECHECK ? earliest(parts.map((part) => part.recheckAt)) : null,
      });
    }
    case "not": {
      const inner = evaluateNode(node.operand, context);
      return verdict(kleeneNot(inner.state), { evidence: inner.evidence, missing: inner.missing, recheckAt: inner.recheckAt });
    }
    case "present": case "absent": return evaluatePresence(node, context);
    case "compare": return evaluateCompare(node, context);
    case "elapsed_since": return evaluateElapsed(node, context);
    case "language": return evaluateLanguage(node, context);
    default: return unknownBecause(String(node.variable ?? ""), "criterion_malformed");
  }
}

/** @param {any} context @param {string} variable */
function factsFor(context, variable) {
  return (context.facts ?? []).filter((fact) => String(fact?.variable ?? "") === String(variable ?? "")).map(fact => ({ ...fact, polarity: clinicalFactPolarity(fact) }));
}

/**
 * `present` / `absent`.
 *
 * The four readings that matter, and why (C2-19): a denial is evidence the
 * window is clear; an event dated inside the window is evidence it is not; an
 * event dated outside it is evidence the window is clear; an event with no date
 * at all cannot be placed and so decides nothing (`undated`). Silence is
 * `unknown` — which is what makes a missing treatment history fail a washout
 * instead of passing it (C2-16).
 * @param {any} node @param {any} context @returns {RequirementVerdict}
 */
function evaluatePresence(node, context) {
  const variable = String(node.variable ?? "");
  const all = factsFor(context, variable);
  if (!all.length) return unknownBecause(variable, "not_recorded");
  const affirmed = all.filter((fact) => String(fact?.polarity ?? "affirmed") === "affirmed");
  const negated = all.filter((fact) => fact?.polarity === "negated");
  const placed = affirmed.map((fact) => ({ fact, inside: withinWindow(fact, node.window, context.asOf) }));
  const inside = placed.filter((item) => item.inside === true).map((item) => item.fact);
  const undated = placed.filter((item) => item.inside === null).map((item) => item.fact);
  const outside = placed.filter((item) => item.inside === false).map((item) => item.fact);

  const wantPresent = node.op === "present";
  if (inside.length) {
    return verdict(wantPresent ? SATISFIED : NOT_SATISFIED, { evidence: inside.map(citation) });
  }
  if (undated.length) return unknownBecause(variable, "undated", undated.map(citation));
  if (negated.length || outside.length) {
    return verdict(wantPresent ? NOT_SATISFIED : SATISFIED, { evidence: [...negated, ...outside].map(citation) });
  }
  return unknownBecause(variable, "not_recorded");
}

/**
 * The small vocabularies coded values are read through. A fact holding a code
 * the vocabulary does not contain is `unknown` (`coding_unmapped`): comparing an
 * unread code as a string is how 「女」 fails to be 「female」 and a woman is
 * passed over for a pregnancy exclusion that applied to her.
 */
export const VCR_MATCHING_VOCABULARY_VERSION = "evimed-internal-sex-1";
export const VCR_CODE_VOCABULARIES = Object.freeze({
  sex: Object.freeze({
    male: Object.freeze(["male", "m", "man", "男", "男性", "1"]),
    female: Object.freeze(["female", "f", "woman", "女", "女性", "2"]),
  }),
});
/** Variables that share a vocabulary. */
const VOCABULARY_OF = Object.freeze(/** @type {Record<string, keyof typeof VCR_CODE_VOCABULARIES>} */ ({ sex: "sex", gender: "sex" }));

/** A code as a comparable token. @param {unknown} value */
const codeToken = (value) => String(value ?? "").normalize("NFKC").trim().toLowerCase();

/**
 * A code through its variable's vocabulary: the canonical word, or `null` when
 * the vocabulary does not contain it. A variable with no vocabulary maps to its
 * own token.
 * @param {string} variable @param {unknown} value @returns {string | null}
 */
export function codedValue(variable, value) {
  const token = codeToken(value);
  if (!token) return null;
  const vocabulary = VOCABULARY_OF[variable];
  if (!vocabulary) return token;
  const entries = /** @type {Record<string, readonly string[]>} */ (VCR_CODE_VOCABULARIES[vocabulary]);
  for (const [canonical, words] of Object.entries(entries)) if (words.includes(token)) return canonical;
  return null;
}

/** @param {unknown} unit */
const unitToken = clinicalUnitToken;
/** @param {number} value @param {string} from @param {string} to @param {string} variable
 * @param {((value:number,from:string,to:string,variable?:string)=>number|null)|undefined} custom */
function convertUnit(value, from, to, variable, custom) {
  const known = convertClinicalUnit(value, from, to, variable);
  if (known) return known.value;
  const supplied = custom ? custom(value, from, to, variable) : null;
  return supplied != null && Number.isFinite(supplied) ? supplied : null;
}

/** A fact's value as a number, when it is one (a plain numeric string is one). @param {unknown} value @returns {number | null} */
function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/** @param {any} node @param {any} context @returns {RequirementVerdict} */
function evaluateCompare(node, context) {
  const variable = String(node.variable ?? "");
  const affirmed = factsFor(context, variable).filter((fact) => String(fact?.polarity ?? "affirmed") === "affirmed");
  // A window needs a date: a fact with none is not inside it and not outside
  // it, so it decides nothing (`undated`), however recent the chart looks.
  const placed = affirmed.map((fact) => ({ fact, inside: withinWindow(fact, node.window, context.asOf) }));
  const candidates = placed.filter((item) => item.inside === true).map((item) => item.fact);
  if (!candidates.length) {
    const undated = placed.filter((item) => item.inside === null).map((item) => item.fact);
    return undated.length ? unknownBecause(variable, "undated", undated.map(citation)) : unknownBecause(variable, "not_measured");
  }
  const aggregate = String(node.aggregate ?? "latest");
  const dated = candidates.filter((fact) => instant(fact?.occurredAt) !== null);
  const ordered = [...dated].sort((a, b) => (instant(b?.occurredAt) ?? 0) - (instant(a?.occurredAt) ?? 0));
  if (aggregate === "latest" && !ordered.length && candidates.length > 1) {
    // Several values and none of them dated: which is the latest cannot be said.
    return unknownBecause(variable, "undated", candidates.map(citation));
  }
  if (aggregate === 'latest' && ordered.length > 1) {
    const tied = ordered.filter(fact => instant(fact.occurredAt) === instant(ordered[0].occurredAt));
    const compared = tied.map(fact => compareFact(node,fact,context));
    // A timestamp with no finer ordering cannot select whichever row happened
    // to arrive first. Agreement can answer the threshold; disagreement cannot.
    if (tied.length > 1) {
      if (compared.some(item => item.state !== compared[0].state)) return unknownBecause(variable,'conflicting_evidence',tied.map(citation));
      return verdict(compared[0].state,{evidence:tied.map(citation),missing:compared.flatMap(item=>item.missing)});
    }
  }
  const chosen = aggregate === "latest" ? [ordered[0] ?? candidates[0]] : (ordered.length === candidates.length ? ordered : candidates);

  /** @type {string[]} */
  const states = [];
  /** @type {any[]} */
  const evidence = [];
  /** @type {{ variable: string, reason: string }[]} */
  const missing = [];
  for (const fact of chosen) {
    const compared = compareFact(node, fact, context);
    states.push(compared.state);
    if (compared.state !== UNKNOWN) evidence.push(citation(fact));
    else missing.push(...compared.missing);
  }
  const state = aggregate === "all" ? kleeneAnd(...states) : aggregate === "any" ? kleeneOr(...states) : states[0];
  return verdict(state, { evidence, missing: state === UNKNOWN ? missing : [] });
}

/**
 * One fact against one threshold.
 *
 * A unit we cannot convert is `unknown`, never a comparison on the raw number,
 * and a fact with no unit against a criterion that names one is `unknown` too
 * (`unit_missing`): 106 with nothing beside it could be either creatinine unit.
 * @param {any} node @param {any} fact @param {any} context @returns {{ state: string, missing: { variable: string, reason: string }[] }}
 */
function compareFact(node, fact, context) {
  const variable = String(node.variable ?? "");
  const comparator = String(node.comparator ?? "eq");
  /** @param {string} reason */
  const cannot = (reason) => ({ state: UNKNOWN, missing: [{ variable, reason }] });
  const raw = fact.clinical?.laboratory?.originalValue ?? fact?.value;
  if (raw === null || raw === undefined || raw === "") return cannot("not_measured");
  if (fact?.source?.vocabularyVersion && fact.source.vocabularyVersion !== VCR_MATCHING_VOCABULARY_VERSION) return cannot('coding_version_unavailable');
  const expectedUnit = String(node.unit ?? "");
  const observedUnit = String(fact.clinical?.laboratory?.originalUnit ?? fact?.unit ?? "");
  let comparable = numericValue(raw);
  if (expectedUnit && comparable !== null) {
    if (!observedUnit) return cannot('unit_missing');
    if (unitToken(expectedUnit) !== unitToken(observedUnit)) {
      comparable = convertUnit(comparable,observedUnit,expectedUnit,variable,context.unitConverter);
      if (comparable === null) return cannot('unit_mismatch');
    }
  }

  if (comparator === "in" || comparator === "not_in" || comparator === "eq" || comparator === "ne") {
    const wanted = comparator === "in" || comparator === "not_in" ? (Array.isArray(node.value) ? node.value : [node.value]) : [node.value];
    // A number is compared as a number (2, 2.0 and "2" are one), a code as its
    // token through the variable's vocabulary.
    const number = comparable;
    let hit;
    if (VOCABULARY_OF[variable]) {
      const version = fact?.source?.vocabularyVersion ?? context.vocabularyVersion ?? VCR_MATCHING_VOCABULARY_VERSION;
      if (version !== VCR_MATCHING_VOCABULARY_VERSION) return cannot('coding_version_unavailable');
      const have = codedValue(variable, raw);
      if (have === null) return cannot("coding_unmapped");
      const want = wanted.map((item) => codedValue(variable, item));
      if (want.some((item) => item === null)) return cannot("coding_unmapped");
      hit = want.includes(have);
    } else if (number !== null && wanted.every((item) => numericValue(item) !== null)) {
      hit = wanted.some((item) => numericValue(item) === number);
    } else {
      hit = wanted.map(codeToken).includes(codeToken(raw));
    }
    const positive = comparator === "in" || comparator === "eq";
    return { state: positive === hit ? SATISFIED : NOT_SATISFIED, missing: [] };
  }

  const value = comparable;
  if (value === null) return cannot("not_measured");
  const bound = Number(node.value);
  const high = Number(node.highValue ?? node.value);
  const passes = comparator === "lt" ? value < bound
    : comparator === "lte" ? value <= bound
      : comparator === "gt" ? value > bound
        : comparator === "gte" ? value >= bound
          : value >= bound && value <= high;
  return { state: passes ? SATISFIED : NOT_SATISFIED, missing: [] };
}

/**
 * `elapsed_since` — the washout shape, and the only place a deferral is born
 * from arithmetic rather than declared by hand.
 *
 * No treatment recorded at all is `unknown` (C2-16); a treatment recorded with no
 * date is `undated`. A last dose too recent is not `not_satisfied` but
 * `pending_recheck` dated at the day the washout ends, because the answer is
 * known to change on a known date and the ledger should say so rather than make
 * the coordinator re-derive it.
 * @param {any} node @param {any} context @returns {RequirementVerdict}
 */
function evaluateElapsed(node, context) {
  const variable = String(node.variable ?? "");
  const everything = factsFor(context, variable).filter(fact => !fact.clinical?.copiedFrom && (!fact.clinical?.medication
    || fact.clinical.assertion === 'negated' || ['administered', 'stopped'].includes(fact.clinical.medication.state)));
  const affirmed = everything.filter((fact) => String(fact?.polarity ?? "affirmed") === "affirmed");
  // What happened after the assessment date is not yet a fact of it.
  const dated = affirmed.filter((fact) => instant(fact?.occurredAt) !== null && /** @type {number} */ (instant(fact.occurredAt)) <= context.asOf);
  const denied = everything.filter((fact) => {
    if (fact?.polarity !== 'negated') return false;
    if (!fact.clinical) return true; // Legacy assertions retain their declared interpretation.
    if (fact.clinical.medication?.absenceScope === 'never') return true;
    const interval = fact.clinical.occurredInterval;
    return fact.clinical.medication?.absenceScope === 'interval' && interval
      && instant(interval.start) != null && instant(interval.end) != null
      && instant(interval.start) <= context.asOf - Number(node.days ?? 0) * DAY_MS && instant(interval.end) >= context.asOf;
  });
  if (!dated.length) {
    // 「从未接受过」 is a complete answer to 「距上次治疗已满 N 天」.
    if (denied.length && node.deniedSatisfies !== false) return verdict(SATISFIED, { evidence: denied.map(citation) });
    const undated = affirmed.filter((fact) => instant(fact?.occurredAt) === null);
    if (undated.length) return unknownBecause(variable, "undated", undated.map(citation));
    return unknownBecause(variable, "not_recorded");
  }
  const latest = [...dated].sort((a, b) => (instant(b.occurredAt) ?? 0) - (instant(a.occurredAt) ?? 0))[0];
  const at = /** @type {number} */ (instant(latest.occurredAt));
  const needed = Number(node.days ?? 0);
  const elapsed = daysBetween(at, context.asOf);
  const strict = String(node.comparator ?? "gte") === "gt";
  if (strict ? elapsed > needed : elapsed >= needed) return verdict(SATISFIED, { evidence: [citation(latest)] });
  return verdict(PENDING_RECHECK, {
    evidence: [citation(latest)],
    // Strictly more than N days is true one moment after N days have passed.
    recheckAt: new Date(at + needed * DAY_MS + (strict ? 1_000 : 0)).toISOString(),
  });
}

/**
 * A criterion only language can decide. The model answers; this module checks
 * that the answer is anchored and refuses it otherwise.
 * @param {any} node @param {any} context @returns {RequirementVerdict}
 */
function evaluateLanguage(node, context) {
  const key = String(node.key ?? context.criterionId ?? "");
  const judgment = (context.modelJudgments ?? {})[key];
  if (!judgment || ![SATISFIED, NOT_SATISFIED, UNKNOWN].includes(String(judgment.state))) return unknownBecause(key, "not_recorded");
  if (judgment.state === UNKNOWN) return unknownBecause(key, "not_recorded");
  const anchored = (Array.isArray(judgment.evidence) ? judgment.evidence : []).filter((item) => {
    const probe = {
      id: item?.factId ?? key, variable: key, polarity: "affirmed", extractedBy: "model",
      surface: item?.quote, visibleAt: item?.visibleAt ?? null, source: item,
    };
    return verifyFactEvidence(probe, { documents: context.documents, asOf: context.asOf }).ok;
  });
  if (!anchored.length) return unknownBecause(key, "not_recorded");
  return verdict(String(judgment.state), {
    evidence: anchored.map((item) => ({
      factId: String(item?.factId ?? ""),
      variable: key,
      quote: String(item?.quote ?? ""),
      quoteKind: "verbatim",
      locator: { documentId: String(item?.documentId ?? ""), start: item?.start ?? null, end: item?.end ?? null },
      occurredAt: null, visibleAt: item?.visibleAt ?? null, polarity: "affirmed",
    })),
  });
}

/** The keys of the language nodes of a requirement: how the model's answers are found. @param {any} node @returns {string[]} */
export function languageKeysOf(node, fallback = "") {
  if (!node || typeof node !== "object") return [];
  if (node.op === "language") return [String(node.key ?? fallback)].filter(Boolean);
  const children = Array.isArray(node.operands) ? node.operands : node.operand ? [node.operand] : [];
  return children.flatMap((child) => languageKeysOf(child, fallback));
}

/** Does this requirement tree need the model to answer any part of it? */
export function requiresLanguageJudgment(node) {
  if (!node || typeof node !== "object") return false;
  if (node.op === "language") return true;
  const children = Array.isArray(node.operands) ? node.operands : node.operand ? [node.operand] : [];
  return children.some((child) => requiresLanguageJudgment(child));
}

// ---------------------------------------------------------------------------
// One criterion, one subject
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CriterionJudgment
 * @property {string} criterionId
 * @property {string} kind `inclusion` or `exclusion`
 * @property {string} criterionType
 * @property {string} state
 * @property {boolean} applicable
 * @property {string} applicabilityState the three-valued answer behind the boolean
 * @property {string} decidedBy `code` or `model`
 * @property {any[]} evidence
 * @property {string|null} recheckAt
 * @property {{ variable: string, reason: string }[]} missing
 */

/**
 * Judge one criterion.
 *
 * Applicability is evaluated first and kept as its own field. A criterion that
 * does not apply is still evaluated and still recorded — the state it would
 * have had is useful when someone later argues about whether it applied — but
 * the eligibility summary skips it. What it is never allowed to become is an
 * `unknown`, because `unknown` means "go find a document" and nobody should be
 * sent to look for a pregnancy test on a man.
 *
 * One criterion that cannot be evaluated never stops the others: an error inside
 * it is that criterion's `unknown` (`evaluation_error`) and the subject's other
 * criteria are judged as they would have been.
 *
 * @param {any} criterion
 * @param {any} context
 * @returns {CriterionJudgment}
 */
export function evaluateCriterion(criterion, context) {
  const local = { ...context, criterionId: String(criterion?.id ?? "") };
  const criterionType = VCR_CRITERION_TYPES.includes(criterion?.criterionType) ? criterion.criterionType : "other";
  try {
    const applicability = criterion?.applicability
      ? evaluateRequirement(criterion.applicability, local)
      : verdict(SATISFIED);
    const result = evaluateRequirement(criterion?.requirement, local);
    return {
      criterionId: String(criterion?.id ?? ""),
      kind: criterion?.kind === "exclusion" ? "exclusion" : "inclusion",
      criterionType,
      state: VCR_CRITERION_STATES.includes(result.state) ? result.state : UNKNOWN,
      applicable: applicability.state !== NOT_SATISFIED,
      applicabilityState: applicability.state,
      decidedBy: requiresLanguageJudgment(criterion?.requirement) ? "model" : "code",
      evidence: result.evidence,
      recheckAt: result.recheckAt,
      // A malformed applicability is a gap on this criterion too: it applies
      // (it is not known not to), and the protocol step owes a fix.
      missing: applicability.state === UNKNOWN && applicability.missing.some((item) => item.reason === "criterion_malformed")
        ? [...result.missing, ...applicability.missing] : result.missing,
    };
  } catch {
    return {
      criterionId: String(criterion?.id ?? ""), kind: criterion?.kind === "exclusion" ? "exclusion" : "inclusion", criterionType,
      state: UNKNOWN, applicable: true, applicabilityState: UNKNOWN, decidedBy: "code", evidence: [], recheckAt: null,
      missing: [{ variable: "", reason: "evaluation_error" }],
    };
  }
}

// ---------------------------------------------------------------------------
// The subject's summary (AC-14)
// ---------------------------------------------------------------------------

/**
 * Count the four states, plus the applicability axis beside them. The counts
 * are the deterministic half of the ranking: a coordinator sorts on them and
 * on nothing a model produced.
 * @param {readonly CriterionJudgment[]} judgments
 */
export function eligibilityCounts(judgments) {
  const counts = { satisfied: 0, not_satisfied: 0, unknown: 0, pending_recheck: 0, notApplicable: 0, total: 0 };
  for (const judgment of judgments ?? []) {
    counts.total += 1;
    if (!judgment?.applicable) { counts.notApplicable += 1; continue; }
    const state = String(judgment?.state ?? UNKNOWN);
    if (state in counts) counts[/** @type {keyof typeof counts} */ (state)] += 1;
  }
  return counts;
}

/**
 * The overall summary, from the criterion states alone.
 *
 * Order matters and is the rule AC-14 tests:
 *
 * 1. one applicable criterion definitely not satisfied → `ineligible`;
 * 2. otherwise any applicable `unknown` → `insufficient_evidence`, and this is
 *    the clause that stops an unknown exclusion from reading 「符合」;
 * 3. otherwise any deferral → `pending`;
 * 4. otherwise → `eligible`.
 *
 * `insufficient_evidence` outranks `pending` because they ask for different
 * work: the first sends someone to collect a document today, the second says
 * there is nothing to do until a date. A subject with both owes the document.
 *
 * @param {readonly CriterionJudgment[]} judgments
 * @returns {string}
 */
export function summarizeEligibility(judgments) {
  const applicable = (judgments ?? []).filter((judgment) => judgment?.applicable);
  if (!applicable.length) return "insufficient_evidence";
  if (applicable.some((judgment) => judgment.state === NOT_SATISFIED)) return "ineligible";
  if (applicable.some((judgment) => judgment.state === UNKNOWN)) return "insufficient_evidence";
  if (applicable.some((judgment) => judgment.state === PENDING_RECHECK)) return "pending";
  return "eligible";
}

/** The exclusion criteria whose `unknown` is what keeps this subject out of 「符合」 (AC-14). */
export function blockingExclusionUnknowns(judgments) {
  return (judgments ?? [])
    .filter((judgment) => judgment?.applicable && judgment.kind === "exclusion" && judgment.state === UNKNOWN)
    .map((judgment) => judgment.criterionId);
}

/** What a coordinator would have to go and find, deduplicated by variable. */
export function evidenceGaps(judgments) {
  /** @type {Map<string, { variable: string, reason: string, criterionIds: string[] }>} */
  const gaps = new Map();
  for (const judgment of judgments ?? []) {
    if (!judgment?.applicable) continue;
    for (const item of judgment.missing ?? []) {
      const reason = GAP_REASONS.includes(item?.reason) ? item.reason : "not_recorded";
      const key = `${item?.variable ?? ""}\u0000${reason}`;
      const entry = gaps.get(key) ?? { variable: String(item?.variable ?? ""), reason, criterionIds: [] };
      entry.criterionIds.push(judgment.criterionId);
      gaps.set(key, entry);
    }
  }
  return [...gaps.values()];
}

/** Deferrals that have come due and must be re-evaluated (plan §7.1 point 4). */
export function dueRechecks(judgments, now) {
  const at = instant(now) ?? Date.now();
  return (judgments ?? [])
    .filter((judgment) => judgment?.state === PENDING_RECHECK && instant(judgment.recheckAt) !== null && instant(judgment.recheckAt) <= at)
    .map((judgment) => ({ criterionId: judgment.criterionId, recheckAt: judgment.recheckAt }));
}

/**
 * The model's clinical priority, carried but never merged.
 *
 * It is a ranking hint and the interface says so in as many words. It is not a
 * probability of benefit, it is not multiplied into the counts, and a subject
 * never changes eligibility because of it.
 * @param {any} priority
 */
export function labelClinicalPriority(priority) {
  if (priority == null) return null;
  const score = Number(priority.score);
  return {
    score: Number.isFinite(score) ? score : null,
    rationale: String(priority.rationale ?? ""),
    decidedBy: "model",
    isBenefitProbability: false,
    label: "临床优先级（不是获益概率）",
  };
}

/**
 * The five things kept apart (plan §7.1).
 *
 * They are five because they fail independently and are owned by different
 * people: a patient may be clinically eligible with a missing document, willing
 * with no slot at the site, or slotted and stuck at 「已转诊」 because nobody
 * called back. Merged into one 「匹配度」 they would produce a number that no
 * single action can move.
 * @param {{ summary: string, counts: any, willingness?: string, siteCapacity?: any, referralState?: string }} input
 */
export function separateLedgers(input) {
  return Object.freeze({
    clinicalEligibility: String(input?.summary ?? "pending"),
    evidenceSufficiency: {
      unknown: Number(input?.counts?.unknown ?? 0),
      pending: Number(input?.counts?.pending_recheck ?? 0),
      sufficient: Number(input?.counts?.unknown ?? 0) === 0,
    },
    patientWillingness: String(input?.willingness ?? "unknown"),
    siteCapacity: input?.siteCapacity ?? null,
    businessProgress: String(input?.referralState ?? "candidate"),
  });
}

// ---------------------------------------------------------------------------
// One assessment
// ---------------------------------------------------------------------------

/**
 * The instant an assessment is made as of, as a valid ISO string — the one form
 * that is hashed, stored and replayed (review CS-34). A value that is not a
 * date is refused with a code, never read as "now": an evaluation that quietly
 * took the wall clock would give a different verdict on each run of the same
 * frozen job.
 * @param {unknown} value
 * @returns {string}
 */
export function frozenAsOf(value) {
  const at = typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) {
    throw Object.assign(new TypeError("asOf is an ISO date or instant, for example 2026-09-28 or 2026-09-28T08:00:00Z."), { code: "vcr_asof_invalid" });
  }
  return new Date(at).toISOString();
}

/**
 * Assess one subject against one protocol version, as of one instant.
 *
 * @param {{ studyId?: string, protocolVersionId?: string|null, subjectKey: string,
 *   direction?: string, criteria: readonly any[], facts: readonly any[],
 *   documents?: any, modelJudgments?: Record<string, any>, priority?: any,
 *   provenance?: { modelId?: string, promptVersion?: string, criteriaVersion?: string, vocabularyVersion?: string, inputSnapshotId?:string } | null,
 *   asOf: number|string|Date, unitConverter?: (value: number, from: string, to: string) => number|null }} input
 */
export function assessSubject(input) {
  const asOf = instant(input?.asOf);
  if (asOf === null) throw new TypeError("An assessment is made as of an instant; pass asOf.");
  const visible = factsVisibleAt(input.facts ?? [], asOf);
  const { facts, voided } = admissibleFacts(visible, { documents: input.documents, asOf });
  // A fact that was thrown away here is the reason a criterion downstream reads
  // `unknown`; carrying the list on the assessment is what makes that traceable
  // instead of mysterious.
  const longitudinal = clinicalFactView(facts, asOf);
  const context = {
    facts: longitudinal.facts, asOf, documents: input.documents,
    modelJudgments: input.modelJudgments ?? {},
    unitConverter: input.unitConverter,
    vocabularyVersion: input.provenance?.vocabularyVersion ?? VCR_MATCHING_VOCABULARY_VERSION,
  };
  const judgments = (input.criteria ?? []).map((criterion) => evaluateCriterion(criterion, context));
  const counts = eligibilityCounts(judgments);
  const summary = summarizeEligibility(judgments);
  const notYetVisible = (input.facts ?? []).length - visible.length;
  return {
    studyId: input.studyId ?? null,
    // Which model, which prompt and which criteria produced the language
    // judgments (plan §7.1; attachment A2 §4.3). It is carried, never used in
    // the verdict: when any of the three changes the old assessment is
    // superseded rather than overwritten, and `matchingReportDiff` needs the
    // three to say what changed between two measurements.
    clinicalHistory: { superseded: longitudinal.superseded, conflicts: longitudinal.conflicts },
    provenance: { ...(input.provenance ?? {}), vocabularyVersion: input.provenance?.vocabularyVersion ?? VCR_MATCHING_VOCABULARY_VERSION,
      inputFactIds: (input.facts ?? []).map(fact => fact.id).filter(Boolean),
      inputLanguageIds: Object.values(input.modelJudgments ?? {}).map(judgment => judgment.id).filter(Boolean),
      inputFactHashes: Object.fromEntries((input.facts ?? []).filter(fact => fact.id).map(fact => [fact.id, matchingInputDigest(fact)])),
      inputCriterionHashes: Object.fromEntries((input.criteria ?? []).filter(criterion => criterion.id).map(criterion => [criterion.id, matchingInputDigest(criterion)])),
      inputLanguageHashes: Object.fromEntries(Object.values(input.modelJudgments ?? {}).filter(judgment => judgment.id)
        .map(judgment => [judgment.id, matchingInputDigest({ id: judgment.id, state: judgment.state, evidence: judgment.evidence ?? [] })])),
      inputReferencesComplete: (input.facts ?? []).every(fact => typeof fact.id === 'string')
        && Object.values(input.modelJudgments ?? {}).every(judgment => typeof judgment.id === 'string') },
    protocolVersionId: input.protocolVersionId ?? null,
    subjectKey: String(input.subjectKey ?? ""),
    direction: input.direction === "patient_to_trial" ? "patient_to_trial" : "trial_to_patient",
    asOf: new Date(asOf).toISOString(),
    summary: VCR_ELIGIBILITY_SUMMARIES.includes(summary) ? summary : "pending",
    counts,
    judgments,
    priority: labelClinicalPriority(input.priority),
    evidenceGaps: evidenceGaps(judgments),
    blockingExclusionUnknowns: blockingExclusionUnknowns(judgments),
    voidedFacts: voided,
    factsWithheldAsFuture: notYetVisible,
    modelDecidedCount: judgments.filter((judgment) => judgment.decidedBy === "model").length,
  };
}

/**
 * The structured companion a `vcr-matching-assessment` deliverable ships
 * (`matching.json`; the domain's `vcrMatchingFindings` reads exactly this).
 * @param {ReturnType<typeof assessSubject>} assessment
 */
export function matchingAssessmentDocument(assessment) {
  return {
    subjectKey: assessment.subjectKey,
    asOf: assessment.asOf,
    provenance: publicMatchingProvenance(assessment.provenance),
    summary: assessment.summary,
    counts: assessment.counts,
    priority: assessment.priority,
    evidenceGaps: assessment.evidenceGaps,
    voidedFacts: assessment.voidedFacts,
    judgments: assessment.judgments.map((judgment) => ({
      criterionId: judgment.criterionId,
      kind: judgment.kind,
      criterionType: judgment.criterionType,
      state: judgment.state,
      applicable: judgment.applicable,
      decidedBy: judgment.decidedBy,
      recheckAt: judgment.recheckAt,
      evidence: judgment.evidence.map((item) => ({ quote: item.quote, locator: item.locator })),
    })),
  };
}

/**
 * Subjects ruled out on a model's word alone.
 *
 * They go to 「待复核排除」 rather than out of the list, so the false-exclusion
 * rate has a denominator. A subject excluded by arithmetic on a structured
 * value is not here: that one a reader can check for themselves.
 * @param {readonly ReturnType<typeof assessSubject>[]} assessments
 */
export function pendingReviewExclusions(assessments) {
  return (assessments ?? []).filter((assessment) => {
    if (assessment?.summary !== "ineligible") return false;
    const deciding = (assessment.judgments ?? []).filter((judgment) => judgment.applicable && judgment.state === NOT_SATISFIED);
    return deciding.length > 0 && deciding.every((judgment) => judgment.decidedBy === "model");
  });
}

/**
 * The criterion funnel both directions share: how many subjects each criterion
 * rules out, leaves unknown or defers. Running a draft protocol's criteria over
 * a historical candidate pool is the feasibility answer partners actually buy —
 * it says which single line is costing the trial its patients (plan §7.4).
 * @param {readonly ReturnType<typeof assessSubject>[]} assessments
 */
export function criterionFunnel(assessments) {
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const assessment of assessments ?? []) {
    for (const judgment of assessment.judgments ?? []) {
      const row = rows.get(judgment.criterionId) ?? {
        criterionId: judgment.criterionId, kind: judgment.kind, criterionType: judgment.criterionType,
        satisfied: 0, not_satisfied: 0, unknown: 0, pending_recheck: 0, notApplicable: 0, soleReason: 0,
      };
      if (!judgment.applicable) row.notApplicable += 1;
      else if (VCR_MATCHING_STATES.includes(judgment.state)) {
        row[judgment.state] += 1;
        if (judgment.state === NOT_SATISFIED) {
          const others = (assessment.judgments ?? []).filter((other) => other.applicable && other.state === NOT_SATISFIED);
          if (others.length === 1) row.soleReason += 1;
        }
      }
      rows.set(judgment.criterionId, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.soleReason - a.soleReason || b.not_satisfied - a.not_satisfied);
}

// ---------------------------------------------------------------------------
// Evaluation (AC-36, C2-20). No threshold, no borrowed accuracy.
// ---------------------------------------------------------------------------

/** @param {string} criterionType */
export function errorLayer(criterionType) {
  return LAYER_BY_TYPE[/** @type {keyof typeof LAYER_BY_TYPE} */ (criterionType)] ?? "other";
}

/**
 * The 4×4 criterion-level confusion matrix, with the two cells that matter
 * named separately.
 *
 * `unknownReadAsSatisfied` is the failure that puts an unscreened patient in
 * front of a coordinator; `satisfiedReadAsNotSatisfied` is the one that loses
 * an eligible patient silently. Both are single cells of the matrix and both
 * are reported on their own, because a matrix summed into one accuracy hides
 * exactly these two.
 *
 * `pairs` are `{ criterionId, criterionType, gold, predicted }`; `gold` is the
 * adjudicated human label.
 * @param {readonly any[]} pairs
 */
export function criterionConfusion(pairs) {
  /** @type {Record<string, Record<string, number>>} */
  const matrix = {};
  for (const gold of VCR_MATCHING_STATES) {
    matrix[gold] = {};
    for (const predicted of VCR_MATCHING_STATES) matrix[gold][predicted] = 0;
  }
  /** @type {Record<string, any>} */
  const byLayer = {};
  let counted = 0;
  for (const pair of pairs ?? []) {
    const gold = String(pair?.gold ?? "");
    const predicted = String(pair?.predicted ?? "");
    if (!VCR_MATCHING_STATES.includes(gold) || !VCR_MATCHING_STATES.includes(predicted)) continue;
    matrix[gold][predicted] += 1;
    counted += 1;
    const layer = errorLayer(String(pair?.criterionType ?? "other"));
    const bucket = byLayer[layer] ?? { total: 0, agreed: 0, unknownReadAsSatisfied: 0, satisfiedReadAsNotSatisfied: 0 };
    bucket.total += 1;
    if (gold === predicted) bucket.agreed += 1;
    if (gold === UNKNOWN && predicted === SATISFIED) bucket.unknownReadAsSatisfied += 1;
    if (gold === SATISFIED && predicted === NOT_SATISFIED) bucket.satisfiedReadAsNotSatisfied += 1;
    byLayer[layer] = bucket;
  }
  const agreed = VCR_MATCHING_STATES.reduce((sum, state) => sum + matrix[state][state], 0);
  return {
    matrix,
    counted,
    agreement: counted ? agreed / counted : null,
    unknownReadAsSatisfied: matrix[UNKNOWN][SATISFIED],
    satisfiedReadAsNotSatisfied: matrix[SATISFIED][NOT_SATISFIED],
    unknownRate: counted ? VCR_MATCHING_STATES.reduce((sum, state) => sum + matrix[state][UNKNOWN], 0) / counted : null,
    byLayer,
  };
}

/**
 * Applicability, measured on its own axis. `pairs` are `{ gold, predicted }`
 * over `applicable` booleans plus the state, so the one confusion TrialGPT's
 * error analysis calls out — 「不适用」 read as 「未知」 — has a cell of its own.
 * @param {readonly any[]} pairs
 */
export function applicabilityConfusion(pairs) {
  const cells = { agreedApplicable: 0, agreedNotApplicable: 0, notApplicableReadAsUnknown: 0, unknownReadAsNotApplicable: 0, other: 0, counted: 0 };
  for (const pair of pairs ?? []) {
    const goldApplicable = Boolean(pair?.goldApplicable);
    const predictedApplicable = Boolean(pair?.predictedApplicable);
    cells.counted += 1;
    if (goldApplicable === predictedApplicable) {
      if (goldApplicable) cells.agreedApplicable += 1; else cells.agreedNotApplicable += 1;
      continue;
    }
    if (!goldApplicable && predictedApplicable && String(pair?.predicted) === UNKNOWN) cells.notApplicableReadAsUnknown += 1;
    else if (goldApplicable && !predictedApplicable && String(pair?.gold) === UNKNOWN) cells.unknownReadAsNotApplicable += 1;
    else cells.other += 1;
  }
  return cells;
}

/**
 * Subject-level metrics.
 *
 * `eligibleRecall` is the primary one for a pre-screen: everything else can be
 * repaired by a human reading more charts, but an eligible patient the tool
 * never surfaced is gone. `numberNeededToScreen` is the price of that recall,
 * and both are reported together because either alone can be bought with the
 * other. A high accuracy on a population where eligibility is rare is not
 * evidence of anything — that is how a published Chinese HCC pre-screen reached
 * 92.9–98.0% accuracy at 51.9–83.5% sensitivity.
 *
 * `pairs` are `{ subjectKey, gold, predicted }` over the eligibility summaries.
 * @param {readonly any[]} pairs
 */
export function patientMatchingMetrics(pairs) {
  const eligible = (value) => String(value) === "eligible";
  let truePositive = 0, falsePositive = 0, falseNegative = 0, trueNegative = 0;
  let goldEligible = 0, screened = 0, unresolved = 0;
  for (const pair of pairs ?? []) {
    const gold = eligible(pair?.gold);
    const predicted = eligible(pair?.predicted);
    screened += 1;
    if (gold) goldEligible += 1;
    if (!["eligible", "ineligible"].includes(String(pair?.predicted))) unresolved += 1;
    if (gold && predicted) truePositive += 1;
    else if (!gold && predicted) falsePositive += 1;
    else if (gold && !predicted) falseNegative += 1;
    else trueNegative += 1;
  }
  const surfaced = truePositive + falsePositive;
  return {
    subjects: screened,
    goldEligible,
    surfaced,
    truePositive, falsePositive, falseNegative, trueNegative,
    // The primary pre-screen metric (plan §7.1).
    eligibleRecall: goldEligible ? truePositive / goldEligible : null,
    // Truly eligible and ruled out — the number 「待复核排除」 exists to keep countable.
    falseExclusionRate: goldEligible ? falseNegative / goldEligible : null,
    positivePredictiveValue: surfaced ? truePositive / surfaced : null,
    // Charts a coordinator opens per eligible patient found. Workload, not quality.
    numberNeededToScreen: truePositive ? surfaced / truePositive : null,
    unresolvedRate: screened ? unresolved / screened : null,
  };
}

/**
 * Agreement between two independent human readers, and Cohen's κ.
 *
 * Agreement describes these supplied labels; it is not a clinical accuracy
 * ceiling or a qualification threshold for another evaluation population.
 * @param {readonly string[]} first @param {readonly string[]} second
 */
export function interRaterAgreement(first, second) {
  const a = [...(first ?? [])].map(String);
  const b = [...(second ?? [])].map(String);
  const n = Math.min(a.length, b.length);
  if (!n) return { pairs: 0, agreement: null, kappa: null };
  let agreed = 0;
  /** @type {Record<string, number>} */
  const marginalA = {};
  /** @type {Record<string, number>} */
  const marginalB = {};
  for (let index = 0; index < n; index += 1) {
    if (a[index] === b[index]) agreed += 1;
    marginalA[a[index]] = (marginalA[a[index]] ?? 0) + 1;
    marginalB[b[index]] = (marginalB[b[index]] ?? 0) + 1;
  }
  const observed = agreed / n;
  const expected = Object.keys({ ...marginalA, ...marginalB })
    .reduce((sum, label) => sum + ((marginalA[label] ?? 0) / n) * ((marginalB[label] ?? 0) / n), 0);
  return { pairs: n, agreement: observed, kappa: expected === 1 ? null : (observed - expected) / (1 - expected) };
}

/**
 * The whole matching evaluation report (AC-36, C2-20).
 *
 * It separates agreement from accuracy and refuses a threshold. `passed` is deliberately absent:
 * there is no number this module could compare itself against that would mean
 * anything, and putting one here would be the platform promising a figure it
 * measured on somebody else's patients.
 *
 * @param {{ label: string, synthetic?: boolean, criterionPairs: readonly any[],
 *   subjectPairs: readonly any[], applicabilityPairs?: readonly any[],
 *   raterA?: readonly string[], raterB?: readonly string[],
 *   reviewMinutesWithTool?: number|null, reviewMinutesWithoutTool?: number|null }} input
 */
export function matchingEvaluationReport(input) {
  const ceiling = interRaterAgreement(input?.raterA ?? [], input?.raterB ?? []);
  const criterion = criterionConfusion(input?.criterionPairs ?? []);
  return {
    label: String(input?.label ?? ""),
    synthetic: Boolean(input?.synthetic),
    criterion,
    applicability: applicabilityConfusion(input?.applicabilityPairs ?? []),
    subject: patientMatchingMetrics(input?.subjectPairs ?? []),
    ceiling: {
      ...ceiling,
      note: ceiling.pairs ? "独立标注者的一致性仅描述本评测集，不代表临床准确率上限。" : "没有独立双标注数据；未估计标注者一致性。",
    },
    // Workload, measured with and without the tool on the same charts. It is not
    // a quality metric and is reported beside quality, never instead of it.
    reviewMinutes: {
      withTool: input?.reviewMinutesWithTool ?? null,
      withoutTool: input?.reviewMinutesWithoutTool ?? null,
      savedPerChart: Number.isFinite(input?.reviewMinutesWithTool) && Number.isFinite(input?.reviewMinutesWithoutTool)
        ? Number(input.reviewMinutesWithoutTool) - Number(input.reviewMinutesWithTool)
        : null,
    },
    threshold: null,
    note: "不设统一准确率门槛，也不引用外部产品的准确率作为承诺；本报告只描述在本评测集上的表现。",
  };
}

/**
 * Run the deterministic evaluator over a labelled set and produce the pairs the
 * report reads. Gold labels retain their actual source (optional human correction or an
 * independent labelled reference); the predictions come from `assessSubject` and nothing else, so
 * an evaluation cannot accidentally score a different code path than the one
 * that runs in production.
 *
 * @param {{ cases: readonly any[], criteria?: readonly any[], asOf?: string|number|Date, label?: string, synthetic?: boolean }} dataset
 */
export function runMatchingEvaluation(dataset) {
  /** @type {any[]} */
  const criterionPairs = [];
  /** @type {any[]} */
  const subjectPairs = [];
  /** @type {any[]} */
  const applicabilityPairs = [];
  /** @type {string[]} */
  const raterA = [];
  /** @type {string[]} */
  const raterB = [];
  for (const item of dataset?.cases ?? []) {
    const assessment = assessSubject({
      subjectKey: item.subjectKey,
      // A labelled set usually states its criteria once and its charts many
      // times; both shapes are read so the file stays the shape a person wrote.
      criteria: item.criteria ?? dataset.criteria ?? [],
      facts: item.facts,
      documents: item.documents,
      modelJudgments: item.modelJudgments,
      asOf: item.asOf ?? dataset.asOf,
    });
    const byId = new Map(assessment.judgments.map((judgment) => [judgment.criterionId, judgment]));
    for (const gold of item.goldJudgments ?? []) {
      const judgment = byId.get(gold.criterionId);
      if (!judgment) continue;
      criterionPairs.push({
        subjectKey: item.subjectKey, criterionId: gold.criterionId,
        criterionType: judgment.criterionType, gold: gold.state, predicted: judgment.state,
      });
      applicabilityPairs.push({
        goldApplicable: gold.applicable !== false, predictedApplicable: judgment.applicable,
        gold: gold.state, predicted: judgment.state,
      });
      if (gold.raterA) raterA.push(String(gold.raterA));
      if (gold.raterB) raterB.push(String(gold.raterB));
    }
    subjectPairs.push({ subjectKey: item.subjectKey, gold: item.goldSummary, predicted: assessment.summary });
  }
  return matchingEvaluationReport({
    label: String(dataset?.label ?? ""),
    synthetic: dataset?.synthetic !== false,
    criterionPairs, subjectPairs, applicabilityPairs, raterA, raterB,
  });
}

/**
 * What changed between two evaluation runs (C2-20's last line).
 *
 * Reported, never gated. A model version, a prompt version or a criteria
 * revision moves these numbers, and the only useful thing to say about the
 * movement is its size and its direction on each metric that matters — plus
 * which criteria flipped, because that is where the cause is. Declaring a
 * regression from one run of a 42-pair set would be arithmetic theatre; the
 * interval on the difference is wider than most of the differences.
 *
 * @param {any} previous @param {any} current
 */
export function matchingReportDiff(previous, current) {
  const delta = (path) => {
    const before = path.split('.').reduce((value, key) => value?.[key], previous);
    const after = path.split('.').reduce((value, key) => value?.[key], current);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return { before: before ?? null, after: after ?? null, change: null };
    return { before, after, change: after - before };
  };
  return {
    versions: { previous: previous?.provenance ?? previous?.label ?? null, current: current?.provenance ?? current?.label ?? null },
    criterionAgreement: delta("criterion.agreement"),
    unknownRate: delta("criterion.unknownRate"),
    unknownReadAsSatisfied: delta("criterion.unknownReadAsSatisfied"),
    satisfiedReadAsNotSatisfied: delta("criterion.satisfiedReadAsNotSatisfied"),
    eligibleRecall: delta("subject.eligibleRecall"),
    falseExclusionRate: delta("subject.falseExclusionRate"),
    numberNeededToScreen: delta("subject.numberNeededToScreen"),
    gated: false,
    note: "版本间差异只报告，不门控；一次评测集上的差值不足以宣布回归。",
  };
}
