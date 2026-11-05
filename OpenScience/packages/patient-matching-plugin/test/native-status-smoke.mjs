/** Actual authenticated native RPC, without a prompt, patient input, provider credential or model call. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { browserSessionCookie, browserSessionCredentialRecord, generateBrowserSessionSecret } from '../../../apps/server/src/dshBrowserAuth.mjs'
import { TOOL_MANIFEST } from '../src/manifest.mjs'
if (!process.argv[2]) throw new Error('Pass an absolute self-contained package tarball')
const artifact = resolve(process.argv[2]), dsh = process.env.MATCHING_PROOF_DSH ?? '/private/tmp/evimed-research-candidate/node_modules/.bin/dsh'
const temporary = await mkdtemp(join(tmpdir(), 'evimed-matching-status-'))
const env = { ...process.env, DSH_HOME: join(temporary, 'dsh'), HOME: join(temporary, 'home'), DSH_TELEMETRY: '0', EVIMED_PATIENT_MATCHING_ENABLED: '1', EVIMED_PATIENT_MATCHING_HOST_ENDPOINT: 'http://127.0.0.1:1/internal/patient-matching/v1/port', EVIMED_PATIENT_MATCHING_TOKEN_FILE: join(temporary, 'host.token'), MATCHING_PROOF_NO_MODEL_LOG: join(temporary, 'model-attempts.log') }
await mkdir(env.HOME, { recursive: true }); await mkdir(env.DSH_HOME, { recursive: true }); await mkdir(join(temporary, 'workspace'))
await writeFile(env.EVIMED_PATIENT_MATCHING_TOKEN_FILE, 'synthetic-host-token-not-a-provider-key', { mode: 0o600 })
await writeFile(env.MATCHING_PROOF_NO_MODEL_LOG, '')
const secret = generateBrowserSessionSecret(), credential = browserSessionCredentialRecord({ secret })
await writeFile(join(env.DSH_HOME, '.credentials.yaml'), JSON.stringify({ version: 1, refs: {}, records: { [credential.key]: credential.record } }), { mode: 0o600 })
const patch = join(temporary, 'no-model.patch.yml')
await writeFile(patch, `- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: llm-pi-ai\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- insert:\n    - id: matching-no-model-proof\n      name: '${fileURLToPath(new URL('./native-no-model.mjs', import.meta.url))}'\n`)
function command(args) {
  const output = spawnSync(dsh, args, { env, encoding: 'utf8', timeout: 60000, cwd: join(temporary, 'workspace') })
  assert.equal(output.status, 0, output.stderr); return output.stdout
}
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(closed => server.close(closed)); return port
}
let childProcess, logs = ''
async function stop() {
  if (!childProcess || childProcess.exitCode !== null) return
  const exited = once(childProcess, 'exit'); childProcess.kill('SIGTERM')
  const force = setTimeout(() => childProcess?.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(force) }
}
async function boot(enabled) {
  const port = await unusedPort(), authority = `127.0.0.1:${port}`, origin = `http://${authority}`
  logs = ''
  childProcess = spawn(dsh, ['--profile', 'matching-status', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env: { ...env, EVIMED_PATIENT_MATCHING_ENABLED: enabled ? '1' : '0' }, cwd: join(temporary, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'] })
  childProcess.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-18000) }); childProcess.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-18000) })
  const cookie = browserSessionCookie({ secret, authority })
  async function rpc(args = {}, authenticated = true, method = 'patientMatching/status') {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId: 'status-proof', method, payload: { args } }), signal: AbortSignal.timeout(2000) })
    return { status: response.status, body: await response.text() }
  }
  let response
  for (let attempt = 0; attempt < 150; attempt++) {
    try { response = await rpc(); if (response.status !== 503) break } catch { /* Native carrier is still starting. */ }
    if (childProcess.exitCode !== null) break
    await delay(100)
  }
  assert.ok(response, `Native status carrier failed to start: ${logs.replace(/token=[^\s&#]+/gi, 'token=[redacted]')}`)
  return { rpc, response }
}
try {
  command(['--profile', 'matching-status', '--from-default-profile', 'web', '--dump-config'])
  command(['plugin', '--profile', 'matching-status', 'add', artifact, '--offline', '--ignore-scripts'])
  const on = await boot(true)
  assert.equal(on.response.status, 200, on.response.body)
  const enabled = JSON.parse(on.response.body)
  assert.equal(enabled.result.ok, true, JSON.stringify(enabled.result.error))
  assert.deepEqual(enabled.result.value, { enabled: true, tools: TOOL_MANIFEST.map(tool => tool.name), skill: 'patient-matching' })
  assert.equal((await on.rpc({}, false)).status, 401)
  const injected = await on.rpc({ tools: ['bash'] })
  assert.equal(JSON.parse(injected.body).result.ok, false)
  const inactiveCancellation = await on.rpc({ taskId: 'task-inactive' }, true, 'patientMatching/cancel')
  assert.deepEqual(JSON.parse(inactiveCancellation.body).result.value, { cancelled: false })
  await stop()
  const off = await boot(false)
  assert.ok(off.response.status === 404 || JSON.parse(off.response.body).result?.ok === false, 'Disabled bundle must expose no status service')
  assert.equal(await readFile(env.MATCHING_PROOF_NO_MODEL_LOG, 'utf8'), '')
  const receipt = { artifact, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex'), kernel: command(['--version']).trim(), endpoint: 'patientMatching/status', authentication: 'passed', noArgumentInjection: 'passed', cancelWireArguments: 'passed', actualTools: TOOL_MANIFEST.map(tool => tool.name), actualLoadableSkill: 'patient-matching', disabledServiceAbsent: 'passed', modelCalls: 0, paidModelCalls: 0 }
  await writeFile(`${artifact}.native-status.json`, `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify(receipt, null, 2))
} finally { await stop(); await rm(temporary, { recursive: true, force: true }) }
