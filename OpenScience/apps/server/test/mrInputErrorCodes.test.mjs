import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recoverableEvidenceSourceErrorCodes, terminalEvidenceSourceErrorCodes } from '@evimed/domain';

test('every hosted MR input error has an explicit dependency or invalid-input classification', async () => {
  const source = (await Promise.all(['evimed_local_inputs.py', 'evimed_mr_job.py'].map((name) =>
    readFile(new URL(`../../../../项目代码/孟德尔随机化/${name}`, import.meta.url), 'utf8'),
  ))).join('\n');
  const codes = new Set([...source.matchAll(/MRInputError\(\s*["'](mr_input_[a-z_]+)["']/g)].map((match) => match[1]));
  assert.equal(codes.size, 9);
  for (const code of codes) {
    const dependency = ['mr_input_remote_auth_required', 'mr_input_remote_metadata_unavailable'].includes(code);
    assert.equal(recoverableEvidenceSourceErrorCodes.has(code), dependency, code);
    assert.equal(terminalEvidenceSourceErrorCodes.has(code), !dependency, code);
  }
});

// The registry classified every open GWAS Catalog refusal on the day the path
// shipped, but the adapter between the engine and the run forwarded none of
// them: on 2026-09-28 three production jobs failed as "The fixed MR runner
// failed." with no code. Engine, registry and adapter are pinned together here.
test('every open-data MR refusal is classified once and forwarded by the MR adapter', async () => {
  const engine = await readFile(
    new URL('../../../../项目代码/孟德尔随机化/mr_agent/tools/open_sumstats.py', import.meta.url), 'utf8');
  const codes = new Set([...engine.matchAll(/OpenSourceError\(\s*["'](mr_open_[a-z_]+)["']/g)].map((match) => match[1]));
  assert.equal(codes.size, 9);
  const adapter = await readFile(
    new URL('../../../deploy/specialist-adapter/evimed_specialist_adapter/service.py', import.meta.url), 'utf8');
  const pattern = adapter.match(/^_MR_RUNNER_CODE = re\.compile\(r"([^"]+)"\)$/m)?.[1];
  assert.ok(pattern, 'the MR adapter names the runner codes it forwards');
  const forwarded = new RegExp(`^(?:${pattern})$`);
  for (const code of codes) {
    assert.ok(forwarded.test(code), `${code} is not forwarded by the MR adapter`);
    assert.notEqual(recoverableEvidenceSourceErrorCodes.has(code), terminalEvidenceSourceErrorCodes.has(code), code);
  }
});
