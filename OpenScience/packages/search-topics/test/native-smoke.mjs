/** Run only inside a disposable runtime image; no serving profile is touched. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { once } from 'node:events'
import { recommendationFixture } from './recommendationFixture.mjs'

if (!process.argv[2]) throw new Error('Pass an absolute tarball path in a disposable DSH container')
const artifact = resolve(process.argv[2])
const temporary = await mkdtemp(join(tmpdir(), 'evimed-topics-native-'))
const topicsFile = join(temporary, 'topics.json'), tokenFile = join(temporary, 'token')
const env = { ...process.env,
  HOME: join(temporary, 'home'), DSH_HOME: join(temporary, 'dsh'),
  EVIMED_SEARCH_TOPICS_ENABLED: '1',
  EVIMED_SEARCH_TOPICS_FILE: topicsFile, EVIMED_SEARCH_TOPICS_TOKEN_FILE: tokenFile,
}
await mkdir(env.HOME, { recursive: true })
await writeFile(topicsFile, await readFile(new URL('../examples/topics.example.json', import.meta.url)))
let token = randomBytes(32).toString('hex')
await writeFile(tokenFile, token, { mode: 0o600 })
/** @type {import('node:child_process').ChildProcess | undefined} */
let child
let logs = ''
function command(/** @type {string[]} */ args) {
  const result = spawnSync('dsh', args, { env, encoding: 'utf8', timeout: 60000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}
const origin = 'http://127.0.0.1:39871'
async function request(/** @type {string} */ category = 'literature', /** @type {string} */ credential = token) {
  return fetch(`${origin}/api/evimed-search/topics?category=${category}`, {
    headers: { Authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(1000),
  })
}
try {
  command(['--profile', 'topics-proof', '--from-default-profile', 'web', '--dump-config'])
  command(['plugin', '--profile', 'topics-proof', 'add', artifact, '--offline', '--ignore-scripts'])
  const profile = JSON.parse(await readFile(join(env.DSH_HOME, 'profiles/topics-proof/package.json'), 'utf8'))
  assert.ok(profile.dsh.profile.bundles.includes('@evimed/dsh-search-topics'))
  const config = command(['--profile', 'topics-proof', '--dump-config'])
  assert.ok(config.includes('evimed-search-topics'))
  child = spawn('dsh', ['--profile', 'topics-proof', '--no-open', '--host', '127.0.0.1', '--port', '39871'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-16000) })
  child.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-16000) })
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    try { ready = (await request()).status === 200 } catch { /* Wait for the native carrier. */ }
    if (ready) break
    if (child.exitCode !== null) break
    await setTimeout(100)
  }
  assert.ok(ready, `Native route failed to become ready: ${logs}`)
  const categories = ['literature', 'guidelines', 'drugs', 'trials']
  for (const category of categories) {
    const res = await request(category)
    assert.equal(res.status, 200)
    const body = JSON.parse(await res.text())
    assert.equal(body.category, category)
    assert.equal(body.count, 3)
    assert.equal(body.source.isExample, true)
  }
  assert.equal((await request('literature', '')).status, 401)
  assert.equal((await request('unknown')).status, 400)
  const feed = JSON.parse(await readFile(topicsFile, 'utf8'))
  feed.categories.literature = [{ id: 'updated', query: '更新主题', description: '热更新验证' }]
  await writeFile(`${topicsFile}.next`, JSON.stringify(feed))
  await rename(`${topicsFile}.next`, topicsFile)
  assert.equal(JSON.parse(await (await request()).text()).topics[0].query, '更新主题')
  const recommended = recommendationFixture()
  await writeFile(`${topicsFile}.next`, JSON.stringify(recommended))
  await rename(`${topicsFile}.next`, topicsFile)
  const backed = JSON.parse(await (await request()).text())
  assert.deepEqual(backed.recommendation, recommended.recommendation)
  assert.deepEqual(backed.topics[0].basis, recommended.categories.literature[0].basis)
  assert.equal((await request('trials')).status, 200)
  assert.deepEqual(JSON.parse(await (await request('trials')).text()).topics, [])
  const previousToken = token
  token = randomBytes(32).toString('hex')
  await writeFile(tokenFile, token)
  assert.equal((await request('literature', previousToken)).status, 401)
  assert.equal((await request()).status, 200)
  await writeFile(topicsFile, '{invalid')
  assert.equal((await request()).status, 503)
  process.stdout.write(`${JSON.stringify({
    kernel: command(['--version']).trim(),
    package: '@evimed/dsh-search-topics',
    installation: 'offline tarball through dsh plugin add',
    nativeRoute: 'passed', categories, authentication: 'passed',
    sourceBackedProvenance: 'passed', emptySourceCategory: 'passed',
    invalidCategory: 'passed', snapshotReplacement: 'passed', tokenRotation: 'passed',
    invalidSource: 'passed', modelCalls: 0,
  }, null, 2)}\n`)
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(3000).then(() => { if (child?.exitCode === null) child.kill('SIGKILL') })
    await Promise.race([stopped, force])
  }
  await rm(temporary, { recursive: true, force: true })
}
