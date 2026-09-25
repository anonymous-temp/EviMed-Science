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
 * @property {false} [listed] Present, and false, when the capability is kept out of the lists a researcher picks from.
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
 * Whether a capability belongs in the lists a researcher picks a tool from —
 * 科研工具 and the kernel frame's tool list.
 *
 * Everything is, except a capability whose display block says `listed: false`:
 * the 「循证 GEO」 capabilities are opened by their own module and bound to a
 * session by id, which is why they stay public (a bound internal capability
 * answers 403) and are hidden here instead. What a list does with an id this
 * build has no display entry for stays that list's decision.
 * @param {string | null | undefined} id
 * @returns {boolean}
 */
export function capabilityListed(id) {
  const key = String(id ?? '').trim()
  return !key || CAPABILITY_DISPLAY[key]?.listed !== false
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

// The two halves of the preamble, read off `capabilityBrief` itself rather than
// restated, so the brief and its reader cannot drift apart: a changed template
// changes both. The mark is a character no title contains.
const briefMark = String.fromCharCode(0)
const [briefHead, briefTail] = capabilityBrief(briefMark, '').split(briefMark)
const briefClose = briefTail.trimEnd()

/**
 * The task a capability-card brief carries, without the card's naming line.
 *
 * `capabilityBrief` puts 「请以「X」能力完成以下任务：」 above what the person asked,
 * and every run started from a card stored that line as the first thing its
 * question said, so twelve runs of one capability were listed under twelve
 * copies of the same sentence (2026-09-18 plan, B §4b). This reads exactly the
 * shape `capabilityBrief` writes and nothing else — a question that merely
 * contains similar words is returned as it was — so it is a format, not a
 * language judgement.
 *
 * @param {string | null | undefined} text
 * @returns {{ task: string, capability: string | null }}
 */
export function capabilityBriefTask(text) {
  const value = String(text ?? '')
  const unchanged = { task: value, capability: null }
  if (!value.startsWith(briefHead)) return unchanged
  const close = value.indexOf(briefClose, briefHead.length)
  if (close < 0) return unchanged
  const capability = value.slice(briefHead.length, close)
  if (!capability.trim() || capability.length > 40 || /[\n「」]/.test(capability)) return unchanged
  const task = value.slice(close + briefClose.length).replace(/^\s+/, '')
  return task ? { task, capability } : unchanged
}
