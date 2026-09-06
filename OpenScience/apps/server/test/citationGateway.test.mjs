import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createPublicSourceGatewayHandler } from '../src/publicSourceGateway.mjs'
import { createManagedFetch } from '../../../packages/socket/plugins/citation-bridge.mjs'
const socketRequire = createRequire(new URL('../../../packages/socket/package.json', import.meta.url))
const { buildCiteTools, resolveConfig } = await import(socketRequire.resolve('dsh-cite'))

test('the actual source gateway contract preserves lookup, search, formatting, checks and failures', async (t) => {
  let token = 'active-model-token'
  let upstreamStatus = 200
  let upstreamCalls = 0
  const handler = createPublicSourceGatewayHandler({}, {
    assertActiveModelGatewayToken(value) { if (value !== 'active-model-token') throw new Error('revoked') },
  }, { fetchImpl: async (target, init) => {
    upstreamCalls++
    assert.equal(new URL(target).hostname, 'api.crossref.org')
    assert.equal(init.redirect, 'error')
    const work = { DOI: '10.5555/fixture', title: ['Managed fixture'], author: [{ family: 'Example' }], issued: { 'date-parts': [[2024]] } }
    return Response.json({ message: new URL(target).pathname.includes('/10.') ? work : { items: [work] } }, { status: upstreamStatus })
  } })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const managed = createManagedFetch({ gatewayUrl: `http://127.0.0.1:${address.port}/internal/sources/v1/fetch`, tokenFile: '/model-gateway.token', timeoutMs: 2000 }, async () => token)
  const tools = new Map(buildCiteTools(resolveConfig({ timeoutMs: 2000 }), managed).map((tool) => [tool.name, tool]))
  /** @param {string} name @param {any} args @returns {Promise<any>} */
  const run = async (name, args) => tools.get(name)?.execute(args, {})
  assert.equal((await run('cite_lookup', { query: 'Managed fixture', limit: 2 })).works[0].title, 'Managed fixture')
  assert.match((await run('cite_format', { doi: '10.5555/fixture' })).citation, /Managed fixture/)
  assert.match((await run('cite_bibtex', { doi: '10.5555/fixture' })).bibtex, /10.5555\/fixture/)
  assert.equal((await run('cite_check', { text: '10.5555/fixture' })).results[0].ok, true)
  assert.equal((await run('cite_health', {})).ok, true)
  const beforeRevocation = upstreamCalls
  token = 'revoked-model-token'
  await assert.rejects(run('cite_lookup', { doi: '10.5555/fixture' }), /401/)
  assert.equal((await run('cite_health', {})).ok, false)
  assert.equal(upstreamCalls, beforeRevocation, 'revocation must stop at the gateway')
  token = 'active-model-token'
  upstreamStatus = 404
  await assert.rejects(run('cite_lookup', { doi: '10.5555/fixture' }), /Crossref/)
  upstreamStatus = 503
  await assert.rejects(run('cite_lookup', { doi: '10.5555/fixture' }), /502/)
  assert.equal((await run('cite_health', {})).ok, false)
})
