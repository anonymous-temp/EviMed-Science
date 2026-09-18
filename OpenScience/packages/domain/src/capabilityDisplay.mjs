/**
 * What a capability is called in the product, and what a reader is told about
 * it, by id.
 *
 * Here and not in `apps/web` because two surfaces outside the browser bundle
 * need it. The run ledger names the capability that produced a row (a row with
 * no recorded brief has nothing else to be titled by), and the kernel's own
 * hero renders the capability cards — inside an iframe on another origin,
 * composed by a plugin whose body is serialized with `toString()` and can
 * import nothing. The server reads this table and hands the frame a catalogue
 * that is already in the product's words.
 *
 * The table is generated, not written: each public capability's `display:`
 * block in `capabilities/<id>/capability.yaml` is its source, and
 * `scripts/build/generate-capability-manifests.mjs` writes it into
 * `capability-display.json` beside this module, adding what `evals/` measured
 * about the capability's real deliveries. It used to be a hand table here —
 * one more place for a new capability to be forgotten, and one that could
 * only ever say what a capability claims, never how it has done. `--check`
 * (in `ci:web`) fails when the two drift.
 *
 * The manifest's top-level `title` and `description` are read by the
 * orchestrator and the delegation contract, where an English identifier is
 * correct; the reader never sees them. An id with no entry here has no product
 * name, and the caller decides whether to show the id or nothing — an id
 * rendered as a title is the defect this exists to prevent.
 *
 * @module @evimed/domain/src/capabilityDisplay
 */

import displayTable from './capability-display.json' with { type: 'json' }

/**
 * What `evals/` holds about a capability's real deliveries. `lastStatus` is the
 * acceptance ledger's verdict on the latest one; the run counts and the median
 * duration of the delivered runs are present only when runs were recorded.
 * @typedef {object} CapabilityEvaluation
 * @property {'accepted' | 'failed' | 'not-run'} [lastStatus]
 * @property {string | null} [lastRunAt] `YYYY-MM-DD`
 * @property {number} [runs]
 * @property {number} [delivered]
 * @property {number | null} [typicalMinutes]
 */

/**
 * @typedef {object} CapabilityDisplay
 * @property {string} title
 * @property {string} category
 * @property {string} description
 * @property {string[]} starterPrompts
 * @property {string} [materials] What the researcher has to provide first, when the capability works on their material.
 * @property {{ min: number, max: number }} estimatedMinutes How long it usually takes.
 * @property {string[]} outputs What the researcher receives, in their words.
 * @property {string[]} knownLimits
 * @property {CapabilityEvaluation} [evaluation]
 */

/** @type {Readonly<Record<string, CapabilityDisplay>>} */
export const CAPABILITY_DISPLAY = Object.freeze(
  /** @type {Record<string, CapabilityDisplay>} */ (displayTable.capabilities),
)

/**
 * The product name of a capability, or null when this build has no name for it.
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
export function capabilityTitle(id) {
  const key = String(id ?? '').trim()
  return key && CAPABILITY_DISPLAY[key] ? CAPABILITY_DISPLAY[key].title : null
}

/**
 * The brief a capability card hands the composer.
 *
 * The capability is named in the sentence rather than in a request field on
 * purpose: there is no capability parameter on the dispatch route, the
 * orchestrator reads the brief, and a person can edit or delete the naming
 * line — which is exactly the difference between a suggestion and a binding.
 *
 * One newline and not two. The composer is a Lexical editor, and it renders
 * each newline as its own paragraph: the blank line this used to carry arrived
 * in the real composer as five empty lines above the brief (2026-09-15 walk,
 * E5, and again in the deployed build before this was changed).
 *
 * @param {string} title the capability's own title @param {string} prompt the starter brief
 * @returns {string}
 */
export function capabilityBrief(title, prompt) {
  return `请以「${title}」能力完成以下任务：\n${prompt}`
}
