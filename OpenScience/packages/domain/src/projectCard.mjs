/**
 * The project card: the slots a project's memory is read in.
 *
 * Hidden knowledge: a project's facts were free text under keys the extraction
 * model made up (`project.primary_outcome`, `project.analysis_method`,
 * `project.confounding_control` for the same study on three replays), so the
 * memory page could list them and could not say what the project was. The
 * extraction instructions therefore name the keys, and the page reads a card
 * off them (2026-10-12, owner's choice A: the card sits at the top of the
 * project's own tab, never in a page of its own).
 *
 * The card is for any kind of work (2026-10-13, owner: a general work assistant
 * first, medicine as an enhancement). It first shipped as the shape a clinical
 * researcher describes a study in — population, intervention, comparator,
 * endpoint, design — plus a closed list of twenty-one specialties, so a
 * software refactor or a launch plan had no slot to fill and a field outside
 * the list lost the whole memory. Now:
 *
 *  - six general slots apply to every project: the field of the work, its goal,
 *    what it is about, the material it works from, where it stands, and what
 *    limits it;
 *  - the clinical elements are an extension that exists only for the study a
 *    researcher actually described: each is written when stated, and an
 *    element nobody stated is not a gap anywhere;
 *  - any other kind of work names its own extra slots under `project.ext.`
 *    (a data analysis: variables, method; writing: audience, venue; software:
 *    interface, version), checked for shape and length and for nothing else.
 *
 * The field is an open vocabulary: one to three short phrases in the
 * researcher's own words. The frontier feed's twenty-one specialties are used
 * only to align with it when a phrase happens to be one of them (stored under
 * the feed's name); a phrase that is not on the list is kept, never a reason to
 * drop the memory. What a slot holds is the researcher's own description and is
 * judged by the model, never by a pattern (principle 5).
 *
 * @module @evimed/domain/projectCard
 */

import { FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH } from './frontierVocabulary.mjs'

/** @typedef {'field'|'goal'|'subject'|'data_source'|'stage'|'constraints'} ProjectCardGeneralSlot */
/** @typedef {'population'|'intervention'|'comparator'|'outcome'|'design'} ProjectCardClinicalSlot */
/** @typedef {ProjectCardGeneralSlot|ProjectCardClinicalSlot} ProjectCardSlot */

/** The slots every project can have, in the order the card reads. */
export const PROJECT_CARD_GENERAL_SLOTS = /** @type {readonly ProjectCardGeneralSlot[]} */ (Object.freeze([
  'field', 'goal', 'subject', 'data_source', 'stage', 'constraints',
]))

/** The extension for a clinical or epidemiological study, in the order a study is described. Written only when stated. */
export const PROJECT_CARD_CLINICAL_SLOTS = /** @type {readonly ProjectCardClinicalSlot[]} */ (Object.freeze([
  'population', 'intervention', 'comparator', 'outcome', 'design',
]))

/** Every named slot: the general ones, then the clinical extension. */
export const PROJECT_CARD_SLOTS = /** @type {readonly ProjectCardSlot[]} */ (Object.freeze([
  ...PROJECT_CARD_GENERAL_SLOTS, ...PROJECT_CARD_CLINICAL_SLOTS,
]))

/** What each slot is called on the card (the words of the OpenViking project-context template, so the two engines show one card). */
export const PROJECT_CARD_SLOT_LABELS_ZH = /** @type {Readonly<Record<ProjectCardSlot, string>>} */ (Object.freeze({
  field: '领域',
  goal: '目标',
  subject: '范围或对象',
  data_source: '材料与数据',
  stage: '阶段',
  constraints: '约束',
  population: '人群',
  intervention: '干预或暴露',
  comparator: '对照',
  outcome: '结局',
  design: '设计',
}))

/** The memory key a slot is written under. */
export const PROJECT_CARD_KEY_PREFIX = 'project.'

/** Where a kind of work that has none of the slots above names its own: `project.ext.<name>`. */
export const PROJECT_CARD_EXTENSION_PREFIX = 'project.ext.'
/** The shape of an extension's name: a lowercase word, optionally joined by underscores. */
const EXTENSION_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,3}$/
/** The longest an extension's name is, and the longest its value is, in characters. */
export const PROJECT_CARD_EXTENSION_NAME_MAX = 32
export const PROJECT_CARD_EXTENSION_VALUE_MAX = 500
/** The most extension rows one card shows. */
export const PROJECT_CARD_EXTENSION_ROWS_MAX = 8

