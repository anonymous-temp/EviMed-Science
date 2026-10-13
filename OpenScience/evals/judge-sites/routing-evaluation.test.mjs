import assert from 'node:assert/strict';
import test from 'node:test';
import { routeRecordedDecision } from './routing-evaluation.mjs';

test('final dispatch after an uncertain or failed Jev answer is the ordinary line, with the medicine rule the only thing under it', async () => {
  const catalog = [{ id: 'clinical-evidence-synthesis', title: 'Evidence synthesis' }];
  const question = '请以已发表论文题目《Empagliflozin in Patients with Chronic Kidney Disease》为检索入口，检索原始全文，并重写一份结构化科研正文（摘要、引言、方法、结果、讨论）。';
  // These were routed to clinical-evidence-synthesis by the regex net whenever Jev was unsure or down (the class the title-to-paper set measures).
  const uncertain = await routeRecordedDecision(question, catalog, { outcome: 'escalated' }, { agentId: 'none' });
  assert.equal(uncertain.agentId, 'none');
  const none = await routeRecordedDecision(question, catalog, { outcome: 'settled', value: { agentId: 'none' } }, null);
  assert.equal(none.agentId, 'none');
  const unavailable = await routeRecordedDecision(question, catalog, { outcome: 'fallback' }, { agentId: 'none' });
  assert.equal(unavailable.agentId, 'none');
  // The pharmacists' list of high-risk medicines still reaches the clinical line in each of those states.
  const medicine = '请就速效救心丸的疗效与安全性做一份循证证据综述报告。';
  for (const [decision, baseline] of [[{ outcome: 'escalated' }, { agentId: 'none' }], [{ outcome: 'fallback' }, { agentId: 'none' }], [{ outcome: 'settled', value: { agentId: 'none' } }, null]]) {
    assert.equal((await routeRecordedDecision(medicine, catalog, decision, baseline)).agentId, 'clinical-evidence-synthesis');
  }
});
