import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findings } from './incidents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('a saved judgment is held to its expectations', () => {
  const expect = { fit: { min: 50 }, verdictNot: ['ineligible'], clauses: [{ contains: 'ECOG', labels: ['not enough information'] }, { contains: 'egfr', labels: ['included'], evidence: true }] };
  const good = { fit: 70, verdict: 'possible', criteria: [{ clause: 'ECOG 0 or 1', label: 'not enough information', sentenceIds: [] }, { clause: 'EGFR mutation', label: 'included', sentenceIds: [2] }] };
  assert.deepEqual(findings(expect, good), []);
  assert.deepEqual(findings(expect, null), ['no judgment saved']);
  const bad = { fit: 40, verdict: 'ineligible', criteria: [{ clause: 'ECOG 0 or 1', label: 'not included', sentenceIds: [] }, { clause: 'EGFR mutation', label: 'included', sentenceIds: [] }] };
  assert.deepEqual(findings(expect, bad), ['fit 40 is below 50', 'verdict ineligible', '"ECOG": not included, wanted not enough information', '"egfr": no sentence behind it']);
  assert.deepEqual(findings({ clauses: [{ contains: 'stroke', labels: ['excluded'] }] }, { fit: 1, criteria: [] }), ['no clause holds "stroke"']);
});

test('the cases are well formed and name only closed labels', () => {
  const labels = new Set(['included', 'not included', 'excluded', 'not excluded', 'not applicable', 'not enough information']);
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, 'incidents.json'), 'utf8'));
  assert.ok(cases.length >= 15);
  assert.equal(new Set(cases.map((/** @type {any} */ one) => one.id)).size, cases.length);
  for (const one of cases) {
    assert.match(one.id, /^[a-z0-9-]{1,40}$/);
    assert.ok(one.note && one.source && one.trial?.raw_criteria, one.id);
    assert.ok(one.expect.fit || one.expect.clauses?.length || one.expect.verdict, one.id);
    for (const clause of one.expect.clauses ?? []) {
      assert.ok(one.trial.raw_criteria.toLowerCase().includes(clause.contains.toLowerCase()), `${one.id}: ${clause.contains}`);
      for (const label of clause.labels) assert.ok(labels.has(label), `${one.id}: ${label}`);
    }
  }
});
