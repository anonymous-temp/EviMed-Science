import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createLocalAdapter, createPlugin } from '../index.mjs'

const engineRoot = resolve(import.meta.dirname, '../../../../项目代码/vcr-engine')

test('method admission never passes unsupported calls to the host', async () => {
  let calls = 0
  const plugin = createPlugin({ methods: ['design.analytic'], adapter: { start: async () => { calls++; return { jobId: 'job' } } } })
  await assert.rejects(plugin.start({ method: 'matching.evaluate' }), /unsupported_method/)
  assert.equal(calls, 0)
  assert.equal((await plugin.start({ method: 'design.analytic' })).jobId, 'job')
})

test('local adapter executes and persists a real analytic design', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-plugin-'))
  try {
    const adapter = createLocalAdapter({ workspace, engineRoot, rscript: process.env.RSCRIPT || 'Rscript' })
    await assert.rejects(adapter.start({ method: 'design.analytic', version: '0.0.0', scenario: {} }), /unsupported_method_version/)
    await assert.rejects(adapter.start({ method: 'design.analytic', scenario: {}, sources: [{ field: 'truth.x', publication: '1' }] }), /invalid_sources/)
    const { jobId } = await adapter.start({ method: 'design.analytic', scenario: {
      design: { kind: 'two_arm_fixed' }, endpoint: { type: 'time_to_event' },
      truth: { hazardRatio: 0.7, controlMedian: 12 }, accrual: { duration: 12, followup: 24 }, analysis: { alpha: 0.025, power: 0.9 },
    }, sources: [{ field: 'truth.hazardRatio', publication: 'example', quote: 'asserted sentence' }] })
    let result
    for (let i = 0; i < 100; i++) {
      result = await adapter.read(jobId)
      if (result.status !== 'running') break
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(result.status, 'succeeded')
    assert.equal((await adapter.readRequest(jobId)).sourceVerification, 'asserted_assumptions_not_verified')
    assert.equal(result.measures.find((item) => item.name === 'required_events').value, 331)
    assert.equal((await createLocalAdapter({ workspace, engineRoot }).read(jobId)).status, 'succeeded')
    await assert.rejects(adapter.read('../escape'), /invalid_job_id/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('cancel terminates an active engine process', async () => {
  const { writeFile, chmod } = await import('node:fs/promises')
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-cancel-'))
  try {
    const runner = join(workspace, 'slow-r')
    await writeFile(runner, '#!/bin/sh\nsleep 20\n')
    await chmod(runner, 0o755)
    const adapter = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    const { jobId } = await adapter.start({ method: 'design.analytic', scenario: {} })
    await adapter.cancel(jobId)
    assert.equal((await adapter.read(jobId)).status, 'cancelled')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('a different process can cancel a detached worker, and a dead worker is identified', async () => {
  const { writeFile, readFile, chmod } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-worker-'))
  try {
    const runner = join(workspace, 'slow-r')
    await writeFile(runner, '#!/bin/sh\nsleep 3\n')
    await chmod(runner, 0o755)
    const moduleUrl = new URL('../index.mjs', import.meta.url).href
    const startScript = `import {createLocalAdapter} from ${JSON.stringify(moduleUrl)}; const a=createLocalAdapter(${JSON.stringify({workspace,engineRoot,rscript:runner})}); console.log(JSON.stringify(await a.start({method:'design.analytic',scenario:{}})));`
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', startScript])
    const { jobId } = JSON.parse(stdout)
    const adapter = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    await adapter.cancel(jobId)
    let state
    for (let i = 0; i < 100; i++) { state = await adapter.read(jobId); if (state.status !== 'running') break; await new Promise(done => setTimeout(done, 50)) }
    assert.equal(state.status, 'cancelled')
    const next = await adapter.start({ method: 'design.analytic', scenario: {} })
    for (let i = 0; i < 100; i++) { state = await adapter.read(next.jobId); if (state.workerPid) break; await new Promise(done => setTimeout(done, 20)) }
    assert.ok(state.workerPid)
    process.kill(state.workerPid, 'SIGKILL')
    const stateFile = join(workspace, '.virtual-research', 'jobs', next.jobId, 'state.json')
    const last = JSON.parse(await readFile(stateFile, 'utf8'))
    last.heartbeat = Date.now() - 6000
    await writeFile(stateFile, JSON.stringify(last))
    assert.equal((await adapter.read(next.jobId)).status, 'interrupted')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('all 47 non-matching methods are discoverable with an engine job mapping and schema', async () => {
  const { readFile } = await import('node:fs/promises')
  const { catalogue, sharedEvidenceMethods } = await import('../catalogue.mjs')
  const snapshot = JSON.parse(await readFile(join(engineRoot, 'R', 'domain-snapshot.json'), 'utf8'))
  const seen = new Set()
  for (const domain of catalogue) for (const method of domain.methods) {
    if (seen.has(method)) { assert.ok(sharedEvidenceMethods.includes(method), method); continue }
    assert.ok(snapshot.methods[method], method)
    assert.ok(Object.values(snapshot.jobMethods).includes(method), method)
    assert.ok(snapshot.scenarioSchemas[method], method)
    seen.add(method)
  }
  assert.deepEqual([...seen].sort(), Object.keys(snapshot.methods).filter(method => method !== 'matching.evaluate').sort())
})

test('workspace symlinks cannot redirect job or report operations', async () => {
  const { mkdir, symlink, writeFile, readFile, chmod } = await import('node:fs/promises')
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-links-'))
  const outside = await mkdtemp(join(tmpdir(), 'vcr-outside-'))
  try {
    const adapter = createLocalAdapter({ workspace, engineRoot })
    await symlink(outside, join(workspace, '.virtual-research'))
    await assert.rejects(adapter.start({ method: 'design.analytic', scenario: {} }), /unsafe_workspace_path/)
    await rm(join(workspace, '.virtual-research'))
    const runner = join(workspace, 'slow-r')
    await writeFile(runner, '#!/bin/sh\nsleep 20\n'); await chmod(runner, 0o755)
    const local = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    const { jobId } = await local.start({ method: 'design.analytic', scenario: {} })
    const dir = join(workspace, '.virtual-research', 'jobs', jobId)
    const target = join(outside, 'victim'); await writeFile(target, 'unchanged')
    await symlink(target, join(dir, 'report.md'))
    await assert.rejects(local.read(jobId), /unsafe_workspace_path/)
    await assert.rejects(local.readRequest(jobId), /unsafe_workspace_path/)
    await assert.rejects(local.saveReport(jobId, 'bad', {}), /unsafe_workspace_path/)
    await assert.rejects(local.cancel(jobId), /unsafe_workspace_path/)
    assert.equal(await readFile(target, 'utf8'), 'unchanged')
    await rm(join(dir, 'report.md'))
    await local.cancel(jobId).catch(() => {})
  } finally { await rm(workspace, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('restart cancellation verifies process identity after supervisor death and does not kill a forged PID', async () => {
  const { writeFile, readFile, chmod } = await import('node:fs/promises')
  const { spawn } = await import('node:child_process')
  const { processIdentity } = await import('../processIdentity.mjs')
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-process-'))
  const unrelated = spawn('sleep', ['20'])
  try {
    const runner = join(workspace, 'slow-r')
    await writeFile(runner, '#!/bin/sh\nsleep 20 &\nwait\n'); await chmod(runner, 0o755)
    const adapter = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    const { jobId } = await adapter.start({ method: 'design.analytic', scenario: {} })
    const stateFile = join(workspace, '.virtual-research', 'jobs', jobId, 'state.json')
    let state
    for (let i = 0; i < 100; i++) { state = await adapter.read(jobId); if (state.engineProcess) break; await new Promise(done => setTimeout(done, 50)) }
    assert.ok(state.engineProcess)
    process.kill(state.workerPid, 'SIGKILL')
    const trusted = JSON.parse(await readFile(stateFile, 'utf8'))
    const forged = { ...trusted, engineProcess: { pid: unrelated.pid, started: trusted.engineProcess.started, command: trusted.engineProcess.command } }
    await writeFile(stateFile, JSON.stringify(forged))
    await assert.rejects(adapter.cancel(jobId), /cancellation_unconfirmed/)
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
    await writeFile(stateFile, JSON.stringify(trusted))
    const restarted = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    await restarted.cancel(jobId)
    assert.equal((await restarted.read(jobId)).status, 'cancelled')
    const dir = await (await import('../workspaceFs.mjs')).jobDirectory(workspace, jobId)
    assert.equal(await processIdentity(trusted.engineProcess.pid, dir, engineRoot), null)
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0))
  } finally { unrelated.kill('SIGKILL'); await rm(workspace, { recursive: true, force: true }) }
})

test('cancel escalates to KILL for a descendant that ignores TERM after its leader exits', async () => {
  const { writeFile, readFile, chmod } = await import('node:fs/promises')
  const { execFileSync } = await import('node:child_process')
  const workspace = await mkdtemp(join(tmpdir(), 'vcr-descendant-'))
  let workerPid
  try {
    const runner = join(workspace, 'stubborn-r')
    await writeFile(runner, `#!/bin/sh\ntrap 'exit 0' TERM\n(trap '' TERM; exec sleep 20) &\necho $! > ${JSON.stringify(join(workspace, 'descendant.pid'))}\nwait\n`)
    await chmod(runner, 0o755)
    const adapter = createLocalAdapter({ workspace, engineRoot, rscript: runner })
    const { jobId } = await adapter.start({ method: 'design.analytic', scenario: {} })
    let state, descendant
    for (let i = 0; i < 100; i++) {
      state = await adapter.read(jobId)
      try { descendant = Number(await readFile(join(workspace, 'descendant.pid'), 'utf8')) } catch {}
      if (state.engineProcess && descendant) break
      await new Promise(done => setTimeout(done, 50))
    }
    assert.ok(descendant && state.engineProcess)
    workerPid = state.workerPid
    await adapter.cancel(jobId)
    assert.equal((await adapter.read(jobId)).status, 'cancelled')
    let processState = ''
    try { processState = execFileSync('ps', ['-p', String(descendant), '-o', 'stat='], { encoding: 'utf8' }).trim() } catch {}
    assert.ok(!processState || processState.startsWith('Z'), `descendant still running: ${processState}`)
  } finally { if (workerPid) { try { process.kill(workerPid, 'SIGKILL') } catch {} } await rm(workspace, { recursive: true, force: true }) }
})
