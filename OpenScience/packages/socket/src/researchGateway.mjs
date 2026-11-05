import { VCR_JOB_METHODS, VCR_ENGINE_METHODS } from '@evimed/domain'
import { projectResearchInvocation } from '@evimed/research-plugin-runtime/hosted-protocol'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Request-local adapter; identity is the verified native tool invocation, never
 * a project or study supplied in tool arguments. The token is rotated per call.
 * @param {{gatewayUrl:string,readToken:(signal:AbortSignal)=>Promise<string|null>,fetchImpl?:typeof fetch}} options */
export function createResearchGatewayAdapter({ gatewayUrl, readToken, fetchImpl = fetch }) {
  const url = new URL(gatewayUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/internal/vcr/v1/simulate') throw new Error('research_gateway_unconfigured')
  /** @type {WeakMap<object,any>} */
  const calls = new WeakMap()
  /** @param {Pick<import('../../harness-port/src/types.mjs').ToolCall,'name'|'args'|'sessionId'|'callId'|'signal'>} call */
  function forCall(call) {
    if (calls.has(call)) return calls.get(call)
    const projected = projectResearchInvocation(call.name, call.args, { jobMethods: VCR_JOB_METHODS, methods: VCR_ENGINE_METHODS })
    const send = async () => {
      const signal = AbortSignal.any([call.signal, AbortSignal.timeout(30000)])
      signal.throwIfAborted()
      const token = (await readToken(signal))?.trim()
      if (!token || token.length > 16384 || /\s/u.test(token)) throw new Error('research_gateway_unavailable')
      const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          'x-evimed-execution-context': JSON.stringify({ v: 1, sessionId: call.sessionId, callId: call.callId }) },
        body: JSON.stringify(projected.body) })
      const reader = response.body?.getReader()
      const chunks = []; let length = 0
      try {
        while (reader) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > MAX_RESPONSE_BYTES) throw new Error('research_response_too_large')
          chunks.push(value)
        }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock() }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const value = JSON.parse(new TextDecoder().decode(bytes))
      if (!response.ok) throw new Error(typeof value.code === 'string' && /^[a-z_]{1,100}$/.test(value.code) ? value.code : 'research_gateway_unavailable')
      const data = value.data
      if (projected.body.action === 'status' && data && typeof data === 'object') {
        return { ...data, ...(data.result && typeof data.result === 'object' ? data.result : {}), status: data.state,
          method: data.method, methodVersion: data.methodVersion, request: data.request,
          jobId: data.jobId, resultEntry: data.resultEntry }
      }
      return data
    }
    // The native verifier compares the actual tool's immutable args with this
    // projection, so an adapter cannot select another operation behind it.
    /** @type {Promise<any>|undefined} */
    let response
    const once = async () => { call.signal.throwIfAborted(); return response ??= send() }
    const scoped = { start: once, read: once, cancel: once, describe: once, readRequest: async () => (await once())?.request ?? null }
    calls.set(call, scoped)
    return scoped
  }
  return Object.freeze({ forCall })
}
