import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { buildTables, inclusionClauses } from './index_r3.mjs';
import { metrics, rrf } from './recall_r3.mjs';

test('inclusion text keeps unsectioned lines and drops the exclusion section', () => {
  const clauses = inclusionClauses('Inclusion Criteria:\n- Adults with asthma\n- FEV1 below 80%\n\nExclusion Criteria:\n- Pregnancy');
  assert.ok(clauses.some((c) => /asthma/.test(c)));
  assert.ok(!clauses.some((c) => /Pregnancy/.test(c)));
  assert.deepEqual(inclusionClauses('Adults with asthma only.').length, 1);
});

test('buildTables writes one trial row and one row per inclusion criterion, and is idempotent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE documents(id INTEGER PRIMARY KEY, nct_id TEXT, payload BLOB)');
  const p = { nct_id: 'NCT00000001', title: 'T', condition: 'C', summary: 's', eligibility: 'Inclusion Criteria:\n- one\n- two\n\nExclusion Criteria:\n- three' };
  db.prepare('INSERT INTO documents VALUES (1, ?, ?)').run(p.nct_id, deflateSync(Buffer.from(JSON.stringify(p))));
  const first = buildTables({ source: db, target: db });
  assert.equal(first.trials, 1);
  assert.equal(first.criteria, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM terms_c WHERE terms_c MATCH 'three'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM terms_b WHERE terms_b MATCH 'three'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM terms_b WHERE terms_b MATCH 'two'").get().n, 1);
  assert.equal(buildTables({ source: db, target: db }).criteria, 2);
});

test('metrics and RRF', () => {
  const q = new Map([['A', 2], ['B', 1], ['C', 0], ['D', 2]]);
  const m = metrics(['A', 'X', 'D'], q, [2]);
  assert.equal(m.eligR2, 0.5);
  assert.equal(m.relR500, 2 / 3);
  assert.deepEqual(rrf([[1, 2], [2, 3]]).slice(0, 1), [2]);
});
