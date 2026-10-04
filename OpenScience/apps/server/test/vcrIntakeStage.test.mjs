import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../src/security.mjs';
import { parseVcrIntakeImportInput, parseVcrIntakeInput } from '../src/vcrIntakeLayout.mjs';
import { resetIntakeSweep, runPlaneExtraction, runPlaneImport, sweepStalePlaneScratch } from '../src/vcrIntakeStage.mjs';

const STUDY = 'std_stage_test';
const sha = value => createHash('sha256').update(value).digest('hex');
const MODE = file => fs.stat(file).then(stat => stat.mode & 0o777);

async function world(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-stage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plane = path.join(root, 'plane');
  await fs.mkdir(path.join(plane, 'studies', STUDY, 'incoming'), { recursive: true });
  const raw = path.join(plane, 'studies', STUDY, 'incoming', 'upload.upload');
  const bytes = Buffer.from('%PDF-1.4 a record that must not leave the plane');
  await fs.writeFile(raw, bytes, { mode: 0o600 });
  resetIntakeSweep();
  return { root, plane, raw, bytes };
}
const scratchOf = plane => path.join(plane, 'studies', STUDY, '.intake');

test('a record is staged as a read-only copy and an empty directory inside the plane, and the controller is told a path, a digest and a size', async t => {
  const w = await world(t);
  let told = null;
  let seen = null;
  const controller = { runVcrIntake: async (kind, reference, options) => {
    const { input, output } = parseVcrIntakeInput(reference.path);
    told = { kind, reference, options };
    seen = {
      inputMode: await MODE(path.join(w.plane, input)), outputMode: await MODE(path.join(w.plane, output)),
      attemptMode: await MODE(path.join(w.plane, path.dirname(path.dirname(input)))), scratchMode: await MODE(scratchOf(w.plane)),
      copy: await fs.readFile(path.join(w.plane, input)), outputEntries: await fs.readdir(path.join(w.plane, output)),
    };
    await fs.writeFile(path.join(w.plane, output, 'result.json'), '{"ok":true}');
    return { finished: true };
  } };
  const signal = new AbortController().signal;
  const result = await runPlaneExtraction({ root: w.plane, studyId: STUDY, controller, source: w.raw, format: 'pdf', signal }, async attempt => {
    assert.equal(attempt.fileSha256, sha(w.bytes));
    assert.equal(attempt.bytes, w.bytes.length);
    return (await attempt.read('result.json', 1024)).toString('utf8');
  });
  assert.equal(result, '{"ok":true}');

  // What the controller was handed: the kind, nothing but the three fields, and the caller's signal.
  assert.equal(told.kind, 'extract');
  assert.deepEqual(Object.keys(told.reference).sort(), ['bytes', 'path', 'sha256']);
  assert.equal(told.reference.sha256, sha(w.bytes));
  assert.equal(told.reference.bytes, w.bytes.length);
  assert.match(told.reference.path, new RegExp(`^studies/${STUDY}/\\.intake/[a-f0-9-]{36}/in/document\\.pdf$`));
  assert.equal(told.options.signal, signal);
  // What the container's two mounts looked like: a copy of the bytes the plane held, nobody else may read or write it.
  assert.deepEqual(seen.copy, w.bytes);
  assert.deepEqual(seen.outputEntries, []);
  assert.equal(seen.inputMode, 0o400);
  assert.equal(seen.outputMode, 0o700);
  assert.equal(seen.attemptMode, 0o700);
  assert.equal(seen.scratchMode, 0o700);

  // Afterwards the attempt is gone, and the raw upload is exactly as it was.
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);
  assert.deepEqual(await fs.readFile(w.raw), w.bytes);
});

test('whatever goes wrong, the attempt is removed', async t => {
  const w = await world(t);
  const failing = { runVcrIntake: async () => { throw new HttpError(502, 'vcr_intake_failed', 'x'); } };
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: STUDY, controller: failing, source: w.raw, format: 'pdf' }, async () => 'never'), { code: 'vcr_intake_failed' });
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);

  const idle = { runVcrIntake: async () => ({ finished: true }) };
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: STUDY, controller: idle, source: w.raw, format: 'docx' }, async () => { throw new Error('the consumer failed'); }), /the consumer failed/);
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);

  // A source that is not there fails before the controller is asked, and leaves no attempt behind.
  let asked = false;
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: STUDY, controller: { runVcrIntake: async () => { asked = true; } }, source: path.join(w.plane, 'missing'), format: 'pdf' }, async () => 'never'), { code: 'ENOENT' });
  assert.equal(asked, false);
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);
  // A study id or a format the layout cannot spell is refused by name before anything is created.
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: '../x', controller: idle, source: w.raw, format: 'pdf' }, async () => 'never'), { code: 'vcr_intake_input_invalid' });
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: STUDY, controller: idle, source: w.raw, format: 'exe' }, async () => 'never'), { code: 'vcr_intake_input_invalid' });
});

