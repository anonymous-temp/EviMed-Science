import { catalogue } from './catalogue.mjs'
import { hostedReferenceParameters, hostedStudyParameter } from './hostedProtocol.mjs'
import { renderResearchReport } from './report.mjs'
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { jobDirectory, assertNoSymlinks, readOwnedFile, writeOwnedFile, scientificEnvironment } from './workspaceFs.mjs'
import { signalVerifiedGroup, groupSnapshot, signalKnownSurvivors } from './processIdentity.mjs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const scientificInterpretationGuidance = 'Distinguish assumed parameters from realized synthetic sample summaries. A nonsignificant diagnostic does not establish validity, transitivity or consistency. Separate jobs or equal seeds do not establish independent random streams; do not derive contrast intervals unless the dependence or stream design is verified.'

/** @typedef {Record<string, any>} ResearchRequest */
/** @typedef {{ start: (request: ResearchRequest) => Promise<any>, read: (jobId: string) => Promise<any>, cancel: (jobId: string) => Promise<any>, describe?: (method: string) => Promise<any>, readRequest?: (jobId: string) => Promise<any>, saveReport?: (jobId: string, report: string, reproduction: any) => Promise<any>, forCall?: (call: any) => ResearchAdapter }} ResearchAdapter */
/** @param {Record<string, any>} source */
function validSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const user = source.origin === 'user'
  const required = user ? ['origin', 'field', 'value', 'quote', 'unit', 'context'] : ['field', 'publication', 'quote']
  const allowed = user ? [...required, 'sessionId', 'messageSeq'] : required
  if (Object.keys(source).some(key => !allowed.includes(key))) return false
  if (required.some(key => key === 'value' ? typeof source[key] !== 'number' || !Number.isFinite(source[key]) : typeof source[key] !== 'string' || !source[key])) return false
  return (source.sessionId === undefined || typeof source.sessionId === 'string') && (source.messageSeq === undefined || Number.isInteger(source.messageSeq) && source.messageSeq >= 0)
}

/** Adapter scope belongs to the host, never to the caller.
 * @param {{adapter: ResearchAdapter, methods: readonly string[]}} options
 */
export function createPlugin({ adapter, methods }) {
  if (!adapter || !Array.isArray(methods)) throw new TypeError('adapter and methods are required')
  const allowed = new Set(methods)
  return Object.freeze({
    listMethods: () => [...allowed],
    /** @param {ResearchRequest} request */
    async start(request) {
      if (!allowed.has(request?.method)) throw new Error('unsupported_method')
      return adapter.start(request)
    },
    /** @param {string} jobId */
    read: (jobId) => adapter.read(jobId),
    /** @param {string} jobId */
    cancel: (jobId) => adapter.cancel(jobId),
  })
}

/** Local process adapter. engineRoot must point at the separately installed VCR engine.
 * @param {{workspace: string, engineRoot: string, rscript?: string}} options
 */
