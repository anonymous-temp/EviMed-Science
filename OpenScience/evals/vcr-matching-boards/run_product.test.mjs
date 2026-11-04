// The product runner's tests: the request and its two arms, the case inputs, when a case has settled, which stack may be used for what,
// and the cleanup of a case on success, failure, interruption and a refused deletion. The platform's routes are a scripted double
// (no kernel, no model, no network); the last block starts the real stack and proves it up to the model call, when the environment names it.
//
//   node --test run_product.test.mjs
//   (and, for the last block) VCR_BOARDS_LIVE OS OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE OPEN_SCIENCE_TEST_POSTGRES_URL
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { EXIT, ARMS, acceptReceipt, availableMb, exportRecord, ownedProcesses, parseOptions, promptFor, replyAgreement, runBoardCase, runProduct, settleStep, summarizeTranscript, writeCaseInputs } from './run_product.mjs';

const tmp = (/** @type {string} */ label) => fs.mkdtempSync(path.join(os.tmpdir(), `vcr-prod-${label}-`));
const ROW = { caseId: 'p-1', patientId: 'p-1', collection: 'tg2-sigir', split: 'dev', note: 'A person with asthma.', candidateIds: ['NCT00000001', 'NCT00000002', 'NCT00000003'], candidateCount: 3 };

describe('the request', () => {
  test('one natural paragraph that names the files, the frozen archive and the destination, and no tool or step', () => {
    const job = promptFor({ arm: 'job', collection: 'tg2-sigir' });
    assert.match(job, /patient\.txt/u);
    assert.match(job, /trials\.txt/u);
    assert.match(job, /tg2-sigir/u);
    assert.match(job, /保存在平台里/u);
    assert.doesNotMatch(job, /vcr_|match_judge|trial_judgment|candidates|mcp__|tool|工具|作业|步骤/iu, 'no internal step, tool or job is named');
    assert.equal(job.split('\n').length, 3, 'the job arm adds nothing');
  });
  test('the native arm differs by one short sentence and nothing else', () => {
    const job = promptFor({ arm: 'job', collection: 'tg2-sigir' }).split('\n');
    const native = promptFor({ arm: 'native', collection: 'tg2-sigir' }).split('\n');
    const extra = native.filter((line) => !job.includes(line));
    assert.equal(extra.length, 1);
    assert.match(extra[0], /自己.*逐个判断.*保存.*不要启动后台作业/u);
    assert.ok(extra[0].length < 40);
    assert.deepEqual(native.filter((line) => job.includes(line)), job);
    assert.deepEqual([...ARMS], ['job', 'native']);
    assert.throws(() => promptFor({ arm: /** @type {any} */ ('both'), collection: 'x' }), { code: 'option_invalid' });
    assert.throws(() => promptFor({ arm: 'job', collection: '../x' }), { code: 'option_invalid' });
  });
});

