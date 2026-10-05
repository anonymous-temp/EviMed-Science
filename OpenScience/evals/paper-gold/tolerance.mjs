/**
 * How close a result must be to a reference number, decided in code.
 *
 * A tolerance is a deterministic property of how a number was printed, so it is derived here and never
 * taken from the model that curated the number (development principle 1: deterministic properties are
 * code). Three things used to be possible and are not any more: a curator choosing `1.30 +/- 0.5` for
 * an odds ratio, which admits a result in the opposite direction; a p-value near 1e-25 carrying an
 * absolute tolerance of 1e-10, which admits any p below 1e-10; and a frozen definition whose stated
 * tolerance nothing ever bounded.
 *
 * The rule:
 *  - a printed number is accepted to half a unit of its last printed digit (`printed` is the token as
 *    the source prints it: "1.30", "37.5%", "1.2e-5", "1.2 x 10^-5");
 *  - a reference that is another implementation's output (no printed token) is accepted to a relative
 *    1e-6, because two correct implementations of one formula agree far closer than that;
 *  - p-values and counts span orders of magnitude, so their tolerance is relative to the value and an
 *    absolute tolerance wider than the printed half unit is never honoured for them;
 *  - anything looser than that default needs a reason from `TOLERANCE_REASONS`, and no reason buys more
 *    than `TOLERANCE_LIMITS` allows;
 *  - a tolerance that would accept the null or trivial answer of the quantity (a ratio of 1, a
 *    difference of 0, a p-value of 0 or 1) is refused when the case is curated.
 *
 * `score_existing_methods.py` carries a line-for-line port of `boundedHalfWidth`; `tolerance.test.mjs`
 * runs both over `tolerance-vectors.json` and fails when they disagree.
 */

/** What kind of number a reference is. It selects the trivial answers and whether the scale is relative. */
export const TOLERANCE_QUANTITIES = Object.freeze(['ratio', 'difference', 'probability', 'p-value', 'count', 'other']);

/** Why a curator may ask for more than the default. A closed list: a reason is a claim a reviewer can check. */
export const TOLERANCE_REASONS = Object.freeze(['inputs-rounded-in-source', 'iterative-estimator', 'stochastic-method', 'specification-variant']);

export const TOLERANCE_LIMITS = Object.freeze({
  /** A printed number may be loosened to this many half units (two units of its last digit either side). */
  printedLoosening: 4,
  /** The widest relative band any reason buys: the 3% reproduction band the plan takes from Paper2Agent. */
  relativeCeiling: 0.03,
  /** Default for a reference computed by another implementation. */
  computedRelative: 1e-6,
  /** The widest a computed reference may be loosened to (an iterative estimator's convergence difference). */
  computedRelativeCeiling: 1e-3,
  /** A reference that is exactly zero has no relative scale. */
  zeroAbsolute: 1e-9,
  zeroAbsoluteCeiling: 1e-6,
});

const RELATIVE_QUANTITIES = ['p-value', 'count'];
const TRIVIAL_ANSWERS = { ratio: [1], difference: [0], probability: [0, 1], 'p-value': [0, 1], count: [0], other: [0, 1] };
/** A half unit is exact in decimal and not in binary; this keeps "0.1645 against 0.164 +/- 0.0005" inside. */
const ROUNDING_SLACK = 1e-9;

/**
 * Read a number the way a paper prints it.
 * @param {unknown} token
 * @returns {{value:number,halfUnit:number,decimals:number,percent:boolean}|null} null when the token is not one plain number
 */
