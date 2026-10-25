import path from 'node:path'
import { normalizeDisabledPlatformSkills, platformSkillRequirement } from '@evimed/domain/platform-skill-policy'
import { loadHarnessModule } from '../index.mjs'

/** Native discovery and parsing stay with the filesystem provider. This adapter changes only its two invocation flags.
 * Disabled winners remain in the registry so a lower precedence duplicate can never become invocable.
 * Policy is copied at registration; serving generations are immutable.
 * @param {any} ctx @param {{customSkillDirs:string[],disabledSkills?:string[]}} config */
export async function registerProjectSkillProvider(ctx, config) {
  const disabled = new Set(normalizeDisabledPlatformSkills(config.disabledSkills ?? []).filter(id => !platformSkillRequirement(id).required))
  const roots = config.customSkillDirs.map(root => path.resolve(root))
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
