// The month's report (monthly_report.mjs) read from the files a run leaves in its directory: whatever is absent or refusal-shaped is said as absent, never a crash and never a raw null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const script = new URL('../monthly_report.mjs', import.meta.url).pathname;
const SUPPLY = {
  exportSha256: 'a'.repeat(64), releaseId: 'release-test.1', settings: { threshold: 64 }, incumbent: null, drift: [],
  development: { month: '2026-09', days: 30, measuredDays: 28, labelled: 400, abstained: 12 },
  confirmation: { month: '2026-10', days: 31, measuredDays: null, labelled: null, abstained: null },
  replayFidelity: 0.98, developmentChoice: { frozen: null, reason: 'campaign_no_improving_candidate', candidates: [] }, minimumGroups: 25, power: { mde: 0.03 },
};
const CALIBRATION = { juryVersion: 'frontier-jury-test', provider: 'dashscope', model: 'qwen3.8-max', costCny: 1.25, calibration: { pickKappa: 0.81, pickPrecision: 0.8, pickRecall: 0.7, abstentionRate: 0.05 }, qualification: { qualified: true } };
const LABELS = { items: 420, labelled: 412, labelCounts: { pick: 100, ok: 200, no: 100, abstained: 10, refused: 2 }, costCny: 3, stopped: null };
/** How the report says the labels: each kind apart, never one total that counts an abstention as a label. */
const COUNTS = '精选 100、普通 200、不展示 100、弃权 10、内容审查拒答 2';

