import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createEvolutionUploadProject, publicDecisionCounts, uploadedComputationReceipts } from '../../../scripts/ops/evolution-upload-acceptance.mjs';

test('actual PostgreSQL upload setup rehydrates the public account before creating its scoped workspace', { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL }, async () => {
  const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
  const parsed = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
  const dataDir = await mkdtemp(join(tmpdir(), 'evolution-upload-account-'));
  const store = createStore({ stateStore: 'postgres', databaseUrl: url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2000, dataDir, maxProjectBytes: 1048576 });
  const username = `p2-${randomUUID()}`;
  try {
    const { user, project } = await createEvolutionUploadProject(store, { username, password: randomUUID(), projectId: 'public-upload' });
    assert.equal(store.publicUser(user).rootDir, undefined);
    assert.equal(project.userId, username);
    assert.equal(project.userRoot, user.rootDir);
    assert.ok(project.workspaceDir.startsWith(join(dataDir, 'users', username)));
    assert.equal((await stat(project.workspaceDir)).isDirectory(), true);
    const restored = await store.requireProject(await store.userById(username), project.id);
    assert.equal(restored.workspaceDir, project.workspaceDir);
  } finally {
    await store.database.query('DELETE FROM evimed_control.users WHERE id=$1', [username]);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('public upload arithmetic derives outcomes from preserved rows with a distinct utility threshold', () => {
  const source = {decisionRule:{field:'glu',operator:'>=',value:140},positiveClass:'Yes',threshold:0.2};
  const result = publicDecisionCounts(Buffer.from('age,bmi,glu,type\n22,25,140,Yes\n23,26,150,No\n24,27,139,Yes\n25,28,80,No\n'),source);
  assert.deepEqual(result,{truePositive:1,falsePositive:1,falseNegative:1,trueNegative:1,n:4,eventCount:2,threshold:0.2});
  assert.throws(()=>publicDecisionCounts(Buffer.from('glu,type\nunknown,Yes\n'),source));
  assert.throws(()=>publicDecisionCounts(Buffer.from('glu,type\n140,Maybe\n'),source));
});

test('upload completion requires exact observed counts, immutable revision and a substantive result', () => {
  const aggregateInput = { n: 4, truePositive: 1, falsePositive: 1, eventCount: 2, threshold: 0.2, falseNegative: 1, trueNegative: 1 };
  const result = { userId: 'u', projectId: 'p', aggregateInput }, run = { id: 'r' }, tool = { id: 't', payload: { artifactDigest: 'sha256:actual', revision: 2 } };
  const specification = { n: 4, truePositive: 1, falsePositive: 1, eventCount: 2, threshold: 0.2 };
  const payload = { userId: 'u', projectId: 'p', runId: 'r', toolId: 't', digest: 'sha256:actual', revision: 2, callId: 'joined-execution',
    inputSha256: createHash('sha256').update(canonicalJson({ specification })).digest('hex'), result: { ok: true },
    resultEvidence: { kind: 'structured', substantive: true, explicitlyUnsupported: false } };
  const valid = { id: 'receipt', payload };
  assert.deepEqual(uploadedComputationReceipts([valid], { result, run, tool }), [valid]);
  for (const altered of [{ projectId: 'other' }, { revision: 1 }, { digest: 'sha256:stale' }, { inputSha256: 'wrong-data' },
    { result: { ok: false } }, { resultEvidence: { kind: 'structured', substantive: false, explicitlyUnsupported: true } }]) {
    assert.deepEqual(uploadedComputationReceipts([{ id: 'bad', payload: { ...payload, ...altered } }], { result, run, tool }), []);
  }
});
