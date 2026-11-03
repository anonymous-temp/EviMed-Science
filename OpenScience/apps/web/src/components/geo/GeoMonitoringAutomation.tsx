import { createPath, Link, useLocation } from 'react-router';
import { useEffect, useId, useState } from 'react';
import { geoAutomationEnabled } from '@evimed/domain';
import { setGeoMonitoringAutomation, type GeoProject } from '@/lib/geoClient';
import { webErrorMessage } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { FactList, type Fact } from '@/components/ui/FactList';
import { Disclosure } from '@/components/ui/Disclosure';
import { LoadError } from '@/components/cards/LoadError';
import { geoActionPermission } from './geoJourney';
import { geoTabPath } from './geoTabs';
import { useGeoFrame } from './geoFrame';
import { engineName } from './geoText';
import { AskAi } from './AskAi';
import { useGeoPath } from './useGeoPath';

/** Recurring measurement is optional and scoped to the engines and coverage the person actually selected. */
/**
 * Component: GeoMonitoringAutomation; owner: GEO; rules: DS23.
 * Anatomy: Unboxed monitoring heading/actions, scope/current round, consent details and retry.
 * Variants: Confirmed scope folds schedule/cost; before consent schedule and cost remain visible.
 * States: Confirmed, changed scope, declined, read-only, busy mutation and retryable save failure.
 * Hit area: Shared controls retain their standard targets.
 * Keyboard: Native controls preserve Tab and activation behavior.
 * Long content: Text wraps within the available reading width.
 * Theme: Shared surface, border and ink tokens.
 * Responsive: Content follows the parent workspace width.
 * Verification: Focused component behavior tests and fixture walkthrough.
 */
export function GeoMonitoringAutomation({ project, onHandoff }: { project: GeoProject; onHandoff?: () => void }) {
  const path = useGeoPath();
  const location = useLocation();
  const handoffId = useId();
  const currentPath = createPath(location);
  const scopePath = path(geoTabPath(project.id, 'questions'));
  const activeRound = project.activeMeasurement;
  const roundPath = activeRound ? path(`${geoTabPath(project.id, 'questions')}?diagnosisRound=${encodeURIComponent(activeRound.id)}`) : null;
  const handoffState = (target: string) => onHandoff && target !== currentPath ? { geoMonitoringHandoff: handoffId } : undefined;
  // A blocked navigation never commits this marker. Native Link gestures keep their default behavior.
  useEffect(() => {
    if (location.state?.geoMonitoringHandoff === handoffId) onHandoff?.();
  }, [location.state, handoffId, onHandoff]);
  const enabled=geoAutomationEnabled(project);
  const consent=project.steps.monitoring?.automation;
  const requested=project.steps.monitoring?.requested;
  const permission=geoActionPermission(project,'run');
  const mayStop=!project.access || project.access.abilities.includes('run');
  const mayChange=permission.allowed || Boolean(enabled && mayStop);
  const frame=useGeoFrame();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(false);
  const change=(value:boolean)=>{
    if((value ? !permission.allowed : !mayStop) || busy) return;
    setBusy(true);setError(null);setAttempt(value);
    void setGeoMonitoringAutomation(project.id,value).then(()=>frame?.reload(),cause=>setError(webErrorMessage(cause,{fallback:'自动监测设置未能保存，请重试。'}))).finally(()=>setBusy(false));
  };
  const canAsk=permission.allowed && (!project.access || project.access.abilities.includes('edit'));
  const sentence=enabled?'停止后不再创建新任务，已经受理的任务会继续。':consent?.state==='confirmed'?'当前引擎或覆盖窗口已经变化。重新开启后，后续复测使用这里显示的范围。已有任务与结果保留。':consent?.state==='declined'?'自动监测已关闭。已有任务与结果保留，需要时可重新开启。':'开启后才会安排后续复测；现有诊断与历史结果仍可查看。';
  const facts:Fact[]=[
    {label:'监测范围',value:`${project.engines.map(engineName).join('、') || '尚未选择引擎'} · 覆盖窗口 ${project.coverageDays} 天`},
    ...(!enabled ? [{label:'停止后',value:'不再创建新任务，已经受理的任务会继续'}] : []),
    // The round that is already accepted is opened exactly, by its id, for whoever can read the project; stopping does not end it.
    ...(activeRound && roundPath ?[{label:'当前测量',value:<>{`已有一轮测量${activeRound.status==='running'?'正在进行':'排队中'}`}{' '}<Link className="rounded text-link underline decoration-1 underline-offset-4 hover:decoration-2" to={roundPath} state={handoffState(roundPath)}>查看这轮测量</Link></>}]:[]),
  ];
  const scheduleFacts:Fact[]=[
    {label:'会安排',value:'每周复测、每日风险抽查和发布后检查；完整方案还包括噪声复测'},
    {label:'额度',value:'这些任务均按实际调用使用项目额度'},
  ];
  const actions=mayChange?<span className="flex flex-wrap items-center gap-2">
    {/* Consent is a write to the project, not a run: later rounds are scheduled from it, none starts now. So it is 开启, not 开始. */}
    <Button size="sm" variant="text" className="text-accent hover:text-accent" actionKind="set" loading={busy} onClick={()=>change(!enabled)}>{enabled?'停止自动监测':'开启自动监测'}</Button>
    {!enabled && consent?.state!=='declined' && requested && <Button size="sm" variant="text" actionKind="set" disabled={busy} onClick={()=>change(false)}>暂不启动</Button>}
    {canAsk && <AskAi project={{projectId:project.projectId,geoId:project.id,sessionId:project.sessionId}} label="让 AI 调整监测范围" onOpened={onHandoff} draft={`请核对本项目的持续监测问题集，并将监测范围调整为当前项目选择的 ${project.engines.map(engineName).join('、')}，覆盖 ${project.coverageDays} 天。保留历史版本，说明问题数、重复次数和预计调用量；在我确认后保存相符的新监测契约。本次不自动启动测量或持续监测。`} />}
  </span>:<Link className="rounded text-ui text-link hover:underline" to={scopePath} state={handoffState(scopePath)}>查看测量范围</Link>;
  return <section id="geo-automation" aria-label="自动监测" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-section font-semibold">{enabled?'已开启自动监测':requested?'等你开启自动监测':'可选：持续监测'}</h2>{actions}</div>
    <p className="text-ui text-text-2">{sentence}</p>
    <FactList rows={facts} ruled={false} />
    {enabled ? <Disclosure summary="监测安排与额度"><FactList rows={scheduleFacts} ruled={false} /></Disclosure> : <FactList rows={scheduleFacts} ruled={false} />}
    {!mayChange && <p className="text-caption text-text-3">{permission.reason}</p>}
    {error && <LoadError message={error} onRetry={()=>change(attempt)} />}
  </section>;
}
