import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

const LIMITS = Object.freeze({ entries: 512, bytes: 16 * 1024 * 1024, depth: 16 })

/** A trusted generation root must contain only bounded ordinary files, never links.
 * This is mechanical resource validation; native DSH alone interprets skill text.
 * The caller must keep this root immutable throughout discovery and use.
 * @param {string} root @param {AbortSignal} [signal] */
export async function validatePersonalSkillRoot(root, signal) {
  signal?.throwIfAborted()
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === path.parse(root).root) throw new Error('personal_skill_root_invalid')
  const resolved = await realpath(root)
  if (path.resolve(root) !== resolved) throw new Error('personal_skill_root_link')
  let entries = 0
  let bytes = 0
  /** @param {string} target @param {number} depth */
  async function visit(target, depth) {
    signal?.throwIfAborted()
    if (++entries > LIMITS.entries || depth > LIMITS.depth) throw new Error('personal_skill_resource_limit')
    const info = await lstat(target)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw new Error('personal_skill_resource_type')
    if (info.isFile()) { bytes += info.size; if (bytes > LIMITS.bytes) throw new Error('personal_skill_resource_limit'); return }
    for (const entry of await readdir(target)) await visit(path.join(target, entry), depth + 1)
  }
  await visit(resolved, 0)
  return resolved
}

/** Roots are deployment-owned selected revisions, never customer request paths.
 * Registration belongs to a standing scope with ctx.skills, not a child agent.
 * @param {any} ctx @param {{roots:string[],signal?:AbortSignal}} options */
export async function createPersonalSkillProvider(ctx, options) {
  if (!Array.isArray(options.roots) || !options.roots.length || options.roots.length > 256) throw new Error('personal_skill_roots_invalid')
  const roots = await Promise.all(options.roots.map(root => validatePersonalSkillRoot(root, options.signal)))
  const { FileSystemSkillProvider } = await import('@deepseek-ai/dsh-skill-filesystem')
  if (!ctx.skills?.registerProvider) throw new Error('personal_skill_scope_unavailable')
  /** @type {InstanceType<typeof FileSystemSkillProvider>|undefined} */
  let provider
  const unregister = ctx.skills.registerProvider((/** @type {any} */ control) => {
    provider = new FileSystemSkillProvider(ctx, control, {
      providerName: 'evimed-personal', customSkillDirs: roots, includeDefaultRoots: false, watch: false,
    })
    return provider
  })
  ctx.effect(() => async () => { await provider?.dispose() }, 'evimed-personal provider disposal')
  return unregister
}

/** Parse exactly one vetted bundle with the shipped provider, without home/project discovery.
 * @param {string} root @param {{expectedName?:string,signal?:AbortSignal}} [options] */
export async function parsePersonalSkill(root, options = {}) {
  const trustedRoot = await validatePersonalSkillRoot(root, options.signal)
  const { FileSystemSkillProvider } = await import('@deepseek-ai/dsh-skill-filesystem')
  const controller = new globalThis.AbortController()
  // Parser diagnostics contain host paths and imported text; public errors below are fixed codes.
  const ctx = /** @type {any} */ ({ get: () => undefined, logger: { warn: () => {} } })
  const provider = new FileSystemSkillProvider(ctx, { signal: controller.signal, invalidate: () => {} }, {
    providerName: 'evimed-personal-validation', customSkillDirs: [trustedRoot], includeDefaultRoots: false, watch: false,
  })
  try {
    options.signal?.throwIfAborted()
    const listed = await provider.list({ signal: options.signal })
    options.signal?.throwIfAborted()
    const candidates = Array.isArray(listed) ? listed : listed.candidates
    if (!Array.isArray(listed) && !listed.complete) throw new Error('personal_skill_discovery_incomplete')
    if (candidates.length !== 1) throw new Error('personal_skill_bundle_invalid')
    const definition = await provider.get(candidates[0], { signal: options.signal })
    if (!definition || (options.expectedName !== undefined && definition.name !== options.expectedName)) throw new Error('personal_skill_identity_invalid')
    return { name: definition.name, description: definition.description, instructions: definition.content,
      invocation: definition.invocation, metadata: definition.metadata ?? {}, resourceBase: definition.resourceBase,
      ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }) }
  } finally {
    controller.abort()
    await provider.dispose()
  }
}
