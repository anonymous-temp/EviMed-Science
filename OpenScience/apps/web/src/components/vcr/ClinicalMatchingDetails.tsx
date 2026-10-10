import { useState } from 'react';
import { CircleCheck, CircleHelp, CircleMinus, CircleX, Clock } from 'lucide-react';
import { knownErrorCodeMessage } from '@evimed/domain';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataColumn } from '@/components/ui/DataTable';
import { Disclosure } from '@/components/ui/Disclosure';
import { Select } from '@/components/ui/Input';
import { Tag } from '@/components/ui/Tag';
import { enqueueVcrMatching, resolveVcrQuote, type VcrClinicalTimelineEntry, type VcrCriterionJudgement, type VcrCriterionState, type VcrMatchingTab, type VcrProtocolChoice } from '@/lib/vcrClient';
import { webErrorMessage } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import { formatDay } from '@/lib/format';
import { ShowMore, useShowMore } from '@/components/ui/ShowMore';
import { ASSERTION_WORDS as assertions, evidenceCaveats, type EvidenceCaveat } from './evidenceCaveats';
import { criterionStateLabel, factValueText } from './vcrText';

const summaries: Record<string, string> = { eligible: '全部满足', ineligible: '有不满足条件', insufficient_evidence: '证据不足', pending: '待复评' };
const experiencers: Record<string, string> = { patient: '本人', family: '家属', other: '他人', unknown: '主体不明' };
const medicationStates: Record<string, string> = { prescribed: '处方', administered: '已给药', stopped: '已停药', planned: '计划用药', historical_list: '历史用药清单', unknown: '用药状态不明' };

/**
 * What came of a request to evaluate, in the reader's words. Nothing queued is said as that, with the reason the server gave for each
 * protocol it could not take — it is not a success with a zero in it (review V-M5).
 */
export function evaluationSentence(answer: { jobs: readonly unknown[]; unavailable: ReadonlyArray<{ code?: string }> }): { text: string; failed: boolean } {
  const unavailable = answer.unavailable ?? [];
  if (answer.jobs.length > 0) {
    return { failed: false, text: `已提交 ${answer.jobs.length} 项评估${unavailable.length ? `，${unavailable.length} 项暂不可用` : ''}。` };
  }
  const reasons = [...new Set(unavailable.map(entry => knownErrorCodeMessage(entry.code ?? '')).filter(Boolean))];
  return { failed: true, text: reasons.length ? `没有提交评估。${reasons.join('')}` : '没有提交评估：所选方案暂不可用。' };
}

/** Queue the evaluation of some protocol versions and keep what was said of it. One at a time; `onQueued` runs when something went in. */
export function useMatchingEvaluation(studyId: string, onQueued: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const evaluate = async (selection: { protocolVersionIds: string[]; subjectKeys?: string[]; direction: string }) => {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const answer = await enqueueVcrMatching(studyId, selection);
      const said = evaluationSentence(answer);
      setMessage(said.text); setFailed(said.failed);
      if (!said.failed) onQueued();
    } catch (error) { setFailed(true); setMessage(webErrorMessage(error, { fallback: '暂时无法开始评估，请重试。' })); }
    finally { setBusy(false); }
  };
  return { busy, message, failed, evaluate };
}

/** What the last press said, under the controls it came from; an alert only when nothing went in. */
export function EvaluationNote({ message, failed }: { message: string; failed: boolean }) {
  if (!message) return null;
  return <p className={failed ? 'text-caption text-error' : 'text-caption text-text-2'} role={failed ? 'alert' : 'status'}>{message}</p>;
}

const STATE_ICON: Record<VcrCriterionState, typeof CircleCheck> = {
  satisfied: CircleCheck,
  not_satisfied: CircleX,
  unknown: CircleHelp,
  pending_recheck: Clock,
};

/**
 * A rule's state for one person — or 「不适用」, which is its own mark and never 未知. Under the mark, what the rule's evidence has been
 * through (denied, since corrected, contradicted): the platform's judgment stays as it is and the row says how far to trust the sentence
 * under it.
 */
