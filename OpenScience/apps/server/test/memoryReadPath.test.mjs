import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as opening from '../src/memoryOpeningByUse.mjs';
import * as indexing from '../src/memoryIndexProvider.mjs';
import * as layout from '../src/openVikingLayout.mjs';

const root = 'viking://user/owner/memories';
const pref = (name, body, extra = {}) => ({ uri: `${root}/preferences/${name}.md`, body, ...extra });

test('standing opening keeps complete scoped preference lines, recent then used, within 400 characters', () => {
  const files = [pref('self/old', '- Old rule.', { usedCount: 99, updatedAt: '2026-01-01' }),
    pref('corrections/reply', '# Reply\n- For weekly reports, use at most 140 characters.', { updatedAt: '2026-11-14' }),
    pref('self/private', '- Private rule.', { sensitive: true }), pref('someone/format', '- Other person.'),
    pref('self/large', `- ${'x'.repeat(500)}`, { updatedAt: '2026-11-15' })];
  assert.deepEqual(opening.standingPreferenceMemos(files, {}), []);
  const memos = opening.standingPreferenceMemos(files, { memoryStandingInstructionsEnabled: true });
  assert.deepEqual(memos.map(row => row.content), ['- For weekly reports, use at most 140 characters.', '- Old rule.']);
  assert.ok(memos.map(row => row.content).join('\n').length <= 400);
  assert.ok(memos.every(row => row.memoryType === 'native_standing_preference'));
});

test('memory file and capsule floors share normalization and reject unknown scores only when enabled', () => {
  const hits = [{ score: 0.9 }, { score: 0.5 }, {}, { score: NaN }];
  assert.deepEqual(indexing.memorySearchHits(hits, 0), hits);
  assert.deepEqual(indexing.memorySearchHits(hits, 0.5), hits.slice(0, 2));
  assert.deepEqual(indexing.memorySearchHits(hits, 0.75), hits.slice(0, 1));
  assert.equal(indexing.memorySearchFloor(Infinity, 0), 0);
  assert.equal(indexing.memorySearchFloor(-1, 0), 0);
  assert.equal(indexing.memorySearchFloor(2, 0), 1);
});

test('only owned people and dedicated safety files travel; namespace and switch are mandatory', () => {
  for (const type of ['people', 'safety_notes']) {
    const uri = `${root}/${type}/person.md`;
    assert.equal(layout.personalMemoryTravels(uri, root, false), false);
    assert.equal(layout.personalMemoryTravels(uri, root, true), true);
    assert.equal(layout.personalMemoryTravels(uri.replace('/owner/', '/shared/'), root, true), false);
  }
  for (const type of ['notes', 'project_facts', 'decisions', 'projects', 'recent_work', 'preferences'])
    assert.equal(layout.personalMemoryTravels(`${root}/${type}/a.md`, root, true), false);
});

const source = await readFile(new URL('../../../packages/socket/src/guidanceText.mjs', import.meta.url), 'utf8');
const stubbed = source.replace(/^import \{[^}]*\} from '@evimed\/domain'\s*$/m,
  "const capabilityListed = () => false; const capabilityTitle = () => ''; const skillRootGuidance = () => '';");
const { buildGuidanceText } = await import(`data:text/javascript;base64,${Buffer.from(stubbed).toString('base64')}`);

test('search hint rejects neighbouring facts and requires original history for earlier assistant suggestions', () => {
  const options = { askUserEnabled: true, openVikingMemory: true };
  const off = buildGuidanceText([], options);
  const on = buildGuidanceText([], { ...options, memorySearchHint: true });
  assert.doesNotMatch(off, /不同的人、属性或时间/);
  assert.match(on, /不同的人、属性或时间/);
  assert.match(on, /所问事实没有记录/);
  assert.match(on, /查以前的对话一次/);
  assert.match(on, /助手自己.*原始对话/);
  assert.match(on, /不限定 target_uri/);
});


test('standing preference budget never separates a rule from its continuation or exception', () => {
  const scope = `- Use brief replies.\n  Except when ${'x'.repeat(400)}.`;
  const memos = opening.standingPreferenceMemos([pref('self/rule', scope)], { memoryStandingInstructionsEnabled: true });
  assert.deepEqual(memos, []);
});

test('standing language preference explicitly overrides the later default language rule', () => {
  const options = { askUserEnabled: true, openVikingMemory: true, memoryStandingInstructions: true };
  assert.match(buildGuidanceText([], options), /语言偏好适用时.*优先于下文.*默认规则/);
});
