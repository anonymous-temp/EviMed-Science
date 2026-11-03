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
const CALIBRATION = { juryVersion: 'frontier-jury-test', model: 'claude-sonnet-5-5', costCny: 0, costBasis: 'subscription', calibration: { pickKappa: 0.81, pickPrecision: 0.8, pickRecall: 0.7, abstentionRate: 0.05 }, qualification: { qualified: true } };
const LABELS = { items: 420, labelled: 412, labelCounts: { pick: 100, ok: 200, no: 100, abstained: 12 }, costCny: 0, costBasis: 'subscription', stopped: null };

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
  assert.match(known.text, /本月标注 412 条，/);
});

test('a Claude jury runs on a subscription: the report says no cash was spent, not ¥0.00; another jury is priced', async () => {
  const base = { 'supply.json': SUPPLY, 'outcome.json': outcome() };
  for (const [calibration, labels] of [
    [CALIBRATION, LABELS],
    [{ ...CALIBRATION, costBasis: undefined }, { ...LABELS, costBasis: undefined }], // records from before the basis was written: the model says it
    [{ ...CALIBRATION, costBasis: undefined, model: 'claude-opus-5-5' }, undefined],
  ]) {
    const { text } = await report({ ...base, 'calibration.json': calibration, ...(labels ? { 'labels.json': labels } : {}) });
    assert.match(text, /花费：订阅，不计现金/);
    assert.ok(!text.includes('¥'), text);
  }
  const priced = await report({ ...base, 'calibration.json': { ...CALIBRATION, model: 'qwen3.8-max', costBasis: undefined, costCny: 1.25 }, 'labels.json': { ...LABELS, costBasis: undefined, costCny: 3 } });
  assert.match(priced.text, /qwen3\.8-max 双盲评审.*花费约 ¥4\.25/);
  assert.ok(!priced.text.includes('订阅'));
  const { json } = await report({ ...base, 'calibration.json': CALIBRATION, 'labels.json': LABELS });
  assert.deepEqual([json.jury.costBasis, json.labelling.costBasis], ['subscription', 'subscription']);
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
