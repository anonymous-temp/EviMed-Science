import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHttpHostTransport, hostFromTransport, validateTransportConfig } from '../src/transport.mjs'
import { bindHostInvocation } from '@evimed/patient-matching-core'
import { fixture } from './fixture.mjs'
const invocation = { tool: 'match_context', callId: 'native-call', sessionId: 'conversation-a', agentId: 'agent-a', args: { sourceId: 'source-a' } }
test('HTTP transport binds original native invocation and sends raw typed operation input', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'matching-transport-')), file = join(temporary, 'token'), requests = []
  try {
    await writeFile(file, 'synthetic-token-123456', { mode: 0o600 })
    const transport = createHttpHostTransport({ endpoint: 'http://127.0.0.1/internal/patient-matching/v1/port', tokenFile: file }, { fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body); requests.push({ url, request, headers: options.headers, redirect: options.redirect })
      const { scope } = fixture()
      return Response.json(request.port === 'IdentityPort' ? request.operation === 'resolve' ? scope : { allowed: true, scope } : { status: 'complete', summary: 'Host persisted response', data: { resultId: 'r1' }, artifacts: [] })
    } })
    const client = await bindHostInvocation(hostFromTransport(transport, invocation), invocation)
    await client.call('PatientDataPort', 'context', { sourceId: 'source-a' })
    assert.equal(requests.length, 3)
    for (const row of requests) { assert.deepEqual(row.request.invocation, invocation); assert.equal(row.redirect, 'error'); assert.equal(row.headers.Authorization, 'Bearer synthetic-token-123456') }
    assert.deepEqual(requests[2].request.input, { sourceId: 'source-a' })
    await writeFile(file, 'rotated-synthetic-token'); await client.call('PatientDataPort', 'context', {})
    assert.equal(requests.at(-1).headers.Authorization, 'Bearer rotated-synthetic-token')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
test('credentials fail closed on insecure mode or symlink and never reach network', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'matching-credential-')), file = join(temporary, 'token'), link = join(temporary, 'link')
  try {
    await writeFile(file, 'synthetic-token-123456', { mode: 0o600 }); await symlink(file, link)
    let fetched = false
    const options = { fetchImpl: async () => { fetched = true; return Response.json({}) } }
    const request = { port: 'IdentityPort', operation: 'resolve', input: {}, invocation }
    await chmod(file, 0o644)
    await assert.rejects(createHttpHostTransport({ endpoint: 'http://127.0.0.1/port', tokenFile: file }, options)(request), /0600/)
    await chmod(file, 0o600)
    await assert.rejects(createHttpHostTransport({ endpoint: 'http://127.0.0.1/port', tokenFile: link }, options)(request))
    assert.equal(fetched, false)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
test('deployment configuration rejects insecure remote endpoints, model injection and unbounded transport', () => {
  const config = { endpoint: 'https://matching.example/internal/port', tokenFile: '/deployment/host.token' }
  validateTransportConfig(config)
  for (const extra of [{ endpoint: 'http://matching.example/port' }, { endpoint: 'https://credential@example/port' }, { endpoint: 'https://example/port?token=bad' }, { tokenFile: 'relative' }, { model: 'injected' }, { timeoutMs: 9999999 }, { maxResponseBytes: 9999999999 }]) assert.throws(() => validateTransportConfig({ ...config, ...extra }))
})
test('host HTTP failure and oversized response do not expose credential or partial JSON', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'matching-limits-')), file = join(temporary, 'token')
  try {
    await writeFile(file, 'synthetic-token-123456', { mode: 0o600 })
    const config = { endpoint: 'https://matching.example/port', tokenFile: file, maxResponseBytes: 1024 }
    const request = { port: 'IdentityPort', operation: 'resolve', input: {}, invocation }
    await assert.rejects(createHttpHostTransport(config, { fetchImpl: async () => new Response('secret echo', { status: 403 }) })(request), error => error.code === 'access_denied' && !error.message.includes('secret'))
    await assert.rejects(createHttpHostTransport(config, { fetchImpl: async () => new Response('x'.repeat(1025)) })(request), /exceeds deployment limit/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
