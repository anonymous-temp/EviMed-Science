import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../src/security.mjs';
import { VCR_DOCUMENT_TEXT_CAP, createIntakeCounters, createVcrRecordExtractor, decideExtraction } from '../src/vcrRecordExtract.mjs';
import { localIntakeController, pythonCan, writeRecordFixtures } from './helpers/vcrIntakeLocal.mjs';

const HAVE_PYTHON = pythonCan('json');
const HAVE_PYPDF = pythonCan('pypdf');
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const limits = { maxPages: 10, minCharsPerPage: 100 };
const sha = value => createHash('sha256').update(value).digest('hex');

/** A container result as the extractor script writes it, and the text it wrote. */
function answer({ text, format = 'pdf', pages = 2, pageChars, extra = {} }) {
  const body = Buffer.from(text);
  const perPage = pageChars ?? Array.from({ length: pages }, () => Math.round(Array.from(text.replace(/\s+/g, '')).length / pages));
  return {
    text: body,
    result: { protocol: 1, outcome: 'text', format, pages, pageChars: format === 'pdf' ? perPage : [], textSha256: sha(body), truncated: false,
      extractor: { name: 'evimed-record-extract', version: '1.0.0', libraries: { pypdf: '6.7.0' } }, ...extra },
  };
}

test('the characters a page yields decide whether a PDF is a scan, and the threshold is the configured one', () => {
  const dense = 'x'.repeat(250);
  const typed = answer({ text: `${dense}\n${dense}`, pages: 2, pageChars: [250, 250] });
  assert.equal(decideExtraction({ format: 'pdf', ...typed, limits }).ok, true);

  // 3 pages with 60 characters between them: 20 per page, far under the floor.
  const scan = answer({ text: 'Page 1 of 3\nPage 2 of 3\nPage 3 of 3 hospital', pages: 3, pageChars: [20, 20, 20] });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...scan, limits }), { ok: false, refusal: 'needs_text' });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...answer({ text: '', pages: 3, pageChars: [0, 0, 0] }), text: null, limits }), { ok: false, refusal: 'failed' });
  // The same document under a lower floor is text.
  assert.equal(decideExtraction({ format: 'pdf', ...scan, limits: { maxPages: 10, minCharsPerPage: 10 } }).ok, true);
  // At the floor exactly it passes: "under the threshold" is the rule.
  const edge = answer({ text: 'y'.repeat(200), pages: 2, pageChars: [100, 100] });
  assert.equal(decideExtraction({ format: 'pdf', ...edge, limits }).ok, true);
  assert.equal(decideExtraction({ format: 'pdf', ...edge, limits: { maxPages: 10, minCharsPerPage: 101 } }).ok, false);
});

test('a container cannot raise a count above what the text holds: characters are recounted here', () => {
  // The result claims 5000 characters on each of two pages; the text has 40.
  const inflated = answer({ text: 'z'.repeat(40), pages: 2, pageChars: [5000, 5000] });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...inflated, limits }), { ok: false, refusal: 'needs_text' });
});

test('a mostly typed PDF with a few scanned pages is accepted and says which pages had no text', () => {
  const page = 'a'.repeat(400);
  const mixed = answer({ text: [page, page, page].join('\n\n'), pages: 4, pageChars: [400, 0, 400, 400] });
  const verdict = decideExtraction({ format: 'pdf', ...mixed, limits });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.extraction.pages, 4);
  assert.equal(verdict.extraction.blankPages, 1);
  assert.deepEqual(verdict.extraction.blankPageNumbers, [2]);
  assert.equal(verdict.extraction.charsPerPage, 300);
  assert.equal(verdict.extraction.sourceFormat, 'pdf');
  assert.equal(verdict.extraction.extractor.name, 'evimed-record-extract');
  assert.equal(verdict.extraction.textSha256, sha(mixed.text));
});

