// The loopback bridge between the official OpenViking memory plugin and the control plane's memory gateway.
//
// A fake gateway on the loopback stands for the control plane; the bridge is the real one. What these tests hold is what the
// lab measured (LAB-MEM, 2026-10-13): the token of the moment goes on every forwarded request, only the plugin's own local
// key is answered, identity never crosses, and a gateway that is down or hangs costs a new kernel's first prompt nothing.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_BRIDGE_SERVICE,
  OPENVIKING_PLUGIN_ENVIRONMENT,
  OPENVIKING_PLUGIN_SETTINGS,
  createLocalBridgeKey,
  createMemoryBridge,
  pinOpenVikingPluginEnvironment,
  registerMemoryBridge,
} from '../index.mjs'

/** @returns {Promise<number>} a port nothing listens on */
async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = /** @type {net.AddressInfo} */ (probe.address())
  await new Promise((resolve) => probe.close(() => resolve(undefined)))
  return port
}

/**
 * A fake memory gateway: records what reached it and answers with `reply`.
 * @param {(req: http.IncomingMessage, body: string) => { status?: number, body?: string, headers?: Record<string, string>, hang?: boolean }} reply
 */
async function fakeGateway(reply) {
  /** @type {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }[]} */
  const seen = []
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */ const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: String(req.method), url: String(req.url), headers: req.headers, body })
      const answer = reply(req, body)
      if (answer.hang) return
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers })
      res.end(answer.body ?? '{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const { port } = /** @type {net.AddressInfo} */ (server.address())
  return {
    seen,
    url: `http://127.0.0.1:${port}/internal/memory/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)) }),
  }
}

const KEY = createLocalBridgeKey()

/**
 * @param {Omit<Parameters<typeof createMemoryBridge>[0], 'localKey'>} options
 * @returns {Promise<{ bridge: ReturnType<typeof createMemoryBridge>, call: (path: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ status: number, text: string, headers: Headers }> }>}
 */
async function startBridge(options) {
  const port = options.port ?? await freePort()
  const bridge = createMemoryBridge({ localKey: KEY, ...options, port })
  await bridge.listen()
  return {
    bridge,
    call: async (path, init = {}) => {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${KEY}`, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      return { status: response.status, text: await response.text(), headers: response.headers }
    },
  }
}

test('a forwarded request carries the token the file holds now, never the local key, and no identity the caller sent', async () => {
  const gateway = await fakeGateway(() => ({ body: '{"status":"ok"}' }))
  let token = 'token-one'
  const { bridge, call } = await startBridge({ gatewayUrl: `${gateway.url}/`, tokenFile: '/run/token', readToken: async () => `${token}\n` })
  try {
    const first = await call('/api/v1/fs/ls?uri=viking%3A%2F%2Fuser&limit=5', { headers: { 'x-openviking-user': 'someone-else', 'x-openviking-role': 'root', cookie: 'a=b', accept: 'application/json' } })
    token = 'token-two'
    const second = await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(gateway.seen.length, 2)
    assert.equal(gateway.seen[0].url, '/internal/memory/v1/api/v1/fs/ls?uri=viking%3A%2F%2Fuser&limit=5', 'the plugin\'s own path and query on the gateway\'s base')
    assert.equal(gateway.seen[0].headers.authorization, 'Bearer token-one')
    assert.equal(gateway.seen[1].headers.authorization, 'Bearer token-two', 'the file is read per request: a rotation is followed')
    assert.equal(gateway.seen[1].body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    for (const request of gateway.seen) {
      assert.ok(!JSON.stringify(request.headers).includes(KEY), 'the local key never leaves the process')
      for (const name of ['x-openviking-user', 'x-openviking-role', 'x-openviking-account', 'cookie']) assert.equal(request.headers[name], undefined, name)
    }
    assert.equal(gateway.seen[0].headers.accept, 'application/json')
  } finally {
    await bridge.close()
    await gateway.close()
  }
})

test('only the plugin\'s own local key is answered: another caller, a browser page and a wrong host are refused before anything is forwarded', async () => {
  const gateway = await fakeGateway(() => ({}))
  const { bridge, call } = await startBridge({ gatewayUrl: gateway.url, tokenFile: '/run/token', readToken: async () => 'token' })
  try {
    const noKey = await call('/health', { headers: { authorization: '' } })
    const wrongKey = await call('/health', { headers: { authorization: `Bearer ${createLocalBridgeKey()}` } })
    const page = await call('/health', { headers: { origin: 'https://example.invalid' } })
    // fetch does not let a caller choose its Host; a page that rebinds a name to the loopback does.
    const wrongHost = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/health', headers: { host: 'memory.internal', authorization: `Bearer ${KEY}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end()
    })
    const put = await call('/api/v1/content/write', { method: 'PUT', body: '{}' })
    assert.deepEqual([noKey.status, wrongKey.status, page.status, wrongHost, put.status], [403, 403, 403, 403, 403])
    assert.equal(gateway.seen.length, 0, 'nothing reached the gateway')
    assert.equal(bridge.stats.refused, 5)
  } finally {
    await bridge.close()
    await gateway.close()
  }
})

