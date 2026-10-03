/** Unit tests verify refusal and evidence handling; they are NOT measured SaaS outcomes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertCompletionFixture, scanBoundedCanaryFiles, summarizeAttributedUsage, COMPLETION_REMAINING, COMPLETION_FIXTURE_OVERRIDES } from '../extension-saas-acceptance-completion.mjs';

test('supplemental controls refuse substitute app/state before any mutation and retain explicit unmeasured controls', async () => {
  await assert.rejects(assertCompletionFixture({ app: { config: { runtimeMode: 'kernel', dataDir: '/tmp/fake' } }, state: { root: '/tmp/fake' } }), /completion_real_app_required/);
  assert.deepEqual(COMPLETION_FIXTURE_OVERRIDES, { vcrEnabled: true, vcrAudience: 'all' });
  assert.equal(Object.isFrozen(COMPLETION_FIXTURE_OVERRIDES), true);
  assert.equal(Object.isFrozen(COMPLETION_REMAINING), true);
  assert.ok(COMPLETION_REMAINING.some(item => item.startsWith('SAAS-19')));
  assert.ok(COMPLETION_REMAINING.some(item => item.startsWith('SAAS-21')));
});

async function scanFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'completion-scan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'library'); await fs.mkdir(library, { mode: 0o700 });
  return { root, library, canary: 'synthetic-only-canary-' + 'a'.repeat(16) };
}

test('bounded actual file scan detects plaintext but emits only relative names and digests', async t => {
  const fixture = await scanFixture(t);
  await fs.writeFile(path.join(fixture.library, 'metadata.json'), JSON.stringify({ value: fixture.canary }));
  const scan = await scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library] });
  assert.equal(scan.files, 1); assert.equal(scan.matches.length, 1);
  assert.equal(scan.matches[0].path, path.join('library', 'metadata.json'));
  assert.match(scan.matches[0].contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(scan).includes(fixture.canary), false);
});

test('overlapping scan roots do not duplicate evidence and symlinks are recorded without reading foreign bytes', async t => {
  const fixture = await scanFixture(t);
  await fs.writeFile(path.join(fixture.library, 'one.txt'), 'allowed');
  await fs.symlink('/etc/passwd', path.join(fixture.library, 'foreign'));
  const scan = await scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, fixture.library] });
  assert.equal(scan.files, 1); assert.equal(scan.matches.length, 0); assert.equal(scan.skippedSymlinks.length, 1);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: ['/etc'] }), /completion_scan_scope_refused/);
});

test('scan bounds are shared across roots and reject invalid canaries or limits instead of declaring a partial success', async t => {
  const fixture = await scanFixture(t), second = path.join(fixture.root, 'cache');
  await fs.mkdir(second); await fs.writeFile(path.join(fixture.library, 'one.txt'), '12345'); await fs.writeFile(path.join(second, 'two.txt'), '12345');
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, second], maxBytes: 9 }), /completion_scan_unbounded/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library, second], maxFiles: 1 }), /completion_scan_unbounded/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], canary: 'short' }), /completion_canary_refused/);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], maxBytes: Infinity }), /completion_scan_limit_refused/);
});

test('empty directories and foreign symlinks consume the entry budget; deep empty trees refuse before unbounded recursion', async t => {
  const fixture = await scanFixture(t);
  await fs.mkdir(path.join(fixture.library, 'one'));
  await fs.mkdir(path.join(fixture.library, 'two'));
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [fixture.library], maxEntries: 2 }), /completion_scan_unbounded/);
  const deep = path.join(fixture.root, 'deep'); await fs.mkdir(path.join(deep, 'a', 'b'), { recursive: true });
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [deep], maxDepth: 2 }), /completion_scan_unbounded/);
  const links = path.join(fixture.root, 'links'); await fs.mkdir(links);
  await fs.symlink('/etc/passwd', path.join(links, 'one')); await fs.symlink('/etc/passwd', path.join(links, 'two'));
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: 2 }), /completion_scan_unbounded/);
  const result = await scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: 3 });
  assert.equal(result.entries, 3); assert.equal(result.files, 0); assert.equal(result.bytes, 0); assert.equal(result.skippedSymlinks.length, 2);
  await assert.rejects(scanBoundedCanaryFiles({ ...fixture, roots: [links], maxEntries: Infinity }), /completion_scan_limit_refused/);
});

const scopes = [
  { userId: 'alice', projectId: 'default', runId: 'run-a', runKeys: ['run-a', 'dispatch-a'] },
  { userId: 'bob', projectId: 'default', runId: 'run-b', runKeys: ['run-b'] },
];
const row = (id, userId, runId) => ({ id, user_id: userId, project_id: 'default', run_id: runId, status: 'settled', revision: 2,
  request_fingerprint: 'a'.repeat(64), provider_request_id: 'controlled-provider-id', settled_at: '2026-10-03T00:00:00Z' });

test('usage summarizer scopes owner-local duplicate project names by actual caller and accepts native dispatch aliases', () => {
  const result = summarizeAttributedUsage([row('one', 'alice', 'run-a'), row('two', 'alice', 'dispatch-a'), row('three', 'bob', 'run-b')], scopes);
  assert.equal(result[0].requests, 2); assert.equal(result[1].requests, 1);
  assert.equal(result[0].userId, 'alice'); assert.equal(result[1].userId, 'bob');
  assert.equal(JSON.stringify(result).includes('controlled-provider-id'), false);
  assert.equal(Object.hasOwn(result[0], 'status'), false); assert.equal(Object.hasOwn(result[0], 'qualified'), false);
});

test('usage refuses wrong caller, unsettled requests, duplicate request IDs and unrelated scopes', () => {
  const valid = [row('one', 'alice', 'run-a'), row('two', 'bob', 'run-b')];
  for (const bad of [
    [{ ...valid[0], user_id: 'bob' }, valid[1]],
    [{ ...valid[0], status: 'reserved' }, valid[1]],
    [valid[0], { ...valid[1], id: 'one' }],
    [valid[0], valid[1], row('extra', 'outsider', 'foreign-run')],
    [{ ...valid[0], request_fingerprint: 'fake' }, valid[1]],
  ]) assert.throws(() => summarizeAttributedUsage(bad, scopes), /completion_/);
  assert.throws(() => summarizeAttributedUsage(valid, [scopes[0], scopes[0]]), /completion_two_usage_actors_required/);
});