test('a Word file with no text is a document needing a text version; one with text is accepted with no page claim it cannot back', () => {
  assert.deepEqual(decideExtraction({ format: 'docx', ...answer({ text: '   \n ', format: 'docx', pages: null }), limits }), { ok: false, refusal: 'needs_text' });
  const verdict = decideExtraction({ format: 'docx', ...answer({ text: '患者男，62岁，主诉胸痛2小时。诊断：不稳定型心绞痛。', format: 'docx', pages: null }), limits });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.extraction.pages, null);
  assert.equal(verdict.extraction.charsPerPage, null);
});

test('refusals the script names map to the reader-facing verdicts', () => {
  const refused = reason => decideExtraction({ format: 'pdf', result: { protocol: 1, outcome: 'refused', reason }, text: null, limits });
  assert.deepEqual(refused('too_many_pages'), { ok: false, refusal: 'too_long' });
  assert.deepEqual(refused('too_large'), { ok: false, refusal: 'too_large' });
  for (const reason of ['encrypted', 'corrupt', 'not_pdf', 'not_docx']) assert.deepEqual(refused(reason), { ok: false, refusal: 'unreadable' });
  for (const reason of ['deadline', 'memory']) assert.deepEqual(refused(reason), { ok: false, refusal: 'timeout' });
  assert.deepEqual(refused('converter_missing'), { ok: false, refusal: 'unavailable' });
  // The container could not hold the staged file to its digest and size: the reader is asked to upload it again.
  assert.deepEqual(refused('request_invalid'), { ok: false, refusal: 'changed' });
  for (const reason of ['failed', 'something_new']) assert.deepEqual(refused(reason), { ok: false, refusal: 'failed' });
});

test('a result that does not describe the text it came with is a failed conversion, never text', () => {
  const good = answer({ text: 'a'.repeat(300), pages: 1, pageChars: [300] });
  assert.equal(decideExtraction({ format: 'pdf', ...good, limits }).ok, true);
  const cases = [
    { ...good, result: { ...good.result, textSha256: sha('other') } },
    { ...good, result: { ...good.result, protocol: 2 } },
    { ...good, result: { ...good.result, format: 'docx' } },
    { ...good, result: { ...good.result, pages: 0, pageChars: [] } },
    { ...good, result: { ...good.result, pageChars: [300, 300] } },
    { ...good, result: { ...good.result, pageChars: [-1] } },
    { ...good, result: { ...good.result, pages: 'many' } },
    { ...good, result: null },
    { ...good, text: null },
  ];
  for (const bad of cases) assert.deepEqual(decideExtraction({ format: 'pdf', ...bad, limits }), { ok: false, refusal: 'failed' });
});

test('more pages than the limit, and text past the cap, are refused by name', () => {
  const long = answer({ text: 'a'.repeat(5000), pages: 11, pageChars: Array(11).fill(450) });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...long, limits }), { ok: false, refusal: 'too_long' });
  const truncated = answer({ text: 'a'.repeat(500), pages: 1, pageChars: [500], extra: { truncated: true } });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...truncated, limits }), { ok: false, refusal: 'too_large' });
  const huge = answer({ text: 'a'.repeat(300), pages: 1, pageChars: [300] });
  assert.deepEqual(decideExtraction({ format: 'pdf', ...huge, limits: { ...limits, textCap: 100 } }), { ok: false, refusal: 'too_large' });
  assert.equal(VCR_DOCUMENT_TEXT_CAP, 1024 * 1024);
});

// --- through the real script --------------------------------------------------

const STUDY = 'std_record_test';

/**
 * A plane (the one directory a record is ever staged in), an empty data volume
 * that must stay empty, and the real extractor over the real script.
 */
