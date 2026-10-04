/**
 * What the module's audit rows may hold. The audit table outlives the study it
 * describes (deleting a study removes its rows and its pseudonym key and leaves
 * the audit), so a row that carries a person's file name, an example cell of a
 * patient's table, or a reviewer's free-text note about a candidate keeps that
 * after the study — and the plane's own deletion — is gone.
 *
 * The stores run here over a scripted database: every statement a write issues
 * is answered from a table, and the audit insert is captured whole. The
 * integration suites cover the same writes against PostgreSQL; what they cannot
 * say is what the row held, which is this file's question.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisTableIssues, refusedTableAuditDetail, uploadAttemptAuditDetail, uploadAuditDetail,
} from '../src/vcrDataPlane.mjs';
import { VcrDataStore } from '../src/vcrDataStore.mjs';
import { VcrMatchStore } from '../src/vcrMatchStore.mjs';

const NAME = '张三-住院病历 2024.pdf';
const NOTE = '患者李四电话 13800000000，家属不同意随访';

/** A database whose statements are answered from `handlers` and whose audit inserts are kept whole. @param {[RegExp, any][]} handlers */
function scripted(handlers) {
  /** @type {any[]} */
  const audits = [];
  const client = {
    async query(sql, values = []) {
      if (/SET LOCAL statement_timeout/.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO evimed_vcr\.audit/.test(sql)) {
        audits.push({ studyId: values[0], actor: values[2], action: values[3], object: values[4], outcome: values[5], reason: values[6], detail: JSON.parse(values[7]) });
        return { rows: [], rowCount: 1 };
      }
      for (const [pattern, answer] of handlers) if (pattern.test(sql)) return typeof answer === 'function' ? answer(sql, values) : answer;
      throw new Error(`unscripted statement: ${sql.replace(/\s+/g, ' ').slice(0, 100)}`);
    },
  };
  return { audits, database: { transaction: async fn => fn(client), query: client.query } };
}
const noMigration = store => { store.ready = async () => {}; return store; };
/** No part of the audit rows may hold what a person typed or what a record said. @param {any[]} audits @param {string[]} secrets */
const assertNone = (audits, secrets) => {
  const text = JSON.stringify(audits);
  for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} reached an audit row: ${text}`);
};

test('a stored file is audited by id, role, format, size and hash, never by its name', async () => {
  const row = { id: 'sfl_1', source_id: 'src_1', study_id: 'std_1', user_id: 'owner', role: 'data', name: NAME, format: 'csv', location: 'studies/std_1/sources/src_1/x.csv', sha256: 'ab'.repeat(32), bytes: 123 };
  const { audits, database } = scripted([[/INSERT INTO evimed_vcr\.source_files/, { rows: [row], rowCount: 1 }]]);
  const store = noMigration(new VcrDataStore({ database }));
  const { created } = await store.addSourceFile({ sourceId: 'src_1', studyId: 'std_1', userId: 'owner', role: 'data', name: NAME, format: 'csv', location: row.location, sha256: row.sha256, bytes: 123, rowCount: 5, columnCount: 3 });
  assert.equal(created, true);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'source.file');
  assert.deepEqual(audits[0].detail, { sourceId: 'src_1', role: 'data', format: 'csv', bytes: 123, sha256: row.sha256, rowCount: 5, columnCount: 3 });
  assertNone(audits, ['张三', NAME]);
});

test('removing a file audits its id, role and hash, and the name goes with the file', async () => {
  const row = { id: 'sfl_1', source_id: 'src_1', study_id: 'std_1', user_id: 'owner', role: 'document', name: NAME, format: 'txt', sha256: 'cd'.repeat(32), bytes: 9 };
  const { audits, database } = scripted([
    [/SELECT \* FROM evimed_vcr\.source_files/, { rows: [row], rowCount: 1 }],
    [/FROM evimed_vcr\.snapshots/, { rows: [], rowCount: 0 }],
    [/DELETE FROM evimed_vcr\.source_files/, { rows: [], rowCount: 1 }],
  ]);
  const store = noMigration(new VcrDataStore({ database }));
  const { removed } = await store.deleteSourceFile({ studyId: 'std_1', fileId: 'sfl_1', actor: 'owner' });
  assert.equal(removed?.id, 'sfl_1');
  assert.deepEqual(audits.map(entry => [entry.action, entry.detail]), [['source.file.remove', { sourceId: 'src_1', role: 'document', sha256: row.sha256 }]]);
  assertNone(audits, ['张三', NAME]);
});

test('a reviewer\'s override keeps the note on the judgment row and out of the audit row, which says only that there is one', async () => {
  const { audits, database } = scripted([
    // The update also reads FROM the assessments table, so it is matched first.
    [/^\s*UPDATE evimed_vcr\.criterion_judgments j/, (sql, values) => ({ rows: [{ id: 'jdg_1', assessment_id: 'mas_1', criterion_id: 'crt_1', state: 'satisfied', override_state: values[2], override_note: values[4] }], rowCount: 1 })],
    [/^\s*SELECT \* FROM evimed_vcr\.matching_assessments/, { rows: [{ id: 'mas_1', study_id: 'std_1' }], rowCount: 1 }],
    [/^\s*SELECT \* FROM evimed_vcr\.criterion_judgments WHERE/, { rows: [{ criterion_id: 'crt_1', state: 'satisfied' }], rowCount: 1 }],
  ]);
  const store = noMigration(new VcrMatchStore({ database }));
  store.captureCorrectionCase = async () => ({ caseId: 'case_1', inputDigest: 'f'.repeat(64) });
  const judgment = await store.overrideJudgment({ assessmentId: 'mas_1', criterionId: 'crt_1', state: 'not_satisfied', by: 'reviewer', note: NOTE, userId: 'owner', studyId: 'std_1' });
  assert.equal(judgment?.overrideNote, NOTE, 'the note is kept where it belongs: on the judgment, which goes with the study');
  assert.deepEqual(audits.map(entry => [entry.action, entry.detail]), [['vcr.judgment.override', { state: 'not_satisfied', noted: true, evaluationCase: { caseId: 'case_1', inputDigest: 'f'.repeat(64) } }]]);
  assertNone(audits, ['李四', '13800000000', '家属']);

  // No note, no claim of one.
  audits.length = 0;
  await store.overrideJudgment({ assessmentId: 'mas_1', criterionId: 'crt_1', state: 'satisfied', by: 'reviewer', note: '  ', userId: 'owner', studyId: 'std_1' });
  assert.equal(audits[0].detail.noted, false);
});

test('a contact approval keeps the coordinator\'s note on the referral\'s event row and out of the audit row', async () => {
  const { audits, database } = scripted([
    [/FROM evimed_vcr\.referrals WHERE id = \$1 AND study_id = \$2 FOR UPDATE/, { rows: [{ id: 'ref_1', study_id: 'std_1', state: 'contactable', contact_approved_by: null }], rowCount: 1 }],
    [/UPDATE evimed_vcr\.referrals SET contact_approved_by/, { rows: [{ id: 'ref_1', study_id: 'std_1', state: 'contactable', contact_approved_by: 'coordinator' }], rowCount: 1 }],
  ]);
  const store = noMigration(new VcrMatchStore({ database }));
  const referral = await store.approveContact({ referralId: 'ref_1', studyId: 'std_1', approvedBy: 'coordinator', userId: 'owner', note: NOTE });
  assert.equal(referral?.contactApprovedBy, 'coordinator');
  assert.deepEqual(audits.map(entry => [entry.action, entry.detail]), [['vcr.referral.contact_approved', { noted: true }]]);
  assertNone(audits, ['李四', '13800000000', '家属']);
});

test('what an audit line may say of an upload is a role, a format, a size and a hash from closed shapes, and nothing a caller typed', () => {
  const sha256 = '0123456789abcdef'.repeat(4);
  assert.equal(uploadAuditDetail({ upload: { role: 'document', format: 'pdf', bytes: 10, sha256 }, file: { name: NAME } }), `document pdf 10B sha256:${sha256}`);
  assert.equal(uploadAuditDetail({ file: { role: 'data', format: 'csv', detail: { originalBytes: 7, originalSha256: sha256 } } }), `data csv 7B sha256:${sha256}`);
  assert.equal(uploadAuditDetail({ file: { role: 'document', format: 'txt', detail: { original: { format: 'docx' }, originalBytes: 1 } } }), 'document docx 1B');
  // Anything outside its shape is dropped, not passed through.
  assert.equal(uploadAuditDetail({ upload: { role: NAME, format: NAME, bytes: NAME, sha256: NAME } }), '');
  assert.equal(uploadAuditDetail({ upload: { role: 'document', format: '张三', bytes: 1.5, sha256: 'ZZ' } }), 'document');
  assert.equal(uploadAuditDetail(null), '');
  assert.equal(uploadAttemptAuditDetail('dictionary', 2048), 'dictionary 2048B declared');
  assert.equal(uploadAttemptAuditDetail('dictionary', null), 'dictionary');
  assert.equal(uploadAttemptAuditDetail(NAME, 'x'), 'other');
  assert.equal(uploadAttemptAuditDetail(undefined, -1), 'other');
});

test('a refused analysis table is audited by its defects and counts, never by the cells that showed them', () => {
  // A raw value that is not a censoring indicator, in a column a person filled by hand.
  const rows = [
    { USUBJID: 'P0123456789abcdef', PARAMCD: 'OS', AVAL: 12, CNSR: '李四' },
    { USUBJID: 'P0123456789abcde0', PARAMCD: 'OS', AVAL: -3, CNSR: 'yes' },
  ];
  const issues = analysisTableIssues('events', rows);
  const blocking = issues.filter(issue => issue.blocking);
  assert.ok(blocking.some(issue => issue.examples.includes('李四')), 'the caller is told the example in the refusal itself');
  const detail = refusedTableAuditDetail('events', blocking);
  assert.equal(detail.shape, 'events');
  assert.ok(detail.issues.length >= 1 && detail.issues.every(item => Object.keys(item).sort().join() === 'column,issue,rows'));
  assertNone([detail], ['李四', 'yes', 'P0123456789abcdef', '-3']);
});
