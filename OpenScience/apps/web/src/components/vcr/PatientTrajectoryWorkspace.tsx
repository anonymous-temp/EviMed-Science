import { useMemo, useState } from 'react';
import { Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataColumn } from '@/components/ui/DataTable';
import { Disclosure } from '@/components/ui/Disclosure';
import { FactList } from '@/components/ui/FactList';
import { Note, type NoteNumber, type NoteResult } from '@/components/ui/Note';
import { Section } from '@/components/ui/Section';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { ChartCard } from '@/components/ui/ChartCard';
import { EmptyState } from '@/components/cards/EmptyState';
import type { ToolbarChips } from '@/components/ui/Toolbar';
import { getVcrTrajectorySubjects, type LongitudinalRecord, type TrajectoryStatus, type TrajectorySubjectLine, type VcrLongitudinalData } from '@/lib/vcrLongitudinalClient';
import type { VcrSeries } from '@/lib/vcrClient';
import { VcrTrajectoryChart } from './VcrCharts';
import { VcrPremises } from './VcrPremises';
import { VcrLongitudinalPanel } from './VcrLongitudinalPanel';
import { forecastIssue } from './VcrForecastEvaluation';
import { useVcrLoad, VcrTabError } from './vcrTabKit';

/**
 * 患者轨迹预测 — the result surface of a batch forecast inside a study (plan T08, A05/A06/A12/A13).
 *
 * Anatomy, top to bottom: the denominator line (everyone who was submitted and where each of them ended up: completed, rejected,
 * failed, not yet processed — the four add up to the submitted, and the line says so); the one 「这个结论的前提」 block; the cohort
 * summary; a filterable table of people, a page of 50 at a time from the server (a batch of thousands is never drawn whole); one
 * person's timeline; and, folded, the input history, the prediction versions, the comparison with what was observed afterwards and
 * the imports (`VcrLongitudinalPanel`, which owns them and the toolbar).
 *
 * Rules the page keeps:
 * - A draw is a sample of one person's future, never a person: the counts are people, and the draws are said once, beside them.
 * - Three things a reader might read as one stay apart: the spread between patients (the cohort band), the interval the model
 *   itself gives, and the Monte Carlo draws. The table and the timeline name which one a person's uncertainty is, or say the model
 *   gave none; nothing is drawn for what was not given.
 * - A forecast under logged actions is told apart from a deployable one (the premises block says it; the heading changes).
 * - Table rows are the server's page; a server without the route (404) leaves the counts and the cohort summary, which come from the
 *   prediction's own summary.
 */
const STATUS_LABEL: Record<TrajectoryStatus, string> = { completed: '已完成', rejected: '未纳入', failed: '失败', unprocessed: '未处理' };
const STATUS_TONE: Record<TrajectoryStatus, TagTone> = { completed: 'neutral', rejected: 'warn', failed: 'warn', unprocessed: 'neutral' };
const REASON: Record<string, string> = {
  unit_not_convertible: '观测的单位无法换算成终点的单位', action_input_missing: '缺少这个模型需要的用药信息', action_unit_not_convertible: '用药剂量的单位无法换算',
  no_forecast_returned: '模型没有给出这位患者的预测', unit_mismatch: '返回的预测单位与终点不一致', point_out_of_range: '返回的预测值超出可能的范围',
  duplicate_forecast: '同一时间点返回了重复的预测', subject_not_in_history: '返回的受试者不在这批资料里', canceled: '预测已停止，可以继续', not_reached: '还没有轮到',
  forecast_time_budget: '本次预测时间已用完，可以继续', forecast_cost_budget: '本次预测预算已用完，可以继续', provider_configuration_changed: '预测服务配置发生变化',
};
const reasonText = (code: string | null) => !code ? '—' : REASON[code] ?? (code.startsWith('provider_http_') ? '预测服务暂时不可用' : forecastIssue(code));
const KIND: Record<string, string> = { parameter: '模型参数的不确定性', structural: '模型结构的不确定性', monte_carlo: '蒙特卡罗抽样', predictive: '模型给出的预测区间', unnamed: '来源未说明' };
const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';
const PAGE = 50;

