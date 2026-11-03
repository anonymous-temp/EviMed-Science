// The monthly frontier campaign end to end, unattended: the real lab script (rsi-lab-monthly.sh) against stand-ins for docker, the lab's database and DashScope
// (fixtures/fake_docker.mjs, fixtures/frontier_labels_stand_in.mjs). The real node entries run (plan, calibrate, label, decide, merge-labels, build, the report); only the
// database, the runner, the evaluator and the model's transport are stubs. The jury is Qwen 3.8 Max on the lab: no operator, no wait.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rsiCampaignIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { rsiLabConfigurationIssues } from '../../../apps/server/src/rsiLabConfiguration.mjs';
import { rsiIncumbent, rsiPolicyDefaults } from '../../../apps/server/src/rsiServingAdapters.mjs';
import { replayFrontierPool } from '../frontier_selection.mjs';
import { frontierDayPool, frontierDaysSource, labConfiguration } from '../profiles/benign_fixture.mjs';
import { loadGoldRows } from '../frontier_labels.mjs';
import { shiftMonth } from '../frontier_assemble.mjs';

const execFileAsync = promisify(execFile);
const repo = new URL('../../../', import.meta.url).pathname;
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const goldPath = new URL('../../frontier-selection/gold.jsonl', import.meta.url).pathname;
const labScript = join(repo, 'deploy/rsi-campaign/rsi-lab-monthly.sh');
const BASELINE = 64;
const CURRENT = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const INCUMBENT = { revisionId: rsiIncumbent('frontier', null, rsiPolicyDefaults('frontier', { frontierSelectThreshold: BASELINE })).revisionId, threshold: BASELINE };
/** The pinned rubric, exemplar set and model: the lab's answer cache is keyed on this string. */
const JURY_VERSION = 'frontier-jury-v1:7ac3c0f634c5';
const SECRET = 'sk-flow-SECRET-0123456789abcdef';
/** CNY of one fake call: 1000 cached and 500 uncached prompt tokens and 20 output tokens at qwen3.8-max's 1.5 / 12 / 36 per million. */
const CALL_CNY = (1000 * 1.5 + 500 * 12 + 20 * 36) / 1e6;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gold = await loadGoldRows(goldPath);
/** The calibration is the even-n anchor rows, two passes each, forty calls to a batch. */
const CALIBRATION_CALLS = 2 * gold.filter((row) => row.n % 2 === 0).length;
const CALIBRATION_BATCHES = Math.ceil(CALIBRATION_CALLS / 40);
/** Every scratch tree a test makes is removed when the file is done: a tree holds an export, a labelled corpus and the run's state. */
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

/** An export of the two months before `month`, with the source text of every row; the title carries the label the stand-in jury answers. */
function exportFor(month, { perfectBaseline = false } = {}) {
  const dev = shiftMonth(month, -2), conf = shiftMonth(month, -1);
  const development = frontierDaysSource({ start: `${dev}-01`, days: 14, rowsPerDay: 26, seed: 11, prefix: 'dev', cutoffs: [72, 72, 74, 76] }).days;
  const confirmation = frontierDaysSource({ start: `${conf}-01`, days: 12, rowsPerDay: 26, seed: 12, prefix: 'conf', cutoffs: [72, 72, 74, 76] }).days;
  const days = [...development, ...confirmation];
  const baselineSelects = new Set(days.flatMap((day) => replayFrontierPool(day, BASELINE).selectedIds.map(String)));
  const texts = {};
  for (const day of days) for (const row of day.rows) {
    const worth = perfectBaseline ? (baselineSelects.has(String(row.id)) ? 'pick' : 'ok') : row.safety_alert === true || row.score_total >= 72 ? 'pick' : row.score_total >= 68 ? 'ok' : 'no';
    texts[row.id] = { title_raw: `Row ${row.id} [${worth}]`, source_name: 'Source', source_type: 'media', journal: null, publication_types: [], published_at: `${day.day}T01:00:00.000Z`, date_precision: 'day', lang: 'en',
      excerpt: `Text of ${row.id}`, title_zh: 'PLATFORM-WRITTEN', summary_zh: 'PLATFORM-SUMMARY' };
  }
  return { schema: 'rsi-frontier-export-v1', exportedAt: `${month}-01T00:00:00Z`, releaseId: 'release-flow.1', from: `${dev}-01`, to: `${conf}-28`,
    settings: { threshold: BASELINE, thresholdSource: 'config', preprintPlaces: 2, preprintMinScore: 50, scoreVersion: 'current', timeZone: 'Asia/Shanghai' },
    incumbent: INCUMBENT, consumer: [], days, texts, signals: {} };
}

