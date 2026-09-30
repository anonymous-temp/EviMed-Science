import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontierWeekWindow, latestFrontierWeek, frontierWeeklyRows } from '../src/frontierWeekly.mjs';
import { frontierNoticeHref } from '@evimed/domain';
import { notificationSwitches } from '../src/notificationService.mjs';
import { FrontierComposer } from '../src/frontierComposer.mjs';
test('completed calendar week respects Monday due time, year boundary and DST', () => {
    const config = { timeZone: 'Asia/Shanghai', dailyTime: '07:30' };
    assert.equal(latestFrontierWeek(new Date('2026-09-27T23:29:00Z'), config), '2026-09-14');
    assert.equal(latestFrontierWeek(new Date('2026-09-27T23:30:00Z'), config), '2026-09-21');
    assert.equal(latestFrontierWeek(new Date('2027-01-04T00:00:00Z'), config), '2026-12-28');
    const dst = frontierWeekWindow('2026-03-02', 'America/New_York');
    assert.equal(dst.end - dst.start, 167 * 3600000);
    assert.throws(() => frontierWeekWindow('2026-09-22', 'Asia/Shanghai'));
});
test('one event appears once, preferring primary verified material', () => {
    const rows = [{ id: '1', event_id: '1', primary: false, score_total: 99 }, { id: '2', event_id: '1', primary: true, score_total: 60 }, { id: '3', event_id: null }];
    assert.deepEqual(frontierWeeklyRows(rows).map(x => x.id), ['2', '3']);
});
test('optional frontier switches inherit legacy opt-out but remain independent', () => {
    assert.equal(notificationSwitches({ frontier: false }).frontierWeekly, false);
    assert.equal(notificationSwitches({ frontier: false }).frontierSafety, false);
    assert.equal(notificationSwitches({ frontier: false, frontierSafety: true }).frontierSafety, true);
});
test('closed notice targets route daily, weekly and safety to the frontier', () => {
    assert.equal(frontierNoticeHref({ type: 'digest', id: 'frontier-weekly:2026-09-21' }), '/app/frontier?view=weekly&week=2026-09-21');
    assert.equal(frontierNoticeHref({ type: 'system', id: 'frontier-safety:fi_123' }), '/app/frontier?item=fi_123');
    assert.equal(frontierNoticeHref({ type: 'digest', id: 'frontier-weekly:2026-02-31' }), null);
    assert.equal(frontierNoticeHref({ type: 'system', id: 'frontier-safety:../../private' }), null);
});
test('new loops share maintenance admission, isolate failures and expose outcomes', async () => {
    const calls = [];
    let allowed = true;
    const composer = new FrontierComposer({ canRun: () => allowed, weekly: { runDue: async () => { calls.push('weekly'); throw new Error('failed'); } }, notifications: { queueWeekly: async () => calls.push('queue'), scanSafety: async () => calls.push('safety'), deliverDue: async () => calls.push('deliver') } });
    await assert.rejects(composer.tick());
    assert.deepEqual(new Set(calls), new Set(['weekly', 'queue', 'safety', 'deliver']));
    allowed = false;
    calls.length = 0;
    await composer.tick();
    assert.equal(calls.length, 0);
});
