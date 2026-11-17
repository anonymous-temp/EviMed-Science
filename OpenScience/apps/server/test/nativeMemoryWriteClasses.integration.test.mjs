import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
const { fixture, options } = nativeIntegration();

for (const enabled of [false, true]) test(`commit source review is optional and once-only (${enabled})`, options, async t => {
  const f = await fixture(t, { config: { memoryCommitVerificationEnabled: enabled } });
  const uri = `${f.root}/preferences/self/replies.md`, extracted = '- 回复先结论后依据，200 字以内；需要展开时先问。', corrected = '回复先结论后依据，200 字以内。';
  let calls = 0;
  f.worker.verification.judge = { judge: async ({ lines, maxAttempts }) => {
    calls++; assert.equal(maxAttempts, 1); assert.ok(lines[0].sources.some(source => source.role === 'user' && source.text.includes(corrected)));
    return { calls: 1, results: new Map([[0, { index: 0, verdict: 'corrected', corrected }]]) };
  } };
  f.stub.extract = () => ({ adds: [{ uri, after: extracted }] });
  const commit = await f.commitConversation('source', [{ role: 'user', text: corrected, at: '2026-11-15T00:00:00Z' }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), enabled ? `- ${corrected}` : extracted);
  const ledger = await f.overlay.commit(f.userId, commit.archive_uri);
  if (enabled) {
    assert.equal(ledger.extraction.sourceVerification.calls, 1); assert.equal(ledger.extraction.sourceVerification.applied, 1);
    assert.ok((await f.overlay.originsOf(f.userId, [uri])).get(uri).get(lineFingerprint(corrected)));
  }
  await f.worker.ingest(ledger, JSON.parse(await f.sessions.read(f.userId, `${commit.archive_uri}/memory_diff.json`)));
  assert.equal(calls, enabled ? 1 : 0);
});

test('formatting duplicates preserve both source origins and a stable path after extraction', options, async t => {
  const f = await fixture(t, { config: { memoryNormalizeNamesEnabled: true } });
  const first = `${f.root}/projects/bi-rads 4 类.md`, second = `${f.root}/projects/bi_rads_4_类.md`;
  const old = '- Embase; 4000 words (as of 2026-03-01)', next = '- PubMed; 3000 words (as of 2026-04-01)';
  f.stub.extract = () => ({ adds: [{ uri: first, after: old }] });
  await f.commitConversation('first', [{ role: 'user', text: old }]); await f.worker.processCommits({ userId: f.userId });
  f.stub.extract = () => ({ adds: [{ uri: second, after: next }] });
  await f.commitConversation('second', [{ role: 'user', text: next }]); await f.worker.processCommits({ userId: f.userId });
  const body = await f.sessions.read(f.userId, first);
  assert.ok(body.startsWith(next)); assert.ok(body.includes(old.slice(2)));
  assert.equal(await f.sessions.read(f.userId, second), null);
  assert.equal((await f.overlay.originsOf(f.userId, [first])).get(first).size, 2);
});

test('commit review never treats a platform promotion summary as the person speaking', options, async t => {
  const f = await fixture(t, { config: { memoryCommitVerificationEnabled: true } });
  const uri = `${f.root}/preferences/self/style.md`, body = '- Observed repeated choice: concise replies.';
  f.worker.verification.judge = { judge: async () => { assert.fail('promotion is not an original conversation'); } };
  f.stub.extract = () => ({ adds: [{ uri, after: body }] });
  await f.commitConversation('promotion', [{ role: 'user', text: body }], { origin: 'promotion' });
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), body);
});

test('consolidation cannot replace a long specific file with a topical summary', options, async t => {
  const f = await fixture(t, { config: { memoryKeepUnexplainedLinesEnabled: true } });
  const uri = `${f.root}/projects/study.md`, before = Array.from({ length: 250 }, (_, i) => `- Study ABC${i}: count ${i + 1}`).join('\n');
  f.stub.extract = () => ({ adds: [{ uri, after: before }] });
  await f.commitConversation('first', [{ role: 'user', text: before }]); await f.worker.processCommits({ userId: f.userId });
  f.stub.files.set(uri, '- Study summary.');
  await f.worker.ingestConsolidation(f.userId, { taskId: 'write-classes', updates: [uri] });
  const after = await f.sessions.read(f.userId, uri);
  assert.ok(after.includes('Study ABC249: count 250')); assert.ok(after.includes('Study summary.'));
});
