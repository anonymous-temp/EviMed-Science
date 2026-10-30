import assert from 'node:assert/strict';
import test from 'node:test';

import { VCR_DATA_INTAKE_CONTRACT } from '../src/vcrDataIntake.mjs';
import { createVcrUploadReceipts } from '../src/vcrUploadReceipts.mjs';

function receipts() {
  const writes = [];
  const puts = [];
  const documents = {
    get: async () => null,
    put: async (userId, kind, id, payload, options) => { puts.push({ userId, kind, id, payload, options }); },
  };
  const kept = createVcrUploadReceipts({ documents, sources: null, write: async (project, relative, bytes) => { writes.push({ project: project.id, relative, bytes }); } });
  return { kept, writes, puts };
}

const project = { id: 'p1', userId: 'u1', baseDir: '/nonexistent' };

test('only a file the data intake can import is kept as an original upload', async () => {
  const { kept, writes, puts } = receipts();
  const table = await kept.record(project, { name: 'cases/baseline.CSV', bytes: Buffer.from('id,age\n1,62\n'), sessionId: 's1' });
  assert.match(table?.sourceId ?? '', /^upl_/);
  assert.equal(writes.length, 1);
  assert.match(writes[0].relative, /^\.evimed-upload-originals\/[0-9a-f]{64}\/baseline\.CSV$/);
  assert.equal(puts.length, 1);

  for (const name of ['report.pdf', 'slides.pptx', 'photo.png', 'notes.txt', 'no-extension']) {
    assert.equal(await kept.record(project, { name, bytes: Buffer.from('x'), sessionId: 's1' }), null, name);
  }
  assert.equal(writes.length, 1, 'an attachment the intake cannot read is not copied a second time');
});

test('an upload larger than the intake reads is not kept', async () => {
  const { kept, writes } = receipts();
  const bytes = Buffer.alloc(VCR_DATA_INTAKE_CONTRACT.import.maxBytes + 1, 0x61);
  assert.equal(await kept.record(project, { name: 'big.csv', bytes, sessionId: 's1' }), null);
  assert.equal(writes.length, 0);
});