test('a request that straddles a token rewrite is asked once more with the new token', async () => {
  const gateway = await fakeGateway((req) => (req.headers.authorization === 'Bearer fresh' ? { body: '{"status":"ok"}' } : { status: 401, body: '{"status":"error"}' }))
  let token = 'stale'
  const { bridge, call } = await startBridge({ gatewayUrl: gateway.url, tokenFile: '/run/token', readToken: async () => token })
  /** @type {string[]} */ const reads = []
  const retried = await startBridge({
    gatewayUrl: gateway.url,
    tokenFile: '/run/token',
    readToken: async () => { reads.push(token); if (reads.length === 1) { const old = token; token = 'fresh'; return old } return token },
  })
  try {
    const answered = await retried.call('/api/v1/sessions', { method: 'POST', body: '{"session_id":"s"}' })
    assert.equal(answered.status, 200)
    assert.deepEqual(gateway.seen.map((request) => request.headers.authorization), ['Bearer stale', 'Bearer fresh'])
    assert.equal(retried.bridge.stats.tokenRetries, 1)
    token = 'stale'
    const unchanged = await call('/api/v1/sessions', { method: 'POST', body: '{}' })
    assert.equal(unchanged.status, 401, 'a 401 with the same token is the gateway\'s answer, passed on')
  } finally {
    await retried.bridge.close()
    await bridge.close()
    await gateway.close()
  }
})

test('a gateway that refuses connections is answered at once, and not asked again during the cooldown', async () => {
  const dead = await fakeGateway(() => ({}))
  const deadUrl = dead.url
  await dead.close()
  let clock = 1_000
  /** @type {string[]} */ const states = []
  const { bridge, call } = await startBridge({ gatewayUrl: deadUrl, tokenFile: '/run/token', readToken: async () => 'token', now: () => clock, cooldownMs: 5_000, onState: (event) => states.push(event) })
  try {
    const started = Date.now()
    const first = await call('/health')
    assert.equal(first.status, 503)
    assert.equal(JSON.parse(first.text).error.code, 'memory_bridge_unavailable')
    assert.ok(Date.now() - started < 2_000, 'a refused connection costs nothing')
    const second = await call('/health')
    assert.equal(second.status, 503)
    assert.equal(bridge.stats.unavailable, 2)
    assert.deepEqual(states, ['unreachable'], 'one state change, not one line per failure')
    clock += 6_000
    assert.equal((await call('/health')).status, 503, 'after the cooldown the gateway is asked again (and is still down)')
  } finally {
    await bridge.close()
  }
})

test('a gateway that accepts and never answers is cut off at the deadline of what was asked, not held for the plugin to give up', async () => {
  const gateway = await fakeGateway(() => ({ hang: true }))
  const { bridge, call } = await startBridge({ gatewayUrl: gateway.url, tokenFile: '/run/token', readToken: async () => 'token', deadlines: { healthMs: 150, requestMs: 250, toolCallMs: 5_000 } })
  try {
    const started = Date.now()
    const health = await call('/health')
    assert.equal(health.status, 503)
    assert.ok(Date.now() - started < 2_000, `the health read was cut off after ${Date.now() - started} ms`)
    assert.match(JSON.parse(health.text).error.message, /Continue without it/)
  } finally {
    await bridge.close()
    await gateway.close()
  }
})

test('a runtime whose token file is still empty is not forwarded for; with no token file at all nothing is sent', async () => {
  const gateway = await fakeGateway(() => ({ body: '{}' }))
  const empty = await startBridge({ gatewayUrl: gateway.url, tokenFile: '/run/token', readToken: async () => '  \n' })
  const noFile = await startBridge({ gatewayUrl: gateway.url })
  const unconfigured = await startBridge({ gatewayUrl: '', tokenFile: '/run/token', readToken: async () => 'token' })
  try {
    assert.equal((await empty.call('/health')).status, 503)
    assert.equal(gateway.seen.length, 0)
    assert.equal((await unconfigured.call('/health')).status, 503)
    assert.equal(gateway.seen.length, 0)
    assert.equal((await noFile.call('/health')).status, 200)
    assert.equal(gateway.seen[0].headers.authorization, undefined)
  } finally {
    await empty.bridge.close()
    await noFile.bridge.close()
    await unconfigured.bridge.close()
    await gateway.close()
  }
})

