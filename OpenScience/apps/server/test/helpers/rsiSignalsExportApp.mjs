// A serving release for scripts/ops/rsi-signals-export.mjs, as a directory: the release's own signal vocabularies, domain and capability
// list re-exported from this tree, a configuration of the test's, and a database that is either the real one (`databaseUrl`) or a recorder that answers
// the export's two statements with the rows it is given. The export reads its script from stdin and finds the release by RSI_EXPORT_APP_ROOT.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const repoRoot = new URL('../../../../', import.meta.url).pathname
export const exportScript = path.join(repoRoot, 'scripts/ops/rsi-signals-export.mjs')

/**
 * Run the export against a release and hand back what it wrote and sent.
 * @param {{from?: string, to?: string, databaseUrl?: string, rows?: {signals?: any[], leads?: any[]}, args?: string[]}} options
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, document: any, queries: {sql: string, params: any[]}[]}>}
 */
export async function runSignalsExport({ from = '2026-09-01', to = '2026-10-31', databaseUrl, rows = {}, args } = {}) {
  const app = await mkdtemp(path.join(os.tmpdir(), 'rsi-signals-app-'))
  try {
    const put = async (/** @type {string} */ file, /** @type {string} */ text) => { await mkdir(path.dirname(path.join(app, file)), { recursive: true }); await writeFile(path.join(app, file), text) }
    const real = (/** @type {string} */ file) => `export * from ${JSON.stringify(`file://${path.join(repoRoot, file)}`)}\n`
    await put('apps/server/src/config.mjs', `export const loadConfig = () => ({ databaseUrl: process.env.TEST_DATABASE_URL, databaseConnectionTimeoutMs: 2000 })\n`)
    await put('apps/server/src/controlPlaneDatabase.mjs', databaseUrl ? real('apps/server/src/controlPlaneDatabase.mjs') : `import { appendFileSync } from 'node:fs'
export class ControlPlaneDatabase {
  constructor() { this.pool = { connect: async () => ({ release() {}, query: async (sql, params = []) => {
    appendFileSync(process.env.FAKE_QUERY_LOG, JSON.stringify({ sql, params }) + '\\n')
    const rows = JSON.parse(process.env.FAKE_ROWS)
    return { rows: /evolution-lead-occurrence/.test(sql) ? rows.leads ?? [] : /evolution-signal/.test(sql) ? rows.signals ?? [] : [] }
  } }) } }
  async close() {}
}
`)
    for (const file of ['apps/server/src/evolutionSignals.mjs', 'apps/server/src/evolutionUsage.mjs', 'packages/domain/index.mjs']) await put(file, real(file))
    await mkdir(path.join(app, 'packages/domain/src'), { recursive: true })
    await copyFile(path.join(repoRoot, 'packages/domain/src/capability-contracts.json'), path.join(app, 'packages/domain/src/capability-contracts.json'))
    const log = path.join(app, 'queries.jsonl')
    const done = spawnSync(process.execPath, ['--input-type=module', '-', ...(args ?? ['--from', from, '--to', to])], { input: await readFile(exportScript, 'utf8'), encoding: 'utf8', maxBuffer: 1 << 24,
      env: { PATH: process.env.PATH, RSI_EXPORT_APP_ROOT: app, FAKE_QUERY_LOG: log, FAKE_ROWS: JSON.stringify(rows), OPEN_SCIENCE_RELEASE_ID: 'release-test.1', ...(databaseUrl ? { TEST_DATABASE_URL: databaseUrl } : {}) } })
    const queries = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, document: done.status === 0 ? JSON.parse(done.stdout) : null, queries }
  } finally { await rm(app, { recursive: true, force: true }) }
}

export const assertSucceeded = (/** @type {{status: number|null, stderr: string}} */ result) => assert.equal(result.status, 0, result.stderr)