export function createLocalAdapter({ workspace, engineRoot, rscript = 'Rscript' }) {
  const workspaceRoot = realpath(resolve(workspace))
  /** @param {string} id @param {boolean} create */
  const dir = async (id, create = false) => {
    const root = await workspaceRoot
    if (await realpath(root) !== root) throw new Error('unsafe_workspace_path')
    return jobDirectory(root, id, create)
  }
  return {
    /** @param {string} method */
    async describe(method) {
      const snapshot = JSON.parse(await readFile(join(engineRoot, 'R', 'domain-snapshot.json'), 'utf8'))
      if (!snapshot.methods[method]) throw new Error('unsupported_method')
      return { method, ...snapshot.methods[method], scenarioSchema: snapshot.scenarioSchemas?.[method] ?? null }
    },
    /** @param {ResearchRequest} request */
    async start(request) {
      const { method, scenario, version, inputs, seed = 1, replicates, sources, cpuSecondsLimit = 600 } = request
      if (Object.keys(hostedReferenceParameters).some(key => request[key] !== undefined)) throw new Error('hosted_reference_unavailable_use_local_inputs')
      if (Object.keys(request).some(key => !['method', 'scenario', 'version', 'inputs', 'seed', 'replicates', 'sources', 'cpuSecondsLimit'].includes(key))) throw new Error('invalid_research_request')
      if (sources !== undefined && (!Array.isArray(sources) || sources.length > 8 || sources.some(source => !validSource(source)))) throw new Error('invalid_sources')
      const snapshot = JSON.parse(await readFile(join(engineRoot, 'R', 'domain-snapshot.json'), 'utf8'))
      const kind = Object.keys(snapshot.jobMethods).find((key) => snapshot.jobMethods[key] === method)
      const expected = snapshot.methods[method]?.version
      if (!kind || !expected || (version && version !== expected)) throw new Error('unsupported_method_version')
      const jobId = `job_${randomUUID()}`
      const output = await dir(jobId, true)
      await assertNoSymlinks(output)
      /** @type {Record<string, any>} */
      const job = { jobId, studyId: 'std_local', kind, method, methodVersion: expected, protocolVersion: 1,
        scenario, inputs: inputs ?? [{ kind: 'assumption', id: 'asm_local@1' }], seed, cores: 1, cpuSecondsLimit }
      if (replicates !== undefined) job.replicates = replicates
      await writeOwnedFile(output, 'job.json', JSON.stringify(job, null, 2))
      if (sources) await writeOwnedFile(output, 'sources-unverified.json', JSON.stringify(sources, null, 2))
      await writeOwnedFile(output, 'state.json', JSON.stringify({ status: 'running', heartbeat: Date.now() }))
      const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), await workspaceRoot, jobId, resolve(engineRoot), rscript], { detached: true, stdio: 'ignore', env: scientificEnvironment(process.env) })
      child.unref()
      return { jobId }
    },
    /** @param {string} jobId */
    async read(jobId) {
      const output = await dir(jobId)
      await assertNoSymlinks(output)
      await readOwnedFile(output, 'job.json')
      try { return JSON.parse(await readOwnedFile(output, 'result.json')) } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
      try {
        const receipt = JSON.parse(await readOwnedFile(output, 'cancelled.json'))
        if (receipt.terminated) return { status: 'cancelled' }
      } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
      try {
        const state = JSON.parse(await readOwnedFile(output, 'state.json'))
        if (state.status === 'cancelling') return { ...state, status: 'running' }
        if (state.status === 'running' && Date.now() - state.heartbeat > 5000) return { status: 'interrupted' }
        return state
      } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error; return { status: 'running' } }
    },
    /** @param {string} jobId */
    async readRequest(jobId) {
      const output = await dir(jobId)
      await assertNoSymlinks(output)
      const job = JSON.parse(await readOwnedFile(output, 'job.json'))
      let sources = null
      try { sources = JSON.parse(await readOwnedFile(output, 'sources-unverified.json')) } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
      return { job, sources, sourceVerification: sources ? 'asserted_assumptions_not_verified' : 'not_supplied' }
    },
    /** @param {string} jobId @param {string} report @param {any} reproduction */
    async saveReport(jobId, report, reproduction) {
      const output = await dir(jobId)
      await assertNoSymlinks(output)
      await readOwnedFile(output, 'job.json')
      await writeOwnedFile(output, 'report.md', report)
      await writeOwnedFile(output, 'reproduction.json', JSON.stringify(reproduction, null, 2))
      return { path: join(output, 'report.md'), reproductionPath: join(output, 'reproduction.json') }
    },
    /** @param {string} jobId */
    async cancel(jobId) {
      const output = await dir(jobId)
      await assertNoSymlinks(output)
      await readOwnedFile(output, 'job.json')
      const existing = await this.read(jobId)
      if (existing.status !== 'running' && existing.status !== 'interrupted') return
      await writeOwnedFile(output, 'CANCEL', '')
      for (let i = 0; i < 30; i++) {
        const state = JSON.parse(await readOwnedFile(output, 'state.json'))
        const identity = state.engineProcess
        const members = identity ? await groupSnapshot(identity, output, resolve(engineRoot)) : []
        if (identity && members.length && await signalVerifiedGroup(identity, output, resolve(engineRoot), 'SIGTERM')) {
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(done => setTimeout(done, 100))
            if (!await signalKnownSurvivors(members, identity.pid, 0)) {
              await writeOwnedFile(output, 'cancelled.json', JSON.stringify({ terminated: true }))
              return
            }
          }
          await signalKnownSurvivors(members, identity.pid, 'SIGKILL')
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(done => setTimeout(done, 100))
            if (!await signalKnownSurvivors(members, identity.pid, 0)) {
              await writeOwnedFile(output, 'cancelled.json', JSON.stringify({ terminated: true }))
              return
            }
          }
          throw new Error('cancellation_unconfirmed')
        }
        const latest = await this.read(jobId)
        if (latest.status !== 'running' && latest.status !== 'interrupted') return
        await new Promise(done => setTimeout(done, 100))
      }
      throw new Error('cancellation_unconfirmed')
    },
  }
}

