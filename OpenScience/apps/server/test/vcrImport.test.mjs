/**
 * A source held in FHIR, OMOP or ADaM, through the data plane: converted in the
 * deployment, stored the way a person's own files are, mapped from the standard,
 * every column labelled with where its values come from. The store is a small
 * in-memory double (the plane's SQL is covered by the integration suites, which
 * need PostgreSQL); the converter is the real script, run locally by
 * `helpers/vcrIntakeLocal.mjs` through the very launch plan the container gets.
 *
 * Every expected number was read from the committed fixture independently of the
 * converter (jq over the NDJSON, awk over the CSV, R's foreign::read.xport over
 * the transport files; see the notes in `test_vcr_import_convert.py`).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../src/security.mjs';
import {
  VcrDataPlane, analysisTableIssues, deriveAnalysisShapes, fileView, importAttemptAuditDetail, importAuditDetail, importExtensionOf, mergeImportedFieldMap,
  normalizeFieldMap, parseTable, validateFieldMap,
} from '../src/vcrDataPlane.mjs';
import { VCR_IMPORT_COUNTER_KEYS, createVcrImporter, decideImport, normalizeCoverage } from '../src/vcrImport.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';
import { MCP_DIR, localIntakeController, pythonCan } from './helpers/vcrIntakeLocal.mjs';

const HAVE_PYTHON = pythonCan('json', 'zipfile');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const FIXTURES = path.join(MCP_DIR, 'test', 'fixtures', 'vcr_imports');
const STUDY = 'study_1';
const SOURCE = 'src_1';
const sha = value => createHash('sha256').update(value).digest('hex');

function memoryStore(valueSource = 'observed') {
  /** @type {any[]} */
  const files = [];
  const source = { id: SOURCE, studyId: STUDY, userId: 'owner', status: 'registered', valueSource, fieldMap: { columns: [] }, fieldMapState: 'none', fieldMapHash: '', fieldMapBy: '' };
  return {
    files, source,
    async studyForAccess(id) { return id === STUDY ? { id, userId: 'owner' } : null; },
    async sourceInStudy(studyId, sourceId) { return studyId === STUDY && sourceId === SOURCE ? structuredClone(source) : null; },
    async addSourceFile(entry) {
      const existing = files.find(file => file.sourceId === entry.sourceId && file.sha256 === entry.sha256 && file.role === entry.role);
      if (existing) return { file: existing, created: false };
      const file = { id: `fil_${files.length + 1}`, studyId: entry.studyId, ...entry, detail: structuredClone(entry.detail ?? {}), createdAt: '2026-10-04T00:00:00.000Z' };
      files.push(file);
      return { file, created: true };
    },
    async setSourceStatus({ status }) { source.status = status; },
    async listSourceFiles() { return [...files]; },
    async listSourceFilesForStudy() { return [...files]; },
    async saveFieldMapDraft({ columns, hash, by }) {
      Object.assign(source, { fieldMap: { columns: structuredClone(columns) }, fieldMapState: 'proposed', fieldMapHash: hash, fieldMapBy: by });
      return structuredClone(source);
    },
  };
}

