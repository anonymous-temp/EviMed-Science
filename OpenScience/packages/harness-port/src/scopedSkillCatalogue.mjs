/** Read-only access to the pinned registry's actual winning agent-scoped skills. */
import fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { canonicalJson, canonicalPersonalSkillResourcePath } from '@evimed/domain'
import { loadHarnessModule } from '../index.mjs'

/** @param {string|Buffer} bytes */
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => new Error('skill_catalogue_unavailable')
const LIMITS = Object.freeze({ skills: 1024, entries: 512, files: 128, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, instructions: 262144, metadata: 32768 })
const BASE = '/opt/evimed/socket/presets/evimed-universal/skills'
export const SCOPED_SKILL_ROOTS = Object.freeze([
  ...['core', 'evimed', 'curated-scientific', 'office'].map(name => Object.freeze({ root: `${BASE}/${name}`, source: 'builtin', duplicate: true })),
  Object.freeze({ root: `${BASE}/community`, source: 'community', duplicate: true }),
  // The private 「循证传播」 method pack sits one level down (`skills/<name>/`, beside its shared layer), the way the preset's
  // own skill directories list it. Without a row here its skills read as an unconfirmed source and a preview fails. It is the
  // owner's pack, not a template: listed and readable, never copied into an account.
  Object.freeze({ root: `${BASE}/geo-private/skills`, source: 'builtin', duplicate: false }),
  Object.freeze({ root: '/opt/evimed/personal-skills', source: 'personal', duplicate: false }),
])
/** @param {any} value @param {string[]} fields */
function closed(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field))) throw fail()
}
/** @param {any} summary */
function summaryKey(summary) {
  return `skill:${sha(canonicalJson({ name: summary.name, description: summary.description, invocation: summary.invocation,
    whenToUse: summary.whenToUse ?? null, provider: summary.provider, source: summary.source, path: summary.path ?? null,
    resourceBase: summary.resourceBase ?? null }))}`
}
/** @param {any} ctx @param {string} sessionId */
function actualAgent(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw fail()
  const agent = ctx.agents.get(sessionId)
  if (!agent || agent.id !== sessionId || agent.session?.header?.id !== sessionId || !ctx.skills?.list || !ctx.skills?.get || !ctx.skills?.snapshot) throw fail()
  return agent
}
/** This classification is deployment-root evidence, not the provider's self-declared source label.
 * @param {any} summary @param {readonly any[]} roots */
function classify(summary, roots) {
  const selected = summary.provider === 'filesystem' && typeof summary.path === 'string'
    ? roots.find(item => summary.path.startsWith(item.root + '/')) : null
  const completeBundle = summary.resourceBase?.kind === 'directory' && summary.path === path.join(summary.resourceBase.path, 'SKILL.md')
  return { source: selected?.source ?? 'unknown', canDuplicate: Boolean(selected?.duplicate && completeBundle), selected }
}
/** @param {any} summary @param {readonly any[]} roots */
function publicSummary(summary, roots) {
  if (typeof summary.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(summary.name)
    || typeof summary.description !== 'string' || Buffer.byteLength(summary.description) > 8192
    || typeof summary.invocation?.userInvocable !== 'boolean' || typeof summary.invocation?.modelInvocable !== 'boolean') throw fail()
  const { source, canDuplicate } = classify(summary, roots)
  return { key: summaryKey(summary), name: summary.name, description: summary.description,
    invocation: { ...summary.invocation }, source, canDuplicate }
}
/** Descriptor verified ordinary source bytes, before and after reads; scripts remain inert data.
 * @param {string} root @param {string} selectedRoot @param {AbortSignal} signal */
