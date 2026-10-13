/**
 * The loopback bridge between the official OpenViking memory plugin and the control plane's memory gateway.
 *
 * Hidden knowledge: why a bridge at all. `@openviking/dsh-memory-plugin` resolves its credential once, when it is applied,
 * and keeps it for the life of the process; it reads no token file. Every gateway of ours accepts only the workload token
 * the runtime's token file holds at that moment, and the control plane rewrites the file every few minutes. So the plugin is
 * given no credential and an endpoint on this process's own loopback, and what listens there puts the token the file holds
 * AT THAT MOMENT on each request it forwards (measured with the file rewritten every four seconds: 31 requests, 9 tokens,
 * both of the plugin's channels — its own fetch calls and the stdio MCP proxy it spawns; LAB-MEM, 2026-10-13). The plugin's
 * bytes are not edited and the runtime gains no new kind of credential.
 *
 * The bridge decides nothing. Which routes exist, whose memory a request reaches and what may be written are the gateway's
 * (`apps/server/src/memoryGateway.mjs`), which fixes account and user from the token; identity headers a caller sends never
 * cross. What the bridge owns is the wait: a memory endpoint that refuses costs a new kernel nothing, one that accepts and
 * never answers held its first prompt for about 18 s (same measurement), so every forward has a deadline and a gateway that
 * just failed is not asked again for a few seconds.
 *
 * Deletable when the upstream plugin reads a token file (or accepts a credential provider) itself.
 *
 * @module memoryBridge
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

/** Loopback only, and written as the address: `localhost` may resolve to `::1`, where nothing listens. */
export const MEMORY_BRIDGE_HOST = '127.0.0.1'

/**
 * The bridge's port inside a runtime. A runtime container has its own network namespace, so the number only has to be free
 * there; a host that runs several kernels side by side (the local harness) sets EVIMED_MEMORY_BRIDGE_PORT per kernel.
 */
export const MEMORY_BRIDGE_PORT = 19336

/** The service the bridge row provides once it listens; the plugin's row waits on it (`inject`), so it never dials first. */
export const MEMORY_BRIDGE_SERVICE = 'evimedMemoryBridge'

/** The code a caller of the bridge is answered when the gateway cannot be reached in time. */
export const MEMORY_BRIDGE_UNAVAILABLE = 'memory_bridge_unavailable'

/**
 * The row configuration of `openviking-memory-runtime` (`packages/socket/cordis.patch.yml` carries the same values; a test
 * holds the two equal). Each was measured on the real kernel (LAB-MEM RESULTS 7.3):
 *  - `autoRecall: false` — the profile at the start, the rest through the recall tool (owner ruling 2026-10-10); on, every
 *    turn waited 0.4–3.3 s, the same block was injected twice, and no tool call was saved.
 *  - `captureToolResults: false` — the DSH default is on and would send tool output verbatim.
 *  - `workspacePeer: false` — with a peer the profile lands under the peer; a project is a tag the control plane writes.
 *  - `skillCatalog: false` — one fewer request at session start; the platform serves no OpenViking skill catalogue.
 *  - `skipSubagentSessions: true` — a delegated child's session is not a conversation with the person.
 *  - `commitTokenThreshold` — the upstream default, stated so that a file cannot lower it.
 */
export const OPENVIKING_PLUGIN_SETTINGS = Object.freeze({
  autoRecall: false,
  captureToolResults: false,
  workspacePeer: false,
  skillCatalog: false,
  skipSubagentSessions: true,
  commitTokenThreshold: 20000,
})

/**
 * The same settings as the plugin's own environment variables, which is where they have to be.
 *
 * The plugin resolves every knob through layers, lowest first: the row's `config`, then `~/.openviking/ovcli.conf`, then
 * `<workspace>/.openviking/config.json` — a file "trusted without a prompt" by its own description — and the environment
 * last. A row's `config` is therefore the weakest statement there is, and the workspace is where a person uploads files
 * and a run writes them: a file there saying `{"recall":{"enabled":true}}` would turn per-turn recall back on. The
 * environment outranks every file, so the bridge states the settings there before the plugin is applied.
 * `OPENVIKING_CREDENTIAL_SOURCE=env` keeps the connection (server, key, identity) from being read out of a file at all; the
 * endpoint itself is the row's, which outranks the environment too.
 */