async function world(t, { valueSource = 'observed', controller = 'real', config = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-import-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const planeDir = path.join(root, 'plane');
  await fs.mkdir(planeDir);
  const appConfig = {
    dataDir: path.join(root, 'data'), vcrDataPlaneDir: planeDir, vcrDataPlaneHostDir: planeDir, vcrDataMaxBytes: 50 * 1024 * 1024, runtimeContainerImage: 'img',
    runtimeContainerUser: '1000:1000', runtimeDataVolume: '', vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000, vcrIntakeMaxBytes: 25 * 1024 * 1024, ...config,
  };
  await fs.mkdir(appConfig.dataDir, { recursive: true });
  const store = memoryStore(valueSource);
  const calls = [];
  const counters = {};
  const stand = controller === 'real' ? localIntakeController(appConfig, { calls }) : typeof controller === 'function' ? controller(appConfig, planeDir) : controller;
  const importer = createVcrImporter({ config: appConfig, controller: stand, counters });
  const plane = new VcrDataPlane({ store, config: appConfig, access: { require: async () => ({ allowed: true }) }, importer });
  const upload = async (name, bytes, format, extra = {}) => plane.importStandard({ actor: 'owner', studyId: STUDY, sourceId: SOURCE, name, format, stream: streamOf(bytes), ...extra });
  return { root, planeDir, config: appConfig, store, plane, importer, counters, calls, upload };
}
const attempts = async plane => (await fs.readdir(path.join(plane, 'studies')).catch(() => []).then(names => Promise.all(names.map(name => fs.readdir(path.join(plane, 'studies', name, '.intake')).catch(() => []))))).flat();
const smart = () => fs.readFile(path.join(FIXTURES, 'smart-10-patients.zip'));
const ndjson = (...rows) => Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

// --- the container's answer, decided here --------------------------------------

const GOOD = () => ({
  protocol: 1, outcome: 'converted', format: 'fhir', standard: { name: 'HL7 FHIR', release: 'R4' },
  converter: { name: 'evimed-import-convert', version: '1.0.0', libraries: { python: '3.12.3' } },
  tables: [{ name: 'fhir_patient', file: 'fhir_patient.csv', rows: 2, bytes: 100, sha256: 'a'.repeat(64), columns: [{ name: 'patient_id', valueSource: 'observed', label: 'id', unit: '', codingSystem: '' }] }],
  fieldMap: [{ table: 'fhir_patient.csv', column: 'patient_id', role: 'subject_key', valueSource: 'observed' }, { table: 'other.csv', column: 'x', role: 'other' }],
  dictionary: [{ column: 'fhir_patient.patient_id', label: 'id', unit: '' }],
  coverage: { inputs: [{ kind: 'Patient', records: 2, imported: 2, status: 'imported' }], skippedTables: [], notices: [] },
});
const limits = { maxTableBytes: 1000 };

test('a finished result is believed only as far as it can be checked: names, files, sizes, digests and sources', () => {
  const ok = decideImport({ format: 'fhir', result: GOOD(), limits });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.fieldMap.map(entry => entry.table), ['fhir_patient.csv'], 'an entry for a table that does not exist is not carried');
  assert.equal(ok.tables[0].name, 'fhir_patient');

  const refused = change => decideImport({ format: 'fhir', result: change(GOOD()), limits });
  for (const change of [
    result => ({ ...result, protocol: 2 }), result => ({ ...result, outcome: 'maybe' }), result => ({ ...result, format: 'omop' }), result => ({ ...result, tables: [] }),
    result => { result.tables[0].name = '../etc'; return result; }, result => { result.tables[0].name = 'omop_person'; return result; },
    result => { result.tables[0].file = 'other.csv'; return result; }, result => { result.tables[0].sha256 = 'zz'; return result; },
    result => { result.tables[0].bytes = 1001; return result; }, result => { result.tables[0].bytes = 0; return result; }, result => { result.tables[0].rows = -1; return result; },
    result => { result.tables[0].rows = 2_000_001; return result; }, result => { result.tables[0].columns = []; return result; },
    result => { result.tables.push(structuredClone(result.tables[0])); return result; },
  ]) assert.equal(refused(change).ok, false);
  assert.equal(decideImport({ format: 'fhir', result: null, limits }).ok, false);

  const sources = decideImport({ format: 'fhir', result: (() => { const r = GOOD(); r.tables[0].columns[0].valueSource = 'synthetic'; return r; })(), limits });
  assert.equal(sources.tables[0].columns[0].valueSource, 'observed', 'a source outside the four a column may have is not carried');
});

