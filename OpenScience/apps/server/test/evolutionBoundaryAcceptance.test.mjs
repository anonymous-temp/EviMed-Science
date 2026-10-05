import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { boundaryExecutionReceipts } from '../../../scripts/ops/evolution-boundary-acceptance.mjs';

test('boundary proof requires every exact invalid input and never accepts an unrelated failure', () => {
  const cases = [{ id: 'negative', input: { specification: { initial: [-1, 0] } } },
    { id: 'probability', input: { specification: { transition: [[-0.1, 1.1]] } } }];
  const tool = { id: 'tool', payload: { artifactDigest: 'sha256:exact', revision: 2 } };
  const options = { userId: 'owner', projectId: 'project', runId: 'run', tool, cases };
  const rows = cases.map(item => ({ id: item.id, payload: { userId: 'owner', projectId: 'project', runId: 'run',
    toolId: tool.id, digest: tool.payload.artifactDigest, revision: 2, callId: `actual-${item.id}`,
    inputSha256: createHash('sha256').update(canonicalJson(item.input)).digest('hex'),
    result: { ok: true }, resultEvidence: { kind: 'structured', substantive: false, explicitlyUnsupported: true } } }));
  assert.equal(boundaryExecutionReceipts(rows, options).passed, true);
  assert.equal(boundaryExecutionReceipts(rows.slice(0, 1), options).passed, false);
  for (const patch of [{ inputSha256: 'unrelated' }, { digest: 'previous' }, { result: { ok: false } },
    { resultEvidence: { kind: 'structured', substantive: true, explicitlyUnsupported: true } }, { callId: null }]) {
    assert.equal(boundaryExecutionReceipts([{ ...rows[0], payload: { ...rows[0].payload, ...patch } }, rows[1]], options).passed, false);
  }
});