async function world(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-extract-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = path.join(root, 'plane');
  const config = { dataDir: path.join(root, 'data'), runtimeContainerImage: 'img', runtimeContainerUser: '1000:1000', runtimeDataVolume: '',
    vcrDataPlaneDir: plane, vcrDataPlaneHostDir: plane,
    vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024, vcrIntakeMaxPages: 300, vcrIntakeMinCharsPerPage: 100, ...extra };
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(path.join(plane, 'studies', STUDY, 'incoming'), { recursive: true });
  const fixtures = await writeRecordFixtures(root);
  const calls = [];
  const counters = createIntakeCounters();
  const extractor = createVcrRecordExtractor({ config, controller: localIntakeController(config, { calls }), counters });
  /** One upload's conversion, as the plane asks for it. @param {string} file @param {string} format @param {Record<string, any>} [more] */
  const convert = (file, format, more = {}) => extractor.extract({ root: plane, studyId: STUDY, path: file, format, ...more });
  return { root, plane, config, fixtures, calls, counters, extractor, convert };
}
/** The attempts left in any study's scratch area of the plane. */
const attempts = async plane => {
  const found = [];
  for (const study of await fs.readdir(path.join(plane, 'studies')).catch(() => [])) {
    for (const attempt of await fs.readdir(path.join(plane, 'studies', study, '.intake')).catch(() => [])) found.push(`${study}/${attempt}`);
  }
  return found;
};
/** Everything under a directory, relative. @param {string} dir */
const listing = async dir => (await fs.readdir(dir, { recursive: true }).catch(() => [])).sort();

test('a Word record becomes text with its provenance, the scratch copy is in the plane and gone afterwards, and the data volume is never written', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  // The raw upload, where the plane keeps it until the conversion is done.
  const raw = path.join(w.plane, 'studies', STUDY, 'incoming', 'raw.upload');
  await fs.copyFile(w.fixtures['record.docx'], raw);
  const done = await w.convert(raw, 'docx');
  assert.match(done.text, /^患者男，62岁，主诉胸痛2小时。/);
  assert.match(done.text, /肌钙蛋白I \| 0\.04 ng\/mL/);
  assert.equal(done.extraction.sourceFormat, 'docx');
  assert.equal(done.extraction.pages, 2);
  assert.equal(done.extraction.extractor.name, 'evimed-record-extract');
  assert.equal(done.extraction.textSha256, sha(done.text));
  assert.equal(w.counters.extracted, 1);
  // What the container saw: this one file, read-only, and an output directory, both
  // inside the study's scratch area of the plane.
  assert.deepEqual(w.calls[0].files, ['document.docx']);
  const scratch = `${w.plane}/studies/${STUDY}/.intake/`;
  assert.deepEqual(w.calls[0].mounts.map(({ src, dst, readonly }) => [src.startsWith(scratch), dst, readonly]), [[true, '/input/document.docx', true], [true, '/output', false]]);
  assert.deepEqual(await attempts(w.plane), [], 'the attempt directory is removed');
  assert.deepEqual(await listing(w.config.dataDir), [], 'not one byte of the record, or of anything else, was written under the data volume');
  assert.deepEqual(await fs.readFile(raw), await fs.readFile(w.fixtures['record.docx']), 'the raw upload is the plane\'s own, and the conversion leaves it as it was');
});

test('a text PDF becomes text and a scan is refused as needing a text version', { skip: !HAVE_PYPDF && 'pypdf is needed' }, async t => {
  const w = await world(t);
  const done = await w.convert(w.fixtures['text.pdf'], 'pdf');
  assert.match(done.text, /BP 140\/90 mmHg/);
  assert.equal(done.extraction.pages, 2);
  assert.equal(done.extraction.blankPages, 0);
  assert.equal(done.extraction.extractor.libraries.pypdf.length > 0, true);

  await assert.rejects(w.convert(w.fixtures['scan.pdf'], 'pdf'), { status: 422, code: 'vcr_document_needs_text' });
  await assert.rejects(w.convert(w.fixtures['image-only.docx'], 'docx'), { status: 422, code: 'vcr_document_needs_text' });
  assert.equal(w.counters.extracted, 1);
  assert.equal(w.counters.needsText, 2);
  assert.deepEqual(await attempts(w.plane), [], 'a refused attempt is removed too');
});

