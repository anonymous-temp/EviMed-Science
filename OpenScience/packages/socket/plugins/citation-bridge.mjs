/** The published citation tools, with transport confined to the source gateway. */
import { buildCiteTools, resolveConfig } from 'dsh-cite'
import { configSchema, readFileAt, registerTool } from '@evimed/harness-port'

const Schema = await configSchema()
export const name = 'evimed-citation-bridge'
export const inject = ['tools']
export const Config = Schema.object({
  gatewayUrl: Schema.string().default(''),
  tokenFile: Schema.string().default(''),
  timeoutMs: Schema.number().default(15000),
})

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** @param {string} target */
function crossrefUrl(target) {
  // Control characters must be rejected before URL parsing can normalize them.
  // eslint-disable-next-line no-control-regex
  if (typeof target !== 'string' || target.length > 8192 || /[\s\u0000-\u001f]/u.test(target)
    || !target.startsWith('https://api.crossref.org/works')) throw new Error('citation_source_url_invalid')
  const url = new URL(target)
  if (url.origin !== 'https://api.crossref.org' || url.username || url.password || url.hash) throw new Error('citation_source_url_invalid')
  if (url.pathname === '/works' || url.pathname === '/works/') {
    const params = url.searchParams
    const keys = [...params.keys()]
    if (new Set(keys).size !== keys.length || keys.some((key) => !['query.bibliographic', 'rows', 'select'].includes(key))
      || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(params.get('rows') ?? '')
      || (params.has('select') && params.get('select') !== 'DOI')) throw new Error('citation_source_url_invalid')
  } else {
    let doi
    try { doi = decodeURIComponent(url.pathname.slice('/works/'.length)) } catch { throw new Error('citation_source_url_invalid') }
    if (!url.pathname.startsWith('/works/') || url.search || !/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(doi)) throw new Error('citation_source_url_invalid')
  }
  return url.href
}

/**
 * Only the deployment names a gateway and a token file. The token is read for
 * every call so rotation and revocation retain the model gateway's semantics.
 * @param {{gatewayUrl: string, tokenFile: string, timeoutMs: number}} config
 * @param {(file: string, signal: AbortSignal) => Promise<string | null>} readToken
 * @param {typeof fetch} [gatewayFetch]
 * @returns {NonNullable<Parameters<typeof buildCiteTools>[1]>}
 */
export function createManagedFetch(config, readToken, gatewayFetch = fetch) {
  return async (target, init = {}) => {
    const url = crossrefUrl(target)
    if (!config.gatewayUrl || !config.tokenFile) throw new Error('citation_gateway_unconfigured')
    let gateway
    try { gateway = new URL(config.gatewayUrl) } catch { throw new Error('citation_gateway_unconfigured') }
    if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password
      || gateway.search || gateway.hash || gateway.pathname !== '/internal/sources/v1/fetch') throw new Error('citation_gateway_unconfigured')
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(resolveConfig(config, {}).timeoutMs)])
    try {
      signal.throwIfAborted()
      const token = (await readToken(config.tokenFile, signal))?.trim()
      if (!token || token.length > 16384 || /\s/u.test(token)) throw new Error('citation_gateway_token_unavailable')
      signal.throwIfAborted()
      const response = await gatewayFetch(gateway.href, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, accept: ['application/json'] }),
      })
      const reader = response.body?.getReader()
      const chunks = []
      let size = 0
      try {
        if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('citation_response_too_large')
        while (reader) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_RESPONSE_BYTES) throw new Error('citation_response_too_large')
          chunks.push(value)
        }
      } finally {
        await reader?.cancel().catch(() => {})
        reader?.releaseLock()
      }
      signal.throwIfAborted()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      // The gateway forwards bounded source bytes and its HTTP status directly.
      return new Response(bytes, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
    } catch (error) {
      init.signal?.throwIfAborted()
      // Never expose gateway addresses, token-file errors or fetch diagnostics.
      const code = error instanceof Error && ['citation_gateway_token_unavailable', 'citation_response_too_large'].includes(error.message)
        ? error.message : signal.aborted ? 'citation_gateway_timeout' : 'citation_gateway_unavailable'
      throw new Error(code)
    }
  }
}

/** @param {any} ctx @param {{gatewayUrl:string, tokenFile:string, timeoutMs:number}} config */
export function apply(ctx, config) {
  const managedFetch = createManagedFetch(config, (file, signal) => readFileAt(ctx, '/', file.replace(/^\/+/, ''), signal))
  for (const tool of buildCiteTools(resolveConfig(config, {}), managedFetch)) ctx.effect(() => registerTool(ctx, tool))
}
