/**
 * The project card: the slots a project's memory is read in.
 *
 * Hidden knowledge: a project's facts were free text under keys the extraction
 * model made up (`project.primary_outcome`, `project.analysis_method`,
 * `project.confounding_control` for the same study on three replays), so the
 * memory page could list them and could not say what the project was. A medical
 * researcher describes a study in one shape — who is studied, what is given,
 * against what, with which endpoint, in which design, from which data, and
 * where the work stands — so the extraction instructions name those keys and
 * the page reads a card off them (2026-10-12, owner's choice A: the card sits at
 * the top of the project's own tab, never in a page of its own).
 *
 * Only one slot has a closed value: `project.field`, the specialty, drawn from
 * the same twenty-one the frontier feed classifies its items into
 * (`FRONTIER_SPECIALTIES`), so a researcher's field and a feed item's field are
 * one vocabulary. That a value is on the list is a format check (principle 5);
 * everything else a slot holds is the researcher's own description and is
 * judged by the model, never by a pattern.
 *
 * @module @evimed/domain/projectCard
 */

import { FRONTIER_MAX_SPECIALTIES, FRONTIER_SPECIALTIES, FRONTIER_SPECIALTY_LABELS_ZH } from './frontierVocabulary.mjs'

/** @typedef {'field'|'population'|'intervention'|'comparator'|'outcome'|'design'|'data_source'|'stage'} ProjectCardSlot */

/** The slots in the order the card reads. */
export const PROJECT_CARD_SLOTS = /** @type {readonly ProjectCardSlot[]} */ (Object.freeze([
  'field', 'population', 'intervention', 'comparator', 'outcome', 'design', 'data_source', 'stage',
]))

/** What each slot is called on the card. */
export const PROJECT_CARD_SLOT_LABELS_ZH = /** @type {Readonly<Record<ProjectCardSlot, string>>} */ (Object.freeze({
  field: '专科',
  population: '人群',
  intervention: '干预或暴露',
  comparator: '对照',
  outcome: '结局',
  design: '设计',
  data_source: '数据来源',
  stage: '阶段',
}))

/** The memory key a slot is written under. */
export const PROJECT_CARD_KEY_PREFIX = 'project.'

/** @param {ProjectCardSlot} slot */
export function projectCardKey(slot) {
  return `${PROJECT_CARD_KEY_PREFIX}${slot}`
}

/**
 * The slot a memory key names, or null.
 * @param {unknown} key
 * @returns {ProjectCardSlot | null}
 */
export function projectCardSlotOfKey(key) {
  const text = typeof key === 'string' ? key.trim().toLowerCase() : ''
  if (!text.startsWith(PROJECT_CARD_KEY_PREFIX)) return null
  const slot = /** @type {ProjectCardSlot} */ (text.slice(PROJECT_CARD_KEY_PREFIX.length))
  return PROJECT_CARD_SLOTS.includes(slot) ? slot : null
}

/** The specialties a project's field may name, as the reader's words. */
export const PROJECT_FIELD_LABELS_ZH = Object.freeze(FRONTIER_SPECIALTIES.map((id) => FRONTIER_SPECIALTY_LABELS_ZH[id]))

/** The most specialties one project's field names. */
export const PROJECT_FIELD_MAX = FRONTIER_MAX_SPECIALTIES

const FIELD_SEPARATOR = /[\s、,，;；/／]+/u

/**
 * A project's field, written the one way it is stored: one to three specialties
 * of the closed list, as their Chinese names joined by 「、」. The model may
 * answer with a name or with the vocabulary's own id; anything else — a
 * specialty the list does not have, a fourth, a sentence — is no field, and the
 * caller drops the memory rather than store a value the card cannot group by.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalProjectField(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  const names = text.split(FIELD_SEPARATOR).filter(Boolean)
  if (names.length === 0 || names.length > PROJECT_FIELD_MAX) return null
  /** @type {string[]} */
  const labels = []
  for (const name of names) {
    const id = FRONTIER_SPECIALTIES.find((candidate) => candidate === name.toLowerCase() || FRONTIER_SPECIALTY_LABELS_ZH[candidate] === name)
    if (!id) return null
    const label = FRONTIER_SPECIALTY_LABELS_ZH[id]
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join('、')
}