test('a scratch directory that is a link is not used', async t => {
  const w = await world(t);
  const elsewhere = path.join(w.root, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, scratchOf(w.plane));
  let asked = false;
  await assert.rejects(runPlaneExtraction({ root: w.plane, studyId: STUDY, controller: { runVcrIntake: async () => { asked = true; } }, source: w.raw, format: 'pdf' }, async () => 'never'), { code: 'path_forbidden' });
  assert.equal(asked, false);
  assert.deepEqual(await fs.readdir(elsewhere), [], 'nothing was written through the link');
});

test('the output is read from the attempt\'s directory under a bound and never through a link', async t => {
  const w = await world(t);
  const writes = async (output, write) => runPlaneExtraction({ root: w.plane, studyId: STUDY, source: w.raw, format: 'pdf',
    controller: { runVcrIntake: async (kind, reference) => { await write(path.join(w.plane, parseVcrIntakeInput(reference.path).output)); } } }, async attempt => attempt.read(output, 16));
  assert.equal(await writes('result.json', async dir => { await fs.writeFile(path.join(dir, 'result.json'), 'small'); }).then(buffer => buffer.toString()), 'small');
  assert.equal(await writes('result.json', async () => {}), null, 'a file that was not written is null, not an error');
  await assert.rejects(writes('result.json', async dir => { await fs.writeFile(path.join(dir, 'result.json'), 'x'.repeat(64)); }), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(writes('result.json', async dir => { await fs.symlink('/etc/hostname', path.join(dir, 'result.json')); }), { status: 502, code: 'vcr_intake_failed' });
});

test('a crash leaves an attempt in the plane, and the sweep removes the old ones and only those', async t => {
  const w = await world(t);
  const other = 'std_other';
  const make = async (study, attempt, ageMs) => {
    const dir = path.join(w.plane, 'studies', study, '.intake', attempt);
    await fs.mkdir(path.join(dir, 'in'), { recursive: true });
    await fs.writeFile(path.join(dir, 'in', 'document.pdf'), 'patient bytes');
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return dir;
  };
  const stale = await make(STUDY, 'a1b2c3d4-0000-4000-8000-00000000000a', 2 * 3_600_000);
  const staleOther = await make(other, 'a1b2c3d4-0000-4000-8000-00000000000b', 3 * 3_600_000);
  const fresh = await make(STUDY, 'a1b2c3d4-0000-4000-8000-00000000000c', 60_000);
  // Things the sweep must leave alone: a stray file in a study, a study with no scratch, a scratch that is a link.
  await fs.writeFile(path.join(w.plane, 'studies', STUDY, 'incoming', 'keep.upload'), 'x');
  await fs.mkdir(path.join(w.plane, 'studies', 'std_none'), { recursive: true });
  const linked = path.join(w.plane, 'studies', 'std_linked');
  const outside = path.join(w.root, 'outside');
  await fs.mkdir(path.join(outside, 'old-attempt'), { recursive: true });
  await fs.utimes(path.join(outside, 'old-attempt'), new Date(0), new Date(0));
  await fs.mkdir(linked);
  await fs.symlink(outside, path.join(linked, '.intake'));

  assert.equal(await sweepStalePlaneScratch(w.plane), 2);
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  await assert.rejects(fs.stat(staleOther), { code: 'ENOENT' });
  assert.ok((await fs.stat(fresh)).isDirectory());
  assert.deepEqual(await fs.readdir(path.join(outside)), ['old-attempt'], 'a link is not followed out of the plane');
  assert.ok((await fs.stat(path.join(w.plane, 'studies', STUDY, 'incoming', 'keep.upload'))).isFile());

  // At most once in five minutes per process, and the seam resets it.
  const later = await make(STUDY, 'a1b2c3d4-0000-4000-8000-00000000000d', 5 * 3_600_000);
  assert.equal(await sweepStalePlaneScratch(w.plane), 0);
  assert.ok((await fs.stat(later)).isDirectory());
  resetIntakeSweep();
  assert.equal(await sweepStalePlaneScratch(w.plane), 1);
  // A plane with no studies directory is not an error.
  resetIntakeSweep();
  assert.equal(await sweepStalePlaneScratch(path.join(w.root, 'no-such-plane')), 0);
});

// --- an import: the upload is streamed into the attempt, and tables are read back out of it -------------------------

async function* chunks(...parts) { for (const part of parts) yield Buffer.from(part); }

test('an import is streamed into a read-only file of the plane, hashed on the way in, and the controller is told a path, a digest, a size and the standard', async t => {
  const w = await world(t);
  let told = null;
  let seen = null;
  const controller = { runVcrIntake: async (kind, reference, options) => {
    const { input, output } = parseVcrIntakeImportInput(reference.path);
    told = { kind, reference, options };
    seen = { inputMode: await MODE(path.join(w.plane, input)), outputMode: await MODE(path.join(w.plane, output)), copy: await fs.readFile(path.join(w.plane, input)),
      outputEntries: await fs.readdir(path.join(w.plane, output)), scratchMode: await MODE(scratchOf(w.plane)) };
    await fs.writeFile(path.join(w.plane, output, 'result.json'), '{"ok":true}');
    await fs.writeFile(path.join(w.plane, output, 'table.csv'), 'a,b\n1,2\n');
    return { finished: true };
  } };
  const signal = new AbortController().signal;
  const body = ['{"resourceType":"Patient"}\n', '{"resourceType":"Patient","id":"2"}\n'];
  const bytes = Buffer.from(body.join(''));
  const answer = await runPlaneImport({ root: w.plane, studyId: STUDY, controller, format: 'fhir', extension: 'ndjson', stream: chunks(...body), cap: 1024, signal }, async attempt => {
    assert.equal(attempt.fileSha256, sha(bytes));
    assert.equal(attempt.bytes, bytes.length);
    const opened = await attempt.openTable('table.csv', 8);
    const hash = await opened.sha256();
    let text = '';
    for await (const block of opened.stream()) text += block;
    await opened.close();
    return { result: (await attempt.read('result.json', 1024)).toString(), hash, text };
  });
  assert.deepEqual(answer, { result: '{"ok":true}', hash: sha('a,b\n1,2\n'), text: 'a,b\n1,2\n' });
  assert.equal(told.kind, 'convert');
  assert.deepEqual(Object.keys(told.reference).sort(), ['bytes', 'format', 'path', 'sha256']);
  assert.deepEqual([told.reference.format, told.reference.bytes, told.reference.sha256], ['fhir', bytes.length, sha(bytes)]);
  assert.match(told.reference.path, new RegExp(`^studies/${STUDY}/\\.intake/[a-f0-9-]{36}/in/import\\.ndjson$`));
  assert.equal(told.options.signal, signal);
  // The container saw the bytes as received, in a file nobody else may write, and an empty output directory of its own.
  assert.deepEqual(seen.copy, bytes);
  assert.deepEqual(seen.outputEntries, []);
  assert.deepEqual([seen.inputMode, seen.outputMode, seen.scratchMode], [0o400, 0o700, 0o700]);
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), [], 'the attempt is gone afterwards');
});