/** A lab host's tree as directories: the lab's state, inbox and outbox, its owner inputs and credentials, and the stand-in docker on PATH. `key: false` leaves the jury's key out. */
async function tree(document, { month = CURRENT, key = SECRET } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-flow-'));
  scratch.push(dir);
  const root = join(dir, 'lab'), etc = join(dir, 'etc'), bin = join(dir, 'bin');
  for (const path of [join(root, 'state'), join(root, 'inbox'), join(root, 'outbox'), join(etc, 'secrets'), join(etc, 'owner-inputs'), join(etc, 'keys'), join(etc, 'credentials'), bin]) await mkdir(path, { recursive: true });
  await writeFile(join(etc, 'image'), 'evimed-rsi-lab:test\n');
  await writeFile(join(etc, 'secrets', 'lab.env'), 'RSI_LAB_DATABASE_URL=postgres://unused\n');
  await writeFile(join(etc, 'owner-inputs', 'config.json'), JSON.stringify(labConfiguration));
  if (key !== false) await writeFile(join(etc, 'credentials', 'dashscope.key'), `${key}\n`);
  const bytes = gzipSync(JSON.stringify(document));
  const name = `frontier-${month}.json.gz`;
  await writeFile(join(root, 'inbox', name), bytes);
  await writeFile(join(root, 'inbox', `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
  await symlink(join(fixtures, 'fake_docker.sh'), join(bin, 'fake-docker'));
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, RSI_LAB_ROOT: root, RSI_LAB_ETC: etc, RSI_LAB_DOCKER: join(bin, 'fake-docker'), RSI_LAB_OWNER: `${process.getuid()}:${process.getgid()}`,
    RSI_LAB_POLL_SECONDS: '0', FAKE_DOCKER_REPO: repo, FAKE_DOCKER_LOG: join(dir, 'docker.jsonl'), FAKE_BUDGET_LEDGER: join(dir, 'ledger.json'), FAKE_DASHSCOPE_LOG: join(dir, 'dashscope.jsonl'),
    FAKE_DASHSCOPE_GOLD: goldPath, FAKE_DASHSCOPE_WORTH: 'by-title', FAKE_DASHSCOPE_MODE: 'ok' };
  const lines = async (file) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return {
    dir, root, etc, env, month,
    lab: (args = [], over = {}) => execFileAsync('bash', [labScript, ...args], { cwd: dir, env: { ...env, ...over }, maxBuffer: 1 << 24 }).catch((error) => error),
    status: async (state = month) => await lines(join(root, 'state', state, 'STATUS')),
    steps: async (state = month) => (await lines(join(root, 'state', state, 'STATUS'))).map((line) => line.split(' ')[0]),
    docker: async () => (await lines(env.FAKE_DOCKER_LOG)).map((line) => JSON.parse(line)),
    jury: async () => (await lines(env.FAKE_DASHSCOPE_LOG)).map((line) => JSON.parse(line)),
    ledger: async () => JSON.parse(await readFile(env.FAKE_BUDGET_LEDGER, 'utf8').catch(() => '{"records":{},"granted":0,"settles":[]}')),
    read: async (...path) => JSON.parse(await readFile(join(root, ...path), 'utf8')),
    text: (...path) => readFile(join(root, ...path), 'utf8'),
    ls: (...path) => readdir(join(root, ...path)).catch(() => []),
    /** The answers a jury cache holds: `state/jury-cache.jsonl`, or a month's calibration cache. */
    cached: async (...path) => (await lines(join(root, 'state', ...path))).map((line) => JSON.parse(line)),
    /** Another month's export in the inbox, as production pushes it. */
    pushExport: async (other, otherDocument) => {
      const otherBytes = gzipSync(JSON.stringify(otherDocument)), otherName = `frontier-${other}.json.gz`;
      await writeFile(join(root, 'inbox', otherName), otherBytes);
      await writeFile(join(root, 'inbox', `${otherName}.sha256`), `${sha(otherBytes)}  ${otherName}\n`);
    },
  };
}
const ok = (result, what) => assert.ok(!(result instanceof Error) || result.code === 0, `${what}: ${result.stderr ?? result.message}`);
const scripts = (calls) => calls.map((call) => call.script.split('/').pop());
/** The jury's calls among a docker log: the only ones that may carry the provider credential. */
const juryCalls = (calls) => calls.filter((call) => call.script.endsWith('frontier_labels.mjs'));
const KEY_MOUNT = '/run/rsi-credentials/dashscope.key';

/** Every file under a tree, but the key's own: the key must be in none of them. */
async function assertKeyNowhere(t) {
  for (const entry of await readdir(t.dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path === join(t.etc, 'credentials', 'dashscope.key')) continue;
    assert.ok(!(await readFile(path)).includes(SECRET), `the key is in ${path.slice(t.dir.length)}`);
  }
}

test('the pinned jury: rubric v1 and the exemplar set are what the lab\'s answer cache is keyed on', async () => {
  const { frontierJuryVersion, selectFrontierExemplars } = await import('../frontier_labels.mjs');
  assert.equal(frontierJuryVersion(selectFrontierExemplars(gold)), JURY_VERSION);
});

test('a month with no development candidate: development is labelled, confirmation never is, nothing is opened, no alpha is drawn; the whole month ran unattended', async () => {
  const t = await tree(exportFor(CURRENT, { perfectBaseline: true }));
  const result = await t.lab();
  ok(result, 'lab');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide']);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_no_improving_candidate' });
  const plan = await t.read('state', CURRENT, 'plan.json');
  // Only development items (and the anchor's calibration rows) were ever sent to the jury; the confirmation month was not.
  const asked = await t.jury();
  assert.ok(asked.some((call) => call.title.includes('Row dev-')) && !asked.some((call) => call.title.includes('Row conf-')), 'no confirmation item was sent to the jury');
  assert.ok(asked.every((call) => call.model === 'qwen3.8-max' && call.authorized && call.url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'));
  const files = await t.ls('state', CURRENT);
  assert.ok(files.includes('labels-development.json') && !files.includes('labels-confirmation.json') && !files.includes('manifest.json'), files.join());
  assert.equal(scripts(await t.docker()).filter((name) => name === 'run.mjs').length, 0, 'the runner never opened anything');
  const supply = await t.read('state', CURRENT, 'supply.json');
  assert.equal(supply.developmentChoice.frozen, null);
  assert.deepEqual([supply.confirmation.labelled, supply.confirmation.measuredDays], [null, null]);
  const development = await t.read('state', CURRENT, 'labels-development.json');
  assert.deepEqual([development.schema, development.phase, development.month, development.provider, development.model, development.juryVersion, development.stopped, development.incomplete, development.exportSha256],
    ['rsi-frontier-jury-labels-v1', 'development', CURRENT, 'dashscope', 'qwen3.8-max', JURY_VERSION, null, 0, plan.exportSha256]);
  assert.equal(development.labelled, plan.idsByRole.development.length);
  // The report says it, and what the jury cost.
  const outbox = await t.ls('outbox', CURRENT);
  assert.ok(outbox.includes('report.md') && outbox.includes('report.json') && !outbox.includes('bundle.json'));
  const text = await t.text('outbox', CURRENT, 'report.md');
  assert.match(text, /^- 确认期未标注：开发期没有选出候选，确认月未被标注、未被打开，本季度 α 未动用$/m);
  assert.match(text, /^- 标注：qwen3\.8-max 双盲评审，校准 κ=.*花费约 ¥\d+\.\d\d$/m);
  const report = await t.read('outbox', CURRENT, 'report.json');
  assert.equal(report.confirmationLabelled, false);
  const ledger = await t.ledger();
  const settled = ledger.settles.reduce((sum, row) => sum + row.actualCny, 0);
  assert.ok(Math.abs(settled - asked.length * CALL_CNY) < 1e-6, `${settled} CNY settled for ${asked.length} calls`);
  assert.ok(Math.abs(report.jury.costCny + report.labelling.costCny - settled) < 1e-6, 'the report\'s cost is what the ledger settled');
  assert.ok(ledger.settles.every((row) => row.outcome === 'success' && row.actualCny < row.reservedCny), 'every batch reserved an upper bound and settled the priced actual');
  await assertKeyNowhere(t);
});

test('a month with a development candidate labels both phases, merges them and runs to the runner', async () => {
  const t = await tree(exportFor(CURRENT));
  ok(await t.lab(), 'lab');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run']);
  const plan = await t.read('state', CURRENT, 'plan.json');
  assert.equal((await t.read('state', CURRENT, 'decision.json')).status, 'confirmation-needed');
  // Confirmation items reach the jury only after every development item, and only the plan's own ids.
  const asked = await t.jury();
  const lastDevelopment = asked.findLastIndex((call) => call.title.includes('Row dev-')), firstConfirmation = asked.findIndex((call) => call.title.includes('Row conf-'));
  assert.ok(firstConfirmation > lastDevelopment && lastDevelopment > 0);
  const merged = await t.read('state', CURRENT, 'labels.json');
  assert.deepEqual([merged.schema, merged.phase, merged.provider, merged.model, merged.juryVersion, merged.stopped, merged.incomplete], ['rsi-frontier-jury-labels-v1', 'all', 'dashscope', 'qwen3.8-max', JURY_VERSION, null, 0]);
  assert.equal(merged.labelled, plan.ids.length);
  const confirmation = await t.read('state', CURRENT, 'labels-confirmation.json');
  assert.deepEqual([confirmation.phase, confirmation.labelled], ['confirmation', plan.idsByRole.confirmation.length]);
  const manifest = await t.read('state', CURRENT, 'manifest.json');
  assert.deepEqual(rsiCampaignIssues(manifest), []);
  assert.equal(manifest.target.baselineRevision, INCUMBENT.revisionId, 'the baseline is the incumbent identity production exported');
  assert.deepEqual(manifest.models.judges, [{ role: 'jury', provider: 'dashscope', model: 'qwen3.8-max', id: JURY_VERSION }]);
  assert.deepEqual(manifest.models.improvers, []);
  const inputs = await t.read('state', CURRENT, 'inputs.json');
  assert.deepEqual([inputs.registration.labelling.provider, inputs.registration.labelling.model, inputs.registration.labelling.juryVersion], ['dashscope', 'qwen3.8-max', JURY_VERSION]);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_stubbed_runner' });
  assert.equal(merged.costCny + (await t.read('state', CURRENT, 'calibration.json')).costCny > 0, true);
  const ledger = await t.ledger();
  assert.ok(Math.abs(ledger.settles.reduce((sum, row) => sum + row.actualCny, 0) - asked.length * CALL_CNY) < 1e-6);
  assert.ok(!(await t.text('outbox', CURRENT, 'report.md')).includes('确认期未标注'), 'its confirmation was labelled');
  // The provider credential is mounted by the jury's two commands and by no other step, on the lab's network, read-only.
  const calls = await t.docker();
  const mounted = calls.filter((call) => call.mounts.includes(KEY_MOUNT));
  assert.deepEqual(mounted.map((call) => call.args[0]), ['calibrate', 'label', 'label']);
  assert.ok(mounted.every((call) => call.script.endsWith('frontier_labels.mjs') && call.network === 'rsi-lab-net'));
  assert.ok(calls.filter((call) => !call.script.endsWith('frontier_labels.mjs')).every((call) => !call.mounts.some((mount) => /credential|dashscope/i.test(mount))));
  assert.equal(juryCalls(calls).length, 3);
  // A second start changes nothing about the labelling: every finished step is skipped, nothing is asked of the jury and nothing is paid again.
  const before = { status: (await t.status()).length, asked: asked.length, settles: ledger.settles.length };
  ok(await t.lab(), 'lab again');
  assert.equal((await t.status()).length, before.status);
  assert.equal((await t.jury()).length, before.asked);
  assert.equal((await t.ledger()).settles.length, before.settles);
  await assertKeyNowhere(t);
});

test('a calibration that does not qualify ends the month before a single item is labelled, by its closed reason, with a report', async () => {
  const t = await tree(exportFor(CURRENT));
  // A jury that calls everything ok against the anchor has no kappa: not qualified, and the campaign stops instead of lowering the bar.
  const result = await t.lab([], { FAKE_DASHSCOPE_WORTH: 'ok' });
  ok(result, 'lab');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate']);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labels_unqualified' });
  const refusal = await t.read('state', CURRENT, 'refusal.json');
  assert.deepEqual([refusal.status, refusal.reason, refusal.calibration.qualification.qualified], ['not-run', 'campaign_labels_unqualified', false]);
  assert.ok(!(await t.ls('state', CURRENT)).includes('supply.json'), 'a refusal is not a supply');
  const asked = await t.jury();
  assert.equal(asked.length, CALIBRATION_CALLS);
  assert.ok(!asked.some((call) => call.title.includes('Row ')), 'no item of the month was sent to the jury');
  assert.equal(juryCalls(await t.docker()).length, 1);
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
  assert.match(await t.text('outbox', CURRENT, 'report.md'), /本月未运行\*\*（campaign_labels_unqualified）/);
});

test('a missing or blank key ends the month with a named outcome and a report: nothing is mounted, nothing is asked, nothing is built', async () => {
  for (const key of [false, '   ']) {
    const t = await tree(exportFor(CURRENT), { key });
    const result = await t.lab();
    assert.equal(result.code, 5, String(key));
    assert.match(result.stderr, /the jury's key .* is missing or empty/);
    assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_jury_credential_missing' });
    assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan']);
    // docker was never asked to mount the missing file (it would have made a directory there), and the jury was not reached
    assert.deepEqual(await readdir(join(t.etc, 'credentials')), key === false ? [] : ['dashscope.key']);
    const calls = await t.docker();
    assert.deepEqual(scripts(calls), ['lab_bootstrap.mjs', 'frontier_assemble.mjs', 'monthly_report.mjs', 'evaluator.mjs'], 'the plan, then the report and its signature');
    assert.equal((await t.jury()).length, 0);
    assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
    assert.ok(!(await t.ls('state', CURRENT)).some((name) => /^(calibration|labels|manifest)/.test(name)));
  }
});

test('a provider that is unavailable is a closed stop, not a crash: nothing is charged for what it rejected and the key is in no artifact', async () => {
  const t = await tree(exportFor(CURRENT));
  const result = await t.lab([], { FAKE_DASHSCOPE_MODE: 'http-401' });
  assert.equal(result.code, 5);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_jury_unavailable' });
  assert.equal((await t.read('state', CURRENT, 'calibration.json')).stopped, 'jury_unavailable');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan']);
  const ledger = await t.ledger();
  assert.ok(ledger.settles.length > 0 && ledger.settles.every((row) => row.actualCny === 0 && row.outcome === 'failed'), 'a request the provider rejected by status is not charged');
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
  await assertKeyNowhere(t);
});

test('a lab configuration without the jury\'s provider row (the one a lab has before it is reinstalled) spends nothing: the month ends by the configuration\'s own code', async () => {
  const t = await tree(exportFor(CURRENT));
  const { providers, ...stale } = labConfiguration;
  await writeFile(join(t.etc, 'owner-inputs', 'config.json'), JSON.stringify(stale));
  const result = await t.lab();
  assert.equal(result.code, 5);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_lab_configuration_invalid' });
  assert.deepEqual([(await t.jury()).length, (await t.ledger()).settles.length], [0, 0]);
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
});

test('a labelling stopped by the budget ends the month with the budget\'s own reason and a report; the next start asks only for what is missing and pays for nothing twice', async () => {
  const t = await tree(exportFor(CURRENT));
  // The calibration takes its batches; the development labelling gets one more and is then refused.
  const stopped = await t.lab([], { FAKE_BUDGET_ALLOW_RESERVES: String(CALIBRATION_BATCHES + 1) });
  assert.equal(stopped.code, 5, stopped.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_budget_exceeded' });
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate'], 'the unfinished labelling is not marked done, and nothing after it ran');
  const partial = await t.read('state', CURRENT, 'labels-development.json');
  assert.equal(partial.stopped, 'campaign_budget_exceeded');
  const plan = await t.read('state', CURRENT, 'plan.json');
  assert.ok(partial.incomplete > 0 && partial.labelled > 0 && partial.labelled < plan.idsByRole.development.length, `${partial.labelled} of ${plan.idsByRole.development.length} labelled`);
  assert.ok(!(await t.ls('state', CURRENT)).some((name) => /^(decision|manifest|labels\.json|supply)/.test(name)), 'no decision and no build on a partial labelling');
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
  const stoppedReport = await t.text('outbox', CURRENT, 'report.md');
  assert.match(stoppedReport, /本月未运行\*\*（campaign_budget_exceeded）/);
  const counts = partial.labelCounts;
  assert.ok(stoppedReport.includes(`本月标注 精选 ${counts.pick}、普通 ${counts.ok}、不展示 ${counts.no}、弃权 ${counts.abstained}、内容审查拒答 ${counts.refused}（已中止：campaign_budget_exceeded）`), stoppedReport);
  const paid = (await t.jury()).length;

  // The budget is lifted; the month resumes from its STATUS (the step name `calibrate` is a step of this script, not a legacy month) and finishes.
  const resumed = await t.lab();
  ok(resumed, 'resume');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run']);
  const asked = await t.jury();
  const pairs = asked.map((call) => `${call.title}|${call.system}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no (item, pass) was asked of the jury twice across the two starts');
  assert.ok(asked.length > paid, 'the resume asked for what was missing');
  const ledger = await t.ledger();
  assert.ok(Math.abs(ledger.settles.reduce((sum, row) => sum + row.actualCny, 0) - asked.length * CALL_CNY) < 1e-6, 'every call was paid once');
  const final = await t.read('state', CURRENT, 'labels-development.json');
  assert.deepEqual([final.stopped, final.incomplete, final.labelled, final.cachedCalls > 0], [null, 0, plan.idsByRole.development.length, true]);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_stubbed_runner' });
  assert.ok(!(await t.text('outbox', CURRENT, 'report.md')).includes('campaign_budget_exceeded'), 'the report was rewritten');
  // The signed figure is the month's, across both starts: the files of the last start alone would miss what the first one paid.
  const report = await t.read('outbox', CURRENT, 'report.json');
  const settled = ledger.settles.reduce((sum, row) => sum + row.actualCny, 0);
  assert.ok(Math.abs(report.jury.costCny + report.labelling.costCny - settled) < 1e-6, `${report.jury.costCny} + ${report.labelling.costCny} reported, ${settled} settled`);
  assert.ok((await t.cached('jury-cache.jsonl')).every((row) => row.campaignId === `frontier-selection-${CURRENT}`), 'every answer names the campaign that paid for it');
  await assertKeyNowhere(t);
});

/** The rows of the merged or phase labels, in the words the report uses. */
const reportCounts = (counts) => `本月标注 精选 ${counts.pick}、普通 ${counts.ok}、不展示 ${counts.no}、弃权 ${counts.abstained}、内容审查拒答 ${counts.refused}`;
const ARREARS = { FAKE_DASHSCOPE_REJECT_CODE: 'Arrearage' };

test('arrears (DashScope answers them with a 400) end the month by name: nothing cached, nothing charged, and a healthy restart labels everything', async () => {
  const t = await tree(exportFor(CURRENT));
  // from the first call: the calibration stops
  const atCalibration = await t.lab([], { ...ARREARS, FAKE_DASHSCOPE_MODE: 'http-400' });
  assert.equal(atCalibration.code, 5, atCalibration.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_jury_unavailable' });
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan']);
  assert.deepEqual([(await t.read('state', CURRENT, 'calibration.json')).stopped, (await t.read('state', CURRENT, 'calibration.json')).labelled], ['jury_unavailable', 0]);
  assert.deepEqual(await t.cached(CURRENT, 'calibration-cache.jsonl'), [], 'an account that cannot pay says nothing about any text');
  assert.ok((await t.ledger()).settles.every((row) => row.outcome === 'failed' && row.actualCny === 0));
  // from the month's own rows: the development labelling stops, with no decision
  const atDevelopment = await t.lab([], { ...ARREARS, FAKE_DASHSCOPE_REJECT: 'Row dev-' });
  assert.equal(atDevelopment.code, 5, atDevelopment.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labelling_incomplete' });
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate']);
  assert.deepEqual(await t.cached('jury-cache.jsonl'), []);
  assert.deepEqual((await t.read('state', CURRENT, 'labels-development.json')).labelled, 0);
  // the account is paid: every item is labelled, none of them an abstention left by the arrears
  ok(await t.lab(), 'restart');
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run']);
  const merged = await t.read('state', CURRENT, 'labels.json');
  assert.deepEqual([merged.labelled, merged.labelCounts.abstained, merged.labelCounts.refused], [(await t.read('state', CURRENT, 'plan.json')).ids.length, 0, 0]);
  await assertKeyNowhere(t);
});

test('arrears on the confirmation phase never open the corpus: the month stops before merge, build and run, and a healthy restart finishes it', async () => {
  const t = await tree(exportFor(CURRENT));
  const stopped = await t.lab([], { ...ARREARS, FAKE_DASHSCOPE_REJECT: 'Row conf-' });
  assert.equal(stopped.code, 5, stopped.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labelling_incomplete' });
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide']);
  assert.equal((await t.read('state', CURRENT, 'labels-confirmation.json')).stopped, 'jury_unavailable');
  assert.equal(scripts(await t.docker()).filter((name) => name === 'run.mjs').length, 0, 'the runner never opened the corpus');
  assert.ok(!(await t.ls('state', CURRENT)).some((name) => /^(labels\.json|manifest|inputs)/.test(name)));
  assert.ok(!(await t.cached('jury-cache.jsonl')).some((row) => row.id.startsWith('conf-')), 'nothing of the phase is cached');
  ok(await t.lab(), 'restart');
  assert.deepEqual((await t.steps()).slice(6), ['label-confirmation', 'merge', 'build', 'run']);
  const confirmation = await t.read('state', CURRENT, 'labels-confirmation.json');
  assert.deepEqual([confirmation.stopped, confirmation.incomplete, confirmation.labelCounts.abstained], [null, 0, 0]);
  assert.ok(confirmation.labels.every((label) => label.basis === 'jury-agree'));
});

test('the calibration measures every month: its own cache, fresh for each month, so a model that moved is caught; a resume within the month does not pay twice', async () => {
  const t = await tree(exportFor(CURRENT, { perfectBaseline: true }));
  ok(await t.lab(), 'the first month');
  assert.equal((await t.read('state', CURRENT, 'calibration.json')).qualification.qualified, true);
  const first = (await t.jury()).filter((call) => !call.title.startsWith('Row '));
  assert.equal(first.length, CALIBRATION_CALLS);
  assert.equal((await t.cached(CURRENT, 'calibration-cache.jsonl')).length, CALIBRATION_CALLS, 'in the month\'s own directory');
  assert.ok(!(await t.cached('jury-cache.jsonl')).some((row) => gold.some((entry) => entry.id === row.id)), 'none of it in the cache the months share');
  // The next month the alias answers differently: the provider is asked again and the month stops, where a replay of last month's answers would have qualified it.
  const next = shiftMonth(CURRENT, 1);
  await t.pushExport(next, exportFor(next, { perfectBaseline: true }));
  const moved = await t.lab([next], { FAKE_DASHSCOPE_WORTH: 'ok' });
  ok(moved, 'the next month');
  assert.equal((await t.jury()).filter((call) => !call.title.startsWith('Row ')).length, 2 * CALIBRATION_CALLS, 'asked again');
  assert.deepEqual(await t.read('state', next, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labels_unqualified' });
  assert.deepEqual(await t.steps(next), ['export', 'bootstrap', 'plan', 'calibrate']);
  assert.ok((await t.read('state', next, 'calibration.json')).costCny > 0, 'and its cost is that month\'s');
  assert.ok(Math.abs((await t.read('state', next, 'calibration.json')).costCny - CALIBRATION_CALLS * CALL_CNY) < 1e-6);
  // the month's calibration, stopped by the budget part-way and started again, pays for each pass once
  const resumed = await tree(exportFor(CURRENT));
  const part = await resumed.lab([], { FAKE_BUDGET_ALLOW_RESERVES: '1' });
  assert.equal(part.code, 5, part.stderr);
  assert.equal((await resumed.cached(CURRENT, 'calibration-cache.jsonl')).length, 40);
  ok(await resumed.lab([], { FAKE_DASHSCOPE_WORTH: 'by-title' }), 'resume');
  const pairs = (await resumed.jury()).filter((call) => !call.title.startsWith('Row ')).map((call) => `${call.title}|${call.system}`);
  assert.equal(pairs.length, CALIBRATION_CALLS);
  assert.equal(new Set(pairs).size, CALIBRATION_CALLS);
  assert.ok(Math.abs((await resumed.read('state', CURRENT, 'calibration.json')).costCny - CALIBRATION_CALLS * CALL_CNY) < 1e-6, 'the file says what both starts paid');
});

test('a calibration with unanswered rows is not marked done: the month ends by name and a healthy start finishes it, asking only for what is missing', async () => {
  const t = await tree(exportFor(CURRENT));
  const row = gold.find((entry) => entry.n % 2 === 0);
  const partial = await t.lab([], { FAKE_DASHSCOPE_REJECT: row.title_raw, FAKE_DASHSCOPE_REJECT_STATUS: '401' });
  assert.equal(partial.code, 5, partial.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_jury_unavailable' });
  assert.deepEqual(await t.steps(), ['export', 'bootstrap', 'plan']);
  assert.equal((await t.read('state', CURRENT, 'calibration.json')).incomplete, 1);
  const asked = (await t.jury()).length;
  ok(await t.lab(), 'resume');
  assert.ok((await t.steps()).includes('calibrate'));
  assert.deepEqual((await t.jury()).slice(asked, asked + 2).map((call) => call.title), [row.title_raw, row.title_raw]);
  const calibration = await t.read('state', CURRENT, 'calibration.json');
  assert.deepEqual([calibration.incomplete, calibration.labelled, calibration.qualification.qualified], [0, calibration.items, true]);
});

test('a crash is not reported as the stop an earlier start left in the output file: the outcome is this start\'s', async () => {
  const t = await tree(exportFor(CURRENT));
  const stopped = await t.lab([], { FAKE_BUDGET_ALLOW_RESERVES: String(CALIBRATION_BATCHES + 1) });
  assert.equal(stopped.code, 5, stopped.stderr);
  assert.equal((await t.read('state', CURRENT, 'labels-development.json')).stopped, 'campaign_budget_exceeded');
  const { providers, ...stale } = labConfiguration;
  await writeFile(join(t.etc, 'owner-inputs', 'config.json'), JSON.stringify(stale));
  const crashed = await t.lab();
  assert.equal(crashed.code, 5, crashed.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_lab_configuration_invalid' });
  // A start that crashed with no code of its own says the step's, not the budget's either.
  await writeFile(join(t.etc, 'owner-inputs', 'config.json'), '{ not json');
  const unreadable = await t.lab();
  assert.equal(unreadable.code, 5, unreadable.stderr);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labelling_incomplete' });
});

test('every lab step runs under an init and yields CPU in all three scripts: stopping a run stops its container (node as PID 1 ignores SIGTERM), and a contended shared host goes to its other products first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-init-'));
  scratch.push(dir);
  const root = join(dir, 'lab'), etc = join(dir, 'etc');
  const seed = async (name, files) => {
    const folder = join(root, 'inbox', name);
    await mkdir(folder, { recursive: true });
    for (const [file, text] of Object.entries(files)) { await writeFile(join(folder, file), text); await writeFile(join(folder, `${file}.sha256`), `${sha(Buffer.from(text))}  ${file}\n`); }
  };
  await mkdir(etc, { recursive: true });
  await seed('harness-medcalc-2026-11', { 'registration.json': JSON.stringify({ scorer: 'medcalc' }), 'development.json': '{}', 'improvement.json': '{}' });
  await seed('skill-2026-11', { 'registration.json': JSON.stringify({ failureCalculators: [2] }), 'development.json': '{}', 'candidates.json': '{}' });
  await writeFile(join(root, 'inbox', 'skill-2026-11', 'mode'), 'development-only\n');
  await writeFile(join(root, 'inbox', 'frontier-2026-11.json.gz'), 'dry-run'); await writeFile(join(root, 'inbox', 'frontier-2026-11.json.gz.sha256'), `${sha(Buffer.from('dry-run'))}  frontier-2026-11.json.gz\n`);
  for (const [script, args] of [['rsi-lab-monthly.sh', ['2026-11']], ['rsi-lab-harness.sh', ['2026-11', 'medcalc', 'develop']], ['rsi-lab-skill.sh', ['2026-11', 'run']]]) {
    const done = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc } }).catch((error) => error);
    const steps = done.stderr.split('\n').filter((line) => line.includes('[dry-run] docker run') && line.includes('--env-file'));
    assert.ok(steps.length > 0, `${script}: ${done.stderr}`);
    for (const line of steps) assert.match(line, /^\[dry-run\] docker run --rm --init --cpu-shares 256 /, script);
  }
});

test('the plan is written whole or not at all: by a rename, so a crash cannot leave the truncated file a later start would refuse as a legacy month', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-plan-'));
  scratch.push(dir);
  const exportPath = join(dir, 'export.json.gz'), out = join(dir, 'plan.json');
  await writeFile(exportPath, gzipSync(JSON.stringify(exportFor(CURRENT))));
  await writeFile(out, '{"idsByRole":{}}\n');
  const before = (await stat(out)).ino;
  await execFileAsync(process.execPath, [join(repo, 'evals/rsi-campaigns/frontier_assemble.mjs'), 'plan', '--export', exportPath, '--month', CURRENT, '--out', out]);
  assert.notEqual((await stat(out)).ino, before, 'a new file renamed over the old one, not the old one truncated and rewritten');
  assert.ok(JSON.parse(await readFile(out, 'utf8')).idsByRole.development.length > 0);
  assert.deepEqual((await readdir(dir)).sort(), ['export.json.gz', 'plan.json'], 'nothing left beside it');
});

test('an item the content check refuses is an abstention of its own: the unattended month goes on, nothing is billed for it, the report counts it apart, and a restart does not ask for it again', async () => {
  const t = await tree(exportFor(CURRENT));
  // every development row numbered 03 (a few of the day's rows, both passes) is refused with a 400 `data_inspection_failed`
  const run = await t.lab([], { FAKE_DASHSCOPE_REJECT: '-03 [' });
  ok(run, 'the month');
  const development = await t.read('state', CURRENT, 'labels-development.json');
  assert.equal(development.stopped, null, 'a few refused items do not stop the run');
  assert.equal(development.incomplete, 0, 'a refused item is answered: an abstention');
  const refused = development.labels.filter((label) => label.basis === 'jury-refused');
  assert.ok(refused.length > 0 && refused.every((label) => label.worth === null));
  assert.deepEqual([development.labelCounts.refused, development.labelCounts.abstained], [refused.length, 0]);
  const merged = await t.read('state', CURRENT, 'labels.json');
  assert.ok(merged.labelCounts.refused >= refused.length);
  assert.ok((await t.text('outbox', CURRENT, 'report.md')).includes(reportCounts(merged.labelCounts)), 'each kind apart');
  assert.ok(!/标注 \d+ 条/.test(await t.text('outbox', CURRENT, 'report.md')), 'never one total that counts an abstention as a label');
  assert.ok((await t.steps()).includes('label-development') && (await t.steps()).includes('decide'));
  const first = await t.jury();
  assert.ok(first.some((call) => call.title.includes('-03 [')));
  const before = (await t.read('state', CURRENT, 'labels-development.json')).costCny;
  // A second start of the finished month asks the provider nothing, the refused passes included.
  await t.lab([], { FAKE_DASHSCOPE_REJECT: '-03 [' });
  assert.equal((await t.jury()).length, first.length, 'nothing was asked again');
  assert.equal((await t.read('state', CURRENT, 'labels-development.json')).costCny, before);
});

test('a rehearsal keeps its own ids and flags: its own directory, budget campaign and manifest id; the real month is untouched', async () => {
  const t = await tree(exportFor(CURRENT));
  const dev = shiftMonth(CURRENT, -2), conf = shiftMonth(CURRENT, -1);
  const flags = ['--development-days', `${dev}-01..${dev}-10`, '--confirmation-days', `${conf}-01..${conf}-10`, '--id-prefix', 'rehearsal-'];
  ok(await t.lab([CURRENT, ...flags]), 'lab');
  const key = `rehearsal-${CURRENT}`;
  assert.deepEqual(await t.steps(key), ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run']);
  assert.deepEqual(await t.status(CURRENT), [], 'the real month was not started');
  assert.ok(!(await t.ls('state')).includes(CURRENT));
  assert.equal((await t.read('state', key, 'manifest.json')).id, `rehearsal-frontier-selection-${CURRENT}`);
  const ledger = await t.ledger();
  assert.ok(Object.values(ledger.records).every((record) => record.campaignId === `rehearsal-frontier-selection-${CURRENT}`), 'its labelling is booked to its own campaign');
  // the jury's cache is shared with the real months: an answer is the item's, whichever month asks
  assert.ok((await t.ls('state')).includes('jury-cache.jsonl'));
  assert.equal(await readlink(join(t.root, 'state', 'current')), key);
});

test('the dry runs print what they would do and change nothing', async () => {
  const t = await tree(exportFor(CURRENT));
  // The lab's own dry run walks the steps against a scratch tree with a docker that prints, up to the first step that needs what a real step wrote, and leaves no scratch behind.
  const tmp = join(t.dir, 'tmp');
  await mkdir(tmp);
  const lab = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1' } });
  assert.match(lab.stderr, /\[dry-run\] docker run .* evals\/rsi-campaigns\/frontier_assemble\.mjs plan /);
  assert.match(lab.stderr, /\[dry-run\] docker run .*-v \S*dashscope\.key:\/run\/rsi-credentials\/dashscope\.key:ro .* evals\/rsi-campaigns\/frontier_labels\.mjs calibrate /);
  assert.match(lab.stderr, /\[dry-run\] docker run .* evals\/rsi-campaigns\/frontier_labels\.mjs label .*--phase development/);
  assert.match(lab.stderr, new RegExp(`frontier_labels\\.mjs calibrate .*--cache /srv/rsi-lab/state/${CURRENT}/calibration-cache\\.jsonl `), 'the calibration\'s cache is the month\'s');
  assert.match(lab.stderr, /frontier_labels\.mjs label .*--cache \/srv\/rsi-lab\/state\/jury-cache\.jsonl /, 'the labelling\'s is shared');
  assert.match(lab.stderr, /\[dry-run\] the steps from decide on read files that only a real run writes: stop/);
  assert.ok(!/wait labels|operator/.test(lab.stderr), 'no wait for anyone');
  assert.deepEqual((await t.ls('state', CURRENT)).length, 0, 'the real tree is untouched');
  assert.deepEqual(await readdir(tmp), [], 'the scratch trees are removed');
  // Against a real tree (RSI_LAB_ROOT) a dry run reads its inbox and writes nothing in it: no STATUS line, no outcome, no log, no link.
  ok(await t.lab([], { FAKE_DASHSCOPE_WORTH: 'ok' }), 'a real run, up to its calibration');
  const before = await readFile(join(t.root, 'state', CURRENT, 'STATUS'), 'utf8');
  const listing = await t.ls('state', CURRENT);
  await symlink('elsewhere', join(t.root, 'state', 'current-probe'));
  const real = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: t.root, RSI_LAB_ETC: t.etc } });
  assert.match(real.stderr, /\[dry-run\] docker run .*lab_bootstrap\.mjs/, 'it walks the steps from the start');
  assert.equal(await readFile(join(t.root, 'state', CURRENT, 'STATUS'), 'utf8'), before, 'no bootstrap ok or plan ok written into the real STATUS');
  assert.deepEqual(await t.ls('state', CURRENT), listing);
  assert.equal(await readlink(join(t.root, 'state', 'current')), CURRENT, 'the link the evaluator reads is the real run\'s');
  assert.deepEqual(await readdir(tmp), []);
  // The harness and skill scripts' dry runs leave nothing behind either.
  for (const [script, args] of [['rsi-lab-harness.sh', ['2026-11', 'medcalc', 'develop']], ['rsi-lab-skill.sh', ['2026-11', 'run']]]) {
    const done = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1' } }).catch((error) => error);
    assert.equal(done.code, 3, `${script}: no inputs in its own scratch inbox`);
    assert.deepEqual(await readdir(tmp), [], `${script} removed its scratch trees`);
  }
});

