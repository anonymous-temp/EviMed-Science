/**
 * The records of the admitted deterministic calculations, as data.
 *
 * Hidden knowledge: one file, three readers. `method-records.json` is the only
 * place a method's assumptions, inputs, refusals, diagnostics, seeding and
 * reference cases are written. The specialist adapter ships a byte-identical copy
 * (a test holds them equal) and cuts every result's `methodRecord` identity from
 * it; the control plane reads it here, for the refusal vocabulary it lets through
 * and the version a result is said to have run. The calculation tool does not read
 * the file (the runtime's delta image copies only `*.py`): its own table of inputs
 * and refusal sentences is held to this one by tests.
 *
 * A record's `version` is its own: it changes when the method's numbers, inputs,
 * checks or diagnostics change. For the two methods the R engine runs it is that
 * engine's method version, which a test holds equal to `VCR_ENGINE_METHODS`.
 * Only strings, integers and booleans appear in a record, so its digest is the
 * same in Python and JavaScript.
 *
 * Kept off the package index on purpose: the web bundle imports the index and has
 * no use for twenty kilobytes of method text.
 */
import methodRecordsData from './method-records.json' with { type: 'json' }

/** The records by method id. Readers must not mutate them. */
export const METHOD_RECORDS = Object.freeze(methodRecordsData.methods)

/** The record of one method, or null when none is admitted. @param {string} method */
export function methodRecord(method) {
  return Object.hasOwn(METHOD_RECORDS, method) ? /** @type {any} */ (METHOD_RECORDS)[method] : null
}

/**
 * Every refusal code the python executor may answer a calculation with, from the
 * records. The control plane passes only these through from an engine's failed
 * answer: the code is read out of a closed list, never out of what the engine said.
 */
export const METHOD_REFUSAL_CODES = Object.freeze(new Set(
  Object.values(/** @type {Record<string, any>} */ (METHOD_RECORDS))
    .flatMap((record) => record.refusals.map((/** @type {any} */ refusal) => refusal.code))
    .filter((/** @type {string} */ code) => /^replay_[a-z_]{1,80}$/.test(code))))

/**
 * The two codes the executor gives for an input it cannot read at all (a missing or unread key, a value of the
 * wrong type, an input too large): not a method's refusal, but as much a reason the researcher can act on.
 */
export const ENGINE_INPUT_CODES = Object.freeze(new Set(['replay_input_invalid', 'replay_input_too_large']))
