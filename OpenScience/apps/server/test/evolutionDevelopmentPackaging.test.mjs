import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WEB_DOCKERFILE_SHA256 } from '../../../scripts/ops/release-full-build.mjs';
test('production image carries explicit public development contracts and reviewed recipe pin', async () => {
  const recipe = await fs.readFile(new URL('../../../deploy/web/Dockerfile', import.meta.url), 'utf8');
  const line = recipe.split('\n').find(value => value.startsWith('COPY --from=build /app/evals/paper-gold/development-contract.json '));
  assert.ok(line);
  for (const name of ['development-contract.json', 'diagnostic-posterior-development.json', 'decision-net-benefit-development.json']) {
    assert.ok(line.includes(`/app/evals/paper-gold/${name}`));
    const contract = JSON.parse(await fs.readFile(new URL(`../../../evals/paper-gold/${name}`, import.meta.url), 'utf8'));
    assert.ok(contract.cases.length);
  }
  assert.ok(!line.includes('*.json'));
  assert.equal(WEB_DOCKERFILE_SHA256, 'sha256:' + createHash('sha256').update(recipe).digest('hex'));
});

test('literal production evaluator resource reads close over explicitly copied public files', async () => {
  const sourceRoot = new URL('../src/', import.meta.url), recipe = await fs.readFile(new URL('../../../deploy/web/Dockerfile', import.meta.url), 'utf8');
  const sources = (await fs.readdir(sourceRoot)).filter(name => /^(?:evolution|paperGold|existingEngine).*\.mjs$/.test(name));
  const expected = new Set();
  for (const name of sources) {
    const source = await fs.readFile(new URL(name, sourceRoot), 'utf8');
    for (const match of source.matchAll(/new URL\(["']\.\.\/\.\.\/\.\.\/evals\/paper-gold\/([^"']+)["']/g)) if (!match[1].includes('${')) expected.add(match[1]);
  }
  assert.ok(expected.has('economics-reference-manifest.json'));
  assert.ok(expected.has('calibration-manifest.json'));
  assert.ok(expected.has('score_existing_methods.py'));
  for (const name of expected) assert.ok(recipe.includes(`/app/evals/paper-gold/${name}`) || name.endsWith('.mjs') && recipe.includes('/app/evals/paper-gold/*.mjs'), `Production resource missing: ${name}`);
});

test('shipped acceptance helpers have explicit public repository resource closure', async () => {
  const root = new URL('../../../scripts/ops/', import.meta.url), recipe = await fs.readFile(new URL('../../../deploy/web/Dockerfile', import.meta.url), 'utf8');
  for (const name of (await fs.readdir(root)).filter(name => /^evolution.*acceptance.*\.mjs$/.test(name))) {
    const source = await fs.readFile(new URL(name, root), 'utf8');
    for (const match of source.matchAll(/new URL\(["']\.\.\/\.\.\/evals\/paper-gold\/([^"']+)["']/g)) assert.ok(recipe.includes(`/app/evals/paper-gold/${match[1]}`), `Shipped helper resource missing: ${match[1]}`);
  }
});
