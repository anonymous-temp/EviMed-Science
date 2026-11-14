import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { NativeMemoryWorker } from '../src/nativeMemoryWorker.mjs';
import { nativeFileId } from '../src/nativeMemoryStore.mjs';
import { createForgetRequestJudge } from '../src/nativeMemoryForgetRequests.mjs';
import { createRejectionJudge } from '../src/nativeMemoryRejections.mjs';
const { fixture, options } = nativeIntegration();
const fact = 'Project M-41633.';
const other = 'Independent goal.';
const old = '2026-01-01T00:00:00.000Z', fresh = '2099-01-01T00:00:00.000Z';
// Enumerated affirmative fixture statements; the real judge parser checks their source witnesses.
function allowFixtureRestatements(f) {
  const rejectionJudge = createRejectionJudge({ config: { deepseekModel: 'fixture', deepseekApiKey: 'fixture' },
    callModel: async (_deps, call) => {
      const input = JSON.parse(call.body.messages[1].content);
      const source = input.said.findIndex(text => [fact, '我上个月临时替同事值了2次夜班'].includes(text));
      const candidates = input.candidates.map(row => row.candidate);
      return { choices: [{ message: { content: JSON.stringify({
        same: input.candidates.map(row => ({ candidate: row.candidate, removed: row.options[0] })),
        stated: source < 0 ? [] : candidates,
        assertions: source < 0 ? [] : candidates.map(candidate => ({ candidate, source, quote: input.said[source] })),
      }) } }] };
    } });
  f.worker.rejectionJudge = rejectionJudge; f.worker.verification.rejectionJudge = rejectionJudge;
}
const withJudge = (f, check) => new NativeMemoryWorker({ ...f, nativeMemory: f.store, forgetRequestJudge: { check } });
const verdict = (input, decision = 'remove') => ({ requests: [{ message: 0, quote: 'Forget that project.', decision,
  targets: input.candidates.flatMap((row, i) => row.text === fact ? [i] : []), intents: [] }], claims: [{ message: 1, quote: 'Forgotten.' }] });

