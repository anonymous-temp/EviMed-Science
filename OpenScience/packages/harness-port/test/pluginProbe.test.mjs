import assert from 'node:assert/strict'
import test from 'node:test'
import { __setHarnessModule, loadHarnessModule } from '../index.mjs'
__setHarnessModule('@deepseek-ai/dsh-scope',{scopeOf:(/** @type {any} */ ctx)=>ctx.agent,scopeChainOf:(/** @type {any} */ agent)=>[agent]})
import { pluginRuntimeBusy, verifyCitationAgent, registerCitationConfiguration } from '../src/pluginProbe.mjs'

test('a queued native input or maintenance task is busy even when status says idle', async () => {
  const idle = { status: 'idle', inbox: { hasPending: false }, runMaintenance: async (/** @type {any} */ fn) => fn() }
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [idle] } }), false)
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [{ ...idle, inbox: { hasPending: true } }] } }), true)
  assert.equal(await pluginRuntimeBusy({ agents: { list: () => [{ ...idle, runMaintenance: () => { throw new Error('busy') } }] } }), true)
})
test('proof observes actual agent registrations and executes only fixed health and DOI calls', async () => {
  /** @type {any[]} */ const calls=[]
  const config={revision:2,enabled:true,timeoutMs:4000,binaryVersion:'0.3.2'}
  const agent={ctx:{get:()=>config},runMaintenance:async(/** @type {any} */ fn)=>fn(AbortSignal.timeout(1000))}
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
  const scope={agent,effect:(/** @type {any} */ fn)=>fn()}
  await registerCitationConfiguration(scope,config)
  const result=await verifyCitationAgent(ctx,agent)
  assert.equal(result.timeoutMs,4000);assert.equal(result.binaryVersion,'0.3.2');assert.deepEqual(result.tools,names)
  assert.deepEqual(calls.map(x=>[x.name,x.arguments]),[['cite_health',{}],['cite_lookup',{doi:'10.1038/nphys1170'}]])
  config.enabled=false
  await registerCitationConfiguration(scope,config)
  await assert.rejects(verifyCitationAgent(ctx,agent),/registrations/)
  ctx.tools.get=()=>undefined
  assert.deepEqual((await verifyCitationAgent(ctx,agent)).tools,[])
  assert.equal(calls.length,2)
})

test('the isolated native pipeline still validates registered input and output schemas', async () => {
  const { defineTool } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  for (const invalid of ['input', 'output']) {
    /** @type {string[]} */ const executed = []
    const agent = { runMaintenance: async (/** @type {any} */ operation) => operation(AbortSignal.timeout(1000)) }
    const definitions = new Map(['cite_lookup', 'cite_format', 'cite_bibtex', 'cite_check', 'cite_health'].map(name => [name, defineTool({
      name, description: name,
      parameters: name === 'cite_health' && invalid === 'input' ? { requiredField: { type: 'string', required: true } } : {},
      output: { schema: name === 'cite_health' && invalid === 'output' ? { type: 'string' } : { type: 'object', additionalProperties: true }, render: () => [] },
      execute: async () => { executed.push(name); return { ok: true } },
    })]))
    await registerCitationConfiguration({ agent, effect: (/** @type {any} */ install) => install() },
      { revision: 1, enabled: true, timeoutMs: 4000, binaryVersion: '0.3.2' })
    await assert.rejects(verifyCitationAgent({ tools: { get: (/** @type {string} */ name) => definitions.get(name) } }, agent), /citation_probe_gateway_failed/)
    assert.deepEqual(executed, invalid === 'input' ? [] : ['cite_health'])
  }
})
