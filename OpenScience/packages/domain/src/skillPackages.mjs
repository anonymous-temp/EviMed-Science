/**
 * The skill packages the platform ships and the runtime image they run on, as the
 * generator (`scripts/build/generate-skill-packages.mjs`) read them out of the
 * trees that define them, and the domain's one reader of that table.
 *
 * Hidden knowledge: the table is data on disk because the places the facts live
 * are not all in the control plane's image (the community pack, the shared
 * capability bodies and the image's install script are not), and it is read
 * through the domain's own normalizer so a row that does not read as a record is
 * dropped instead of half-believed. `check:skill-packages` fails when it drifts
 * from the trees.
 *
 * Kept out of the domain's root export: it is the one large table in the
 * package and only the control plane reads it, through
 * `@evimed/domain/skill-packages`.
 *
 * @module @evimed/domain/src/skillPackages
 */

import table from './skill-packages.json' with { type: 'json' }
import { normalizeSkillPackageRecord } from './skillSupply.mjs'

/** @typedef {import('./skillSupply.mjs').SkillPackageRecord} SkillPackageRecord */
/** @typedef {import('./skillSupply.mjs').ImageRecipe} ImageRecipe */

/** The runtime image's recipe: pinned python distributions and the modules they provide, apt packages, commands and R packages. @type {Readonly<ImageRecipe & { source: string }>} */
export const IMAGE_RECIPE = Object.freeze(/** @type {any} */ ({
  source: String(table.image.source),
  python: Object.freeze({ ...table.image.python }),
  modules: Object.freeze(Object.fromEntries(Object.entries(table.image.modules).map(([name, modules]) => [name, Object.freeze([...modules])]))),
  apt: Object.freeze([...table.image.apt]),
  tools: Object.freeze([...table.image.tools]),
  rPackages: Object.freeze([...table.image.rPackages]),
}))

/** Every shipped package, by id. A row that does not read as a record is absent, never repaired. @type {ReadonlyMap<string, Readonly<SkillPackageRecord>>} */
export const SKILL_PACKAGES = new Map(
  table.packages.flatMap((/** @type {unknown} */ row) => {
    const record = normalizeSkillPackageRecord({ schemaVersion: 1, ...(/** @type {Record<string, unknown>} */ (row)) })
    return record ? [[record.id, Object.freeze(record)]] : []
  }),
)

/**
 * The packages a name stands for: a skill's name is not unique across origins
 * (a curated `statistical-analysis` and the capability of the same name are two
 * packages), so a name returns every package that carries it, in id order.
 * @param {string} name @returns {Readonly<SkillPackageRecord>[]}
 */
export function skillPackagesNamed(name) {
  return [...SKILL_PACKAGES.values()].filter((record) => record.name === name)
}

/**
 * The package of one origin and name.
 * @param {SkillPackageRecord['origin']} origin @param {string} name @returns {Readonly<SkillPackageRecord> | null}
 */
export function skillPackage(origin, name) {
  return SKILL_PACKAGES.get(`${origin}/${name}`) ?? null
}
