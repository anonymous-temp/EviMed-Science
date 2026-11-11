import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordedIds, serialJsonlWriter } from '../experiments/pasted-recording.mjs';

test('concurrent large Unicode evidence records remain whole, ordered and parseable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pasted-recording-'));
  try {
    const file = path.join(directory, 'rows.jsonl'), append = serialJsonlWriter(file);
    const text = '來源'.repeat(150000);
    await Promise.all(Array.from({ length: 12 }, (_, id) => append({ id: String(id), text })));
    const rows = (await readFile(file, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 12);
    assert.deepEqual(rows.map(row => Number(row.id)), Array.from({ length: 12 }, (_, id) => id));
    assert.ok(rows.every(row => row.text === text));
    assert.deepEqual([...await recordedIds(file)], Array.from({ length: 12 }, (_, id) => String(id)));
    await appendFile(file, '{"id":"torn');
    await assert.rejects(recordedIds(file), /evidence_last_record_incomplete/);
    assert.equal((await recordedIds(path.join(directory, 'not-started.jsonl'))).size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