async function sourceEntries(root, selectedRoot, signal) {
  if (!root.startsWith(selectedRoot + '/') || await fs.realpath(root) !== root) throw fail()
  const prefixes = new Map(), identities = new Set()
  /** @type {any[]} */ const entries = []
  let visited = 0, total = 0
  /** @param {any} info */
  const stamp = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`
  /** @param {string} directory @param {string} relative */
  async function visit(directory, relative = '') {
    signal.throwIfAborted()
    const held = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const before = await held.stat(); if (!before.isDirectory()) throw fail()
      const base = process.platform === 'linux' ? `/proc/self/fd/${held.fd}` : directory
      const names = (await fs.readdir(base)).sort()
      for (const name of names) {
        signal.throwIfAborted(); if (++visited > LIMITS.entries) throw fail()
        const raw = relative ? `${relative}/${name}` : name
        const canonical = canonicalPersonalSkillResourcePath(raw, prefixes)
        if (canonical.path !== raw || identities.has(canonical.key)) throw fail(); identities.add(canonical.key)
        const target = path.join(base, name), info = await fs.lstat(target)
        if (info.isSymbolicLink()) throw fail()
        if (info.isDirectory()) { await visit(target, raw); continue }
        if (!info.isFile() || info.nlink !== 1 || info.size > LIMITS.fileBytes || entries.length >= LIMITS.files + 1
          || (raw !== 'SKILL.md' && canonical.key.split('/').at(-1) === 'skill.md')) throw fail()
        total += info.size; if (total > LIMITS.totalBytes) throw fail()
        const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        let bytes
        try { const prior = await file.stat(); if (stamp(prior) !== stamp(info)) throw fail(); const buffer = Buffer.alloc(info.size + 1)
          const read = await file.read(buffer, 0, buffer.length, 0); if (read.bytesRead !== info.size || stamp(await file.stat()) !== stamp(prior)) throw fail()
          bytes = buffer.subarray(0, read.bytesRead)
        } finally { await file.close() }
        entries.push({ path: raw, size: bytes.length, digest: `sha256:${sha(bytes)}`, bytesBase64: bytes.toString('base64') })
      }
      if (stamp(await held.stat()) !== stamp(before) || canonicalJson((await fs.readdir(base)).sort()) !== canonicalJson(names)) throw fail()
    } finally { await held.close() }
  }
  await visit(root)
  if (entries.filter(entry => entry.path === 'SKILL.md').length !== 1) throw fail()
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

/** Caller context is a real registered agent. Trusted fixture roots may be injected only at registration.
 * @param {any} ctx @param {{roots?:readonly any[]}} [options] */
export function createScopedSkillCatalogue(ctx, { roots = SCOPED_SKILL_ROOTS } = {}) {
  const trusted = roots.map(item => Object.freeze({ ...item, root: path.resolve(item.root) }))
  /** @param {string} sessionId @param {AbortSignal} signal */
  async function observe(sessionId, signal) {
    const agent = actualAgent(ctx, sessionId), lookup = { scope: agent, cwd: agent.session.header.cwd, signal }
    const snapshot = await ctx.skills.snapshot(lookup)
    // Use the public list contract as well: a changed observation is not advertised as complete.
    const listed = await ctx.skills.list(lookup)
    if (!Array.isArray(snapshot.skills) || !Array.isArray(listed) || listed.length > LIMITS.skills) throw fail()
    const complete = snapshot.complete === true && canonicalJson(snapshot.skills.map(summaryKey)) === canonicalJson(listed.map(summaryKey))
    if (ctx.agents.get(sessionId) !== agent) throw fail()
    return { agent, lookup, listed, complete }
  }
  /** @param {any} request @param {AbortSignal} signal */
  async function read(request, signal, exportBytes = false) {
    closed(request, ['sessionId', 'key']); const observed = await observe(request.sessionId, signal)
    if (!observed.complete) throw fail()
    const selected = observed.listed.find(item => summaryKey(item) === request.key)
    if (!selected) throw fail()
    const definition = await ctx.skills.get(selected.name, observed.lookup)
    if (!definition || summaryKey(definition) !== request.key || typeof definition.content !== 'string'
      || Buffer.byteLength(definition.content) > LIMITS.instructions || Buffer.byteLength(canonicalJson(definition.metadata ?? {})) > LIMITS.metadata) throw fail()
    const view = publicSummary(definition, trusted), classification = classify(definition, trusted)
    if (view.source === 'unknown') throw fail()
    let entries = null, finding = null
    // Personal bundles expose their bounded manifest on detail, while export/duplication stays forbidden.
    const personalBundle = view.source === 'personal' && definition.resourceBase?.kind === 'directory'
      && definition.path === path.join(definition.resourceBase.path, 'SKILL.md')
    if (view.canDuplicate || personalBundle) {
      try { entries = await sourceEntries(definition.resourceBase.path, classification.selected.root, signal) }
      catch { view.canDuplicate = false; finding = 'skill_resources_unavailable' }
    }
    if (exportBytes && (!view.canDuplicate || !entries)) throw fail()
    const after = await observe(request.sessionId, signal)
    if (!after.complete || after.agent !== observed.agent || !after.listed.some(item => summaryKey(item) === request.key)) throw fail()
    const resources = (entries ?? []).filter(entry => entry.path !== 'SKILL.md').map(({ bytesBase64: _bytes, ...resource }) => resource)
    const output = { ...view, instructions: definition.content, metadata: definition.metadata ?? {}, whenToUse: definition.whenToUse ?? null,
      resources, scripts: resources.filter(resource => resource.path.startsWith('scripts/')).map(resource => ({ path: resource.path, size: resource.size })),
      findings: finding ? [{ code: finding }] : [] }
    const digest = `sha256:${sha(canonicalJson({ ...output, ...(entries ? { entries: entries.map(({ bytesBase64: _bytes, ...entry }) => entry) } : {}) }))}`
    return { ...output, digest, ...(exportBytes ? { entries } : {}) }
  }
  return {
    /** @param {any} request @param {AbortSignal} [signal] */
    async list(request, signal = AbortSignal.timeout(10000)) {
      closed(request, ['sessionId']); const observed = await observe(request.sessionId, signal)
      return { complete: observed.complete, items: observed.listed.map(item => ({ ...publicSummary(item, trusted), canDuplicate: observed.complete && publicSummary(item, trusted).canDuplicate })) }
    },
    read: (/** @type {any} */ request, signal = AbortSignal.timeout(10000)) => read(request, signal),
    snapshotBuiltin: (/** @type {any} */ request, signal = AbortSignal.timeout(10000)) => read(request, signal, true),
  }
}

/** Fixed owned remote methods; no path, root, provider, command or plugin-selection argument.
 * @param {any} ctx */
export async function registerScopedSkillCatalogue(ctx) {
  const api = createScopedSkillCatalogue(ctx), { TypertRemoteService, Remote } = await loadHarnessModule('@deepseek-ai/dsh-typert-protocol')
  /** @type {((this:any)=>void)[]} */ const initializers = []
  class ScopedCatalogue extends TypertRemoteService {
    constructor() { super(ctx, 'evimedSkills'); for (const initialize of initializers) initialize.call(this) }
    /** @param {any} request @param {AbortSignal} [signal] */
    async list(request, signal) { return api.list(request, signal) }
    /** @param {any} request @param {AbortSignal} [signal] */
    async read(request, signal) { return api.read(request, signal) }
    /** @param {any} request @param {AbortSignal} [signal] */
    async snapshotBuiltin(request, signal) { return api.snapshotBuiltin(request, signal) }
  }
  for (const method of ['list', 'read', 'snapshotBuiltin']) Remote(ScopedCatalogue.prototype[method], {
    kind: 'method', name: method, static: false, private: false, addInitializer: (/** @type {(this:any)=>void} */ initialize) => initializers.push(initialize),
  })
  return new ScopedCatalogue()
}