test('a mixed PDF is accepted with its blank page recorded, and a lower page ceiling refuses it by name', { skip: !HAVE_PYPDF && 'pypdf is needed' }, async t => {
  const w = await world(t);
  const mixed = await w.convert(w.fixtures['mixed.pdf'], 'pdf');
  assert.equal(mixed.extraction.pages, 4);
  assert.deepEqual(mixed.extraction.blankPageNumbers, [2]);
  const strict = await world(t, { vcrIntakeMaxPages: 3 });
  await assert.rejects(strict.convert(strict.fixtures['mixed.pdf'], 'pdf'), { status: 413, code: 'vcr_document_too_long' });
  assert.equal(strict.counters.tooLong, 1);
  // The floor is configuration, not a constant: the same scan passes under a floor of zero.
  const lax = await world(t, { vcrIntakeMinCharsPerPage: 1 });
  const typed = await lax.convert(lax.fixtures['text.pdf'], 'pdf');
  assert.equal(typed.extraction.pages, 2);
});

test('a file that is not what its name says is unreadable before any container starts', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  await assert.rejects(w.convert(w.fixtures['not-a.pdf'], 'pdf'), { status: 422, code: 'vcr_document_unreadable' });
  await assert.rejects(w.convert(w.fixtures['text.pdf'], 'docx'), { status: 422, code: 'vcr_document_unreadable' });
  assert.equal(w.calls.length, 0, 'the magic bytes are checked before a container is asked for');
  assert.deepEqual(await attempts(w.plane), [], 'and before anything is staged');
  assert.equal(w.counters.unreadable, 2);
});

test('only PDF and Word are converted, and without a controller the refusal is the converter being unavailable', async () => {
  const config = { dataDir: '/tmp/none', vcrIntakeMaxPages: 300, vcrIntakeMinCharsPerPage: 100 };
  const none = createVcrRecordExtractor({ config });
  assert.equal(none.available, false);
  await assert.rejects(none.extract({ root: '/tmp/none', studyId: 'std_x', path: '/dev/null', format: 'pdf' }), { status: 503, code: 'vcr_document_converter_unavailable' });
  await assert.rejects(none.extract({ root: '/tmp/none', studyId: 'std_x', path: '/dev/null', format: 'rtf' }), { status: 415, code: 'vcr_data_format_unsupported' });
  assert.equal(none.counters.unavailable, 1);
  assert.deepEqual(none.describe(), { available: false, formats: ['pdf', 'docx'], maxBytes: 0, maxPages: 300, minCharsPerPage: 100 });
});

test('a controller that cannot be reached is the converter being unavailable; its own refusals pass through and are counted', async t => {
  const w = await world(t);
  const reported = [];
  const make = error => createVcrRecordExtractor({ config: w.config, counters: w.counters, report: code => reported.push(code),
    controller: { runVcrIntake: async () => { throw error; } } });
  const asDocx = extractor => extractor.extract({ root: w.plane, studyId: STUDY, path: w.fixtures['record.docx'], format: 'docx' });
  await assert.rejects(asDocx(make(new HttpError(503, 'runtime_controller_unavailable', 'x'))), { status: 503, code: 'vcr_document_converter_unavailable' });
  assert.deepEqual(reported, ['runtime_controller_unavailable']);
  await assert.rejects(asDocx(make(new HttpError(504, 'vcr_intake_timeout', 'x'))), { code: 'vcr_intake_timeout' });
  await assert.rejects(asDocx(make(new HttpError(502, 'vcr_intake_failed', 'x'))), { code: 'vcr_intake_failed' });
  // A controller that has no host path for the plane answers by name, and that is the converter being unavailable too.
  await assert.rejects(asDocx(make(new HttpError(503, 'vcr_document_converter_unavailable', 'x'))), { status: 503, code: 'vcr_document_converter_unavailable' });
  assert.equal(w.counters.timedOut, 1);
  assert.equal(w.counters.failed, 1);
  assert.equal(w.counters.unavailable, 2);
  assert.deepEqual(await attempts(w.plane), []);
});

