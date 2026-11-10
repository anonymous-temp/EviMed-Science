// A round's money in its three places (round_spend.mjs): the settled CNY of the arms' runs in the sources, the Claude usage the round recorded in tokens, and the lab's
// reading (none is recorded for these campaigns). Synthetic data only; what is unmetered stays unmetered, and nothing adds CNY to tokens.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentOnly } from '../harness_assemble.mjs';
import { harnessReport } from '../harness_report.mjs';
import { ROUND_SPEND_FILE, buildRoundSpend, harness2Spend, judgeParts, laneSource, moneyLines, readRoundSpend } from '../round_spend.mjs';
import { IMPROVEMENT, harnessFixture } from '../profiles/harness_fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-spend-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const nextDir = async () => { const dir = join(scratch, String(dirs += 1)); await mkdir(dir, { recursive: true }); return dir; };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const script = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const ledgerPy = fileURLToPath(new URL('../../harness-adaptation/evimed_h2/ledger.py', import.meta.url));

const run = (row, arm, repeat, cost) => ({ row, arm, repeat, runId: `run-${row}-${arm}-${repeat}`, status: 'succeeded', answer: 'x', cost });
const source = (changes = {}) => ({ kind: 'harness-arms', schema: 1, role: 'development', benchmark: 'medcalc-bench', arms: { baseline: {}, aa: {} },
  runs: [run('1', 'baseline', 0, 0.25), run('2', 'baseline', 0, 0.5), run('1', 'aa', 0, 0.125), run('2', 'aa', 0, 0.125)], ...changes });
