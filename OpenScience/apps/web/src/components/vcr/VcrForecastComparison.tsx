import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { Disclosure } from '@/components/ui/Disclosure';
import { queueVcrJob, getVcrJob } from '@/lib/vcrClient';
import { webErrorMessage } from '@/lib/apiClient';
import type { LongitudinalRecord } from '@/lib/vcrLongitudinalClient';

const number = (value?: number | null) => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const modes: Record<string, string> = { scenario: '治疗情景', input_sensitivity: '输入敏感性', model_version: '模型版本', update: '新增观测后的更新' };
const date = (value?: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '未记录';
const version = (record: LongitudinalRecord, index: number, records: LongitudinalRecord[]) => {
  const model = record.summary.models?.[index] ?? records.find(r => r.id === record.summary.predictionIds?.[index])?.summary.model;
  return `${model?.name ?? '外部模型'} · ${model?.version ?? '版本未记录'} · 起点 ${date(record.summary.origins?.[index])}`;
};

export function VcrForecastComparison({ studyId, selected, records, canRun, onComplete }: {
  studyId: string; selected: LongitudinalRecord; records: LongitudinalRecord[]; canRun: boolean; onComplete: () => void;
}) {
  const [otherId, setOtherId] = useState('');
  const [mode, setMode] = useState('');
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const others = records.filter(r => r.kind === 'prediction' && r.id !== selected.id
    && ['code', 'unit', 'type'].every(key => r.summary.endpoint?.[key as keyof NonNullable<typeof r.summary.endpoint>] === selected.summary.endpoint?.[key as keyof NonNullable<typeof selected.summary.endpoint>]));
  const other = others.find(r => r.id === otherId) ?? others[0];
  const inferredMode = selected.summary.origin !== other?.summary.origin ? 'update'
    : selected.summary.historyId !== other?.summary.historyId ? 'input_sensitivity'
      : JSON.stringify(selected.summary.model) !== JSON.stringify(other?.summary.model) ? 'model_version' : 'scenario';
  const comparisons = records.filter(r => r.kind === 'comparison' && (r.summary.predictionIds?.includes(selected.id) || r.parentId === selected.id));
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const job = await getVcrJob(studyId, jobId);
        if (!active) return;
        if (job.state === 'succeeded') { setJobId(''); setBusy(false); setMessage('比较已完成。'); onComplete(); }
        else if (['failed', 'canceled', 'awaiting_budget'].includes(job.state)) {
          setJobId(''); setBusy(false); setError(true); setMessage(job.error?.message ?? '本次比较未完成，可在研究对话中查看原因或重试。');
        } else timer = setTimeout(() => { void poll(); }, 1200);
      } catch (cause) {
        if (active) { setBusy(false); setJobId(''); setError(true); setMessage(webErrorMessage(cause, { fallback: '比较状态未能读取，请刷新结果。' })); }
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId, studyId, onComplete]);
  async function compare() {
    if (!other) return;
    setBusy(true); setError(false); setMessage('正在比较相同受试者的预测。');
    try {
      const job = await queueVcrJob(studyId, { kind: 'compare_forecasts', scenario: { predictionId: selected.id, otherPredictionId: other.id, mode: mode || inferredMode } });
      setJobId(job.id);
    } catch (cause) { setBusy(false); setError(true); setMessage(webErrorMessage(cause, { fallback: '比较未能开始，请重试。' })); }
  }
  return <Disclosure summary="预测之间的比较">
    <div className="flex flex-col gap-3">
      {canRun && other && <>
        <Select label="对照预测" value={other.id} onChange={event => setOtherId(event.target.value)} disabled={busy}>
          {others.map(r => <option key={r.id} value={r.id}>{r.summary.endpoint?.code} · {r.summary.model?.name ?? '外部模型'} · {r.summary.model?.version ?? '版本未知'} · {date(r.summary.origin)}</option>)}
        </Select>
        <Select label="比较目的" value={mode || inferredMode} onChange={event => setMode(event.target.value)} disabled={busy}>
          {Object.entries(modes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
        <div><Button variant="secondary" size="sm" loading={busy} disabled={busy} onClick={() => { void compare(); }}>比较所选预测</Button></div>
      </>}
      {!other && !comparisons.length && <p className="text-caption text-text-2">同一终点有两个预测版本后，可以比较治疗情景、输入变化或新增观测后的结果。</p>}
      {message && <p role={error ? 'alert' : 'status'} className={error ? 'text-caption text-error' : 'text-caption text-text-2'}>{message}</p>}
      {comparisons.map(record => <div key={record.id} className="flex flex-col gap-2">
        <h3 className="text-ui font-medium text-text">{modes[record.summary.mode ?? 'scenario'] ?? '预测'}比较</h3>
        <p className="text-caption text-text-3">第一版本：{version(record, 0, records)}<br />第二版本：{version(record, 1, records)}<br />差值为第一版本减第二版本。</p>
        {record.summary.available === false && <p className="text-caption text-text-2">没有可配对的目标日期和受试者，请核对两个预测的终点、单位及目标日期。</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-caption tabular-nums">
          <caption className="sr-only">同一日期、相同受试者的预测差异</caption>
          <thead><tr className="border-b border-border text-text-3">{['目标日期', '配对人数', '第一版本', '第二版本', '均值差', '95% 抽样区间'].map(label => <th key={label} className="p-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{record.summary.groups?.map(group => <tr key={group.horizonDays} className="border-b border-faint text-text-2">
            <td className="p-2">{group.targetAt ? date(group.targetAt) : `${group.horizonDays} 天`}</td>
            {group.displayReason ? <td className="p-2" colSpan={5}>涉及小样本，汇总数值未展示。</td> : <>
              <td className="p-2">{number(group.subjects)}</td><td className="p-2">{number(group.firstMean)}</td><td className="p-2">{number(group.secondMean)}</td>
              <td className="p-2">{number(group.meanDifference)}</td><td className="p-2">{group.lower == null ? '未估计' : `${number(group.lower)}–${number(group.upper)}`}</td>
            </>}
          </tr>)}</tbody>
        </table></div>
        {!!record.summary.changedFactors && record.summary.changedFactors.length > 1 && <p className="text-caption text-text-3">两个版本有多项输入或模型变化，差异不能归因于单一因素。</p>}
        {record.summary.notes?.includes('equal_target_date_different_conditional_risk_windows') && <p className="text-caption text-text-3">目标日期相同，但条件风险的起算日期不同；风险差异不能全部解释为新信息的作用。</p>}
      </div>)}
      {!!comparisons.length && <p className="text-caption text-text-3">比较只使用两边都有预测的受试者和目标日期，不插补缺失时间点。抽样区间描述人群差异；预测差异本身不确立因果治疗效果。</p>}
    </div>
  </Disclosure>;
}
