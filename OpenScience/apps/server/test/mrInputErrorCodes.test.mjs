import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recoverableEvidenceSourceErrorCodes, terminalEvidenceSourceErrorCodes } from '@evimed/domain';

test('every hosted MR input error has an explicit dependency or invalid-input classification', async () => {
  const source = (await Promise.all(['evimed_local_inputs.py', 'evimed_mr_job.py'].map((name) =>
    readFile(new URL(`../../../../项目代码/孟德尔随机化/${name}`, import.meta.url), 'utf8'),
  ))).join('\n');
  const codes = new Set([...source.matchAll(/MRInputError\(\s*["'](mr_input_[a-z_]+)["']/g)].map((match) => match[1]));
  assert.equal(codes.size, 8);
  for (const code of codes) {
    const dependency = ['mr_input_remote_auth_required', 'mr_input_remote_metadata_unavailable'].includes(code);
    assert.equal(recoverableEvidenceSourceErrorCodes.has(code), dependency, code);
    assert.equal(terminalEvidenceSourceErrorCodes.has(code), !dependency, code);
  }
});
