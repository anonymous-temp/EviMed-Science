import assert from 'node:assert/strict';
import test from 'node:test';

import { VCR_DATA_INTAKE_CONTRACT } from '../src/vcrDataIntake.mjs';
import { createVcrUploadReceipts, VCR_PATIENT_CONTEXT_MAX_BYTES, VCR_PATIENT_RECORD_MAX_BYTES } from '../src/vcrUploadReceipts.mjs';

function receipts() {
  const writes = [];
  const puts = [];
  const documents = {
    get: async (_userId, _kind, id) => { const row = puts.find((entry) => entry.id === id); return row ? { id, projectId: 'p1', payload: row.payload } : null; },
    put: async (userId, kind, id, payload, options) => { puts.push({ userId, kind, id, payload, options }); },
  };
  const kept = createVcrUploadReceipts({ documents, sources: null, write: async (project, relative, bytes) => { writes.push({ project: project.id, relative, bytes }); } });
  return { kept, writes, puts };
}

const project = { id: 'p1', userId: 'u1', baseDir: '/nonexistent' };

test('tables, patient records and archives are kept as originals; what no intake reads is not', async () => {
  const { kept, writes, puts } = receipts();
  const table = await kept.record(project, { name: 'cases/baseline.CSV', bytes: Buffer.from('id,age\n1,62\n'), sessionId: 's1' });
  assert.match(table?.sourceId ?? '', /^upl_/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].relative, /^\.evimed-upload-originals\/[0-9a-f]{64}\/baseline\.CSV$/);
  assert.equal(puts.length, 1);

  for (const name of ['slides.pptx', 'clip.mp4', 'no-extension']) {
    assert.equal(await kept.record(project, { name, bytes: Buffer.from('x'), sessionId: 's1' }), null, name);
  }
  assert.equal(writes.length, 1, 'an attachment no intake reads is not copied a second time');
  assert.equal(await kept.record(project, { name: 'invalid.txt', bytes: Buffer.from([0xc3, 0x28]) }), null);
  assert.equal(await kept.record(project, { name: 'empty.md', bytes: Buffer.from('   ') }), null);
  assert.equal(await kept.record(project, { name: 'large.txt', bytes: Buffer.alloc(VCR_PATIENT_CONTEXT_MAX_BYTES + 1, 0x61) }), null);
  const patient = await kept.record(project, { name: 'notes.MD', bytes: Buffer.from('Patient text'), sessionId: 's1' });
  assert.match(patient?.sourceId ?? '', /^upl_/);
  assert.equal(puts[1].payload.intake, 'patient_context');
  // A record as a PDF, a Word file or a picture of a page is a patient's record too, and a zip of them a batch.
  for (const name of ['discharge.pdf', 'note.docx', 'page.PNG', 'fax.tiff']) {
    assert.match((await kept.record(project, { name, bytes: Buffer.from(`bytes of ${name}`), sessionId: 's1' }))?.sourceId ?? '', /^upl_/, name);
    assert.equal(puts.at(-1).payload.intake, 'patient_context', name);
  }
  await kept.record(project, { name: 'notes.zip', bytes: Buffer.from('PK'), sessionId: 's1' });
  assert.equal(puts.at(-1).payload.intake, 'notes_archive');
  assert.equal(await kept.get('u1', puts.at(-1).id), null, 'a patient original is never a table for the plain import');
});

test('an upload larger than any intake reads is not kept, and a table of notes may be far larger than a table of values', async () => {
  const { kept, writes } = receipts();
  const past = Buffer.alloc(VCR_DATA_INTAKE_CONTRACT.import.maxBytes + 1, 0x61);
  assert.equal(await kept.record(project, { name: 'big.json', bytes: past, sessionId: 's1' }), null);
  assert.equal(writes.length, 0);
  assert.match((await kept.record(project, { name: 'notes.csv', bytes: past, sessionId: 's1' }))?.sourceId ?? '', /^upl_/);
  assert.equal(await kept.record(project, { name: 'scan.pdf', bytes: Buffer.alloc(VCR_PATIENT_RECORD_MAX_BYTES + 1), sessionId: 's1' }), null);
});
