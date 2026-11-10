import assert from 'node:assert/strict';
import test from 'node:test';
import { privateByDefault, sourceAllowsEgress } from '@evimed/domain';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { sourceReceiptState } from '../src/memorySourceReceipts.mjs';
import { methodSourceAllowsLearning } from '../src/runLearningScope.mjs';
const native = nativeIntegration(), options = native.options;

async function ingested(t) {
  const f = await native.fixture(t, { extract: ({ user }) => ({ adds: [
    { uri: `viking://user/${user}/memories/profile.md`, memory_type: 'profile', after: '# Profile\n- Prefers short answers.' },
    { uri: `viking://user/${user}/memories/people/lin.md`, memory_type: 'people', after: '# People\n- A colleague, Dr. Lin, reviews my drafts.' }] }) });
  await f.commitConversation('a', [{ role: 'user', text: 'Prefer short answers; Dr. Lin reviews my drafts.' }], { projectId: null });
  await f.worker.processCommits({ userId: f.userId });
  const records = await f.store.records(f.userId);
  return { f, records, of: (/** @type {string} */ text) => records.find(record => String(record.value).includes(text)) };
}

test('a line the engine extracted from the owner\'s own conversation is ordinary; a people file stays private', options, async t => {
  const { f, of } = await ingested(t);
  const profile = of('Prefers short answers'), person = of('Dr. Lin');
  assert.equal(profile.sourcePrivacy.classification, 'ordinary');
  assert.equal(person.sourcePrivacy.classification, 'private');
  assert.equal(privateByDefault(profile), false, 'the external agent-memory API and default shares may list it');
  assert.equal(privateByDefault(person), true, 'people stay out of the external API and default shares');
  const listed = await f.store.listRecords(f.userId, { statuses: ['active'], pageSize: 100, allowRecord: record => !privateByDefault(record) });
  assert.ok(listed.some(record => String(record.value).includes('Prefers short answers')), 'the external API lists the ordinary record');
  assert.ok(!listed.some(record => String(record.value).includes('Dr. Lin')));
  // The external agent-memory API's own filter (agentMemoryRoutes list/search): ordinary records come back, people do not.
});

test('a line with no provable origin stays unclassified and private by default', options, async t => {
  const { f } = await ingested(t);
  f.seed('preferences/unknown.md', '# Preferences\n- Nobody knows where this came from.', { type: 'preferences' });
  const found = (await f.store.records(f.userId)).find(record => String(record.value).includes('Nobody knows'));
  assert.equal(found.sourcePrivacy.classification, 'unclassified');
  assert.equal(privateByDefault(found), true);
});

test('distillation admits a run that was handed ordinary memory and refuses one that was handed a person', options, async t => {
  const { of } = await ingested(t);
  const receipt = record => sourceReceiptState([{ id: record.id, contentDigest: record.contentHash, sourcePrivacy: record.sourcePrivacy, attribution: record.attribution }], { trusted: true });
  const ordinaryRun = { ...receipt(of('Prefers short answers')) }, personRun = { ...receipt(of('Dr. Lin')) };
  assert.equal(methodSourceAllowsLearning(ordinaryRun), true);
  assert.equal(sourceAllowsEgress(ordinaryRun, { purpose: 'method' }), true);
  assert.equal(methodSourceAllowsLearning(personRun), false);
});
