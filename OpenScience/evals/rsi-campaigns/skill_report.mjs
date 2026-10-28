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
  const inputs = await read(join(dir, 'inputs.json'));
  const run = await read(join(dir, 'run', 'resume.json')) ?? await read(join(dir, 'run', 'run.json'));
  const checkpoint = run?.checkpoint ?? (await read(join(dir, 'run', 'report.json')))?.checkpoint ?? null;
  const evaluation = checkpoint?.evaluation ?? null;
  const confirmation = checkpoint?.stages?.confirmation?.result ?? null;
  const frozen = checkpoint?.frozenPolicy ?? null;
  const candidate = inputs?.registration?.candidates?.find((c) => c.arm === frozen?.arm) ?? null;
  const scores = confirmation?.scores ?? null;
  const base = scores?.baseline, cand = frozen && scores ? scores[frozen.arm] : null;
  const report = {
    type: 'rsi-capability-skill-report-v1', month, campaignId: checkpoint?.campaignId ?? null,
    status: run?.status ?? 'not-run', qualification: run?.qualification ?? evaluation?.decision ?? null,
    reason: run?.reason ?? evaluation?.reasons?.[0] ?? null,
    development: supply?.development ?? null, developmentChoice: supply?.developmentChoice ?? null,
    frozen: frozen ? { arm: frozen.arm, skillDigest: frozen.skillDigest, title: candidate?.title ?? null } : null,
    confirmation: confirmation ? { groups: inputs?.registration?.statistics?.G_target ?? null, sliceGroups: supply?.confirmation?.sliceGroups ?? null,
      repeats: supply?.confirmation?.repeats ?? null, baseline: base ? { overall: base.overall, slice: base.slice } : null,
      candidate: cand ? { overall: cand.overall, slice: cand.slice } : null, costCny: supply?.confirmation?.costCny ?? null } : null,
    statistics: evaluation ? { decision: evaluation.decision, reasons: evaluation.reasons ?? [], quantities: evaluation.quantities ?? null, scope: evaluation.scope ?? null } : null,
    failureCalculators: inputs?.registration?.failureCalculators ?? null,
  };
  const lines = [
    `# 能力技能 RSI 活动报告 · ${month}`, '',
    `结论：${report.qualification === 'qualified' ? '候选技能通过确认（targeted-repair）' : report.qualification ? `未通过（${report.qualification}）` : '未运行'}${report.reason ? `，原因 ${report.reason}` : ''}。`, '',
    '## 开发期', '',
    `- 开发行 ${report.development?.rows ?? '—'}（失败子集 ${report.development?.sliceRows ?? '—'}），各臂成本 ${JSON.stringify(report.development?.costCny ?? {})} 元`,
    ...(report.developmentChoice?.candidates ?? []).map((c) => `- 候选 ${c.arm}（${c.chars} 字）：总体 ${signed(c.overallDifference)}，失败子集 ${signed(c.sliceDifference)}`),
    `- 冻结：${report.frozen ? `${report.frozen.arm} 「${report.frozen.title ?? ''}」` : '无（' + (report.developmentChoice?.reason ?? '—') + '）'}`, '',
    '## 确认期', '',
    report.confirmation ? `- ${report.confirmation.groups} 组（失败子集 ${report.confirmation.sliceGroups}），每组每臂重复 ${report.confirmation.repeats} 次` : '- 未进行',
    ...(report.confirmation?.baseline ? [`- 对照：总体 ${pct(report.confirmation.baseline.overall)}，失败子集 ${pct(report.confirmation.baseline.slice)}`] : []),
    ...(report.confirmation?.candidate ? [`- 候选：总体 ${pct(report.confirmation.candidate.overall)}，失败子集 ${pct(report.confirmation.candidate.slice)}`] : []),
    ...(report.confirmation?.costCny ? [`- 成本：${JSON.stringify(report.confirmation.costCny)} 元`] : []),
    ...(report.statistics ? ['', '## 统计', '', `- 判定 ${report.statistics.decision}；${(report.statistics.reasons ?? []).join('；') || '无附加原因'}`] : []),
    '', '本阶段不向生产导入任何东西；通过只代表一项提议：把该技能加入平台技能库。',
  ];
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ qualification: report.qualification, reason: report.reason }));
}

main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });
