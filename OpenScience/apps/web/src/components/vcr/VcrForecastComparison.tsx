import { VcrForecastComparisonResult } from "./VcrForecastComparisonResult";
import { useEffect, useState } from 'react';
import { workStateLabel } from '@evimed/domain';
import { Button } from '@/components/ui/Button';
import { Note } from '@/components/ui/Note';
import { Select } from '@/components/ui/Input';
import { Disclosure } from '@/components/ui/Disclosure';
import { queueVcrJob, getVcrJob } from '@/lib/vcrClient';
import { webErrorMessage } from '@/lib/apiClient';
import type { LongitudinalRecord } from '@/lib/vcrLongitudinalClient';
import { useStudyFrame } from './studyFrameContext';
import { COMPARE_START_LABEL } from './vcrActionWords';

const modes: Record<string, string> = { scenario: '治疗情景', input_sensitivity: '输入敏感性', model_version: '模型版本', update: '新增观测后的更新' };
const date = (value?: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '未记录';

/**
 * Two predictions of one endpoint, compared by an engine job the reader starts (开始比较). A job past the study's compute budget is
 * not a failure: it waits for the lead to confirm the budget (`awaiting_budget`), and the page says so and opens the budget panel —
 * it offers no retry, because a retry would queue a second job behind the one that is waiting.
 */
export function VcrForecastComparison({ studyId, selected, records, canRun, canManage = false, onComplete }: {
  studyId: string; selected: LongitudinalRecord; records: LongitudinalRecord[]; canRun: boolean;
  /** The reader may confirm the compute budget (`manage_study`, the lead's). */
  canManage?: boolean; onComplete: () => void;
}) {
  const frame = useStudyFrame();
  const [awaitingBudget, setAwaitingBudget] = useState(false);
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
        else if (job.state === 'awaiting_budget') { setJobId(''); setBusy(false); setError(false); setMessage(''); setAwaitingBudget(true); }
        else if (['failed', 'canceled'].includes(job.state)) {
          setJobId(''); setBusy(false); setError(true); setMessage(job.error?.message ?? '本次比较未完成，可在研究对话中查看原因或重试。');
        } else timer = setTimeout(() => { void poll(); }, 1200);
      } catch (cause) {
        if (active) { setBusy(false); setJobId(''); setError(true); setMessage(webErrorMessage(cause, { fallback: '比较状态未能读取，请刷新结果。' })); }
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId, studyId, onComplete]);
  // The comparison that was waiting for the budget has arrived: the wait is over.
  const arrived = comparisons.length;
  useEffect(() => { setAwaitingBudget(false); }, [arrived]);
  async function compare() {
    if (!other) return;
    setBusy(true); setError(false); setMessage('正在比较相同受试者的预测。');
    try {
      // An update (a later origin) is also read against what was observed afterwards, when a later history holds it.
      const chosen = mode || inferredMode;
      const latest = Math.max(Date.parse(selected.summary.origin ?? ''), Date.parse(other.summary.origin ?? ''));
      const outcome = chosen === 'update' ? records.filter(r => r.kind === 'history' && Date.parse(r.summary.origin ?? '') > latest)
        .sort((a, b) => Date.parse(b.summary.origin ?? '') - Date.parse(a.summary.origin ?? ''))[0] : undefined;
      const job = await queueVcrJob(studyId, { kind: 'compare_forecasts', scenario: { predictionId: selected.id, otherPredictionId: other.id, mode: chosen, ...(outcome ? { outcomeHistoryId: outcome.id } : {}) } });
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
        <div><Button variant="secondary" size="sm" actionKind="start" loading={busy} disabled={busy || awaitingBudget} onClick={() => { void compare(); }}>{COMPARE_START_LABEL}</Button></div>
      </>}
      {!other && !comparisons.length && <p className="text-caption text-text-2">同一终点有两个预测版本后，可以比较治疗情景、输入变化或新增观测后的结果。</p>}
      {awaitingBudget && (
        <Note tone="warn" action={canManage && frame ? <Button size="sm" variant="secondary" actionKind="set" onClick={() => frame.openPanel('budget')}>确认预算</Button> : undefined}>
          {`${workStateLabel('waiting', '确认预算')}：这次比较超出了研究的计算预算，确认后会自动开始。`}
        </Note>
      )}
      {message && <p role={error ? 'alert' : 'status'} className={error ? 'text-caption text-error' : 'text-caption text-text-2'}>{message}</p>}
      {comparisons.map(record => <VcrForecastComparisonResult key={record.id} record={record} records={records} />)}
    </div>
  </Disclosure>;
}
