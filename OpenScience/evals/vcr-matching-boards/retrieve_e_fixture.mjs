// A tiny official-format collection for the board E tests: five trials as public XML in one zip, ingested by ingest_e.py into the two index
// directories the runners expect. No network and nothing outside a temporary directory.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} label */
export const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `vcr-e-${label}-`));

/** One trial as a public-XML record. */
export function recordXml(nct, title, conditions, summary, eligibility, extra = '') {
  return `<clinical_study><id_info><nct_id>${nct}</nct_id></id_info><brief_title>${title}</brief_title><overall_status>Completed</overall_status>`
    + `<brief_summary><textblock>\n ${summary}\n</textblock></brief_summary><phase>Phase 2</phase>${conditions.map((c) => `<condition>${c}</condition>`).join('')}`
    + `<eligibility><criteria><textblock>\n ${eligibility}\n</textblock></criteria>${extra || '<gender>All</gender><minimum_age>18 Years</minimum_age><maximum_age>N/A</maximum_age>'}</eligibility></clinical_study>`;
}
export const TRIALS = [
  recordXml('NCT00000001', 'Osimertinib after progression in EGFR lung cancer', ['Lung Cancer'], 'EGFR positive lung adenocarcinoma after osimertinib.', 'Inclusion Criteria:\n- EGFR mutation'),
  recordXml('NCT00000002', 'Chemotherapy for lung cancer', ['Lung Cancer'], 'Platinum doublet in lung cancer.', 'Inclusion Criteria:\n- lung cancer'),
  recordXml('NCT00000003', 'Pediatric migraine prevention', ['Migraine'], 'Prevention of migraine in children.', 'Inclusion Criteria:\n- child with migraine',
    '<gender>All</gender><minimum_age>6 Years</minimum_age><maximum_age>17 Years</maximum_age>'),
  recordXml('NCT00000004', 'Migraine in adults', ['Migraine'], 'Adult migraine.', 'Inclusion Criteria:\n- adult', '<gender>Female</gender><minimum_age>18 Years</minimum_age><maximum_age>65 Years</maximum_age>'),
  recordXml('NCT00000005', 'Glaucoma pressure drops', ['Glaucoma'], 'Primary open angle glaucoma.', 'Inclusion Criteria:\n- POAG'),
];

/** Build the two collections the runners expect out of one zip of the fixture, with the real ingest script. Returns the directory. */
export function buildCollections() {
  const root = tmp('coll');
  const zip = path.join(root, 'fixture.zip');
  const script = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1], "w")',
    'for i, line in enumerate(sys.stdin.read().split("\\u0001")): z.writestr("a/r%d.xml" % i, line)',
    'z.close()',
  ].join('\n');
  const made = spawnSync('python3', ['-I', '-B', '-c', script, zip], { input: TRIALS.join('\u0001'), encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  for (const [dir, id, snapshot] of [['index2021', 'trec-ct-2021', '2021-04-27'], ['index2023', 'trec-ct-2023', '2023-05-08']]) {
    const index = path.join(root, dir);
    for (const args of [['add', '--zip', zip, '--index', index, '--id', id, '--min-free-gb', '0'], ['seal', '--index', index, '--id', id, '--snapshot', snapshot, '--expect-docs', '5', '--min-free-gb', '0']]) {
      const ran = spawnSync('python3', ['-I', '-B', path.join(HERE, 'ingest_e.py'), ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: root } });
      assert.equal(ran.status, 0, ran.stderr);
    }
  }
  return root;
}

