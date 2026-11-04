import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cloneFileNoFollow, openScopedFileNoFollow, resolveScopedPath, writeFileAtomicNoFollow } from '../src/security.mjs';

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
  for (const name of ['notes.zip', 'adsl.xpt', 'export.ndjson']) {
    await kept.record(project, { name, bytes: Buffer.from(`PK ${name}`), sessionId: 's1' });
    assert.equal(puts.at(-1).payload.intake, 'notes_archive', name);
  }
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

// --- the original of a large binary record is made from the uploaded file, as a clone and never as a hard link (2026-11-04) -------

async function cloned(name, bytes, { source = bytes, clone = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'vcr-clone-'));
  const writes = [];
  const puts = [];
  const documents = {
    get: async (_userId, _kind, id) => { const row = puts.find((entry) => entry.id === id); return row ? { id, projectId: 'p1', payload: row.payload } : null; },
    put: async (userId, kind, id, payload, options) => { puts.push({ userId, kind, id, payload, options }); },
  };
  const owner = { id: 'p1', userId: 'u1', baseDir: base };
  const kept = createVcrUploadReceipts({
    documents, sources: null,
    write: async (project, relative, data) => { writes.push(relative); await writeFileAtomicNoFollow(project.baseDir, resolveScopedPath(project.baseDir, relative), data, { mode: 0o600 }); },
    clone: clone ? async (project, relative, from) => cloneFileNoFollow(project.baseDir, from, resolveScopedPath(project.baseDir, relative)) : null,
  });
  await mkdir(join(base, 'workspace'), { recursive: true });
  const uploaded = join(base, 'workspace', name);
  await writeFile(uploaded, source);
  const receipt = await kept.record(owner, { name, bytes, cloneFrom: uploaded });
  return { base, uploaded, writes, receipt, owner, kept, puts, original: receipt ? join(base, '.evimed-upload-originals', receipt.sha256, name) : null };
}

test('the original of a PDF, a picture or an archive is made from the uploaded file, a table or a text note from the bytes in hand, and no file gets a second name', async () => {
  for (const name of ['discharge.pdf', 'page.png', 'notes.zip']) {
    const bytes = Buffer.from(`bytes of ${name}`);
    const { base, uploaded, writes, receipt, original } = await cloned(name, bytes);
    try {
      assert.match(receipt?.sourceId ?? '', /^upl_/, name);
      assert.equal(writes.length, 0, `${name}: the bytes in memory were not written again`);
      assert.deepEqual(await readFile(original), bytes);
      const [a, b] = await Promise.all([stat(uploaded), stat(original)]);
      assert.notEqual(a.ino, b.ino, `${name}: a file of its own`);
      assert.equal(a.nlink, 1);
      assert.equal(b.nlink, 1);
      assert.equal(b.mode & 0o777, 0o600);
      // The scoped open the platform reads files through accepts both, which a hard link would make it refuse for both.
      for (const file of [uploaded, original]) { const opened = await openScopedFileNoFollow(base, file); await opened.handle.close(); }
    } finally { await rm(base, { recursive: true, force: true }); }
  }
  for (const name of ['baseline.csv', 'note.txt']) {
    const bytes = Buffer.from(name === 'note.txt' ? 'Patient text' : 'id,age\n1,62\n');
    const { base, writes } = await cloned(name, bytes);
    try {
      assert.equal(writes.length, 1, `${name}: a table and a note are small and written from the bytes in hand`);
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test('a hard link is refused by the platform for both names, which is why an original is a clone', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vcr-clone-'));
  try {
    await writeFile(join(base, 'a.pdf'), 'x');
    await link(join(base, 'a.pdf'), join(base, 'b.pdf'));
    await assert.rejects(openScopedFileNoFollow(base, join(base, 'a.pdf')), /hard-linked/);
    await assert.rejects(openScopedFileNoFollow(base, join(base, 'b.pdf')), /hard-linked/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('with no clone given, or a file that is not the bytes kept, the original is written from the bytes in hand and the upload is not touched', async () => {
  const bytes = Buffer.from('%PDF-1.4 a record');
  const none = await cloned('a.pdf', bytes, { clone: false });
  try { assert.equal(none.writes.length, 1); assert.deepEqual(await readFile(none.original), bytes); } finally { await rm(none.base, { recursive: true, force: true }); }

  // The upload was replaced between its write and the clone: what was cloned is not what was kept, so the bytes in hand are written over it.
  const swapped = await cloned('b.pdf', bytes, { source: Buffer.from('%PDF-1.4 something else') });
  try {
    assert.equal(swapped.writes.length, 1, 'the clone was dropped for a write');
    assert.deepEqual(await readFile(swapped.original), bytes);
    assert.equal((await readFile(swapped.uploaded)).toString(), '%PDF-1.4 something else', 'the upload itself is not touched');
  } finally { await rm(swapped.base, { recursive: true, force: true }); }
});

test('a symbolic link, a path outside the tree and a directory are never cloned', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vcr-clone-'));
  try {
    await mkdir(join(base, 'workspace', 'dir'), { recursive: true });
    await writeFile(join(base, 'outside.pdf'), 'secret');
    await symlink(join(base, 'outside.pdf'), join(base, 'workspace', 'sneaky.pdf'));
    await assert.rejects(cloneFileNoFollow(base, join(base, 'workspace', 'sneaky.pdf'), join(base, 'dst', 'sneaky.pdf')));
    await assert.rejects(cloneFileNoFollow(base, join(base, '..', 'elsewhere.pdf'), join(base, 'dst', 'x.pdf')));
    await assert.rejects(cloneFileNoFollow(base, join(base, 'workspace', 'dir'), join(base, 'dst', 'dir')));
  } finally { await rm(base, { recursive: true, force: true }); }
});