test('a conversion that wrote no result, or a result that is not JSON, is a failed conversion', async t => {
  const w = await world(t);
  const make = write => createVcrRecordExtractor({ config: w.config, counters: w.counters,
    controller: { runVcrIntake: async (kind, reference) => { await write(path.join(w.plane, path.dirname(path.dirname(reference.path)), 'out')); return { finished: true }; } } });
  const asDocx = extractor => extractor.extract({ root: w.plane, studyId: STUDY, path: w.fixtures['record.docx'], format: 'docx' });
  await assert.rejects(asDocx(make(async () => {})), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(asDocx(make(dir => fs.writeFile(path.join(dir, 'result.json'), '{broken'))), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(asDocx(make(async dir => { await fs.symlink('/etc/hostname', path.join(dir, 'result.json')); })), { status: 502, code: 'vcr_intake_failed' });
  assert.deepEqual(await attempts(w.plane), []);
});

test('a staged file that is not the one that was digested is refused as changed, and the attempt is removed', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  const inner = localIntakeController(w.config);
  // Someone with write access to the plane swaps the staged file after it was digested.
  const tampering = { runVcrIntake: async (kind, reference) => {
    await fs.chmod(path.join(w.plane, reference.path), 0o600);
    await fs.appendFile(path.join(w.plane, reference.path), 'x');
    return inner.runVcrIntake(kind, reference);
  } };
  const extractor = createVcrRecordExtractor({ config: w.config, controller: tampering, counters: w.counters });
  await assert.rejects(extractor.extract({ root: w.plane, studyId: STUDY, path: w.fixtures['record.docx'], format: 'docx' }), { status: 409, code: 'vcr_intake_input_invalid' });
  assert.equal(w.counters.failed, 1);
  assert.equal(w.counters.extracted, 0);
  assert.deepEqual(await attempts(w.plane), []);
  assert.deepEqual(await listing(w.config.dataDir), []);
});

// --- the external parser is not reachable from this path -----------------------

/** Every module a file imports, transitively, within `src/`. @param {string[]} entries */
async function importClosure(entries) {
  const seen = new Set();
  const queue = entries.map(entry => path.join(SRC, entry));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
      queue.push(path.resolve(path.dirname(file), match[1] ?? match[2] ?? match[3]));
    }
  }
  return new Set([...seen].map(file => path.relative(SRC, file)));
}

test('the external document parser is not reachable from the record intake path', async () => {
  const entries = ['vcrDataPlane.mjs', 'vcrRecordExtract.mjs', 'vcrIntakeStage.mjs', 'vcrIntakeController.mjs', 'runtimeControllerClient.mjs', 'vcrComposition.mjs'];
  const closure = await importClosure(entries);
  // The walk must have walked: the plane's own dependencies are in it.
  for (const expected of ['vcrDataStore.mjs', 'vcrAccess.mjs', 'security.mjs', 'dockerMounts.mjs']) assert.ok(closure.has(expected), `${expected} is in the closure; the walk ran`);
  assert.ok(closure.size >= 15, `only ${closure.size} modules were walked`);
  // The parser, and every module that reaches it (the knowledge base, the web reader, the public-source gateway).
  for (const forbidden of ['documentParserClient.mjs', 'sourceService.mjs', 'sourceWorker.mjs', 'webRead.mjs', 'publicSourceGateway.mjs']) {
    assert.ok(!closure.has(forbidden), `${forbidden} must not be reachable from the record intake path`);
  }
});

test('a record is converted without one outbound request from this process', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error('no network is part of this path'); };
  t.after(() => { globalThis.fetch = real; });
  await w.convert(w.fixtures['record.docx'], 'docx');
  assert.deepEqual(requests, []);
});