/**
 * Names the instructions suggest for other kinds of work, with the words the card uses for them. A name outside the list is
 * as good a slot: the card shows it as the sentence the memory states, since an English key cannot be turned into a label.
 */
export const PROJECT_CARD_EXTENSION_LABELS_ZH = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  variables: '变量',
  method: '方法',
  audience: '读者',
  venue: '发表去向',
  interface: '接口',
  version: '版本',
}))

/** @param {ProjectCardSlot} slot */
export function projectCardKey(slot) {
  return `${PROJECT_CARD_KEY_PREFIX}${slot}`
}

/** @param {unknown} key */
function keyText(key) {
  return typeof key === 'string' ? key.trim().toLowerCase() : ''
}

/**
 * The named slot a memory key names, or null.
 * @param {unknown} key
 * @returns {ProjectCardSlot | null}
 */
export function projectCardSlotOfKey(key) {
  const text = keyText(key)
  if (!text.startsWith(PROJECT_CARD_KEY_PREFIX)) return null
  const slot = /** @type {ProjectCardSlot} */ (text.slice(PROJECT_CARD_KEY_PREFIX.length))
  return PROJECT_CARD_SLOTS.includes(slot) ? slot : null
}

/**
 * The extension a memory key names — `project.ext.audience` → `audience` — or null for a key that is no extension or whose name
 * has the wrong shape.
 * @param {unknown} key
 * @returns {string | null}
 */
export function projectCardExtensionOfKey(key) {
  const text = keyText(key)
  if (!text.startsWith(PROJECT_CARD_EXTENSION_PREFIX)) return null
  const name = text.slice(PROJECT_CARD_EXTENSION_PREFIX.length)
  return name.length <= PROJECT_CARD_EXTENSION_NAME_MAX && EXTENSION_NAME.test(name) ? name : null
}

/**
 * Whether a key is the card's: a named slot or an extension.
 * @param {unknown} key
 */
export function isProjectCardKey(key) {
  return projectCardSlotOfKey(key) !== null || projectCardExtensionOfKey(key) !== null
}

/**
 * Whether a value fits an extension: not empty, not longer than the card shows. The only check an extension has.
 * @param {unknown} value
 */
export function projectCardExtensionValueFits(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 && text.length <= PROJECT_CARD_EXTENSION_VALUE_MAX
}

/** The most phrases a project's field names. */
export const PROJECT_FIELD_MAX = 3
/** The longest one phrase of a field is, in characters; a longer text is a sentence, not a field. */
export const PROJECT_FIELD_PHRASE_MAX = 30

const FIELD_SEPARATOR = /[、,，;；/／\n]+/u

/**
 * A project's field, written the one way it is stored: one to three short phrases in the researcher's own words, joined by 「、」.
 * A phrase that is one of the frontier feed's specialties — by its name or by the vocabulary's own id — is stored under the
 * feed's name so the two meet; every other phrase is kept as it was said. More than three keep the first three. What is no field
 * is an empty text and a sentence (a phrase beyond `PROJECT_FIELD_PHRASE_MAX`), and the caller drops that memory.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalProjectField(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const phrases = text.split(FIELD_SEPARATOR).map((phrase) => phrase.replace(/\s+/gu, ' ').trim()).filter(Boolean)
  if (phrases.length === 0 || phrases.some((phrase) => phrase.length > PROJECT_FIELD_PHRASE_MAX)) return null
  /** @type {string[]} */
  const kept = []
  for (const phrase of phrases) {
    const id = FRONTIER_SPECIALTIES.find((candidate) => candidate === phrase.toLowerCase() || FRONTIER_SPECIALTY_LABELS_ZH[candidate] === phrase)
    const label = id ? FRONTIER_SPECIALTY_LABELS_ZH[id] : phrase
    if (!kept.some((held) => held.toLowerCase() === label.toLowerCase())) kept.push(label)
  }
  return kept.slice(0, PROJECT_FIELD_MAX).join('、')
}
