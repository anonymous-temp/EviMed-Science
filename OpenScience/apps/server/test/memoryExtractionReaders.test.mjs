import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectCardRows } from '../src/nativeMemoryStore.mjs';
import { memoryLines, lineFingerprint } from '../src/nativeMemoryOverlay.mjs';
import { removalLines } from '../src/nativeMemoryRejections.mjs';
import { replaceStatement } from '../src/nativeMemoryVerification.mjs';
import { openingProfileRead } from '../src/memoryOpeningByUse.mjs';
import { capsuleFactMemos } from '../src/capsuleProfile.mjs';
import { safetyNoteLines } from '../src/memorySafetyNotes.mjs';
import { observationWords, conversationsThatWrote } from '../src/nativeMemoryObservations.mjs';
import { projectCardMemo } from '../src/residentProfile.mjs';
const A = 'project_fern';

test('project study elements retain adjacent dated history without reading it as the current population', () => {
  const rows = projectCardRows([{ nativeType: 'project_context', scopeId: A, id: 'r', updatedAt: null,
    value: '## 研究要素\n- 人群：成人 ≥18 岁\n- 曾为：人群：成人 ≥40 岁（截至 2026-11-02）\n- 曾为：人群：成人 ≥60 岁（截至 2026-11-01）' }], A);
  assert.equal(rows.find(row => row.slot === 'population').text,
    '成人 ≥18 岁；曾为：成人 ≥40 岁（截至 2026-11-02）；曾为：成人 ≥60 岁（截至 2026-11-01）');
});

test('the project field keeps its earlier dated value beside its current value', () => {
  const rows = projectCardRows([{ nativeType: 'project_context', scopeId: A, id: 'r', updatedAt: null,
    value: '# Study\nField: cardiology\n- earlier: Field: pharmacy (until 2026-11-02)' }], A);
  assert.equal(rows[0].text, 'cardiology；earlier: pharmacy (until 2026-11-02)');
});


test('recorded history survives opening, capsule, safety, page statements and single-line verification', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-extraction-v2/history.json', import.meta.url), 'utf8'));
  const writes = fixture.sessions.at(-1).writes;
  const body = writes['profile.md'];
  const historical = 'earlier: Greenhouse setting: 18 °C (until 2026-11-02)';
  assert.equal(memoryLines(body).length, 3);
  assert.ok(memoryLines(body).includes(historical));
  assert.equal(openingProfileRead(body, 'viking://user/test/memories', {}), body);
  assert.ok(capsuleFactMemos([{ id: 'test', factKind: 'profile', content: body }])[0].content.includes(historical));
  assert.ok(safetyNoteLines(`## History [evimed-safety-notes]\n${body.split('\n').slice(1).join('\n')}`, 'people').includes(historical));
  const rows = projectCardRows([{ id: 'fern', nativeType: 'project_context', scopeId: A, value: writes['project_context/fern.md'], updatedAt: null }], A);
  assert.ok(projectCardMemo(A, rows).content.includes(historical));
  assert.ok(removalLines(body).includes(historical));
  assert.notEqual(lineFingerprint(historical), lineFingerprint('Greenhouse setting: 18 °C'));
  const fixed = replaceStatement(body, lineFingerprint('Greenhouse setting: 22 °C'), 'Greenhouse setting: 23 °C');
  assert.ok(fixed.includes(historical));
  assert.ok(memoryLines(fixed).some(line => line.includes('23 °C')));
});

test('two recorded numeric choices survive the observation reader and conversation counting', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-extraction-v2/numeric-choice.json', import.meta.url), 'utf8'));
  const body = fixture.sessions.at(-1).writes['observations/weekly_140.md'];
  assert.match(observationWords(body), /140 字/);
  const revisions = fixture.sessions.map(session => ({ actor: 'engine', change: 'added', engineSession: session.id }));
  assert.equal((await conversationsThatWrote(revisions, async revision => revision.engineSession)).size, 2);
});