export const OPENVIKING_PLUGIN_ENVIRONMENT = Object.freeze({
  OPENVIKING_AUTO_RECALL: '0',
  OPENVIKING_CAPTURE_TOOL_RESULTS: '0',
  OPENVIKING_WORKSPACE_PEER: '0',
  OPENVIKING_SKILL_CATALOG: '0',
  OPENVIKING_SKIP_SUBAGENT_SESSIONS: '1',
  OPENVIKING_COMMIT_TOKEN_THRESHOLD: String(OPENVIKING_PLUGIN_SETTINGS.commitTokenThreshold),
  OPENVIKING_PEER_SOURCE: 'none',
  OPENVIKING_CREDENTIAL_SOURCE: 'env',
})

/** Connection variables of the plugin that must not be set in a runtime: the row names the endpoint and nothing names a key. */
const OPENVIKING_CONNECTION_ENVIRONMENT = Object.freeze([
  'OPENVIKING_URL', 'OPENVIKING_BASE_URL', 'OPENVIKING_MCP_URL', 'OPENVIKING_API_KEY', 'OPENVIKING_BEARER_TOKEN',
  'OPENVIKING_ACCOUNT', 'OPENVIKING_USER', 'OPENVIKING_PEER_ID', 'OPENVIKING_AUTH_MODE', 'OPENVIKING_EXTRA_HEADERS',
])

/**
 * State the plugin's settings in this process's environment and clear any connection a parent environment carried.
 * @param {Record<string, string | undefined>} [env]
 */
export function pinOpenVikingPluginEnvironment(env = process.env) {
  for (const [name, value] of Object.entries(OPENVIKING_PLUGIN_ENVIRONMENT)) env[name] = value
  for (const name of OPENVIKING_CONNECTION_ENVIRONMENT) delete env[name]
}

/** What crosses towards the gateway: content negotiation and the MCP session headers. Identity never does. */
const FORWARDED_REQUEST_HEADERS = Object.freeze(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'user-agent'])
const FORWARDED_RESPONSE_HEADERS = Object.freeze(['content-type', 'mcp-session-id', 'retry-after'])
const BRIDGE_METHODS = Object.freeze(['GET', 'POST', 'DELETE'])

/**
 * Deadlines of one forward, by what is being asked. The gateway has its own, shorter ones towards OpenViking; these bound
 * the bridge's wait on the gateway itself. A session's start waits on `/health` and then on four reads in series, so those
 * are the short ones; a tool the model called may take as long as the kernel lets a tool call take.
 */
export const MEMORY_BRIDGE_DEADLINES = Object.freeze({ healthMs: 2_000, requestMs: 8_000, toolCallMs: 60_000 })

/** After a forward fails in transport, how long the gateway is answered for without being asked. */
export const MEMORY_BRIDGE_COOLDOWN_MS = 10_000

/** The request body the bridge will hold; the platform's own gateways refuse a larger one. */
export const MEMORY_BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024

/** @param {unknown} error @returns {string} */
function reason(error) {
  const cause = /** @type {any} */ (error)?.cause
  return String(cause?.code ?? /** @type {any} */ (error)?.name ?? 'error').slice(0, 64)
}

/**
 * Whether a request body is an MCP tool call — the one kind of request that may legitimately take long.
 * @param {string} pathname @param {Buffer} body
 */
function isToolCall(pathname, body) {
  if (pathname !== '/mcp' || !body.length) return false
  try {
    const message = JSON.parse(body.toString('utf8'))
    return (Array.isArray(message) ? message : [message]).some((item) => item?.method === 'tools/call')
  } catch {
    return false
  }
}