export function CriterionState({ row, caveats = [] }: { row: VcrCriterionJudgement; caveats?: readonly EvidenceCaveat[] }) {
  if (row.applicable === false) {
    return (
      <span data-vcr-not-applicable="" className="inline-flex items-center gap-1.5 whitespace-nowrap text-text-3">
        <CircleMinus size={16} aria-hidden="true" />
        不适用
      </span>
    );
  }
  const Icon = STATE_ICON[row.state] ?? CircleHelp;
  const mark = (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap',
      row.state === 'satisfied' ? 'text-ok' : row.state === 'not_satisfied' ? 'text-danger-strong' : 'text-warn-strong')}
    >
      <Icon size={16} aria-hidden="true" />
      {criterionStateLabel(row.state)}
      {/* The state shown is a person's: the platform's own answer is kept beside it. */}
      {row.overridden && <span data-vcr-overridden=""><Tag>人工改判</Tag></span>}
    </span>
  );
  if (caveats.length === 0) return mark;
  return (
    <span className="flex flex-col items-start gap-1">
      {mark}
      <span data-vcr-caveats="" className="flex flex-wrap gap-1">
        {caveats.map((caveat) => <Tag key={caveat.key} tone={caveat.needsChecking ? 'warn' : 'neutral'}>{caveat.label}</Tag>)}
      </span>
    </span>
  );
}

/**
 * The rule-by-rule table of one trial for one person: the trial's own words, the state, the person's own sentence and what to ask for.
 * The study's own protocol and a registry trial a run found read through this one table; `extraColumns` is where a person's hand (改判)
 * is added for the protocol, which is the only trial a person re-judges.
 */
