import { ensureGeoConversationSession } from "./geoConversationSession";
import { useState } from 'react';
import { useLocation } from 'react-router';
import { GEO_METRIC_LABELS_ZH } from '@evimed/domain';
import { getGeoAnalysis, type GeoAnalysisDescriptor, type GeoAnalysisRow } from '@/lib/geoAnalysisClient';
import { getGeoProject, stageGeoPlanContext, type GeoProject } from '@/lib/geoClient';
import { geoReadScopeQuery, type GeoMetricMembers } from '@/lib/geoReadScope';
import { geoSessionIdFromChatPath } from '@/lib/geoLocation';
import { webErrorMessage } from '@/lib/apiClient';
import { Disclosure } from '@/components/ui/Disclosure';
import { Toolbar } from '@/components/ui/Toolbar';
import { ChartCard } from '@/components/ui/ChartCard';
import { DataTable } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { Note } from '@/components/ui/Note';
import { DocumentExportActions } from '@/components/document/DocumentExportActions';
import { useGeoReadScope, useGeoFrame } from './geoFrame';
import { useGeoLoad } from './geoProjectData';
import { useOpenGeoConversation } from './useOpenGeoConversation';
import { GeoMetricMembersDrawer } from './GeoMetricMembersDrawer';
import { formatGeoValue, geoCellWord } from './GeoCellText';
import { metricUnit } from './tabs/geoTabText';
import { GeoLineChart, chartScale } from './tabs/GeoCharts';
import { engineName } from './geoText';