/**
 * @typedef {object} MemoryBridgeOptions
 * @property {string} gatewayUrl the control plane's memory gateway, without a trailing slash
 * @property {string} [tokenFile] the workload token file the other gateway clients read; empty sends no credential
 * @property {number} [port]
 * @property {typeof fetch} [fetchImpl]
 * @property {(file: string) => Promise<string>} [readToken]
 * @property {() => number} [now]
 * @property {{ healthMs?: number, requestMs?: number, toolCallMs?: number }} [deadlines]
 * @property {number} [cooldownMs]
 * @property {(event: 'unreachable' | 'restored', detail: string) => void} [onState] called on a change, never per request
 */

/**
 * The bridge as a plain HTTP server: no kernel, so the forwarding rules are tested without one.
 * @param {MemoryBridgeOptions} options
 */
export function createMemoryBridge(options) {
  const gateway = String(options.gatewayUrl ?? '').trim().replace(/\/+$/, '')
  const tokenFile = String(options.tokenFile ?? '').trim()
  const port = Number.isInteger(options.port) ? Number(options.port) : MEMORY_BRIDGE_PORT
  const send = options.fetchImpl ?? fetch
  const readToken = options.readToken ?? ((/** @type {string} */ file) => readFile(file, 'utf8'))
  const now = options.now ?? Date.now
  const deadlines = { ...MEMORY_BRIDGE_DEADLINES, ...options.deadlines }
  const cooldownMs = options.cooldownMs ?? MEMORY_BRIDGE_COOLDOWN_MS
  const stats = { requests: 0, forwarded: 0, unavailable: 0, refused: 0, tokenRetries: 0 }
  let closedUntil = 0
  let reachable = true

  /** @param {boolean} ok @param {string} detail */
  const observe = (ok, detail) => {
    if (ok === reachable) return
    reachable = ok
    options.onState?.(ok ? 'restored' : 'unreachable', detail)
  }

  /** @param {http.ServerResponse} res @param {number} status @param {string} code @param {string} message */
  const answer = (res, status, code, message) => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'error', error: { code, message } }))
  }

  /** @param {http.ServerResponse} res @param {string} detail */
  const unavailable = (res, detail) => {
    stats.unavailable += 1
    // The sentence is what the plugin's MCP proxy hands the model as the tool's error, so it says what the model can act on.
    answer(res, 503, MEMORY_BRIDGE_UNAVAILABLE, `The memory service is not available right now (${detail}). Continue without it.`)
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const handle = async (req, res) => {
    stats.requests += 1
    const url = new URL(req.url ?? '/', `http://${MEMORY_BRIDGE_HOST}:${port}`)
    // Only this process's own plugin dials here. A page rendered inside the runtime (the image carries a browser) could
    // otherwise reach the listener by name or by a form post: it would send an Origin, or a Host that is not this address.
    const host = String(req.headers.host ?? '')
    if (req.headers.origin !== undefined || (host !== `${MEMORY_BRIDGE_HOST}:${port}` && host !== `localhost:${port}`)
      || !BRIDGE_METHODS.includes(String(req.method))) {
      stats.refused += 1
      req.resume()
      answer(res, 403, 'memory_bridge_refused', 'This address serves the runtime\'s own memory plugin only.')
      return
    }
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MEMORY_BRIDGE_MAX_BODY_BYTES) {
        stats.refused += 1
        answer(res, 413, 'memory_bridge_body_too_large', 'The request is larger than the memory service accepts.')
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks)
    if (!gateway) { unavailable(res, 'not configured'); return }
    if (now() < closedUntil) { unavailable(res, 'unreachable'); return }

    /** @type {string} */
    let token = ''
    if (tokenFile) {
      try { token = (await readToken(tokenFile)).trim() } catch { token = '' }
      // A runtime whose token file is still empty has not been admitted yet; the gateway would only say 401.
      if (!token) { unavailable(res, 'no credential yet'); return }
    }
    const deadline = url.pathname === '/health' ? deadlines.healthMs : isToolCall(url.pathname, body) ? deadlines.toolCallMs : deadlines.requestMs
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), deadline)
    // The plugin has deadlines of its own; when it gives up, so does the forward.
    let callerLeft = false
    res.once('close', () => {
      if (res.writableFinished) return
      callerLeft = true
      abort.abort()
    })
    /** @param {string} bearer */
    const forward = (bearer) => {
      /** @type {Record<string, string>} */
      const headers = {}
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name]
        if (typeof value === 'string' && value) headers[name] = value
      }
      if (bearer) headers.authorization = `Bearer ${bearer}`
      return send(`${gateway}${url.pathname}${url.search}`, { method: req.method, headers, ...(body.length ? { body } : {}), signal: abort.signal, redirect: 'error' })
    }
    try {
      let response = await forward(token)
      // The control plane accepts only the token its file holds now: a request that straddled a rewrite is asked once more
      // with what the file holds after it (the rule of `packages/socket/src/workloadRequest.mjs`, for the same reason).
      if (response.status === 401 && tokenFile) {
        const fresh = await readToken(tokenFile).then((text) => text.trim(), () => '')
        if (fresh && fresh !== token) {
          await response.body?.cancel().catch(() => {})
          stats.tokenRetries += 1
          response = await forward(fresh)
        }
      }
      /** @type {Record<string, string>} */
      const out = {}
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name)
        if (value) out[name] = value
      }
      res.writeHead(response.status, out)
      if (response.body) for await (const chunk of response.body) res.write(chunk)
      res.end()
      stats.forwarded += 1
      observe(true, `HTTP ${response.status}`)
    } catch (error) {
      // The caller hung up first: nothing was learned about the gateway, and there is nobody to answer.
      if (callerLeft) return
      const timedOut = abort.signal.aborted
      // A tool call that ran out of time says the tool was slow, not that the gateway is gone.
      if (!(timedOut && deadline === deadlines.toolCallMs)) closedUntil = now() + cooldownMs
      observe(false, timedOut ? `no answer in ${deadline} ms` : reason(error))
      unavailable(res, timedOut ? 'timed out' : 'unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => unavailable(res, 'error'))
  })
  return {
    server,
    port,
    stats,
    /** @returns {Promise<void>} */
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, MEMORY_BRIDGE_HOST, () => { server.off('error', reject); resolve() })
    }),
    /** @returns {Promise<void>} */
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