test('every reason the converter names is one refusal with a registered code, and an unknown reason is a failure', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  // A container that answers with a refusal of the given reason, written where the real script writes its result.
  const scripted = reason => (_config, planeDir) => ({
    async runVcrIntake(_kind, reference) {
      const out = path.join(planeDir, reference.path.replace(/\/in\/import\.[a-z]+$/, '/out'));
      await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ protocol: 1, outcome: 'refused', reason, format: 'fhir' }));
      return { finished: true };
    },
  });
  const expected = {
    not_fhir: [422, 'vcr_import_not_this_format'], not_json: [422, 'vcr_import_not_this_format'], not_zip: [422, 'vcr_import_not_this_format'], not_xpt: [422, 'vcr_import_not_this_format'],
    nothing_to_import: [422, 'vcr_import_nothing_to_import'], no_supported_resource: [422, 'vcr_import_nothing_to_import'], no_supported_table: [422, 'vcr_import_nothing_to_import'],
    corrupt: [422, 'vcr_import_unreadable'], encrypted: [422, 'vcr_import_unreadable'], xpt_version_unsupported: [422, 'vcr_import_version_unsupported'],
    too_large: [413, 'vcr_data_file_too_large'], deadline: [504, 'vcr_intake_timeout'], memory: [504, 'vcr_intake_timeout'],
    converter_missing: [503, 'vcr_import_converter_unavailable'], request_invalid: [409, 'vcr_intake_input_invalid'], surprise: [502, 'vcr_intake_failed'],
  };
  for (const [reason, [status, code]] of Object.entries(expected)) {
    const w = await world(t, { controller: scripted(reason) });
    const error = await w.upload('export.zip', Buffer.from('x'), 'fhir').catch(caught => caught);
    assert.equal(error.status, status, reason);
    assert.equal(error.code, code, reason);
    assert.equal(error.vcrDetail.reason, reason, 'the container\'s own reason travels with the refusal');
    assert.equal(w.store.files.length, 0);
    assert.deepEqual(await attempts(w.planeDir), []);
  }
});

test('the coverage that travels is rebuilt from a closed shape: counts are counts, words are clipped, nothing else passes', () => {
  const rebuilt = normalizeCoverage({
    inputs: [{ kind: 'Patient', records: 3, imported: 2, status: 'imported', skipped: { duplicate_patient_id: 1, 'bad key with spaces': 4, evil: 'x' }, secret: 'no' }, { kind: '' }, { kind: 'Device', records: -1, status: 'skipped', reason: 'unsupported_resource_type' }],
    skippedTables: [{ table: 'fhir_observation', reason: 'too_many_rows' }, { table: '' }],
    notices: [{ code: 'mixed_units', count: 2, examples: ['http://loinc.org|1|', 'x'.repeat(500)] }, { code: 'not a code', count: 1 }],
    other: 'ignored',
  });
  assert.deepEqual(rebuilt.inputs[0], { kind: 'Patient', records: 3, imported: 2, status: 'imported', reason: null, skipped: { duplicate_patient_id: 1 } });
  assert.deepEqual(rebuilt.inputs[1], { kind: 'Device', records: null, imported: 0, status: 'skipped', reason: 'unsupported_resource_type', skipped: {} });
  assert.equal(rebuilt.inputs.length, 2);
  assert.deepEqual(rebuilt.skippedTables, [{ table: 'fhir_observation', reason: 'too_many_rows' }]);
  assert.equal(rebuilt.notices.length, 1);
  assert.equal(rebuilt.notices[0].examples[1].length, 120);
  assert.ok(!JSON.stringify(rebuilt).includes('secret'));
});

// --- the plane's side of an import ---------------------------------------------