const usage = (input, output, cacheRead, cacheCreation) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation });
const improver = (key, stage, model, use, extra = {}) => ({ key, kind: 'improver', cached: false, stage, model, domain: 'medcalc', usage: use, usd_reported: 0.5, ...extra });
const rollout = (key, cny, extra = {}) => ({ key, kind: 'rollout', cached: false, domain: 'medcalc', cny, cost_uncertain: 0, ...extra });
const ledgerText = (rows, tail = '') => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${tail}`;
const LEDGER = ledgerText([
  improver('i1', 'inv', 'claude-sonnet-5-5', usage(10, 2000, 50000, 4000)), improver('i2', 'inv', 'claude-sonnet-5-5', usage(5, 1000, 20000, 0)),
  improver('i3', 'inv', 'claude-sonnet-5-5', { input_tokens: null, output_tokens: null }, { usd_reported: 0 }), // a timeout: paid for, no usage reported
  improver('i4', 'agg', 'claude-opus-5-5', {}, { usd_reported: undefined }), // a stage that recorded no usage at all
  improver('i5', 'dom', 'deepseek-v4-pro[1m]', usage(100, 200, 300, 0)), // a round from before the Claude-only ruling
  improver('i6', 'inv', 'claude-sonnet-5-5', usage(999, 999, 999, 999), { cached: true }), // a cached reply costs nothing
  improver('i1', 'inv', 'claude-sonnet-5-5', usage(10, 2000, 50000, 4000)), // the same key twice is one row
  rollout('r1', 0.2), rollout('r2', 0.3), rollout('r3', null), rollout('r4', 0.1, { cost_uncertain: 2 }), rollout('r5', 9, { cached: true }),
  { key: 'other-domain', kind: 'rollout', domain: 'drb', cny: 5 },
], '{"key": "torn');

test('a source\'s settled cost is summed per arm, and a run with no cost is counted apart and never made zero', () => {
  const read = laneSource('development.json', JSON.stringify(source()));
  assert.deepEqual(read.byArm, { aa: { runs: 2, runsWithoutCost: 0, settledCny: 0.25 }, baseline: { runs: 2, runsWithoutCost: 0, settledCny: 0.75 } });
  assert.deepEqual([read.runs, read.runsWithoutCost, read.settledCny, read.settledOn, read.role, read.benchmark], [4, 0, 1, 'lane', 'development', 'medcalc-bench']);
  assert.equal(read.sha256, sha(JSON.stringify(source())), 'the bytes read are named by their digest');
  const open = laneSource('x.json', JSON.stringify(source({ runs: [run('1', 'baseline', 0, null), run('2', 'baseline', 0, 0.5)] })));
  assert.deepEqual(open.byArm.baseline, { runs: 2, runsWithoutCost: 1, settledCny: 0.5 });
  assert.equal(open.runsWithoutCost, 1);
  assert.equal(laneSource('s.json', JSON.stringify(source({ kind: 'skill-arms' }))).settledOn, 'production');
  assert.equal(laneSource('m.json', JSON.stringify(source({ kind: 'module-arms' }))).settledOn, 'operator-box');
  for (const bad of [{ kind: 'frontier-days' }, { runs: 'no' }, { runs: [run('1', 'baseline', 0, -1)] }, { runs: [run('1', 'baseline', 0, '0.1')] }, { runs: [{ ...run('1', 'baseline', 0, 1), arm: 3 }] }, { arms: null }]) {
    assert.throws(() => laneSource('bad.json', JSON.stringify(source(bad))), { message: 'round_spend_source_invalid' }, JSON.stringify(Object.keys(bad)));
  }
});

test('Harness2\'s ledger: tokens by stage and model, a call without usage counted apart, unmetered where nothing was recorded, rollouts settled or open', () => {
  const read = harness2Spend('rsi1-ledger.jsonl', LEDGER, 'medcalc');
  assert.deepEqual(read.input, { kind: 'harness2-ledger', file: 'rsi1-ledger.jsonl', sha256: sha(LEDGER), domain: 'medcalc', rowsRead: 12, unreadableLines: 1 });
  const by = Object.fromEntries(read.roles.map((role) => [role.role, role]));
  assert.deepEqual(Object.keys(by).sort(), ['harness2/agg', 'harness2/dom', 'harness2/inv']);
  assert.deepEqual(by['harness2/inv'].tokens, { input: 15, output: 3000, cacheRead: 70000, cacheCreation: 4000 });
  assert.deepEqual([by['harness2/inv'].calls, by['harness2/inv'].callsWithoutUsage, by['harness2/inv'].usdReported, by['harness2/inv'].claude], [3, 1, 1, true], 'a timeout is a call, not a zero of tokens');
  assert.deepEqual([by['harness2/agg'].tokens, by['harness2/agg'].calls, by['harness2/agg'].callsWithoutUsage, by['harness2/agg'].usdReported], ['unmetered', 1, 1, null]);
  assert.deepEqual([by['harness2/dom'].model, by['harness2/dom'].claude], ['deepseek-v4-pro[1m]', false], 'a non-Claude improver is listed as one');
  assert.deepEqual(read.rollouts, { runs: 4, runsWithoutCost: 1, uncertain: 1, settledCny: 0.6 }, 'cached rows and other domains are not this family\'s');
  assert.deepEqual(harness2Spend('x', LEDGER).rollouts, { runs: 5, runsWithoutCost: 1, uncertain: 1, settledCny: 5.6 }, 'without a domain, the whole ledger');
  assert.equal(harness2Spend('x', LEDGER, 'bixbench').roles.length, 0);
});

test('what Harness2\'s own Ledger class writes is what is read, to the same totals', async () => {
  const dir = await nextDir(), file = join(dir, 'rsi1-ledger.jsonl');
  const program = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('ledger',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nl=m.Ledger(sys.argv[2])\n`
    + `l.append('improver:medcalc:inv:a1',kind='improver',cached=False,stage='inv',domain='medcalc',model='claude-sonnet-5-5',usage={'input_tokens':7,'output_tokens':70,'cache_read_input_tokens':700,'cache_creation_input_tokens':7000},usd_reported=0.25)\n`
    + `l.append('improver:medcalc:inv:a1',kind='improver',cached=False,stage='inv',domain='medcalc',model='claude-sonnet-5-5',usage={'input_tokens':1},usd_reported=9)\n`
    + `l.append('rollout:r1',kind='rollout',cached=False,domain='medcalc',cny=0.125,cost_uncertain=0)\nl.append('rollout:r2',kind='rollout',cached=False,domain='medcalc',cny=None,cost_uncertain=0)\nprint(json.dumps(l.totals()))\n`;
  const made = spawnSync('python3', ['-I', '-c', program, ledgerPy, file], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const totals = JSON.parse(made.stdout);
  const read = harness2Spend('rsi1-ledger.jsonl', await readFile(file, 'utf8'));
  assert.equal(read.rollouts.runs, totals.rollouts);
  assert.equal(read.rollouts.runsWithoutCost, totals.rollouts_without_cost);
  assert.equal(read.rollouts.settledCny, totals.solver_cny);
  assert.equal(read.roles[0].calls, totals.by_stage.inv.calls);
  assert.equal(read.roles[0].tokens.output, totals.by_stage.inv.output);
  assert.equal(read.roles[0].tokens.cacheCreation, 7000, 'the Python totals leave cache writes out; the money section does not');
  assert.equal(read.roles[0].usdReported, totals.by_stage.inv.usd_reported);
});