/** The sentence that says where the whole batch went; the four numbers after the colon add up to the first. */
export function trajectoryDenominator(counts: NonNullable<LongitudinalRecord['summary']['accounting']>): string {
  const rest = [`${counts.completed} 人已完成`, `${counts.rejected} 人未纳入`, `${counts.failed} 人失败`, `${counts.unprocessed} 人未处理`];
  return `共提交 ${counts.submitted} 人：${rest.join('，')}。`;
}

/** The denominator as a sentence whose numbers each open the people they count. */
function denominatorParts(counts: NonNullable<LongitudinalRecord['summary']['accounting']>, open: (status: 'all' | TrajectoryStatus) => void): NoteResult {
  const part = (n: number, status: 'all' | TrajectoryStatus): NoteNumber => ({ n, onOpen: () => open(status) });
  return ['共提交 ', part(counts.submitted, 'all'), ' 人：', part(counts.completed, 'completed'), ' 人已完成，', part(counts.rejected, 'rejected'), ' 人未纳入，',
    part(counts.failed, 'failed'), ' 人失败，', part(counts.unprocessed, 'unprocessed'), ' 人未处理。'];
}

/** What this person's uncertainty is, in one phrase; never a number nobody gave. */
export function personUncertainty(line: TrajectorySubjectLine): string {
  if (line.status !== 'completed') return '—';
  const u = line.uncertainty;
  if (!u?.available) return '模型没有给出';
  return Object.keys(u.kinds).map(kind => KIND[kind] ?? kind).join('、');
}

