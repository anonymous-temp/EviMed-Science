import assert from 'node:assert/strict';
import test from 'node:test';
import { routeRecordedDecision } from './routing-evaluation.mjs';

test('final dispatch includes the regex net after uncertain Jev answers', async () => {
  const catalog = [{ id: 'clinical-evidence-synthesis', title: 'Evidence synthesis' }];
  const question = '请以已发表论文题目《Empagliflozin in Patients with Chronic Kidney Disease》为检索入口，检索原始全文，并重写一份结构化科研正文（摘要、引言、方法、结果、讨论）。';
  const uncertain = await routeRecordedDecision(question, catalog, { outcome: 'escalated' }, { agentId: 'none' });
  assert.equal(uncertain.agentId, 'clinical-evidence-synthesis');
  const none = await routeRecordedDecision(question, catalog, { outcome: 'settled', value: { agentId: 'none' } }, null);
  assert.equal(none.agentId, 'none');
  const unavailable = await routeRecordedDecision(question, catalog, { outcome: 'fallback' }, { agentId: 'none' });
  assert.equal(unavailable.agentId, 'none');
});