describe('options', () => {
  const base = ['--arm', 'native', '--board', 'sigir', '--data-dir', '/tmp/d', '--boards', '/tmp/b', '--live-root', '/tmp/l', '--os', '/tmp/o', '--key-file', '/tmp/k'];
  test('a run names its private places, the arm and the board; the criterion board is left to dev_job', () => {
    const options = parseOptions(base, {});
    assert.deepEqual([options.arm, options.board, options.diagnostic, options.caseCny, options.dbName], ['native', 'sigir', false, 2, 'evimed_test_vmlive']);
    assert.equal(options.dshBin, '/tmp/l/kernel/node_modules/.bin/dsh');
    assert.throws(() => parseOptions(base.map((value) => (value === 'sigir' ? 'c' : value)), {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(base.map((value) => (value === 'native' ? 'both' : value)), {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions(base.slice(0, 4), {}), { code: 'option_missing' });
    assert.equal(parseOptions(['--readiness', '--data-dir', '/tmp/d', '--live-root', '/tmp/l', '--os', '/tmp/o', '--key-file', '/tmp/k'], {}).readiness, true, 'readiness needs no boards');
    assert.equal(parseOptions(['--arm', 'job', '--data-dir', '/tmp/d', '--boards', '/tmp/b', '--live-root', '/tmp/l', '--os', '/tmp/o'], { OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE: '/tmp/k' }).keyFile, '/tmp/k');
  });
});

describe('what a conversation did, read from its transcript', () => {
  const tool = (/** @type {string} */ name, /** @type {Record<string, any>} */ extra = {}) => ({ role: 'tool', parts: [{ type: 'tool', tool: name, status: 'done', error: null, ...extra }] });
  const said = (/** @type {string} */ text) => ({ role: 'assistant', parts: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }] });
  test('tool names come out in order, errors and unfinished calls are counted, and the reply is the last thing the assistant said', () => {
    const digest = summarizeTranscript({ turns: [{}, {}], messages: [{ role: 'user', parts: [{ type: 'text', text: 'ask' }] }, said('first'), tool('mcp__evimed__vcr_read'), tool('mcp__evimed__vcr_simulate', { error: 'boom' }),
      tool('mcp__evimed__vcr_read', { status: 'pending' }), said('  second  '), { role: 'assistant', parts: [{ type: 'text', text: '' }] }] });
    assert.deepEqual(digest.tools, ['mcp__evimed__vcr_read', 'mcp__evimed__vcr_simulate', 'mcp__evimed__vcr_read']);
    assert.deepEqual([digest.toolErrors, digest.pendingCalls, digest.assistantMessages, digest.turns, digest.reply, digest.replyChars], [1, 1, 3, 2, 'second', 6]);
    assert.deepEqual(summarizeTranscript(null), { tools: [], toolErrors: 0, pendingCalls: 0, assistantMessages: 0, turns: null, reply: '', replyChars: 0 });
    assert.deepEqual(summarizeTranscript({ error: 'x' }).tools, []);
  });
  test('the verdicts a reply states are compared with the saved rows: agree, disagree, stated none, unreported, and ids nothing saved', () => {
    const rows = [['NCT00000001', 'eligible'], ['NCT00000002', 'possible'], ['NCT00000003', 'ineligible'], ['NCT00000004', 'insufficient'], ['NCT00000005', 'eligible'], ['NCT00000006', 'eligible']].map(([id, verdict]) => ({ target: { registryId: id }, verdict }));
    const reply = ['1. NCT00000001 符合', '2. NCT00000002 可能符合，需确认', '3. NCT00000003 不符合', 'NCT00000004: eligible', 'NCT00000006 在名单里', 'NCT00000009 符合'].join('\n');
    assert.deepEqual(replyAgreement(reply, rows), { saved: 6, reported: 5, agree: 3, disagree: 1, noVerdictStated: 1, unreported: 1, unknownIds: 1, agreeByHeading: 0 });
    assert.deepEqual(replyAgreement('', rows), { saved: 6, reported: 0, agree: 0, disagree: 0, noVerdictStated: 0, unreported: 6, unknownIds: 0, agreeByHeading: 0 });
    assert.equal(replyAgreement('NCT00000001 不符合', rows.slice(0, 1)).disagree, 1, '不符合 is not also 符合');
    assert.equal(replyAgreement('NCT00000001 可能符合', rows.slice(0, 1)).disagree, 1, '可能符合 is not also 符合');
    // A table row's verdict is its verdict cell; the reasons beside it may use the word of a single clause. With no verdict cell the heading above stands.
    const table = ['## 第二档：可能符合（2 个）', '| 序 | 试验 | 判定 | 为什么 |', '| 1 | NCT00000002 肺栓塞 | 82 | 疑似 PE 且符合造影条件 |', '', '**第三档：不符合**', '| 2 | NCT00000003 另一项 | 不符合 | 年龄不符合 |', '| 3 | NCT00000001 一项 | **符合** | 唯一条款符合 |'].join('\n');
    assert.deepEqual(replyAgreement(table, rows.slice(0, 3)), { saved: 3, reported: 3, agree: 3, disagree: 0, noVerdictStated: 0, unreported: 0, unknownIds: 0, agreeByHeading: 1 });
    assert.deepEqual(replyAgreement(['| 1 | NCT00000003 | 不符合（当前） | 55 |', '| 2 | NCT00000002 | 80 | 可能符合：年龄满足，需确认 |'].join('\n'), rows.slice(1, 3)), { saved: 2, reported: 2, agree: 2, disagree: 0, noVerdictStated: 0, unreported: 0, unknownIds: 0, agreeByHeading: 0 }, 'a verdict cell may carry a bracket or a reason');
    assert.equal(replyAgreement('结果：符合 1 项、可能符合 20 项。\n| 1 | NCT00000002 | 80 | 理由 |', rows.slice(1, 2)).noVerdictStated, 1, 'a summary line with several verdicts is not a heading');
  });
  test('free memory is a number in MB on this machine', () => {
    assert.ok(Number.isInteger(availableMb()) && /** @type {number} */ (availableMb()) > 0);
  });
  test('arms and patients are lists that are checked, and the allowance and caps are options of the run', () => {
    const base = ['--board', 'sigir', '--data-dir', '/tmp/d', '--boards', '/tmp/b', '--live-root', '/tmp/l', '--os', '/tmp/o', '--key-file', '/tmp/k'];
    const options = parseOptions([...base, '--arms', 'job,native', '--patients', 'p1,p2', '--allowance-cny', '15', '--run-cap-cny', '1.6', '--min-free-mb', '900'], {});
    assert.deepEqual([options.arms, options.patients, options.allowanceCny, options.runCapCny, options.minFreeMb], [['job', 'native'], ['p1', 'p2'], 15, 1.6, 900]);
    assert.deepEqual(parseOptions([...base, '--arm', 'native'], {}).arms, ['native']);
    assert.throws(() => parseOptions([...base, '--arms', 'job,both'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--arms', 'job,job'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--patients', 'p1,p1'], {}), { code: 'option_invalid' });
    assert.throws(() => parseOptions([...base, '--patients', '../x'], {}), { code: 'option_invalid' });
  });
});

describe('the case inputs', () => {
  test('two files a case, the note and the candidate ids, each with its hash, in the manifest shape the campaign verifier reads', () => {
    const dir = tmp('inputs');
    try {
      const manifest = writeCaseInputs({ cases: [ROW, { ...ROW, patientId: 'p-2' }], dir });
      assert.deepEqual([manifest.version, manifest.task, manifest.collection, manifest.cases.length], [1, 'matching', 'tg2-sigir', 2]);
      for (const entry of manifest.cases) {
        assert.deepEqual(entry.files.map((file) => file.name).sort(), ['patient.txt', 'trials.txt']);
        for (const file of entry.files) assert.equal(file.sha256.length, 64);
      }
      const trials = fs.readFileSync(manifest.cases[0].files.find((file) => file.name === 'trials.txt').path, 'utf8');
      assert.match(trials, /^Frozen trial collection: tg2-sigir\n/u);
      assert.deepEqual(trials.trim().split('\n').slice(2), ROW.candidateIds, 'in the order the case lists them');
      assert.equal(fs.readFileSync(manifest.cases[0].files.find((file) => file.name === 'patient.txt').path, 'utf8'), ROW.note);
      assert.throws(() => writeCaseInputs({ cases: [ROW, { ...ROW, patientId: 'p-3', collection: 'other' }], dir }), { code: 'collection_ambiguous' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('when a case has settled', () => {
  const run = (/** @type {string} */ status, id = 'r1') => ({ id, status });
  const job = (/** @type {string} */ state, id = 'j1') => ({ id, state });
  const fresh = () => ({ lastChangeAt: 0, signature: '' });
  test('only when the root run has ended, nothing is active, every job is terminal, and none of it has changed for the quiet time', () => {
    let memory = fresh();
    const at = (/** @type {any} */ seen, /** @type {number} */ now) => { const step = settleStep(memory, seen, now, { quietMs: 20_000 }); memory = step.memory; return step.state; };
    assert.equal(at({ runs: [], rootRunId: 'r1', jobs: [] }, 0), 'working', 'the root run is not even listed yet');
    assert.equal(at({ runs: [run('running')], rootRunId: 'r1', jobs: [] }, 1000), 'working');
    assert.equal(at({ runs: [run('completed')], rootRunId: 'r1', jobs: [job('running')] }, 5000), 'working', 'a job is out');
    assert.equal(at({ runs: [run('completed')], rootRunId: 'r1', jobs: [job('succeeded')] }, 9000), 'quiet', 'the job ended, its completion turn may still begin');
    assert.equal(at({ runs: [run('completed'), run('running', 'r2')], rootRunId: 'r1', jobs: [job('succeeded')] }, 15_000), 'working', 'the completion turn began');
    assert.equal(at({ runs: [run('completed'), run('completed', 'r2')], rootRunId: 'r1', jobs: [job('succeeded')] }, 20_000), 'quiet');
    assert.equal(at({ runs: [run('completed'), run('completed', 'r2')], rootRunId: 'r1', jobs: [job('succeeded')] }, 39_999), 'quiet');
    assert.equal(at({ runs: [run('completed'), run('completed', 'r2')], rootRunId: 'r1', jobs: [job('succeeded')] }, 40_000), 'settled');
  });
  test('a job that waits for budget while nothing else runs is its own state; a failed root run still settles', () => {
    assert.equal(settleStep(fresh(), { runs: [run('completed')], rootRunId: 'r1', jobs: [job('awaiting_budget')] }, 100).state, 'awaiting_budget');
    assert.equal(settleStep({ lastChangeAt: 0, signature: JSON.stringify([['r1:failed'], []]) }, { runs: [run('failed')], rootRunId: 'r1', jobs: [] }, 60_000, { quietMs: 20_000 }).state, 'settled');
  });
});

describe('which stack may be used for what', () => {
  const receipt = { diagnostic: true, origin: 'http://127.0.0.1:41000', instance: 'abc', budget: { allModelPurposes: true }, kernelVersion: '9.9.9-test', isolation: 'host-kernel diagnostic', sourceSha: 'deadbeef', dirty: false,
    resolvedConfig: { production: false, memoryEnabled: false, memoryRecallEnabled: false, nativeMemoryTurnCommitEnabled: false, learningEnabled: false } };
  const args = { receipt, diagnostic: true, origin: 'http://127.0.0.1:41000', pinned: '9.9.9-test' };
  test('a diagnostic run takes a host-kernel receipt that says what it is, and writes that down', async () => {
    assert.deepEqual(await acceptReceipt(args), { diagnostic: true, isolation: 'host-kernel diagnostic', kernelVersion: '9.9.9-test', sourceSha: 'deadbeef', dirty: false });
  });
  test('it refuses a receipt that does not say so, another origin, memory switched on, production, or a kernel off the pin', async () => {
    for (const [change, code] of /** @type {Array<[any, string]>} */ ([[{ diagnostic: undefined }, 'receipt_refused'], [{ origin: 'http://127.0.0.1:41001' }, 'receipt_refused'], [{ instance: '' }, 'receipt_refused'],
      [{ budget: {} }, 'receipt_refused'], [{ kernelVersion: '0.1.7' }, 'receipt_refused'], [{ resolvedConfig: { ...receipt.resolvedConfig, memoryEnabled: true } }, 'receipt_refused'],
      [{ resolvedConfig: { ...receipt.resolvedConfig, production: true } }, 'receipt_refused']])) {
      await assert.rejects(() => acceptReceipt({ ...args, receipt: { ...receipt, ...change } }), { code });
    }
    await assert.rejects(() => acceptReceipt({ ...args, origin: 'http://10.0.0.1:41000', receipt: { ...receipt, origin: 'http://10.0.0.1:41000' } }), { code: 'receipt_refused' });
  });
  test('a formal run is the comparison campaign\'s own verifier, which refuses this stack; without it the formal path is refused outright', async () => {
    await assert.rejects(() => acceptReceipt({ ...args, diagnostic: false }), { code: 'formal_refused' });
    await assert.rejects(() => acceptReceipt({ ...args, diagnostic: false, formal: async () => { throw new Error('Formal benchmarking requires a paid Docker control plane on an internal runtime network'); } }), /Docker control plane/u);
    assert.deepEqual(await acceptReceipt({ ...args, diagnostic: false, formal: async () => 'verified' }), { diagnostic: false });
  });
});

describe('a case on a scripted platform', () => {
  /**
   * The platform's routes as the runner uses them. `script` picks what the polls answer; everything the runner sent is kept.
   * @param {{ polls?: Array<{ runs: any[], jobs: any[] }>, failOn?: string, closeResult?: { deleted: boolean, reason: string | null }, abortAfterDispatch?: AbortController, dispatchFails?: boolean }} [options]
   */
  function platform({ polls = [], failOn = '', closeResult = { deleted: true, reason: null }, abortAfterDispatch = undefined, dispatchFails = false } = {}) {
    /** @type {Array<{ method: string, route: string, body: any, headers: Record<string, string> }>} */ const seen = [];
    /** @type {any} */ const state = { polled: 0, closed: 0, stopped: 0, readCalls: 0 };
    /** The runs and jobs a cancel reached: the double honours it, as the platform does. */
    const ended = new Set();
    // The platform answers `{ data }` on success and `{ code, message }` on a refusal.
    const answer = (/** @type {any} */ data, status = 200) => ({ status, headers: { get: (/** @type {string} */ name) => (name === 'x-evimed-benchmark-instance' ? 'inst-1' : null) }, json: async () => (status >= 400 ? data : { data }) });
    const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
      const route = url.replace('http://127.0.0.1:1', '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      seen.push({ method: init.method, route, body, headers: init.headers });
      if (failOn && route.startsWith(failOn)) return answer({ code: 'boom' }, 500);
      if (route === '/api/projects') return answer({ id: body.id }, 201);
      if (route === '/api/files/upload') return answer({ source: { id: `src-${body.path}` }, vcrInput: null });
      if (route === '/api/runtime/sessions') return answer({ id: 'sess-1' }, 201);
      if (route.startsWith('/api/research-sessions/')) return answer({});
      if (route === '/api/agent-runs/dispatch') { if (dispatchFails) return answer({ code: 'dispatch_refused' }, 500); abortAfterDispatch?.abort(); return answer({ id: 'run-1' }, 202); }
      if (route === '/api/agent-runs' && init.method === 'GET') { const poll = polls[Math.min(state.polled, polls.length - 1)] ?? { runs: [], jobs: [] }; state.polled += 1; state.current = poll; return answer({ runs: poll.runs.map((run) => (ended.has(run.id) ? { ...run, status: 'canceled' } : run)) }); }
      if (route.includes('/cancel')) { state.cancelled = [...(state.cancelled ?? []), route]; ended.add(route.split('/').at(-2)); return answer({}); }
      if (route === '/api/vcr/studies') return answer({ conversationStudies: [{ id: 'st-1', projectId: seen.find((entry) => entry.route === '/api/projects')?.body.id }], studies: [] });
      if (route === '/api/vcr/studies/st-1/jobs') return answer({ jobs: (state.current?.jobs ?? []).map((job) => (ended.has(job.id) ? { ...job, state: 'canceled' } : job)) });
      if (route === '/api/commands/stop_runtime') { state.stopped += 1; return answer({}); }
      if (route.startsWith('/api/runtime/sessions/') && route.endsWith('/transcript')) return answer({ messages: [] });
      if (route.startsWith('/api/sources/outputs')) return answer({ outputs: [] });
      if (route === '/api/account/usage') return answer({ actualCost: 0.42, currency: 'CNY' });
      return answer({});
    };
    const openAccount = async (/** @type {any} */ input) => ({ id: 'acct-1', headers: { cookie: 'session=x' }, close: async () => { state.closed += 1; await input.stop({ id: 'acct-1' }); return closeResult; } });
    return { fetchImpl: /** @type {any} */ (fetchImpl), openAccount: /** @type {any} */ (openAccount), seen, state };
  }
  const settledPolls = [
    { runs: [{ id: 'run-1', status: 'running', automated: true }], jobs: [] },
    { runs: [{ id: 'run-1', status: 'completed', automated: true }], jobs: [{ id: 'j-1', state: 'running' }] },
    { runs: [{ id: 'run-1', status: 'completed', automated: true }], jobs: [{ id: 'j-1', state: 'succeeded' }] },
  ];
  const saved = { ranking: [{ target: { registryId: 'NCT00000002' }, fit: 80, confidence: 0.8, verdict: 'eligible' }, { target: { registryId: 'NCT00000001' }, fit: 40, confidence: 0.4, verdict: 'possible' }],
    failed: [{ registryId: 'NCT00000003', code: 'registry_unavailable' }], usage: { inputTokens: 1000, outputTokens: 100, costCny: 0.42, calls: 4 }, readFrom: 'saved judgments (job)', studies: ['st-1'], subjects: 1 };
  const files = [{ name: 'patient.txt', path: '', sha256: '' }, { name: 'trials.txt', path: '', sha256: '' }];
  const withFiles = (/** @type {string} */ dir) => files.map((file) => {
    const full = path.join(dir, file.name);
    fs.writeFileSync(full, `${file.name} text`);
    return { ...file, path: full, sha256: createHash('sha256').update(`${file.name} text`).digest('hex') };
  });
  const caseDir = () => tmp('case');

  const run = async (/** @type {ReturnType<typeof platform>} */ stub, /** @type {string} */ dir, extra = {}) => runBoardCase({
    base: 'http://127.0.0.1:1', instance: 'inst-1', row: ROW, files: withFiles(dir), arm: 'native', outDir: path.join(dir, 'out'), timeoutMs: 60_000, quietMs: 0,
    read: async () => saved, deps: { openAccount: stub.openAccount, fetchImpl: stub.fetchImpl, sleepMs: async () => {}, pollMs: 0, ...(/** @type {any} */ (extra)) },
    ...(/** @type {any} */ (extra.signal ? { signal: extra.signal } : {})),
  });

  test('success: an automated dispatch of the arm\'s request, the polls to a settled state, the saved judgments read, the account deleted once', async () => {
    const dir = caseDir();
    try {
      const stub = platform({ polls: settledPolls });
      const record = await run(stub, dir);
      assert.equal(record.status, 'settled', JSON.stringify(record.error));
      const dispatch = stub.seen.find((entry) => entry.route === '/api/agent-runs/dispatch');
      assert.deepEqual([dispatch?.body.automated, dispatch?.body.line], [true, 'answer']);
      assert.equal(dispatch?.body.text, promptFor({ arm: 'native', collection: 'tg2-sigir' }));
      assert.ok(stub.seen.every((entry) => entry.headers['x-evimed-automated'] === '1'), 'every request is marked automated');
      assert.deepEqual(stub.seen.filter((entry) => entry.route === '/api/files/upload').map((entry) => entry.body.path), ['inputs/patient.txt', 'inputs/trials.txt']);
      assert.equal(stub.state.closed, 1);
      assert.ok(stub.state.stopped >= 1, 'the runtime is stopped before the account goes');
      assert.equal(record.cleanup.deleted, true);
      assert.equal(record.saved.readFrom, 'saved judgments (job)');
      assert.ok(fs.existsSync(path.join(dir, 'out', 'p-1', 'case.json')));
      const line = exportRecord(ROW, record);
      assert.deepEqual([line.status, line.ranking.map((entry) => entry.registryId), line.ranking.map((entry) => entry.rank), line.failed], ['partial', ['NCT00000002', 'NCT00000001'], [1, 2], [{ registryId: 'NCT00000003', code: 'registry_unavailable' }]]);
      assert.deepEqual([line.caseStatus, line.arm, line.usage.costCny], ['settled', 'native', 0.42]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a case that saved nothing is a missing result, not a success, and its record is empty with the reason', async () => {
    const dir = caseDir();
    try {
      const stub = platform({ polls: settledPolls });
      const record = await runBoardCase({ base: 'http://127.0.0.1:1', instance: 'inst-1', row: ROW, files: withFiles(dir), arm: 'job', outDir: path.join(dir, 'out'), timeoutMs: 60_000, quietMs: 0,
        read: async () => ({ ranking: [], failed: [], usage: null, readFrom: 'saved judgments (none)', studies: ['st-1'], subjects: 0 }), deps: { openAccount: stub.openAccount, fetchImpl: stub.fetchImpl, sleepMs: async () => {}, pollMs: 0 } });
      assert.equal(record.status, 'missing_feature_result');
      const line = exportRecord(ROW, record);
      assert.deepEqual([line.status, line.why, line.ranking.length], ['none', 'missing_feature_result', 0]);
      assert.equal(stub.state.closed, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('failure: a refused dispatch is a failed case, the partial result is still read, and the account is deleted all the same', async () => {
    const dir = caseDir();
    try {
      const stub = platform({ dispatchFails: true });
      const record = await run(stub, dir);
      assert.equal(record.status, 'failed');
      assert.equal(record.error.code, 'dispatch_refused');
      assert.equal(stub.state.closed, 1);
      assert.equal(record.cleanup.deleted, true);
      assert.ok(record.saved, 'what the platform holds is read even then');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('interruption: the run in hand is cancelled, its job is cancelled, the runtime is stopped and the account is deleted', async () => {
    const dir = caseDir();
    try {
      const abort = new AbortController();
      const polls = [{ runs: [{ id: 'run-1', status: 'running', automated: true }], jobs: [{ id: 'j-1', state: 'running' }] }];
      const stub = platform({ polls, abortAfterDispatch: abort });
      const record = await run(stub, dir, { signal: abort.signal });
      assert.equal(record.status, 'interrupted');
      assert.equal(stub.state.closed, 1);
      assert.ok(stub.state.cancelled?.some((route) => route.includes('/api/agent-runs/run-1/cancel')));
      assert.ok(stub.state.cancelled?.some((route) => route.includes('/jobs/j-1/cancel')));
      assert.ok(stub.state.stopped >= 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a deletion the platform refuses is named, and the case reads as a failure to clean up, never as done', async () => {
    const dir = caseDir();
    try {
      const stub = platform({ polls: settledPolls, closeResult: { deleted: false, reason: '409 account_busy' } });
      const record = await run(stub, dir);
      assert.equal(record.status, 'cleanup_failed');
      assert.equal(record.cleanup.reason, '409 account_busy');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a changed input file is refused before anything is uploaded', async () => {
    const dir = caseDir();
    try {
      const stub = platform({ polls: settledPolls });
      const wrong = withFiles(dir).map((file) => ({ ...file, sha256: '0'.repeat(64) }));
      const record = await runBoardCase({ base: 'http://127.0.0.1:1', instance: 'inst-1', row: ROW, files: wrong, arm: 'job', outDir: path.join(dir, 'out'), timeoutMs: 60_000, quietMs: 0,
        read: async () => saved, deps: { openAccount: stub.openAccount, fetchImpl: stub.fetchImpl, sleepMs: async () => {}, pollMs: 0 } });
      assert.equal(record.status, 'failed');
      assert.match(record.error.message, /Frozen input changed/u);
      assert.equal(stub.seen.some((entry) => entry.route === '/api/files/upload'), false);
      assert.equal(stub.state.closed, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('what a run ends', () => {
  test('processes are recognised by their own paths: a kernel carrying a path under the run\'s directory is found, another is not', async () => {
    const dir = tmp('own');
    const other = tmp('other');
    const mine = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', path.join(dir, 'x', 'dsh')], { stdio: 'ignore' });
    const theirs = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', path.join(other, 'x', 'dsh')], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      const found = ownedProcesses(dir);
      assert.ok(found.includes(/** @type {number} */ (mine.pid)));
      assert.equal(found.includes(/** @type {number} */ (theirs.pid)), false, 'a process of another run is never taken');
      assert.deepEqual(ownedProcesses(), []);
    } finally {
      mine.kill('SIGKILL'); theirs.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('a run past the cap or in the window is refused before anything is started, and a plan starts nothing', async () => {
    const dir = tmp('run');
    try {
      const boards = path.join(dir, 'boards');
      fs.mkdirSync(path.join(boards, 'A-sigir'), { recursive: true });
      fs.writeFileSync(path.join(boards, 'A-sigir', 'cases.jsonl'), `${JSON.stringify(ROW)}\n`);
      const options = parseOptions(['--arm', 'job', '--board', 'sigir', '--data-dir', path.join(dir, 'data'), '--boards', boards, '--live-root', path.join(dir, 'live'), '--os', path.join(dir, 'os'), '--key-file', path.join(dir, 'key'), '--db-url', 'postgres://x@127.0.0.1:1/p'], {});
      const lines = [];
      const planned = await runProduct({ ...options, planOnly: true }, { log: (line) => lines.push(line), signals: false, balance: null });
      assert.equal(planned.exitCode, EXIT.finished);
      assert.equal(planned.summary.planOnly, true);
      const peak = await runProduct({ ...options }, { log: (line) => lines.push(line), signals: false, balance: null, now: () => new Date('2026-11-04T08:00:00Z') });
      assert.equal(peak.exitCode, EXIT.refused);
      assert.equal(peak.summary.refused.code, 'peak_window');
      const capped = await runProduct({ ...options, allowPeak: true, capCny: 0.5 }, { log: (line) => lines.push(line), signals: false, balance: null, now: () => new Date('2026-11-04T12:00:00Z') });
      assert.equal(capped.summary.refused.code, 'cap');
      const poor = await runProduct({ ...options, allowPeak: true }, { log: (line) => lines.push(line), signals: false, balance: async () => ({ code: 2, balance: 100, line: '' }), now: () => new Date('2026-11-04T12:00:00Z') });
      assert.equal(poor.summary.refused.code, 'balance_floor');
      assert.equal(fs.existsSync(path.join(dir, 'data', 'spend-ledger.jsonl')) ? fs.readFileSync(path.join(dir, 'data', 'spend-ledger.jsonl'), 'utf8') : '', '', 'nothing was spent');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real stack, up to the model call: only when the environment names it.
// ---------------------------------------------------------------------------------------------------------------------

const LIVE = ['VCR_BOARDS_LIVE', 'OS', 'OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE', 'OPEN_SCIENCE_TEST_POSTGRES_URL'].every((name) => process.env[name]);
describe('the real stack, up to the model call', { skip: !LIVE && 'VCR_BOARDS_LIVE, OS, the key file and a test PostgreSQL are not named in the environment' }, () => {
  test('server, throwaway account, session, a kernel that came up, no prompt dispatched, no model request, the account and the server gone', { timeout: 600_000 }, async () => {
    const dir = tmp('real');
    try {
      const options = parseOptions(['--readiness', '--diagnostic', '--data-dir', dir, '--db-name', `evimed_test_vmlive_t${Math.random().toString(16).slice(2, 8)}`], process.env);
      const lines = [];
      const result = await runProduct(options, { log: (line) => lines.push(line), signals: false, dropDatabaseAfter: true });
      assert.equal(result.exitCode, EXIT.finished, lines.join('\n'));
      const ready = result.summary.readinessResult;
      assert.deepEqual([ready.accountCreated, ready.sessionOpened, ready.kernelAnswered, ready.accountDeleted, ready.modelRequests, ready.paidRequests], [true, true, true, true, 0, 0]);
      assert.ok(ready.standInRequests >= 0, 'whatever the server asked of a model at its first start went to the local stand-in, and is counted there');
      assert.equal(result.summary.stack.diagnostic, true);
      assert.deepEqual(ownedProcesses(path.join(options.liveRoot)), [], 'no kernel of this run is left');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
