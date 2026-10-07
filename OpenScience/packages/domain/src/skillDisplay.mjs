/**
 * How the skills the runtime image ships are shown to a researcher, by skill
 * name: a Chinese name, the one line a list row carries, the sentence that says
 * when the skill is used, and the group it is listed under.
 *
 * Hidden knowledge: a SKILL.md is written for the model — an English
 * description that reads "Use whenever you ..." — and its folder name is an
 * identifier. Neither is what a researcher choosing among fifty-seven skills
 * can read, and the file cannot be translated at the point of display without
 * a model call per page view. So the Chinese words are data, written once next
 * to the packages (`skill-display-zh.json`), and a test holds the table equal
 * to the shipped set: a skill added without its row, or a row left behind by a
 * deleted skill, fails there rather than showing a bare identifier.
 *
 * Kept out of the domain's root export, like the package table: only the
 * control plane reads it, through `@evimed/domain/skill-display`.
 *
 * @module @evimed/domain/src/skillDisplay
 */

import table from './skill-display-zh.json' with { type: 'json' }

/**
 * @typedef {object} SkillDisplay
 * @property {string} group one of {@link SKILL_DISPLAY_GROUPS}
 * @property {string} title the Chinese name
 * @property {string} use the line a list row carries
 * @property {string} when the sentence that says when the skill is used
 */

/** The groups a skill is listed under, in the order the page lists them. */
export const SKILL_DISPLAY_GROUPS = Object.freeze([...table.groups])

/** The group the proprietary 「循证传播」 method pack is listed under, where its folder is present. One of {@link SKILL_DISPLAY_GROUPS}. */
export const SKILL_DISPLAY_GEO_GROUP = String(table.geoGroup)

/** Every shipped skill's words by skill name, in the order each group lists them. @type {Readonly<Record<string, Readonly<SkillDisplay>>>} */
export const SKILL_DISPLAY = Object.freeze(Object.fromEntries(
  Object.entries(/** @type {Record<string, SkillDisplay>} */ (table.skills)).map(([name, row]) => [name, Object.freeze({ ...row })]),
))

/**
 * The words of one skill, or null for a name this table does not carry.
 * @param {string | null | undefined} name @returns {Readonly<SkillDisplay> | null}
 */
export function skillDisplay(name) {
  const key = String(name ?? '')
  return Object.hasOwn(SKILL_DISPLAY, key) ? SKILL_DISPLAY[key] : null
}
