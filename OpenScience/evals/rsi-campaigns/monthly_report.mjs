/**
 * The month's campaign report (2026-10-26): what the lab measured, in one JSON record and a short Chinese summary for the
 * owner. It is written whatever happened — not run, inconclusive, not qualified or qualified — and signed by the evaluator.
 *
 *   node monthly_report.mjs <run-dir> <month>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RSI_OFFLINE_ROLE_MODEL } from '../../packages/domain/src/rsiCampaign.mjs';

const [dir, month] = process.argv.slice(2);
const read = async (name) => { try { return JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { return null; } };
const [supplyFile, plan, calibration, labels, run, resume, status] = await Promise.all(['supply.json', 'plan.json', 'calibration.json', 'labels.json', 'run/run.json', 'run/resume.json', 'outcome.json'].map(read));
// A supply is what a development that ran measured; a refusal-shaped or absent file is no supply.
const supply = supplyFile?.development ? supplyFile : null;
// The plan records `incumbent: null` for an export that carried no baseline identity (an older export script): the month is measured, and cannot be imported.
const baselineBound = plan ? plan.incumbent != null : null;
const evaluation = resume?.checkpoint?.evaluation ?? null;
const quantities = evaluation?.quantities?.superiority?.quality_superiority ?? null;
// What confirmation measured, read from its own observations: shown even when the statistics could not decide.
const observed = (() => {
  const rows = (resume ?? run)?.checkpoint?.stages?.confirmation?.result?.observations;
  if (!Array.isArray(rows) || !rows.length) return null;
  const byGroup = new Map();
  for (const row of rows) byGroup.set(row.group, { ...byGroup.get(row.group), [row.arm]: row.quality });
  const differences = [...byGroup.values()].filter((g) => Number.isFinite(g.baseline) && Number.isFinite(g.candidate)).map((g) => g.candidate - g.baseline);
  return differences.length ? { groups: differences.length, meanDifference: differences.reduce((a, b) => a + b, 0) / differences.length, better: differences.filter((d) => d > 0).length, worse: differences.filter((d) => d < 0).length } : null;
})();
const outcome = status?.outcome ?? resume?.qualification ?? resume?.status ?? run?.status ?? 'not-run';
// Fewer measured confirmation days than the procedure's minimum: the statistics give no verdict and no alpha was reserved (directional.mjs).
const directional = evaluation?.directional ?? null;
const report = {
  schema: 'rsi-monthly-report-v1', month, surface: 'frontier-selection', writtenAt: new Date().toISOString(), outcome,
  reason: status?.reason ?? resume?.reason ?? run?.reason ?? null,
  campaignId: run?.checkpoint?.campaignId ?? resume?.checkpoint?.campaignId ?? null,
  frozenPolicy: resume?.checkpoint?.frozenPolicy ?? run?.checkpoint?.frozenPolicy ?? null,
  development: supply?.developmentChoice ?? null,
  confirmation: quantities ? { meanDifference: quantities.mean, lowerBound: quantities.lower, groups: quantities.n_groups, testAlpha: evaluation.quantities.superiority.test_alpha, volumeRatio: evaluation.volumeRatio ?? null } : null,
  confirmationObserved: observed, statisticsReasons: evaluation?.reasons ?? [], directional,
  supply: supply ? { development: supply.development, confirmation: supply.confirmation, replayFidelity: supply.replayFidelity, drift: supply.drift, power: supply.power, minimumGroups: supply.minimumGroups, releaseId: supply.releaseId } : null,
  jury: calibration ? { version: calibration.juryVersion, model: calibration.model, qualified: calibration.qualification?.qualified ?? null, metrics: calibration.calibration ?? null, costCny: calibration.costCny ?? null, costBasis: calibration.costBasis ?? null } : null,
  labelling: labels ? { items: labels.items ?? null, labelled: labels.labelled ?? null, labelCounts: labels.labelCounts ?? null, costCny: labels.costCny ?? null, costBasis: labels.costBasis ?? null, stopped: labels.stopped ?? null } : null,
  baselineBound, releaseEligible: false,
  note: 'Lab-only trial: no bundle is imported into production in this phase.',
};
const pct = (value) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
/** A count the run did not measure or label is unknown, not zero and not `null`. */
const count = (value) => value == null ? '未标注' : String(value);
// The operator's Claude jury runs on a subscription: its records say `costBasis: "subscription"` and no cash was spent.
const subscription = [report.jury?.costBasis, report.labelling?.costBasis].includes('subscription') || RSI_OFFLINE_ROLE_MODEL.test(String(report.jury?.model ?? labels?.model ?? ''));
const lines = [
  `# 前沿精选阈值战役 · ${month}`, '',
  `- 结论：**${directional ? `方向性参考，不是合格结论（确认期可测 ${directional.groups} 天，低于登记统计程序的 ${directional.minimum} 天下限，本季度 α 未动用）`
    : { qualified: '候选通过（仅实验机，未导入生产）', 'not-qualified': '候选未通过', inconclusive: '证据不足', 'not-run': '本月未运行' }[outcome] ?? outcome}**${report.reason ? `（${report.reason}）` : ''}`,
  ...(baselineBound === false ? ['- 生产导出缺少基线身份，本月结论只作实验机参考，不能导入'] : []),
  `- 基线阈值 ${report.frozenPolicy?.baselineThreshold ?? supply?.settings?.threshold ?? '—'}，开发期选出的候选阈值 ${report.frozenPolicy?.threshold ?? '无'}`,
  report.confirmation ? `- 确认期：${report.confirmation.groups} 天，按天加权准确率平均差 ${pct(report.confirmation.meanDifference)}，单侧下界 ${pct(report.confirmation.lowerBound)}（α=${report.confirmation.testAlpha.toFixed(4)}），候选入选量为基线的 ${report.confirmation.volumeRatio == null ? '—' : `${(report.confirmation.volumeRatio * 100).toFixed(0)}%`}`
    : observed ? `- 确认期：测了 ${observed.groups} 天，候选比基线平均 ${pct(observed.meanDifference)}（${observed.better} 天更好、${observed.worse} 天更差）；统计未下结论：${report.statisticsReasons.join('；') || report.reason || '—'}`
      : '- 确认期：未进行',
  supply ? `- 供给：开发期 ${supply.development.days} 天（可测 ${count(supply.development.measuredDays)}），确认期 ${supply.confirmation?.days} 天（可测 ${count(supply.confirmation?.measuredDays)}，最少 ${supply.minimumGroups}），最小可检出差 ${pct(supply.power?.mde)}；基线重放与生产实际入选的重合度 ${pct(supply.replayFidelity)}` : '- 供给：无',
  supply?.drift?.length ? `- 实验机选择器与生产不一致的文件：${supply.drift.join('、')}` : '- 实验机选择器与生产一致',
  report.jury ? `- 标注：${report.jury.model ?? '未记录模型'} 双盲评审，校准 κ=${report.jury.metrics?.pickKappa?.toFixed(3) ?? '—'}、精选精确率 ${pct(report.jury.metrics?.pickPrecision)}、召回率 ${pct(report.jury.metrics?.pickRecall)}、弃权 ${pct(report.jury.metrics?.abstentionRate)}；本月标注 ${report.labelling?.labelled == null ? '未标注' : `${report.labelling.labelled} 条`}，${subscription ? '花费：订阅，不计现金' : `花费约 ¥${((report.jury.costCny ?? 0) + (report.labelling?.costCny ?? 0)).toFixed(2)}`}` : '- 标注：未进行',
  '', '本阶段只在实验机运行，不向生产导入任何候选。',
];
await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
await writeFile(join(dir, 'report.md'), `${lines.join('\n')}\n`);
console.log(JSON.stringify({ status: 'reported', outcome, month }));