test('an import that outgrows its cap, is empty, is interrupted, or fails anywhere leaves no attempt behind', async t => {
  const w = await world(t);
  let asked = false;
  const idle = { runVcrIntake: async () => { asked = true; return { finished: true }; } };
  const run = (stream, extra = {}) => runPlaneImport({ root: w.plane, studyId: STUDY, controller: idle, format: 'omop', extension: 'zip', stream, cap: 8, ...extra }, async () => 'ok');
  await assert.rejects(run(chunks('12345', '67890')), { status: 413, code: 'vcr_data_file_too_large' });
  await assert.rejects(run(chunks()), { status: 422, code: 'vcr_data_file_unreadable' });
  await assert.rejects(run((async function* () { yield Buffer.from('1234'); throw new Error('reset'); })()), { status: 400, code: 'vcr_data_file_unreadable' });
  assert.equal(asked, false, 'no container was asked for a file that did not arrive');
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);
  await assert.rejects(run(chunks('1234'), { controller: { runVcrIntake: async () => { throw new HttpError(502, 'vcr_intake_failed', 'x'); } } }), { code: 'vcr_intake_failed' });
  await assert.rejects(runPlaneImport({ root: w.plane, studyId: STUDY, controller: idle, format: 'omop', extension: 'zip', stream: chunks('1234'), cap: 8 }, async () => { throw new Error('the consumer failed'); }), /the consumer failed/);
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);
  // A study id or an extension the layout cannot spell is refused by name before anything is created.
  await assert.rejects(runPlaneImport({ root: w.plane, studyId: '../x', controller: idle, format: 'omop', extension: 'zip', stream: chunks('1'), cap: 8 }, async () => 'never'), { code: 'vcr_intake_input_invalid' });
  await assert.rejects(runPlaneImport({ root: w.plane, studyId: STUDY, controller: idle, format: 'omop', extension: 'exe', stream: chunks('1'), cap: 8 }, async () => 'never'), { code: 'vcr_intake_input_invalid' });
});

test('a table of the output is opened only as the file and the size the result named, never through a link', async t => {
  const w = await world(t);
  const opening = (name, bytes, write) => runPlaneImport({ root: w.plane, studyId: STUDY, format: 'fhir', extension: 'json', stream: chunks('{}'), cap: 64,
    controller: { runVcrIntake: async (kind, reference) => { await write(path.join(w.plane, parseVcrIntakeImportInput(reference.path).output)); return { finished: true }; } } },
  async attempt => { const opened = await attempt.openTable(name, bytes); await opened.close(); return opened.bytes; });
  assert.equal(await opening('a.csv', 3, async dir => { await fs.writeFile(path.join(dir, 'a.csv'), 'abc'); }), 3);
  await assert.rejects(opening('a.csv', 4, async dir => { await fs.writeFile(path.join(dir, 'a.csv'), 'abc'); }), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(opening('a.csv', 3, async () => {}), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(opening('a.csv', 3, async dir => { await fs.symlink('/etc/hostname', path.join(dir, 'a.csv')); }), { status: 502, code: 'vcr_intake_failed' });
  await assert.rejects(opening('../../etc/hostname', 3, async () => {}), { status: 502, code: 'vcr_intake_failed' });
  assert.deepEqual(await fs.readdir(scratchOf(w.plane)), []);
});