test('the judge: claude_judge.py keeps USD per call and no tokens, so tokens are unmetered; a failed packet judged later is not a failure', () => {
  const who = JSON.stringify({ schema: 'claude-judge/1', judge: 'claude-judge-drb', model: 'claude-sonnet-5-5', effort: 'medium', dialect: 'race', briefSha256: 'a'.repeat(64) });
  const log = [
    '2026-11-03T10:00:00Z ok drb-1 p1 usd 0.0234 (1 done, 0 failed of 4)', '2026-11-03T10:00:09Z FAILED drb-2 p1: judge_transport (1 done, 1 failed of 4)',
    '2026-11-03T10:01:00Z ok drb-2 p1 usd 0.0300 (2 done, 0 failed of 4)', '2026-11-03T10:01:05Z ok drb-1 p2 usd 0.0100 (3 done, 0 failed of 4)', '2026-11-03T10:02:00Z FAILED drb-3 p1: judge_quota (3 done, 1 failed of 4)',
  ].join('\n');
  const read = judgeParts('/ops/judge-parts', who, `${log}\n`);
  assert.deepEqual([read.id, read.model, read.effort, read.calls, read.failedCalls, read.usdReported], ['claude-judge-drb', 'claude-sonnet-5-5', 'medium', 3, 1, 0.0634]);
  assert.deepEqual(read.input, { kind: 'judge-parts', file: 'judge-parts', sha256: sha(who), log: sha(`${log}\n`) });
  const noLog = judgeParts('/ops/judge-parts', who, null);
  assert.deepEqual([noLog.calls, noLog.failedCalls, noLog.usdReported, noLog.input.log], [null, null, null, null], 'a log that is not there is a figure that is not there');
  assert.throws(() => judgeParts('d', JSON.stringify({ judge: 'j', model: 'deepseek-flash' }), ''), { message: 'round_spend_judge_record_invalid' });
});

