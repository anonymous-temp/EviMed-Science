/**
 * A patient record as PDF or Word, through the data plane: converted to text in
 * the deployment, the original kept in the plane beside it, a scan refused by
 * name. The store is a small in-memory double (the plane's SQL is covered by
 * the integration suites, which need PostgreSQL); the converter is the real
 * script, run locally by `helpers/vcrIntakeLocal.mjs`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VcrDataPlane, fileView, safeUploadName } from '../src/vcrDataPlane.mjs';
import { createVcrRecordExtractor } from '../src/vcrRecordExtract.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { localIntakeController, pythonCan, writeRecordFixtures } from './helpers/vcrIntakeLocal.mjs';

const HAVE_PYTHON = pythonCan('json');
const HAVE_PYPDF = pythonCan('pypdf');
const STUDY = 'study_1';
const SOURCE = 'src_1';
const sha = value => createHash('sha256').update(value).digest('hex');

function memoryStore() {
  /** @type {any[]} */
  const files = [];
  return {
    files,
    async studyForAccess(id) { return id === STUDY ? { id, userId: 'owner' } : null; },
    async sourceInStudy(studyId, sourceId) { return studyId === STUDY && sourceId === SOURCE ? { id: SOURCE, studyId, userId: 'owner', status: 'registered' } : null; },
    async addSourceFile(entry) {
      const existing = files.find(file => file.sourceId === entry.sourceId && file.sha256 === entry.sha256 && file.role === entry.role);
      if (existing) return { file: existing, created: false };
      const file = { id: `fil_${files.length + 1}`, studyId: entry.studyId, ...entry, detail: structuredClone(entry.detail ?? {}), createdAt: '2026-10-04T00:00:00.000Z' };
      files.push(file);
      return { file, created: true };
    },
    async listSourceFilesForStudy() { return [...files]; },
    async getSourceFile(studyId, id) { return files.find(file => file.id === id) ?? null; },
    async deleteSourceFile({ fileId }) {
      const index = files.findIndex(file => file.id === fileId);
      if (index < 0) return { removed: null, frozen: false };
      return { removed: files.splice(index, 1)[0], frozen: false };
    },
  };
}

async function world(t, { extractor = 'real', config = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-plane-docs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const planeDir = path.join(root, 'plane');
  await fs.mkdir(planeDir);
  const appConfig = { dataDir: path.join(root, 'data'), vcrDataPlaneDir: planeDir, vcrDataMaxBytes: 50 * 1024 * 1024, runtimeContainerImage: 'img',
    runtimeContainerUser: '1000:1000', runtimeDataVolume: '', vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024,
    vcrIntakeMaxPages: 300, vcrIntakeMinCharsPerPage: 100, ...config };
  await fs.mkdir(appConfig.dataDir, { recursive: true });
  const store = memoryStore();
  const calls = [];
  const converter = extractor === 'real' ? createVcrRecordExtractor({ config: appConfig, controller: localIntakeController(appConfig, { calls }) }) : extractor;
  const plane = new VcrDataPlane({ store, config: appConfig, access: { require: async () => ({ allowed: true }) }, extractor: converter });
  const fixtures = await writeRecordFixtures(root);
  const upload = async (name, bytes, extra = {}) => plane.storeUpload({
    actor: 'owner', studyId: STUDY, sourceId: SOURCE, name, role: 'document', subject: 'S-001', stream: streamOf(bytes), ...extra,
  });
  const read = async name => fs.readFile(fixtures[name]);
  return { root, planeDir, config: appConfig, store, plane, upload, read, calls };
}
const inDir = async (dir, sub) => (await fs.readdir(path.join(dir, 'studies')).then(names => Promise.all(names.map(name => fs.readdir(path.join(dir, 'studies', name, sub)).catch(() => []))))).flat();

test('a Word record is stored as the text the matching step reads, with its original and provenance beside it', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  const original = await w.read('record.docx');
  const { file, created } = await w.upload('admission note (患者姓名).docx', original);
  assert.equal(created, true);

  // The contract downstream is unchanged: a text file with a pseudonymous name.
  assert.equal(file.role, 'document');
  assert.equal(file.format, 'txt');
  assert.match(file.name, /^document-[a-f0-9]{8}\.txt$/);
  assert.ok(!file.name.includes('患者'), 'the uploader\'s file name is never kept');
  assert.ok(file.location.endsWith('.txt'));
  const text = await fs.readFile(path.join(w.planeDir, file.location), 'utf8');
  assert.match(text, /^患者男，62岁，主诉胸痛2小时。/);
  assert.equal(file.sha256, sha(text));

  // The original's hash, format and page count, and the extractor, are recorded.
  assert.equal(file.detail.originalSha256, sha(original));
  assert.equal(file.detail.originalBytes, original.length);
  assert.equal(file.detail.original.sha256, sha(original));
  assert.equal(file.detail.original.format, 'docx');
  assert.equal(file.detail.extraction.sourceFormat, 'docx');
  assert.equal(file.detail.extraction.pages, 2);
  assert.equal(file.detail.extraction.extractor.name, 'evimed-record-extract');
  assert.equal(file.detail.extraction.textSha256, sha(text));
  assert.equal(file.detail.originalName, undefined);
  assert.match(file.detail.subjectKey, /^P[a-f0-9]{16}$/);
  assert.equal(file.detail.chars, text.length);

  // The original's bytes stay in the plane, under its own hash.
  assert.equal(file.detail.original.location, `studies/${STUDY}/documents/${sha(original)}.docx`);
  assert.deepEqual(await fs.readFile(path.join(w.planeDir, file.detail.original.location)), original);

  // A read for the matching step returns the text and never the original.
  const read = await w.plane.documentText({ studyId: STUDY, documentId: file.id, principal: 'owner' });
  assert.equal(read.text, text);
  assert.equal(read.name, file.name);

  // What a route shows says what it was converted from and how much had no text layer.
  const shown = fileView(file);
  assert.equal(shown.sourceFormat, 'docx');
  assert.equal(shown.pages, 2);
  assert.equal(shown.blankPages, 0);
  assert.ok(!JSON.stringify(shown).includes('location'));
  assert.ok(!JSON.stringify(shown).includes(sha(original)) || shown.sha256 === file.sha256);
});