/** Register callable DSH tools. Configuration paths are supplied by the operator.
 * @param {any} ctx
 * @param {{ name: string, methods: readonly string[], mode: string, workspace: string, engineRoot: string, rscript?: string, skillUrl?: URL }} config
 */
export async function registerResearchTools(ctx, config) {
  if (config.mode === 'standalone') return registerConfiguredResearchTools(ctx, config)
  // Native bundles can precede the socket in the upstream loader. Cordis owns
  // waiting for the provider and disposing registrations when it disappears.
  ctx.inject(['evimedResearchAdapter'], (/** @type {any} */ scoped) => registerConfiguredResearchTools(scoped, config))
}
/** @param {any} ctx
 * @param {{ name: string, methods: readonly string[], mode: string, workspace: string, engineRoot: string, rscript?: string, skillUrl?: URL }} config */
async function registerConfiguredResearchTools(ctx, { name, methods, mode, workspace, engineRoot, rscript, skillUrl }) {
  const { defineTool, registerTool, registerResearchConfiguration, registerSkill, registerSection } = await import('@evimed/harness-port')
  const adapter = ctx.get?.('evimedResearchAdapter') ?? (mode === 'standalone' && workspace && engineRoot ? createLocalAdapter({ workspace, engineRoot, rscript }) : null)
  if (!adapter) throw new Error('research_adapter_not_configured')
  const overview = catalogue.find(item => item.id === name.replaceAll('_', '-'))
  ctx.inject(['systemPrompt'], (/** @type {any} */ scoped) => {
    scoped.effect(() => registerSection(scoped, { name: `evimed-research-${name}`, order: 160,
      text: `Research domain: ${overview?.task ?? name}\nFor a question in this domain, use ${name}_describe to find applicable registered methods and ${name}_start/read/report/cancel for scientific computations and preserved results. Prefer these methods to ad hoc scripts when they fit; compatibility tools remain available for existing hosted records and other operations. Use only the operations the question needs, in any useful order. Answer explanations directly. When required inputs are absent, state what is needed and finish the reply; do not manufacture replacement patient data. Explicitly authorized demonstrations may use clearly labeled assumptions. ${scientificInterpretationGuidance} Unrelated general work stays ordinary conversation.` }))
  })
  // A bundle's skill belongs in the upstream on-demand skill catalogue, not
  // only in a describe response that a model may never request.
  if (skillUrl) {
    const content = await readFile(skillUrl, 'utf8')
    ctx.inject(['skills'], (/** @type {any} */ scoped) => {
      scoped.effect(() => registerSkill(scoped, { name: name.replaceAll('_', '-'),
        description: overview?.task ?? 'Virtual research', content, resourceDir: fileURLToPath(new URL('.', skillUrl)),
        whenToUse: `For this research domain, use the installed ${name}_describe/start/read/report/cancel tools when applicable. Answer only the requested parts; for missing essential inputs, explain what is needed instead of inventing data.` }))
    })
  }
  /** @param {any} call */
  const forCall = (call) => adapter.forCall?.(call) ?? adapter
  /** @param {any} call */
  const pluginFor = (call) => createPlugin({ adapter: forCall(call), methods })
  /** A lab tool needs the hosted platform, which persists and advances campaigns. @param {any} call @param {'search' | 'compare'} kind @param {any} args */
  const labCall = async (call, kind, args) => {
    const scoped = /** @type {any} */ (forCall(call))
    if (typeof scoped[kind] !== 'function') throw new Error('research_lab_hosted_only')
    return { ok: true, data: await scoped[kind](args) }
  }
  /** @type {Parameters<typeof import('@evimed/harness-port').defineTool>[0][]} */
  const definitions = [
    { name: `${name}_describe`, description: `${overview?.task ?? 'Virtual research'}. Discover methods, prerequisites and one method schema. Answer conceptual questions directly. If essential inputs are missing, finish with a concise list of what is needed; do not repeatedly inspect schemas or manufacture data. Prefer an applicable registered method over an ad hoc calculation.`, parameters: { method: { type: 'string' }, ...hostedStudyParameter }, execute: async ({ method }, call) => {
      if (!method) return { ok: true, data: { ...overview, methods, guidance: skillUrl ? await readFile(skillUrl, 'utf8') : null } }
      if (!methods.includes(method)) throw new Error('unsupported_method')
      if (!forCall(call).describe) return { ok: true, data: { method, schemaAvailable: false } }
      return { ok: true, data: { ...await forCall(call).describe(method), interpretationGuidance: scientificInterpretationGuidance } }
    } },
    { name: `${name}_start`, description: `${overview?.task ?? 'Virtual research'}. Start a research computation using an installed method. Available method IDs: ${methods.join(', ')}. Use only explicit assumptions and authorized inputs.`,
      parameters: { method: { type: 'string', required: true }, scenario: { type: 'object', additionalProperties: true, required: true }, version: { type: 'string' }, inputs: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } }, sources: { type: 'array', description: 'At most 8 source assertions: publication {field, publication, quote} or user {origin: user, field, value, quote, unit, context, sessionId?, messageSeq?}. Assertions need independent verification.', items: { type: 'object', additionalProperties: true, properties: {} } }, seed: { type: 'integer' }, replicates: { type: 'integer' }, cpuSecondsLimit: { type: 'integer' }, ...hostedReferenceParameters, ...hostedStudyParameter },
      execute: async (args, call) => ({ ok: true, data: await pluginFor(call).start(args) }) },
    { name: `${name}_read`, description: 'Read the state and result of a research job.', parameters: { jobId: { type: 'string', required: true }, ...hostedStudyParameter }, execute: async ({ jobId }, call) => ({ ok: true, data: await pluginFor(call).read(jobId) }) },
    { name: `${name}_report`, description: 'Compose an inspectable report from a completed research job, preserving its assumptions and limitations.', parameters: { jobId: { type: 'string', required: true }, ...hostedStudyParameter }, execute: async ({ jobId }, call) => {
      const scoped = forCall(call)
      const result = await pluginFor(call).read(jobId)
      if (result.status !== 'succeeded') throw new Error('job_not_succeeded')
      const request = scoped.readRequest ? await scoped.readRequest(jobId) : null
      const report = renderResearchReport(result, request)
      const reproduction = { result, request }
      const saved = scoped.saveReport ? await scoped.saveReport(jobId, report, reproduction) : null
      return { ok: true, data: { report, ...(saved ?? { reproduction }) } }
    } },
    { name: `${name}_cancel`, description: 'Cancel a running research job.', parameters: { jobId: { type: 'string', required: true }, ...hostedStudyParameter }, execute: async ({ jobId }, call) => { await pluginFor(call).cancel(jobId); return { ok: true, data: { jobId, requested: true } } } },
    // The virtual lab (trial plugin, hosted): the model proposes a frozen campaign or a comparison and reads it; code evaluates.
    ...(name === 'virtual_trial' ? [
      { name: 'virtual_trial_search', description: 'Bounded design search. {manifest} freezes objective, constraints with fixed bounds, truths, the searched design paths, screening and final sizes, budget; the platform screens, re-checks finalists at full precision and stops with a reason. {campaignId} reads; add cancel:true to stop.',
        parameters: { manifest: { type: 'object', additionalProperties: true, properties: {} }, campaignId: { type: 'string' }, cancel: { type: 'boolean' }, ...hostedStudyParameter },
        execute: async (/** @type {any} */ args, /** @type {any} */ call) => labCall(call, 'search', args) },
      { name: 'virtual_trial_compare', description: 'Compare arms on one endpoint and analysis: saved design results by resultId (no rerun), design methods, or drug hypotheses on a disease-progression model; contrasts to a reference arm. {experiment} creates, {experimentId} reads.',
        parameters: { experiment: { type: 'object', additionalProperties: true, properties: {} }, experimentId: { type: 'string' }, ...hostedStudyParameter },
        execute: async (/** @type {any} */ args, /** @type {any} */ call) => labCall(call, 'compare', args) },
    ] : []),
  ]
  /** @type {Map<string, any>} */
  const registered = new Map()
  for (const definition of definitions) {
    const tool = await defineTool(definition)
    registered.set(definition.name, tool)
    ctx.effect(() => registerTool(ctx, tool))
  }
  const register = mode === 'standalone' ? registerResearchConfiguration : adapter.registerConfiguration
  if (typeof register !== 'function') throw new Error('research_registration_not_configured')
  await register(ctx, { extensionId: name.replaceAll('_', '-'), definitions: registered })
}
