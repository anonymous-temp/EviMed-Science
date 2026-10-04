/**
 * What an update of a skill package would change, and what it must leave alone.
 *
 * Hidden knowledge: a skill the researcher took from somewhere (a public
 * repository at a commit, a built-in skill they copied to edit) and then edited
 * has three versions at once — the one it started from (the BASE), their own
 * (LOCAL), and the newer upstream one (UPSTREAM). Overwriting LOCAL with
 * UPSTREAM destroys their edits; ignoring UPSTREAM leaves the copy behind
 * forever; and without BASE the two cannot be told apart at all (a difference
 * could be their edit or the upstream's change). So the plan compares per
 * part — each of the description, the instructions, when to use it, how it may
 * be invoked, its metadata, and every resource file — against the digest the
 * package had when it came in:
 *
 *   upstream did not move            -> keep local (their edit, if any, stays)
 *   local did not move               -> take upstream (add, replace or remove)
 *   both moved, to the same content  -> nothing to do
 *   both moved, differently          -> conflict: local stays, upstream is offered
 *   base unknown                     -> every difference is a conflict, never an overwrite
 *
 * Nothing here merges text. A conflict is reported by name and the researcher
 * decides; the update never produces a blend neither side wrote. And it is
 * never a gate: the plan describes a new revision a researcher may create, it
 * does not touch the revision a project or a running conversation pinned.
 *
 * Pure. Digests are computed by the caller's `sha256Hex` (the domain is
 * browser-safe), exactly as `extensions.mjs` does.
 *
 * @module @evimed/domain/src/skillUpdatePlan
 */

import { canonicalJson } from './capsule.mjs'

/** The parts of a skill, besides its resource files, that an update compares. */
export const SKILL_UPDATE_PARTS = Object.freeze(['description', 'instructions', 'whenToUse', 'invocation', 'metadata'])

/**
 * @typedef {object} SkillDigests
 * @property {Record<string, string>} parts part name -> sha256 hex of its canonical content
 * @property {Record<string, string>} resources resource path -> `sha256:` digest
 *
 * @typedef {'unchanged' | 'same' | 'keep-local' | 'take-upstream' | 'add' | 'remove' | 'conflict'} SkillUpdateDecision
 *
 * @typedef {object} SkillUpdateEntry
 * @property {'part' | 'resource'} scope
 * @property {string} name
 * @property {SkillUpdateDecision} decision
 * @property {'local' | 'upstream' | 'removed'} side which side the new revision takes
 * @property {string | null} base
 * @property {string | null} local
 * @property {string | null} upstream
 */

/**
 * The digests of a skill's content, part by part: the thing a package is
 * compared by, and the thing stored as its baseline when it comes in.
 * @param {{ description?: unknown, instructions?: unknown, whenToUse?: unknown, invocation?: unknown, metadata?: unknown, resources?: readonly { path: string, digest: string }[] }} content
 * @param {(text: string) => string} sha256Hex
 * @returns {SkillDigests}
 */
export function skillContentDigests(content, sha256Hex) {
  /** @type {Record<string, string>} */ const parts = {}
  for (const part of SKILL_UPDATE_PARTS) {
    const value = /** @type {Record<string, unknown>} */ (content)[part]
    parts[part] = sha256Hex(canonicalJson(value === undefined ? null : value))
  }
  /** @type {Record<string, string>} */ const resources = {}
  for (const resource of content.resources ?? []) resources[resource.path] = resource.digest
  return { parts, resources }
}

/** @param {unknown} value @returns {SkillDigests | null} a stored baseline, or null where it does not read as one */
export function normalizeSkillBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = /** @type {Record<string, any>} */ (value)
  if (!raw.parts || typeof raw.parts !== 'object' || !raw.resources || typeof raw.resources !== 'object') return null
  /** @type {Record<string, string>} */ const parts = {}
  for (const part of SKILL_UPDATE_PARTS) {
    if (typeof raw.parts[part] !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.parts[part])) return null
    parts[part] = raw.parts[part]
  }
  /** @type {Record<string, string>} */ const resources = {}
  for (const [path, digest] of Object.entries(raw.resources)) {
    if (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(digest) || Object.keys(resources).length >= 256) return null
    resources[path] = digest
  }
  return { parts, resources }
}

/**
 * @param {string | null} base @param {string | null} local @param {string | null} upstream @param {boolean} baseKnown
 * @returns {{ decision: SkillUpdateDecision, side: 'local' | 'upstream' | 'removed' }}
 */
function decide(base, local, upstream, baseKnown) {
  if (local === upstream) return { decision: local === base || !baseKnown ? 'unchanged' : 'same', side: local === null ? 'removed' : 'local' }
  if (!baseKnown) return { decision: 'conflict', side: 'local' }
  if (upstream === base) return { decision: 'keep-local', side: local === null ? 'removed' : 'local' }
  if (local === base) {
    if (upstream === null) return { decision: 'remove', side: 'removed' }
    return { decision: base === null ? 'add' : 'take-upstream', side: 'upstream' }
  }
  return { decision: 'conflict', side: 'local' }
}

/**
 * The plan for updating LOCAL toward UPSTREAM, given the BASE both came from.
 * @param {{ base: SkillDigests | null, local: SkillDigests, upstream: SkillDigests }} input
 * @returns {{ baseKnown: boolean, entries: SkillUpdateEntry[], counts: Record<SkillUpdateDecision, number>, changes: number, conflicts: number }}
 */
export function planSkillUpdate({ base, local, upstream }) {
  const baseKnown = base !== null
  /** @type {SkillUpdateEntry[]} */ const entries = []
  for (const part of SKILL_UPDATE_PARTS) {
    const b = base?.parts[part] ?? null
    const l = local.parts[part] ?? null
    const u = upstream.parts[part] ?? null
    entries.push({ scope: 'part', name: part, ...decide(b, l, u, baseKnown), base: b, local: l, upstream: u })
  }
  const paths = [...new Set([...Object.keys(base?.resources ?? {}), ...Object.keys(local.resources), ...Object.keys(upstream.resources)])].sort()
  for (const path of paths) {
    const b = base?.resources[path] ?? null
    const l = local.resources[path] ?? null
    const u = upstream.resources[path] ?? null
    entries.push({ scope: 'resource', name: path, ...decide(b, l, u, baseKnown), base: b, local: l, upstream: u })
  }
  /** @type {Record<SkillUpdateDecision, number>} */
  const counts = { unchanged: 0, same: 0, 'keep-local': 0, 'take-upstream': 0, add: 0, remove: 0, conflict: 0 }
  for (const entry of entries) counts[entry.decision] += 1
  return {
    baseKnown, entries, counts,
    changes: counts['take-upstream'] + counts.add + counts.remove,
    conflicts: counts.conflict,
  }
}