test('the extension an import is staged under is the standard\'s own, and the upload\'s name is never kept', () => {
  assert.equal(importExtensionOf('export.ZIP', 'omop'), 'zip');
  assert.equal(importExtensionOf('C:\\data\\patient (张三).ndjson', 'fhir'), 'ndjson');
  assert.equal(importExtensionOf('adsl.xpt', 'adam'), 'xpt');
  assert.throws(() => importExtensionOf('adsl.xpt', 'omop'), { status: 415, code: 'vcr_data_format_unsupported' });
  assert.throws(() => importExtensionOf('person.csv', 'omop'), { status: 415, code: 'vcr_data_format_unsupported' });
  assert.throws(() => importExtensionOf('noextension', 'fhir'), { status: 400, code: 'vcr_data_file_name_invalid' });
  assert.throws(() => importExtensionOf('', 'fhir'), { status: 400, code: 'vcr_data_file_name_invalid' });
  assert.throws(() => importExtensionOf('.zip', 'fhir'), { status: 400, code: 'vcr_data_file_name_invalid' });
});

test('an audit line says the standard, the tables taken and the upload\'s hash, never a name or a row', () => {
  const digest = sha('x');
  assert.equal(importAuditDetail({ format: 'fhir', input: { sha256: digest, bytes: 99 }, tables: [{ stored: true }, { stored: false }, { stored: true }] }), `fhir 2/3 tables 99B sha256:${digest}`);
  assert.equal(importAuditDetail({ format: 'patient-name', input: { sha256: 'not a digest' }, tables: [] }), '');
  assert.equal(importAttemptAuditDetail('omop', 1234), 'omop 1234B declared');
  assert.equal(importAttemptAuditDetail('张三.zip', 'x'), 'other');
});

test('a re-import replaces its own tables\' entries, keeps another file\'s, and renames a covariate that would collide', () => {
  const held = [
    { table: 'cohort.csv', column: 'SEX', role: 'covariate', alias: 'SEX' }, { table: 'cohort.csv', column: 'ID', role: 'subject_key' },
    { table: 'fhir_patient.csv', column: 'old', role: 'other' },
  ];
  const incoming = [
    { table: 'fhir_patient.csv', column: 'patient_id', role: 'subject_key', valueSource: 'observed' },
    { table: 'fhir_patient.csv', column: 'gender', role: 'covariate', alias: 'SEX', valueSource: 'observed', concept: 'Sex' },
    { table: 'fhir_patient.csv', column: 'age_at_index', role: 'covariate', alias: 'AGE', valueSource: 'calculated', concept: 'Age' },
  ];
  const merged = mergeImportedFieldMap({ existing: held, incoming, sourceValueSource: 'observed' });
  assert.deepEqual(merged.columns.map(entry => `${entry.table}:${entry.column}`), ['cohort.csv:SEX', 'cohort.csv:ID', 'fhir_patient.csv:patient_id', 'fhir_patient.csv:gender', 'fhir_patient.csv:age_at_index']);
  assert.equal(merged.columns.find(entry => entry.column === 'gender').alias, 'SEX_2');
  assert.equal(merged.columns.find(entry => entry.column === 'age_at_index').alias, 'AGE');
  assert.equal(merged.sourcesDeclared, true);
  assert.equal(merged.columns.find(entry => entry.column === 'age_at_index').valueSource, 'calculated');
  // The map is valid as a whole: one subject key a table, no analysis name twice.
  const { columns, issues } = normalizeFieldMap(merged.columns);
  assert.deepEqual(issues, []);
  assert.equal(columns.length, 5);
});

test('a source that is not a real person\'s rows takes no per-column sources, and a full map drops what says least', () => {
  const incoming = [{ table: 'fhir_patient.csv', column: 'a', role: 'other', valueSource: 'observed' }, { table: 'fhir_patient.csv', column: 'b', role: 'covariate', alias: 'B', valueSource: 'calculated' }];
  for (const sourceValueSource of ['synthetic', 'aggregate', 'predicted']) {
    const merged = mergeImportedFieldMap({ existing: [], incoming, sourceValueSource });
    assert.equal(merged.sourcesDeclared, false, sourceValueSource);
    assert.ok(merged.columns.every(entry => !('valueSource' in entry)), 'the whole source is what it is');
  }
  const many = Array.from({ length: 520 }, (_, index) => ({ table: 't.csv', column: `c${index}`, role: 'other', valueSource: 'observed' }));
  many.push({ table: 't.csv', column: 'important', role: 'covariate', alias: 'IMP', valueSource: 'observed' });
  const full = mergeImportedFieldMap({ existing: [], incoming: many, sourceValueSource: 'observed' });
  assert.equal(full.columns.length, 500);
  assert.equal(full.trimmed, 21);
  assert.ok(full.columns.some(entry => entry.column === 'important'), 'the column that says something stays');
});