/** Holds `lock` (flock) in another process until the returned function releases it. @param {string} lock */
async function holdLock(lock) {
  const holder = spawn('bash', ['-c', 'exec 8>"$1"; flock 8; echo locked; exec sleep 60', 'hold', lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  return () => { holder.kill('SIGKILL'); return new Promise((resolve) => holder.once('exit', resolve)); };
}

test('a second run started while a month holds the lock changes nothing: no directory, no moved link, exit 75', async () => {
  const t = await tree(exportFor(CURRENT));
  await symlink(CURRENT, join(t.root, 'state', 'current'));
  const release = await holdLock(join(t.root, 'state', 'monthly.lock'));
  try {
    const dev = shiftMonth(CURRENT, -2), conf = shiftMonth(CURRENT, -1);
    const rehearsal = await t.lab([CURRENT, '--development-days', `${dev}-01..${dev}-10`, '--confirmation-days', `${conf}-01..${conf}-10`, '--id-prefix', 'rehearsal-']);
    assert.equal(rehearsal.code, 75);
    const other = await t.lab([shiftMonth(CURRENT, 1)]);
    assert.equal(other.code, 75);
    assert.equal(await readlink(join(t.root, 'state', 'current')), CURRENT, 'the receipt path still points at the month that holds the lock');
    assert.deepEqual((await t.ls('state')).sort(), ['current', 'monthly.lock']);
    assert.deepEqual(await t.ls('outbox'), []);
  } finally { await release(); }
  // The skill campaign's link is held the same way.
  await symlink('skill-2026-10', join(t.root, 'state', 'skill-current'));
  const skill = join(repo, 'deploy/rsi-campaign/rsi-lab-skill.sh');
  const releaseSkill = await holdLock(join(t.root, 'state', 'skill.lock'));
  try {
    const held = await execFileAsync('bash', [skill, '2026-11', 'run'], { cwd: t.dir, env: t.env }).catch((error) => error);
    assert.equal(held.code, 75);
    assert.equal(await readlink(join(t.root, 'state', 'skill-current')), 'skill-2026-10');
    assert.ok(!(await t.ls('state')).includes('skill-2026-11'));
  } finally { await releaseSkill(); }
  const free = await execFileAsync('bash', [skill, '2026-11', 'run'], { cwd: t.dir, env: t.env }).catch((error) => error);
  assert.equal(free.code, 3, 'with the lock free it runs (and waits for inputs it does not have)');
  assert.equal(await readlink(join(t.root, 'state', 'skill-current')), 'skill-2026-11');
});

test('the rehearsal prefix is checked before it names a path: only rehearsal-[<a-z0-9->-], from --id-prefix', async () => {
  const t = await tree(exportFor(CURRENT));
  for (const prefix of ['rehearsal-../../escape-', 'rehearsal-a b-', 'prod-', 'rehearsal-X-', 'rehearsal-x']) {
    const result = await t.lab([CURRENT, '--id-prefix', prefix]);
    assert.equal(result.code, 2, prefix);
    assert.match(result.stderr, /id prefix is a rehearsal's/);
  }
  assert.deepEqual(await t.ls('state'), [], 'nothing was created, not even the lock');
  ok(await t.lab([CURRENT, '--id-prefix=rehearsal-b2-'], { FAKE_DASHSCOPE_WORTH: 'ok' }), 'the = form');
  assert.ok((await t.ls('state')).includes(`rehearsal-b2-${CURRENT}`));
});

test('a month begun before 2026-11-03 is refused as it is: nothing in it changes, its signed report stays; a month of this script, part-way through its labelling, is not', async () => {
  const t = await tree(exportFor(CURRENT));
  const dir = join(t.root, 'state', CURRENT);
  await mkdir(dir, { recursive: true });
  const legacy = 'export ok 2026-11-01T00:00:00Z\nbootstrap ok 2026-11-01T00:00:01Z\nplan ok 2026-11-01T00:00:02Z\nids ok 2026-11-01T00:00:03Z\ncalibrate ok 2026-11-01T00:00:04Z\nlabel ok 2026-11-01T00:00:05Z\n';
  const files = { STATUS: legacy, 'plan.json': JSON.stringify({ month: CURRENT, ids: ['1'] }), 'report.signed.json': '{"signed":true}', 'report.md': '# signed\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  // what identifies the old month: its steps, or its plan with no phases — each alone
  for (const [variant, change] of [['legacy steps and plan', {}], ['a plan without idsByRole, new steps', { STATUS: 'export ok 2026-11-01T00:00:00Z\nplan ok 2026-11-01T00:00:02Z\ncalibrate ok 2026-11-01T00:00:03Z\n' }],
    ['the step ids, no plan on disk', { STATUS: legacy, 'plan.json': null }]]) {
    for (const [name, text] of Object.entries(change)) { files[name] = text; if (text === null) await rm(join(dir, name), { force: true }); else await writeFile(join(dir, name), text); }
    const result = await t.lab();
    assert.equal(result.code, 5, variant);
    assert.match(result.stderr, /campaign_run_directory_legacy/);
    const kept = Object.keys(files).filter((name) => files[name] !== null).sort();
    assert.deepEqual((await readdir(dir)).sort(), kept, variant);
    for (const name of kept) assert.equal(await readFile(join(dir, name), 'utf8'), files[name], `${variant}: ${name}`);
    assert.ok(!(await t.ls('state')).includes('current'), 'the receipt link was not moved to it');
    assert.equal((await t.docker()).length, 0);
  }
  // The other direction: the same step names in a month of this script (a plan with its phases) are resumed, not refused.
  const fresh = await tree(exportFor(CURRENT));
  const first = await fresh.lab([], { FAKE_BUDGET_ALLOW_RESERVES: String(CALIBRATION_BATCHES) });
  assert.equal(first.code, 5, first.stderr);
  assert.deepEqual(await fresh.steps(), ['export', 'bootstrap', 'plan', 'calibrate']);
  assert.match((await fresh.text('state', CURRENT, 'plan.json')), /"idsByRole"/);
  const resumed = await fresh.lab();
  ok(resumed, 'resumed');
  assert.ok(!/legacy/.test(resumed.stderr ?? '') && (await fresh.steps()).includes('label-development'));
});

/** A run directory that has reached its receipt (every earlier step marked), for a resume the stubbed runner refuses. */
async function atResume(t, dir, steps, files = {}) {
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'STATUS'), steps.map((step) => `${step} ok 2026-11-03T00:00:00Z\n`).join(''));
  await writeFile(join(dir, 'run', 'run.json'), JSON.stringify({ status: 'awaiting-evaluation' }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}

test('a resume that fails ends the run with exit 9 and no report in the monthly, harness and skill campaigns', async () => {
  const t = await tree(exportFor(CURRENT));
  const refuse = { ...t.env, FAKE_RESUME_EXIT: '2' };
  const reported = async () => (await t.docker()).filter((call) => /_report\.mjs$|monthly_report\.mjs$/.test(call.script) || (call.script.endsWith('evaluator.mjs') && call.args[0] === 'report'));
  // the month: through merge, build, run, checkpoint and receipt
  const month = join(t.root, 'state', CURRENT);
  await atResume(t, month, ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run', 'checkpoint', 'receipt'],
    { 'plan.json': JSON.stringify({ idsByRole: { development: [], confirmation: [] } }), 'decision.json': JSON.stringify({ status: 'confirmation-needed' }), 'manifest.json': '{}',
      'calibration.json': JSON.stringify({ qualification: { qualified: true } }) });
  const monthly = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: refuse }).catch((error) => error);
  assert.equal(monthly.code, 9, monthly.stderr);
  assert.match(monthly.stderr, /resume failed \(campaign_stubbed_resume_refused\): no verdict and no report/);
  assert.ok(!(await readdir(month)).some((name) => name.startsWith('report')), 'no report claims a verdict');
  assert.ok(!(await t.ls('outbox', CURRENT)).some((name) => name.startsWith('report')));
  assert.ok(!(await t.status()).some((line) => line.startsWith('resume ok')), 'the resume is not marked done: the next start asks again');
  // the harness family and the skill month
  const harness = join(t.root, 'state', 'harness-medcalc-2026-11'), skill = join(t.root, 'state', 'skill-2026-11');
  await atResume(t, harness, ['inputs', 'bootstrap', 'assemble', 'run', 'checkpoint', 'receipt']);
  await mkdir(join(t.root, 'inbox', 'skill-2026-11'), { recursive: true });
  await writeFile(join(t.root, 'inbox', 'skill-2026-11', 'registration.json'), JSON.stringify({ failureCalculators: [2] }));
  await atResume(t, skill, ['inputs', 'assemble', 'run', 'checkpoint', 'receipt']);
  for (const [script, args, dir] of [['rsi-lab-harness.sh', ['2026-11', 'medcalc', 'run'], harness], ['rsi-lab-skill.sh', ['2026-11', 'run'], skill]]) {
    const result = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: t.dir, env: refuse }).catch((error) => error);
    assert.equal(result.code, 9, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /resume failed: no verdict and no report/);
    assert.ok(!(await readdir(dir)).some((name) => name.startsWith('report')), script);
  }
  assert.deepEqual(await reported(), [], 'no report step ran, and nothing was signed as one');
});

