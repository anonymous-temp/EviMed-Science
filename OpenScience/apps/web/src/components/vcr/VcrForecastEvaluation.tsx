import type { LongitudinalRecord } from '@/lib/vcrLongitudinalClient';

const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
const labels: Record<string, string> = { mae: '平均绝对误差', rmse: '均方根误差', crps: '分布误差（CRPS）', auroc: 'AUROC', averagePrecision: '平均精确率', brier: 'Brier 分数', intervalCoverage: '预测区间覆盖率' };
const baselines: Record<string, string> = { persistence: '最近一次观测', trend: '既往线性趋势', calibration_prevalence: '校准集事件比例', calibration_kaplan_meier: '校准集 Kaplan–Meier' };
export const forecastIssue = (code: string) => ({ provider_rows_invalid: '云端返回的部分预测格式有误', canceled: '预测已停止', forecast_time_budget: '本次预测时间已用完', forecast_cost_budget: '本次预测预算已用完', provider_configuration_changed: '预测服务配置发生变化', provider_version_mismatch: '返回的模型版本与请求不符', target_identity_unknown: '部分证据缺少组别或时间点，请在研究对话中补充来源定位', target_identity_mismatch: '部分预测与证据的组别、终点或时间点不一致', actual_evidence_unverified: '部分实际效果尚未对应到可核对的来源', preserved_evidence_missing: '部分比较引用的证据尚未导入', split_not_declared: '部分试验尚未声明验证划分', trial_family_overlap: '部分试验家族同时出现在校准和测试数据中', comparison_invalid: '部分试验预测条目格式有误' }[code] ?? '部分记录暂不可用，具体原因可在研究对话中查看');

export function VcrForecastEvaluation({ record }: { record: LongitudinalRecord }) {
  const trial = record.kind === 'trial_evaluation';
  return <div className="flex flex-col gap-3">
    <h3 className="text-ui font-medium text-text">{trial ? '与试验证据比较' : '与后续观测比较'}</h3>
    <p className="text-caption text-text-3">{record.summary.validationClass === 'engineering_synthetic' ? '模拟数据流程验证' : trial ? '独立试验基准' : '纵向数据验证'} · {record.summary.trainingOverlap === 'unknown' ? '模型训练数据重叠情况未知' : '训练数据重叠情况已记录'}</p>
    {trial && <p className="text-caption text-text-2">纳入 {number(record.summary.comparisons)} 条比较，排除 {number(record.summary.excluded)} 条。</p>}
    {record.summary.groups?.map((group, index) => <div key={`${group.horizonDays}:${index}`} className="flex flex-col gap-3">
      <h4 className="text-caption font-medium text-text">{group.horizonDays} 天{group.endpoint ? ` · ${group.endpoint} · ${group.scale} · ${group.unit}` : ''}</h4>
      {group.displayReason === 'small_cell_suppression' ? <p className="text-caption text-text-2">这一时间点涉及小样本，汇总数值未展示；不代表结局缺失。</p> : <>
        {!trial && <p className="text-caption tabular-nums text-text-2">应预测 {number(group.requested)} 人 · 已验证 {number(group.evaluated ?? group.subjects)} 人 · 缺少预测 {number(group.missingForecasts)} 人 · 无效预测 {number(group.invalidForecasts)} 人 · 缺少结局 {number(group.missingOutcomes)} 人{group.events != null ? ` · 事件 ${number(group.events)} 人` : ''}</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-caption tabular-nums">
          <caption className="sr-only">{group.horizonDays} 天的指标与抽样置信区间</caption>
          <thead><tr className="border-b border-border text-text-3"><th className="p-2 font-medium">指标</th><th className="p-2 font-medium">结果</th><th className="p-2 font-medium">95% 置信区间</th></tr></thead>
          <tbody>{Object.entries(group.metrics ?? {}).filter(([key]) => labels[key]).map(([key, metric]) =>
            <tr key={key} className="border-b border-faint text-text-2"><td className="p-2">{labels[key]}</td><td className="p-2">{metric.value == null ? '未估计' : number(metric.value)}</td><td className="p-2">{metric.lower != null && metric.upper != null ? `${number(metric.lower)}–${number(metric.upper)}` : '未估计'}</td></tr>)}</tbody>
        </table></div>
        {Object.entries(group.baselines ?? {}).map(([name, baseline]) => <div key={name} className="overflow-x-auto"><table className="w-full text-left text-caption tabular-nums">
          <caption className="mb-2 text-left text-text-2">与{baselines[name] ?? name}比较 · 相同 {number(baseline.subjects)} 人</caption>
          <thead><tr className="border-b border-border text-text-3"><th className="p-2 font-medium">指标</th><th className="p-2 font-medium">模型</th><th className="p-2 font-medium">基线</th><th className="p-2 font-medium">点估计较优</th></tr></thead>
          <tbody>{Object.entries(baseline.comparisons ?? {}).map(([key, comparison]) => <tr key={key} className="border-b border-faint text-text-2"><td className="p-2">{labels[key] ?? key}</td><td className="p-2">{number(comparison.model)}</td><td className="p-2">{number(comparison.baseline)}</td><td className="p-2">{{ model: '模型', baseline: '基线', equal: '相同' }[comparison.preferred] ?? '未估计'}</td></tr>)}</tbody>
        </table></div>)}
        {group.baseline?.metrics && <div className="overflow-x-auto"><table className="w-full text-left text-caption tabular-nums"><caption className="mb-2 text-left text-text-2">其他试验家族均值基线</caption><tbody>{Object.entries(group.baseline.metrics).filter(([key]) => labels[key]).map(([key, metric]) => <tr key={key} className="border-b border-faint text-text-2"><th className="p-2 font-medium">{labels[key]}</th><td className="p-2">{number(metric.value)}</td></tr>)}</tbody></table></div>}
        {group.distributionAvailability && <p className="text-caption text-text-3">预测样本 {number(group.distributionAvailability.sampleRows)} 条，预测分位区间 {number(group.distributionAvailability.intervalRows)} 条，预测标准差 {number(group.distributionAvailability.sdRows)} 条。CRPS 需要预测样本，区间覆盖率需要分位数；未提供时对应指标无法计算。</p>}
      </>}
    </div>)}
    {[...new Set(record.summary.issues?.map(issue => issue.code))].map(code => <p key={code} className="text-caption text-text-2">{forecastIssue(code ?? '')}</p>)}
    <p className="text-caption text-text-3">点估计较优不代表差异具有统计学显著性。各指标的抽样区间不用于替代模型与基线的差异检验。</p>
  </div>;
}