// --- the whole import, through the real script ---------------------------------

test('a FHIR export becomes six tables, a dictionary and a proposed map, each column marked with its source', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  const bytes = await smart();
  const answer = await w.upload('bulk export (张三).zip', bytes, 'fhir');

  assert.deepEqual(answer.tables.map(table => [table.name, table.rows, table.stored]), [
    ['fhir_patient', 11, true], ['fhir_condition', 298, true], ['fhir_observation', 4188, true], ['fhir_medication', 172, true], ['fhir_procedure', 1341, true], ['fhir_encounter', 413, true],
  ]);
  assert.equal(answer.created, 6);
  assert.deepEqual(answer.input, { sha256: sha(bytes), bytes: bytes.length, format: 'fhir' });
  assert.equal(answer.standard.name, 'HL7 FHIR');
  assert.equal(answer.converter.name, 'evimed-import-convert');

  // The stored files are the module's ordinary data files and a dictionary, named by the standard and not by the upload.
  const data = w.store.files.filter(file => file.role === 'data');
  assert.deepEqual(data.map(file => file.name), ['fhir_patient.csv', 'fhir_condition.csv', 'fhir_observation.csv', 'fhir_medication.csv', 'fhir_procedure.csv', 'fhir_encounter.csv']);
  assert.ok(data.every(file => file.format === 'csv' && file.location.startsWith(`studies/${STUDY}/sources/${SOURCE}/`)));
  assert.ok(!JSON.stringify(w.store.files).includes('张三'), 'the upload\'s name is never kept');
  assert.deepEqual(data.map(file => file.rowCount), [11, 298, 4188, 172, 1341, 413]);
  assert.equal(data[0].detail.import.format, 'fhir');
  assert.equal(data[0].detail.import.uploadSha256, sha(bytes));
  assert.equal(fileView(data[0]).importFormat, 'fhir');
  const dictionary = w.store.files.find(file => file.role === 'dictionary');
  assert.equal(dictionary.name, 'fhir-dictionary.csv');
  assert.ok(dictionary.detail.dictionary.some(item => item.column === 'fhir_patient.os_days' && /calculated/.test(item.label) && item.unit === 'days'));
  assert.equal(w.store.source.status, 'profiled');

  // Nothing of the staging is left, in the plane or under the data volume.
  assert.deepEqual(await attempts(w.planeDir), []);
  assert.deepEqual(await fs.readdir(w.config.dataDir), []);

  // The proposal is the standard's own map, a person's to confirm.
  assert.equal(w.store.source.fieldMapState, 'proposed');
  assert.equal(w.store.source.fieldMapBy, 'import');
  assert.deepEqual(answer.fieldMap.entryIssues, []);
  assert.deepEqual(answer.fieldMap.mapIssues, []);
  const map = w.store.source.fieldMap.columns;
  assert.equal(answer.fieldMap.entries, map.length);
  assert.ok(map.every(entry => ['observed', 'calculated'].includes(entry.valueSource)), 'every imported column carries a value source');
  assert.deepEqual(map.filter(entry => entry.valueSource === 'calculated').map(entry => entry.column).sort(), ['age_at_index', 'birth_year', 'first_record_date', 'os_days', 'os_event']);
  assert.equal(answer.fieldMap.columnSourcesDeclared, true);
  assert.equal(map.find(entry => entry.column === 'os_event').codes.event[0], '1');

  // The coverage names what was not read.
  const unread = answer.coverage.inputs.find(input => input.kind === 'DiagnosticReport');
  assert.deepEqual([unread.status, unread.reason, unread.records], ['skipped', 'unsupported_resource_type', 780]);
  assert.equal(w.counters.importConverted, 1);
});

test('the imported tables and the proposed map derive the analysis tables the engine reads, with each column\'s source', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  await w.upload('export.zip', await smart(), 'fhir');
  const tables = [];
  for (const file of w.store.files.filter(item => item.role === 'data')) {
    const parsed = parseTable(await fs.readFile(path.join(w.planeDir, file.location), 'utf8'));
    tables.push({ name: file.name, header: parsed.header, rows: parsed.rows });
  }
  const checked = validateFieldMap(normalizeFieldMap(w.store.source.fieldMap.columns).columns, tables.map(table => ({ name: table.name, header: table.header })));
  assert.deepEqual(checked.issues, [], 'the generated map holds together against the generated files');

  const derived = deriveAnalysisShapes({ tables, entries: checked.columns, key: Buffer.alloc(32, 7), fileSource: 'observed' });
  // Eleven people; one death among them: one event (CNSR 0) and ten censored (CNSR 1), each with its index date.
  assert.equal(derived.shapes.subject.rows.length, 11);
  assert.equal(derived.identity.length, 11);
  const events = derived.shapes.events;
  assert.deepEqual(events.header, ['USUBJID', 'PARAMCD', 'AVAL', 'CNSR', 'STARTDT']);
  assert.equal(events.rows.length, 11);
  assert.deepEqual(events.rows.map(row => row[3]).sort(), ['0', '1', '1', '1', '1', '1', '1', '1', '1', '1', '1']);
  assert.ok(events.rows.every(row => row[1] === 'OS'));
  assert.equal(events.rows.find(row => row[3] === '0')[2], '3341', 'the one death: 1999-12-15 to 2009-02-06');
  assert.deepEqual(analysisTableIssues('events', events.rows.map(row => Object.fromEntries(events.header.map((name, index) => [name, row[index]])))).filter(issue => issue.blocking), []);
  // The weakest source of what the events table rests on is the computation, and the subject table says which columns are which.
  assert.equal(events.valueSource, 'calculated');
  assert.deepEqual(derived.shapes.subject.columnSources, { SEX: 'observed', BRTHYR: 'calculated', RACE: 'observed', ETHNIC: 'observed', AGE: 'calculated', DTHFL: 'observed' });
  assert.equal(derived.shapes.subject.valueSource, 'calculated');
  // The death columns are outcomes: flagged, so a confirmatory study's seal holds them with the pair.
  assert.equal(derived.shapes.subject.outcomeBearing, true);
});

test('a synthetic source takes the import without per-column sources, which its freeze would refuse', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t, { valueSource: 'synthetic' });
  const answer = await w.upload('export.zip', await smart(), 'fhir');
  assert.equal(answer.fieldMap.columnSourcesDeclared, false);
  assert.ok(w.store.source.fieldMap.columns.every(entry => !('valueSource' in entry)));
  assert.deepEqual(answer.fieldMap.mapIssues, []);
});

test('a table the plane cannot take is named and the others still land', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t, { config: { vcrDataMaxBytes: 1024 * 1024 } });
  const answer = await w.upload('export.zip', await smart(), 'fhir');
  // The observation table is 1.1 MB: past this deployment's 1 MB ceiling, so it is reported, not written, and nothing partial is stored.
  assert.deepEqual(answer.coverage.skippedTables, [{ table: 'fhir_observation', reason: 'table_too_large' }]);
  assert.deepEqual(answer.tables.map(table => table.name), ['fhir_patient', 'fhir_condition', 'fhir_medication', 'fhir_procedure', 'fhir_encounter']);
  assert.ok(!w.store.files.some(file => file.name === 'fhir_observation.csv'));
  assert.ok(!w.store.source.fieldMap.columns.some(entry => entry.table === 'fhir_observation.csv'));
});