export function GeoAnalysisWorkbench({geoId,project,initialView='V01'}:{geoId:string;project:GeoProject;initialView?:'V01'|'V02'}) {
  const [expanded,setExpanded]=useState(false);
  return <Disclosure summary="所选数据分析" onToggle={setExpanded}>{expanded&&<AnalysisBody geoId={geoId} project={project} initialView={initialView}/>}</Disclosure>;
}
function AnalysisBody({geoId,project,initialView}:{geoId:string;project:GeoProject;initialView:'V01'|'V02'}) {
  const scope=useGeoReadScope();
  const [view,setView]=useState<GeoAnalysisDescriptor>({viewId:initialView,dimension:initialView==='V02'?'engine':'project'});
  const identity=JSON.stringify([geoId,geoReadScopeQuery(scope),view]);
  return <AnalysisPage key={identity} geoId={geoId} project={project} view={view} setView={setView}/>;
}
function AnalysisPage({geoId,project,view,setView}:{geoId:string;project:GeoProject;view:GeoAnalysisDescriptor;setView(view:GeoAnalysisDescriptor):void}) {
  const scope=useGeoReadScope(),frame=useGeoFrame();
  const [page,setPage]=useState<{offset:number;reference:string;digest:string}|null>(null);
  const [members,setMembers]=useState<GeoMetricMembers|null>(null);
  const location=useLocation(), open=useOpenGeoConversation();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const {state,reload}=useGeoLoad(`analysis:${geoId}:${geoReadScopeQuery(scope)}:${JSON.stringify(view)}:${page?.offset??0}`,()=>getGeoAnalysis(geoId,page?{selectionRef:page.reference}:scope,view,page?.offset??0,page?.digest));
  const data=state.kind==='ready'?state.data:null;
  const refresh=()=>{setPage(null);if(state.kind==='error'&&state.stale&&frame?.refreshScope)frame.refreshScope();else reload();};
  const explain=async()=>{
    if(!data)return;
    setBusy(true);setError('');
    try {
      const current=await getGeoProject(geoId);
      const sessionId=await ensureGeoConversationSession(project.projectId,geoSessionIdFromChatPath(location.pathname)||new URLSearchParams(location.search).get('session')||current.sessionId||project.sessionId);
      const context=await stageGeoPlanContext(geoId,{requestKey:crypto.randomUUID(),sessionId,mode:'analysis',selectionRef:data.selection.reference,view:data.view,expectedDigest:data.digest,intent:'explain'});
      await open({projectId:project.projectId,geoId,sessionId:context.sessionId,geoPlanContext:{referenceId:context.referenceId}},context.draft);
    } catch(cause){setError(webErrorMessage(cause,{fallback:'分析暂时无法带入对话，请刷新后重试。'}));}
    finally{setBusy(false);}
  };
  const dates=data?.chart?.labels??[];
  const series=(data?.chart?.series??[]).map(line=>({...line,label:line.engine?line.label.replace(line.engine,engineName(line.engine)):line.label,tone:'accent' as const}));
  const chartRange=chartScale(series.flatMap(line=>line.values));
  const labelCounts=new Map<string,number>();
  for(const line of series)labelCounts.set(line.label,(labelCounts.get(line.label)??0)+1);
  return <div className="flex flex-col gap-4">
    <Toolbar filters={[
      {kind:'select',label:'分析',value:view.viewId,options:[{value:'V01',label:'当前水平与目标'},{value:'V02',label:'指标趋势'}],onChange:value=>setView({viewId:value==='V02'?'V02':'V01',dimension:value==='V02'?'engine':'project'})},
      {kind:'select',label:'维度',value:view.dimension??'project',options:[{value:'project',label:'整体'},{value:'engine',label:'按平台'},{value:'group',label:'按问题群'}],onChange:value=>setView({...view,dimension:value==='engine'?'engine':value==='group'?'group':'project'})},
      {kind:'select',label:'指标',value:view.metricId??(view.viewId==='V02'?'M-01':null),allLabel:view.viewId==='V01'?'全部指标':undefined,options:Object.entries(GEO_METRIC_LABELS_ZH).filter(([id])=>id.startsWith('M-')).map(([value,label])=>({value,label:String(label)})),onChange:value=>setView({...view,metricId:value})},
    ]} actions={data?<Button size="sm" variant="secondary" loading={busy} onClick={()=>void explain()}>在对话中解释</Button>:undefined}/>
    {error&&<Note tone="warn" action={<Button size="sm" variant="text" onClick={refresh}>刷新分析</Button>}>{error}</Note>}
    {dates.length>1&&series.map((line,index)=><ChartCard key={line.key} title={(labelCounts.get(line.label)??0)>1?`${line.label}（同名组 ${index+1}）`:line.label}>
      <GeoLineChart series={[line]} labels={dates} domain={chartRange?[chartRange.low,chartRange.high]:null}/>
    </ChartCard>)}
    <DataTable<GeoAnalysisRow> label="所选分析数据" rows={data?.rows??[]} rowKey={row=>row.key}
      state={state.kind==='loading'?'loading':state.kind==='error'?'error':data?.rows.length?'content':'empty'} emptyText="这个范围尚无可用读数。" errorMessage={state.kind==='error'?state.message:undefined} onRetry={refresh}
      columns={[{key:'label',header:'指标与区间',rowHeader:true,cell:row=><>{row.label.replace(row.dimensions.engine??'\u0000',engineName(row.dimensions.engine??''))}{row.dimensions.date?` · ${row.dimensions.date}`:row.dimensions.period==='comparison'?' · 对照区间':row.dimensions.period?' · 所选区间':''}</>},...(data?.columns??[]).map(column=>({key:column.key,header:column.label,align:'right' as const,cell:(row:GeoAnalysisRow)=>{
        const value=row.values[column.key];const word=value.state==='known'&&value.value!==null?formatGeoValue(value.value,metricUnit(row.metricId)):value.metric?geoCellWord(value.metric):'未测';
        return <span className="inline-flex flex-col items-end">{value.members?<Button size="sm" variant="text" onClick={()=>setMembers(value.members)}>{word}</Button>:word}{value.metric?.denominator!=null&&<span className="text-caption text-text-3">{value.metric.numerator??'—'} / {value.metric.denominator}</span>}</span>;
      }}))]} footnote="实测、对照与当前目标分别显示；空白不计为零。趋势图和导出均包含全部所选数据。"/>
    {data&&<><Note result={['共 ',{n:data.page.total},' 行，当前显示 ',{n:data.page.shown},' 行。']}/>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={!page} onClick={()=>setPage(null)}>首批数据</Button>{data.page.nextOffset!==null&&<Button size="sm" variant="secondary" onClick={()=>setPage({offset:data.page.nextOffset!,reference:data.selection.reference,digest:data.digest})}>下一批数据</Button>}</div>
      <DocumentExportActions source={{geoId,selectionRef:data.selection.reference,view:data.view,expectedDigest:data.digest}} groupLabel="导出所选数据"/>
    </>}
    {members&&<GeoMetricMembersDrawer geoId={geoId} members={members} onClose={()=>setMembers(null)}/>}
  </div>;
}
