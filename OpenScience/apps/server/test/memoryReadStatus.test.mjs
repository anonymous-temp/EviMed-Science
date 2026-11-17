import assert from 'node:assert/strict';
import test from 'node:test';
import { measuredRead, readStatus, searchStatusText, literalIndexMatch, memorySourceLabel } from '../src/memoryReadStatus.mjs';
import { profileStatements } from '../src/nativeMemoryStore.mjs';
import { MEMORY_PROFILE_NEUTRAL_TITLES, MEMORY_PROFILE_STRUCTURAL_TITLES, MEMORY_PROFILE_HEADING_RULE } from '@evimed/domain';
import { renderMemoryTemplates } from '../../../deploy/web/openviking/memory-templates-src/build.mjs';
import { loadConfig } from '../src/config.mjs';

test('empty, failed, timed-out and skipped lookups cannot masquerade as one another', async () => {
  assert.equal((await measuredRead(async () => [], 100)).status.state, 'empty');
  assert.equal((await measuredRead(async () => { throw Error('private detail'); }, 100)).status.state, 'unavailable');
  const timeout = await measuredRead(() => new Promise(() => {}), 1);
  assert.equal(timeout.status.reason, 'timeout');
  assert.doesNotMatch(searchStatusText({ earlierConversations: timeout.status }), /private detail/);
  assert.equal(readStatus('skipped', 'paused').reason, 'paused');
});

test('literal index matching does not infer identities or medical meanings', () => {
  assert.equal(literalIndexMatch('What did Mara say?', ['Mara.md']), true);
  assert.equal(literalIndexMatch('What did Mara say?', ['Mary.md']), false);
  assert.equal(literalIndexMatch('What did Tamara say?', ['Mara.md']), false);
  assert.equal(literalIndexMatch('What is an allergy?', ['Mara.md']), false);
  assert.equal(loadConfig({ memoryLiteralFallbackEnabled: false }).memoryLiteralFallbackEnabled, false);
  assert.equal(loadConfig({ memoryLiteralFallbackEnabled: true }).memoryLiteralFallbackEnabled, true);
});

test('source labels preserve supported speaker, date and earlier-value metadata without inventing certainty', () => {
  const item = { speaker: 'assistant', asOf: '2025-01-01', earlierValue: true, attribution: { origins: ['document'] } };
  const label = memorySourceLabel(item);
  assert.match(label, /assistant/); assert.match(label, /2025-01-01/); assert.match(label, /earlierValue/);
  assert.doesNotMatch(label, /confirmed.*true/);
  assert.deepEqual(profileStatements('# Mara\n## Work\n- Designs reports.'), ['# Mara', 'Designs reports.']);
});

test('literal fallback environment default remains off', () => {
  const name = 'OPEN_SCIENCE_MEMORY_LITERAL_FALLBACK_ENABLED', previous = process.env[name];
  try {
    delete process.env[name]; assert.equal(loadConfig().memoryLiteralFallbackEnabled, false);
    process.env[name] = 'true'; assert.equal(loadConfig().memoryLiteralFallbackEnabled, true);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('a failed capsule channel is not hidden by a successful empty reference channel', async () => {
  const { createNativeCapsuleSearch } = await import('../src/capsuleGateway.mjs');
  const search = createNativeCapsuleSearch({ service: { recall: async () => { throw Error('source offline'); } }, subscriptions: { recall: async () => [] } });
  const result = await search({ user: { id: 'u' }, project: { id: 'default' }, query: 'past', limit: 5 });
  assert.equal(result.length, 0); assert.equal(result.readStatus.state, 'unavailable');
  const none = createNativeCapsuleSearch({ service: { recall: async () => ({ items: [], mode: 'lexical' }) } });
  assert.equal((await none({ user: { id: 'u' }, project: { id: 'default' }, query: 'absent', limit: 5 })).readStatus.state, 'empty');
});


test('profile facts and opt-in next templates share the exact unnamed headings', () => {
  for (const title of Object.values(MEMORY_PROFILE_NEUTRAL_TITLES)) {
    assert.deepEqual(profileStatements(`# ${title}`), []);
    assert.deepEqual(profileStatements(`# ${title}\r\n- Designs reports.\r\n## Work`), ['Designs reports.']);
  }
  // A generic document title or the word for "user" in another language is scaffolding too: the serving template asks for
  // "the word for user" in the conversation's language, and the memory page must not show such a title as the person's name
  // (memoryApi.integration pins a "# Profile" file as its statements only).
  for (const title of [...MEMORY_PROFILE_STRUCTURAL_TITLES, 'profile', 'USER  PROFILE', 'Ｐｒｏｆｉｌｅ']) {
    assert.deepEqual(profileStatements(`# ${title}\n- Designs reports.`), ['Designs reports.'], title);
  }
  for (const title of ['Mara Santos', 'Dr User', 'Profile of Mara', '用户的昵称', '画像师小王']) {
    assert.deepEqual(profileStatements(`# ${title}\n- Designs reports.`), [`# ${title}`, 'Designs reports.']);
  }
  for (const variant of ['next']) {
    const template = renderMemoryTemplates({ variant })['profile.yaml'];
    assert.ok(template.includes(MEMORY_PROFILE_HEADING_RULE.split('\n').join('\n  ')));
    assert.doesNotMatch(template, /__PROFILE_HEADING__/);
  }
});
