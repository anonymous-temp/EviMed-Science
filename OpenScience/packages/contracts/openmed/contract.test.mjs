import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
const json = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));

test('selective OpenMed adoption is pinned and inventories every reviewed surface', async () => {
  const pins = await json('../../../deps-version.json');
  assert.equal(pins.openmed.version, '3.0.0');
  assert.equal(pins.openmed.commit, 'ea920f36fadd7b45935247d639f0ffa1ef493b23');
  assert.equal(pins.openmed.adoptionMode, 'reference-contracts-and-evaluation-only');
  const ledger = await json('implementation.json');
  assert.equal(new Set(ledger.tasks.map(row => row.id)).size, 52);
  for (const row of ledger.tasks) {
    assert.ok(row.owner && row.nativeIntegrationPoints.length);
    assert.ok(Array.isArray(row.evidence));
    if (row.status === 'verified') assert.ok(row.evidence.length > 0, row.id);
    assert.ok(ledger.statusMeaning[row.status], row.id);
    assert.ok(row.evidence.length > 0 && Array.isArray(row.remaining), row.id);
    for (const file of row.evidence) await access(new URL(`../../../${file}`, import.meta.url));
    if (row.status === 'ready_waiting_for_data') assert.ok(row.remaining.length, row.id);
  }
  const scorecard = await json('../../../evals/vcr-matching/openmed-scorecard.json');
  assert.equal(scorecard.independentClinicalValidation, false);
  assert.equal(scorecard.productionEnabled, false);
  const catalogue = await readFile(new URL('capability-decisions.csv', import.meta.url), 'utf8');
  assert.equal([...catalogue.matchAll(/^C\d{3},/gm)].length, 152);
  for (const manifest of ['../../../apps/server/package.json', '../../../apps/web/package.json', '../../socket/package.json']) {
    const pkg = await json(manifest);
    assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => /^(openmed|torch|transformers|mlx)$/.test(name)));
  }
});

// The eight tasks that wait for a licensed, partner or independently labelled input (2026-10-10 owner ruling):
// they read "ready, waiting for data" - not open work, not closed, not switched off - and each says what its
// input turns on. Every place that states a task's status uses the same words and the same counts.
const WAITING_FOR_DATA = ['B03', 'E01', 'F01', 'F02', 'F03', 'F04', 'F05', 'F06'];
const FORMER_WORDS = ['conditional_not_activated', 'external_validation_required'];

test('the tasks waiting for licensed or partner data are ready, each naming its input and what arrival switches on', async () => {
  const ledger = await json('implementation.json');
  assert.deepEqual(ledger.tasks.filter(row => row.status === 'ready_waiting_for_data').map(row => row.id), WAITING_FOR_DATA);
  for (const word of FORMER_WORDS) {
    assert.equal(ledger.statusMeaning[word], undefined, `${word} is no longer a status`);
    assert.ok(!ledger.tasks.some(row => row.status === word), word);
  }
  assert.match(ledger.statusMeaning.ready_waiting_for_data, /Neither open work nor closed/);
  for (const row of ledger.tasks.filter(task => WAITING_FOR_DATA.includes(task.id))) {
    assert.ok(FORMER_WORDS.includes(row.formerStatus), `${row.id} keeps the word it replaced`);
    assert.equal(typeof row.waitingFor, 'string', row.id);
    assert.ok(row.waitingFor.length > 20, row.id);
    for (const field of ['readyBecause', 'onArrival']) {
      assert.ok(Array.isArray(row[field]) && row[field].length >= 1, `${row.id}.${field}`);
      assert.ok(row[field].every(line => typeof line === 'string' && line.length > 20), `${row.id}.${field}`);
    }
    // Waiting is not validation: the input is still external, and nothing is relabelled verified.
    assert.equal(row.validationStatus, 'external_prerequisite', row.id);
  }
});

test('every place that states the task statuses uses the ledger words and counts', async () => {
  const ledger = await json('implementation.json');
  const counts = {};
  for (const row of ledger.tasks) counts[row.status] = (counts[row.status] ?? 0) + 1;
  assert.deepEqual(counts, { implemented: 38, native_reused: 6, ready_waiting_for_data: 8 });
  assert.deepEqual(ledger.statusCounts, counts);
  assert.deepEqual(ledger.localReview20261010.coverageCounts, counts);
  assert.deepEqual(ledger.functionalRecheck20261010.counts, counts);
  const scorecard = await json('../../../evals/vcr-matching/openmed-scorecard.json');
  assert.deepEqual(scorecard.taskDispositions, counts);
  for (const file of ['../../../evals/vcr-matching/openmed-scorecard.json', '../healthflux/implementation.json', '../../../docs/WEB_OPERATIONS_RUNBOOK.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const word of FORMER_WORDS) assert.ok(!text.includes(word), `${file} still says ${word}`);
  }
  const runbook = await readFile(new URL('../../../docs/WEB_OPERATIONS_RUNBOOK.md', import.meta.url), 'utf8');
  assert.match(runbook, /ready_waiting_for_data/);
});

test('data admission is specific to a frozen corpus, edition and operation', async () => {
  const policy = await json('data-rights.json');
  assert.equal(policy.default, 'deny_unlisted_data_operation');
  assert.equal(new Set(policy.resources.map(row => row.id)).size, policy.resources.length);
  for (const row of policy.resources) {
    assert.ok(['admitted', 'conditional', 'excluded'].includes(row.decision));
    if (row.decision === 'admitted') assert.ok(row.revision && row.source && row.licenseEvidence && row.purposes.length);
    else assert.deepEqual(row.purposes, []);
  }
  assert.equal(policy.resources.filter(row => row.decision === 'admitted').length, 1);
  const selection = await json('../../../evals/vcr-matching/corpora/drugprot/selection.json');
  assert.equal(selection.cases.length, 10);
  assert.equal(new Set(selection.cases.map(row => row.pmid)).size, 10);
  assert.equal(selection.archiveSha256, policy.resources.find(row => row.id === 'drugprot-5119892-pilot').archiveSha256);
});