export function PatientTrajectoryWorkspace({ studyId, canRun, canManage = false, data, onReload, switcher }: {
  studyId: string; canRun: boolean; canManage?: boolean; data: VcrLongitudinalData; onReload: () => void; switcher?: ToolbarChips | null;
}) {
  const records = useMemo(() => [...new Map([...data.records, ...(data.related ?? [])].map(record => [record.id, record])).values()], [data]);
  const predictions = useMemo(() => records.filter(record => record.kind === 'prediction')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || b.id.localeCompare(a.id)), [records]);
  const [chosen, setChosen] = useState('');
  const [status, setStatus] = useState<'all' | TrajectoryStatus>('all');
  const [offset, setOffset] = useState(0);
  const [person, setPerson] = useState('');
  const selected = predictions.find(record => record.id === chosen) ?? predictions[0];
  const summary = selected?.summary;
  const counts = summary?.accounting;
  const page = useVcrLoad(`${studyId}:trajectory:${selected?.id ?? 'none'}:${status}:${offset}`,
    () => selected ? getVcrTrajectorySubjects(studyId, selected.id, { status: status === 'all' ? undefined : status, offset, limit: PAGE }) : Promise.resolve(null));
  const lines = page.state.kind === 'ready' ? page.state.data?.lines ?? [] : page.last?.lines ?? [];
  const shown = page.state.kind === 'ready' ? page.state.data : page.last;
  const timeline = person ? shown?.trajectories?.[person] : undefined;
  const series: VcrSeries[] = timeline?.length ? [{ key: person, label: '模型预测', source: 'predicted', ours: true,
    points: timeline.map(p => ({ x: p.horizonDays, y: p.point,
      low: p.quantiles.length ? p.quantiles[0]?.value ?? null : null, high: p.quantiles.length ? p.quantiles[p.quantiles.length - 1]?.value ?? null : null })) }] : [];

  const columns: Array<DataColumn<TrajectorySubjectLine>> = [
    { key: 'subject', header: '受试者', rowHeader: true, cell: line => <Button variant="text" size="sm" aria-label={`查看受试者 ${line.subjectKey.slice(0, 8)} 的轨迹`} onClick={() => setPerson(line.subjectKey)}>{line.subjectKey.slice(0, 8)}</Button> },
    { key: 'status', header: '状态', cell: line => <Tag tone={STATUS_TONE[line.status]}>{STATUS_LABEL[line.status]}{line.partial ? '（部分时间点）' : ''}</Tag> },
    { key: 'reason', header: '原因', cell: line => reasonText(line.reason), isEmpty: line => !line.reason },
    { key: 'points', header: '预测时间点', align: 'right', cell: line => `${line.horizonsAccepted} / ${line.horizonsRequested}` },
    { key: 'uncertainty', header: '不确定性', cell: line => personUncertainty(line) },
  ];

  const statusChips: ToolbarChips = { kind: 'chips', label: '状态', value: status, neutral: 'all', onChange: value => { setStatus(value as 'all' | TrajectoryStatus); setOffset(0); setPerson(''); },
    options: [{ value: 'all', label: '全部', ...(counts ? { count: counts.submitted } : {}) },
      ...(['completed', 'rejected', 'failed', 'unprocessed'] as const).map(value => ({ value, label: STATUS_LABEL[value], ...(counts ? { count: counts[value] } : {}) }))] };
  if (!selected) return <VcrLongitudinalPanel studyId={studyId} canRun={canRun} canManage={canManage} data={data} onReload={onReload} switcher={switcher} />;
  const replay = summary?.actionContext?.label === 'logged_action_replay';
  const draws = summary?.uncertainty?.drawsTotal ?? 0;
  return <section className="flex flex-col gap-6" aria-label="患者轨迹预测">
    {predictions.length > 1 && <Select label="预测版本" value={selected.id} onChange={event => { setChosen(event.target.value); setOffset(0); setPerson(''); }}>
      {predictions.map(record => <option key={record.id} value={record.id}>第 {record.summary.versionNumber ?? 1} 版 · {record.summary.endpoint?.code} · {record.summary.origin?.slice(0, 10)} · {record.summary.model?.version ?? '版本未提供'}</option>)}
    </Select>}

    <div className="flex flex-col gap-2">
      <h2 className="text-section font-semibold text-text">{replay ? '按实际用药回放的检验' : '每位患者的预测轨迹'}</h2>
      {counts
        ? <Note result={denominatorParts(counts, value => { setStatus(value); setOffset(0); setPerson(''); })} />
        : <Note result={['这个预测来自早期导入，没有逐人的去向记录；可用的预测 ', { n: summary?.accepted ?? 0 }, ' 条。']} />}
      {counts && counts.submitted !== counts.completed + counts.rejected + counts.failed + counts.unprocessed
        && <Note tone="warn" action={<Button size="sm" variant="secondary" onClick={onReload}>刷新</Button>}>各部分人数与提交人数对不上；刷新后仍对不上，请在研究对话中说明这批预测。</Note>}
      {counts && counts.unprocessed > 0 && <Note result={['还有 ', { n: counts.unprocessed, onOpen: () => { setStatus('unprocessed'); setOffset(0); setPerson(''); } },
        ' 人没有处理（预测被停止或预算用完）；已完成的结果已保留，重新开始同一预测会接着做，不会重复计费。']} />}
      {draws > 0 && <Note result={['模型对每位患者给出了多次抽样，共 ', { n: draws }, ' 条；它们是同一个人未来的不同可能，不当作更多的人。']} />}
      {counts && counts.partial > 0 && <Note result={['其中 ', { n: counts.partial }, ' 人只有部分时间点有预测，已计入“已完成”。']} />}
    </div>

    <VcrPremises premises={summary?.premises} />

    {(summary?.trajectories?.length ?? 0) > 0 && <Section title="整批人群的汇总" level="sub">
      <DataTable label="按预测时间的人群汇总" rows={(summary?.trajectories ?? []).map(p => ({ ...p, key: String(p.day) }))} rowKey={p => p.key}
        footnote={`均值是已完成患者的平均；“患者之间的差异”是 10%–90% 分位，不是模型对预测本身的不确定性。${summary?.uncertainty?.available
          ? `模型给出的不确定性：${Object.entries(summary.uncertainty.kinds).map(([kind, n]) => `${KIND[kind] ?? kind} ${n} 条`).join('，')}。`
          : '这个模型没有给出不确定性，所以没有预测区间。'}`}
        columns={[
          { key: 'day', header: '距起点（天）', rowHeader: true, cell: p => number(p.day) },
          { key: 'subjects', header: '人数', align: 'right', cell: p => p.subjects == null ? '小样本未展示' : number(p.subjects) },
          { key: 'mean', header: `均值${summary?.endpoint?.unit ? `（${summary.endpoint.unit}）` : ''}`, align: 'right', cell: p => number(p.mean) },
          { key: 'spread', header: '患者之间的差异', cell: p => p.lower == null || p.upper == null ? '—' : `${number(p.lower)} – ${number(p.upper)}` },
        ]} />
    </Section>}

    <Section title="逐人去向" level="sub" count={shown?.matching ?? counts?.submitted}>
      <div className="flex flex-col gap-3">
        {page.state.kind === 'error' && !shown
          ? (page.state.missing || page.state.off
            ? <Note action={<Button size="sm" variant="secondary" onClick={page.reload}>重试</Button>}>逐人的列表暂时无法读取；上面的人数和汇总仍然有效。</Note>
            : <VcrTabError message={page.state.message} onRetry={page.reload} />)
          : <DataTable label="逐人预测去向" rows={lines} rowKey={line => line.subjectKey} columns={columns} state={page.state.kind === 'loading' && !shown ? 'loading' : 'content'}
            emptyText="没有符合这个状态的人。" highlight={line => line.subjectKey === person}
            footnote={shown ? `第 ${shown.offset + 1}–${shown.offset + lines.length} 人，共 ${shown.matching} 人` : undefined} />}
        {shown && (shown.more || shown.offset > 0) && <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={shown.offset === 0} onClick={() => setOffset(Math.max(0, shown.offset - PAGE))}>上一页</Button>
          <Button variant="secondary" size="sm" disabled={!shown.more} onClick={() => setOffset(shown.offset + PAGE)}>下一页</Button>
        </div>}
      </div>
    </Section>

    {person && <Section title={`受试者 ${person.slice(0, 8)} 的时间线`} level="sub">
      {series.length
        ? <ChartCard title="随预测时间变化的结果"><VcrTrajectoryChart xLabel="距预测起点（天）" yLabel={summary?.endpoint?.unit} series={series} /></ChartCard>
        : <Note action={<Button size="sm" variant="secondary" onClick={() => setPerson('')}>关闭</Button>}>这位患者没有可显示的预测，原因见上表。</Note>}
      {timeline?.length ? <FactList rows={[{ label: '这位患者的不确定性', value: timeline.some(p => p.sd != null || p.quantiles.length || p.draws)
        ? `${timeline.some(p => p.quantiles.length) ? '模型给出了预测区间；' : ''}${timeline.some(p => p.draws) ? `含 ${Math.max(...timeline.map(p => p.draws))} 次抽样；` : ''}区间的来源以模型的说明为准。`
        : '模型没有给出，所以没有画预测区间。' }]} /> : null}
    </Section>}

    <Disclosure summary="输入历史、预测版本与验证">
      <VcrLongitudinalPanel studyId={studyId} canRun={canRun} canManage={canManage} data={data} onReload={onReload} switcher={switcher} extraFilters={[statusChips]} />
    </Disclosure>
  </section>;
}

/** An empty entrance: nothing submitted yet. The surface says what a batch needs, in one sentence, and the question box is the page's. */
export function PatientTrajectoryEmpty() {
  return <EmptyState title="还没有批量预测" description="给出一批患者的带时间的观测记录（比如 100 位患者），就能得到每位患者的预测轨迹和整批人群的汇总；每个人的去向都会列出来。" />;
}
