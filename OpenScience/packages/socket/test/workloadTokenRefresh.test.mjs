// A presenter of the workload token asks again when the token it carried was
// superseded in flight.
//
// The control plane accepts only the token currently in the runtime's token file
// and rewrites it every 150 s. A request that reads the file, sends, and is
// decided after a rewrite is refused 401 `evimed_workload_token_invalid` though
// the token was good when it left. The review poller (every 3 s for up to
// sixteen minutes) ended its whole review on the first such answer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import { runReview } from '../src/review.mjs'
import { refusedWorkloadToken, sendWithFreshWorkloadToken } from '../src/workloadRequest.mjs'

const refusal = () => new Response(JSON.stringify({ error: 'EviMed workload token is invalid.', code: 'evimed_workload_token_invalid' }), { status: 401, headers: { 'content-type': 'application/json' } })
const ok = (value = { status: 'done' }) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

test('only a 401 that names the workload token is the refusal that clears', async () => {
  assert.equal(await refusedWorkloadToken(refusal()), true)
  assert.equal(await refusedWorkloadToken(new Response(JSON.stringify({ error: { code: 'evimed_workload_token_invalid' } }), { status: 401 })), true)
  assert.equal(await refusedWorkloadToken(new Response(JSON.stringify({ code: 'review_disabled' }), { status: 401 })), false)
  assert.equal(await refusedWorkloadToken(new Response(JSON.stringify({ code: 'evimed_workload_token_invalid' }), { status: 403 })), false)
  assert.equal(await refusedWorkloadToken(new Response('not json', { status: 401 })), false)
  assert.equal(await refusedWorkloadToken(ok()), false)
  const kept = refusal()
  await refusedWorkloadToken(kept)
  assert.equal(/** @type {any} */ (await kept.json()).code, 'evimed_workload_token_invalid', 'the caller can still read the answer')
})

test('a token superseded in flight is asked again with the one the file holds now, once', async () => {
  const sent = /** @type {string[]} */ ([])
  const answer = await sendWithFreshWorkloadToken({
    token: 'old',
    readToken: async () => 'new\n',
    send: async (token) => { sent.push(token); return token === 'new' ? ok({ status: 'running' }) : refusal() },
  })
  assert.equal(answer.status, 200)
  assert.deepEqual(sent, ['old', 'new'])
})

test('a refusal of the token the file still holds is a real one, and is returned as it came', async () => {
  const sent = /** @type {string[]} */ ([])
  const answer = await sendWithFreshWorkloadToken({
    token: 'current',
    readToken: async () => 'current',
    send: async (token) => { sent.push(token); return refusal() },
  })
  assert.equal(answer.status, 401)
  assert.deepEqual(sent, ['current'], 'no second request: nothing has changed to make it succeed')
  const unreadable = await sendWithFreshWorkloadToken({ token: 'a', readToken: async () => null, send: async () => refusal() })
  assert.equal(unreadable.status, 401, 'a token file that cannot be read is not a token to try')
})

test('it asks once and not again: a second refusal is the answer', async () => {
  const sent = /** @type {string[]} */ ([])
  const reads = ['b', 'c']
  const answer = await sendWithFreshWorkloadToken({
    token: 'a', readToken: async () => reads.shift(), send: async (token) => { sent.push(token); return refusal() },
  })
  assert.equal(answer.status, 401)
  assert.deepEqual(sent, ['a', 'b'])
})

test('nothing else is asked again: a success and every other refusal are returned at once', async () => {
  for (const response of [ok(), new Response('{}', { status: 500 }), new Response(JSON.stringify({ code: 'usage_budget_exceeded' }), { status: 402 })]) {
    let asked = 0
    const answer = await sendWithFreshWorkloadToken({ token: 'a', readToken: async () => { asked += 1; return 'b' }, send: async () => response })
    assert.equal(answer, response)
    assert.equal(asked, 0)
  }
})

// ——— The review poll, end to end against a server that behaves like the control plane ———

/** A gateway that accepts only the token its file holds now, as the control plane does. */
/** @param {any} t @param {{ token: string }} file */
async function reviewGateway(t, file) {
  const polls = /** @type {{ presented: string, answered: number }[]} */ ([])
  const server = createServer((req, res) => {
    const presented = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    res.setHeader('content-type', 'application/json')
    req.resume()
    if (presented !== file.token) {
      polls.push({ presented, answered: 401 })
      res.writeHead(401).end(JSON.stringify({ error: 'EviMed workload token is invalid.', code: 'evimed_workload_token_invalid' }))
      return
    }
    polls.push({ presented, answered: 200 })
    if (req.method === 'POST') { res.writeHead(202).end(JSON.stringify({ reviewId: 'rev_1', status: 'running' })); return }
    res.writeHead(200).end(JSON.stringify({ status: 'done', reviewId: 'rev_1', findings: [] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return { polls, revisionAuthorizeUrl: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/internal/revisions/v1/authorize` }
}

test('a review survives the token being rewritten between the poll that read it and the answer', async (t) => {
  const file = { token: 'token-1' }
  const gateway = await reviewGateway(t, file)
  // The file the plugin reads: it holds `token-1` for the start and the first read of
  // the poll, and the control plane rewrites it (to `token-2`) before deciding that poll.
  let reads = 0
  const ctx = { get: (/** @type {string} */ name) => (name === 'fs' ? { resolve: async (/** @type {string} */ path) => path, readText: async () => { reads += 1; if (reads === 2) { const stale = file.token; file.token = 'token-2'; return stale } return file.token } } : null) }
  const result = await runReview(ctx, { revisionAuthorizeUrl: gateway.revisionAuthorizeUrl, tokenFile: '/runtime/token' }, {
    runId: 'run_1', sessionId: 's1', deliverableId: 'd1', contractKind: 'clinical-evidence-report', capability: 'clinical-evidence-synthesis', attempt: 1, pollMs: 10, waitMs: 5_000,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(/** @type {any} */ (result).review.status, 'done')
  assert.deepEqual(gateway.polls.map((poll) => poll.answered), [200, 401, 200], 'the superseded poll was asked again, and once')
  assert.equal(gateway.polls[1].presented, 'token-1')
  assert.equal(gateway.polls[2].presented, 'token-2')
})

test('a review whose token is refused while the file still holds it ends as it always did', async (t) => {
  const file = { token: 'token-1' }
  const gateway = await reviewGateway(t, file)
  const ctx = { get: (/** @type {string} */ name) => (name === 'fs' ? { resolve: async (/** @type {string} */ path) => path, readText: async () => 'token-forged' } : null) }
  const result = await runReview(ctx, { revisionAuthorizeUrl: gateway.revisionAuthorizeUrl, tokenFile: '/runtime/token' }, {
    runId: 'run_1', sessionId: 's1', deliverableId: 'd1', contractKind: 'clinical-evidence-report', capability: 'clinical-evidence-synthesis', attempt: 1, pollMs: 10, waitMs: 1_000,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /evimed_workload_token_invalid/)
  assert.equal(gateway.polls.length, 1, 'one request: the file held what was sent, so there was nothing to ask again with')
})
