import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { exportDossiers } from '../run/dossier.mjs';
import { scoreRun } from '../run/score.mjs';

test('dossiers bind repeated plant IDs to their case and retain complete raw evidence at the scorer checkpoint', async t => {
  const root = await mkdtemp(path.resolve('.dossier-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run'), data = path.join(root, 'data');
  const put = async (file, value, lines = false) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, lines ? value.map(v => JSON.stringify(v) + '\n').join('') : JSON.stringify(value)); };
  await put(path.join(run, 'run.json'), { runId: 'r', set: 'synthetic-users', split: 'dev' });
  for (const caseId of ['A', 'B']) {
    await put(path.join(data, 'dev', caseId, 'gold.json'), { userId: caseId, questions: [{ qid: 'q', question: 'Recall?', checkpoint: 1, expect: { mustContain: [caseId] } }], store: [{ plantId: 'x', current: caseId, expectStored: true, checkpoint: 1 }] });
    await put(path.join(data, 'dev', caseId, 'input.json'), { sessions: [{ sessionId: 's001', messages: [{ role: 'user', text: caseId }] }] });
    await put(path.join(run, 'cases', caseId, 'answers.jsonl'), [{ caseId, qid: 'q', question: 'Recall?', answer: 'wrong', opening: { profileBlock: 'entire profile' }, toolCalls: [{ name: 'search', args: { query: caseId }, blocks: ['FULL ' + 'x'.repeat(30000)] }] }], true);
    await put(path.join(run, 'cases', caseId, 'snapshots/1.json'), { afterSession: 1, files: {} });
    await put(path.join(run, 'cases', caseId, 'snapshots/2.json'), { afterSession: 2, files: { 'later.md': caseId } });
    await put(path.join(run, 'cases', caseId, 'ingest.jsonl'), [{ sessionId: 's001', caseId }], true);
  }
  await scoreRun({ run, data, noJudge: true });
  const out = path.join(root, 'dossiers');
  const result = await exportDossiers({ run, data, out });
  assert.ok(result.length >= 2);
  for (const item of result) {
    const pack = JSON.parse(await readFile(item.path, 'utf8'));
    assert.equal(pack.gold.caseId, pack.key.caseId);
    assert.equal(pack.gold.definition.userId, pack.key.caseId);
    assert.equal(pack.snapshot.afterSession, 1);
    assert.ok(pack.sourceSessions.length); assert.equal(pack.ingest[0].caseId, pack.key.caseId);
    if (pack.key.kind === 'answer') assert.equal(pack.answer.toolCalls[0].blocks[0].length, 30005);
  }
  // A forged case on an answer record is evidence corruption, never another user's evidence pack.
  await put(path.join(run, 'cases/A/answers.jsonl'), [{ caseId: 'B', qid: 'q', answer: 'wrong' }], true);
  await assert.rejects(exportDossiers({ run, data, out }), /answer_case_mismatch/);
});
test('sealed path components and symlink targets are refused before reading', async t => {
  const root = await mkdtemp(path.resolve('.sealed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'sealed-data'));
  await symlink(path.join(root, 'sealed-data'), path.join(root, 'alias'));
  for (const data of [path.join(root, 'sealed-data'), path.join(root, 'alias')]) {
    await assert.rejects(exportDossiers({ run: root, data, out: path.join(root, 'out') }), /sealed_path_forbidden/);
  }
});
test('allow-sealed is explicit and permits a development dataset stored under a sealed-named path', async t => {
  const root = await mkdtemp(path.resolve('.dossier-allow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run'), data = path.join(root, 'sealed-data'), out = path.join(root, 'out');
  await mkdir(path.join(data, 'dev/A'), { recursive: true }); await mkdir(path.join(run, 'scores-custom'), { recursive: true });
  await writeFile(path.join(run, 'run.json'), JSON.stringify({ runId: 'r', set: 'synthetic-users', split: 'dev' }));
  await writeFile(path.join(data, 'dev/A/gold.json'), JSON.stringify({ userId: 'A', questions: [] }));
  await writeFile(path.join(run, 'scores-custom/rows.jsonl'), JSON.stringify({ runId: 'r', caseId: 'A', kind: 'answer', id: 'q', verdict: 'unobserved' }) + '\n');
  const result = await exportDossiers({ run, data, out, allowSealed: true });
  assert.equal(result.length, 1);
  const pack = JSON.parse(await readFile(result[0].path, 'utf8'));
  assert.ok(pack.missingRecords.includes('answer-record'));
});
