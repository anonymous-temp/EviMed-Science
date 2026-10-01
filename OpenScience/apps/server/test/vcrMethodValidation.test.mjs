import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VCR_ENGINE_METHODS } from '@evimed/domain';
import { assertMethodValidationFile, parseMethodValidation, bindMethodValidation, loadMethodValidation, validatedMethods } from '../src/vcrMethodValidation.mjs';
import { presentModels } from '../src/vcrViews.mjs';

const method = 'design.analytic';
const identity = { ok: true, rVersion: '4.3.3', numericalSourceDigest: 'a'.repeat(64), packageLockHash: 'b'.repeat(64) };
const artifact = () => ({ schemaVersion: 1, sourceRevision: 'c'.repeat(40), ...Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'ok')),
  ci: { runId: '101', jobId: '202', url: 'https://github.com/example/project/actions/runs/101', headSha: 'c'.repeat(40), status: 'success', reportSha256: 'd'.repeat(64), completedAt: '2026-09-30T10:00:00Z' },
  methods: [{ method, version: VCR_ENGINE_METHODS[method].version, assumptions: [{ text: 'Explicit test fixture assumption.', source: 'R/design_analytic.R:1' }],
    numericTests: { status: 'passed', caseIds: ['N01-reference'], referenceCases: [{ caseId: 'N01-reference', reference: 'Analytic fixture equation' }] } }] });

test('numerical evidence requires the exact source, runtime, lock and completed CI identity', () => {
  const parsed = parseMethodValidation(artifact());
  const accepted = bindMethodValidation(parsed, identity);
  assert.equal(accepted.status, 'verified');
  assert.equal(bindMethodValidation(parsed, { ...identity, rVersion: 'R version 4.3.3 (2024-02-29)' }).status, 'verified');
  for (const patch of [{ numericalSourceDigest: 'e'.repeat(64) }, { packageLockHash: 'e'.repeat(64) }, { rVersion: '4.4.0' }, { ok: false }, { numericalSourceDigest: null }]) {
    assert.equal(bindMethodValidation(parsed, { ...identity, ...patch }).status, 'unmeasured');
  }
  for (const change of [value => { value.ci.headSha = 'e'.repeat(40); }, value => { value.ci.status = 'failure'; },
    value => { value.methods[0].numericTests.referenceCases = []; }, value => { value.methods[0].numericTests.referenceCases[0].caseId = 'unexecuted'; },
    value => { value.methods[0].version = 'unknown'; }, value => { value.ci.url = 'javascript:alert(1)'; },
    value => { value.methods.push(value.methods[0]); }]) {
    const value = artifact(); change(value); assert.throws(() => parseMethodValidation(value));
  }
});

test('stored or model-authored counts cannot create a validation badge and absent methods stay unmeasured', () => {
  const rows = [{ id: 'm1', method, version: VCR_ENGINE_METHODS[method].version, numericTests: { passed: 999, total: 999 } },
    { id: 'm2', method: 'comparator.rmst', version: VCR_ENGINE_METHODS['comparator.rmst'].version }];
  const show = validation => presentModels({ methods: validatedMethods(rows, validation), models: [], usedBy: new Map(), engineAvailable: true, engineMismatch: null });
  assert.equal(show({ status: 'unmeasured', reason: 'not_configured' }).methods[0].numeric, null);
  const current = show(bindMethodValidation(parseMethodValidation(artifact()), identity));
  assert.equal(current.methods[0].numeric, '1 个参考用例通过');
  assert.equal(current.methods[0].validation.ciUrl, artifact().ci.url);
  assert.equal(current.methods[1].numeric, null);
  assert.equal(current.methods[1].validation.status, 'unmeasured');
  assert.equal(show(bindMethodValidation(parseMethodValidation(artifact()), { ...identity, numericalSourceDigest: 'e'.repeat(64) })).methods[0].numeric, null);
});

test('only bounded root-owned non-writable regular files can supply method evidence', async () => {
  const stat = { uid: 0, mode: 0o100644, size: 100, nlink: 1, isFile: () => true };
  assert.doesNotThrow(() => assertMethodValidationFile(stat));
  for (const patch of [{ uid: 501 }, { mode: 0o100666 }, { size: 1024 * 1024 + 1 }, { nlink: 2 }, { isFile: () => false }]) {
    assert.throws(() => assertMethodValidationFile({ ...stat, ...patch }));
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'method-proof-')));
  try {
    const file = path.join(root, 'proof.json'); await fs.writeFile(file, JSON.stringify(artifact()), { mode: 0o644 });
    const link = path.join(root, 'link.json'); await fs.symlink(file, link);
    assert.equal((await loadMethodValidation({ file: link, health: identity })).status, 'unmeasured');
    if (process.getuid?.() !== 0) assert.equal((await loadMethodValidation({ file, health: identity })).reason, 'file_untrusted');
    assert.equal((await loadMethodValidation({ file: '', health: identity })).reason, 'not_configured');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
