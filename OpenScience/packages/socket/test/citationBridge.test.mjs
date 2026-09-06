import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadHarnessModule } from '@evimed/harness-port'
import { buildCiteTools, resolveConfig } from 'dsh-cite'
import { apply, createManagedFetch, MAX_RESPONSE_BYTES } from '../plugins/citation-bridge.mjs'

test('the bridge registers the five original tools once in the pinned native tool service', async () => {
  const { Context } = await loadHarnessModule('@deepseek-ai/cordis')
  const { ToolRuntime } = await loadHarnessModule('@deepseek-ai/dsh-tools')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const runtime = new ToolRuntime(ctx)
  await apply(ctx, { gatewayUrl: '', tokenFile: '', timeoutMs: 2000 })
  const names = buildCiteTools(resolveConfig({})).map((tool) => tool.name)
  assert.deepEqual([...runtime.view().visible.keys()].sort(), names.sort())
  assert.equal((await runtime.get('cite_health').execute({}, {})).ok, false, 'unconfigured is not reported ready')
  await ctx.fiber.dispose()
  assert.equal(runtime.view().visible.size, 0, 'disposing the bridge releases every registration')
})

test('the citation package, image install and support inventory agree on the exact upstream pin', async () => {
  const json = async (/** @type {string} */ relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'))
  const version = (await json('../../../deps-version.json')).dsh.citeVersion
  assert.equal(version, '0.3.2')
  assert.equal((await json('../package.json')).dependencies['dsh-cite'], version)
  const dockerfile = await readFile(new URL('../../../deploy/runtime-dsh/Dockerfile', import.meta.url), 'utf8')
  assert.ok(dockerfile.includes(`"dsh-cite@${version}"`))
  const bundle = (await json('../../../runtime/skills/community/plugin-support.json')).communityToolBundles.find((/** @type {any} */ row) => row.name === 'dsh-cite')
  assert.equal(bundle.version, version)
  assert.deepEqual(bundle.tools.sort(), buildCiteTools(resolveConfig({})).map((tool) => tool.name).sort())
  assert.equal(bundle.status, 'installed')
  assert.match(bundle.readiness, /cite_health.*successful DOI lookup/)
})

test('the published citation tools use only the authenticated managed gateway', async (t) => {
  /** @type {any[]} */
  const requests = []
  let token = 'model-token-one'
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    requests.push({ path: req.url, method: req.method, token: req.headers.authorization, payload })
    res.setHeader('content-type', 'application/json')
    const work = { DOI: '10.5555/fixture', title: ['Managed fixture'], author: [{ family: 'Example' }] }
    res.end(JSON.stringify({ message: payload.url.includes('/works/10.') ? work : { items: [work] } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const gatewayUrl = `http://127.0.0.1:${address.port}/internal/sources/v1/fetch`
  const managed = createManagedFetch({ gatewayUrl, tokenFile: '/runtime/dsh-home/model-gateway.token', timeoutMs: 2000 }, async (file) => {
    assert.equal(file, '/runtime/dsh-home/model-gateway.token')
    return token
  })
  const tools = new Map(buildCiteTools(resolveConfig({ timeoutMs: 2000 }), managed).map((tool) => [tool.name, tool]))
  const lookup = await tools.get('cite_lookup')?.execute({ doi: '10.5555/fixture' }, {})
  assert.deepEqual(/** @type {any} */ (lookup).works.map((/** @type {any} */ work) => work.title), ['Managed fixture'])
  token = 'model-token-two'
  const health = await tools.get('cite_health')?.execute({}, {})
  assert.equal(/** @type {any} */ (health).ok, true)
  assert.deepEqual(requests.map((req) => req.token), ['Bearer model-token-one', 'Bearer model-token-two'])
  assert.ok(requests.every((req) => req.path === '/internal/sources/v1/fetch' && req.method === 'POST'))
  assert.deepEqual(requests.map((req) => req.payload), [
    { url: 'https://api.crossref.org/works/10.5555%2Ffixture', accept: ['application/json'] },
    { url: 'https://api.crossref.org/works?rows=1&select=DOI', accept: ['application/json'] },
  ])
})

test('unapproved URL forms never reach the gateway or read its token', async () => {
  const managed = createManagedFetch({ gatewayUrl: 'http://gateway/internal/sources/v1/fetch', tokenFile: '/model-gateway.token', timeoutMs: 2000 }, async () => { throw new Error('must not read') }, async () => { throw new Error('must not fetch') })
  assert.ok(managed)
  for (const url of [
    'http://api.crossref.org/works?rows=1', 'https://attacker.example/works?rows=1',
    'https://api.crossref.org.evil/works?rows=1', 'https://user@api.crossref.org/works?rows=1',
    'https://api.crossref.org/works?rows=1#fragment', 'https://api.crossref.org/works?rows=1&rows=2',
    'https://api.crossref.org/works?rows=1000', 'https://api.crossref.org/works?rows=1&url=http://private',
    'https://api.crossref.org/journals', 'https://api.crossref.org/works/../../members',
    'https://api.crossref.org/works/10.5555%2Ffixture?secret=not-allowed',
    'https://api.crossref.org/works/10.5555%2Ffixture\n',
  ]) await assert.rejects(managed(url), /citation_source_url_invalid/)
})

test('gateway errors are sanitized, response bytes bounded, caller cancellation preserved', async () => {
  const config = { gatewayUrl: 'http://gateway/internal/sources/v1/fetch', tokenFile: '/model-gateway.token', timeoutMs: 2000 }
  const target = 'https://api.crossref.org/works?rows=1&select=DOI'
  const unavailable = createManagedFetch(config, async () => { throw new Error('secret-file-private-value') })
  assert.ok(unavailable)
  await assert.rejects(unavailable(target), /^Error: citation_gateway_unavailable$/)
  const missing = createManagedFetch(config, async () => '')
  assert.ok(missing)
  await assert.rejects(missing(target), /^Error: citation_gateway_token_unavailable$/)
  let cancelled = false
  const oversized = createManagedFetch(config, async () => 'token', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)) },
    cancel() { cancelled = true },
  })))
  assert.ok(oversized)
  await assert.rejects(oversized(target), /^Error: citation_response_too_large$/)
  assert.equal(cancelled, true)
  const abort = new AbortController()
  const cancellation = new Error('caller cancelled')
  const pending = createManagedFetch(config, async () => 'token', async (_target, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  assert.ok(pending)
  const result = pending(target, { signal: abort.signal })
  await new Promise((resolve) => setImmediate(resolve))
  abort.abort(cancellation)
  await assert.rejects(result, (error) => error === cancellation)
})

test('the deadline covers a stalled real HTTP response body', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"message":')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const managed = createManagedFetch({ gatewayUrl: `http://127.0.0.1:${address.port}/internal/sources/v1/fetch`, tokenFile: '/model-gateway.token', timeoutMs: 2000 }, async (_file, signal) => {
    assert.equal(signal.aborted, false)
    return 'token'
  })
  await assert.rejects(managed('https://api.crossref.org/works?rows=1&select=DOI'), /^Error: citation_gateway_timeout$/)
})
