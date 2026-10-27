import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { GEO_SIGNAL_STATE_LABELS_ZH } from '@evimed/domain';
import { getGeoProject, stageGeoPlanContext, type GeoProject } from '@/lib/geoClient';
import { getGeoSignal, listGeoSignals, setGeoSignalDisposition, getGeoSignalRunRecord, geoSignalResultHref, type GeoSignal, type GeoSignalDetail, type GeoSignalPage, type GeoSignalState, type GeoSignalAttempt } from '@/lib/geoSignalsClient';
import { webErrorMessage } from '@/lib/apiClient';
import type { ProgrammeRun } from '@/lib/programmeRuns';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Input';
import { Section } from '@/components/ui/Section';
import { List, ListRow } from '@/components/ui/ListRow';
import { Tag } from '@/components/ui/Tag';
import { Note } from '@/components/ui/Note';
import { LoadError } from '@/components/cards/LoadError';
import { ProgrammeRunsDrawer } from '@/components/runs/ProgrammeRunsDrawer';
import { ensureGeoConversationSession } from './geoConversationSession';
import { useOpenGeoConversation } from './useOpenGeoConversation';
import { useGeoDestinationPath } from './useGeoPath';
import { GeoGroupMembers } from './GeoGroupMembers';
import { engineName, poolName } from './geoText';
import { metricName } from './tabs/geoTabText';

const kinds: Record<GeoSignal['kind'], string> = { error_observed: '医学说法待核查', source_changed: '资料变化', citation_observed: '新增引用页面', group_changed: '问题群变化', order_anomaly: '投放异常' };
const outcomes: Record<string, string> = { open: '问题仍待处理', acting: '已开展处理', awaiting_remeasure: '等待后续观察', closed: '后续观察支持已消失', withdrawn: '原判断已撤回', unreviewed: '受影响版本仍需核查', partial: '部分版本仍待处理', handled: '本次版本均有核查结果', observed: '已观察到', unknown: '当前业务结果未确认', cancelled: '订单已取消', refunded: '订单已退款', published: '已发布', verified: '已核对发布', settled: '已结算', problem: '订单需要处理', rejected: '订单被拒绝', lost: '订单未能追回' };
const reviewWords = { unhandled: '尚未核查', no_change_needed: '核查认为无需修改', update_proposed: '已提出修改，更新未确认', updated: '已关联更新版本', uncertain: '仍待核实' };
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '时间未记录';
const stateWord = (row: GeoSignal) => `${GEO_SIGNAL_STATE_LABELS_ZH[row.state]}${row.state === 'ignored' && row.executionState === 'processing' ? ' · AI 仍在处理' : ''}`;
const cleanSignal = (path: string) => { const url = new URL(path, 'https://evimed.invalid'); url.searchParams.delete('signal'); url.searchParams.delete('signals'); return `${url.pathname}${url.search}${url.hash}`; };
const runOf = (attempt: GeoSignalAttempt, label: string): ProgrammeRun => ({ runId: attempt.runId ?? undefined, sessionId: attempt.sessionId, label,
  state: ['running', 'queued', 'starting'].includes(attempt.status ?? '') ? 'running' : attempt.status === 'succeeded' ? 'finished' : 'stopped', at: time(attempt.startedAt) });

/** One current-work projection across overview and step pages; the URL addresses detail and preserves back/refresh. */
export function GeoSignalsWorkbench({ geoId, project, step }: { geoId: string; project: GeoProject; step?: string | null }) {
  const [params, setParams] = useSearchParams();
  const signalId = params.get('signal');
  const expanded = params.get('signals') === 'all';
  const [filter, setFilter] = useState<GeoSignalState | ''>('');
  const identity = JSON.stringify([geoId, step ?? null, expanded, filter, signalId]);
  const address = (id: string | null, all = expanded) => setParams(current => {
    const next = new URLSearchParams(current);
    if (id) next.set('signal', id); else next.delete('signal');
    if (all) next.set('signals', 'all'); else next.delete('signals');
    return next;
  });
  return signalId ? <SignalDetail key={identity} geoId={geoId} project={project} signalId={signalId} onBack={() => address(null, true)} />
    : <SignalList key={identity} geoId={geoId} step={step} expanded={expanded} filter={filter} setFilter={setFilter} onOpen={id => address(id)} onExpand={() => address(null, !expanded)} />;
}

