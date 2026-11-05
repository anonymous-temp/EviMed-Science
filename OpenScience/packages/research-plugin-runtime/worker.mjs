import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { jobDirectory, assertNoSymlinks, readOwnedFile, writeOwnedFile, scientificEnvironment } from './workspaceFs.mjs'
import { processIdentity } from './processIdentity.mjs'

const [workspace, jobId, requestedEngineRoot, rscript] = process.argv.slice(2)
const engineRoot = resolve(requestedEngineRoot)
const output = await jobDirectory(workspace, jobId)
await assertNoSymlinks(output)
await readOwnedFile(output, 'job.json')
let stateQueue = Promise.resolve()
/** @type {import('./processIdentity.mjs').ProcessIdentity | null} */
let identity = null
/** @param {Record<string, any>} value */
const state = (value) => {
  stateQueue = stateQueue.then(async () => {
    const directory = await jobDirectory(workspace, jobId)
    await assertNoSymlinks(directory)
    await writeOwnedFile(directory, 'state.json', JSON.stringify({ ...value, workerPid: process.pid, engineProcess: identity }))
  })
  return stateQueue
}
const child = spawn(rscript, [join(engineRoot, 'service', 'run_job.R'), join(output, 'job.json'), output], {
  env: { ...scientificEnvironment(process.env), VCR_ENGINE_ROOT: engineRoot, VCR_ENGINE_DATA_ROOT: resolve(workspace) }, stdio: 'ignore', detached: true,
})
let cancelled = false
let done = false
async function tick() {
  if (done) return
  const directory = await jobDirectory(workspace, jobId)
  await assertNoSymlinks(directory)
  if (!identity && child.pid !== undefined) identity = await processIdentity(child.pid, output, engineRoot)
  if (!done) await state({ status: 'running', heartbeat: Date.now() })
}
const timer = setInterval(() => { void tick() }, 500)
child.once('error', (error) => { done = true; clearInterval(timer); void state({ status: 'failed', message: error.message }) })
child.once('exit', (code, signal) => {
  done = true; clearInterval(timer)
  void (async () => {
    try { await readOwnedFile(await jobDirectory(workspace, jobId), 'CANCEL'); cancelled = true } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error }
    await state({ status: cancelled ? 'cancelling' : code === 0 ? 'completed' : 'failed', code, signal })
  })()
})
void tick()
