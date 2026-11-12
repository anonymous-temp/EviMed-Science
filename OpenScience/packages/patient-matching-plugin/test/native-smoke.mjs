import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { fixture } from './fixture.mjs'
if (!process.argv[2]) throw new Error('Pass the absolute self-contained package tarball')
const artifact = resolve(process.argv[2]), dsh = process.env.MATCHING_PROOF_DSH ?? '/private/tmp/evimed-research-candidate/node_modules/.bin/dsh'
const temporary = await mkdtemp(join(tmpdir(), 'evimed-matching-native-')), f = fixture(), calls = []
const tokenFile = join(temporary, 'host.token'), fixtureFile = join(temporary, 'fixture.json'), logFile = join(temporary, 'adapter.jsonl')
const credential = 'synthetic-host-token-no-provider-key'
await writeFile(tokenFile, credential, { mode: 0o600 }); await writeFile(fixtureFile, JSON.stringify(f)); await writeFile(logFile, '')
const host = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${credential}`)
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body); calls.push(request)
    assert.ok(request.invocation.callId && request.invocation.agentId && request.invocation.sessionId)
    let result
    if (request.port === 'IdentityPort' && request.operation === 'resolve') {
      if (f.scope.conversationId === 'conversation-a') {
        const id = request.invocation.sessionId
        const old = f.scope.conversationId; f.scope.conversationId = id
        const updated = JSON.stringify(f).replaceAll(old, id); Object.assign(f, JSON.parse(updated)); await writeFile(fixtureFile, JSON.stringify(f))
      }
      result = f.scope
    } else if (request.port === 'IdentityPort') result = { allowed: true, scope: f.scope }
    else if (request.port === 'ExecutionPort' && request.operation === 'assess') result = { status: 'complete', summary: 'Frozen synthetic execution', data: f.prepared, artifacts: [] }
    else if (request.port === 'ResultPort' && request.operation === 'save') {
      assert.equal(request.invocation.tool, 'match_assess'); assert.equal(request.input.executionId, 'execution-a')
      if (request.input.phase === 'failure') {
        assert.equal(Object.hasOwn(request.input,'decisions'),false)
        await writeFile(join(temporary,'failed.json'),JSON.stringify(request.input))
        result={status:'failed',summary:'Synthetic runtime failure saved',data:{resultId:'native-failed',failureCheckpoint:{saved:true,executionId:request.input.executionId}},artifacts:[]}
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return
      }
      await writeFile(join(temporary, 'persisted.json'), JSON.stringify(request.input))
      result = { status: 'complete', summary: 'Persisted synthetic native decision', data: { resultId: 'native-persisted', decisions: request.input.decisions }, artifacts: [] }
    } else result = { status: 'complete', summary: 'Synthetic evidence/calculation', data: { scope: f.scope, preserved: true }, artifacts: [] }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
})
host.listen(0, '127.0.0.1'); await once(host, 'listening')
const env = { ...process.env, DSH_HOME: join(temporary, 'dsh'), HOME: join(temporary, 'home'), DSH_TELEMETRY: '0', EVIMED_PATIENT_MATCHING_ENABLED: '1', EVIMED_PATIENT_MATCHING_HOST_ENDPOINT: `http://127.0.0.1:${host.address().port}/internal/patient-matching/v1/port`, EVIMED_PATIENT_MATCHING_TOKEN_FILE: tokenFile, MATCHING_PROOF_FIXTURE: fixtureFile, MATCHING_PROOF_LOG: logFile }
await mkdir(env.HOME, { recursive: true }); await mkdir(join(temporary, 'workspace'))
const patch = join(temporary, 'synthetic.patch.yml')
await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: synthetic-parent\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: matching-synthetic-provider\n      name: '${fileURLToPath(new URL('./native-provider.mjs', import.meta.url))}'\n`)
function command(args, overrides = {}) {
  const output = spawnSync(dsh, args, { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60000, cwd: join(temporary, 'workspace') })
  assert.equal(output.status, 0, output.stderr || output.stdout); return output.stdout
}
async function run(enabled, overrides = {}) {
  const process = spawn(dsh, ['--profile', 'matching-proof', '--patch', patch, '--json', 'Run the synthetic matching proof.'], { env: { ...env, EVIMED_PATIENT_MATCHING_ENABLED: enabled ? '1' : '0', ...overrides }, cwd: join(temporary, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''; process.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-50000) }); process.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-50000) })
  const timeout = setTimeout(() => process.kill('SIGKILL'), 45000)
  try { const [code] = await once(process, 'exit'); assert.equal(code, 0, logs); return logs } finally { clearTimeout(timeout) }
}
try {
  command(['--profile', 'matching-proof', '--from-default-profile', 'headless', '--dump-config'])
  command(['plugin', '--profile', 'matching-proof', 'add', artifact, '--offline', '--ignore-scripts'])
  const profile = JSON.parse(await readFile(join(env.DSH_HOME, 'profiles/matching-proof/package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('@evimed/dsh-patient-matching'))
  const logs = await run(true)
  const saved = JSON.parse(await readFile(join(temporary, 'persisted.json'), 'utf8').catch(() => { throw new Error(`No persisted native result: ${logs}`) }))
  assert.equal(saved.decisions.length, 1); assert.ok(saved.native.childId && saved.native.messageId)
  const on = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const root = on.find(row => row.model === 'synthetic-parent'), child = on.filter(row => row.model === 'deepseek-flash')
  assert.ok(root.skills.includes('patient-matching'))
  assert.equal(root.tools.filter(name => name.startsWith('match_')).length, 9)
  assert.equal(child.length, 3); for (const request of child) { assert.deepEqual(request.tools.sort(), ['match_compute', 'match_evidence', 'structured_output']); assert.equal(request.reasoningEffort, 'high'); assert.equal(request.maxTokens, 8000) }
  assert.ok(calls.some(row => row.invocation.tool === 'match_evidence' && row.port === 'PatientDataPort' && row.operation === 'read'))
  assert.ok(calls.some(row => row.invocation.tool === 'match_compute' && row.operation === 'compute'))
  assert.ok(calls.some(row => row.operation === 'assess' && row.input.phase === 'refresh'))
  await writeFile(logFile, ''); await run(false)
  const off = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(off.length > 0); for (const row of off) { assert.equal(row.tools.filter(name => name.startsWith('match_')).length, 0); assert.equal(row.skills.includes('patient-matching'), false) }
  const writesBeforeBudget = calls.filter(row => row.port === 'ResultPort' && row.operation === 'save' && row.input.phase === 'commit').length
  f.prepared.task.budgets.maxModelCalls = 1; await writeFile(fixtureFile, JSON.stringify(f)); await writeFile(logFile, '')
  const budgetLogs = await run(true)
  const budgetCalls = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.model === 'deepseek-flash')
  assert.equal(budgetCalls.length, 1, budgetLogs)
  assert.equal(calls.filter(row => row.port === 'ResultPort' && row.operation === 'save' && row.input.phase === 'commit').length, writesBeforeBudget)
  assert.match(budgetLogs, /native_model_call_budget_exhausted/)
  f.prepared.task.budgets.maxModelCalls = 4; await writeFile(fixtureFile, JSON.stringify(f)); await writeFile(logFile, '')
  const cancelLogs = await run(true, { MATCHING_PROOF_CANCEL_CHILD: '1' })
  const cancelled = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(cancelled.find(row => row.cancellation)?.cancellation, { cancelled: true })
  assert.equal(cancelled.filter(row => row.model === 'deepseek-flash').length, 1)
  assert.equal(cancelled.filter(row => row.model === 'synthetic-parent').at(-1).liveAgents, 1, 'Native child must be disposed before the parent resumes')
  assert.equal(calls.filter(row => row.port === 'ResultPort' && row.operation === 'save' && row.input.phase === 'commit').length, writesBeforeBudget)
  assert.match(cancelLogs, /cancelled/)
  const failuresBeforeMalformed=calls.filter(row=>row.port==='ResultPort'&&row.operation==='save'&&row.input.phase==='failure').length
  await writeFile(logFile,'');const malformedLogs=await run(true,{MATCHING_PROOF_INVALID_CHILD:'1'})
  const failed=JSON.parse(await readFile(join(temporary,'failed.json'),'utf8'))
  assert.equal(failed.phase,'failure');assert.equal(Object.hasOwn(failed,'decisions'),false);assert.ok(failed.native.childId&&failed.native.messageId)
  assert.equal(calls.filter(row=>row.port==='ResultPort'&&row.operation==='save'&&row.input.phase==='failure').length,failuresBeforeMalformed+1)
  assert.match(malformedLogs,/Non-clinical failed attempts were saved/)
  const receipt = { sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), kernel: command(['--version']).trim(), artifact, installation: 'passed: offline self-contained tarball', nativeTools: 9, nativeManagedChild: 'passed', nativeFailureCheckpoint: 'passed', nativeModelCallBudget: 'passed', nativeCancelRpcAndDisposal: 'passed', childEvidenceAndCompute: 'passed', structuredPersistence: 'passed', FlashProfileOverride: 'passed (synthetic parent has a distinct model)', disabledGeneralConversation: 'passed', paidModelCalls: 0, syntheticOnly: true }
  await writeFile(`${artifact}.native-smoke.json`, `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify(receipt, null, 2))
} finally { await new Promise(closed => host.close(closed)); await rm(temporary, { recursive: true, force: true }) }