test('the plugin\'s settings are stated in its own environment, which outranks every file, and no connection survives from a parent', () => {
  /** @type {Record<string, string | undefined>} */
  const env = { OPENVIKING_URL: 'http://elsewhere', OPENVIKING_BEARER_TOKEN: 'x', OPENVIKING_AUTO_RECALL: '1', OPENVIKING_USER: 'u', OPENVIKING_EXTRA_HEADERS: '{}' }
  pinOpenVikingPluginEnvironment(KEY, env)
  assert.equal(env.OPENVIKING_AUTO_RECALL, '0')
  assert.equal(env.OPENVIKING_CAPTURE_TOOL_RESULTS, '0')
  assert.equal(env.OPENVIKING_WORKSPACE_PEER, '0')
  assert.equal(env.OPENVIKING_SKILL_CATALOG, '0')
  assert.equal(env.OPENVIKING_SKIP_SUBAGENT_SESSIONS, '1')
  assert.equal(env.OPENVIKING_CREDENTIAL_SOURCE, 'env')
  assert.equal(env.OPENVIKING_API_KEY, KEY)
  for (const name of ['OPENVIKING_URL', 'OPENVIKING_BEARER_TOKEN', 'OPENVIKING_USER', 'OPENVIKING_EXTRA_HEADERS']) assert.equal(env[name], undefined, name)
  assert.equal(OPENVIKING_PLUGIN_ENVIRONMENT.OPENVIKING_COMMIT_TOKEN_THRESHOLD, String(OPENVIKING_PLUGIN_SETTINGS.commitTokenThreshold))
})

test('the row configuration in the bundle patch is the one the bridge states in the environment', async () => {
  const patch = await readFile(fileURLToPath(new URL('../../socket/cordis.patch.yml', import.meta.url)), 'utf8')
  const row = /- id: openviking-memory-runtime\n([\s\S]*?)(?=\n- |\n# |$)/.exec(patch)?.[1] ?? ''
  assert.ok(row, 'the socket patch carries the plugin\'s row')
  for (const [key, value] of Object.entries(OPENVIKING_PLUGIN_SETTINGS)) {
    assert.match(row, new RegExp(`^    ${key}: ${value}\\s*$`, 'm'), `${key} in the row`)
  }
  assert.match(row, /disabled: !!js \(process\.env\.EVIMED_MEMORY_GATEWAY_URL \|\| ''\) === ''/, 'off unless the launch plan gave this runtime a gateway')
  assert.ok(!/apiKey|api_key|bearer/i.test(row), 'no key in the row')
})

test('the bridge row listens and provides its service only when this session is on the native engine', async () => {
  /** @type {any[]} */ const provided = []
  /** @type {(() => unknown)[]} */ const disposers = []
  const context = (/** @type {any} */ extra = {}) => ({
    get: () => undefined,
    effect: (/** @type {() => () => void} */ install) => { disposers.push(install()) },
    provide: (/** @type {string} */ name, /** @type {any} */ value) => { provided.push([name, value]) },
    ...extra,
  })
  const env = { ...process.env }
  try {
    await registerMemoryBridge(context(), { enabled: false, gatewayUrl: '', tokenFile: '', port: await freePort() })
    assert.deepEqual(provided, [], 'a legacy account\'s runtime gets no bridge')
    assert.equal(process.env.OPENVIKING_API_KEY, env.OPENVIKING_API_KEY, 'and no plugin environment')

    const port = await freePort()
    const gateway = await fakeGateway(() => ({ body: '{"status":"ok"}' }))
    await registerMemoryBridge(context(), { enabled: true, gatewayUrl: gateway.url, tokenFile: '', port })
    assert.equal(provided.length, 1)
    assert.equal(provided[0][0], MEMORY_BRIDGE_SERVICE)
    const service = /** @type {{ port: number, listening: boolean }} */ (provided[0][1])
    assert.deepEqual({ port: service.port, listening: service.listening }, { port, listening: true })
    const answered = await globalThis.fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${process.env.OPENVIKING_API_KEY}` } })
    assert.equal(answered.status, 200, 'the key the plugin was given is the one the bridge answers')
    await gateway.close()
  } finally {
    for (const dispose of disposers) await dispose()
    for (const name of Object.keys(OPENVIKING_PLUGIN_ENVIRONMENT)) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name] }
    if (env.OPENVIKING_API_KEY === undefined) delete process.env.OPENVIKING_API_KEY
  }
})

test('a bridge that cannot bind still provides its service, so the plugin\'s row is never left waiting, and says so', async () => {
  const taken = net.createServer()
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = /** @type {net.AddressInfo} */ (taken.address()).port
  /** @type {any[]} */ const provided = []
  /** @type {string[]} */ const notices = []
  /** @type {(() => unknown)[]} */ const disposers = []
  const env = { ...process.env }
  try {
    await registerMemoryBridge({
      get: () => ({ degrade: (/** @type {string} */ line) => notices.push(line) }),
      effect: (/** @type {() => () => void} */ install) => { disposers.push(install()) },
      provide: (/** @type {string} */ name, /** @type {any} */ value) => { provided.push([name, value]) },
    }, { enabled: true, gatewayUrl: 'http://127.0.0.1:9/internal/memory/v1', tokenFile: '', port })
    assert.equal(/** @type {{ listening: boolean }} */ (provided[0][1]).listening, false)
    assert.ok(notices.some((line) => /could not listen/.test(line)), notices.join('|'))
  } finally {
    for (const dispose of disposers) await dispose()
    await new Promise((resolve) => taken.close(() => resolve(undefined)))
    for (const name of [...Object.keys(OPENVIKING_PLUGIN_ENVIRONMENT), 'OPENVIKING_API_KEY']) { if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name] }
  }
})