export function printedNumber(token) {
  if (typeof token !== 'string') return null;
  const text = token.trim().replace(/[\u2212\u2012\u2013]/g, '-').replace(/(?<=\d)[,\u2009\u202f](?=\d{3}(?:\D|$))/g, '');
  const match = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))(?:\s*(?:[eE]|[\u00d7x*]\s*10\s*\^?\s*)([+-]?\d+))?\s*(%)?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  const exponent = Number(match[5] ?? 0) - (match[6] ? 2 : 0);
  // Built from the printed digits, not from a parsed float: "0.0000001" must not round-trip through "1e-7".
  const value = Number(`${match[1] === '-' ? '-' : ''}${match[2] ?? '0'}${fraction ? `.${fraction}` : ''}e${exponent}`);
  const halfUnit = Number(`5e${exponent - fraction.length - 1}`);
  if (!Number.isFinite(value) || !Number.isFinite(halfUnit) || halfUnit <= 0) return null;
  return { value, halfUnit, decimals: fraction.length, percent: Boolean(match[6]) };
}

/** The coarsest printing a stored number is consistent with: its shortest decimal form. A legacy
 *  reference kept no printed token, and "1.30" stored as 1.3 can only be read as one decimal.
 * @param {number} value */
function shortestPrinted(value) {
  return printedNumber(String(value));
}

/** @param {any} reference */
function statedHalfWidth(reference) {
  return Math.max(Number(reference.absoluteTolerance ?? 0), Math.abs(reference.value ?? 0) * Number(reference.relativeTolerance ?? 0));
}

/**
 * The default acceptance half-width for one reference.
 * @param {{value:number,printed?:string}} reference
 */
export function defaultHalfWidth(reference) {
  const printed = printedNumber(reference.printed);
  if (printed) return printed.halfUnit * (1 + ROUNDING_SLACK);
  return reference.value === 0 ? TOLERANCE_LIMITS.zeroAbsolute : Math.abs(reference.value) * TOLERANCE_LIMITS.computedRelative;
}

/**
 * The widest half-width any curator can obtain for this reference.
 * @param {{value:number,printed?:string,toleranceReason?:string}} reference
 */
export function halfWidthCeiling(reference) {
  const magnitude = Math.abs(reference.value);
  const printed = printedNumber(reference.printed);
  if (printed) {
    const unit = printed.halfUnit * (1 + ROUNDING_SLACK);
    if (!TOLERANCE_REASONS.includes(reference.toleranceReason)) return unit;
    const loosened = unit * TOLERANCE_LIMITS.printedLoosening;
    return reference.toleranceReason === 'inputs-rounded-in-source' ? loosened : Math.max(loosened, magnitude * TOLERANCE_LIMITS.relativeCeiling);
  }
  if (reference.value === 0) return TOLERANCE_LIMITS.zeroAbsoluteCeiling;
  // No printed token: either another implementation's output or a record frozen before tokens were
  // kept. The first is bounded relatively; the second by the coarsest printing its digits allow.
  const inferred = reference.printed === undefined ? shortestPrinted(reference.value) : null;
  return Math.max(magnitude * TOLERANCE_LIMITS.computedRelativeCeiling, inferred ? inferred.halfUnit * (1 + ROUNDING_SLACK) : 0);
}

/**
 * The half-width a score actually uses: what the reference states, never more than the ceiling.
 * A reference that states nothing and carries a printed token gets the printed default; one that states
 * nothing and carries no token is an exact comparison, as it always was.
 * @param {any} reference
 * @returns {{halfWidth:number,clamped:boolean}}
 */
export function boundedHalfWidth(reference) {
  if (!Number.isFinite(reference?.value)) return { halfWidth: statedHalfWidth(reference ?? {}), clamped: false };
  const unstated = reference.absoluteTolerance === undefined && reference.relativeTolerance === undefined;
  const stated = unstated && printedNumber(reference.printed) ? defaultHalfWidth(reference) : statedHalfWidth(reference);
  const ceiling = halfWidthCeiling(reference);
  return stated > ceiling ? { halfWidth: ceiling, clamped: true } : { halfWidth: stated, clamped: false };
}

/** Whether the reference, at this half-width, would also accept a trivial answer of its quantity.
 * @param {{value:number,quantity?:string}} reference @param {number} halfWidth */
