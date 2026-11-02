/**
 * The harness-patch campaign's report: report.json and a Chinese report.md from the campaign directory, whatever the verdict
 * (signed afterwards by the evaluator's `report` command, as the other campaigns' are).
 *
 *   node harness_report.mjs <campaign-dir> <month>
 *
 * A family with fewer confirmation groups than the registered procedure's minimum (25, in the whole family or in its failure
 * slice) is answered by the procedure itself with a refusal (`inconclusive`: sparse population); the report then says what that
 * is — a directional reading, never a qualification — from the counts alone, not from the wording of the refusal.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—');
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} 个百分点` : '—');

/** Whether a confirmation with this many groups is below the registered procedure's minimum. @param {any} groups @param {any} sliceGroups @param {any} minimum */
export const belowMinimumGroups = (groups, sliceGroups, minimum) => Number.isFinite(minimum) && ((Number.isFinite(groups) && groups < minimum) || (Number.isFinite(sliceGroups) && sliceGroups < minimum));

export async function harnessReport(dir, month) {
  const supply = await read(join(dir, 'supply.json'));
  const devOnly = await read(join(dir, 'development-only.json'));
  const inputs = await read(join(dir, 'inputs.json'));
  const run = await read(join(dir, 'run', 'resume.json')) ?? await read(join(dir, 'run', 'run.json'));
  const checkpoint = run?.checkpoint ?? (await read(join(dir, 'run', 'report.json')))?.checkpoint ?? null;
  // A signed closure (harness_closure.mjs) stands in for the evaluation of a campaign whose receipt the evaluator refused for missing costs:
  // the statistics it recorded are shown, and the deviation is said in the report, never left to the signature.
  const closure = checkpoint?.evaluation ? null : (await read(join(dir, 'closure.signed.json')))?.payload ?? null;
  const evaluation = checkpoint?.evaluation ?? closure?.statistics ?? null;
  const confirmation = checkpoint?.stages?.confirmation?.result ?? null;
  const frozen = checkpoint?.frozenPolicy ?? null;
  const candidate = inputs?.registration?.candidates?.find((c) => c.arm === frozen?.arm) ?? null;
  const scores = confirmation?.scores ?? null;
  const base = scores?.baseline, cand = frozen && scores ? scores[frozen.arm] : null;
  const groups = inputs?.registration?.statistics?.G_target ?? null, sliceGroups = supply?.confirmation?.sliceGroups ?? null;
  const minimum = inputs?.registration?.statistics?.procedure?.minimum_slice_groups ?? supply?.minimumGroups ?? null;
  const choice = supply?.developmentChoice ?? devOnly?.supply?.developmentChoice ?? null;
  // `develop` alone opens nothing: a candidate that cleared the gate is a candidate for a confirmation, not a qualification; none that did is the end of the campaign.
  // A development-only record that a later assembly or run has superseded (the same directory serves both commands) is not this report's subject.
  const developmentOnlyActive = Boolean(devOnly) && !supply?.confirmation && !checkpoint;
  const gatePassed = developmentOnlyActive && Boolean(choice?.frozen);
  const qualification = run?.qualification ?? evaluation?.decision ?? (developmentOnlyActive ? (gatePassed ? null : 'not-qualified') : null);
  const directional = Boolean(confirmation) && qualification !== 'qualified' && belowMinimumGroups(groups, sliceGroups, minimum);
  const judge = supply?.judge ?? devOnly?.supply?.judge ?? null;
  const report = {
    type: 'rsi-harness-patch-report-v1', month, campaignId: checkpoint?.campaignId ?? devOnly?.campaignId ?? null, family: inputs?.registration?.family ?? devOnly?.registration?.family ?? null,
    scorer: inputs?.registration?.scorer ?? devOnly?.registration?.scorer ?? null, image: supply?.image ?? devOnly?.supply?.image ?? null,
    status: run?.status ?? (developmentOnlyActive ? devOnly.status : 'not-run'), qualification, developmentGate: developmentOnlyActive ? (gatePassed ? 'passed' : 'failed') : null, directional: directional ? { groups, sliceGroups, minimum } : null,
    reason: run?.reason ?? evaluation?.reasons?.[0] ?? choice?.reason ?? null,
    scoresDevelopment: devOnly?.supply?.developmentChoice?.scores ?? choice?.scores ?? null, controls: choice?.controls ?? null, noiseFloor: choice?.noiseFloor ?? null,
    development: supply?.development ?? devOnly?.supply?.development ?? null, developmentChoice: choice ? { frozen: choice.frozen, reason: choice.reason, candidates: choice.candidates } : null,
    frozen: frozen ? { arm: frozen.arm, harnessDigest: frozen.harnessDigest, alwaysOnChars: candidate?.alwaysOnChars ?? null, chars: candidate?.chars ?? null, title: candidate?.title ?? null }
      : gatePassed ? { arm: choice.frozen.arm, harnessDigest: choice.frozen.harnessDigest, alwaysOnChars: null, chars: null, title: null } : null,
    confirmation: confirmation ? { groups, sliceGroups, repeats: supply?.confirmation?.repeats ?? null, baseline: base ? { overall: base.overall, slice: base.slice } : null,
      candidate: cand ? { overall: cand.overall, slice: cand.slice } : null, costCny: supply?.confirmation?.costCny ?? null } : null,
    statistics: evaluation ? { decision: evaluation.decision, reasons: evaluation.reasons ?? [], quantities: evaluation.quantities ?? null, scope: evaluation.scope ?? null } : null,
    closure: closure ? { type: closure.type, issuedAt: closure.issuedAt, deviation: closure.deviation, alpha: closure.alpha, costTotals: closure.statistics?.costTotals ?? null, binding: closure.binding } : null,
    judge, failureSlice: inputs?.registration?.failureSlice ?? inputs?.registration?.failureCalculators ?? devOnly?.registration?.failureSlice ?? devOnly?.registration?.failureCalculators ?? null,
  };
  const lines = [
    `# 运行时补丁 RSI 活动报告 · ${report.family ?? '—'} · ${month}`, '',
    `结论：${directional ? `方向性参考，不是合格结论（确认集 ${groups} 组、失败子集 ${sliceGroups} 组，低于登记统计程序的 ${minimum} 组下限）`
      : gatePassed ? `开发门通过：候选 ${choice.frozen.arm} 的失败子集收益超过 A/A 噪声下限；确认集未开启，目前没有任何合格结论`
      : report.qualification === 'qualified' ? '候选补丁通过确认（targeted-repair）' : report.qualification ? `未通过（${report.qualification}）` : '未运行'}${report.reason ? `，原因 ${report.reason}` : ''}${report.closure ? '；本结论由签名的成本收尾记录给出，见“偏差”一节' : ''}。`, '',
    '## 开发期', '',
    `- 镜像 ${report.image ? `${report.image.id}（${report.image.digest.slice(0, 12)}）` : '—'}；打分器 ${report.scorer ?? '—'}`,
    `- 开发行 ${report.development?.rows ?? '—'}（失败子集 ${report.development?.sliceRows ?? '—'}），各臂成本 ${JSON.stringify(report.development?.costCny ?? {})} 元`,
    ...(report.developmentChoice?.candidates ?? []).map((c) => `- 候选 ${c.arm}（常驻 ${c.alwaysOnChars} 字，共 ${c.chars} 字）：总体 ${signed(c.overallDifference)}，失败子集 ${signed(c.sliceDifference)}`),
    ...(report.controls ?? []).map((c) => `- A/A 对照 ${c.arm}：总体 ${signed(c.overallDifference)}，失败子集 ${signed(c.sliceDifference)}（噪声下限 ${pct(report.noiseFloor)}，候选须超过它）`),
    ...(report.scoresDevelopment ? Object.entries(report.scoresDevelopment).map(([arm, s]) => `- ${arm}：总体 ${pct(s.overall)}，失败子集 ${pct(s.slice)}`) : []),
    `- 冻结：${report.frozen ? `${report.frozen.arm} 「${report.frozen.title ?? ''}」` : '无（' + (report.developmentChoice?.reason ?? '—') + '）'}`,
    ...(judge ? ['', '## 裁判', '',
      `- 裁判 ${judge.id}（${judge.provider}），${judge.form === 'pairwise' ? '成对比较，顺序交换' : '逐份打分'}，每份 ${judge.passes} 遍；已登记资格：一致率 ${pct(judge.qualification?.agreement)}，噪声带 ${judge.qualification?.noiseBand95 ?? '—'}（${judge.qualification?.measuredOn ?? '—'}）`,
      `- 裁判调用 ${judge.calls} 次（上限 ${judge.maxCalls}），费用 ${judge.costCny} 元：${judge.costNote}（订阅内调用，不按元计量，如实写 0 元，不是没有发生）`] : []), '',
    '## 确认期', '',
    report.confirmation ? `- ${report.confirmation.groups} 组（失败子集 ${report.confirmation.sliceGroups}），每组每臂重复 ${report.confirmation.repeats} 次` : '- 未进行：开发期没有改进候选，确认集未开启，本季度 α 未动用',
    ...(report.confirmation?.baseline ? [`- 对照：总体 ${pct(report.confirmation.baseline.overall)}，失败子集 ${pct(report.confirmation.baseline.slice)}`] : []),
    ...(report.confirmation?.candidate ? [`- 候选：总体 ${pct(report.confirmation.candidate.overall)}，失败子集 ${pct(report.confirmation.candidate.slice)}`] : []),
    ...(report.confirmation?.costCny ? [`- 成本（求解器，lane 账本）：${JSON.stringify(report.confirmation.costCny)} 元`] : []),
    ...(directional ? ['- 方向性：组数不足时，登记的统计程序自己拒绝给出判定；上面的差异只说明方向，不能当作合格结果，也不得据此提 PR 声称通过。', '- 本活动未动用本季度 α；确认集按“方向性”开启，之后不再作为合格活动的确认集。'] : []),
    ...(report.statistics ? ['', '## 统计', '', `- 判定 ${report.statistics.decision}；${(report.statistics.reasons ?? []).join('；') || '无附加原因'}`] : []),
    ...(report.closure ? ['', '## 偏差', '',
      `- 偏差：评测进程拒绝了回执（${report.closure.deviation.reason.split(':')[0]}），${report.closure.deviation.runs.length} 次运行的成本在账本里没有结算完。本结论由签名的收尾记录（${report.closure.type}）给出，不是回执路径。`,
      ...report.closure.deviation.runs.map((r) => `- 运行 ${r.row}/${r.arm}/第 ${r.repeat + 1} 次（${r.runId}）：成本取账本已结算部分 ${r.usedCost} 元（下限）；账本另有未定调用 ${r.ledger.uncertain ?? '—'} 个、未结预留 ${r.ledger.openCost ?? '—'} 元`),
      `- 没有任何分数、行、重复或臂被改动；登记的统计程序在同一批观测上用这些成本重算；本季度 α 的预留不变（${report.closure.alpha.reservation}）。`,
      ...(report.closure.costTotals ? [`- 计入这些成本后的求解器总成本：${JSON.stringify(report.closure.costTotals)} 元`] : [])] : []),
    '', '本阶段不向生产导入任何东西；通过只代表一项提议：把该补丁以 PR 形式提出，由人审阅合入。',
  ];
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, 'report.md'), `${lines.join('\n')}\n`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, month] = process.argv.slice(2);
  harnessReport(dir, month).then((report) => console.log(JSON.stringify({ qualification: report.qualification, reason: report.reason, directional: report.directional !== null })))
    .catch((error) => { console.error(error?.message ?? error); process.exit(1); });
}
