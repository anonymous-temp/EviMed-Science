/** Freeze non-TREC runtime inputs apart from scoring labels. No provider calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { incidentInputs, assertAcceptanceCase } from './acceptance-inputs.mjs';
import { CRITERIA } from '../vcr-matching/n2c2/criteria.mjs';
import { contentDigest } from '../../packages/patient-matching-core/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); };
const lines = async (file, values) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, values.map(value => JSON.stringify(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 }); };
const python = (exe, code, args = []) => { const result = spawnSync(exe, ['-I', '-B', '-c', code, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }); if (result.status !== 0) throw new Error(result.stderr); };
export async function prepareAcceptance({ out, authority, annotations, criterionCollection, previousN2c2, n2c2Root, pythonPath = 'python3' }) {
  const approved = await read(authority), inputs = path.join(out, 'inputs'), scoring = path.join(out, 'scoring');
  const parquet = await fs.readFile(annotations);
  assert.equal(contentDigest(parquet), 'sha256:14c547184fac9b013cd17441fd028845b40150c76b022e58334f5494077e5234');
  python(pythonPath, `import sys,json,pathlib;sys.path.insert(0,sys.argv[1]);import prepare
cases,seven,labels=prepare.criterion_board(prepare.read_annotations(pathlib.Path(sys.argv[2])))
for filename,rows in [(sys.argv[3],cases),(sys.argv[4],labels)]:
 p=pathlib.Path(filename);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\\n' for r in rows));p.chmod(0o600)
`, [path.join(HERE, '../vcr-matching-boards'), annotations, path.join(scoring, 'boards/C-criterion/cases.jsonl'), path.join(scoring, 'labels/C-criterion/labels.jsonl')]);
  const cCases = (await fs.readFile(path.join(scoring, 'boards/C-criterion/cases.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const cCollection = await read(criterionCollection);
  assert.equal(cCollection.sourceVersion, 'trialgpt-sigir-1b3242cd50c1');
  const cDatabase = path.resolve(path.dirname(criterionCollection), cCollection.databasePath);
  assert.equal(contentDigest(await fs.readFile(cDatabase)), `sha256:${cCollection.databaseSha256}`);
  await write(path.join(inputs, 'criterion-collection.json'), { ...cCollection, databasePath: cDatabase });
  const runtimeC = cCases.map(one => assertAcceptanceCase({ caseId: one.caseId, patientId: one.patientId, cohort: 'criterion', collection: cCollection.id,
    split: 'regression', note: one.note, candidateIds: one.trials.map(trial => trial.registryId), candidateCount: one.trials.length, dataClass: 'public-benchmark-vignette' }));
  await lines(path.join(inputs, 'criterion-cases.jsonl'), runtimeC);
  await write(path.join(scoring, 'criterion-trials.json'), Object.fromEntries(cCases.map(one => [one.patientId, one.trials])));
  // Reuse the existing public synthetic source builder with expectations removed before it receives fixtures.
  const incidents = await read(path.join(HERE, '../vcr-matching-boards/incidents.json'));
  const trials = path.join(inputs, 'incident-trials'); await fs.mkdir(trials, { recursive: true, mode: 0o700 });
  for (const [index, one] of incidents.entries()) await write(path.join(trials, `NCT9${String(index + 1).padStart(7, '0')}.json`),
    { nctid: `NCT9${String(index + 1).padStart(7, '0')}`, study_type: 'INTERVENTIONAL', phases: ['PHASE2'], overall_status: 'RECRUITING', ...one.trial });
  python(pythonPath, `import sys;sys.path.insert(0,sys.argv[1]);import prepare;prepare.build_collection(sys.argv[2],sys.argv[3],'sigir')`,
    [path.join(HERE, '../vcr-matching-boards'), trials, path.join(inputs, 'incident-collection')]);
  await lines(path.join(inputs, 'incident-cases.jsonl'), incidentInputs(incidents));
  await write(path.join(scoring, 'incident-expectations.json'), incidents.map(one => ({ id: one.id, source: one.source, expect: one.expect })));
  // The previously authorized test source is checked against its original raw XML bytes; no gold archive is opened.
  const nCasesPath = path.join(previousN2c2, 'test/cases.json'), nProvenancePath = path.join(previousN2c2, 'test/provenance.json');
  const nCases = await read(nCasesPath), nProvenance = await read(nProvenancePath);
  const nOriginal = nProvenance.cases ?? nProvenance.patients;
  assert.equal(nCases.cases.length, 86); assert.equal(nOriginal.length, 86);
  const runtimeF = [], fMapping = [];
  for (let index = 0; index < nCases.cases.length; index++) {
    const one = nCases.cases[index], source = nOriginal.find(row => row.caseId === one.id); assert.ok(source);
    const xml = await fs.readFile(path.join(n2c2Root, 'work/test/test_notags', `${source.originalXmlId}.xml`));
    assert.equal(contentDigest(xml), `sha256:${source.xmlSha256}`);
    const from = xml.toString().indexOf('<TEXT><![CDATA['), to = xml.toString().lastIndexOf(']]></TEXT>'); assert.ok(from >= 0 && to > from);
    const note = xml.toString().slice(from + '<TEXT><![CDATA['.length, to);
    assert.equal(contentDigest(note), `sha256:${source.textSha256}`);
    const patientId = `n2c2-${source.originalXmlId}`;
    runtimeF.push(assertAcceptanceCase({ caseId: one.id, patientId, cohort: 'n2c2', collection: 'tg2-sigir', split: 'test-replay', note,
      candidateIds: [], candidateCount: 1, dataClass: 'deidentified-clinical' }));
    fMapping.push({ frozenCaseId: one.id, patientId, xmlDigest: contentDigest(xml), noteDigest: contentDigest(note), asOf: one.asOf });
  }
  await lines(path.join(inputs, 'n2c2-cases.jsonl'), runtimeF);
  await write(path.join(scoring, 'n2c2-binding.json'), fMapping);
  const protocolPath = path.join(inputs, 'n2c2-protocol.txt');
  await fs.writeFile(protocolPath, 'Inclusion Criteria:\n\n' + CRITERIA.map(one => '* ' + one.sourceText).join('\n\n'), { flag: 'wx', mode: 0o600 });
  const definitions = {};
  for (const [board, casesFile, collectionFile] of [['incidents', 'incident-cases.jsonl', 'incident-collection/collection.json'], ['criterion', 'criterion-cases.jsonl', 'criterion-collection.json'], ['n2c2', 'n2c2-cases.jsonl', 'criterion-collection.json']]) {
    const cases = path.join(inputs, casesFile), collection = path.join(inputs, collectionFile);
    definitions[board] = { cases, casesDigest: contentDigest(await fs.readFile(cases)), collection, collectionDigest: contentDigest(await fs.readFile(collection)) };
  }
  definitions.n2c2.protocolPath = protocolPath; definitions.n2c2.protocolDigest = contentDigest(await fs.readFile(protocolPath));
  const inputDigests = {};
  for (const [name, file] of Object.entries({ annotations, criterionCollection, nCasesPath, nProvenancePath })) inputDigests[name] = contentDigest(await fs.readFile(file));
  const harnessSources = {};
  for (const name of ['acceptance-host.mjs', 'acceptance-inputs.mjs', 'acceptance-prepare.mjs', 'acceptance-export.mjs', 'acceptance-source.mjs', 'campaign-runtime.mjs', 'campaign-host.mjs', 'campaign-budget.mjs']) {
    const filename = path.join(HERE, name); harnessSources[filename] = contentDigest(await fs.readFile(filename));
  }
  const harnessSourcePath = path.join(out, 'harness-sources.json');
  await write(harnessSourcePath, harnessSources);
  await write(path.join(out, 'preparation.json'), { kind: 'native-non-trec-acceptance-preparation', cases: { incidents: 17, criterion: 53, n2c2: 86 }, pairs: { incidents: 17, criterion: 105, n2c2: 86 },
    annotationRows: 1015, inputDigests, fBindingDigest: contentDigest(JSON.stringify(fMapping)), clinicalDataClass: 'deidentified-clinical',
    priorExposure: 'All C/F patients are previously inspected regression/replay inputs, not a fresh holdout.', localLimitCny: 40, globalLimitCny: 500, retries: 0, repeats: 1 });
  await write(path.join(scoring, 'boards/manifest.json'), { inputsDigest: contentDigest(JSON.stringify(inputDigests)), narrowed: 'C criterion regression only; no ranking benchmark or TREC execution' });
  const config = { ...approved, out: path.join(out, 'run'), boards: definitions, localLimitCny: 40, allowProviderCalls: false, sessionNamespace: 'non-trec-20261105-v1' };
  config.harnessSources = harnessSourcePath; config.harnessSourcesDigest = contentDigest(await fs.readFile(harnessSourcePath));
  config.executionStatus = 'user-skipped';
  delete config.sourceRepair; delete config.userSkippedBoards;
  await write(path.join(out, 'config.json'), config);
  return { cases: 156, pairs: 208, localLimitCny: 40, allowProviderCalls: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['out', 'authority', 'annotations', 'criterion-collection', 'previous-n2c2', 'n2c2-root', 'python'].map(key => [key, { type: 'string' }])) });
  console.log(JSON.stringify(await prepareAcceptance({ out: path.resolve(values.out), authority: values.authority, annotations: values.annotations, criterionCollection: values['criterion-collection'], previousN2c2: values['previous-n2c2'], n2c2Root: values['n2c2-root'], pythonPath: values.python })));
}