function SignalList({ geoId, step, expanded, filter, setFilter, onOpen, onExpand }: {
  geoId: string; step?: string | null; expanded: boolean; filter: GeoSignalState | ''; setFilter(value: GeoSignalState | ''): void; onOpen(id: string): void; onExpand(): void;
}) {
  const [page, setPage] = useState<GeoSignalPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [paging, setPaging] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const query = { limit: expanded ? 20 : 5, ...(step ? { step } : {}), ...(filter ? { state: filter } : {}), ...(!expanded ? { actionable: true } : {}) };
  useEffect(() => {
    let current = true;
    void listGeoSignals(geoId, query).then(value => { if (current) { setPage(value); setError(null); } }, failure => { if (current) setError(webErrorMessage(failure, { fallback: '发现与处理暂时读不到，请稍后重试。' })); });
    const timer = !expanded ? window.setTimeout(() => { if (current) setRound(value => value + 1); }, 30_000) : null;
    return () => { current = false; if (timer) window.clearTimeout(timer); };
    // The keyed parent recreates the view when its scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geoId, round]);
  const more = async () => {
    if (!page?.nextCursor || paging) return;
    setPaging(true);
    try {
      const next = await listGeoSignals(geoId, { ...query, cursor: page.nextCursor });
      if (alive.current) setPage(previous => previous ? { ...next, items: [...previous.items, ...next.items.filter(item => !previous.items.some(old => old.id === item.id))] } : next);
    } catch (failure) { if (alive.current) setError(webErrorMessage(failure, { fallback: '更多记录暂时读不到。' })); }
    finally { if (alive.current) setPaging(false); }
  };
  if (!page && error) return <LoadError message={error} onRetry={() => setRound(value => value + 1)} />;
  if (!page) return <p role="status" className="py-2 text-ui text-text-3">正在读取发现与处理</p>;
  if (!expanded && page.total === 0 && Object.values(page.counts).every(count => count === 0) && !error) return null;
  if (!expanded && page.total === 0 && page.items.length === 0 && !error) return <div data-geo-signals-summary="" className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <p className="text-caption text-text-3">{step ? "本阶段暂无待处理发现" : `当前没有待处理发现 · 已保留 ${Object.values(page.counts).reduce((sum, count) => sum + count, 0)} 条发现记录`}</p>
    <Button variant="text" size="sm" onClick={onExpand}>{step ? "查看本阶段发现" : "查看全部发现"}</Button>
  </div>;
  return <Section title="发现与处理" count={page.total} toolbar={<div className="flex items-center gap-2">
    {expanded && <Select aria-label="处理状态" value={filter} onChange={event => setFilter(event.target.value as GeoSignalState | '')}><option value="">全部状态</option>{Object.entries(GEO_SIGNAL_STATE_LABELS_ZH).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}
    {expanded && <Button variant="text" size="sm" onClick={() => setRound(value => value + 1)}>刷新记录</Button>}
    <Button variant="text" size="sm" onClick={onExpand}>{expanded ? '收起历史' : step ? '查看本阶段发现' : '查看全部发现'}</Button>
  </div>}>
    {error && <Note action={<Button variant="text" size="sm" onClick={() => setRound(value => value + 1)}>重试</Button>}>更新失败，保留已读记录。{error}</Note>}
    {page.items.length === 0 ? <p className="text-ui text-text-3">当前条件下没有记录。</p> : <List divided label="发现与处理记录">
      {page.items.map(item => <ListRow key={item.id} title={item.title} onOpen={() => onOpen(item.id)} meta={`${kinds[item.kind]} · ${stateWord(item)} · ${outcomes[item.businessOutcome.state] ?? '查看业务状态'} · ${time(item.observedAt)}`} />)}
    </List>}
    {expanded && page.nextCursor && <Button variant="text" size="sm" loading={paging} onClick={() => void more()}>更多记录</Button>}
  </Section>;
}

function SignalDetail({ geoId, project, signalId, onBack }: { geoId: string; project: GeoProject; signalId: string; onBack(): void }) {
  const location = useLocation();
  const open = useOpenGeoConversation();
  const destination = useGeoDestinationPath();
  const [signal, setSignal] = useState<GeoSignalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [record, setRecord] = useState<ProgrammeRun | null>(null);
  const keys = useRef(new Map<string, string>());
  const arrival = useRef(location.key); arrival.current = location.key;
  const alive = useRef(true);
  const readRecord = useCallback(async (run: ProgrammeRun) => {
    if (!run.runId) throw new Error('An exact handling run is required.');
    const record = await getGeoSignalRunRecord(geoId, signalId, run.runId);
    if (record.runId !== run.runId || record.sessionId !== run.sessionId) throw new Error('The returned handling record does not match.');
    return { history: record.history, files: record.files.map(file => ({ ...file, href: geoSignalResultHref(geoId, signalId, file) })) };
  }, [geoId, signalId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void getGeoSignal(geoId, signalId).then(value => { if (current) { setSignal(value); setError(null); } }, failure => { if (current) setError(webErrorMessage(failure, { fallback: '这条发现暂时读不到。' })); });
    const timer = window.setTimeout(() => { if (current) setRound(value => value + 1); }, 10_000);
    return () => { current = false; window.clearTimeout(timer); };
  }, [geoId, signalId, round]);
  const keyFor = (signature: string) => { if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID()); return keys.current.get(signature)!; };
  const canEdit = !project.access?.abilities || project.access.abilities.includes('edit');
  if (!signal && error) return <LoadError message={error} onRetry={() => setRound(value => value + 1)} />;
  if (!signal) return <p role="status" className="py-2 text-ui text-text-3">正在读取这条发现</p>;
  const targets = signal.targets ?? signal.basis.targets ?? [];
  const reviews = new Map((signal.sourceReview?.records ?? []).map(record => [record.targetKey, record]));
  const focus = selected ?? (targets.length <= 100 ? targets.map(target => target.key) : []);
  const attempt = signal.currentAttempt;
  const active = attempt?.submitted && ['started', 'processing'].includes(attempt.executionState);
  const orderHref = (() => {
    const url = new URL(cleanSignal(destination(geoId, { tab: 'actions', section: 'distribution' })), 'https://evimed.invalid');
    if (signal.basis.orderId) url.searchParams.set('order', signal.basis.orderId);
    return `${url.pathname}${url.search}${url.hash}`;
  })();
  const groupAnalysisHref = (side: 'before' | 'after') => {
    const url = new URL(cleanSignal(destination(geoId, { tab: 'visibility', section: 'trend' })), 'https://evimed.invalid');
    const session = url.searchParams.get('session');
    url.search = new URLSearchParams({ selectionRef: signal.basis.sides?.[side].selectionRef ?? '' }).toString();
    if (session) url.searchParams.set('session', session);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const handle = async (intent: 'analyse' | 'correct' | 'review', previous?: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    const from = location.key;
    const current = () => alive.current && arrival.current === from;
    try {
      const latestProject = await getGeoProject(geoId);
      if (!current()) return;
      const exactSession = previous ? attempt?.sessionId : latestProject.sessionId;
      if (previous && !exactSession) throw new Error("The original signal conversation is unavailable.");
      const sessionId = await ensureGeoConversationSession(geoId, project.projectId, exactSession, previous ? null : latestProject.sessionId);
      if (!current()) return;
      const body = { mode: 'signal' as const, signalId, expectedSignalRevision: signal.revision, sessionId, intent, focusRefs: focus,
        ...(previous ? { previousContextRef: previous } : {}) };
      const staged = await stageGeoPlanContext(geoId, { ...body, requestKey: keyFor(JSON.stringify(body)) });
      if (!current()) return;
      await open({ geoId, projectId: project.projectId, sessionId: staged.sessionId, exactSession: true,
        ...(staged.state !== 'bound' ? { geoPlanContext: { referenceId: staged.referenceId } } : {}) }, staged.state === 'bound' ? undefined : staged.draft);
    } catch (failure) { if (current()) setError(webErrorMessage(failure, { fallback: '暂时无法打开处理对话，已保留本次选择。' })); }
    finally { if (current()) setBusy(false); }
  };
  const disposition = async () => {
    if (busy) return;
    setBusy(true);
    const body = { expectedRevision: signal.revision, disposition: signal.disposition === 'ignored' ? 'active' as const : 'ignored' as const };
    try { const changed = await setGeoSignalDisposition(geoId, signalId, { ...body, requestKey: keyFor(JSON.stringify(['disposition', body])) }); if (alive.current) { setSignal(changed); setError(null); } }
    catch (failure) { if (alive.current) setError(webErrorMessage(failure, { fallback: '状态暂时没有保存，请重试。' })); }
    finally { if (alive.current) setBusy(false); }
  };
  return <Section title={kinds[signal.kind]} toolbar={<Button variant="text" size="sm" onClick={onBack}>返回记录</Button>}>
    <div className="flex flex-col gap-4">
      <p className="text-ui text-text">{signal.title}</p>
      <div className="flex flex-wrap gap-2"><Tag>{stateWord(signal)}</Tag><Tag>{outcomes[signal.businessOutcome.state] ?? '查看业务状态'}</Tag></div>
      <p className="text-caption text-text-3">观察时间：{time(signal.observedAt)} · 发现时间：{time(signal.detectedAt)}</p>
      {error && <Note action={<Button variant="text" size="sm" onClick={() => setRound(value => value + 1)}>重试读取</Button>}>{error}</Note>}
      {signal.availability === 'unknown' && <Note action={<Button variant="text" size="sm" onClick={() => setRound(value => value + 1)}>刷新执行记录</Button>}>执行记录暂时无法确认，保留已有产出。刷新后再决定是否继续处理。</Note>}
      {signal.basis.engine && <p className="text-ui text-text-2">{engineName(signal.basis.engine)}{signal.basis.questionVersion ? ` · 问句版本 ${signal.basis.questionVersion}` : ''}</p>}
      {signal.basis.snapshotId && <Link className="text-ui text-link hover:underline" to={cleanSignal(`/app/geo/${encodeURIComponent(geoId)}/answers/${encodeURIComponent(signal.basis.snapshotId)}`)}>查看原问题、完整回答和判断依据</Link>}
      {signal.basis.assessedStatement?.evidence && <blockquote className="border-l border-faint pl-3 text-ui text-text-2">{signal.basis.assessedStatement.evidence}</blockquote>}
      {signal.basis.assessedStatement?.applicability?.population && <p className="text-ui text-text-2">适用人群：{signal.basis.assessedStatement.applicability.population}</p>}
      {signal.basis.evidenceAvailability === 'unknown' && <Note action={<Link className="text-link hover:underline" to={cleanSignal(destination(geoId, { tab: 'evidence' }))}>查看现有证据</Link>}>这条历史记录没有完整保留判断依据，不能据此确认医学结论。</Note>}
      {signal.basis.url && /^https?:\/\//.test(signal.basis.url) && <a className="text-ui text-link hover:underline" href={signal.basis.url} target="_blank" rel="noopener noreferrer">打开被引用页面</a>}
      {signal.kind === 'group_changed' && <>
        <p className="text-ui text-text-2">{[signal.basis.group?.label ?? '问题群', signal.basis.group?.pool ? poolName(signal.basis.group.pool) : null, signal.basis.group?.questionVersion ? `问句版本 ${signal.basis.group.questionVersion}` : null].filter(Boolean).join(' · ')}</p>
        <p className="text-caption text-text-3">前次完成：{time(signal.basis.previous?.completedAt ?? null)} · 本次完成：{time(signal.basis.current?.completedAt ?? null)}</p>
        <p className="text-caption text-text-3">参与比较的平台：{signal.basis.methods?.before.engines.map(engineName).join("、")||"未记录"}</p>
        <List label="前后观测指标" divided>{signal.basis.cells?.map(cell => <ListRow key={cell.key}
          title={`${metricName(cell.metricId) ?? '指标'}：${cell.before.value}% → ${cell.after.value}%`}
          meta={`前次 ${cell.before.numerator ?? '未知'} / ${cell.before.denominator ?? '未知'}；本次 ${cell.after.numerator ?? '未知'} / ${cell.after.denominator ?? '未知'}；差异 ${cell.delta > 0 ? '+' : ''}${cell.delta} 个百分点`} />)}</List>
        <Note result={['观测差异绝对值大于 ', { n: signal.basis.policy?.threshold ?? '未知' }, ' 个百分点；噪声未实测，不能据此判断由内容调整造成。分析任务完成仅表示任务已完成。']} />
        {(['before', 'after'] as const).map(side => <div key={side} className="flex flex-col gap-2">
          <p className="text-ui text-text-2">{side === 'before' ? '前次' : '本次'}样本：{signal.basis.sides?.[side].count ?? '未知'} 条</p>
          <GeoGroupMembers key={`${signalId}:${side}:${signal.basisDigest}`} geoId={geoId} signalId={signalId} side={side} basisDigest={signal.basisDigest}/>
          <Link className="text-ui text-link hover:underline" to={groupAnalysisHref(side)}>查看{side === 'before' ? '前轮' : '后轮'}共同样本</Link>
        </div>)}
      </>}
      {signal.kind === 'source_changed' && <>
        {signal.sourceReview && <Note result={['已核查 ', { n: signal.sourceReview.handled }, ' / ', { n: signal.sourceReview.total }, ' 项：更新 ', { n: signal.sourceReview.updated }, ' 项，无需修改 ', { n: signal.sourceReview.unchanged }, ' 项，仍需处理 ', { n: signal.sourceReview.remaining }, ' 项。']} />}
        {targets.length === 0 ? <Note action={<Link className="text-link hover:underline" to={cleanSignal(destination(geoId, { tab: 'evidence' }))}>查看相关资料</Link>}>尚未建立具体受影响版本的关联，可以在对话中核查。</Note> : <div className="flex flex-col gap-2">
          <p className="text-caption text-text-3">已选 {focus.length} / {targets.length} 项，每次最多 100 项。</p>
          {targets.map(target => { const review = reviews.get(target.key); return <div key={target.key} className="flex flex-col gap-1"><label className="flex items-start gap-2 text-ui text-text">
            <input type="checkbox" checked={focus.includes(target.key)} disabled={busy || !canEdit || !focus.includes(target.key) && focus.length >= 100}
              onChange={event => setSelected(event.target.checked ? [...focus, target.key] : focus.filter(key => key !== target.key))} />
            <span>{target.label || ({ finding: '研究发现', claim: '证据结论', article: '稿件' }[target.type])}{typeof target.version === 'number' ? ` · 版本 ${target.version}` : target.version ? ' · 已固定稿件版本' : ' · 版本未记录'}{target.relationship === 'possible_group_dependency' ? ' · 同组关联，影响仍待核查' : ''}</span>
          </label>
            {review && <p className="text-caption text-text-2">{reviewWords[review.outcome]}{review.reason ? `：${review.reason}` : ''}</p>}
            {review?.availability === 'unknown' && <Note action={<Button variant="text" size="sm" onClick={() => setRound(value => value + 1)}>刷新</Button>}>这一项的核查结果暂时读不到，已保留已读到的记录。</Note>}
            {review?.artifact && <Link className="text-caption text-link hover:underline" to={geoSignalResultHref(geoId, signalId, review.artifact)}>查看这项核查的原始结果</Link>}
            {review?.after?.type === 'article' && review.after.path && typeof review.after.version === 'string' && <Link className="text-caption text-link hover:underline" to={geoSignalResultHref(geoId, signalId, { runId: review.after.runId, path: review.after.path, versionId: review.after.version })}>查看已关联的稿件版本</Link>}
          </div>; })}
        </div>}
      </>}
      <div className="flex flex-wrap items-center gap-2">
        {signal.basis.orderId ? <Link className="text-ui text-link hover:underline" to={orderHref}>查看订单和可执行操作</Link>
          : canEdit && !active && signal.availability !== 'unknown' && <Button variant="secondary" loading={busy} disabled={targets.length > 0 && focus.length === 0} onClick={() => void handle(signal.kind === 'error_observed' ? 'correct' : signal.kind === 'source_changed' ? 'review' : 'analyse', attempt?.submitted ? attempt.contextRef : undefined)}>
            {attempt?.submitted ? '在原对话继续处理' : signal.kind === 'error_observed' ? '准备纠错内容' : signal.kind === 'source_changed' ? '核查所选版本' : '在对话中分析'}
          </Button>}
        {attempt?.runId && <Button variant="secondary" onClick={() => setRecord(runOf(attempt, signal.title))}>查看本次运行</Button>}
        {active && attempt && <Button variant="text" onClick={() => void open({ geoId, projectId: project.projectId, sessionId: attempt.sessionId, exactSession: true })}>回到正在处理的对话</Button>}
        {canEdit && <Button variant="text" loading={busy} onClick={() => void disposition()}>{signal.disposition === 'ignored' ? '恢复提醒' : '忽略这条提醒'}</Button>}
      </div>
      {attempt?.result?.artifacts?.map(file => <Link key={file.id} className="text-ui text-link hover:underline" to={geoSignalResultHref(geoId, signalId, { ...file, versionId: file.id })}>{file.path.split('/').at(-1)} · 本次产出版本</Link>)}
      {signal.attempts.length > 1 && <List label="处理历史" divided>{signal.attempts.map(item => <ListRow key={item.contextRef} title={GEO_SIGNAL_STATE_LABELS_ZH[item.state]} meta={time(item.startedAt ?? item.createdAt)} onOpen={item.runId ? () => setRecord(runOf(item, signal.title)) : undefined} />)}</List>}
    </div>
    {record && <ProgrammeRunsDrawer key={record.runId ?? record.sessionId} projectId={project.projectId} load={async () => [record]} initialRun={record} readRecord={readRecord} onClose={() => setRecord(null)} />}
  </Section>;
}
