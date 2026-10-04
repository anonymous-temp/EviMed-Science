import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrLocationIsValid } from '@evimed/domain';
import { assertDataPlaneLocation } from '../src/vcrDataPlane.mjs';
import {
  VCR_INTAKE_DOCUMENT_FORMATS, VCR_INTAKE_LIMITS, VCR_INTAKE_SCRATCH, isVcrIntakeScratchLocation, parseVcrIntakeInput, vcrIntakeScratchPaths,
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
