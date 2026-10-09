import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Disclosure } from '@/components/ui/Disclosure';
import { Select } from '@/components/ui/Input';
import { enqueueVcrMatching, resolveVcrQuote, type VcrMatchingTab } from '@/lib/vcrClient';
import { webErrorMessage } from '@/lib/apiClient';

const summaries: Record<string, string> = { eligible: '全部满足', ineligible: '有不满足条件', insufficient_evidence: '证据不足', pending: '待复评' };
const assertions: Record<string, string> = { affirmed: '已记录', negated: '已否认', possible: '疑似', hypothetical: '假设', conditional: '有条件', unknown: '未知', family: '家族史' };
const experiencers: Record<string, string> = { patient: '本人', family: '家属', other: '他人', unknown: '主体不明' };
const medicationStates: Record<string, string> = { prescribed: '处方', administered: '已给药', stopped: '已停药', planned: '计划用药', historical_list: '历史用药清单', unknown: '用药状态不明' };

export function MatchingPanelControls({ studyId, data, canRun, onProtocol, onCandidate, onReload }: {
  studyId: string; data: VcrMatchingTab; canRun: boolean; onProtocol: (id: string) => void; onCandidate: (id: string) => void; onReload: () => void;
}) {
  const [panel, setPanel] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const protocols = data.protocols ?? [];
  if (!protocols.length) return null;
  const run = async () => {
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const answer = await enqueueVcrMatching(studyId, { protocolVersionIds: panel, direction: data.direction ?? 'trial_to_patient',
        ...(subject ? { subjectKeys: [subject] } : {}) });
      setMessage(`已提交 ${answer.jobs.length} 项评估${answer.unavailable.length ? `，${answer.unavailable.length} 项暂不可用` : ''}。`);
      setFailed(answer.jobs.length === 0); onReload();
    } catch (error) { setFailed(true); setMessage(webErrorMessage(error, { fallback: '暂时无法开始评估，请重试。' })); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-3">
    {data.candidateCoverage && <p className="text-caption text-text-2" role="status">
      {`本次选择 ${data.candidateCoverage.requested} 人 · 已评估 ${data.candidateCoverage.evaluated} 人 · 待评估 ${data.candidateCoverage.pending} 人 · 暂不可用 ${data.candidateCoverage.unavailable} 人`}
    </p>}
    <Select label="查看方案" value={data.protocolVersionId ?? ''} onChange={event => onProtocol(event.target.value)}>
      {protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.title || `方案版本 ${protocol.version}`}</option>)}
    </Select>
    <Disclosure summary="比较多个方案">
      <div className="grid gap-3 md:grid-cols-2">
        <Select label="选择方案（最多 10 项）" multiple className="h-auto min-h-control-primary" value={panel} onChange={event => setPanel(Array.from(event.target.selectedOptions).map(option => option.value).slice(0, 10))}>
          {protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{protocol.title || `方案版本 ${protocol.version}`}</option>)}
        </Select>
        <Select label="受试者" value={subject} onChange={event => { setSubject(event.target.value); if (event.target.value) onCandidate(event.target.value); }}>
          <option value="">{data.direction === 'patient_to_trial' ? '请选择受试者' : '全部已登记受试者'}</option>
          {(data.candidateRoster ?? []).map(key => <option key={key} value={key}>{key}</option>)}
        </Select>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          {canRun && <Button loading={busy} disabled={busy || !panel.length || data.direction === 'patient_to_trial' && !subject} onClick={() => void run()}>开始评估所选方案</Button>}
          <Button variant="secondary" onClick={onReload}>刷新结果</Button>
        </div>
        {message && <p className="text-caption text-text-2 md:col-span-2" role={failed ? 'alert' : 'status'}>{message}</p>}
        {(data.comparisons ?? []).length > 0 && <ul className="divide-y divide-faint md:col-span-2">
          {data.comparisons?.map(entry => <li key={entry.protocol.id} className="py-2 text-ui text-text">
            {entry.protocol.title || `方案版本 ${entry.protocol.version}`} · {entry.summary ? summaries[entry.summary] ?? '待核对' : '尚未评估'}
            {entry.evidenceGaps.length > 0 && <span className="ml-2 text-caption text-text-3">{`${entry.evidenceGaps.length} 项证据缺口`}</span>}
          </li>)}
        </ul>}
      </div>
    </Disclosure>
  </div>;
}

export function ClinicalTimeline({ studyId, data, mayReadOriginal }: { studyId: string; data: VcrMatchingTab; mayReadOriginal: boolean }) {
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const entries = data.timeline ?? [];
  if (!entries.length) return null;
  const reveal = async (entry: typeof entries[number]) => {
    if (!entry.locator || !entry.quote) return;
    setBusy(entry.id); setProblem('');
    try {
      const answer = await resolveVcrQuote(studyId, entry.locator.documentId, { start: entry.locator.start, end: entry.locator.end, quote: entry.quote });
      setOriginals(previous => ({ ...previous, [entry.id]: answer.evidence.quote }));
    } catch (error) { setProblem(webErrorMessage(error, { fallback: '原文暂时无法打开，请重试。' })); }
    finally { setBusy(null); }
  };
  return <Disclosure summary="临床记录与更正">
    <ol className="divide-y divide-faint">
      {entries.map(entry => <li key={entry.id} className="flex flex-col gap-2 py-3">
        <p className="text-caption text-text-3">{[entry.at?.slice(0, 10) ?? '日期未记载', assertions[entry.assertion] ?? '未知',
          entry.experiencer ? experiencers[entry.experiencer] : null, entry.medicationState ? medicationStates[entry.medicationState] : null,
          entry.correctionOf ? '更正记录' : null, entry.superseded ? '已有更正' : null, entry.conflictFactIds?.length ? '记录有冲突' : null].filter(Boolean).join(' · ')}</p>
        <p className="text-ui text-text">{entry.quote ?? `${entry.variable}：${String(entry.value ?? '未知')}${entry.unit ? ` ${entry.unit}` : ''}`}</p>
        {entry.correctionReason && <p className="text-caption text-text-2">{entry.correctionReason}</p>}
        {mayReadOriginal && entry.locator?.documentId.startsWith('prj_') && <Button variant="text" size="sm" loading={busy === entry.id} disabled={busy !== null} onClick={() => void reveal(entry)}>查看对应原文</Button>}
        {originals[entry.id] && <blockquote className="whitespace-pre-wrap text-ui text-text-2">{originals[entry.id]}</blockquote>}
      </li>)}
    </ol>
    {problem && <p role="alert" className="text-caption text-error">{problem}</p>}
  </Disclosure>;
}