test('a file that is not what it was declared to be is refused by name and stores nothing', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  await assert.rejects(w.upload('patients.ndjson', Buffer.from('patient_id,age\n1,40\n'), 'fhir'), { status: 422, code: 'vcr_import_not_this_format' });
  await assert.rejects(w.upload('patients.ndjson', ndjson({ id: 1 }), 'fhir'), { status: 422, code: 'vcr_import_not_this_format' });
  await assert.rejects(w.upload('only-staff.ndjson', ndjson({ resourceType: 'Practitioner', id: 'x' }), 'fhir'), { status: 422, code: 'vcr_import_nothing_to_import' });
  await assert.rejects(w.upload('broken.zip', Buffer.from('PK\u0003\u0004 not really'), 'fhir'), { status: 422, code: 'vcr_import_unreadable' });
  await assert.rejects(w.upload('x.zip', Buffer.from('hello'), 'fhir'), { status: 422, code: 'vcr_import_not_this_format' });
  const error = await w.upload('patients.ndjson', Buffer.from('a,b\n'), 'fhir').catch(caught => caught);
  assert.equal(error.vcrDetail.reason, 'not_json', 'the container\'s own reason travels with the refusal');
  assert.equal(w.store.files.length, 0);
  assert.equal(w.store.source.fieldMapState, 'none');
  assert.deepEqual(await attempts(w.planeDir), []);
  assert.equal(w.counters.importRefused, 6);
  assert.equal(w.counters.importConverted, 0);
});

test('a name or a format the standard is not uploaded as is refused before anything is staged', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  await assert.rejects(w.upload('export.zip', Buffer.from('x'), 'hl7v2'), { status: 400, code: 'vcr_payload_invalid' });
  await assert.rejects(w.upload('export.xpt', Buffer.from('x'), 'fhir'), { status: 415, code: 'vcr_data_format_unsupported' });
  await assert.rejects(w.upload('export.zip', Buffer.from('x'), 'fhir', { declaredLength: 26 * 1024 * 1024 }), { status: 413, code: 'vcr_data_file_too_large' });
  assert.equal(w.calls.length, 0, 'no container was asked for');
  assert.deepEqual(await attempts(w.planeDir), []);
});

test('an upload that outgrows the ceiling while it streams is cut off and nothing is left behind', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t, { config: { vcrIntakeMaxBytes: 1024 * 1024 } });
  // The ceiling is the intake ceiling, never under 10 MiB.
  await assert.rejects(w.upload('export.zip', Buffer.alloc(11 * 1024 * 1024, 1), 'fhir'), { status: 413, code: 'vcr_data_file_too_large' });
  assert.equal(w.calls.length, 0);
  assert.deepEqual(await attempts(w.planeDir), []);
  assert.equal(w.store.files.length, 0);
});

test('the launch plan of an import mounts the one input and the one output of the plane, with no network', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const w = await world(t);
  await w.upload('export.zip', await smart(), 'fhir');
  assert.equal(w.calls.length, 1);
  const [call] = w.calls;
  assert.equal(call.kind, 'convert');
  assert.deepEqual(call.reference.format, 'fhir');
  assert.equal(call.mounts.length, 2);
  const [input, output] = call.mounts;
  assert.ok(input.readonly && input.dst === '/input/import.zip' && input.src.startsWith(`${w.planeDir}/studies/${STUDY}/.intake/`) && input.src.endsWith('/in/import.zip'));
  assert.ok(!output.readonly && output.dst === '/output' && output.src.startsWith(`${w.planeDir}/studies/${STUDY}/.intake/`) && output.src.endsWith('/out'));
  assert.ok(![input.src, output.src].some(source => source.startsWith(w.config.dataDir)), 'nothing of the data volume');
});

