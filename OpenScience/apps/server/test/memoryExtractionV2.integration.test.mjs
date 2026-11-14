// Model responses are recorded format fixtures. Client -> worker -> real overlay -> page/read parsers are not mocked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { nativeMemoryCounters } from '../src/nativeMemoryMetrics.mjs';
import { observationWords, conversationsThatWrote } from '../src/nativeMemoryObservations.mjs';
import { lineFingerprint, memoryLines } from '../src/nativeMemoryOverlay.mjs';
import { projectCardRows } from '../src/nativeMemoryStore.mjs';
import { projectCardMemo } from '../src/residentProfile.mjs';
import { openingProfileRead } from '../src/memoryOpeningByUse.mjs';
import { capsuleFactMemos } from '../src/capsuleProfile.mjs';
import { safetyNoteLines } from '../src/memorySafetyNotes.mjs';
import { replaceStatement } from '../src/nativeMemoryVerification.mjs';
import { removalLines } from '../src/nativeMemoryRejections.mjs';

const { options, fixture } = nativeIntegration();
const candidate = { memoryTemplatesDirectory: 'memory-templates-extraction-v2' };
for (const name of ['attribution', 'history', 'numeric-choice']) test(`${name}: recorded conversations through the write ledger and real readers`, options, async t => {
  const recorded = JSON.parse(readFileSync(new URL(`./fixtures/memory-extraction-v2/${name}.json`, import.meta.url), 'utf8'));
  let stage = 0;
  const prior = new Map();
  const f = await fixture(t, { config: candidate, extract: ({ user }) => {
    const adds = [], updates = [];
    for (const [path, after] of Object.entries(recorded.sessions[stage].writes)) {
      const uri = `viking://user/${user}/memories/${path}`;
      if (prior.has(path)) updates.push({ uri, before: prior.get(path), after });
      else adds.push({ uri, after });
      prior.set(path, after);
    }
    return { adds, updates };
  } });
  for (const session of recorded.sessions) {
    const commit = await f.commitConversation(session.id, session.messages, { projectId: 'fern' });
    await f.worker.processCommits({ userId: f.userId });
    assert.equal((await f.overlay.commit(f.userId, commit.archive_uri))?.state, 'completed', `${session.id}: write ledger settled`);
    for (const [path, body] of Object.entries(session.writes)) assert.equal(await f.sessions.read(f.userId, `${f.root}/${path}`), body);
    if (name === 'history') {
      const project = (await f.store.records(f.userId)).find(record => record.uri === `${f.root}/projects/fern.md`);
      assert.ok(project, `${session.id}: project file reaches the real store`);
      assert.equal(project.scopeId, 'fern');
      assert.equal(project.value, session.writes['projects/fern.md']);
      const rows = await f.store.projectCard(f.userId, 'fern');
      assert.ok(rows.some(row => row.slot === 'constraints'));
      const memo = projectCardMemo('fern', rows);
      assert.ok(memo, `${session.id}: project card is readable`);
      for (const line of memoryLines(session.writes['projects/fern.md'])) assert.ok(memo.content.includes(line));
    }
    stage++;
  }
  const records = await f.store.records(f.userId);
  if (name === 'attribution') {
    assert.equal(nativeMemoryCounters().noteLabels.missing_label, 0);
    assert.equal(nativeMemoryCounters().noteLabels.checked, 2);
    assert.match(records[0].value, /助手建议（未采纳）：/);
  } else if (name === 'history') {
    const body = prior.get('profile.md');
    const historical = 'earlier: Greenhouse setting: 18 °C (until 2026-11-02)';
    assert.equal(records.filter(record => record.nativeType === 'profile').length, 3);
    assert.ok(records.some(record => record.value === historical));
    assert.equal(openingProfileRead(body, f.root, {}), body);
    assert.ok(capsuleFactMemos([{ id: 'test', factKind: 'profile', content: body }])[0].content.includes(historical));
    assert.ok(safetyNoteLines(`## History [evimed-safety-notes]\n${body.split('\n').slice(1).join('\n')}`, 'people').includes(historical));
    const card = projectCardMemo('fern', projectCardRows(records, 'fern'));
    assert.ok(card, 'the project reader returns a card with dated history');
    assert.ok(card.content.includes(historical));
    assert.ok(removalLines(body).includes(historical));
    assert.notEqual(lineFingerprint(historical), lineFingerprint('Greenhouse setting: 18 °C'));
    const fixed = replaceStatement(body, lineFingerprint('Greenhouse setting: 22 °C'), 'Greenhouse setting: 23 °C');
    assert.ok(fixed.includes(historical));
    assert.ok(memoryLines(fixed).some(line => line.includes('23 °C')));
  } else {
    const uri = `${f.root}/observations/weekly_140.md`;
    const revisions = await f.overlay.revisionsOf(f.userId, uri);
    const conversations = await conversationsThatWrote(revisions, revision => f.overlay.conversationOf(f.userId, revision.engineSession, revision.archiveUri));
    assert.equal(conversations.size, 2);
    assert.match(observationWords(prior.get('observations/weekly_140.md')), /140 字/);
  }
});

test('the opt-in worker counts missing labels, preserves bytes and marks sensitive files; the default does neither', options, async t => {
  const body = '# Notes\n- 用户观点（敏感）：某政治立场。（记录日期 2026-11-01）\n- 未标注的陈述';
  for (const enabled of [false, true]) {
    const f = await fixture(t, { config: enabled ? candidate : {}, extract: ({ user }) => ({ adds: [{ uri: `viking://user/${user}/memories/notes/stance.md`, after: body }] }) });
    await f.commitConversation(`sensitive_${enabled}`, [{ role: 'user', text: '我认为某政治立场值得支持。', at: '2026-11-01T08:00:00Z' }]);
    await f.worker.processCommits({ userId: f.userId });
    const uri = `${f.root}/notes/stance.md`;
    assert.equal(await f.sessions.read(f.userId, uri), body);
    assert.equal((await f.overlay.file(f.userId, uri)).sensitive, enabled);
    assert.equal(nativeMemoryCounters().noteLabels.missing_label, enabled ? 1 : 0);
    assert.equal((await f.overlay.sensitiveUris(f.userId)).includes(uri), enabled);
    await f.worker.processCommits({ userId: f.userId });
    assert.equal(nativeMemoryCounters().noteLabels.checked, enabled ? 2 : 0, 'settled writes are not counted twice');
  }
});
