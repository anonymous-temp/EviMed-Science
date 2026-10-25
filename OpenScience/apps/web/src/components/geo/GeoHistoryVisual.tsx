import type {GeoAnalysisChartCell,GeoAnalysisRow} from "@/lib/geoAnalysisClient";
import {ChartCard} from "@/components/ui/ChartCard";
import {Button} from "@/components/ui/Button";
import {HeatGrid} from "@/components/charts/HeatGrid";

export interface GeoHistoryTimeline {
  total:number; dated:number; undated:number;
  events:Array<{id:string;rowKey:string;columnKey:string;at:string;label:string}>;
}
export interface GeoHistoryTrendPoint {
  roundId:string;rowKey:string;columnKey:string;at:string|null;
  metricId:string;value:number|null;status:string;reason:string|null;
  numerator:number|null;denominator:number|null;
  observedFrom?:string|null;observedTo?:string|null;unknownTimes?:number;
}

/** Draw recorded times as recorded. Event timing alone does not explain a change in model answers. */
export function GeoHistoryVisual({rows,columns,cells,timeline,trend=[],errorHistory=false,timeZone="Asia/Shanghai",onSelect}:{
  rows:GeoAnalysisRow[];
  columns:Array<{key:string;label:string}>;
  cells:GeoAnalysisChartCell[];
  timeline:GeoHistoryTimeline;
  trend?:GeoHistoryTrendPoint[];
  errorHistory?:boolean;
  timeZone?:string;
  onSelect(cell:GeoAnalysisChartCell):void;
}) {
  const eventRows=rows.filter(row=>row.dimensions.kind!=="history_reading"),eventColumns=columns.filter(column=>column.key!=="reading");
  const visible=new Set(rows.map(row=>row.key));
  const visibleCells=cells.filter(cell=>visible.has(cell.rowKey));
  const events=timeline.events.filter(event=>Number.isFinite(Date.parse(event.at)));
  const datedTrend=trend.filter(point=>point.at&&Number.isFinite(Date.parse(point.at)));
  const times=[...events.map(event=>Date.parse(event.at)),...datedTrend.flatMap(point=>[Date.parse(point.at!),...(point.observedFrom?[Date.parse(point.observedFrom)]:[])])];
  const low=times.length?Math.min(...times):0,high=times.length?Math.max(...times):0;
  const x=(at:string)=>high>low?40+(Date.parse(at)-low)/(high-low)*700:390;
  const numeric=datedTrend.filter(point=>typeof point.value==="number"&&Number.isFinite(point.value));
  const minimum=Math.min(0,...numeric.map(point=>point.value!)),maximum=Math.max(1,...numeric.map(point=>point.value!));
  const y=(value:number)=>110-(value-minimum)/(maximum-minimum)*90;
  const rowName=new Map(rows.map(row=>[row.key,row.label]));
  const readingLabel=columns.find(column=>column.key==="reading")?.label??"所选实测读数";
  return <>
    <ChartCard title={errorHistory?"错误观察与处理记录":"事件与所选观测"} state={eventRows.length?"content":"empty"} emptyText="这个范围暂无保留的历史记录。"
      footnote={errorHistory?"再次出现依据实际观察记录；任务完成、判定撤回和后续采样的错误消失分别记录。中间未保留的观察不作推测。":"事件与采样使用各自实际时间；发布和读数变化之间的先后关系不表示因果。"}>
      <HeatGrid label="历史事件记录" columns={eventColumns.map(column=>({key:column.key,header:column.label}))}
        rows={eventRows.map(row=>({key:row.key,header:row.label,cells:eventColumns.map(column=>{const cell=row.values[column.key];return {value:typeof cell?.value==="number"?cell.value:null,text:cell?.state==="not_applicable"?"—":String(cell?.value??"未知")};})}))}/>
      <ul aria-label="历史记录精确明细">{visibleCells.filter(cell=>cell.state!=="not_applicable"&&cell.columnKey!=="reading").map(cell=><li key={cell.rowKey+":"+cell.columnKey}>
        <Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{rowName.get(cell.rowKey)??cell.label} · {columns.find(column=>column.key===cell.columnKey)?.label} · {cell.value??"未知"}</Button>
      </li>)}</ul>
    </ChartCard>
    <ChartCard title="实际事件与采样时间" state={times.length||trend.length?"content":"empty"} emptyText="所选范围暂无可定位到日期的记录。"
      footnote={`事件标记显示最早的 ${events.length} / ${timeline.dated} 条有日期记录；${timeline.undated} 条时间未知记录保留在表格明细。每轮读数汇总所选样本区间，标在最后一次观察；虚线标示观察区间，未知读数或时间不定位，点之间不补算。先后关系不表示因果。`}>
      {!times.length&&<p role="status" className="text-caption text-text-2">观察时间未完整保留，图中留空；已知读数和精确样本仍可查看。</p>}
      {!!times.length&&<svg role="img" aria-label="实际业务事件与采样读数时间轴" viewBox="0 0 780 200" className="w-full">
        <line x1="40" x2="740" y1="150" y2="150" className="stroke-border"/>
        {!!numeric.length&&<><text x="4" y="22" className="fill-current text-text-2 text-caption">{maximum}</text><text x="4" y="110" className="fill-current text-text-2 text-caption">{minimum}</text></>}
        {numeric.map((point,index)=><g key={point.roundId}>{point.observedFrom&&point.observedFrom!==point.at&&<line x1={x(point.observedFrom)} x2={x(point.at!)} y1={y(point.value!)} y2={y(point.value!)} strokeDasharray="3 3" className="stroke-current text-text-2"><title>所选样本观察区间，非连续读数</title></line>}<circle cx={x(point.at!)} cy={y(point.value!)} r="4" className="fill-current text-accent">
          <title>{rowName.get(point.rowKey)??`采样第 ${index+1} 轮`} · {point.observedFrom??point.at} 至 {point.observedTo??point.at} · {readingLabel}区间汇总：{point.value}</title>
        </circle></g>)}
        {events.map((event,index)=><circle key={event.id} cx={x(event.at)} cy={150+(index%3-1)*6} r="3" className="fill-current text-text-2"><title>{event.at} · {event.label}</title></circle>)}
        {!!times.length&&<><text x="40" y="185" className="fill-current text-text-2 text-caption">{new Date(low).toLocaleDateString("zh-CN",{timeZone})}</text><text x="740" y="185" textAnchor="end" className="fill-current text-text-2 text-caption">{new Date(high).toLocaleDateString("zh-CN",{timeZone})}</text></>}
      </svg>}
      {!!trend.length&&<p className="text-caption text-text-2">{readingLabel}：{numeric.length} 条有日期的可用读数；{trend.length-numeric.length} 条读数或时间未知，完整状态见表格。</p>}
      <ul aria-label="实测读数精确成员">{visibleCells.filter(cell=>cell.columnKey==="reading"&&cell.state!=="not_applicable").map(cell=><li key={cell.rowKey}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{rowName.get(cell.rowKey)??cell.label} · {readingLabel} · {cell.value??"未知"}</Button></li>)}</ul>
      <ol aria-label="业务事件发生时间">{events.map(event=><li key={event.id} className="text-caption text-text-2"><time dateTime={event.at}>{event.at}</time> · {event.label}</li>)}</ol>
    </ChartCard>
  </>;
}
