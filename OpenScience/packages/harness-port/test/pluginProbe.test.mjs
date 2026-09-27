import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHarnessModule } from '../index.mjs'
import { pluginRuntimeBusy, verifyCitationAgent, registerCitationConfiguration } from '../src/pluginProbe.mjs'

/** Every live registration a test made, disposed after it: the registry is
 *  runtime-wide, as the configuration it holds is. */
/** @type {(() => void)[]} */
const mounted = []
test.afterEach(() => { while (mounted.length) mounted.pop()?.() })

/** An agent, and a context the citation bridge could be mounted in: a Cordis
 *  context's `effect` runs the install now and keeps its undo for disposal.
 *  @param {Record<string, any>} [extra] */
function kernelAgent(extra = {}) {
  /** @type {any} */ const agent = { runMaintenance: async (/** @type {any} */ operation) => operation(AbortSignal.timeout(1000)), ...extra }
  const mount = () => ({ effect: (/** @type {() => () => void} */ install) => { const undo = install(); mounted.push(undo); return undo } })
  return { agent, mount }
}

test('a queued native input or maintenance task is busy even when status says idle', async () => {
  const idle = { status: 'idle', inbox: { hasPending: false }, runMaintenance: async (/** @type {any} */ fn) => fn() }
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [idle] } }), false)
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [{ ...idle, inbox: { hasPending: true } }] } }), true)
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [{ ...idle, runMaintenance: () => { throw new Error('busy') } }] } }), true)
})
test('proof observes actual agent registrations and asks the source one fixed health call', async () => {
  /** @type {any[]} */ const calls=[]
  const config={revision:2,enabled:true,timeoutMs:4000,binaryVersion:'0.3.2'}
  const { agent, mount } = kernelAgent()
  const names=['cite_lookup','cite_format','cite_bibtex','cite_check','cite_health']
  const { defineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  const definitions = new Map(names.map(name => [name, defineTool({
    name, description: name, parameters: name === 'cite_lookup' ? { doi: { type: 'string', required: true } } : {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    execute: async (/** @type {any} */ args, /** @type {any} */ exec) => {
      calls.push({ name: exec.name, arguments: args })
      return name === 'cite_health' ? { ok: true } : { works: [{ doi: '10.1038/nphys1170' }] }
    },
  })]))
  const ctx={tools:{get:(/** @type {string} */ name,/** @type {any} */ subject)=>subject===agent?definitions.get(name):undefined,
    execute:async()=>{assert.fail('probe must not broadcast through the research host pipeline')}}}
  const scope=mount()
  await registerCitationConfiguration(scope,config)
  const result=await verifyCitationAgent(ctx,agent)
  assert.equal(result.timeoutMs,4000);assert.equal(result.binaryVersion,'0.3.2');assert.deepEqual(result.tools,names)
  assert.deepEqual(result.upstream,{ok:true,code:null})
  assert.deepEqual(calls.map(x=>[x.name,x.arguments]),[['cite_health',{}]],'one source request per proof')
  // A remount with the tools switched off, the old mount disposed as a reload would.
  mounted.pop()?.()
  config.enabled=false
  await registerCitationConfiguration(mount(),config)
  await assert.rejects(verifyCitationAgent(ctx,agent),/registrations/)
  ctx.tools.get=()=>undefined
  const disabled=await verifyCitationAgent(ctx,agent)
  assert.deepEqual(disabled.tools,[]);assert.equal(disabled.upstream,null,'switched off, the source is not asked')
  assert.equal(calls.length,1)
})

/** A proof whose `cite_health` answers as dsh-cite 0.3.2 does: `HTTP <status>`
 *  for an answer, the thrown message plus its proxy hint for a transport error.
 *  @param {() => any} health */
async function proofWith(health) {
  const { defineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  const names = ['cite_lookup', 'cite_format', 'cite_bibtex', 'cite_check', 'cite_health']
  const { agent, mount } = kernelAgent()
  const definitions = new Map(names.map(name => [name, defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    execute: async () => (name === 'cite_health' ? health() : {}),
  })]))
  await registerCitationConfiguration(mount(),
    { revision: 1, enabled: true, timeoutMs: 4000, binaryVersion: '0.3.2' })
  return verifyCitationAgent({ tools: { get: (/** @type {string} */ name) => definitions.get(name) } }, agent)
}
/** @param {string} detail */
const unhealthy = (detail) => () => ({ ok: false, plugin: 'dsh-cite', checks: [{ name: 'Crossref API', ok: false, detail }, { name: '请求配置', ok: true, detail: 'timeoutMs=4000' }] })
const hint = '（网络需要特殊代理时请配置系统代理后重启）'

test('the source being down is reported beside the proof, never as a failed proof', async () => {
  // Crossref timed out on about a quarter of requests from the production host
  // (2026-09-26 audit); a proof that needed its answer failed applies at random.
  for (const [health, code] of [
    [unhealthy('HTTP 429'), 'http_429'],
    [unhealthy('HTTP 502'), 'http_502'],
    [unhealthy('HTTP 504'), 'http_504'],
    [unhealthy('HTTP 404'), 'http_404'],
    [unhealthy(`citation_gateway_timeout${hint}`), 'citation_gateway_timeout'],
    [unhealthy(`The operation was aborted due to timeout${hint}`), 'citation_gateway_timeout'],
    [unhealthy(`citation_response_too_large${hint}`), 'citation_response_too_large'],
    [() => ({ ok: false }), 'cite_health_failed'],
  ]) {
    const proof = await proofWith(/** @type {() => any} */ (health))
    assert.deepEqual(proof.upstream, { ok: false, code }, String(code))
    assert.deepEqual([proof.binaryVersion, proof.revision, proof.enabled, proof.timeoutMs, proof.tools.length], ['0.3.2', 1, true, 4000, 5])
  }
})

test('a transport the deployment owns failing still fails the proof, and says which', async () => {
  for (const [detail, reason] of [
    [`citation_gateway_token_unavailable${hint}`, 'the runtime could not read its gateway token (citation_gateway_token_unavailable)'],
    [`citation_gateway_unconfigured${hint}`, 'the runtime was given no source gateway or token file (citation_gateway_unconfigured)'],
    [`citation_gateway_unavailable${hint}`, 'the runtime could not reach the source gateway (citation_gateway_unavailable)'],
    ['HTTP 401', 'the source gateway refused the runtime token (HTTP 401)'],
    ['HTTP 403', 'the source gateway refused the approved endpoint (HTTP 403)'],
  ]) {
    await assert.rejects(proofWith(unhealthy(detail)), { message: `citation_probe_gateway_failed: ${reason}` })
  }
  // The registered definition refused by the native pipeline is the
  // registration failing, whatever the source is doing.
  await assert.rejects(proofWith(() => { throw new Error('cancelled') }), /^Error: citation_probe_gateway_failed: cite_health: /u)
})

test('a failed proof says which check failed and why', async () => {
  // The first production apply (2026-09-27) failed with nothing recorded but a bare code.
  // A reason is one bounded line, whatever the tool said.
  await assert.rejects(proofWith(() => { throw new Error(`line\nbreak ${'x'.repeat(500)}`) }),
    (/** @type {any} */ error) => !/\n/.test(error.message) && error.message.length <= 'citation_probe_gateway_failed: '.length + 240)
  // And the registrations a proof found, when they are not the ones it needs.
  const { agent, mount } = kernelAgent()
  await registerCitationConfiguration(mount(), { revision: 1, enabled: true, timeoutMs: 4000, binaryVersion: '0.3.2' })
  await assert.rejects(verifyCitationAgent({ tools: { get: (/** @type {string} */ name) => name === 'cite_health' ? {} : undefined } }, agent),
    { message: 'citation_probe_registrations_invalid: enabled=true, registered cite_health' })
  // Two different configurations live in one runtime is not a configuration.
  await registerCitationConfiguration(mount(), { revision: 2, enabled: true, timeoutMs: 4000, binaryVersion: '0.3.2' })
  await assert.rejects(verifyCitationAgent({ tools: { get: () => undefined } }, agent),
    { message: 'citation_probe_config_invalid: 2 different citation configurations are live in this runtime' })
  while (mounted.length) mounted.pop()?.()
  await assert.rejects(verifyCitationAgent({ tools: { get: () => undefined } }, agent),
    { message: 'citation_probe_config_invalid: no citation configuration is registered in this runtime' })
})

test('the isolated native pipeline still validates registered input and output schemas', async () => {
  const { defineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  for (const invalid of ['input', 'output']) {
    /** @type {string[]} */ const executed = []
    const { agent, mount } = kernelAgent()
    const definitions = new Map(['cite_lookup', 'cite_format', 'cite_bibtex', 'cite_check', 'cite_health'].map(name => [name, defineTool({
      name, description: name,
      parameters: name === 'cite_health' && invalid === 'input' ? { requiredField: { type: 'string', required: true } } : {},
      output: { schema: name === 'cite_health' && invalid === 'output' ? { type: 'string' } : { type: 'object', additionalProperties: true }, render: () => [] },
      execute: async () => { executed.push(name); return { ok: true } },
    })]))
    await registerCitationConfiguration(mount(), { revision: 1, enabled: true, timeoutMs: 4000, binaryVersion: '0.3.2' })
    await assert.rejects(verifyCitationAgent({ tools: { get: (/** @type {string} */ name) => definitions.get(name) } }, agent), /citation_probe_gateway_failed/)
    assert.deepEqual(executed, invalid === 'input' ? [] : ['cite_health'])
  }
})
