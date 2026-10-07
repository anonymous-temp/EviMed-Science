import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNaturalToolAcceptance } from '../../../scripts/ops/evolution-natural-tool-acceptance.mjs';
test('natural proof rejects stale pin, a conversation the researcher did not put in the capability, and incomplete output', () => {
  const input = { run: { id: 'run', status: 'succeeded', effectiveRouteReason: 'choice:statistical-analysis', effectiveAgentId: 'statistical-analysis' }, tool: { id: 'tool', payload: { artifactDigest: 'exact', revision: 2 } }, capabilityId: 'statistical-analysis', transcript: { header: { completeness: 'complete' } }, receipts: [{ id: 'receipt', payload: { runId: 'run', toolId: 'tool', digest: 'exact', revision: 2, callId: 'actual', result: { ok: true }, resultEvidence: { substantive: true, kind: 'structured' } } }] };
  assert.deepEqual(verifyNaturalToolAcceptance(input).receiptIds, ['receipt']);
  for (const patch of [{ digest: 'stale' }, { runId: 'previous' }, { result: { ok: false } }, { resultEvidence: { substantive: false, kind: 'empty' } }]) assert.throws(() => verifyNaturalToolAcceptance({ ...input, receipts: [{ ...input.receipts[0], payload: { ...input.receipts[0].payload, ...patch } }] }));
  assert.throws(() => verifyNaturalToolAcceptance({ ...input, run: { ...input.run, effectiveRouteReason: 'unrouted:open-domain' } }));
  assert.throws(() => verifyNaturalToolAcceptance({ ...input, transcript: { header: { completeness: 'partial' } } }));
});
