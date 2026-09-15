/**
 * The platform's provider for the kernel's `web` service.
 *
 * Hidden knowledge: `ctx.web` is a registry, not an egress. The kernel has
 * carried it in our composition since before this file existed — the baseline
 * shows a `web` row configured with DeepSeek's official search and an http
 * fetcher — and the composition disables both, because every retrieval this
 * platform performs goes through a control-plane gateway that resolves the
 * destination, refuses private addresses, and records what was fetched. What
 * was missing was a provider of ours for that registry to point at.
 *
 * Registering one buys two things and it is worth being precise about which:
 *
 *   1. `web.config.searchProvider` can name `evimed-gateway` rather than name
 *      nothing. Today the profile leaves it on the official provider and
 *      disables the row, which protects by absence; naming ours protects by
 *      configuration, and the two failure modes are different (an absence is
 *      one edit from returning).
 *   2. A community plugin written against `ctx.web` — there are none we take
 *      today, which is why this is not urgent — works unmodified and through
 *      the gateway, instead of having to be rewritten or refused.
 *
 * What it deliberately does not do is mount `tool-web`. The MCP already gives
 * the model `web_search` and `official_page_fetch` over the same two gateways;
 * a second pair of tools for one activity is two names for one thing, and the
 * composition's "deliberately absent" list names `web_fetch` as an SSRF surface
 * on purpose.
 *
 * @module @evimed/dsh-socket/plugins/web
 */

import { configSchema, registerWebFetchProvider, registerWebSearchProvider, readFileAt } from '@evimed/harness-port'
import { errorMessage } from '../src/runPolicy.mjs'

const Schema = await configSchema()

export const name = 'evimed-web'

export const inject = ['web']

/** The id both halves register under. One name, so a profile that points at it
 * points at both, and a dump-config diff shows one string. */
export const PROVIDER_ID = 'evimed-gateway'

/**
 * @typedef {object} Config
 * @property {string} searchUrl
 * @property {string} fetchUrl
 * @property {string} tokenFile
 * @property {number} timeoutMs
 */

export const Config = Schema.object({
  searchUrl: Schema.string().default('')
    .description('Control-plane web-search endpoint. Empty means this deployment has no open-web search and the provider is not registered.'),
  fetchUrl: Schema.string().default('')
    .description('Control-plane public-source endpoint. Empty means no fetch provider is registered.'),
  tokenFile: Schema.string().default('')
    .description('Path to the short-lived workload token file. The container never holds a real key.'),
  timeoutMs: Schema.number().default(30000)
    .description('Deadline for one gateway call.'),
})

/** Upstream's error shape for a provider that cannot answer. Named rather than
 * thrown bare so a refusal reads as a refusal and not as a crashed provider. */
class WebError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}

/**
 * @param {any} ctx
 * @param {Config} config
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const search = String(config.searchUrl ?? '').trim()
  const fetchUrl = String(config.fetchUrl ?? '').trim()
  if (!search && !fetchUrl) {
    ctx.get('evimedDiagnostics')?.degrade?.('web providers not registered: no gateway endpoint configured')
    return
  }

  if (search) {
    ctx.effect(() => registerWebSearchProvider(ctx, {
      id: PROVIDER_ID,
      available: () => true,
      /** @param {any} request @param {AbortSignal} [signal] */
      async search(request, signal) {
        const payload = await call(ctx, config, search, {
          query: String(request?.query ?? request?.text ?? '').trim(),
          ...(Number.isInteger(request?.limit) ? { limit: request.limit } : {}),
          ...(request?.language ? { language: String(request.language) } : {}),
        }, signal)
        // Upstream's own result shape, which is not ours: the gateway answers
        // `{results:[{title,url,snippet}]}` and a `WebSearchProvider` returns
        // rows carrying `content`. Translating here is the whole point of a
        // provider — a caller written against the kernel's interface must not
        // have to know which gateway answered.
        return {
          results: (Array.isArray(payload?.results) ? payload.results : []).map((/** @type {any} */ row) => ({
            title: String(row?.title ?? ''),
            url: String(row?.url ?? ''),
            content: String(row?.snippet ?? ''),
          })),
        }
      },
    }))
  }

  if (fetchUrl) {
    ctx.effect(() => registerWebFetchProvider(ctx, {
      id: PROVIDER_ID,
      available: () => true,
      /** @param {any} request @param {AbortSignal} [signal] */
      async fetch(request, signal) {
        const url = String(request?.url ?? '').trim()
        if (!/^https:\/\//i.test(url)) {
          throw new WebError('web_fetch_forbidden', '这个部署只通过平台网关取内容，网关只接受 https 的已批准来源。')
        }
        // The allowlist is the gateway's, not this file's. A second copy here
        // would be a second opinion about which hosts are approved, and the two
        // would disagree the first time one of them was edited: a host the
        // gateway refuses is refused with the gateway's own reason.
        const payload = await call(ctx, config, fetchUrl, { url, accept: ['text/html', 'application/json', 'text/plain'] }, signal)
        return { url, content: typeof payload === 'string' ? payload : JSON.stringify(payload) }
      },
    }))
  }
}

/**
 * @param {any} ctx @param {Config} config @param {string} endpoint
 * @param {Record<string, unknown>} body @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function call(ctx, config, endpoint, body, signal) {
  const token = config.tokenFile ? await readFileAt(ctx, '/', config.tokenFile.replace(/^\/+/, '')) : null
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token.trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw new WebError('web_gateway_unavailable', `平台网关不可用：${errorMessage(error)}`)
  }
  if (!response.ok) {
    // The gateway's own code, carried through. A caller told only "502" cannot
    // tell a refused host from an unreachable one, and those need different
    // next moves.
    let code = 'web_gateway_failed'
    try {
      const failure = await response.json()
      if (typeof failure?.code === 'string') code = failure.code
    } catch { /* a non-JSON failure keeps the generic code */ }
    throw new WebError(code, `平台网关返回 ${response.status}（${code}）。`)
  }
  return response.json()
}
