import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRsiOssClient, readRsiOssCredentialFile, rsiOssConfigurationIssues } from '../src/rsiOssClient.mjs';

test('unbound transport neither loads SDK nor reads credentials', async () => {
  let loaded = false;
  const value = await createRsiOssClient({}, { sdkFactory() { loaded = true; } });
  assert.equal(value.available, false); assert.equal(loaded, false); assert.equal(value.preflight.permissionsVerified, false);
});
test('endpoint cannot override the declared regional HTTPS host', () => {
  for (const endpoint of ['https://evil.example', 'http://oss-cn-hangzhou.aliyuncs.com', 'https://oss-cn-hangzhou.aliyuncs.com?q=x', 'https://a@oss-cn-hangzhou.aliyuncs.com']) assert.ok(rsiOssConfigurationIssues({ region: 'cn-hangzhou', endpoint }).includes('rsi_oss_endpoint_invalid'));
});
test('credentials require private regular bounded JSON and reject links and extra fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-oss-'));
  try {
    const file = join(dir, 'credentials'); const link = join(dir, 'link');
    await writeFile(file, JSON.stringify({ accessKeyId: 'fixture', accessKeySecret: 'fixture-secret' }), { mode: 0o600 });
    assert.equal((await readRsiOssCredentialFile(file)).accessKeyId, 'fixture');
    await symlink(file, link); await assert.rejects(readRsiOssCredentialFile(link));
    await writeFile(file, JSON.stringify({ accessKeyId: 'fixture', accessKeySecret: 'fixture-secret', endpoint: 'https://evil.example' }));
    await assert.rejects(readRsiOssCredentialFile(file), /credentials_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
