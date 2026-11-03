import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { crossCheckLabelProblems, packagesNamedBy } from '../../ops/vcr-method-references.mjs';

const script = new URL('../check-method-references.mjs', import.meta.url).pathname;
const locked = new Set(['simsurv', 'IPDfromKM', 'meta', 'synthpop', 'metafor', 'sandwich']);
const file = text => [{ path: 'tests/numeric/Nxx.R', bytes: Buffer.from(text) }];

test('a label names a package only by its exact name as a word', () => {
  assert.deepEqual(packagesNamedBy('simsurv (exponential and Weibull event times)', locked), ['simsurv']);
  assert.deepEqual(packagesNamedBy('metafor::rma maximum-likelihood fit', locked), ['metafor']);
  assert.deepEqual(packagesNamedBy('meta engine', locked), ['meta']);
  assert.deepEqual(packagesNamedBy('simstudy semantics', locked), [], 'simstudy is in no lock');
  assert.deepEqual(packagesNamedBy('metaanalysis, IPDfromKMx', locked), [], 'a longer word is another word');
  assert.deepEqual(packagesNamedBy('closed-form published equation evaluation', locked), []);
});

test('a label that names a locked package no case calls is a problem; a call makes it true', () => {
  const methods = {
    'patients.time_to_event': { crossChecks: ['simsurv'] },
    'evidence.reconstruct_km': { crossChecks: ['IPDfromKM'] },
    'evidence.pool': { crossChecks: ['metafor', 'meta engine'] },
    'population.synthpop': { crossChecks: ['synthpop'] },
    'population.scenario': { crossChecks: ['simstudy semantics'] },
  };
  const cases = file('x <- stats::sd(y)\n# simsurv::simsurv( is only talked about here\nlibrary(IPDfromKM)\nr <- metafor::rma(yi, vi)\n');
  const got = crossCheckLabelProblems(methods, locked, cases).map(p => `${p.method}:${p.packageName}`).sort();
  assert.deepEqual(got, ['evidence.pool:meta', 'patients.time_to_event:simsurv', 'population.synthpop:synthpop']);
  const fixed = file('s <- simsurv::simsurv(dist = "weibull")\nlibrary(IPDfromKM)\nif (!requireNamespace("synthpop", quietly = TRUE)) stop("x")\nmetafor::rma(yi, vi)\nmeta::metabin(1)\n');
  assert.deepEqual(crossCheckLabelProblems(methods, locked, fixed), []);
});

test('only a call counts: a longer package name and a comment line do not', () => {
  const methods = { m: { crossChecks: ['meta'] } };
  assert.equal(crossCheckLabelProblems(methods, locked, file('metafor::rma(y)\nlibrary(metafor)\n')).length, 1, 'metafor:: is not meta::');
  assert.equal(crossCheckLabelProblems(methods, locked, file('  # meta::metabin(1)\nx <- 1\n')).length, 1, 'a comment line is not a call');
  assert.equal(crossCheckLabelProblems(methods, locked, file('library(meta)\n')).length, 0);
  assert.equal(crossCheckLabelProblems(methods, locked, file('requireNamespace("meta", quietly = TRUE)\n')).length, 0);
  assert.equal(crossCheckLabelProblems({ m: { crossChecks: 'meta' } }, locked, file('x <- 1\n')).length, 1, 'a single label written as a string is still read');
});

test('the engine as committed passes the whole check, labels included', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all \d+ dispatched methods have a reference case/);
});