test('a repeated withdrawal repairs an invented extra quote without creating another removal', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  await f.store.forgetLines(f.userId, (await f.store.rawFiles(f.userId)).find(file => file.uri === uri), [fact]);
  const before = await f.overlay.removals(f.userId);
  let calls = 0;
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekModel: 'test', deepseekApiKey: 'test-key' },
    callModel: async (_deps, request) => {
      const input = JSON.parse(request.body.messages[1].content);
      if (++calls === 3) return { choices: [{ message: { content: JSON.stringify({ targets: input.targets.map(row => ({ request: row.request, candidate: row.candidate, decision: 'remove' })) }) } }] };
      const target = input.candidates.find(row => row.removed);
      return { choices: [{ message: { content: JSON.stringify({ requests: [{ message: 0, quote: 'Forget that project.', decision: 'remove',
        targets: [target.candidate], intents: calls === 1 ? [{ message: 0, quote: fact }] : [] }], claims: [] }) } }] };
    } });
  const worker = new NativeMemoryWorker({ ...f, nativeMemory: f.store, forgetRequestJudge: judge });
  const committed = await f.commitConversation('repeat', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  const request = (await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests.requests[0];
  assert.equal(request.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(request.removed, 0);
  assert.equal(request.alreadyRemoved, 1);
  assert.deepEqual(request.intents, []);
  assert.deepEqual(await f.overlay.removals(f.userId), before);
  assert.equal(await f.sessions.read(f.userId, uri), null);
});

test('off does not judge or remove', options, async t => {
  const f = await fixture(t), uri = f.seed('notes/test.md', fact);
  const worker = withJudge(f, () => { throw new Error('must not call'); });
  await f.commitConversation('off', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact);
});

for (const deferred of [false, true]) test(`request without tool removes only referred lines, rejects re-extraction, permits later restatement, and is undoable (deferred=${deferred})`, options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  allowFixtureRestatements(f);
  f.overlay.deferredSummaryRebuildEnabled = deferred;
  const uri = f.seed('notes/test.md', `- ${fact}\n- ${other}`);
  const worker = withJudge(f, input => verdict(input));
  const committed = await f.commitConversation('on', [{ role: 'user', text: 'Forget that project.', at: old }, { role: 'assistant', text: 'Forgotten.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), `- ${other}`);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text.toLowerCase().includes('m-41633')));
  const result = (await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests;
  assert.equal(result.requests[0].removed, 1);
  assert.equal(result.falseClaims, 0);
  const revisionCount = (await f.overlay.revisionsOf(f.userId, uri)).length;
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.revisionsOf(f.userId, uri)).length, revisionCount);
  const archived = (await f.store.profile(f.userId)).records.find(record => record.status === 'archived');
  assert.equal(archived.value, fact);
  await f.store.update(f.userId, archived.id, { status: 'active', expectedVersion: archived.version });
  assert.match(await f.sessions.read(f.userId, uri), /M-41633/);
  await f.store.forgetLines(f.userId, (await f.store.rawFiles(f.userId)).find(file => file.uri === uri), [fact]);
  f.stub.extract = () => ({ updates: [{ uri, before: other, after: `- ${fact}\n- ${other}` }] });
  await f.commitConversation('old-again', [{ role: 'user', text: fact, at: old }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), `- ${other}`);
  await f.commitConversation('restated', [{ role: 'user', text: fact, at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.match(await f.sessions.read(f.userId, uri), /M-41633/);
});

test('a tool removal is not repeated or redated by settlement', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  await f.store.forget({ id: f.userId }, { id: 'default', userId: f.userId }, uri, { engineSession: 'dsh-session_tool' });
  const before = await f.overlay.removals(f.userId);
  const worker = withJudge(f, input => ({ requests: [{ message: 0, quote: 'Forget that project.', decision: 'remove',
    targets: input.candidates.map((_, i) => i), intents: [] }], claims: [{ message: 1, quote: 'Forgotten.' }] }));
  const committed = await f.commitConversation('tool', [{ role: 'user', text: 'Forget that project.' }, { role: 'assistant', text: 'Forgotten.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.deepEqual(await f.overlay.removals(f.userId), before);
  assert.equal((await f.overlay.revisionsOf(f.userId, uri)).length, 1);
  assert.equal((await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests.falseClaims, 0);
});

test('ambiguous reference removes nothing and records pending confirmation and an unsupported completion claim', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  const worker = withJudge(f, input => verdict(input, 'uncertain'));
  const committed = await f.commitConversation('uncertain', [{ role: 'user', text: 'Forget that project.' }, { role: 'assistant', text: 'Forgotten.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact);
  const result = (await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests;
  assert.equal(result.requests[0].status, 'pending');
  assert.equal(result.falseClaims, 1);
});

test('an unstored target records an undoable intent that refuses later extraction of earlier messages', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const worker = withJudge(f, () => ({ requests: [{ message: 0, quote: `Forget ${fact}`, decision: 'remove', targets: [],
    intents: [{ message: 0, quote: fact }] }], claims: [] }));
  await f.commitConversation('not-stored', [{ role: 'user', text: `Forget ${fact}`, at: old }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.removals(f.userId)).length, 1);
  assert.equal((await f.store.forgotten(f.userId)).length, 1);
  const uri = `${f.root}/notes/late.md`;
  f.stub.extract = () => ({ adds: [{ uri, after: fact }] });
  await f.commitConversation('late', [{ role: 'user', text: fact, at: old }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null);
});

test('pending page choices can be confirmed without deleting unrelated lines, or dismissed', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', `- ${fact}\n- ${other}`);
  const worker = withJudge(f, input => verdict(input, 'uncertain'));
  await f.commitConversation('pending-page', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  const pending = (await f.store.profile(f.userId)).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'confirmation');
  assert.deepEqual(pending[0].choices, [{ index: 0, text: fact }]);
  await assert.rejects(f.store.resolveForgetRequest(f.userId, pending[0].id, { action: 'confirm', choices: [5] }));
  await f.store.resolveForgetRequest(f.userId, pending[0].id, { action: 'confirm', choices: [0] });
  assert.equal(await f.sessions.read(f.userId, uri), `- ${other}`);
  assert.equal((await f.store.pending(f.userId)).length, 0);
});

test('confirmation refuses a changed before-image and never accepts another account request', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  const worker = withJudge(f, input => verdict(input, 'uncertain'));
  await f.commitConversation('pending-stale', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  const [pending] = await f.store.pending(f.userId);
  f.stub.files.set(uri, `${fact}\n${other}`);
  await assert.rejects(f.store.resolveForgetRequest(f.userId, pending.id, { action: 'confirm', choices: [0] }), { code: 'memory_source_body_changed' });
  const otherAccount = await fixture(t);
  await assert.rejects(otherAccount.store.resolveForgetRequest(otherAccount.userId, pending.id, { action: 'confirm', choices: [0] }), { status: 404 });
  await f.store.resolveForgetRequest(f.userId, pending.id, { action: 'dismiss', choices: [] });
  assert.equal((await f.store.pending(f.userId)).length, 0);
  assert.equal(await f.sessions.read(f.userId, uri), `${fact}\n${other}`);
});

test('selected headings disappear too and a removed identifier leaves the filename without losing independent content', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/M-41633.md', `# M-41633\n- ${fact}\n- ${other}`);
  const worker = withJudge(f, input => ({ requests: [{ message: 0, quote: 'Forget that project.', decision: 'remove',
    targets: input.candidates.flatMap((row, index) => row.text.includes('M-41633') ? [index] : []), intents: [] }], claims: [] }));
  await f.commitConversation('heading', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  const kept = (await f.store.rawFiles(f.userId)).find(file => file.body.includes(other));
  assert.ok(kept);
  assert.equal(kept.body.trim(), `- ${other}`);
  assert.ok(!kept.uri.includes('M-41633'));
});

test('retained archive context cannot repeat an undone request when the judge changes its quote span', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  let checks = 0;
  const worker = withJudge(f, input => {
    const result = verdict(input);
    if (++checks > 1) result.requests[0].quote = 'Forget that project';
    return result;
  });
  const messages = [{ role: 'user', text: 'Forget that project.', at: old }];
  const original = await f.commitConversation('retained', messages);
  await worker.processCommits({ userId: f.userId });
  await f.store.undo(f.userId, nativeFileId(uri));
  // A second archive of the same source session retaining the same message.
  const archiveUri = original.archive_uri.replace('archive_001', 'archive_002');
  f.stub.files.set(`${archiveUri}/messages.jsonl`, f.stub.files.get(`${original.archive_uri}/messages.jsonl`));
  f.stub.files.set(`${archiveUri}/memory_diff.json`, JSON.stringify({ operations: {} }));
  await f.overlay.recordCommit({ userId: f.userId, archiveUri, engineSession: original.session, origin: 'gateway' });
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), fact);
  assert.equal((await f.overlay.commit(f.userId, archiveUri)).extraction.forgetRequests.requests.length, 0);
});

test('a failed judge settles the commit and retries the advisory check independently', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  let attempts = 0;
  const worker = withJudge(f, input => { if (!attempts++) throw new Error('temporary model failure'); return verdict(input); });
  const committed = await f.commitConversation('retry-check', [{ role: 'user', text: 'Forget that project.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, committed.archive_uri)).state, 'completed');
  assert.equal(await f.sessions.read(f.userId, uri), fact);
  await f.database.query("UPDATE evimed_memory.native_commits SET updated_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1", [f.userId]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), null);
  assert.equal(attempts, 2);
});

test('a reply claiming completion with only a historical removal is counted, without removing again', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  await f.store.remove(f.userId, nativeFileId(uri), { keepText: true });
  const worker = withJudge(f, input => ({ requests: [{ message: 0, quote: 'Forget that project.', decision: 'remove', targets: input.candidates.map((_, i) => i), intents: [] }],
    claims: [{ message: 1, quote: 'Forgotten.' }] }));
  const committed = await f.commitConversation('claim', [{ role: 'user', text: 'Forget that project.' }, { role: 'assistant', text: 'Forgotten.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests.falseClaims, 1);
});

test('two absent targets in one commit each keep their own undoable intent', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const targets = [fact, 'Project N-51744.'];
  const worker = withJudge(f, () => ({ requests: targets.map((text, message) => ({ message, quote: `Forget ${text}`,
    decision: 'remove', targets: [], intents: [{ message, quote: text }] })), claims: [] }));
  await f.commitConversation('two-intents', targets.map(text => ({ role: 'user', text: `Forget ${text}` })));
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.removals(f.userId)).length, 2);
  const forgotten = await f.store.forgotten(f.userId);
  assert.equal(forgotten.length, 2);
  assert.equal(new Set(forgotten.map(record => record.id)).size, 2);
});

test('removing something in an earlier turn does not excuse a later unsupported completion claim', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  f.seed('notes/test.md', fact);
  const worker = withJudge(f, input => ({ requests: [{ message: 0, quote: 'Forget that project.', decision: 'remove',
    targets: input.candidates.map((_, i) => i), intents: [] }, { message: 2, quote: 'And forget the other one.', decision: 'uncertain',
    targets: [], intents: [] }], claims: [{ message: 1, quote: 'Forgotten.' }, { message: 3, quote: 'Forgotten too.' }] }));
  const commit = await f.commitConversation('two-turns', [{ role: 'user', text: 'Forget that project.' }, { role: 'assistant', text: 'Forgotten.' },
    { role: 'user', text: 'And forget the other one.' }, { role: 'assistant', text: 'Forgotten too.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, commit.archive_uri)).extraction.forgetRequests.falseClaims, 1);
});

test('a same-session tool receipt from another namespace cannot satisfy a completion claim', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const uri = f.seed('notes/test.md', fact);
  await f.store.remove(f.userId, nativeFileId(uri), { keepText: true });
  await f.overlay.addRevision({ userId: f.userId, uri: 'viking://user/u-other-namespace/memories/notes/test.md', memoryType: 'notes',
    change: 'deleted', actor: 'conversation', reason: 'forgotten in a conversation', before: fact, engineSession: 'dsh-session_cross-scope' });
  const worker = withJudge(f, input => verdict(input));
  const commit = await f.commitConversation('cross-scope', [{ role: 'user', text: 'Forget that project.' }, { role: 'assistant', text: 'Forgotten.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.commit(f.userId, commit.archive_uri)).extraction.forgetRequests.falseClaims, 1);
});

test('restoring one partially forgotten line leaves the other removed lines undoable on the page', options, async t => {
  const f = await fixture(t);
  const second = 'Project N-51744.';
  const uri = f.seed('notes/test.md', `- ${fact}\n- ${second}\n- ${other}`);
  await f.store.forgetLines(f.userId, (await f.store.rawFiles(f.userId))[0], [fact, second]);
  for (const [index, text] of [fact, second].entries()) {
    const forgotten = await f.store.forgotten(f.userId);
    assert.equal(forgotten.length, 2 - index);
    const row = forgotten.find(entry => entry.value === text);
    await f.store.update(f.userId, row.id, { status: 'active', expectedVersion: row.version });
  }
  assert.equal((await f.store.forgotten(f.userId)).length, 0);
  const body = await f.sessions.read(f.userId, uri);
  for (const text of [fact, second, other]) assert.ok(body.includes(text));
});

test('the independent whole-line review preserves a correct line selected by a mistaken first judgement', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const correct = 'The child is in middle school, not primary school.';
  const uri = f.seed('people/child.md', correct);
  let called = 0;
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test', deepseekModel: 'test' },
    callModel: async () => ({ choices: [{ message: { content: JSON.stringify(++called === 1
      ? { requests: [{ message: 0, quote: 'Correct primary school to middle school.', decision: 'remove', targets: [0], intents: [{ message: 0, quote: 'primary school' }] }], claims: [] }
      : { targets: [{ request: 0, candidate: 0, decision: 'keep' }, { request: 0, candidate: 1, decision: 'remove' }] }) } }] }) });
  const worker = new NativeMemoryWorker({ ...f, nativeMemory: f.store, forgetRequestJudge: judge });
  await f.commitConversation('review-veto', [{ role: 'user', text: 'Correct primary school to middle school.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), correct);
  assert.equal(called, 2);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text === 'primary school'));
});

test('both judgements know which document a heading belongs to, and the reviewer sees the complete retained facts', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const body = '# Child\n- The child is in middle school, not primary school.';
  const uri = f.seed('people/child.md', body);
  let called = 0;
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test', deepseekModel: 'test' },
    callModel: async (_deps, request) => {
      const input = JSON.parse(request.body.messages[1].content);
      assert.equal(input.documents[0].title, 'people/child.md');
      let result;
      if (++called === 1) {
        assert.equal(input.candidates[0].document, input.candidates[1].document);
        result = { requests: [{ message: 0, quote: 'Correct primary school to middle school.', decision: 'remove', targets: [0],
          intents: [{ message: 0, quote: 'primary school' }] }], claims: [] };
      } else {
        assert.equal(input.documents[0].body, body);
        assert.equal(input.targets[0].document, input.documents[0].document);
        result = { targets: [{ request: 0, candidate: 0, decision: 'keep' }, { request: 0, candidate: 2, decision: 'remove' }] };
      }
      return { choices: [{ message: { content: JSON.stringify(result) } }] };
    } });
  const worker = new NativeMemoryWorker({ ...f, nativeMemory: f.store, forgetRequestJudge: judge });
  await f.commitConversation('review-heading', [{ role: 'user', text: 'Correct primary school to middle school.' }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), body);
  assert.equal(called, 2);
});

test('an absent intent cannot withdraw the newly correct fact through the rejection path', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const correct = 'The child is in middle school, not primary school.';
  const uri = f.seed('people/child.md', correct);
  let calls = 0;
  const judge = createForgetRequestJudge({ config: { memoryForgetRequestCheckEnabled: true, deepseekApiKey: 'test', deepseekModel: 'test' },
    callModel: async (_deps, request) => {
      const input = JSON.parse(request.body.messages[1].content);
      let result;
      if (++calls === 1) result = { requests: [{ message: 0, quote: correct, decision: 'remove', targets: [],
        intents: [{ message: 0, quote: correct }] }], claims: [] };
      else {
        assert.equal(input.targets[0].kind, 'intent');
        assert.equal(input.targets[0].text, correct);
        result = { targets: input.targets.map(({ request: index, candidate }) => ({ request: index, candidate, decision: 'keep' })) };
      }
      return { choices: [{ message: { content: JSON.stringify(result) } }] };
    } });
  const worker = new NativeMemoryWorker({ ...f, nativeMemory: f.store, forgetRequestJudge: judge });
  const committed = await f.commitConversation('intent-veto', [{ role: 'user', text: correct }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(calls, 2);
  assert.equal(await f.sessions.read(f.userId, uri), correct);
  assert.deepEqual(await f.overlay.removals(f.userId), []);
  const request = (await f.overlay.commit(f.userId, committed.archive_uri)).extraction.forgetRequests.requests[0];
  assert.equal(request.status, 'pending');
  assert.deepEqual(request.intents, []);
});

test('two withdrawals in one original message both apply before that message is deduplicated', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  const targets = [fact, 'Project N-51744.'];
  const worker = withJudge(f, () => ({ requests: targets.map(text => ({ message: 0, quote: `Forget ${text}`,
    decision: 'remove', targets: [], intents: [{ message: 0, quote: text }] })), claims: [] }));
  await f.commitConversation('same-message-intents', [{ role: 'user', text: targets.map(text => `Forget ${text}`).join(' ') }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal((await f.overlay.removals(f.userId)).length, 2);
  assert.equal((await f.store.forgotten(f.userId)).length, 2);
});

test('a stored paraphrase and its original fact share removal authority and undo', options, async t => {
  const f = await fixture(t, { config: { memoryForgetRequestCheckEnabled: true } });
  allowFixtureRestatements(f);
  const original = '我上个月临时替同事值了2次夜班';
  const wrapped = '用户 2026-03-28 提到上个月临时替同事值了 2 次夜班，随后要求忘掉；该条不保留。';
  const uri = f.seed('notes/plan.md', `- ${wrapped}\n- ${other}`);
  const worker = withJudge(f, ({ candidates }) => ({ requests: [{ message: 1, quote: 'Forget that detail.', decision: 'remove',
    targets: candidates.flatMap((row, index) => row.text === wrapped ? [index] : []), intents: [{ message: 0, quote: original }] }], claims: [] }));
  await f.commitConversation('wrapped', [{ role: 'user', text: original, at: old }, { role: 'user', text: 'Forget that detail.', at: old }]);
  await worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, uri), `- ${other}`);
  assert.ok((await f.overlay.removals(f.userId)).some(row => row.text === original));
  const lateUri = `${f.root}/notes/late.md`;
  const respaced = original.replace('2次', '2 次');
  f.stub.extract = () => ({ adds: [{ uri: lateUri, after: respaced }] });
  await f.commitConversation('wrapped-old-again', [{ role: 'user', text: original, at: old }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, lateUri), null);
  await f.commitConversation('wrapped-fresh', [{ role: 'user', text: original, at: fresh }]);
  await f.worker.processCommits({ userId: f.userId });
  assert.equal(await f.sessions.read(f.userId, lateUri), respaced);
  await f.store.undo(f.userId, nativeFileId(uri));
  assert.equal((await f.overlay.removals(f.userId)).length, 0);
  assert.equal((await f.store.forgotten(f.userId)).length, 0);
});