test('the script takes no more than it should: the month is checked before anything runs', async () => {
  const t = await tree(exportFor(CURRENT));
  const lab = await t.lab(['October']);
  assert.equal(lab.code, 2);
  assert.deepEqual(await t.docker(), []);
});

test('the provider credential is the jury\'s alone: one mount in the monthly script, none in the skill, harness or installer, and one provider row in the configuration the installer writes', async () => {
  const deploy = join(repo, 'deploy/rsi-campaign');
  const code = async (file) => (await readFile(join(deploy, file), 'utf8')).replace(/^\s*#.*$/gm, '');
  const monthly = await code('rsi-lab-monthly.sh');
  assert.equal(monthly.match(/dashscope\.key/g).length, 3, 'the key file is named where it is defined, where it is mounted (once) and where the command is told its path');
  assert.equal(monthly.match(/-v "\$JURY_KEY":\/run\/rsi-credentials\/dashscope\.key:ro/g).length, 1);
  assert.equal(monthly.match(/"\$\{JURY\[@\]\}"/g).length, 1, 'only jury_step mounts it');
  for (const file of ['rsi-lab-skill.sh', 'rsi-lab-harness.sh', 'Dockerfile']) assert.ok(!/dashscope|qwen|DEEPSEEK_API|credentials\//i.test(await code(file)), `${file} names a provider credential or a Qwen model`);
  assert.deepEqual((await readdir(join(repo, 'evals/rsi-campaigns'))).filter((name) => /improver/.test(name)), [], 'the retired improver is gone');
  assert.ok(!/improve2?\b/.test((await code('rsi-lab-skill.sh')).replace(/the improver is gone/g, '')), 'no improve step');
  // the configuration the installer writes is valid for the lab's own validator and names exactly one provider
  const install = await readFile(join(deploy, 'rsi-lab-install.sh'), 'utf8');
  const heredoc = /cat > \$O\/config\.json <<JSON\n([\s\S]*?)\nJSON/.exec(install)[1].replace('$INSTANCE', 'i-lab').replace('$PUB', 'a'.repeat(64));
  const written = JSON.parse(heredoc);
  assert.deepEqual(rsiLabConfigurationIssues(written), []);
  assert.deepEqual(written.providers, { qwenMax: { provider: 'dashscope', model: 'qwen3.8-max', credentialRef: 'lab:dashscope' } });
  const example = JSON.parse(await readFile(join(deploy, 'config.example.json'), 'utf8'));
  assert.deepEqual(Object.keys(example), ['host', 'transport', 'signer', 'authority', 'budget', 'providers']);
  assert.deepEqual(Object.keys(example.providers), ['qwenMax']);
  assert.deepEqual([example.providers.qwenMax.provider, example.providers.qwenMax.model], ['dashscope', 'qwen3.8-max']);
  assert.ok(!/>>\s*\$O\//.test(install), 'idempotent install: the owner inputs are rewritten, not appended to');
  // the operator's labelling script and its stand-ins are gone with the wait they answered
  assert.deepEqual((await readdir(deploy)).filter((name) => name === 'operator'), []);
  assert.ok(!/wait labels|rsi-frontier-label|operator\//.test(await code('rsi-lab-monthly.sh')));
});

test('the harness script requires its improvement record and always passes it', async () => {
  const script = await readFile(join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), 'utf8');
  assert.match(script, /local files=\(registration\.json development\.json improvement\.json\)/);
  assert.match(script, /^VERDICTS\+=\(--improvement "\$IN\/improvement\.json"\)$/m);
  assert.ok(!/\[ -s "\$INBOX\/\$NAME\/improvement\.json" \]/.test(script), 'no longer optional');
  // Without it the inputs are missing: the run stops before the assembly, in the lab\'s own dry-run tree.
  const dir = await mkdtemp(join(tmpdir(), 'rsi-harness-'));
  scratch.push(dir);
  const root = join(dir, 'lab'), etc = join(dir, 'etc');
  await mkdir(join(root, 'inbox', 'harness-medcalc-2026-11'), { recursive: true }); await mkdir(etc, { recursive: true });
  const folder = join(root, 'inbox', 'harness-medcalc-2026-11');
  for (const name of ['registration.json', 'development.json']) {
    const bytes = Buffer.from(JSON.stringify({ scorer: 'medcalc' }));
    await writeFile(join(folder, name), bytes); await writeFile(join(folder, `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
  }
  const result = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), '2026-11', 'medcalc', 'develop'], { env: { PATH: process.env.PATH, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc } }).catch((error) => error);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /inputs missing or checksum mismatch/);
  const bytes = Buffer.from(JSON.stringify({ improvers: [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5' }] }));
  await writeFile(join(folder, 'improvement.json'), bytes); await writeFile(join(folder, 'improvement.json.sha256'), `${sha(bytes)}  improvement.json\n`);
  const complete = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), '2026-11', 'medcalc', 'develop'], { env: { PATH: process.env.PATH, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc } }).catch((error) => error);
  assert.match(complete.stderr, /\[dry-run\] docker run .*harness_assemble\.mjs --development-only --development \/srv\/rsi-lab\/inbox\/harness-medcalc-2026-11\/development\.json --improvement \/srv\/rsi-lab\/inbox\/harness-medcalc-2026-11\/improvement\.json/);
});

test('an export from before the incumbent identity does not stop the month: it is measured against an unbound baseline, reported as not importable', async () => {
  const document = exportFor(CURRENT);
  delete document.incumbent;
  const t = await tree(document);
  ok(await t.lab(), 'lab');
  assert.equal((await t.read('state', CURRENT, 'plan.json')).incumbent, null);
  assert.deepEqual((await t.steps()).filter((step) => /^(decide|merge|build|run)$/.test(step)), ['decide', 'merge', 'build', 'run']);
  const manifest = await t.read('state', CURRENT, 'manifest.json');
  assert.deepEqual(rsiCampaignIssues(manifest), []);
  assert.equal(manifest.target.baselineRevision, 'unbound:release-flow.1');
  assert.equal((await t.read('state', CURRENT, 'supply.json')).incumbent, null);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_stubbed_runner' });
  const report = await t.read('outbox', CURRENT, 'report.json');
  assert.equal(report.baselineBound, false);
  const text = await t.text('outbox', CURRENT, 'report.md');
  assert.equal(text.split('\n').filter((line) => line.includes('生产导出缺少基线身份，本月结论只作实验机参考，不能导入')).length, 1, 'said once, in one line');
  assert.ok(!/null|undefined/.test(text), 'no raw null in the report');
});

test('a month with no candidate from development and no incumbent ends there and still says the export carried no baseline', async () => {
  const document = exportFor(CURRENT, { perfectBaseline: true });
  delete document.incumbent;
  const t = await tree(document);
  ok(await t.lab(), 'lab');
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_no_improving_candidate' });
  const text = await t.text('outbox', CURRENT, 'report.md');
  assert.match(text, /- 生产导出缺少基线身份，本月结论只作实验机参考，不能导入/);
  assert.match(text, /- 确认期未标注：开发期没有选出候选/);
  assert.match(text, /确认期 \d+ 天（可测 未标注，最少 25）/, 'confirmation was never labelled: unknown, not null');
  assert.ok(!/null|undefined/.test(text));
});

test('an incumbent the export carries but that is malformed ends the month at the plan, by its closed reason, before the jury is asked anything', async () => {
  const document = exportFor(CURRENT);
  document.incumbent = { revisionId: 'threshold-64-release-flow.1', threshold: BASELINE };
  const t = await tree(document);
  const result = await t.lab();
  assert.equal(result.code, 4);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_export_incumbent_invalid' });
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'), 'the report says why');
  assert.deepEqual([(await t.jury()).length, juryCalls(await t.docker()).length], [0, 0]);
});
