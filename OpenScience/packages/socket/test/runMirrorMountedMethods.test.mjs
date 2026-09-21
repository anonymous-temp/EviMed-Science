import assert from 'node:assert/strict'
import test from 'node:test'

import { projectRunState } from '../src/runMirror.mjs'

test('the run-state projection carries the root session\'s receipt of its mounted methods', () => {
  // 2026-09-21: a run that did its work without delegating had no record of the
  // methods it carried, and every paired-evaluation cell was `arm_not_applied`.
  const projection = projectRunState({
    run: { runId: 'run_1', sessionId: 'ses_1' },
    planIndex: undefined,
    evidence: [],
    mountedMethods: [{ name: 'claim-verdict-audit', digest: `sha256:${'a'.repeat(64)}` }, { name: '', digest: 'x' }, /** @type {any} */ (null)],
    now: '2026-09-21T12:00:00.000Z',
  })
  assert.deepEqual(projection.mountedMethods, [{ name: 'claim-verdict-audit', digest: `sha256:${'a'.repeat(64)}` }])
  assert.deepEqual(projectRunState({ run: {}, planIndex: undefined, evidence: [], now: 'x' }).mountedMethods, [], 'none is an empty list')
})
