import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, boundedBytes, pollReady, redact, runAcceptance, validateTables, reviewAcceptance, safeRead } from '../live-acceptance.mjs';
import { mkdtemp, writeFile, readFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const valid = { command: 'observe', stage: 'S2', baseUrl: 'https://example.com', studyId: 'std_1', output: '/tmp/acceptance-new' };
test('requires explicit deployment stage and origin without credentials or subpaths', () => {
  assert.equal(validateConfig(valid).stage, 'S2');
  for (const change of [{ stage: undefined }, { baseUrl: 'https://secret@example.com' }, { baseUrl: 'https://example.com/path' }, { baseUrl: 'http://example.com' }, { studyId: '../other' }, { output: 'relative' }]) assert.throws(() => validateConfig({ ...valid, ...change }));
});
test('response cap cancels oversized streamed bodies', async () => {
  await assert.rejects(boundedBytes(new Response('12345'), 4), /response_limit/);
  assert.equal((await boundedBytes(new Response('1234'), 4)).length, 4);
});
test('conversion failure and exhausted polls never become ready', async () => {
  await assert.rejects(pollReady(async () => ({ state: 'failed' }), { timeoutMs: 20, intervalMs: 1 }), /conversion_failed/);
  await assert.rejects(pollReady(async () => ({ state: 'queued' }), { timeoutMs: 5, intervalMs: 1 }), /poll_timeout/);
  assert.equal((await pollReady(async () => ({ state: 'ready' }), { timeoutMs: 20, intervalMs: 1 })).state, 'ready');
});
test('credentials are removed from nested receipts and arbitrary strings', () => {
  const secret = 'private-cookie-value';
  assert.equal(JSON.stringify(redact({ token: secret, data: { note: `echo ${secret}` } }, [secret])).includes(secret), false);
});
test('commissioning requires an explicit spend acknowledgement and known step', () => {
  for (const command of ['intake', 'run-step', 'vcr-exports']) assert.throws(() => validateConfig({ ...valid, command }));
  assert.throws(() => validateConfig({ ...valid, command: 'run-step', allowResearch: 'yes', step: 'unknown' }));
  assert.equal(validateConfig({ ...valid, command: 'run-step', allowResearch: 'yes', step: 'definition' }).step, 'definition');
});
test('completed artifact exports poll, hash both outputs and prove denial; denial failure leaves incomplete receipts', async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'vcr-live-test-')));
  let leak = false;
  const calls = [];
  const server = createServer((req, res) => {
    calls.push([req.method, req.url]);
    const unrelated = req.headers.cookie === 'session=stranger';
    if (unrelated && !leak) { res.writeHead(404); res.end(JSON.stringify({ code: 'not_found' })); return; }
    if (req.url.endsWith('/download/docx')) { res.end(Buffer.from('PK fake Word fixture')); return; }
    if (req.url.endsWith('/download/pdf')) { res.end(Buffer.from('%PDF- fake PDF fixture')); return; }
    res.end(JSON.stringify({ data: req.method === 'POST' ? { id: 'exp_1' } : { id: 'exp_1', state: 'ready' } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const owner = path.join(dir, 'owner.json'); const stranger = path.join(dir, 'stranger.json'); const input = path.join(dir, 'input.json');
    await writeFile(owner, JSON.stringify({ cookie: 'session=owner', csrf: 'owner-secret' }), { mode: 0o600 });
    await writeFile(stranger, JSON.stringify({ cookie: 'session=stranger', csrf: 'stranger-secret' }), { mode: 0o600 });
    await writeFile(input, JSON.stringify({ projectId: 'prj_1', source: { artifactId: 'art_1', root: 'deliverables', revision: 'sha256:known' } }));
    // This success fixture includes durable fsync writes; timeout behavior has separate short-deadline controls.
    const config = { command: 'artifact-export', stage: 'staging', baseUrl: `http://127.0.0.1:${server.address().port}`, credentials: owner, strangerCredentials: stranger, input, timeoutMs: 10000, output: path.join(dir, 'success') };
    const failureSummary = receipt => JSON.stringify({ errorType: receipt.error?.match(/^[a-z][a-z0-9_]*$/)?.[0] ?? (receipt.error ? 'other_error' : null), steps: receipt.steps.map(({ method, status, durationMs, bytes }) => ({ method, status, durationMs, bytes })), outputCount: receipt.outputs.length });
    const result = await runAcceptance(config);
    assert.equal(result.status, 'completed_scoped_checks', failureSummary(result));
    assert.equal(result.outputs.length, 2);
    assert.equal((await stat(path.join(config.output, 'receipt.json'))).mode & 0o077, 0);
    assert.equal((await readFile(path.join(config.output, 'receipt.json'), 'utf8')).includes('owner-secret'), false);
    assert.equal(calls.some(([, route]) => route.includes('/vcr/')), false, 'non-VCR export has no VCR dependency');
    leak = true;
    const incomplete = await runAcceptance({ ...config, output: path.join(dir, 'denial-failed') });
    assert.equal(incomplete.status, 'incomplete', failureSummary(incomplete));
    assert.equal(incomplete.error, 'http_200');
    assert.equal(incomplete.outputs.length, 0);
    await assert.rejects(runAcceptance(config), /EEXIST/);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); }
});
test('snapshot admission distinguishes refused, absent and expected tables', () => {
  assert.throws(() => validateTables({ registered: [], refused: [{ code: 'invalid' }] }, ['subject']), /tables_not_admitted/);
  assert.throws(() => validateTables({ registered: [{ shape: 'subject' }], refused: [] }, ['subject', 'events']), /tables_not_admitted/);
  assert.throws(() => validateTables({ registered: [{ shape: 'subject' }], refused: [], dropped: { rows: 1 } }, ['subject']), /tables_not_admitted/);
  assert.doesNotThrow(() => validateTables({ registered: [{ shape: 'subject' }], refused: [], skipped: [], dropped: {} }, ['subject']));
});
test('VCR review acceptance requires current completed clinical and statistical AI review with provenance', () => {
  const reviews = ['clinical', 'statistical'].map(role => ({ role, reviewerKind: 'ai', status: 'done', current: true, by: 'model', inputDigest: 'digest' }));
  assert.equal(reviewAcceptance(reviews).verified, true);
  for (const changes of [{ status: 'queued' }, { status: 'failed' }, { current: false }, { by: null }, { reviewerKind: 'human' }]) assert.equal(reviewAcceptance([{ ...reviews[0], ...changes }, reviews[1]]).verified, false);
  assert.equal(reviewAcceptance([]).verified, false);
});
test('file readers reject final and ancestor symlinks and bound actual regular bytes', async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'vcr-path-test-')));
  try {
    const target = path.join(dir, 'target'); await writeFile(target, '12345');
    await symlink(target, path.join(dir, 'linked-input'));
    await symlink(dir, path.join(dir, 'linked-parent'));
    await assert.rejects(safeRead(path.join(dir, 'linked-input'), 4), /symlink/);
    await assert.rejects(safeRead(path.join(dir, 'linked-parent', 'target'), 8), /symlink/);
    await assert.rejects(safeRead(target, 4), /file_limit/);
  } finally { await rm(dir, { recursive: true }); }
});
async function fixture(handler, run) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'vcr-staged-test-')));
  const server = createServer(handler); server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const credentials = path.join(dir, 'owner.json'), strangerCredentials = path.join(dir, 'stranger.json');
    await writeFile(credentials, JSON.stringify({ cookie: 'session=owner', csrf: 'csrf-owner' }), { mode: 0o600 });
    await writeFile(strangerCredentials, JSON.stringify({ cookie: 'session=stranger', csrf: 'csrf-stranger' }), { mode: 0o600 });
    await run({ dir, command: 'observe', stage: 'staging', baseUrl: `http://127.0.0.1:${server.address().port}`, credentials, strangerCredentials, timeoutMs: 5000, output: path.join(dir, 'out') });
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); }
}
const json = (res, data, status = 200) => { res.writeHead(status); res.end(JSON.stringify({ data })); };
test('POST accepted then disconnected retains private durable unknown intent and never retries', async () => {
  let posts = 0;
  await fixture((req, res) => {
    if (req.method === 'POST') { posts++; req.resume(); req.on('end', () => req.socket.destroy()); }
    else json(res, {});
  }, async c => {
    const input = path.join(c.dir, 'input.json'); await writeFile(input, JSON.stringify({ projectId: 'prj_1', source: { artifactId: 'art_1', root: 'deliverables', revision: 'known' } }));
    const receipt = await runAcceptance({ ...c, command: 'artifact-export', input });
    assert.equal(receipt.status, 'incomplete'); assert.equal(posts, 1);
    const intent = JSON.parse(await readFile(path.join(c.output, '0001-attempt.json'), 'utf8'));
    assert.equal(intent.outcome, 'unknown'); assert.equal(intent.method, 'POST'); assert.equal(intent.route, '/api/document-exports');
    assert.match(intent.bodySha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.attempts[0].outcome, 'unknown');
  });
});
test('HTTP 201 snapshot with refused tables records snapshot and leaves intake incomplete', async () => {
  await fixture((req, res) => {
    req.resume();
    if (req.headers.cookie === 'session=stranger') return json(res, null, 404);
    if (req.url === '/api/vcr/studies') return json(res, { id: 'std_1', projectId: 'prj_1' }, 201);
    if (req.url.endsWith('/data/sources')) return json(res, { source: { id: 'src_1' } }, 201);
    if (req.url.includes('/files?')) return json(res, { file: { id: 'fil_1' } }, 201);
    if (req.url.endsWith('/fieldmap')) return json(res, { hash: 'a'.repeat(64), entryIssues: [], mapIssues: [] }, 201);
    if (req.url.endsWith('/snapshots')) return json(res, { snapshot: { id: 'snp_1' }, tables: { registered: [], refused: [{ code: 'invalid' }], dropped: {} } }, 201);
    json(res, {});
  }, async c => {
    const file = path.join(c.dir, 'synthetic.csv'); await writeFile(file, 'id,age\n1,40\n');
    const input = path.join(c.dir, 'input.json'); await writeFile(input, JSON.stringify({ datasetClass: 'synthetic', authorizationNote: 'Acceptance fixture only', file, study: { name: 'Synthetic test', question: 'Synthetic testing only' }, source: { name: 'Synthetic fixture', valueSource: 'synthetic' }, fieldMap: { columns: [] }, expectedTableShapes: ['subject'] }));
    const result = await runAcceptance({ ...c, command: 'intake', input, allowResearch: 'yes' });
    assert.equal(result.status, 'incomplete'); assert.equal(result.error, 'tables_not_admitted');
    assert.equal(result.snapshotId, 'snp_1'); assert.equal(result.tableAdmission.refused.length, 1);
    assert.match(result.correlation, /^acceptance-/);
  });
});
test('all four VCR Word/PDF conversions survive unavailable or stale AI review without false acceptance', async () => {
  let exports = 0;
  await fixture((req, res) => {
    req.resume();
    if (req.headers.cookie === 'session=stranger') return json(res, null, 404);
    if (req.method === 'POST') { exports++; return json(res, { export: { id: `vex_${exports}` }, conversion: { id: `exp_${exports}` } }, 201); }
    if (req.url.endsWith('/download/pdf')) return res.end('%PDF- fixture');
    if (req.url.endsWith('/download/docx')) return res.end('PK fixture');
    if (req.url.startsWith('/api/document-exports')) return json(res, { state: 'ready' });
    if (req.url.includes('/export/')) return json(res, { state: 'ready', document: { reviews: [{ role: 'clinical', reviewerKind: 'ai', status: 'failed', current: false, by: 'model', inputDigest: 'digest' }] } });
    json(res, { projectId: 'prj_1' });
  }, async c => {
    const result = await runAcceptance({ ...c, command: 'vcr-exports', studyId: 'std_1', allowResearch: 'yes' });
    assert.equal(result.outputs.length, 8); assert.equal(exports, 4);
    assert.equal(result.status, 'incomplete');
    assert.equal(Object.values(result.reviewAcceptance).every(row => row.conversion === 'completed' && !row.verified), true);
  });
});