export function CriterionTable({ label, rows, facts, extraColumns = [] }: {
  label: string;
  rows: readonly VcrCriterionJudgement[];
  /** The person's own facts, when the page holds them: the rows are tagged by what has been through them. */
  facts?: readonly VcrClinicalTimelineEntry[];
  extraColumns?: ReadonlyArray<DataColumn<VcrCriterionJudgement>>;
}) {
  const columns: Array<DataColumn<VcrCriterionJudgement>> = [
    { key: 'code', header: '编号', rowHeader: true, width: 'w-16', cell: (row) => <span className="tabular-nums text-text-3">{row.code}</span> },
    { key: 'text', header: '方案原文', cell: (row) => <span className="text-text">{row.text}</span> },
    { key: 'state', header: '状态', width: 'w-24', cell: (row) => <CriterionState row={row} caveats={evidenceCaveats(row.evidence, facts)} /> },
    {
      key: 'evidence',
      header: '患者证据',
      isEmpty: (row) => !row.evidence,
      cell: (row) => row.evidence ? (
        <span className="block">
          <span className="block text-text">{`“${row.evidence.quote}”`}</span>
          <span className="block text-caption text-text-3">{[row.evidence.source, row.evidence.at].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null,
    },
    {
      key: 'request',
      header: '补证建议',
      isEmpty: (row) => !row.request,
      cell: (row) => row.request ? (
        <span className="block">
          <span className="block text-text">{row.request}</span>
          {row.requestNote && <span className="block text-caption text-text-3">{row.requestNote}</span>}
        </span>
      ) : <span className="text-text-3">—</span>,
    },
    ...extraColumns,
  ];
  return (
    <DataTable
      label={label}
      minWidth="min-w-[44rem]"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.code}
      rowAttrs={(row) => ({
        'data-vcr-criterion': row.code,
        'data-vcr-criterion-state': row.applicable === false ? 'not_applicable' : row.state,
      })}
    />
  );
}

/** The most protocol versions one comparison takes: the server refuses more (`vcr_matching_selection_invalid`). */
const MOST_PROTOCOLS = 10;

/**
 * The protocol versions to compare, as a group of checkboxes (review V-M1). A native multiple select needs Ctrl/Cmd-click that
 * nothing mentions, cannot be used by touch, and showed an eleventh choice as chosen while the request carried ten. Here a plain
 * click picks, each row is 44 px high, and at the limit the rest are disabled with the reason in view.
 */
function ProtocolChecklist({ protocols, chosen, onChange }: { protocols: readonly VcrProtocolChoice[]; chosen: readonly string[]; onChange: (next: string[]) => void }) {
  const full = chosen.length >= MOST_PROTOCOLS;
  return <fieldset className="min-w-0">
    <legend className="mb-2 text-ui font-medium text-text">{`选择方案（最多 ${MOST_PROTOCOLS} 项）`}</legend>
    <ul className="flex flex-col">
      {protocols.map(protocol => {
        const checked = chosen.includes(protocol.id);
        const locked = full && !checked;
        return <li key={protocol.id}>
          <label className={cn('flex min-h-form-primary items-center gap-3 rounded px-2 text-ui', locked ? 'cursor-not-allowed text-text-3' : 'cursor-pointer text-text hover:bg-surface-2')}>
            <input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={checked} disabled={locked}
              onChange={event => onChange(event.target.checked ? [...chosen, protocol.id] : chosen.filter(id => id !== protocol.id))} />
            <span className="min-w-0">{protocol.title || `方案版本 ${protocol.version}`}</span>
          </label>
        </li>;
      })}
    </ul>
    <p className="mt-2 text-caption text-text-3" aria-live="polite">{full ? `已选 ${chosen.length} 项，已到上限；取消一项后才能再选。` : `已选 ${chosen.length} 项`}</p>
  </fieldset>;
}

export function MatchingPanelControls({ studyId, data, direction, protocolId, subjectKey, settling = false, canRun, onProtocol, onCandidate, onReload }: {
  studyId: string; data: VcrMatchingTab;
  /** The direction the reader chose: `data` may still be the page of the one before. */
  direction?: NonNullable<VcrMatchingTab['direction']>;
  /** The protocol the reader chose, once they have: the select shows it at once, before its page has arrived. */
  protocolId?: string | null;
  /**
   * The patient the page is about, when the page — not these controls — keeps it (给患者找试验): the select shows it, and choosing
   * 请选择患者 again says so through `onCandidate('')`. Left out, the select keeps the choice itself.
   */
  subjectKey?: string | null;
  /** The page for what the reader chose is still being read (or could not be): the controls stay, and a run waits for it. */
  settling?: boolean;
  canRun: boolean; onProtocol: (id: string) => void; onCandidate: (id: string) => void; onReload: () => void;
}) {
  const [panel, setPanel] = useState<string[]>([]);
  const [ownSubject, setSubject] = useState('');
  const evaluation = useMatchingEvaluation(studyId, onReload);
  const protocols = data.protocols ?? [];
  const way = direction ?? data.direction ?? 'trial_to_patient';
  const roster = data.candidateRoster ?? [];
  // A patient's trials do not wait on a protocol: the patient to start from is chosen here whether or not the study has one.
  if (!protocols.length && !(way === 'patient_to_trial' && roster.length)) return null;
  const subject = subjectKey !== undefined ? subjectKey ?? '' : ownSubject;
  const viewing = protocolId ?? data.protocolVersionId ?? protocols[0]?.id ?? '';
  const scope = subject ? { subjectKeys: [subject] } : {};
  // 给患者找试验 starts from a person: nothing is asked of the engine until one is chosen.
  const needsPatient = way === 'patient_to_trial' && !subject;
  const name = (protocol: typeof protocols[number]) => protocol.title || `方案版本 ${protocol.version}`;
  return <div className="flex flex-col gap-3">
    {data.candidateCoverage && <p className="text-caption text-text-2" role="status">
      {`本次选择 ${data.candidateCoverage.requested} 人 · 已评估 ${data.candidateCoverage.evaluated} 人 · 待评估 ${data.candidateCoverage.pending} 人 · 暂不可用 ${data.candidateCoverage.unavailable} 人`}
    </p>}
    <div className="flex flex-wrap items-end gap-3">
      {protocols.length > 0 && <div className="w-full min-w-0 sm:w-64">
        <Select label="查看方案" value={viewing} onChange={event => onProtocol(event.target.value)}>
          {protocols.map(protocol => <option key={protocol.id} value={protocol.id}>{name(protocol)}</option>)}
        </Select>
      </div>}
      <div className="w-full min-w-0 sm:w-64">
        <Select label="患者" value={subject} onChange={event => {
          const chosen = event.target.value;
          setSubject(chosen);
          // Where the page keeps the patient, choosing the placeholder again is a choice too: nobody.
          if (chosen || subjectKey !== undefined) onCandidate(chosen);
        }}>
          <option value="">{way === 'patient_to_trial' ? '请选择患者' : '全部已登记患者'}</option>
          {roster.map(key => <option key={key} value={key}>{key}</option>)}
        </Select>
      </div>
      {/* The view's main action is the contact confirmation below; starting an evaluation is the quieter one next to the protocol it is for. */}
      {canRun && protocols.length > 0 && <Button variant="secondary" loading={evaluation.busy} disabled={evaluation.busy || settling || needsPatient}
        onClick={() => void evaluation.evaluate({ protocolVersionIds: [viewing], direction: way, ...scope })}>开始评估</Button>}
      <Button variant="text" onClick={onReload}>刷新结果</Button>
    </div>
    <EvaluationNote message={evaluation.message} failed={evaluation.failed} />
    {protocols.length > 0 && <Disclosure summary="比较多个方案">
      <div className="grid gap-3 md:grid-cols-2">
        <ProtocolChecklist protocols={protocols} chosen={panel} onChange={setPanel} />
        <div className="flex flex-wrap items-start gap-2">
          {canRun && <Button loading={evaluation.busy} disabled={evaluation.busy || settling || !panel.length || needsPatient}
            onClick={() => void evaluation.evaluate({ protocolVersionIds: panel, direction: way, ...scope })}>开始评估所选方案</Button>}
        </div>
        {(data.comparisons ?? []).length > 0 && <ul className="divide-y divide-faint md:col-span-2">
          {data.comparisons?.map(entry => <li key={entry.protocol.id} className="py-2 text-ui text-text">
            {name(entry.protocol)} · {entry.summary ? summaries[entry.summary] ?? '待核对' : '尚未评估'}
            {entry.evidenceGaps.length > 0 && <span className="ml-2 text-caption text-text-3">{`${entry.evidenceGaps.length} 项证据缺口`}</span>}
          </li>)}
        </ul>}
      </div>
    </Disclosure>}
  </div>;
}

/** How many facts the timeline draws before the reader asks for more: a patient's chart can run to hundreds. */
const FACTS_SHOWN = 20;

export function ClinicalTimeline({ studyId, data, mayReadOriginal, subject }: {
  studyId: string; data: VcrMatchingTab; mayReadOriginal: boolean;
  /** Whose records these are: the person the page is about. The fold names them, so a reader never wonders whose facts they are reading. */
  subject?: string | null;
}) {
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A refusal is said on the fact whose original was asked for, not under the whole list.
  const [problems, setProblems] = useState<Record<string, string>>({});
  const entries = data.timeline ?? [];
  const shown = useShowMore(entries, { first: FACTS_SHOWN, step: FACTS_SHOWN, resetKey: subject ?? '' });
  if (!entries.length) return null;
  const reveal = async (entry: typeof entries[number]) => {
    if (!entry.locator || !entry.quote) return;
    setBusy(entry.id); setProblems(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== entry.id)));
    try {
      const answer = await resolveVcrQuote(studyId, entry.locator.documentId, { start: entry.locator.start, end: entry.locator.end, quote: entry.quote });
      setOriginals(previous => ({ ...previous, [entry.id]: answer.evidence.quote }));
    } catch (error) { setProblems(previous => ({ ...previous, [entry.id]: webErrorMessage(error, { fallback: '原文暂时无法打开，请重试。' }) })); }
    finally { setBusy(null); }
  };
  return <Disclosure summary={subject ? `${subject} 的临床记录与更正` : '临床记录与更正'}>
    <ol className="divide-y divide-faint">
      {shown.visible.map(entry => <li key={entry.id} className="flex flex-col gap-2 py-3">
        <p className="text-caption text-text-3">{[formatDay(entry.at) || '日期未记载', assertions[entry.assertion] ?? '未知',
          entry.experiencer ? experiencers[entry.experiencer] : null, entry.medicationState ? medicationStates[entry.medicationState] : null,
          entry.correctionOf ? '更正记录' : null, entry.superseded ? '已有更正' : null, entry.conflictFactIds?.length ? '记录有冲突' : null].filter(Boolean).join(' · ')}</p>
        <p className="text-ui text-text">{entry.quote ?? `${entry.variable}：${factValueText(entry.value)}${entry.unit ? ` ${entry.unit}` : ''}`}</p>
        {entry.correctionReason && <p className="text-caption text-text-2">{entry.correctionReason}</p>}
        {/* The original can be read wherever the fact cites a span of it; whether the server can open that span is the server's answer, said right here. */}
        {mayReadOriginal && entry.locator && entry.quote && <Button variant="text" size="sm" loading={busy === entry.id} disabled={busy !== null} onClick={() => void reveal(entry)}>查看对应原文</Button>}
        {originals[entry.id] && <blockquote className="whitespace-pre-wrap text-ui text-text-2">{originals[entry.id]}</blockquote>}
        {problems[entry.id] && <p role="alert" className="text-caption text-error">{problems[entry.id]}</p>}
      </li>)}
    </ol>
    <ShowMore remaining={shown.remaining} unit="条" onMore={shown.more} />
  </Disclosure>;
}