test('a table that is not the file the result names is never stored', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  // The real script runs, and one byte of a table changes afterwards: the digest it was told no longer holds.
  const tampering = (config, planeDir) => {
    const real = localIntakeController(config);
    return {
      async runVcrIntake(kind, reference, options) {
        const done = await real.runVcrIntake(kind, reference, options);
        const target = path.join(planeDir, reference.path.replace(/\/in\/import\.zip$/, '/out/fhir_patient.csv'));
        await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace('female', 'femalX'));
        return done;
      },
    };
  };
  const w = await world(t, { controller: tampering });
  await assert.rejects(w.upload('export.zip', await smart(), 'fhir'), { status: 502, code: 'vcr_intake_failed' });
  assert.equal(w.store.files.filter(file => file.name === 'fhir_patient.csv').length, 0, 'the altered table was not stored');
  assert.deepEqual(await attempts(w.planeDir), []);
  assert.equal(w.counters.importFailed, 1);
});

test('a controller that is not composed, or cannot be reached, is the converter being unavailable', async t => {
  const none = await world(t, { controller: null });
  assert.equal(none.importer.available, false);
  assert.deepEqual(none.plane.importUpload(), { available: false, formats: [], maxBytes: null });
  await assert.rejects(none.upload('export.zip', Buffer.from('x'), 'fhir'), { status: 503, code: 'vcr_import_converter_unavailable' });

  const reports = [];
  const down = await world(t, { controller: { runVcrIntake: async () => { throw new HttpError(503, 'runtime_controller_unavailable', 'x'); } } });
  const importer = createVcrImporter({ config: down.config, controller: { runVcrIntake: async () => { throw new HttpError(503, 'runtime_controller_unavailable', 'x'); } }, report: code => reports.push(code) });
  const plane = new VcrDataPlane({ store: memoryStore(), config: down.config, access: { require: async () => ({ allowed: true }) }, importer });
  await assert.rejects(plane.importStandard({ actor: 'owner', studyId: STUDY, sourceId: SOURCE, name: 'export.zip', format: 'fhir', stream: streamOf(Buffer.from('x')) }), { status: 503, code: 'vcr_import_converter_unavailable' });
  assert.deepEqual(reports, ['runtime_controller_unavailable']);

  // What the page is told it may offer: the three standards and what each is uploaded as.
  const offer = down.plane.importUpload();
  assert.equal(offer.available, true);
  assert.deepEqual(offer.formats.map(format => format.value), ['fhir', 'omop', 'adam']);
  assert.deepEqual(offer.formats.find(format => format.value === 'adam').extensions, ['xpt', 'zip']);
  assert.equal(offer.maxBytes, 25 * 1024 * 1024);
  assert.deepEqual([...VCR_IMPORT_COUNTER_KEYS], ['importConverted', 'importRefused', 'importFailed']);
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

test('the external document parser is not reachable from the import path, and no request leaves this process', { skip: !HAVE_PYTHON && 'python3 is needed' }, async t => {
  const closure = await importClosure(['vcrImport.mjs', 'vcrIntakeStage.mjs', 'vcrIntakeController.mjs', 'vcrDataPlane.mjs']);
  for (const expected of ['vcrIntakeLayout.mjs', 'security.mjs', 'vcrAccess.mjs', 'dockerMounts.mjs']) assert.ok(closure.has(expected), `${expected} is in the closure; the walk ran`);
  for (const forbidden of ['documentParserClient.mjs', 'sourceService.mjs', 'sourceWorker.mjs', 'webRead.mjs', 'publicSourceGateway.mjs']) {
    assert.ok(!closure.has(forbidden), `${forbidden} must not be reachable from the import path`);
  }
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error('no network is part of this path'); };
  t.after(() => { globalThis.fetch = real; });
  const w = await world(t);
  await w.upload('export.zip', await smart(), 'fhir');
  assert.deepEqual(requests, []);
});
