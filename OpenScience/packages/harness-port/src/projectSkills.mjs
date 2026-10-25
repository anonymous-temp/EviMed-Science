import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeDisabledPlatformSkills, platformSkillRequirement } from '@evimed/domain/platform-skill-policy'
import { loadHarnessModule } from '../index.mjs'

/** Native discovery and parsing stay with the filesystem provider. This adapter changes only its two invocation flags.
 * Disabled winners remain in the registry so a lower precedence duplicate can never become invocable.
 * Policy is copied at registration; serving generations are immutable.
 *
 * It is the only row that discovers every skill a session has (core, office, the conversation's own, LoopX, personal), so it
 * fails open: a policy that cannot be read is logged and the native provider is registered with no restriction, because an
 * optional switch must never cost a session all of its skills (owner rulings 2026-10-10). The roots are resolved through
 * `realpath`, the paths the native provider reports, so a symlinked root still matches. Deletable when DSH ships a native
 * per-skill disable (seam manifest `notes.projectSkillsAdapter`).
 * @param {any} ctx @param {{customSkillDirs:string[],disabledSkills?:string[]}} config */
export async function registerProjectSkillProvider(ctx, config) {
  /** @type {Set<string>} */ let disabled
  try { disabled = new Set(normalizeDisabledPlatformSkills(config.disabledSkills ?? []).filter(id => !platformSkillRequirement(id).required)) }
  catch (error) {
    ctx.logger?.warn?.(`evimed project skills: the project's skill policy could not be read (${error?.message ?? error}); every skill stays available`)
    disabled = new Set()
  }
  const roots = await Promise.all(config.customSkillDirs.map(root => fs.realpath(root).catch(() => path.resolve(root))))
  /** @type {Record<string,string>} */
  const origins = { core: 'core', evimed: 'evimed', 'curated-scientific': 'curated', office: 'office', community: 'community' }
  const { FileSystemSkillProvider } = await loadHarnessModule('@deepseek-ai/dsh-skill-filesystem')
  /** @type {any} */ let native
  /** @param {any} value */
  const restricted = value => {
    const root = roots.find(candidateRoot => typeof value.path === 'string' && value.path.startsWith(candidateRoot + '/'))
    const id = root && `${origins[path.basename(root)] ?? ''}:${value.name}`
    return id && disabled.has(id) ? { ...value, invocation: { modelInvocable: false, userInvocable: false } } : value
  }
  const unregister = ctx.skills.registerProvider((/** @type {any} */ control) => {
    native = new FileSystemSkillProvider(ctx, control, { providerName: 'filesystem', customSkillDirs: roots, includeDefaultRoots: false, watch: false })
    return {
      name: native.name,
      async list(/** @type {any} */ options) {
        const observed = await native.list(options)
        return Array.isArray(observed) ? observed.map(restricted) : { ...observed, candidates: observed.candidates.map(restricted) }
      },
      async get(/** @type {any} */ candidate, /** @type {any} */ options) {
        const definition = await native.get(candidate, options)
        return definition && restricted(definition)
      },
    }
  })
  ctx.effect(() => async () => { await native?.dispose() }, 'project skill provider disposal')
  return unregister
}