test('the file: lanes, Claude roles by tokens, the lab reading missing, every input named by digest, the whole sealed by its own digest', async () => {
  const dev = JSON.stringify(source());
  const judged = JSON.stringify(source({ role: 'confirmation', judged: { schema: 1, judge: { id: 'claude-judge-drb', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', form: 'absolute', passes: 2, qualification: { agreement: 0.9 } }, calls: 40, cost: { settledCny: 0, note: 'subscription' } } }));
  const improvement = JSON.stringify({ ...IMPROVEMENT, improvers: [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5' }] });
  const spend = buildRoundSpend({ label: 'rsi2-medcalc', sources: [{ file: 'development.json', text: dev }, { file: 'confirmation.json', text: judged }], harness2: [{ file: 'rsi1-ledger.jsonl', text: LEDGER, domain: 'medcalc' }],
    judge: [{ dir: 'judge-parts', record: JSON.stringify({ judge: 'claude-judge-drb', model: 'claude-sonnet-5-5', effort: 'medium' }), log: '2026-11-03T10:00:00Z ok drb-1 p1 usd 0.5000 (1 done, 0 failed of 1)\n' }], improvement: { file: 'improvement.json', text: improvement } });
  assert.equal(spend.schema, 'rsi-round-spend/1');
  assert.deepEqual(spend.lab, { ledgerCny: null, reason: 'lab_ledger_not_recorded' });
  assert.equal(spend.lanes.sources.length, 2);
  assert.deepEqual([spend.lanes.runsWithoutCost, spend.lanes.uncertain, spend.lanes.complete], [1 + 0, 1, false], 'an open rollout cost and a rollout without one make the total a lower bound');
  assert.equal(spend.lanes.settledCny, 2.6, 'two sources of 1 and the settled rollouts of 0.6');
  const roles = Object.fromEntries(spend.claude.roles.map((role) => [role.role, role]));
  assert.equal(roles['judge:claude-judge-drb'].tokens, 'unmetered');
  assert.deepEqual([roles['judge:claude-judge-drb'].calls, roles['judge:claude-judge-drb'].callsBasis, roles['judge:claude-judge-drb'].usdReported, roles['judge:claude-judge-drb'].recordedCny], [1, 'cli-calls', 0.5, 0]);
  assert.deepEqual([roles.lead.tokens, roles.lead.calls, roles.lead.claude], ['unmetered', null, true], 'a role the improvement record names and nothing else records is unmetered, not zero');
  assert.equal(roles['harness2/inv'].tokens.output, 3000);
  assert.deepEqual(spend.claude.inputs.map((input) => input.kind), ['harness2-ledger', 'judge-parts', 'improvement-record']);
  assert.equal(spend.claude.inputs[2].sha256, sha(improvement));
  assert.equal(spend.lanes.sources[0].sha256, sha(dev));
  // The file is sealed by its own digest: a hand-edited figure is another file.
  const dir = await nextDir();
  await writeFile(join(dir, ROUND_SPEND_FILE), JSON.stringify(spend));
  assert.deepEqual(await readRoundSpend(dir), { spend, problem: null });
  await writeFile(join(dir, ROUND_SPEND_FILE), JSON.stringify({ ...spend, lanes: { ...spend.lanes, settledCny: 0.1 } }));
  assert.deepEqual(await readRoundSpend(dir), { spend: null, problem: 'round_spend_digest_mismatch' });
  await writeFile(join(dir, ROUND_SPEND_FILE), '{not json');
  assert.deepEqual(await readRoundSpend(dir), { spend: null, problem: 'round_spend_unreadable' });
  assert.deepEqual(await readRoundSpend(await nextDir()), { spend: null, problem: null }, 'no file is no problem, only absent');
  // Nothing to read, a label that is not one, and a judge record that is not Claude are refused.
  assert.throws(() => buildRoundSpend({ label: 'x' }), { message: 'round_spend_nothing_to_read' });
  assert.throws(() => buildRoundSpend({ label: 'a b', sources: [{ file: 'd', text: dev }] }), { message: 'round_spend_label_invalid' });
  assert.throws(() => buildRoundSpend({ label: 'x', improvement: { file: 'i', text: '{"improvers": []}' } }), { message: 'round_spend_improvement_invalid' });
});

test('the three lines: CNY of the lane, tokens of Claude, never one total across them; what is missing says 未提供 or 未计量', () => {
  const dev = JSON.stringify(source({ runs: [run('1', 'baseline', 0, 0.25), run('2', 'baseline', 0, null)] }));
  const spend = buildRoundSpend({ label: 'rsi2-medcalc', sources: [{ file: 'development.json', text: dev }], harness2: [{ file: 'l.jsonl', text: LEDGER, domain: 'medcalc' }],
    judge: [{ dir: 'jp', record: JSON.stringify({ judge: 'j1', model: 'claude-sonnet-5-5', effort: 'low' }), log: '2026-11-03T10:00:00Z ok k p1 usd 0.2500 (1 done, 0 failed of 1)\n' }] });
  const [lab, solver, claude, ...rest] = moneyLines({ spend, problem: null });
  assert.equal(rest.length, 0, 'three lines');
  assert.equal(lab, '- 实验机账本：未提供（战役记录里没有实验机支出读数）');
  assert.match(solver, /^- 求解器（DeepSeek，按各自账本已结算，元）：开发期（medcalc-bench） 0\.25 元（2 次运行，lane 账本）；Harness2 改进阶段 0\.6 元（4 次运行）；合计 0\.85 元；3 次运行没有结算完的成本，以上是下限$/);
  assert.match(claude, /^- Claude（订阅，按 token 计，不折算为元，不与上两行相加；操作员机器上的记录，实验机未复核）：/);
  assert.ok(claude.includes('Harness2 不变量编辑 claude-sonnet-5-5 3 次，输入 15 输出 3,000 缓存读 70,000 缓存写 4,000（另有 1 次无用量记录）'), claude);
  assert.ok(claude.includes('Harness2 组合 claude-opus-5-5 1 次，token 未计量'), claude);
  assert.ok(claude.includes('Harness2 领域编辑 deepseek-v4-pro[1m]（非 Claude）'), claude);
  assert.ok(claude.includes('裁判 j1 claude-sonnet-5-5 1 次，token 未计量（CLI 报告的 API 等价约 $0.25，不是计费）'), claude);
  assert.ok(!/合计|总计/.test(claude), 'tokens are never totalled, and never joined to the CNY lines');
  // Absent, mismatched or unreadable: three lines that say so.
  assert.deepEqual(moneyLines({ spend: null, problem: null }), ['- 实验机账本：未提供', '- 求解器（DeepSeek，已结算）：未提供', '- Claude：未提供']);
  assert.match(moneyLines({ spend: null, problem: 'round_spend_digest_mismatch' })[2], /^- Claude：未提供（round-spend\.json 的摘要与内容不符，未采用）$/);
  assert.match(moneyLines({ spend: null, problem: 'round_spend_unreadable' })[0], /未提供（round-spend\.json 无法读取，未采用）$/);
  // A complete round has no lower-bound clause.
  const whole = buildRoundSpend({ label: 'x', sources: [{ file: 'd', text: JSON.stringify(source()) }] });
  assert.ok(!moneyLines({ spend: whole, problem: null })[1].includes('下限'));
  assert.equal(moneyLines({ spend: whole, problem: null })[2], '- Claude（订阅，按 token 计，不折算为元，不与上两行相加；操作员机器上的记录，实验机未复核）：未提供');
});

test('the command writes the file from exports read through their sidecars, and refuses what it should', async () => {
  const dir = await nextDir();
  const exportFile = join(dir, 'development.json'), text = JSON.stringify(source());
  await writeFile(exportFile, text);
  await writeFile(join(dir, 'ledger.jsonl'), LEDGER);
  const out = join(dir, 'round-spend.json');
  const command = (...args) => spawnSync('node', [script('round_spend.mjs'), ...args], { encoding: 'utf8' });
  assert.match(command('--label', 'r', '--out', out, '--source', exportFile).stderr, /campaign_input_checksum_missing/, 'an export without its sidecar is not read');
  await writeFile(`${exportFile}.sha256`, `${sha(text)}  development.json\n`);
  assert.match(command('--label', 'r', '--out', out, '--h2-domain', 'medcalc', '--source', exportFile).stderr, /round_spend_domain_without_ledger/);
  const made = command('--label', 'rsi2-medcalc', '--out', out, '--source', exportFile, '--h2-ledger', join(dir, 'ledger.jsonl'), '--h2-domain', 'medcalc');
  assert.equal(made.status, 0, made.stderr);
  const summary = JSON.parse(made.stdout);
  assert.deepEqual([summary.label, summary.laneSettledCny, summary.laneComplete, summary.unmetered], ['rsi2-medcalc', 1.6, false, ['harness2/agg']]);
  const written = await readRoundSpend(dir);
  assert.equal(written.problem, null);
  assert.equal(written.spend.digest, summary.digest);
  assert.match(command('--label', 'rsi2-medcalc', '--out', out, '--source', exportFile).stderr, /round_spend_out_exists/, 'an existing file is never overwritten without --force');
  assert.equal(command('--label', 'rsi2-medcalc', '--out', out, '--source', exportFile, '--force').status, 0);
  assert.match(command('--out', join(dir, 'nothing.json')).stderr, /round_spend_label_invalid/);
});

test('the harness report prints the money section from the file, and says 未提供 without it, or with one whose digest is not its content\'s', async () => {
  const good = await harnessFixture('medcalc');
  const only = developmentOnly({ development: good.exports.development.source, registration: good.round, improvement: IMPROVEMENT, month: '2026-11' });
  const make = async (spendFile) => {
    const dir = await nextDir();
    await mkdir(join(dir, 'run'), { recursive: true });
    await writeFile(join(dir, 'development-only.json'), JSON.stringify(only));
    await writeFile(join(dir, 'supply.json'), JSON.stringify(only.supply));
    if (spendFile) await writeFile(join(dir, ROUND_SPEND_FILE), spendFile);
    return dir;
  };
  const without = await make(null);
  const absent = await harnessReport(without, '2026-11');
  const noText = await readFile(join(without, 'report.md'), 'utf8');
  assert.ok(noText.includes('## 费用\n\n- 实验机账本：未提供\n- 求解器（DeepSeek，已结算）：未提供\n- Claude：未提供\n'), noText);
  assert.equal(absent.spend, null);
  // The lane figures of the file are the supply's own, read from the same export.
  const spend = buildRoundSpend({ label: 'rsi2-medcalc', sources: [{ file: 'development.json', text: JSON.stringify(good.exports.development.source) }], improvement: { file: 'improvement.json', text: JSON.stringify(IMPROVEMENT) } });
  assert.deepEqual(Object.fromEntries(Object.entries(spend.lanes.sources[0].byArm).map(([arm, slot]) => [arm, slot.settledCny])), only.supply.development.costCny);
  const withFile = await make(JSON.stringify(spend));
  const report = await harnessReport(withFile, '2026-11');
  const text = await readFile(join(withFile, 'report.md'), 'utf8');
  assert.deepEqual(report.spend, { label: 'rsi2-medcalc', digest: spend.digest });
  assert.ok(text.includes('- 实验机账本：未提供（战役记录里没有实验机支出读数）\n'), text);
  assert.match(text, /\n- 求解器（DeepSeek，按各自账本已结算，元）：开发期（medcalc-bench） [0-9.]+ 元（120 次运行，lane 账本）；合计 [0-9.]+ 元\n/);
  assert.match(text, /\n- Claude（订阅，按 token 计，不折算为元，不与上两行相加；操作员机器上的记录，实验机未复核）：writing-candidates claude-opus-5-5 token 未计量\n/);
  assert.ok(text.indexOf('## 费用') > text.indexOf('## 确认期') && text.indexOf('## 费用') < text.indexOf('本阶段不向生产导入任何东西'), 'the section sits before the closing sentence');
  const tampered = await make(JSON.stringify({ ...spend, lanes: { ...spend.lanes, settledCny: 1 } }));
  assert.equal((await harnessReport(tampered, '2026-11')).spend, null);
  assert.match(await readFile(join(tampered, 'report.md'), 'utf8'), /- 求解器（DeepSeek，已结算）：未提供（round-spend\.json 的摘要与内容不符，未采用）/);
});

test('the capability-skill report and the frontier month print their three lines too', async () => {
  const dir = await nextDir();
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'inputs.json'), JSON.stringify({ registration: { statistics: { G_target: 30, procedure: { minimum_slice_groups: 25 } }, candidates: [] } }));
  await writeFile(join(dir, 'supply.json'), JSON.stringify({ confirmation: { sliceGroups: 27, repeats: 3, costCny: {} } }));
  const skill = (target) => { const done = spawnSync('node', [script('skill_report.mjs'), target, '2026-11'], { encoding: 'utf8' }); assert.equal(done.status, 0, done.stderr); return readFile(join(target, 'report.md'), 'utf8'); };
  assert.ok((await skill(dir)).includes('## 费用\n\n- 实验机账本：未提供\n- 求解器（DeepSeek，已结算）：未提供\n- Claude：未提供\n'));
  const spend = buildRoundSpend({ label: 'skill-2026-11', sources: [{ file: 'dev.json', text: JSON.stringify(source({ kind: 'skill-arms' })) }] });
  await writeFile(join(dir, ROUND_SPEND_FILE), JSON.stringify(spend));
  const text = await skill(dir);
  assert.match(text, /- 求解器（DeepSeek，按各自账本已结算，元）：开发期（medcalc-bench） 1 元（4 次运行，生产账本）；合计 1 元\n/);
  assert.equal(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).spend.digest, spend.digest);
  // The frontier month: the jury's CNY from its own records, and no lane or Claude spend, which is true of the surface.
  const month = await nextDir();
  await writeFile(join(month, 'calibration.json'), JSON.stringify({ model: 'qwen3.8-max', costCny: 1.25, calibration: {}, qualification: { qualified: true } }));
  await writeFile(join(month, 'labels.json'), JSON.stringify({ items: 4, labelled: 4, costCny: 3, labelCounts: {} }));
  const done = spawnSync('node', [script('monthly_report.mjs'), month, '2026-11'], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  const monthText = await readFile(join(month, 'report.md'), 'utf8');
  assert.ok(monthText.includes('## 费用\n\n- 实验机账本：陪审团 qwen3.8-max 约 ¥4.25（校准加标注，按实验机预算账本计价）\n- 求解器（DeepSeek）：无（本战役重放生产的选择器，不运行 lane 求解器）\n- Claude：无（本战役没有 Claude 角色，陪审团是 Qwen）\n'), monthText);
  const empty = await nextDir();
  assert.equal(spawnSync('node', [script('monthly_report.mjs'), empty, '2026-11'], { encoding: 'utf8' }).status, 0);
  assert.match(await readFile(join(empty, 'report.md'), 'utf8'), /^- 实验机账本：未提供（本月没有标注记录）$/m);
});

test('the harness and skill scripts hand the operator\'s file to their reports, as the steps\' user, and a round without one is as before', async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const spend = buildRoundSpend({ label: 'rsi2-medcalc', sources: [{ file: 'development.json', text: JSON.stringify(source()) }] });
  const lab = async (name, setup, script, args) => {
    const dir = await nextDir();
    const root = join(dir, 'lab'), etc = join(dir, 'etc'), bin = join(dir, 'bin'), inbox = join(root, 'inbox', name), state = join(root, 'state', name);
    for (const path of [inbox, state, join(root, 'outbox'), join(etc, 'secrets'), join(etc, 'owner-inputs'), join(etc, 'keys'), bin]) await mkdir(path, { recursive: true });
    await writeFile(join(etc, 'image'), 'evimed-rsi-lab:test\n');
    await writeFile(join(etc, 'secrets', 'lab.env'), 'RSI_LAB_DATABASE_URL=postgres://unused\n');
    await symlink(fileURLToPath(new URL('./fixtures/fake_docker.sh', import.meta.url)), join(bin, 'fake-docker'));
    await setup(inbox, state);
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, RSI_LAB_ROOT: root, RSI_LAB_ETC: etc, RSI_LAB_DOCKER: join(bin, 'fake-docker'), RSI_LAB_OWNER: `${process.getuid()}:${process.getgid()}`, RSI_LAB_POLL_SECONDS: '0',
      FAKE_DOCKER_REPO: repo, FAKE_DOCKER_LOG: join(dir, 'docker.jsonl') };
    const done = spawnSync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(done.status, 0, `${script}: ${done.stderr}`);
    return state;
  };
  const harness = (withSpend) => lab('harness-medcalc-2026-11', async (inbox, state) => {
    await writeFile(join(inbox, 'registration.json'), JSON.stringify({ scorer: 'medcalc' }));
    if (withSpend) await writeFile(join(inbox, ROUND_SPEND_FILE), JSON.stringify(spend));
    await writeFile(join(state, 'STATUS'), 'inputs ok 2026-11-03T00:00:00Z\ndevelop ok 2026-11-03T00:00:01Z\n');
  }, 'rsi-lab-harness.sh', ['2026-11', 'medcalc', 'develop']);
  const skill = (withSpend) => lab('skill-2026-11', async (inbox, state) => {
    await writeFile(join(inbox, 'mode'), 'development-only\n');
    for (const [name, text] of [['registration.json', JSON.stringify({ failureCalculators: [2] })], ['development.json', '{}'], ['candidates.json', '{}']]) {
      await writeFile(join(inbox, name), text);
      await writeFile(join(inbox, `${name}.sha256`), `${sha(text)}  ${name}\n`);
    }
    if (withSpend) await writeFile(join(inbox, ROUND_SPEND_FILE), JSON.stringify(spend));
    await writeFile(join(state, 'STATUS'), 'develop ok 2026-11-03T00:00:01Z\n');
  }, 'rsi-lab-skill.sh', ['2026-11', 'run']);
  for (const [name, start] of [['harness', harness], ['skill', skill]]) {
    const state = await start(true);
    assert.equal((await stat(join(state, ROUND_SPEND_FILE))).mode & 0o777, 0o640, name);
    assert.deepEqual(JSON.parse(await readFile(join(state, 'report.json'), 'utf8')).spend, { label: 'rsi2-medcalc', digest: spend.digest }, `${name}: the report read it`);
    const without = await start(false);
    await assert.rejects(stat(join(without, ROUND_SPEND_FILE)), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(without, 'report.json'), 'utf8')).spend, null, `${name}: no file, no spend`);
  }
});

// ------------------------------------------------------------------------------------------ review findings: a missing figure must look missing

const JUDGE_RECORD = JSON.stringify({ judge: 'j1', model: 'claude-sonnet-5-5', effort: 'low' });
const withJudge = (parts, sources = []) => buildRoundSpend({ label: 'x', sources, judge: parts.map(([dir, log]) => ({ dir, record: JUDGE_RECORD, log })) });
const judgeRole = (spend) => spend.claude.roles.find((role) => role.role === 'judge:j1');

test('two parts directories of one judge are one judge: calls and USD add, a packet in both is counted once, a disagreement is said', () => {
  const a = '2026-11-03T10:00:00Z ok k1 p1 usd 1.0000 (1 done, 0 failed of 2)\n2026-11-03T10:00:01Z ok k2 p1 usd 2.0000 (2 done, 0 failed of 2)\n';
  const b = '2026-11-04T10:00:00Z ok k3 p1 usd 1.5000 (1 done, 0 failed of 1)\n';
  const merged = judgeRole(withJudge([['pa', a], ['pb', b]]));
  assert.deepEqual([merged.calls, merged.usdReported, merged.conflicts], [3, 4.5, 0]);
  const again = judgeRole(withJudge([['pa', a], ['pb', `${b}2026-11-04T10:00:02Z ok k1 p1 usd 1.0000 (2 done, 0 failed of 1)\n`]]));
  assert.deepEqual([again.calls, again.usdReported, again.conflicts], [3, 4.5, 0], 'the same packet and pass in both is one call');
  const clash = judgeRole(withJudge([['pa', a], ['pb', '2026-11-04T10:00:00Z ok k1 p1 usd 9.0000 (1 done, 0 failed of 1)\n']]));
  assert.equal(clash.conflicts, 1);
  assert.match(claudeLine(withJudge([['pa', a], ['pb', '2026-11-04T10:00:00Z ok k1 p1 usd 9.0000 (1 done, 0 failed of 1)\n']])), /1 处记录互相矛盾/);
  const lone = judgeRole(withJudge([['pa', a], ['pb', null]]));
  assert.deepEqual([lone.calls, lone.usdReported], [null, null], 'a log that is missing makes the sum unknown, not smaller');
});
const claudeLine = (spend) => moneyLines({ spend, problem: null })[2];

test('a judged section without a call count reads as unknown, not 0 verdicts', () => {
  const judged = (calls) => JSON.stringify(source({ judged: { schema: 1, judge: { id: 'j1', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' }, ...(calls === undefined ? {} : { calls }), cost: { settledCny: 0 } } }));
  const unknown = buildRoundSpend({ label: 'x', sources: [{ file: 'a.json', text: judged(undefined) }] });
  assert.equal(judgeRole(unknown).calls, null);
  assert.ok(!claudeLine(unknown).includes('0 次'), claudeLine(unknown));
  assert.equal(judgeRole(buildRoundSpend({ label: 'x', sources: [{ file: 'a.json', text: judged(7) }, { file: 'b.json', text: judged(undefined) }] })).calls, null, 'one unknown source makes the sum unknown');
  assert.equal(judgeRole(buildRoundSpend({ label: 'x', sources: [{ file: 'a.json', text: judged(7) }, { file: 'b.json', text: judged(3) }] })).calls, 10);
});

test('a call whose usage lacks fields is a call without usage, not zeros', () => {
  const text = ledgerText([improver('p1', 'inv', 'claude-sonnet-5-5', usage(10, 20, 30, 40)), improver('p2', 'inv', 'claude-sonnet-5-5', { input_tokens: 100 })]);
  const [role] = harness2Spend('l', text).roles;
  assert.deepEqual([role.calls, role.callsWithoutUsage, role.tokens], [2, 1, { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 }]);
  assert.equal(harness2Spend('l', ledgerText([improver('p3', 'inv', 'claude-sonnet-5-5', { input_tokens: 100 })])).roles[0].tokens, 'unmetered');
});

test('costs the exporter lists as uncertain make the lane total a lower bound, and that file is digested', () => {
  const unc = JSON.stringify({ kind: 'harness-uncertain-costs', schema: 1, runs: [{ arm: 'baseline', row: '1', repeat: 0 }, { arm: 'aa', row: '2', repeat: 0 }] });
  const read = laneSource('development.json', JSON.stringify(source()), unc);
  assert.deepEqual([read.uncertainRuns, read.uncertainSha256], [2, sha(unc)]);
  const spend = buildRoundSpend({ label: 'x', sources: [{ file: 'development.json', text: JSON.stringify(source()), uncertain: { file: 'development.json.uncertain-costs.json', text: unc } }] });
  assert.deepEqual([spend.lanes.complete, spend.lanes.uncertain], [false, 2]);
  assert.match(moneyLines({ spend, problem: null })[1], /2 次运行没有结算完的成本，以上是下限/);
  assert.throws(() => laneSource('d', JSON.stringify(source()), '{"kind":"other"}'), { message: 'round_spend_source_invalid' });
  assert.equal(buildRoundSpend({ label: 'x', sources: [{ file: 'd', text: JSON.stringify(source()) }] }).lanes.complete, true);
});

test('a judge log line for a CLI that reported no cost is an unreported cost, never a measured zero', () => {
  const log = '2026-11-03T10:00:00Z ok k1 p1 usd 0.2500 (1 done, 0 failed of 2)\n2026-11-03T10:00:01Z ok k2 p1 usd none (2 done, 0 failed of 2)\n';
  const read = judgeParts('d', JUDGE_RECORD, log);
  assert.deepEqual([read.calls, read.usdReported, read.callsWithoutCost], [2, 0.25, 1]);
  assert.match(claudeLine(withJudge([['d', log]])), /另有 1 次未报告/);
  const none = judgeParts('d', JUDGE_RECORD, '2026-11-03T10:00:01Z ok k2 p1 usd none (1 done, 0 failed of 1)\n');
  assert.deepEqual([none.usdReported, none.callsWithoutCost], [null, 1]);
});

test('claude_judge.py writes usd none when the CLI result had no cost, and the number when it had one', () => {
  const tools = fileURLToPath(new URL('../../public-benchmarks/tools/', import.meta.url));
  const program = `import sys\nsys.path.insert(0,sys.argv[1])\nimport claude_judge as c\nprint(c.usd_text(None), c.usd_text(0.0), c.usd_text(0.02))\n`;
  const done = spawnSync('python3', ['-I', '-c', program, tools], { encoding: 'utf8' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout.trim(), 'none 0.0000 0.0200');
});
