import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrLocationIsValid } from '@evimed/domain';
import { assertDataPlaneLocation } from '../src/vcrDataPlane.mjs';
import {
  VCR_IMPORT_EXTENSIONS, VCR_IMPORT_FORMATS, VCR_INTAKE_DOCUMENT_FORMATS, VCR_INTAKE_LIMITS, VCR_INTAKE_LONG_KINDS, VCR_INTAKE_SCRATCH, VCR_TABLE_LIMITS,
  isVcrIntakeScratchLocation, parseVcrIntakeImportInput, parseVcrIntakeInput, vcrIntakeImportPaths, vcrIntakeScratchPaths,
} from '../src/vcrIntakeLayout.mjs';

const STUDY = 'std_0123abcd-EF';
const ATTEMPT = 'a1b2c3d4-0000-4000-8000-000000000001';

test('an attempt is one input file and one output directory under the study\'s hidden scratch directory', () => {
  const paths = vcrIntakeScratchPaths(STUDY, ATTEMPT, 'pdf');
  assert.deepEqual(paths, {
    scratch: `studies/${STUDY}/.intake`,
    attempt: `studies/${STUDY}/.intake/${ATTEMPT}`,
    inputDirectory: `studies/${STUDY}/.intake/${ATTEMPT}/in`,
    input: `studies/${STUDY}/.intake/${ATTEMPT}/in/document.pdf`,
    output: `studies/${STUDY}/.intake/${ATTEMPT}/out`,
  });
  assert.equal(VCR_INTAKE_SCRATCH, '.intake');
  assert.deepEqual([...VCR_INTAKE_DOCUMENT_FORMATS], ['pdf', 'docx']);
  assert.equal(vcrIntakeScratchPaths(STUDY, ATTEMPT, 'docx').input, `studies/${STUDY}/.intake/${ATTEMPT}/in/document.docx`);
});

test('the path a controller is handed parses back to the attempt, and only that shape does', () => {
  for (const format of VCR_INTAKE_DOCUMENT_FORMATS) {
    const { input } = vcrIntakeScratchPaths(STUDY, ATTEMPT, format);
    assert.deepEqual(parseVcrIntakeInput(input), { studyId: STUDY, attemptId: ATTEMPT, format, ...vcrIntakeScratchPaths(STUDY, ATTEMPT, format) });
  }
  const good = vcrIntakeScratchPaths(STUDY, ATTEMPT, 'pdf').input;
  const bad = [
    '', 'studies', `${good}/`, `/${good}`, `${good}\n`, `${good},readonly`, ` ${good}`,
    good.replace('document.pdf', 'document.exe'), good.replace('document.pdf', 'other.pdf'), good.replace('/in/', '/out/'), good.replace('/in/', '/in/../in/'),
    good.replace('.intake', 'incoming'), good.replace('.intake', '.INTAKE'), good.replace(STUDY, '..'), good.replace(STUDY, 'a/b'), good.replace(STUDY, 'a,b'),
    good.replace(ATTEMPT, 'attempt'), good.replace(ATTEMPT, ATTEMPT.toUpperCase()), good.replace(ATTEMPT, `${ATTEMPT}0`),
    good.replace('studies/', ''), good.replace('studies/', 'studies/x/'), `x/${good}`,
    undefined, null, 7, {}, [good],
  ];
  for (const value of bad) assert.throws(() => parseVcrIntakeInput(value), { status: 400, code: 'vcr_intake_input_invalid' }, JSON.stringify(value));
  for (const [study, attempt, format] of [['', ATTEMPT, 'pdf'], ['a b', ATTEMPT, 'pdf'], [STUDY, 'x', 'pdf'], [STUDY, ATTEMPT, 'doc'], [STUDY, ATTEMPT, 'PDF'], ['x'.repeat(81), ATTEMPT, 'pdf']]) {
    assert.throws(() => vcrIntakeScratchPaths(study, attempt, format), { code: 'vcr_intake_input_invalid' }, `${study}/${attempt}/${format}`);
  }
});

test('no engine job can be pointed at the scratch: the domain grammar cannot spell it and the plane refuses it', () => {
  const { input, output, attempt, scratch } = vcrIntakeScratchPaths(STUDY, ATTEMPT, 'pdf');
  // Controls: the locations the engine is legitimately given are valid.
  for (const fine of ['studies/std_1/sources/src_1/abc.csv', 'derived/std_1/job_1/table.csv', 'studies/std_1/views/snp_1/abc.csv']) assert.equal(vcrLocationIsValid(fine), true, fine);
  for (const hidden of [input, output, attempt, scratch, `studies/${STUDY}/.pseudonym-key`]) assert.equal(vcrLocationIsValid(hidden), false, hidden);

  assert.equal(isVcrIntakeScratchLocation(input), true);
  assert.equal(isVcrIntakeScratchLocation(scratch), true);
  assert.equal(isVcrIntakeScratchLocation(`studies\\${STUDY}\\.intake\\x`), true);
  assert.equal(isVcrIntakeScratchLocation('studies/std_1/documents/abc.txt'), false);
  assert.equal(isVcrIntakeScratchLocation('studies/std_1/intake-notes/abc.txt'), false);
  assert.equal(isVcrIntakeScratchLocation(''), false);

  const root = '/srv/evimed/vcr-plane';
  assert.equal(assertDataPlaneLocation(root, 'studies/std_1/documents/abc.txt'), `${root}/studies/std_1/documents/abc.txt`);
  for (const where of [input, output, attempt, scratch]) {
    assert.throws(() => assertDataPlaneLocation(root, where), { status: 400, code: 'vcr_data_plane_location_outside' }, where);
  }
});

