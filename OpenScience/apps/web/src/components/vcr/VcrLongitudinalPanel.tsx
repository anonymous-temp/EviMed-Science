import { useRef, useState } from 'react';
import { Download, FileUp } from 'lucide-react';
import { Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { FactList, type Fact } from '@/components/ui/FactList';
import { Section } from '@/components/ui/Section';
import { Tag } from '@/components/ui/Tag';
import { ChartCard } from '@/components/ui/ChartCard';
import type { ToolbarChips } from '@/components/ui/Toolbar';
import { webErrorMessage } from '@/lib/apiClient';
import { getVcrLongitudinal, importVcrPrediction, importVcrBenchmark, type LongitudinalRecord, type VcrLongitudinalData } from '@/lib/vcrLongitudinalClient';
import { VcrForecastEvaluation, forecastIssue } from './VcrForecastEvaluation';
import { VcrForecastComparison } from './VcrForecastComparison';
import type { VcrSeries } from '@/lib/vcrClient';
import { VcrTrajectoryChart, VcrSeriesLegend } from './VcrCharts';
import { useVcrLoad } from './vcrTabKit';
import { useVcrToolbar } from './studyFrameContext';
import { VcrToolbarActions, type VcrToolbarAction } from './VcrToolbarActions';

const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
const date = (value?: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '时间未记录';
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

/** The study's longitudinal records: read with the study (this key follows it), so a result a job just wrote appears by itself. */
export function useLongitudinal(studyId: string) {
  return useVcrLoad(`${studyId}:longitudinal`, () => getVcrLongitudinal(studyId));
}

/**
 * Whether the second view of the patients tab exists: a follow-up history, a prediction, a comparison, a trial benchmark — anything
 * the longitudinal route holds. With none of them there is nothing to look at and no view is drawn (R19, plan §5.3: the panel used
 * to hang under an empty patients page with a primary button that was always grey).
 */
export function hasLongitudinal(data: VcrLongitudinalData | null | undefined): boolean {
  return Boolean(data && data.available !== false && (data.records.length > 0 || (data.related ?? []).length > 0));
}

/**
 * 预测验证: real follow-up history, an outside model's predictions of it, and how they compare with what was observed afterwards —
 * a feature of its own that shares the patients tab, as that tab's second view (`switcher`, drawn in the band's one toolbar row).
 *
 * The conversation chooses mappings and analysis; this view imports files and compares versions. What it used to say about itself —
 * how to bring a history in, what the benchmark is for, the providers list — is the conversation's and the log's, not a sentence
 * here. Templates and imports are the toolbar's 「⋯」: a button that cannot act (a prediction file with no history to attach it to)
 * is not in it.
 */
export function VcrLongitudinalPanel({ studyId, canRun, data, onReload, switcher }: {
  studyId: string;
  canRun: boolean;
  data: VcrLongitudinalData;
  /** Read the records again (after an import, or a comparison that finished). */
  onReload: () => void;
  /** The patients tab's view switch, so the toolbar holds the same one on both views. */
  switcher?: ToolbarChips | null;
}) {
  const [historyId, setHistoryId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const [pages, setPages] = useState<{ studyId: string; records: LongitudinalRecord[]; nextOffset?: number | null }>({ studyId, records: [] });
  const [benchmarkId, setBenchmarkId] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const benchmarkInput = useRef<HTMLInputElement>(null);
  const held = pages.studyId === studyId ? pages : { records: [], nextOffset: undefined };
  const records = [...new Map([...held.records, ...data.records, ...(data.related ?? [])].map(record => [record.id, record])).values()]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || b.id.localeCompare(a.id));
  const nextOffset = held.nextOffset === undefined ? data.nextOffset : held.nextOffset;
  const benchmarks = records.filter(r => r.kind === 'trial_benchmark');
  const benchmark = benchmarks.find(r => r.id === benchmarkId) ?? benchmarks[0];
  const histories = records.filter(r => r.kind === 'history');
  const predictions = records.filter(r => r.kind === 'prediction');
  const history = histories.find(r => r.id === historyId) ?? histories.find(r => r.id === predictions[0]?.summary.historyId) ?? histories[0];
  const historyPredictions = predictions.filter(r => r.summary.historyId === history?.id);
  const selected = historyPredictions.find(r => r.id === selectedId) ?? historyPredictions[0];
  const evaluations = records.filter(r => r.kind === 'evaluation' && r.parentId === selected?.id);
  const evaluated = evaluations[0]?.summary.groups;
  const chartSeries: VcrSeries[] = selected ? [{ key: selected.id, label: '模型预测', source: 'predicted', ours: true,
    points: evaluated ? evaluated.map(g => ({x:g.horizonDays,y:g.forecastMean ?? null}))
      : (selected.summary.trajectories ?? []).map(p => ({x:p.day,y:p.mean})) },
    ...(evaluated ? [{ key: 'observed', label: '后续观测', source: 'observed' as const,
      points: evaluated.map(g => ({x:g.horizonDays,y:g.observedMean == null ? null : selected.summary.endpoint?.type === 'survival_probability' ? 1-g.observedMean : g.observedMean})) }] : [])] : [];
  function refresh() { setPages({ studyId, records }); onReload(); }
  async function more() {
    if (nextOffset == null) return;
    setBusy(true); setMessage(''); setError(false);
    try {
      const page = await getVcrLongitudinal(studyId, { offset: nextOffset });
      setPages({ studyId, records: [...records, ...page.records, ...(page.related ?? [])], nextOffset: page.nextOffset ?? null });
    } catch (cause) { setError(true); setMessage(webErrorMessage(cause, { fallback: '较早版本未能读取，请重试。' })); }
    finally { setBusy(false); }
  }
  async function upload(file?: File, trial = false) {
    if (!file || !trial && !history) return;
    setBusy(true); setMessage(''); setError(false);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('预测文件超过 8 MB，请拆分后导入。');
      const body = JSON.parse(await file.text());
      const result = trial ? await importVcrBenchmark(studyId, body) : await importVcrPrediction(studyId, { ...body, historyId: history.id });
      if (trial) { setBenchmarkId(result.id); setMessage(`已导入 ${number(result.summary.comparisons)} 条试验预测，其中 ${number(result.summary.matched)} 条已对应到证据。`); }
      else if (result.kind === 'prediction_set') {
        setSelectedId(result.summary.components?.[0]?.id ?? '');
        setMessage(`已导入 ${number(result.summary.acceptedComponents)} 个终点的 ${number(result.summary.accepted)} 条预测，${number(result.summary.invalidComponents)} 个终点需更正；可用部分已保留。`);
      } else { setSelectedId(result.id); setMessage(`已导入 ${number(result.summary.accepted)} 条预测，${number(result.summary.invalidRows)} 条需补充或更正。`); }
      setPages({ studyId, records: [...records, result] }); onReload();
    } catch (cause) {
      setError(true); setMessage(webErrorMessage(cause, { fallback: '文件未能导入，请检查预测模板后重试。' }));
    } finally { setBusy(false); if (input.current) input.current.value = ''; if (benchmarkInput.current) benchmarkInput.current.value = ''; }
  }

  // The toolbar's own: the view switch, and the templates and the two imports behind 「⋯」. A reader who may not run sees only what they
  // can use (the templates); an import with nothing to attach to is not offered.
  const actions: VcrToolbarAction[] = [
    { key: 'events', label: '下载事件模板', icon: Download, quiet: true, onSelect: () => download('longitudinal-events.csv', [data.templates.events.columns.join(','), data.templates.events.example.join(',')].join('\n'), 'text/csv') },
    { key: 'prediction', label: '下载预测模板', icon: Download, quiet: true, onSelect: () => download('prediction-template.json', JSON.stringify({ ...data.templates.prediction, ...(history ? { historyId: history.id, origin: history.summary.origin } : {}) }, null, 2), 'application/json') },
    ...(data.templates.predictionSet ? [{ key: 'set', label: '下载多终点模板', icon: Download, quiet: true, onSelect: () => download('prediction-set-template.json', JSON.stringify({ ...data.templates.predictionSet, ...(history ? { historyId: history.id, origin: history.summary.origin } : {}) }, null, 2), 'application/json') }] : []),
    ...(data.templates.benchmark ? [{ key: 'benchmark', label: '下载试验基准模板', icon: Download, quiet: true, onSelect: () => download('trial-benchmark-template.json', JSON.stringify(data.templates.benchmark, null, 2), 'application/json') }] : []),
    ...(canRun && history ? [{ key: 'import', label: '导入预测文件', icon: FileUp, loading: busy, onSelect: () => input.current?.click() }] : []),
    ...(canRun ? [{ key: 'import-benchmark', label: '导入试验预测', icon: FileUp, loading: busy, onSelect: () => benchmarkInput.current?.click() }] : []),
  ];
  useVcrToolbar({
    ...(switcher ? { filters: [switcher] } : {}),
    actions: <VcrToolbarActions actions={actions} label="模板与导入" menu />,
  });

  const interrupted = records.filter(r => r.kind === 'prediction_interruption' && r.summary.predictionId === selected?.id);
  const failures = [...(selected?.summary.failures ?? []).map(failure => forecastIssue(failure.code)), ...interrupted.map(r => forecastIssue(r.summary.code ?? ''))];
  const log = records.filter(r => ['history', 'prediction'].includes(r.kind)).slice(0, 12);
  const providers = data.providers ?? [];

  const historyFacts: Fact[] = history ? [
    { label: '人数', value: number(history.summary.subjects) },
    { label: '记录条数', value: number(history.summary.events) },
    { label: '有重复观测', value: `${number(history.summary.repeatedSubjects)} 人` },
    { label: '历史跨度中位数', value: `${number(history.summary.medianHistoryDays)} 天` },
    ...(history.summary.subjectsWithoutObservations ? [{ label: '没有观测', value: `${number(history.summary.subjectsWithoutObservations)} 人` }] : []),
  ] : [];

  return <section className="flex flex-col gap-6" aria-label="预测与验证">
    <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="选择预测结果文件" onChange={event => { void upload(event.target.files?.[0]); }} />
    <input ref={benchmarkInput} type="file" accept=".json,application/json" className="sr-only" aria-label="选择试验预测文件" onChange={event => { void upload(event.target.files?.[0], true); }} />

    {history && <div className="flex flex-col gap-3">
      <Select label="输入历史" value={history.id} onChange={event => { setHistoryId(event.target.value); setSelectedId(''); }}>
        {histories.map(r => <option key={r.id} value={r.id}>{date(r.summary.origin)} · {number(r.summary.subjects)} 人 · {number(r.summary.events)} 条记录</option>)}
      </Select>
      <FactList rows={historyFacts} />
    </div>}
    {message && <p role={error ? 'alert' : 'status'} className={error ? 'text-ui text-error' : 'text-ui text-text-2'}>{message}</p>}
    {selected && <div className="flex flex-col gap-4">
      <Select label="预测版本" value={selected.id} onChange={event => setSelectedId(event.target.value)}>
        {historyPredictions.map(r => <option key={r.id} value={r.id}>{r.summary.endpoint?.code} · {date(r.summary.origin)} · {r.summary.model?.name ?? '外部模型'} · {r.summary.model?.version ?? '版本未提供'}</option>)}
      </Select>
      <FactList rows={[
        { label: '来源', value: <Tag>{selected.summary.originKind === 'cloud_api' ? '云端模型预测' : '外部导入预测'}</Tag> },
        { label: '终点', value: [selected.summary.endpoint?.code, selected.summary.endpoint?.unit].filter(Boolean).join(' · ') || '—' },
        { label: '可用预测', value: `${number(selected.summary.accepted)} 条` },
        ...(selected.summary.invalidRows ? [{ label: '未纳入计算', value: `${number(selected.summary.invalidRows)} 条` }] : []),
      ]} />
      {chartSeries[0]?.points.length > 1 ? <ChartCard title="随预测时间变化的结果" legend={<VcrSeriesLegend series={chartSeries} />}>
        <VcrTrajectoryChart xLabel="距预测起点（天）" yLabel={selected.summary.endpoint?.unit} series={chartSeries} />
      </ChartCard> : chartSeries[0]?.points.length === 1 && <dl className="flex flex-wrap gap-6">
        {chartSeries.map(series => <div key={series.key}><dt className="text-caption text-text-3">{series.points[0]?.x} 天 · {series.label}</dt>
          <dd className="text-section font-semibold tabular-nums text-text">{number(series.points[0]?.y)} <span className="text-caption text-text-3">{selected.summary.endpoint?.unit}</span></dd></div>)}
      </dl>}

      {failures.length > 0 && <Section title="没有算完" level="sub" count={failures.length}>
        <ul className="flex flex-col gap-1 text-ui text-text-2">{failures.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </Section>}
      {evaluations.map(record => <VcrForecastEvaluation key={record.id} record={record} />)}
      <VcrForecastComparison key={selected.id} studyId={studyId} selected={selected} records={records} canRun={canRun} onComplete={refresh} />
    </div>}

    {benchmark && <Section title="试验效果基准验证" level="sub">
      <div className="flex flex-col gap-3">
        <Select label="试验预测版本" value={benchmark.id} onChange={event => setBenchmarkId(event.target.value)}>{benchmarks.map(r => <option key={r.id} value={r.id}>{r.summary.model?.name ?? '外部模型'} · {r.summary.model?.version ?? '版本未知'} · {date(r.createdAt)}</option>)}</Select>
        <FactList rows={[{ label: '已对应到试验证据', value: `${number(benchmark.summary.matched)} / ${number(benchmark.summary.comparisons)} 条` }]} />
        {[...new Set(benchmark.summary.issues?.map(issue => issue.code))].map(code => <p key={code} className="text-ui text-text-2">{forecastIssue(code ?? '')}</p>)}
        {records.filter(r => r.kind === 'trial_evaluation' && r.parentId === benchmark.id).map(r => <VcrForecastEvaluation key={r.id} record={r} />)}
      </div>
    </Section>}

    {nextOffset != null && <div><Button variant="text" size="sm" loading={busy} onClick={() => { void more(); }}>加载较早版本</Button></div>}
    {(log.length > 0 || providers.length > 0) && <Disclosure summary={`版本记录 · ${log.length + providers.length}`}>
      <ul className="flex flex-col gap-2 text-caption text-text-2">
        {providers.map(provider => <li key={provider.id}>{provider.name} · {provider.version}</li>)}
        {log.map(record => <li key={record.id}>{date(record.createdAt)} · {record.kind === 'history' ? '历史快照' : '预测结果'} · {record.summary.model?.version ?? date(record.summary.origin)}</li>)}
      </ul>
    </Disclosure>}
  </section>;
}
