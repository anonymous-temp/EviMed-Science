import { useState } from 'react';
import { geoAutomationEnabled } from '@evimed/domain';
import { setGeoMonitoringAutomation, type GeoProject } from '@/lib/geoClient';
import { webErrorMessage } from '@/lib/apiClient';
import { Button } from '@/components/ui/Button';
import { LoadError } from '@/components/cards/LoadError';
import { geoActionPermission } from './geoJourney';
import { useGeoFrame } from './geoFrame';
import { engineName } from './geoText';
import { AskAi } from './AskAi';

/** Recurring measurement is optional and scoped to the engines and coverage the person actually selected. */
export function GeoMonitoringAutomation({project}: {project:GeoProject}) {
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
  return <section id="geo-automation" aria-label="自动监测" className="flex flex-col gap-2">
    <h2 className="text-section font-semibold">{enabled?'已开启自动监测':requested?'尚未开启自动监测':'可选：持续监测'}</h2>
    <p className="text-caption text-text-3">{`监测范围 · ${project.engines.map(engineName).join('、') || '尚未选择引擎'} · 覆盖窗口 ${project.coverageDays} 天`}</p>
    <p className="max-w-measure text-ui text-text-2">{enabled?'后续复测按此范围安排，可随时停止；每次测量按项目额度使用。':consent?.state==='confirmed'?'当前引擎或覆盖窗口已经变化。重新开启后，后续复测使用这里显示的范围。已有任务与结果保留。':consent?.state==='declined'?'自动监测已关闭。已有任务与结果保留，需要时可重新开启。':'开启后才会安排后续复测；现有诊断与历史结果仍可查看。'}</p>
    <p className="max-w-measure text-caption text-text-3">开启后会安排每周复测、每日风险抽查和发布后检查；完整方案还包括噪声复测。这些任务均按实际调用使用项目额度。停止后不再创建新任务，已经受理的任务会继续。</p>
    {mayChange ? <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" loading={busy} onClick={()=>change(!enabled)}>{enabled?'停止自动监测':'开始自动监测'}</Button>
      {!enabled && consent?.state!=='declined' && requested && <Button size="sm" variant="text" disabled={busy} onClick={()=>change(false)}>暂不启动</Button>}
    </div> : <p className="text-caption text-text-3">{permission.reason}</p>}
    {error && <LoadError message={error} onRetry={()=>change(attempt)} />}
    {permission.allowed && (!project.access || project.access.abilities.includes('edit')) && <AskAi project={{projectId:project.projectId,geoId:project.id,sessionId:project.sessionId}} label="在对话中调整监测范围" draft={`请核对本项目的持续监测问题集，并将监测范围调整为当前项目选择的 ${project.engines.map(engineName).join('、')}，覆盖 ${project.coverageDays} 天。保留历史版本，说明问题数、重复次数和预计调用量；在我确认后保存相符的新监测契约。本次不自动启动测量或持续监测。`} />}
    {project.activeMeasurement && <p className="text-caption text-text-3">已有一轮测量{project.activeMeasurement.status==='running'?'正在执行':'已排队'}；停止自动监测后它仍会继续。</p>}
  </section>;
}
