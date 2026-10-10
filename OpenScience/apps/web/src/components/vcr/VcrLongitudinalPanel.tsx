import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { Disclosure } from '@/components/ui/Disclosure';
import { Tag } from '@/components/ui/Tag';
import { ChartCard } from '@/components/ui/ChartCard';
import { webErrorMessage } from '@/lib/apiClient';
import { getVcrLongitudinal, importVcrPrediction, type LongitudinalRecord } from '@/lib/vcrLongitudinalClient';
import type { VcrSeries } from '@/lib/vcrClient';
import { VcrTrajectoryChart, VcrSeriesLegend } from './VcrCharts';
import { useVcrLoad, VcrTabError } from './vcrTabKit';
import { VcrTabSkeleton } from './VcrStates';

const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
const date = (value?: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '时间未记录';
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

/** Longitudinal research extends the existing patient tab. The conversation
 * chooses mappings and analysis; this panel imports files and compares versions. */
export function VcrLongitudinalPanel({ studyId, canRun }: { studyId: string; canRun: boolean }) {
  const { state, reload } = useVcrLoad(`${studyId}:longitudinal`, () => getVcrLongitudinal(studyId));
  const [historyId, setHistoryId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (state.kind === 'loading') return <VcrTabSkeleton />;
  if (state.kind === 'error') return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const records = data.records ?? [];
  const histories = records.filter(r => r.kind === 'history');
  const predictions = records.filter(r => r.kind === 'prediction');
  const history = histories.find(r => r.id === historyId) ?? histories.find(r => r.id === predictions[0]?.summary.historyId) ?? histories[0];
  const historyPredictions = predictions.filter(r => r.summary.historyId === history?.id);
  const selected = historyPredictions.find(r => r.id === selectedId) ?? historyPredictions[0];
  const evaluations = records.filter(r => r.kind === 'evaluation' && r.parentId === selected?.id);
  const evaluated = evaluations[0]?.summary.groups;
  const chartSeries: VcrSeries[] = selected ? [{ key: selected.id, label: '模型预测', source: 'predicted', ours: true,
    points: evaluated ? evaluated.map(g => ({x:g.horizonDays,y:g.forecastMean}))
      : (selected.summary.trajectories ?? []).map(p => ({x:p.day,y:p.mean})) },
    ...(evaluated ? [{ key: 'observed', label: '后续观测', source: 'observed' as const,
      points: evaluated.map(g => ({x:g.horizonDays,y:g.observedMean == null ? null : selected.summary.endpoint?.type === 'survival_probability' ? 1-g.observedMean : g.observedMean})) }] : [])] : [];
  async function upload(file?: File) {
    if (!file || !history) return;
    setBusy(true); setMessage(''); setError(false);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('预测文件超过 8 MB，请拆分后导入。');
      const body = JSON.parse(await file.text());
      const result = await importVcrPrediction(studyId, { ...body, historyId: history.id });
      setSelectedId(result.id); setMessage(`已导入 ${number(result.summary.accepted)} 条预测，${number(result.summary.invalidRows)} 条需补充或更正。`); reload();
    } catch (cause) {
      setError(true); setMessage(webErrorMessage(cause, { fallback: '文件未能导入，请检查预测模板后重试。' }));
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <section className="flex flex-col gap-4" aria-label="纵向预测与验证">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-section font-semibold text-text">纵向预测与验证</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => download('longitudinal-events.csv', [data.templates.events.columns.join(','), data.templates.events.example.join(',')].join('\n'), 'text/csv')}>下载事件模板</Button>
        <Button variant="ghost" size="sm" onClick={() => download('prediction-template.json', JSON.stringify({ ...data.templates.prediction, ...(history ? { historyId: history.id, origin: history.summary.origin } : {}) }, null, 2), 'application/json')}>下载预测模板</Button>
        {canRun && <Button size="sm" disabled={!history || busy} loading={busy} onClick={() => input.current?.click()}>导入预测文件</Button>}
        <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="选择预测结果文件" onChange={event => { void upload(event.target.files?.[0]); }} />
      </div>
    </div>
    {!history && <p className="text-ui text-text-2">在数据页接入随访记录，再在研究对话中说明预测起点和终点。也可以继续用文献进行情景分析。</p>}
    {history && <>
      <Select label="输入历史" value={history.id} onChange={event => { setHistoryId(event.target.value); setSelectedId(''); }}>
        {histories.map(r => <option key={r.id} value={r.id}>{date(r.summary.origin)} · {number(r.summary.subjects)} 人 · {number(r.summary.events)} 条记录</option>)}
      </Select>
      <p className="text-caption text-text-2">{number(history.summary.repeatedSubjects)} 人有重复观测，历史跨度中位数 {number(history.summary.medianHistoryDays)} 天。{history.summary.dataClass === 'synthetic' && '这批是模拟数据，仅用于检验流程。'}</p>
    </>}
    {message && <p role={error ? 'alert' : 'status'} className={error ? 'text-caption text-error' : 'text-caption text-text-2'}>{message}</p>}
    {selected && <>
      <Select label="预测版本" value={selected.id} onChange={event => setSelectedId(event.target.value)}>
        {historyPredictions.map(r => <option key={r.id} value={r.id}>{date(r.summary.origin)} · {r.summary.model?.name ?? '外部模型'} · {r.summary.model?.version ?? '版本未提供'}</option>)}
      </Select>
      <div className="flex flex-wrap items-center gap-2 text-caption text-text-2">
        <Tag>{selected.summary.originKind === 'cloud_api' ? '云端模型预测' : '外部导入预测'}</Tag>
        <span>{selected.summary.endpoint?.code} · {selected.summary.endpoint?.unit}</span>
        <span>{number(selected.summary.accepted)} 条可用预测</span>
      </div>
      {chartSeries[0]?.points.length > 1 ? <ChartCard title="随预测时间变化的结果" footnote={evaluated ? '每个时间点的预测与观测使用同一批受试者；人数可能随时间变化。' : '曲线为人群平均预测。'}>
        <VcrTrajectoryChart xLabel="距预测起点（天）" yLabel={selected.summary.endpoint?.unit} series={chartSeries} />
        <div className="flex flex-wrap gap-4"><VcrSeriesLegend series={chartSeries} /></div>
      </ChartCard> : chartSeries[0]?.points.length === 1 && <dl className="flex flex-wrap gap-6">
        {chartSeries.map(series => <div key={series.key}><dt className="text-caption text-text-3">{series.points[0]?.x} 天 · {series.label}</dt>
          <dd className="text-section font-medium tabular-nums text-text">{number(series.points[0]?.y)} <span className="text-caption text-text-3">{selected.summary.endpoint?.unit}</span></dd></div>)}
      </dl>}

      {evaluations.map(record => <Evaluation key={record.id} record={record} />)}
      {!evaluations.length && <p className="text-caption text-text-3">接入后续观测后，可在对话中要求比较预测与实际结果。</p>}
    </>}
    <Disclosure summary="可用模型与版本记录">
      <ul className="flex flex-col gap-2 text-caption text-text-2">
        {(data.providers ?? []).map(provider => <li key={provider.id}>{provider.name} · {provider.version}</li>)}
        {!data.providers?.length && <li>尚未接入专用预测模型；可以导入已有预测结果。</li>}
        {records.filter(r => ['history', 'prediction'].includes(r.kind)).slice(0, 12).map(record => <li key={record.id}>{date(record.createdAt)} · {record.kind === 'history' ? '历史快照' : '预测结果'} · {record.summary.model?.version ?? date(record.summary.origin)}</li>)}
      </ul>
    </Disclosure>
  </section>;
}

function Evaluation({ record }: { record: LongitudinalRecord }) {
  const labels: Record<string, string> = { mae: '平均绝对误差', rmse: '均方根误差', crps: '分布误差（CRPS）', auroc: 'AUROC', averagePrecision: '平均精确率', brier: 'Brier 分数', intervalCoverage: '预测区间覆盖率' };
  return <div className="flex flex-col gap-3">
    <h3 className="text-ui font-medium text-text">与后续观测比较</h3>
    <p className="text-caption text-text-3">{record.summary.validationClass === 'engineering_synthetic' ? '模拟数据流程验证' : '纵向数据验证'} · {record.summary.trainingOverlap === 'unknown' ? '模型训练数据重叠情况未知' : '训练数据重叠情况已记录'}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-caption tabular-nums">
      <caption className="sr-only">各预测跨度的误差与患者抽样置信区间</caption>
      <thead><tr className="border-b border-border text-text-3"><th className="p-2 font-medium">跨度</th><th className="p-2 font-medium">参与者</th><th className="p-2 font-medium">指标</th><th className="p-2 font-medium">结果</th><th className="p-2 font-medium">95% 置信区间</th></tr></thead>
      <tbody>{record.summary.groups?.flatMap(group => Object.entries(group.metrics ?? {}).filter(([key, metric]) => labels[key] && metric.value != null).map(([key, metric]) =>
        <tr key={`${group.horizonDays}:${key}`} className="border-b border-faint text-text-2"><td className="p-2">{group.horizonDays} 天</td><td className="p-2">{number(group.subjects)}</td><td className="p-2">{labels[key]}</td><td className="p-2">{number(metric.value)}</td><td className="p-2">{metric.lower != null && metric.upper != null ? `${number(metric.lower)}–${number(metric.upper)}` : '未估计'}</td></tr>))}</tbody>
    </table></div>
  </div>;
}