test('the ceilings the container is told besides the page count are fixed here, for the API and the controller alike', () => {
  assert.deepEqual({ ...VCR_INTAKE_LIMITS }, { maxChars: 1024 * 1024, maxXmlBytes: 24 * 1024 * 1024 });
  assert.throws(() => { /** @type {any} */ (VCR_INTAKE_LIMITS).maxChars = 1; }, TypeError);
});

test('an import is staged in the same scratch area under a file name of its own, and the two parsers refuse each other\'s file', () => {
  const paths = vcrIntakeImportPaths(STUDY, ATTEMPT, 'zip');
  assert.deepEqual(paths, {
    scratch: `studies/${STUDY}/.intake`, attempt: `studies/${STUDY}/.intake/${ATTEMPT}`, inputDirectory: `studies/${STUDY}/.intake/${ATTEMPT}/in`,
    input: `studies/${STUDY}/.intake/${ATTEMPT}/in/import.zip`, output: `studies/${STUDY}/.intake/${ATTEMPT}/out`,
  });
  assert.deepEqual({ ...VCR_IMPORT_FORMATS }, { fhir: ['ndjson', 'json', 'zip'], omop: ['zip'], adam: ['xpt', 'zip'] });
  assert.deepEqual([...VCR_IMPORT_EXTENSIONS].sort(), ['json', 'ndjson', 'xpt', 'zip']);
  for (const extension of VCR_IMPORT_EXTENSIONS) {
    const { input } = vcrIntakeImportPaths(STUDY, ATTEMPT, extension);
    assert.deepEqual(parseVcrIntakeImportInput(input), { studyId: STUDY, attemptId: ATTEMPT, extension, ...vcrIntakeImportPaths(STUDY, ATTEMPT, extension) });
    assert.throws(() => parseVcrIntakeInput(input), { code: 'vcr_intake_input_invalid' }, 'a record\'s parser does not take an import');
  }
  assert.throws(() => parseVcrIntakeImportInput(vcrIntakeScratchPaths(STUDY, ATTEMPT, 'pdf').input), { code: 'vcr_intake_input_invalid' }, 'an import\'s parser does not take a record');
  const good = vcrIntakeImportPaths(STUDY, ATTEMPT, 'xpt').input;
  for (const bad of ['', `${good}/`, `${good},readonly`, `${good}\n`, good.replace('import.xpt', 'import.exe'), good.replace('import.xpt', 'document.xpt'), good.replace('/in/', '/out/'),
    good.replace(STUDY, '..'), good.replace(ATTEMPT, 'x'), good.replace('.intake', 'incoming'), good.replace('studies/', ''), undefined, null, 7, {}]) {
    assert.throws(() => parseVcrIntakeImportInput(bad), { status: 400, code: 'vcr_intake_input_invalid' }, JSON.stringify(bad));
  }
  for (const [study, attempt, extension] of [['', ATTEMPT, 'zip'], [STUDY, 'x', 'zip'], [STUDY, ATTEMPT, 'csv'], [STUDY, ATTEMPT, 'ZIP'], [STUDY, ATTEMPT, 'pdf']]) {
    assert.throws(() => vcrIntakeImportPaths(study, attempt, extension), { code: 'vcr_intake_input_invalid' }, `${study}/${attempt}/${extension}`);
  }
  // It is under the same hidden segment: no engine location can spell it and the plane refuses it.
  assert.equal(vcrLocationIsValid(paths.input), false);
  assert.equal(isVcrIntakeScratchLocation(paths.input), true);
  assert.throws(() => assertDataPlaneLocation('/srv/evimed/vcr-plane', paths.input), { code: 'vcr_data_plane_location_outside' });
});

test('the table ceilings and the long operations are one definition, read by the plane, the container and the client', () => {
  assert.deepEqual({ ...VCR_TABLE_LIMITS }, { columns: 500, rows: 2_000_000 });
  assert.deepEqual([...VCR_INTAKE_LONG_KINDS], ['materials', 'convert']);
  assert.throws(() => { /** @type {any} */ (VCR_TABLE_LIMITS).rows = 1; }, TypeError);
});
