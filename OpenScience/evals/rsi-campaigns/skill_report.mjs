/**
 * The capability-skill campaign's report: report.json and a Chinese report.md from the run directory, whatever the verdict
 * (signed afterwards by the evaluator's `report` command, as the frontier campaign's is).
 *
 *   node skill_report.mjs <campaign-dir> <month>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const read = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const pct = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—');
const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} 个百分点` : '—');

async function main() {
  const [dir, month] = process.argv.slice(2);
  const supply = await read(join(dir, 'supply.json'));
  const devOnly = await read(join(dir, 'development-only.json'));
  const inputs = await read(join(dir, 'inputs.json'));
  const run = await read(join(dir, 'run', 'resume.json')) ?? await read(join(dir, 'run', 'run.json'));
  const checkpoint = run?.checkpoint ?? (await read(join(dir, 'run', 'report.json')))?.checkpoint ?? null;
  const evaluation = checkpoint?.evaluation ?? null;
  const confirmation = checkpoint?.stages?.confirmation?.result ?? null;
  const frozen = checkpoint?.frozenPolicy ?? null;
  const candidate = inputs?.registration?.candidates?.find((c) => c.arm === frozen?.arm) ?? null;
  const scores = confirmation?.scores ?? null;
  const base = scores?.baseline, cand = frozen && scores ? scores[frozen.arm] : null;
  const qualification = run?.qualification ?? evaluation?.decision ?? (devOnly ? 'not-qualified' : null);
  // A confirmation below the registered procedure's minimum number of groups (in the family, or in its failure slice) is refused by the procedure itself
  // (`inconclusive`, sparse population); that is a directional reading and never a qualification. Decided from the counts, not from the refusal's wording.
  const groups = inputs?.registration?.statistics?.G_target ?? null, sliceGroups = supply?.confirmation?.sliceGroups ?? null, minimum = inputs?.registration?.statistics?.procedure?.minimum_slice_groups ?? null;
  const directional = Boolean(confirmation) && qualification !== 'qualified' && Number.isFinite(minimum) && ((Number.isFinite(groups) && groups < minimum) || (Number.isFinite(sliceGroups) && sliceGroups < minimum));
  const report = {
    type: 'rsi-capability-skill-report-v1', month, campaignId: checkpoint?.campaignId ?? null,
    status: run?.status ?? devOnly?.status ?? 'not-run', qualification, directional: directional ? { groups, sliceGroups, minimum } : null,
    reason: run?.reason ?? evaluation?.reasons?.[0] ?? devOnly?.supply?.developmentChoice?.reason ?? null,
    scoresDevelopment: devOnly?.supply?.developmentChoice?.scores ?? null,
    improvers: inputs?.registration?.improvers ?? devOnly?.registration?.improvers ?? null,
    development: supply?.development ?? null, developmentChoice: supply?.developmentChoice ?? null,
    frozen: frozen ? { arm: frozen.arm, skillDigest: frozen.skillDigest, title: candidate?.title ?? null } : null,
    confirmation: confirmation ? { groups: inputs?.registration?.statistics?.G_target ?? null, sliceGroups: supply?.confirmation?.sliceGroups ?? null,
      repeats: supply?.confirmation?.repeats ?? null, baseline: base ? { overall: base.overall, slice: base.slice } : null,
      candidate: cand ? { overall: cand.overall, slice: cand.slice } : null, costCny: supply?.confirmation?.costCny ?? null } : null,
    statistics: evaluation ? { decision: evaluation.decision, reasons: evaluation.reasons ?? [], quantities: evaluation.quantities ?? null, scope: evaluation.scope ?? null } : null,
    scorer: inputs?.registration?.scorer ?? 'medcalc',
    failureCalculators: inputs?.registration?.failureCalculators ?? inputs?.registration?.failureSlice ?? null,
  };
  const lines = [
    `# 能力技能 RSI 活动报告 · ${month}`, '',
    `结论：${directional ? `方向性参考，不是合格结论（确认集 ${groups} 组、失败子集 ${sliceGroups} 组，低于登记统计程序的 ${minimum} 组下限）`
      : report.qualification === 'qualified' ? '候选技能通过确认（targeted-repair）' : report.qualification ? `未通过（${report.qualification}）` : '未运行'}${report.reason ? `，原因 ${report.reason}` : ''}。`, '',
    '## 开发期', '',
    `- 开发行 ${report.development?.rows ?? '—'}（失败子集 ${report.development?.sliceRows ?? '—'}），各臂成本 ${JSON.stringify(report.development?.costCny ?? {})} 元`,
    ...(report.developmentChoice?.candidates ?? []).map((c) => `- 候选 ${c.arm}（${c.chars} 字）：总体 ${signed(c.overallDifference)}，失败子集 ${signed(c.sliceDifference)}`),
    ...(report.scoresDevelopment ? Object.entries(report.scoresDevelopment).map(([arm, s]) => `- ${arm}：总体 ${pct(s.overall)}，失败子集 ${pct(s.slice)}`) : []),
    ...(report.improvers?.length ? [`- 候选由 ${report.improvers.map((i) => i.model).join('、')} 撰写（操作员订阅，不计费）`] : []),
    `- 冻结：${report.frozen ? `${report.frozen.arm} 「${report.frozen.title ?? ''}」` : '无（' + (report.developmentChoice?.reason ?? '—') + '）'}`, '',
    '## 确认期', '',
    report.confirmation ? `- ${report.confirmation.groups} 组（失败子集 ${report.confirmation.sliceGroups}），每组每臂重复 ${report.confirmation.repeats} 次` : '- 未进行：开发期没有改进候选，确认集未开启，本季度 α 未动用',
    ...(report.confirmation?.baseline ? [`- 对照：总体 ${pct(report.confirmation.baseline.overall)}，失败子集 ${pct(report.confirmation.baseline.slice)}`] : []),
    ...(report.confirmation?.candidate ? [`- 候选：总体 ${pct(report.confirmation.candidate.overall)}，失败子集 ${pct(report.confirmation.candidate.slice)}`] : []),
    ...(report.confirmation?.costCny ? [`- 成本：${JSON.stringify(report.confirmation.costCny)} 元`] : []),
    ...(directional ? ['- 方向性：组数不足时，登记的统计程序自己拒绝给出判定；上面的差异只说明方向，不能当作合格结果。', '- 本活动未动用本季度 α；确认集按“方向性”开启，之后不再作为合格活动的确认集。'] : []),
    ...(report.statistics ? ['', '## 统计', '', `- 判定 ${report.statistics.decision}；${(report.statistics.reasons ?? []).join('；') || '无附加原因'}`] : []),
    '', '本阶段不向生产导入任何东西；通过只代表一项提议：把该技能加入平台技能库。',
  ];
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ qualification: report.qualification, reason: report.reason }));
}

main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