export function acceptsTrivialAnswer(reference, halfWidth) {
  const trivial = TRIVIAL_ANSWERS[reference.quantity] ?? TRIVIAL_ANSWERS.other;
  return trivial.some(answer => Math.abs(answer - reference.value) <= halfWidth);
}

/**
 * Turn a curated number into a frozen reference, or refuse it with a named code.
 *
 * `allowLoosening` is for a definition an operator writes by hand, where a named reason may widen the
 * default inside the ceiling. A model-curated number never passes it: whatever tolerance the model
 * wrote is discarded.
 * @param {{value:number,printed?:string,quantity?:string,absoluteTolerance?:number,relativeTolerance?:number,toleranceReason?:string}} proposed
 * @param {{allowLoosening?:boolean,requirePrinted?:boolean}} [options]
 * @returns {{ok:boolean,reference?:any,discriminating?:boolean,code?:string}} `ok:false` carries the refusal `code`
 */
export function curatedReference(proposed, { allowLoosening = false, requirePrinted = true } = {}) {
  if (!Number.isFinite(proposed?.value)) return { ok: false, code: 'reference_value_invalid' };
  if (proposed.quantity !== undefined && !TOLERANCE_QUANTITIES.includes(proposed.quantity)) return { ok: false, code: 'reference_quantity_unknown' };
  const printed = printedNumber(proposed.printed);
  if (requirePrinted && !printed) return { ok: false, code: 'printed_value_missing' };
  // The printed token is the bond between the number and its source: it must be this number.
  if (printed && Math.abs(printed.value - proposed.value) > Math.abs(proposed.value) * 1e-12 + Number.MIN_VALUE) return { ok: false, code: 'printed_value_bond_failed' };
  const base = { value: proposed.value, ...(printed ? { printed: proposed.printed.trim() } : {}), ...(proposed.quantity ? { quantity: proposed.quantity } : {}) };
  const fallback = defaultHalfWidth(base);
  let halfWidth = fallback;
  let reason;
  const requested = statedHalfWidth(proposed);
  if (allowLoosening && requested > fallback) {
    if (!TOLERANCE_REASONS.includes(proposed.toleranceReason)) return { ok: false, code: 'tolerance_reason_required' };
    reason = proposed.toleranceReason;
    if (requested > halfWidthCeiling({ ...base, toleranceReason: reason })) return { ok: false, code: 'tolerance_exceeds_bound' };
    halfWidth = requested;
  }
  // The printed value may itself be the trivial answer ("OR 1.0"); that is a fact about the paper. What
  // is refused is a widening that lets the trivial answer in.
  const trivialAtDefault = acceptsTrivialAnswer(base, fallback);
  if (!trivialAtDefault && acceptsTrivialAnswer(base, halfWidth)) return { ok: false, code: 'tolerance_accepts_trivial_answer' };
  const relative = RELATIVE_QUANTITIES.includes(proposed.quantity) && proposed.value !== 0;
  const reference = { ...base, ...(relative ? { absoluteTolerance: 0, relativeTolerance: halfWidth / Math.abs(proposed.value) } : { absoluteTolerance: halfWidth, relativeTolerance: 0 }),
    toleranceBasis: reason ? 'named-reason' : printed ? 'printed-precision' : 'computed-reference', ...(reason ? { toleranceReason: reason } : {}) };
  return { ok: true, reference, discriminating: !trivialAtDefault };
}

/**
 * Curate every number of one case. A case none of whose numbers can tell a real answer from the trivial
 * one is refused: reproducing it would prove nothing.
 * @param {Record<string, any>} numeric @param {{allowLoosening?:boolean,requirePrinted?:boolean}} [options]
 * @returns {{ok:boolean,numeric?:Record<string,any>,code?:string,key?:string}} `ok:false` carries the refusal `code` and the offending `key`
 */
