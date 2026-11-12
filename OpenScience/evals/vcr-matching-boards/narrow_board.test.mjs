import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { keptInPreparedOrder, narrowBoard } from './narrow_board.mjs';

test('what is kept is the reranker\'s first N, named in the prepared order', () => {
  assert.deepEqual(keptInPreparedOrder(['a', 'b', 'c', 'd'], ['d', 'b', 'a', 'c'], 2), ['b', 'd']);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-'));
  const collection = path.join(root, 'boards', 'collections', 'c1');
  fs.mkdirSync(collection, { recursive: true });
  const db = new DatabaseSync(path.join(collection, 'c1.sqlite'));
  db.exec('CREATE TABLE documents(nct_id TEXT, payload BLOB)');
  const insert = db.prepare('INSERT INTO documents VALUES (?, ?)');
  for (const id of ['NCT1', 'NCT2', 'NCT3']) insert.run(id, deflateSync(JSON.stringify({ title: `Trial ${id}`, condition: 'Asthma\nCough', eligibility: 'Adults' })));
  db.close();
  fs.writeFileSync(path.join(collection, 'collection.json'), JSON.stringify({ databasePath: 'c1.sqlite' }));
  fs.mkdirSync(path.join(root, 'boards', 'B-nih'));
  fs.writeFileSync(path.join(root, 'boards', 'B-nih', 'cases.jsonl'), `${JSON.stringify({ patientId: 'p1', caseId: 'p1', split: 'test', note: 'A note.', collection: 'c1', candidateIds: ['NCT1', 'NCT2', 'NCT3'], candidateCount: 3 })}\n`);
  fs.writeFileSync(path.join(root, 'boards', 'manifest.json'), JSON.stringify({ inputsDigest: 'd' }));
  for (const name of ['key', 'dash']) fs.writeFileSync(path.join(root, name), 'k');
  return root;
}

const chat = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ condition: 'asthma', terms: ['asthma'], summary: 'Adult with asthma.' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a board comes out narrowed, and a second run asks nothing again', async () => {
  const root = fixture();
  let reranks = 0, chats = 0;
  const rerankFetch = /** @type {typeof fetch} */ (async () => {
    reranks += 1;
    return new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.1 }], usage: { total_tokens: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const options = { boards: path.join(root, 'boards'), board: /** @type {'nih'} */ ('nih'), out: path.join(root, 'out'), top: 2, split: 'all', keyFile: path.join(root, 'key'), dashscopeKeyFile: path.join(root, 'dash'),
    model: 'deepseek-flash', rerankModel: 'qwen3-rerank', baseUrl: 'http://provider.test', rerankUrl: 'http://rerank.test/reranks', concurrency: 1, spendLedger: null };
  const deps = { fetchImpl: /** @type {typeof fetch} */ (async () => { chats += 1; return chat(); }), rerankFetch, log: () => {} };
  const first = await narrowBoard(options, deps);
  assert.deepEqual(first, { written: true, patients: 1, pairs: 2, failed: [] });
  const row = JSON.parse(fs.readFileSync(path.join(root, 'out', 'B-nih', 'cases.jsonl'), 'utf8'));
  assert.deepEqual(row.candidateIds, ['NCT1', 'NCT3']);
  assert.equal(row.candidateCount, 2);
  assert.ok(fs.existsSync(path.join(root, 'out', 'collections', 'c1', 'collection.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'out', 'manifest.json'), 'utf8'));
  assert.equal(manifest.inputsDigest, 'd');
  assert.deepEqual(manifest.narrowed, { from: 'd', board: 'B-nih', top: 2, by: 'qwen3-rerank' });
  await narrowBoard(options, deps);
  assert.equal(chats, 1);
  assert.equal(reranks, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