test('a text PDF is converted, and the same PDF twice is the same file', { skip: !HAVE_PYPDF && 'pypdf is needed' }, async t => {
  const w = await world(t);
  const bytes = await w.read('text.pdf');
  const first = await w.upload('lab.pdf', bytes);
  assert.equal(first.created, true);
  assert.equal(first.file.detail.extraction.sourceFormat, 'pdf');
  assert.equal(first.file.detail.extraction.pages, 2);
  assert.equal(first.file.detail.extraction.blankPages, 0);
  assert.match(await fs.readFile(path.join(w.planeDir, first.file.location), 'utf8'), /Troponin I 0\.04 ng\/mL/);
  const again = await w.upload('lab-renamed.pdf', bytes);
  assert.equal(again.created, false);
  assert.equal(again.file.id, first.file.id);
  assert.equal(w.store.files.length, 1);
});

test('a scanned PDF and a picture are refused by name, store nothing, and are never sent anywhere', { skip: !HAVE_PYPDF && 'pypdf is needed' }, async t => {
  const w = await world(t);
  await assert.rejects(w.upload('scan.pdf', await w.read('scan.pdf')), { status: 422, code: 'vcr_document_needs_text' });
  await assert.rejects(w.upload('image-only.docx', await w.read('image-only.docx')), { status: 422, code: 'vcr_document_needs_text' });
  const before = w.calls.length;
  for (const name of ['photo.png', 'record.JPG', 'page.jpeg', 'fax.tif', 'scan.heic']) {
    await assert.rejects(w.upload(name, Buffer.from('not looked at')), { status: 422, code: 'vcr_document_needs_text' });
  }
  assert.equal(w.calls.length, before, 'a picture is refused by its extension before any converter is asked');
  assert.equal(w.store.files.length, 0);
  assert.deepEqual(await inDir(w.planeDir, 'documents'), [], 'nothing was written to the plane');
  assert.deepEqual(await inDir(w.planeDir, 'incoming'), [], 'the raw upload is removed');
});

