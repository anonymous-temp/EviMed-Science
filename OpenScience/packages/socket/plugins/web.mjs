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
 * the model `web_search` and `web_read` over the same two gateways; a second
 * pair of tools for one activity is two names for one thing, and the
 * composition's "deliberately absent" list names `web_fetch` as an SSRF surface
 * on purpose.
 *
 * So the registry has no consumer, and that is the decision, not a gap
 * (2026-09-28, after the integration audit listed "no consumer" as one): the
 * one thing that would consume it here is `tool-web`, which the preset leaves
 * out and the composition records `disabled`; a consumer added only to exercise
 * the provider would be the second tool pair ruled out above. What the audit
 * holds instead is the invariant — both providers name `evimed-gateway` and
 * `tool-web` stays disabled in the image's recorded composition — so the day a
 * consumer does appear (a community plugin written against `ctx.web`), it
 * reaches the gateway and nothing else.
 *
 * The fetch half asks the gateway's web-read mode (2026-09-20), the same one
 * `web_read` uses: any public page, robots.txt honoured, paced per site,
 * rendered in a browser when drawn in script (the deployment's own or
 * AgentBay's, whichever the control plane is configured with), PDFs through
 * the parser. It used to ask the API mode for raw HTML, which only ever
 * reached the allowlisted APIs and stopped working the day that mode stopped
 * serving HTML — a registry entry whose every call fails, with nobody calling
 * it yet to notice.
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
        const maxResults = Number.isInteger(request?.maxResults) && request.maxResults > 0 ? request.maxResults : null
        const payload = await call(ctx, config, search, {
          query: String(request?.query ?? '').trim(),
          ...(maxResults ? { limit: maxResults } : {}),
        }, signal)
        return searchResult(payload)
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
        if (!/^https?:\/\//i.test(url)) {
          throw new WebError('web_fetch_forbidden', '这个部署只通过平台网关读取公开的 http(s) 网页。')
        }
        // What may be read is the gateway's rule, not this file's: a second
        // copy here would be a second opinion, and a page the gateway refuses
        // is refused with the gateway's own reason.
        return fetchResult(await call(ctx, config, fetchUrl, { webRead: { url } }, signal), url)
      },
    }))
  }
}

/**
 * The gateway's search answer in the kernel's `WebSearchResult` (`@deepseek-ai/dsh-web`, unchanged in 0.2.1).
 *
 * The web-search gateway answers `{ data: { results: [{ title, url, snippet, engine, publishedDate, … }] }, warnings }`.
 * This read `payload.results` and answered `{ results: [{ title, url, content }] }`: the first is a field the gateway
 * never sends, so every search came back empty, and the second is not the shape the kernel reads (`sources`, which its
 * own cap step slices), so a consumer written against `ctx.web` would have thrown on it. Nothing consumes the registry
 * today (`tool-web` is unmounted), which is the only reason neither was seen. A source carries what the gateway gave
 * and nothing invented: `publishedAt` is the engine's date where one gave it.
 * @param {any} payload
 * @returns {{ sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }}
 */
export function searchResult(payload) {
  const rows = Array.isArray(payload?.data?.results) ? payload.data.results : []
  /** @type {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>} */
  const sources = []
  for (const row of rows) {
    const url = typeof row?.url === 'string' ? row.url.trim() : ''
    if (!url) continue
    const title = typeof row?.title === 'string' ? row.title.trim() : ''
    const snippet = typeof row?.snippet === 'string' ? row.snippet.trim() : ''
    const date = typeof row?.publishedDate === 'string' ? row.publishedDate : typeof row?.date === 'string' ? row.date : ''
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(date ? { publishedAt: date } : {}) })
  }
  // `truncated` is the seam's to set when it cuts to `maxResults`; the gateway already answered within the limit.
  return { sources, truncated: false }
}

/**
 * The gateway's web read in the kernel's `WebFetchResult`.
 *
 * The web-read mode answers the read itself, unwrapped: `{ receipt: { finalUrl, status, contentType, truncated, … },
 * text, links }` — the page as text (HTML is extracted, a PDF parsed), so the body is always the `text` kind, never
 * HTML the caller would have to strip. The status is the page's own, as the contract asks: a page that answered 404 is
 * a result, a page the gateway refused is an error under the gateway's code.
 * @param {any} payload @param {string} requested
 * @returns {{ url: string, statusCode: number, body: { kind: 'text', content: string }, truncated: boolean }}
 */
export function fetchResult(payload, requested) {
  const receipt = payload?.receipt ?? {}
  return {
    url: typeof receipt.finalUrl === 'string' && receipt.finalUrl ? receipt.finalUrl : requested,
    statusCode: Number.isInteger(receipt.status) ? receipt.status : 200,
    body: { kind: 'text', content: typeof payload?.text === 'string' ? payload.text : '' },
    truncated: receipt.truncated === true,
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
      // The gateways answer `{ error: { code, message } }`.
      const failure = /** @type {any} */ (await response.json())
      const named = failure?.error?.code ?? failure?.code
      if (typeof named === 'string') code = named
    } catch { /* a non-JSON failure keeps the generic code */ }
    throw new WebError(code, `平台网关返回 ${response.status}（${code}）。`)
  }
  return response.json()
}