/** Runs the report over a directory holding exactly these files; returns what it wrote. @param {Record<string, any>} files */
async function report(files, month = '2026-11') {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-report-'));
  try {
    for (const [name, value] of Object.entries(files)) { await mkdir(join(dir, name, '..'), { recursive: true }); await writeFile(join(dir, name), JSON.stringify(value)); }
    await execFileAsync(process.execPath, [script, dir, month]);
    return { json: JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')), text: await readFile(join(dir, 'report.md'), 'utf8') };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const outcome = (value = 'not-qualified', reason = 'campaign_no_improving_candidate') => ({ outcome: value, reason });

test('a supply.json that is a refusal, or absent, is no supply: the report says so and does not crash', async () => {
  for (const files of [
    { 'supply.json': { status: 'not-run', reason: 'campaign_labels_unqualified', calibration: { qualification: { qualified: false } } }, 'outcome.json': outcome('not-run', 'campaign_labels_unqualified') },
    { 'supply.json': { status: 'not-run', reason: 'campaign_labels_jury_changed', jury: { labels: 'a', calibration: 'b' } }, 'outcome.json': outcome('not-run', 'campaign_labels_jury_changed') },
    { 'outcome.json': outcome('not-run', 'campaign_export_missing') },
    {},
  ]) {
    const { json, text } = await report(files);
    assert.equal(json.supply, null);
    assert.equal(json.development, null);
    assert.match(text, /^- 供给：无$/m);
    assert.ok(!/null|undefined|NaN/.test(text), text);
  }
  const { json, text } = await report({ 'supply.json': { status: 'not-run', reason: 'campaign_labels_unqualified' }, 'outcome.json': outcome('not-run', 'campaign_labels_unqualified') });
  assert.equal(json.outcome, 'not-run');
  assert.match(text, /结论：\*\*本月未运行\*\*（campaign_labels_unqualified）/, 'the reason still comes from the outcome');
});

test('a count the run did not measure or label is printed as 未标注, never as null', async () => {
  const { text } = await report({ 'supply.json': SUPPLY, 'calibration.json': CALIBRATION, 'labels.json': { ...LABELS, labelled: null }, 'outcome.json': outcome() });
  assert.match(text, /开发期 30 天（可测 28），确认期 31 天（可测 未标注，最少 25）/);
  assert.match(text, /本月标注 未标注，/);
  assert.ok(!/null|undefined|NaN/.test(text), text);
  const known = await report({ 'supply.json': { ...SUPPLY, confirmation: { ...SUPPLY.confirmation, measuredDays: 29 } }, 'calibration.json': CALIBRATION, 'labels.json': LABELS, 'outcome.json': outcome() });
  assert.match(known.text, /确认期 31 天（可测 29，最少 25）/);
  assert.ok(known.text.includes(`本月标注 ${COUNTS}，`), known.text);
  assert.ok(!/标注 \d+ 条/.test(known.text), 'no total that includes abstentions');
});

test('the Qwen jury is named with its priced cost: the calibration and the labelling, summed, in CNY', async () => {
  const base = { 'supply.json': SUPPLY, 'outcome.json': outcome() };
  const priced = await report({ ...base, 'calibration.json': CALIBRATION, 'labels.json': LABELS });
  assert.ok(priced.text.split('\n').includes(`- 标注：qwen3.8-max 双盲评审，校准 κ=0.810、精选精确率 80.0%、召回率 70.0%、弃权 5.0%；本月标注 ${COUNTS}，花费约 ¥4.25`), priced.text);
  assert.ok(!priced.text.includes('订阅') && !priced.text.includes('不计现金'), 'nothing of a subscription: the lab pays for its jury');
  assert.deepEqual([priced.json.jury.provider, priced.json.jury.model, priced.json.jury.costCny, priced.json.labelling.costCny], ['dashscope', 'qwen3.8-max', 1.25, 3]);
  assert.ok(!('costBasis' in priced.json.jury) && !('costBasis' in priced.json.labelling));
  // A calibration alone (the month ended there) costs what the calibration cost; no jury at all says none.
  const calibrated = await report({ 'calibration.json': CALIBRATION, 'outcome.json': outcome('not-run', 'campaign_labels_unqualified') });
  assert.match(calibrated.text, /本月标注 未标注，花费约 ¥1\.25$/m);
  assert.match((await report({ 'outcome.json': outcome('not-run', 'campaign_export_missing') })).text, /^- 标注：未进行$/m);
  // A labelling that stopped (budget, quota) says so beside the count it reached.
  const stopped = await report({ 'calibration.json': CALIBRATION, 'labels.json': { ...LABELS, labelled: 120, costCny: 0.8, stopped: 'campaign_budget_exceeded' }, 'outcome.json': outcome('not-run', 'campaign_budget_exceeded') });
  assert.ok(stopped.text.includes(`本月标注 ${COUNTS}（已中止：campaign_budget_exceeded），花费约 ¥2.05\n`), stopped.text);
  assert.ok(!/null|undefined|NaN/.test(stopped.text), stopped.text);
  // A labels file from before refusals were counted apart has none to say.
  const earlier = await report({ 'calibration.json': CALIBRATION, 'labels.json': { ...LABELS, labelCounts: { pick: 1, ok: 2, no: 3, abstained: 4 } }, 'outcome.json': outcome() });
  assert.ok(earlier.text.includes('本月标注 精选 1、普通 2、不展示 3、弃权 4、内容审查拒答 0，'), earlier.text);
});

test('a month that stopped part-way has only its phases\' labels files: the report sums them, and the merged file wins once it exists', async () => {
  const development = { ...LABELS, phase: 'development', items: 300, labelled: 300, labelCounts: { pick: 80, ok: 150, no: 60, abstained: 9, refused: 1 }, costCny: 2 };
  const confirmation = { ...LABELS, phase: 'confirmation', items: 200, labelled: 90, labelCounts: { pick: 30, ok: 40, no: 15, abstained: 3, refused: 2 }, costCny: 0.5, stopped: 'campaign_budget_exceeded' };
  const stopped = await report({ 'calibration.json': CALIBRATION, 'labels-development.json': development, 'labels-confirmation.json': confirmation, 'outcome.json': outcome('not-run', 'campaign_budget_exceeded') });
  assert.deepEqual([stopped.json.labelling.items, stopped.json.labelling.labelled, stopped.json.labelling.costCny, stopped.json.labelling.stopped], [500, 390, 2.5, 'campaign_budget_exceeded']);
  assert.deepEqual(stopped.json.labelling.labelCounts, { pick: 110, ok: 190, no: 75, abstained: 12, refused: 3 });
  assert.ok(stopped.text.includes('本月标注 精选 110、普通 190、不展示 75、弃权 12、内容审查拒答 3（已中止：campaign_budget_exceeded），花费约 ¥3.75\n'), stopped.text);
  const alone = await report({ 'calibration.json': CALIBRATION, 'labels-development.json': { ...development, stopped: 'jury_unavailable' }, 'outcome.json': outcome('not-run', 'campaign_jury_unavailable') });
  assert.ok(alone.text.includes('本月标注 精选 80、普通 150、不展示 60、弃权 9、内容审查拒答 1（已中止：jury_unavailable），花费约 ¥3.25\n'), alone.text);
  const merged = await report({ 'calibration.json': CALIBRATION, 'labels.json': LABELS, 'labels-development.json': development, 'labels-confirmation.json': confirmation, 'outcome.json': outcome() });
  assert.ok(merged.text.includes(`本月标注 ${COUNTS}，花费约 ¥4.25\n`), merged.text);
  assert.ok(!/null|undefined|NaN/.test(stopped.text + alone.text + merged.text));
});

test('a month whose development found no candidate says its confirmation month was not labelled, not opened, and drew no alpha; a labelled one does not', async () => {
  const line = '- 确认期未标注：开发期没有选出候选，确认月未被标注、未被打开，本季度 α 未动用';
  const ended = await report({ 'supply.json': SUPPLY, 'calibration.json': CALIBRATION, 'labels.json': LABELS, 'outcome.json': outcome() });
  assert.equal(ended.json.confirmationLabelled, false);
  assert.equal(ended.text.split('\n').filter((l) => l === line).length, 1);
  assert.match(ended.text, /确认期 31 天（可测 未标注，最少 25）/);
  assert.match(ended.text, /^- 确认期：未进行$/m);
  // the labelling it paid for is the development's only: the cost line is the calibration's and that phase's
  assert.ok(ended.text.includes(`本月标注 ${COUNTS}，花费约 ¥4.25\n`), ended.text);
  const labelled = await report({ 'supply.json': { ...SUPPLY, confirmation: { ...SUPPLY.confirmation, measuredDays: 29, labelled: 600, abstained: 20 } }, 'calibration.json': CALIBRATION, 'labels.json': LABELS, 'outcome.json': outcome() });
  assert.equal(labelled.json.confirmationLabelled, true);
  assert.ok(!labelled.text.includes('确认期未标注'));
  // no supply at all (a refusal, a stop before development was decided): not known, so not said
  const unknown = await report({ 'calibration.json': CALIBRATION, 'outcome.json': outcome('not-run', 'campaign_labels_unqualified') });
  assert.equal(unknown.json.confirmationLabelled, null);
  assert.ok(!unknown.text.includes('确认期未标注'));
});

test('an export that carried no baseline identity is said so in one line; one that did, or no plan at all, says nothing of it', async () => {
  const files = { 'supply.json': SUPPLY, 'calibration.json': CALIBRATION, 'labels.json': LABELS, 'outcome.json': outcome() };
  const line = '- 生产导出缺少基线身份，本月结论只作实验机参考，不能导入';
  const unbound = await report({ ...files, 'plan.json': { incumbent: null, releaseId: 'release-test.1' } });
  assert.equal(unbound.json.baselineBound, false);
  assert.equal(unbound.text.split('\n').filter((l) => l === line).length, 1);
  const lines = unbound.text.split('\n');
  assert.match(lines[lines.indexOf(line) - 1], /^- 结论：/, 'right under the conclusion');
  const bound = await report({ ...files, 'plan.json': { incumbent: { revisionId: `default:${'a'.repeat(64)}`, threshold: 64 } } });
  assert.equal(bound.json.baselineBound, true);
  assert.ok(!bound.text.includes('基线身份'));
  const unplanned = await report(files);
  assert.equal(unplanned.json.baselineBound, null);
  assert.ok(!unplanned.text.includes('基线身份'));
  // A month that ended before any supply (a refusal) with no incumbent still says it.
  const refused = await report({ 'plan.json': { incumbent: null }, 'outcome.json': outcome('not-run', 'campaign_labels_unqualified') });
  assert.ok(refused.text.includes(line));
});

test('a month with no measured confirmation day is reported as directional, 0 days, with no alpha drawn', async () => {
  const directional = { groups: 0, sliceGroups: null, minimum: 25 };
  const resume = { qualification: 'inconclusive', checkpoint: { campaignId: 'frontier-selection-2026-11', evaluation: { directional, reasons: ['campaign_directional_below_minimum_groups'], scope: 'directional-reference' } } };
  const { json, text } = await report({ 'supply.json': { ...SUPPLY, confirmation: { ...SUPPLY.confirmation, measuredDays: 0 } }, 'run/resume.json': resume, 'outcome.json': outcome('inconclusive', null) });
  assert.deepEqual(json.directional, directional);
  assert.match(text, /结论：\*\*方向性参考，不是合格结论（确认期可测 0 天，低于登记统计程序的 25 天下限，本季度 α 未动用）\*\*/);
  assert.ok(!/null|undefined|NaN/.test(text), text);
});
