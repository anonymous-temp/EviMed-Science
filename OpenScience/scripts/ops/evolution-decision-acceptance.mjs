import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { shanghaiDay } from '../../apps/server/src/notificationService.mjs';

/** Run only against the isolated acceptance app. The clock is advanced explicitly, not real elapsed time.
 * @param {any} app */
export async function runEvolutionDecisionAcceptance(app) {
  const evolution = app.evolution;
  assert.ok(evolution?.service && evolution?.decisions, 'Evolution must be composed for isolated acceptance.');
  const { service, decisions, worker } = evolution;
  assert.equal(worker.running, false, 'Do not alter the clock during another evolution job.');
  const resumeTimer = Boolean(worker.timer);
  worker.stop();
  const originalNow = service.now, originalDecisionNow = decisions.now;
  let controlled = originalNow();
  service.now = decisions.now = () => new Date(controlled);
  const prefix = `acceptance-${randomUUID()}`;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    const rows = [];
    for (let index = 0; index < 4; index++) rows.push(await decisions.propose({
      category: prefix, subjectId: `${prefix}-${index}`, materialVersion: 1, directional: true,
      attemptedPaths: ['compare-existing-conservative-options', 'inspect-public-literature-metadata'],
      title: '隔离验收：meta-analysis 方法方向', body: '这是隔离验收事项：network meta-analysis heterogeneity random effects methods。仅检查近期公开的荟萃分析方法资料，保留已有方向或等待更多资料；不研发工具、不改变科研结论。',
      options: [{ id: 'keep', label: '保留当前方向', operation: 'keep' }, { id: 'wait', label: '等待更多资料', operation: 'wait' }],
      recommended: 'keep', conservative: 'wait', impact: 100 - index,
    }));
    const firstDay = shanghaiDay(controlled);
    const first = await decisions.digest(firstDay);
    const delivered = (await Promise.all(rows.map(row => service.get(row.id)))).filter(row => row.payload.deliveredAt);
    assert.ok(delivered.length > 0 && delivered.length <= 3, 'No more than three cards may be delivered.');
    for (const row of delivered) {
      const notice = await service.notifications.get(await service.owner(), row.payload.notificationId);
      assert.ok(notice?.id && notice.createdAt, 'Delivery requires the real durable notification.');
      assert.equal(row.payload.deliveredAt, notice.createdAt);
      assert.equal(Date.parse(row.payload.dueAt) - Date.parse(row.payload.deliveredAt), 86400000);
    }
    controlled = new Date(Math.max(...delivered.map(row => Date.parse(row.payload.dueAt))) + 1);
    const completed = [];
    for (const row of delivered) {
      const result = await decisions.expire(row.id);
      assert.equal(result.payload.status, 'executed');
      assert.equal(result.payload.source, 'default');
      assert.ok(['keep', 'wait'].includes(result.payload.selected));
      assert.ok(result.payload.evidence.refreshed.evidence.length > 0, 'Fresh Crossref evidence is required.');
      assert.equal(result.payload.evidence.refreshed.family, 'deepseek');
      assert.equal(result.payload.evidence.reviewed.family, 'qwen');
      assert.equal(result.payload.evidence.reviewed.independent, true);
      completed.push({ id: result.id, state: result.payload.status, evidenceHash: hash(result.payload.evidence),
        decisionHash: hash(result.payload.history) });
    }
    const next = await decisions.digest(shanghaiDay(controlled));
    assert.ok(next.payload.autonomous.some(row => completed.some(item => item.id === row.id)), 'The next digest must report expiry outcomes.');
    return { state: 'passed', controlledClock: 'delivery-plus-24-hours', firstDigestId: first.id,
      nextDigestId: next.id, cards: completed, firstDigestHash: hash(first.payload), nextDigestHash: hash(next.payload) };
  } finally {
    service.now = originalNow;
    decisions.now = originalDecisionNow;
    if (resumeTimer) worker.start();
  }
}
