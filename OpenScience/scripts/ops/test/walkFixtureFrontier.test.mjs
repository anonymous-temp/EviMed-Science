import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXTURE_ITEMS, fixtureArchiveDays, fixtureGroupAnswer } from '../walk-fixture/frontier.mjs';
import { buildGroupInput, buildGroupPairInput, validateGroupAnswer, validateGroupPair } from '../../../apps/server/src/frontierEventGrouping.mjs';

const report = registry => ({ titleZh: 'Synthetic registry report', registryIds: [registry], summaryZh: 'Synthetic fixture only' });
test('fixture grouping uses the current wire and joins only the same synthetic registry', () => {
  const input = buildGroupInput({ report: report('NCT90000001'), candidates: [report('NCT90000001'), report('NCT90000002')].map(candidate => ({ report: candidate, members: 1 })) });
  const output = validateGroupAnswer(2, fixtureGroupAnswer([{ role: 'user', content: input }]));
  assert.deepEqual(output.decisions.map(entry => entry.relation), ['SAME_OCCURRENCE', 'UNRELATED']);
  for (const [registry, expected] of [['NCT90000001', 'SAME_OCCURRENCE'], ['NCT90000002', 'UNRELATED']]) {
    const pair = buildGroupPairInput(report('NCT90000001'), report(registry));
    assert.equal(validateGroupPair(fixtureGroupAnswer([{ role: 'user', content: pair }])).relation, expected);
  }
});

test('the archive holds issues of more than one month, all before today, whatever day the fixture is made on', () => {
  for (const today of ['2026-10-26', '2026-03-01', '2026-03-31', '2026-01-02', '2026-12-31', '2027-02-28']) {
    const days = fixtureArchiveDays(today);
    assert.ok(days.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && day < today), `${today}: ${days}`);
    assert.deepEqual(days, [...new Set(days)].sort().reverse(), `${today}: unique, newest first`);
    const months = new Set(days.map(day => day.slice(0, 7)));
    assert.ok(months.size >= 2, `${today}: ${months.size} month(s)`);
    assert.ok(days.some(day => day.slice(0, 7) !== today.slice(0, 7)), `${today}: a month other than this one`);
    assert.ok(days.length >= 6, `${today}: enough rows to draw a column`);
  }
});

test('the second story spans Beijing days whatever the hour: its reports besides the paper are at least 48 hours apart, and there are three', () => {
  const story = FIXTURE_ITEMS.filter(([, , , , , , , registry]) => registry === 'NCT90000002');
  const reports = story.filter(([source]) => source !== 'example-journal-cardiology');
  const hours = reports.map(([, hoursAgo]) => hoursAgo);
  assert.ok(reports.length >= 3, `${reports.length} reports besides the paper`);
  assert.ok(Math.max(...hours) - Math.min(...hours) >= 48, `hours ${hours}`);
});