test('an old .doc says what to save it as, and an unknown extension lists what a document may be', async t => {
  const w = await world(t, { extractor: null });
  await assert.rejects(w.upload('old.doc', Buffer.from('x')), { status: 415, code: 'vcr_data_format_unsupported', message: /\.docx/ });
  await assert.rejects(w.upload('notes.rtf', Buffer.from('x')), { status: 415, code: 'vcr_data_format_unsupported', message: /txt, md, pdf, docx/ });
  assert.deepEqual(safeUploadName('x.PDF', 'document'), { name: 'x.PDF', ext: 'pdf', format: 'pdf' });
  assert.deepEqual(safeUploadName('x.docx', 'document'), { name: 'x.docx', ext: 'docx', format: 'docx' });
  assert.deepEqual(safeUploadName('x.md', 'document'), { name: 'x.md', ext: 'md', format: 'txt' });
  assert.throws(() => safeUploadName('x.pdf', 'data'), { code: 'vcr_data_format_unsupported' });
  assert.throws(() => safeUploadName('x.docx', 'dictionary'), { code: 'vcr_data_format_unsupported' });
});

test('a deployment without a converter refuses PDF and Word by name and still takes plain text', async t => {
  const w = await world(t, { extractor: null });
  await assert.rejects(w.upload('lab.pdf', Buffer.from('%PDF-1.4')), { status: 503, code: 'vcr_document_converter_unavailable' });
  await assert.rejects(w.upload('note.docx', Buffer.from('PK\u0003\u0004')), { status: 503, code: 'vcr_document_converter_unavailable' });
  const { file } = await w.upload('note.txt', Buffer.from('主诉胸痛2小时。', 'utf8'));
  assert.equal(file.detail.original, undefined);
  assert.equal(file.detail.extraction, undefined);
  assert.equal(file.detail.encoding, 'utf-8');
});

test('a text record is read exactly as before: no conversion, no original, the same cap', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  const { file } = await w.upload('note.txt', Buffer.from('主诉胸痛2小时。'));
  assert.equal(w.calls.length, 0);
  assert.equal(file.detail.original, undefined);
  assert.equal(file.detail.originalSha256, sha('主诉胸痛2小时。'));
  await assert.rejects(w.upload('big.txt', Buffer.alloc(1024 * 1024 + 1, 0x61)), { status: 413, code: 'vcr_data_file_too_large' });
});

test('a PDF or Word file has its own byte ceiling, and the text that comes out is held to the document cap', async t => {
  const small = await world(t, { config: { vcrIntakeMaxBytes: 2048 }, extractor: { available: true, extract: async () => { throw new Error('never reached'); } } });
  await assert.rejects(small.upload('large.pdf', Buffer.alloc(4096, 0x20)), { status: 413, code: 'vcr_data_file_too_large' });
  const long = 'a'.repeat(1024 * 1024 + 10);
  const generous = await world(t, { extractor: { available: true, extract: async () => ({ text: long, extraction: { sourceFormat: 'pdf', pages: 1 } }) } });
  await assert.rejects(generous.upload('long.pdf', Buffer.from('%PDF-1.4 stand-in')), { status: 413, code: 'vcr_data_file_too_large' });
  assert.deepEqual(await inDir(generous.planeDir, 'incoming'), []);
});

test('two different originals with the same text leave one original, and removing the file removes it', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const calls = [];
  const converter = { available: true, extract: async ({ path: file }) => { calls.push(file); return { text: 'identical extracted record text '.repeat(10), extraction: { sourceFormat: 'pdf', pages: 1, blankPages: 0 } }; } };
  const w = await world(t, { extractor: converter });
  const first = await w.upload('a.pdf', Buffer.from('%PDF-1.4 first save'));
  const second = await w.upload('b.pdf', Buffer.from('%PDF-1.4 second save'));
  assert.equal(second.created, false);
  assert.deepEqual(await inDir(w.planeDir, 'documents'), [`${sha('identical extracted record text '.repeat(10))}.txt`, `${sha(Buffer.from('%PDF-1.4 first save'))}.pdf`].sort(),
    'the second original is not left behind unnamed');
  const removed = await w.plane.removeUpload({ actor: 'owner', studyId: STUDY, fileId: first.file.id });
  assert.equal(removed.removed, true);
  assert.deepEqual(await inDir(w.planeDir, 'documents'), [], 'the text and its original go together');
});

test('the data plane never holds the intake scratch and the intake scratch never holds the plane', async t => {
  const w = await world(t);
  assert.ok(!w.config.dataDir.startsWith(w.planeDir));
  assert.ok(!w.planeDir.startsWith(w.config.dataDir));
});