export function curatedCaseNumeric(numeric, options = {}) {
  const entries = Object.entries(numeric ?? {});
  if (!entries.length) return { ok: false, code: 'reference_value_invalid' };
  const result = {};
  let discriminating = false;
  for (const [key, proposed] of entries) {
    const curated = curatedReference(proposed, options);
    if (!curated.ok) return { ok: false, code: curated.code, key };
    // Fields the tolerance rule does not own (the quotation, the output path) travel with the reference.
    const { absoluteTolerance: _a, relativeTolerance: _r, toleranceReason: _t, value: _v, printed: _p, quantity: _q, ...carried } = proposed;
    result[key] = { ...carried, ...curated.reference };
    discriminating ||= curated.discriminating;
  }
  return discriminating ? { ok: true, numeric: result } : { ok: false, code: 'case_accepts_trivial_answer' };
}

/** One number as text prints it, with thousands separators, an exponent in either notation and a percent sign. */
const NUMBER_TOKEN = /(?<![\d.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:[eE]|[\u00d7x*]\s*10\s*\^?\s*)[+-]?\d+)?\s*%?/g;

/**
 * Find the printed token of a number inside the quotation that bonds it to its source.
 *
 * A token match, not a substring match: `5` does not bond to "0.52", `12` does not bond to "0.12", and
 * `1` does not bond to "10". The quotation is split into number tokens and one of them must print
 * exactly this value (a percentage counts on either scale: "37.5%" bonds 37.5 and 0.375).
 * @param {unknown} quote @param {number} value
 * @returns {string|null} the token as printed, or null when the quotation does not print the number
 */
export function printedTokenIn(quote, value) {
  if (typeof quote !== 'string' || !Number.isFinite(value)) return null;
  const normalized = quote.replace(/[\u2212\u2012\u2013]/g, '-');
  for (const match of normalized.matchAll(new RegExp(NUMBER_TOKEN.source, 'g'))) {
    const token = match[0].trim();
    // "1.30.2" is a version or a section number, not the number 1.30.
    if (/^\.\d/.test(normalized.slice(match.index + match[0].length))) continue;
    for (const candidate of [token, token.replace(/^[+-]/, '')]) {
      const printed = printedNumber(candidate);
      if (!printed) continue;
      const scale = Math.abs(value) * 1e-12 + Number.MIN_VALUE;
      if (Math.abs(printed.value - value) <= scale) return candidate;
      // "37.5%" quoted for a stored 37.5: the same digits on the percent scale.
      if (printed.percent && Math.abs(printed.value * 100 - value) <= scale) return candidate.replace(/\s*%$/, '');
    }
  }
  return null;
}

/**
 * A text with every printed occurrence of the given numbers replaced by "[withheld]".
 *
 * For a reader who must see a paper's methods and must not see its answers: the reviewer that writes the
 * independent reference implementation. Token by token, with the same reading of a printed number as the
 * bond above, on either scale of a percentage and with either sign.
 * @param {string} text @param {number[]} values
 */
export function withholdNumbers(text, values) {
  const wanted = values.filter(Number.isFinite);
  if (typeof text !== 'string' || !wanted.length) return text;
  const same = (printed, value) => Math.abs(Math.abs(printed) - Math.abs(value)) <= Math.abs(value) * 1e-12 + Number.MIN_VALUE;
  return text.replace(/[\u2212\u2012\u2013]/g, '-').replace(new RegExp(NUMBER_TOKEN.source, 'g'), token => {
    const printed = printedNumber(token.trim()) ?? printedNumber(token.trim().replace(/^[+-]/, ''));
    if (!printed) return token;
    // The token pattern takes the blank before an optional percent sign with it; give the blank back.
    return wanted.some(value => same(printed.value, value) || (printed.percent && same(printed.value * 100, value))) ? `[withheld]${/\s*$/.exec(token)[0]}` : token;
  });
}
