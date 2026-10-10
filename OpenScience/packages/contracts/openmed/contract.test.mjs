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
    if (row.status === 'conditional_not_activated' || row.status === 'external_validation_required') assert.ok(row.remaining.length, row.id);
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
