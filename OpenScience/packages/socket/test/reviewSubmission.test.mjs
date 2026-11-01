// What a submission asks of the review, and what a passed submission says.
//
// Measured on twelve BixBench capsules (2026-10-28): `evimed_submit_deliverable`
// blocked for 61.6 of 245.8 minutes, 31.0 of them in nine resubmissions, and a
// run that held a clean, accepted submission fixed a typo and submitted again
// "to keep the receipt consistent" because the call never said it need not.
// The editor reads a package once; a resubmission gets the code's checks, the
// finished review of the same bytes, or - after a read that owed findings -
// one more read to check the repair.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import {
  REVIEW_EXPLICIT_WAIT_MS,
  REVIEW_REPEAT_WAIT_MS,
  REVIEW_WAIT_MS,
  nextStanding,
  owedFindings,
  reviewForSubmission,
  reviewIssues,
  reviewStanding,
  reviewSummary,
  runReview,
  settledNote,
} from '../src/review.mjs'

const ctx = { get: (/** @type {string} */ name) => (name === 'fs' ? { resolve: async (/** @type {string} */ path) => path, readText: async () => 'token' } : null) }

/** @param {Record<string, any>[]} findings */
const done = (findings, reviewId = 'rv_x') => ({ reviewId, status: 'done', tier: 'L2', model: 'm', editor: 'done', findings, checklist: { present: 0, absent: [], unlocated: [] }, acceptance: { met: [], unmet: [], unlocated: [] }, deterministic: { references: null, previous: { open: [], resolved: [] } } })
const finding = (/** @type {string} */ id, /** @type {string} */ kind, extra = {}) => ({ id, kind, label: kind, severity: 'advisory', origin: 'editor', location: 'x', evidence: 'e', fix: 'f', message: `m ${id}`, answerRequired: ['contradiction', 'overclaim', 'safety'].includes(kind), ...extra })

/**
 * A control plane that holds reviews: `POST /deliverables` starts one (answering as scripted),
 * `GET /deliverables/<id>` reads it. Records what it was asked.
 * @param {any} t @param {{ started?: (body: any, n: number) => any, states?: Record<string, any[]> }} script
 */
