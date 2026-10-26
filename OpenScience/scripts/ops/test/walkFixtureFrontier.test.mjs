import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureGroupAnswer } from '../walk-fixture/frontier.mjs';
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