/**
 * The host-scope row: start the bridge and say so to the rows that wait on it.
 *
 * The service is provided whether or not the listener came up. The plugin's row waits on it, and a row left waiting is a
 * composition entry that never activates; memory is an enhancement, so a bridge that could not bind leaves the plugin
 * dialling a closed port — which costs nothing — and a notice where an operator looks.
 *
 * @param {any} ctx
 * @param {{ enabled?: boolean, gatewayUrl?: string, tokenFile?: string, port?: number }} config
 */
export async function registerMemoryBridge(ctx, config) {
  if (config.enabled !== true) return
  const diagnostics = () => ctx.get('evimedDiagnostics')
  pinOpenVikingPluginEnvironment()
  const gatewayUrl = String(config.gatewayUrl ?? '').trim()
  if (!gatewayUrl) diagnostics()?.degrade?.('memory bridge: no memory gateway is configured for this runtime')
  const bridge = createMemoryBridge({
    gatewayUrl,
    tokenFile: config.tokenFile,
    port: config.port,
    onState: (event, detail) => {
      // One line per state, not per failure: the set an operator reads holds each line once.
      if (event === 'unreachable') diagnostics()?.degrade?.('memory bridge: the memory service did not answer; the conversation continued without it')
      ctx.logger?.warn?.(`evimed memory bridge: gateway ${event} (${detail})`)
    },
  })
  let listening = false
  try {
    await bridge.listen()
    listening = true
  } catch (error) {
    diagnostics()?.degrade?.(`memory bridge: could not listen on ${MEMORY_BRIDGE_HOST}:${bridge.port} (${reason(error)})`)
  }
  ctx.effect(() => () => bridge.close())
  ctx.provide(MEMORY_BRIDGE_SERVICE, { port: bridge.port, listening, stats: bridge.stats })
}