async function gateway(t, script = {}) {
  const posts = /** @type {any[]} */ ([])
  const gets = /** @type {string[]} */ ([])
  /** @type {Record<string, number>} */
  const reads = {}
  const server = createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([])
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        posts.push(body)
        const answered = script.started?.(body, posts.length) ?? { reviewId: `rv_${posts.length}`, status: 'running' }
        res.writeHead(answered.status === 'skipped' ? 200 : 202).end(JSON.stringify(answered))
        return
      }
      const id = String(req.url).split('/').pop() ?? ''
      gets.push(id)
      const sequence = script.states?.[id] ?? [done([], id)]
      const at = Math.min(reads[id] ?? 0, sequence.length - 1)
      reads[id] = (reads[id] ?? 0) + 1
      res.writeHead(200).end(JSON.stringify(sequence[at]))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const config = { revisionAuthorizeUrl: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/internal/revisions/v1/authorize`, tokenFile: '/runtime/token' }
  return { posts, gets, config }
}

const request = { runId: 'run_1', sessionId: 's1', deliverableId: 'd1', contractKind: 'statistical-analysis-package', capability: 'statistical-analysis', attempt: 1, pollMs: 10 }

test('a first submission gets the full read, and waits for it as long as the editor may take', async (t) => {
  const g = await gateway(t, { states: { rv_1: [{ reviewId: 'rv_1', status: 'running' }, done([finding('F01', 'wording')], 'rv_1')] } })
  const outcome = await reviewForSubmission(ctx, g.config, { ...request, digest: 'aaa' }, undefined)
  assert.equal(outcome.ok, true)
  assert.equal('review' in outcome && outcome.review.reviewId, 'rv_1')
  assert.equal(g.posts.length, 1)
  assert.equal('editor' in g.posts[0], false, 'the editor is not switched off for the first read')
  assert.ok(REVIEW_WAIT_MS >= 5 * 60_000 && REVIEW_WAIT_MS < 15 * 60_000, 'above what was measured (5.2 min), below the editor timeout (15 min)')
})

test('the very bytes read before are not read again: the finished review is handed back and nothing is started', async (t) => {
  const g = await gateway(t, { states: { rv_1: [done([finding('F01', 'contradiction')], 'rv_1')] } })
  const standing = reviewStanding(/** @type {any} */ (done([finding('F01', 'contradiction')], 'rv_1')), 'aaa')
  const outcome = await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'aaa' }, standing)
  assert.equal(g.posts.length, 0, 'no new review')
  assert.equal(outcome.ok && 'review' in outcome && outcome.reused, true)
  assert.equal(outcome.ok && 'review' in outcome && outcome.review.findings.length, 1, 'the previous findings come back at once')
  assert.equal(reviewSummary(/** @type {any} */ (outcome.ok && 'review' in outcome ? outcome.review : null), true).unchanged?.includes('没有改动'), true)
})

test('an unchanged package whose review cannot be read again is skipped, never restarted', async (t) => {
  const g = await gateway(t, { states: { rv_1: [{ reviewId: 'rv_1', status: 'failed' }] } })
  const standing = reviewStanding(/** @type {any} */ (done([], 'rv_1')), 'aaa')
  const outcome = await reviewForSubmission(ctx, g.config, { ...request, digest: 'aaa' }, standing)
  assert.deepEqual(outcome, { ok: true, skipped: 'review_unchanged' })
  assert.equal(g.posts.length, 0)
})

test('changed bytes after a read that owed nothing get the code\'s checks, not another editor read', async (t) => {
  const g = await gateway(t)
  const standing = reviewStanding(/** @type {any} */ (done([finding('F01', 'wording'), finding('F02', 'structure')], 'rv_0')), 'aaa')
  assert.equal(standing.required, 0, 'advisory findings are not owed')
  const outcome = await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, standing)
  assert.equal(outcome.ok, true)
  assert.equal(g.posts.length, 1)
  assert.equal(g.posts[0].editor, false)
})

test('changed bytes after a read that owed findings get the editor once more: the repair is checked', async (t) => {
  const g = await gateway(t)
  const standing = reviewStanding(/** @type {any} */ (done([finding('F01', 'contradiction', { response: 'fixed' })], 'rv_0')), 'aaa')
  assert.equal(standing.required, 1, 'answered or not, a kind that asks for an answer was raised')
  await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, standing)
  assert.equal(g.posts.length, 1)
  assert.equal('editor' in g.posts[0], false)
})

test('a read the writer asked for is always the full one, whatever was read before', async (t) => {
  const g = await gateway(t)
  const standing = reviewStanding(/** @type {any} */ (done([], 'rv_0')), 'aaa')
  await reviewForSubmission(ctx, g.config, { ...request, digest: '', explicit: true }, standing)
  assert.equal(g.posts.length, 1)
  assert.equal('editor' in g.posts[0], false)
  assert.ok(REVIEW_EXPLICIT_WAIT_MS > REVIEW_WAIT_MS)
  assert.ok(REVIEW_REPEAT_WAIT_MS < 60_000, 'a repeat is code checks: seconds, not minutes')
})

test('a read still running when the wait ends is a pending review with its id, not a failure', async (t) => {
  const g = await gateway(t, { states: { rv_1: [{ reviewId: 'rv_1', status: 'running' }] } })
  const outcome = await runReview(ctx, g.config, { ...request, waitMs: 60 })
  assert.equal(outcome.ok, false)
  assert.equal(!outcome.ok && outcome.pending, true)
  assert.equal(!outcome.ok && outcome.reviewId, 'rv_1')
  assert.equal(!outcome.ok && outcome.code, 'review_unavailable', 'no new code: the run reads it as the review not being in this answer')
  assert.match(String(!outcome.ok && outcome.message), /继续/)
})

test('a pending review is looked at before another is started, and none is stacked behind it', async (t) => {
  const g = await gateway(t, { states: { rv_1: [{ reviewId: 'rv_1', status: 'running' }] } })
  const pending = nextStanding(undefined, { ok: false, code: 'review_unavailable', pending: true, reviewId: 'rv_1', message: 'x' }, 'aaa')
  assert.deepEqual(pending, { reviewId: 'rv_1', digest: 'aaa', status: 'pending', required: 0, findings: [] })
  const outcome = await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, pending)
  assert.equal(g.posts.length, 0)
  assert.equal(!outcome.ok && outcome.pending, true)
  // The record still says which bytes the running read started on.
  const kept = nextStanding(pending, outcome, 'bbb')
  assert.equal(kept?.digest, 'aaa')
})

test('a pending review that finished with findings owed becomes the previous read: the next read checks the repair', async (t) => {
  const g = await gateway(t, { states: { rv_1: [done([finding('F01', 'overclaim')], 'rv_1')] } })
  const pending = nextStanding(undefined, { ok: false, code: 'review_unavailable', pending: true, reviewId: 'rv_1', message: 'x' }, 'aaa')
  await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, pending)
  assert.equal(g.posts.length, 1)
  assert.equal('editor' in g.posts[0], false, 'it owed something, so the editor reads again')
})

test('a pending review that finished clean leaves the next submission with the code\'s checks only', async (t) => {
  const g = await gateway(t, { states: { rv_1: [done([], 'rv_1')] } })
  const pending = nextStanding(undefined, { ok: false, code: 'review_unavailable', pending: true, reviewId: 'rv_1', message: 'x' }, 'aaa')
  await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, pending)
  assert.equal(g.posts[0].editor, false)
})

test('a pending review that cannot be found is asked afresh', async (t) => {
  const g = await gateway(t, { states: { rv_1: [{ reviewId: 'rv_1', status: 'failed', code: 'review_interrupted' }] } })
  const pending = nextStanding(undefined, { ok: false, code: 'review_unavailable', pending: true, reviewId: 'rv_1', message: 'x' }, 'aaa')
  await reviewForSubmission(ctx, g.config, { ...request, attempt: 2, digest: 'bbb' }, pending)
  assert.equal(g.posts.length, 1)
  assert.equal('editor' in g.posts[0], false)
})

test('the plan item keeps what the last read came to, and keeps what it knew when a later ask got nothing', () => {
  const read = /** @type {any} */ (done([finding('F01', 'contradiction'), finding('F02', 'wording', { response: 'declined' })], 'rv_1'))
  const standing = nextStanding(undefined, { ok: true, review: read }, 'aaa')
  assert.deepEqual(standing, {
    reviewId: 'rv_1', digest: 'aaa', status: 'done', required: 1,
    findings: [{ id: 'F01', kind: 'contradiction', answerRequired: true, answered: false }, { id: 'F02', kind: 'wording', answerRequired: false, answered: true }],
  })
  assert.equal(nextStanding(standing, { ok: false, code: 'review_unavailable', message: 'down' }, 'bbb'), standing)
  assert.equal(nextStanding(standing, { ok: true, skipped: 'review_kind_unreviewed' }, 'bbb'), standing)
})

test('a passed submission says plainly that nothing is required, and that suggestions and small edits are no reason to submit again', () => {
  for (const outcome of [null, { ok: true, review: done([]) }, { ok: true, review: done([finding('F01', 'wording'), finding('F02', 'structure')]) }, { ok: false, code: 'review_unavailable', pending: true, reviewId: 'rv', message: 'x' }, { ok: true, skipped: 'review_unchanged' }]) {
    const note = settledNote(/** @type {any} */ (outcome))
    assert.match(note, /没有必须修的问题/)
    assert.match(note, /不需要为它们重新提交/)
    assert.match(note, /回执会按最终文件生成/)
  }
})

test('a finding that asks for an answer is the one reason given to submit again, and it names the findings', () => {
  const note = settledNote(/** @type {any} */ ({ ok: true, review: done([finding('F01', 'contradiction'), finding('F02', 'safety'), finding('F03', 'wording')]) }))
  assert.match(note, /2 条需回应的发现（F01、F02）/)
  assert.match(note, /responses/)
  assert.doesNotMatch(note, /没有必须修的问题/)
})

test('an answered finding is no longer owed: not counted, not marked, however many passes carry it', () => {
  const review = /** @type {any} */ (done([finding('F01', 'contradiction', { response: 'declined' }), finding('F02', 'overclaim')]))
  assert.deepEqual(owedFindings(review).map((f) => f.id), ['F02'])
  assert.deepEqual(reviewSummary(review).answerRequired, ['F02'])
  const lines = reviewIssues(review)
  assert.match(lines[0].message, /F01\]（已回应：不改）/)
  assert.match(lines[1].message, /F02\]（需回应）/)
  assert.match(settledNote(/** @type {any} */ ({ ok: true, review })), /1 条需回应的发现（F02）/)
  assert.match(settledNote(/** @type {any} */ ({ ok: true, review: done([finding('F01', 'contradiction', { response: 'fixed' })]) })), /没有必须修的问题/, 'everything owed has been answered')
})

test('the tool says before it is called what its result says after: ok stands, and only an owed answer is a reason to submit again', async () => {
  const source = await readFile(new URL('../plugins/run-policy.mjs', import.meta.url), 'utf8')
  assert.match(source, /ok 之后交付物已成立，不需要再提交，除非审查标了「需回应」的发现/)
})
