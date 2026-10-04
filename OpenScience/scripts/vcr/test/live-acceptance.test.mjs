import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDY_NAME_MAX, acceptanceStudyName, validateConfig, boundedBytes, pollReady, redact, runAcceptance, validateTables, reviewAcceptance, safeRead } from '../live-acceptance.mjs';
import { VCR_EXPORT_KINDS } from '../../../packages/domain/src/vcrVocabulary.mjs';
import { VCR_STUDY_NAME_MAX, vcrStudyName } from '../../../apps/server/src/vcrRoutes.mjs';
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
  // What a baseline-only source answers (live, 2026-10-03): the two shapes its field map has nothing for are skipped.
  const baselineOnly = { registered: [{ shape: 'subject', rowCount: 60 }], refused: [], skipped: ['longitudinal', 'events'], subjects: 60, dropped: {} };
  assert.doesNotThrow(() => validateTables(baselineOnly, ['subject']));
  // A skipped shape the owner expected is still not admitted: it was not registered.
  assert.throws(() => validateTables(baselineOnly, ['subject', 'events']), /tables_not_admitted/);
  assert.throws(() => validateTables({ ...baselineOnly, refused: [{ shape: 'events' }] }, ['subject']), /tables_not_admitted/);
});
test('an intake study name passes the route\'s own rule whatever the owner called the study, and still ends in a tag it can be found by', () => {
  assert.equal(STUDY_NAME_MAX, VCR_STUDY_NAME_MAX, 'the driver cuts to the ceiling the route enforces');
  const correlation = 'acceptance-d04b914d-d8fe-4518-9987-77f811f689ce';
  for (const given of ['SYNTHETIC intake', 'SYNTHETIC 验收 ZZ000 T0 20261003 基线数据接入检查（合成数据）', 'S'.repeat(200),
    '  spaced \t out   name ', '合成验收'.repeat(20), '', undefined]) {
    const { name, tag } = acceptanceStudyName(given, correlation);
    assert.equal(tag, 'acc-d04b914dd8fe');
    assert.equal(vcrStudyName(name), name, `the route takes ${JSON.stringify(name)} as it stands`);
    assert.ok(name.endsWith(` ${tag}`) && [...name].length <= VCR_STUDY_NAME_MAX, name);
  }
  assert.equal(acceptanceStudyName('SYNTHETIC intake', correlation).name, 'SYNTHETIC intake acc-d04b914dd8fe');
  // What it used to send: thirty characters of the name and the whole correlation.
  assert.throws(() => vcrStudyName(`${'SYNTHETIC intake'.slice(0, 30)} ${correlation}`), { code: 'vcr_name_invalid' });
  assert.throws(() => acceptanceStudyName('SYNTHETIC intake', 'no hex here'), /correlation_required/);
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
    // Every request leaves fsynced receipts, which is most of what these runs take on a busy disk: the deadline is a
    // ceiling no run here is meant to reach (the short-deadline controls above are where a timeout is the subject).
    await run({ dir, command: 'observe', stage: 'staging', baseUrl: `http://127.0.0.1:${server.address().port}`, credentials, strangerCredentials, timeoutMs: 30000, output: path.join(dir, 'out') });
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
/** The intake routes, with study creation held to the real route's own name rule: a double that took any
 * name is how a driver that could never create a study passed its tests.
 * @param {any} tables what the snapshot freeze answers @param {string[]} names every study name posted */
const intakeServer = (tables, names = []) => (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    if (req.headers.cookie === 'session=stranger') return json(res, null, 404);
    if (req.url === '/api/vcr/studies' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      names.push(body.name);
      try { vcrStudyName(body.name); } catch (error) { res.writeHead(error.status); return res.end(JSON.stringify({ error: error.message, code: error.code })); }
      return json(res, { id: 'std_1', projectId: 'prj_1' }, 201);
    }
    if (req.url.endsWith('/data/sources')) return json(res, { source: { id: 'src_1' } }, 201);
    if (req.url.includes('/files?')) return json(res, { file: { id: 'fil_1' } }, 201);
    if (req.url.endsWith('/fieldmap')) return json(res, { hash: 'a'.repeat(64), entryIssues: [], mapIssues: [] }, 201);
    if (req.url.endsWith('/snapshots')) return json(res, { snapshot: { id: 'snp_1' }, tables }, 201);
    json(res, {});
  });
};
/** @param {string} dir @param {Record<string, any>} [study] */
async function intakeInput(dir, study = { name: 'Synthetic test', question: 'Synthetic testing only' }) {
  const file = path.join(dir, 'synthetic.csv'); await writeFile(file, 'id,age\n1,40\n');
  const input = path.join(dir, 'input.json');
  await writeFile(input, JSON.stringify({ datasetClass: 'synthetic', authorizationNote: 'Acceptance fixture only', file, study, source: { name: 'Synthetic fixture', valueSource: 'synthetic' }, fieldMap: { columns: [] }, expectedTableShapes: ['subject'] }));
  return input;
}
test('HTTP 201 snapshot with refused tables records snapshot and leaves intake incomplete', async () => {
  await fixture(intakeServer({ registered: [], refused: [{ code: 'invalid' }], dropped: {} }), async c => {
    const result = await runAcceptance({ ...c, command: 'intake', input: await intakeInput(c.dir), allowResearch: 'yes' });
    assert.equal(result.status, 'incomplete'); assert.equal(result.error, 'tables_not_admitted');
    assert.equal(result.snapshotId, 'snp_1'); assert.equal(result.tableAdmission.refused.length, 1);
    assert.match(result.correlation, /^acceptance-/);
  });
});
test('intake creates its study under the route\'s own name rule and admits a baseline-only snapshot', async () => {
  const names = [];
  // The answer the pilot gave: one table registered, the two the field map has nothing for skipped.
  const tables = { registered: [{ shape: 'subject', rowCount: 60 }], refused: [], skipped: ['longitudinal', 'events'], subjects: 60, dropped: {} };
  await fixture(intakeServer(tables, names), async c => {
    const study = { name: 'SYNTHETIC 验收 ZZ000 基线数据接入检查（合成数据，非真实研究）', question: 'Synthetic acceptance fixture (not a real study).' };
    const result = await runAcceptance({ ...c, command: 'intake', input: await intakeInput(c.dir, study), allowResearch: 'yes' });
    assert.equal(result.error, undefined, 'the study was created and its tables admitted');
    assert.equal(result.status, 'completed_scoped_checks');
    assert.equal(result.createdStudyId, 'std_1');
    assert.deepEqual(result.tableAdmission.skipped, ['longitudinal', 'events']);
    assert.equal(names.length, 1, 'one creation, never repeated');
    assert.equal(vcrStudyName(names[0]), names[0], 'the name posted is one the route takes');
    assert.match(names[0], /^SYNTHETIC 验收 ZZ000 .* acc-[a-f0-9]{12}$/);
    assert.equal(result.studyName, names[0]);
    assert.ok(result.reconciliation.includes(names[0].slice(-16)), 'the receipt says which suffix finds the study again');
  });
});
test('a synthetic intake whose label would be cut out of the study name is refused before anything is created', async () => {
  const names = [];
  await fixture(intakeServer({ registered: [{ shape: 'subject' }], refused: [], dropped: {} }, names), async c => {
    const study = { name: 'A long study name that only says synthetic at its very end', question: 'Synthetic testing only' };
    const result = await runAcceptance({ ...c, command: 'intake', input: await intakeInput(c.dir, study), allowResearch: 'yes' });
    assert.equal(result.error, 'synthetic_fixture_requires_source_and_study_labels');
    assert.deepEqual(names, [], 'no study was created under a name that had lost its label');
  });
});
test('a VCR export kind that fails is recorded under its own name; the kinds after it are still asked for and the delivered ones still inspected', async () => {
  let exports = 0;
  const inspected = [];
  const reviews = ['clinical', 'statistical'].map(role => ({ role, reviewerKind: 'ai', status: 'done', current: true, by: 'model', inputDigest: 'digest' }));
  await fixture((req, res) => {
    req.resume();
    if (req.headers.cookie === 'session=stranger') return json(res, null, 404);
    // The second kind's run leaves no document: its export ends failed, as the pilot's did.
    if (req.method === 'POST') { exports++; return json(res, exports === 2 ? { export: { id: 'vex_2' } } : { export: { id: `vex_${exports}` }, conversion: { id: `exp_${exports}` } }, 201); }
    if (req.url.endsWith('/download/pdf')) return res.end('%PDF- fixture');
    if (req.url.endsWith('/download/docx')) return res.end('PK fixture');
    if (req.url.startsWith('/api/document-exports')) return json(res, { state: 'ready' });
    if (req.url.endsWith('/export/vex_2')) return json(res, { state: 'failed', document: { reviews: [] } });
    if (req.url.includes('/export/')) { inspected.push(req.url.split('/').pop()); return json(res, { state: 'ready', document: { reviews } }); }
    json(res, { projectId: 'prj_1' });
  }, async c => {
    const result = await runAcceptance({ ...c, command: 'vcr-exports', studyId: 'std_1', allowResearch: 'yes' });
    assert.equal(exports, VCR_EXPORT_KINDS.length, 'every kind was asked for, the ones after the failure included');
    assert.deepEqual(Object.keys(result.reviewAcceptance), [...VCR_EXPORT_KINDS]);
    const failed = VCR_EXPORT_KINDS[1];
    assert.deepEqual(result.reviewAcceptance[failed], { verified: false, state: 'export_failed', conversion: 'failed', vcrExportId: 'vex_2', error: 'conversion_failed' });
    assert.equal(result.outputs.length, 2 * (VCR_EXPORT_KINDS.length - 1), 'Word and PDF of every kind that was delivered');
    for (const kind of VCR_EXPORT_KINDS.filter(kind => kind !== failed)) {
      assert.equal(result.reviewAcceptance[kind].verified, true, `${kind} was inspected after the failure`);
      assert.equal(result.reviewAcceptance[kind].exportState, 'ready');
    }
    assert.deepEqual([...new Set(inspected)].sort(), VCR_EXPORT_KINDS.map((_, index) => `vex_${index + 1}`).filter(id => id !== 'vex_2'));
    assert.equal(result.status, 'incomplete', 'one failed kind keeps the receipt incomplete');
    assert.equal(result.error, undefined, 'and the failure is that kind\'s, not the whole run\'s');
  });
});
test('every VCR Word/PDF conversion survives unavailable or stale AI review without false acceptance', async () => {
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
    assert.equal(result.outputs.length, 2 * VCR_EXPORT_KINDS.length); assert.equal(exports, VCR_EXPORT_KINDS.length);
    assert.equal(result.status, 'incomplete');
    assert.equal(Object.values(result.reviewAcceptance).every(row => row.conversion === 'completed' && !row.verified), true);
  });
});
