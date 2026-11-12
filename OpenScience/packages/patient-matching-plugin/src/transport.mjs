import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { HOST_ABI, HOST_PORT_METHODS, validateHostPorts } from '@evimed/patient-matching-core'

export function validateTransportConfig(config) {
  if (!config || typeof config !== 'object' || Object.keys(config).some(key => !['endpoint', 'tokenFile', 'timeoutMs', 'maxResponseBytes'].includes(key))) throw new TypeError('Invalid deployment transport configuration')
  const endpoint = new URL(config.endpoint)
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search || !['http:', 'https:'].includes(endpoint.protocol)) throw new TypeError('Invalid host endpoint')
  // Plain HTTP stays on the machine or the deployment's own container network: loopback, or a single-label service name (no dot, not
  // an address), which no public name is. The hosted runtime reaches its control plane as `http://open-science-web:8787` like every
  // other gateway (2026-11-10: the first production install refused that endpoint and the bundle never loaded).
  if (endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) && !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(endpoint.hostname)) throw new TypeError('Remote host endpoint requires HTTPS')
  if (typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) throw new TypeError('An absolute deployment token file is required')
  const timeoutMs = config.timeoutMs ?? 30000, maxResponseBytes = config.maxResponseBytes ?? 8 * 1024 * 1024
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 32 * 1024 * 1024) throw new TypeError('Invalid transport limits')
  return { endpoint: endpoint.href, tokenFile: config.tokenFile, timeoutMs, maxResponseBytes }
}
async function readCredential(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size < 16 || stat.size > 4096) throw new Error('Deployment credential file must be owned, regular and mode 0600')
    const token = (await handle.readFile('utf8')).trim()
    if (!/^[A-Za-z0-9._~+/-]{16,4096}={0,2}$/.test(token)) throw new Error('Invalid deployment credential')
    return token
  } finally { await handle.close() }
}
/** The only HTTP operation; the model cannot choose endpoint, scope, token, method or headers. */
export function createHttpHostTransport(config, { fetchImpl = fetch } = {}) {
  const settings = validateTransportConfig(config)
  return async ({ port, operation, input, invocation, signal }) => {
    if (!HOST_PORT_METHODS[port]?.includes(operation)) throw new Error('Unsupported host operation')
    const token = await readCredential(settings.tokenFile)
    const response = await fetchImpl(settings.endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ abi: HOST_ABI, port, operation, input, invocation }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]) : AbortSignal.timeout(settings.timeoutMs) })
    if (!response.ok) throw Object.assign(new Error(`Matching host rejected operation (${response.status})`), { code: response.status === 403 || response.status === 401 ? 'access_denied' : 'host_unavailable' })
    const reader = response.body.getReader(), chunks = []; let size = 0
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) { size += next.value.byteLength; if (size > settings.maxResponseBytes) throw new Error('Matching host response exceeds deployment limit'); chunks.push(Buffer.from(next.value)) }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
}
/** Build the complete core ABI with one immutable authenticated native invocation per tool. */
export function hostFromTransport(transport, invocation, signal) {
  return validateHostPorts({ abi: HOST_ABI, ports: Object.fromEntries(Object.entries(HOST_PORT_METHODS).map(([port, methods]) => [port, Object.fromEntries(methods.map(operation => [operation, envelope => transport({ port, operation, input: port === 'IdentityPort' ? operation === 'resolve' ? {} : envelope : envelope.input, invocation: structuredClone(invocation), signal })]))])) })
}
