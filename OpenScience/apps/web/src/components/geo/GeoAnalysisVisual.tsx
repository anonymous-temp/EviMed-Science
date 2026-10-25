import {GeoHistoryVisual} from "./GeoHistoryVisual";
import { useId, useState } from "react";
import type { GeoAnalysisView, GeoAnalysisChartCell } from "@/lib/geoAnalysisClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { Toolbar } from "@/components/ui/Toolbar";
import { Button } from "@/components/ui/Button";
import { BarList } from "@/components/charts/BarList";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { GeoLineChart, chartScale } from "./tabs/GeoCharts";
import { engineName } from "./geoText";
import { GeoFinanceVisual } from "./GeoFinanceVisual";

const reasonWords: Readonly<Record<string, string>> = {
  measurement_method_changed: "测量方法已变化，保留两期读数且不参与排序。",
  measurement_contract_changed: "测量约定已变化，不参与排序。",
  metric_members_changed: "合资格成员发生变化，不参与排序。",
  comparison_basis_changed: "组成指标或有效权重已变化，不参与排序。",
  comparison_not_selected: "请选择对照区间。",
  own_brand_not_registered: "这个范围没有登记可用于比较的本品品牌；通用名独立观测。",
  rival_history_unknown: "历史登记依据未知，不能将缺席记为零。",
  share_agreement_missing: "该轮未约定此声量指标或登记集合。",
  engine_absent: "这个范围没有该平台的回答。",
  no_snapshots: "这个范围没有回答记录。",
  no_valid_answers: "这个范围尚未取得有效回答。",
  insufficient_sample: "尚未达到该指标的样本要求。",
  not_adjudicated: "回答中的陈述尚未完成判定。",
  judgement_incomplete: "回答的判定尚未完整。",
  not_extracted: "尚未取得该指标所需的提取结果。",
  entity_extraction_incomplete: "品牌与实体识别尚未完成。",
  citations_without_links: "引用缺少可核对的链接。",
  owned_not_registered: "尚未登记可识别的自有信源。",
  no_inline_citation_engine: "该平台没有可识别的正文引用。",
  no_citations: "这个范围没有可核对的引用。",
  no_retrieval: "这个范围没有可核对的检索结果。",
  not_mentioned: "这个范围没有可确定位置的品牌提及。",
  no_drug_entities: "尚未识别出可用于该指标的药品实体。",
  coverage_below_min: "品牌登记信息不足，尚不能计算该指标。",
  uneven_denominators: "回答覆盖不均，不能直接比较该指标。",
  no_brand_mentions: "这个范围没有可识别的品牌提及。",
  conversion_not_derivable: "缺少可用于该指标的上下游读数。",
  no_measurable_dimension: "这个范围尚无可计算的指标维度。",
  no_measurable_pool: "这个范围尚无可计算的问句池读数。",
  not_applicable: "该指标不适用于这类问题。",
  inclusion_surface: "该采样方式不适用于这个指标。",
};
function unavailableWord(cell: GeoAnalysisChartCell): string {
  if (cell.reason === "citations_without_links") return "引用不可测";
  return ({ no_data: "未测", insufficient: "样本不足", unjudged: "尚无法判定", not_applicable: "不适用" } as Record<string, string>)[cell.state] ?? "暂无可用读数";
}
function unavailableReason(cell: GeoAnalysisChartCell): string {
  return reasonWords[cell.reason ?? ""] ?? (cell.state === "insufficient"
    ? "尚未达到该指标的样本要求。"
    : "尚无可用读数，可在下表查看明细。");
}
function platformLabel(cell: GeoAnalysisChartCell): string {
  return [engineName(cell.engine ?? ""), cell.pool].filter(Boolean).join(" · ");
}

/** Geometry only: every value, display dimension and exact member comes from the full server aggregate. */
export function GeoAnalysisVisual({ data, onSelect }: {
  data: GeoAnalysisView;
  onSelect(cell: GeoAnalysisChartCell): void;
}) {
  const statusId = useId();
  const [journeyColumn, setJourneyColumn] = useState("questions");
  const chart = data.chart;
  if (!chart) return null;
  if(chart.kind==="error_history"||chart.kind==="business_history")return <GeoHistoryVisual rows={data.rows} columns={data.columns} cells={chart.cells??[]} timeline={chart.timeline??{total:0,dated:0,undated:0,events:[]}} trend={chart.trend} errorHistory={chart.kind==="error_history"} timeZone={data.scope?.timeZone} onSelect={onSelect}/>;
  if(chart.kind==="project_finance"||chart.kind==="frozen_plan_targets")return <GeoFinanceVisual data={data} onSelect={onSelect}/>;
  if(chart.kind==="publication_coverage"||chart.kind==="publication_execution"){
    const visible=new Set(data.rows.map(row=>row.key)),cells=(chart.cells??[]).filter(cell=>visible.has(cell.rowKey));
    const rows=data.rows.map(row=>({key:row.key,header:row.label,cells:data.columns.map(column=>{const value=row.values[column.key]?.value;return {value:typeof value==="number"?value:null,text:String(value??"未知")};})}));
    const events=chart.timeline?.events??[],dates=events.map(event=>Date.parse(event.at)),low=Math.min(...dates),high=Math.max(...dates);
    return <>
      <ChartCard title={chart.kind==="publication_coverage"?"内容与发布覆盖":"投放与发布状态"} state={rows.length?"content":"empty"} emptyText="这个范围尚无内容或发布记录。"
        footnote="各列独立计数；一篇内容可有多个版本和发布记录。登记发布不等于外部核验。业务记录按日期筛选；只选采样轮次时，这些关联记录不代表该轮当时状态。">
        <HeatGrid label="内容、版本与发布记录" columns={data.columns.map(column=>({key:column.key,header:column.label}))} rows={rows}/>
        <ul aria-label="内容与发布精确明细">{cells.map(cell=><li key={`${cell.rowKey}:${cell.columnKey}`}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{cell.label} · {data.columns.find(column=>column.key===cell.columnKey)?.label} · {cell.value??"未知"}</Button></li>)}</ul>
      </ChartCard>
      {chart.timeline&&<ChartCard title="订单事件时间" state={events.length?"content":"empty"} emptyText="所选范围暂无有日期的订单事件。"
        footnote={`时间轴显示最早的 ${events.length} / ${chart.timeline.dated} 条有日期记录；${chart.timeline.undated} 条时间未知记录保留在明细。订单按创建日期筛选，事件按其记录时间筛选，不能作为同一分母。`}>
        <svg role="img" aria-label="订单实际事件时间轴" viewBox="0 0 600 60" className="w-full"><line x1="10" x2="590" y1="30" y2="30" className="stroke-border"/>
         {events.map((event,index)=><circle key={event.id} cx={high>low?10+(dates[index]-low)/(high-low)*580:300} cy={30+(index%3-1)*7} r="3" className="fill-current text-accent"><title>{event.at} · {event.label}</title></circle>)}
        </svg>
        {events.length>0&&<p className="text-caption text-text-3">{events[0].at} — {events.at(-1)?.at}</p>}
        <ul aria-label="订单事件明细入口">{cells.filter(cell=>cell.columnKey==="orderEvents"&&Number(cell.value)>0).map(cell=><li key={cell.rowKey}><Button size="sm" variant="text" onClick={()=>onSelect(cell)}>{cell.label} · 查看 {cell.value} 条事件</Button></li>)}</ul>
      </ChartCard>}
    </>;
  }
  if (chart.kind === "error_distribution") {
    const visible=new Set(data.rows.map(row=>row.key)),columns=data.columns.filter(column=>column.key.startsWith("engine_"));
    const cells=(chart.cells??[]).filter(cell=>visible.has(cell.rowKey));
    const rows=data.rows.map(row=>({key:row.key,header:row.label,cells:columns.map(column=>{const value=row.values[column.key]?.value;return {value:typeof value==="number"?value:null,text:String(value??"未知")};})}));
    return <ChartCard title={data.view.errorFacet==="severity"?"严重程度与平台":"错误类型与平台"} state={rows.length?"content":"empty"} emptyText="所选回答没有关联的错误记录。"
      footnote="展示当前页关联的错误记录；重复出现和任务次数不重复计数。这里是当前判定与处置状态，不能当作当时状态或回答错误率。">
      <HeatGrid label="错误记录分布" columns={columns.map(column=>({key:column.key,header:column.label}))} rows={rows}/>
      <ul aria-label="错误记录精确明细">{cells.map(cell=><li key={`${cell.rowKey}:${cell.columnKey}`}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{cell.label} · {engineName(cell.engine??"")} · {cell.value??"未知"} 条记录</Button></li>)}</ul>
    </ChartCard>;
  }
  if (chart.kind === "evidence") {
    const visible = new Set(data.rows.map(row => row.key));
    const cells = (chart.cells ?? []).filter(cell => visible.has(cell.rowKey));
    const rows = data.rows.map(row => ({key:row.key,header:row.label,cells:data.columns.map(column=>{
      const cell=cells.find(item=>item.rowKey===row.key&&item.columnKey===column.key);
      return {value:cell?.state==="known"?cell.value:null,text:cell?.state==="partial"?`${cell.knownSubtotal??cell.value??"未知"} 已核实；${cell.unknownCandidates??"未知"} 待核实`:cell?.value==null?"未知":String(cell.value)};
    })}));
    const findings=data.view.evidenceKind==="findings";
    return <ChartCard title={findings?"发现表达覆盖":"主张与来源覆盖"} state={rows.length?"content":"empty"} emptyText="尚无所选范围的已保存判定。"
      footnote={findings?"展示当前页的表达记录；是否表达给定结论与医学来源是否支持该结论分别判断。":"展示当前页的精确主张、条件与来源；依据缺失保持未知，当前来源变更与采样时的回答分别保留。"}>
      <HeatGrid label={findings?"发现表达覆盖矩阵":"主张条件与来源覆盖矩阵"} columns={data.columns.map(column=>({key:column.key,header:column.label}))} rows={rows}/>
      <ul aria-label="证据覆盖精确明细">{cells.map(cell=><li key={`${cell.rowKey}:${cell.columnKey}`}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{cell.label} · {data.columns.find(column=>column.key===cell.columnKey)?.label} · {cell.value??"未知"}{cell.state==="partial"?`（另有 ${cell.unknownCandidates??"未知"} 条待核实）`:""}</Button></li>)}</ul>
    </ChartCard>;
  }
  if (chart.kind === "journey") {
    const columns=data.columns??[], selected=columns.find(column=>column.key===journeyColumn)??columns[0], cells=(chart.cells??[]).filter(cell=>cell.columnKey===selected?.key);
    const word = (cell: GeoAnalysisChartCell) => cell.state === "partial"
      ? `${cell.knownSubtotal ?? cell.value ?? "未知"}（已核实小计；${cell.unknownCandidates == null ? "待核实数量未知" : `另有 ${cell.unknownCandidates} 条待核实`}）` : cell.value == null ? "未知" : String(cell.value);
    return <ChartCard title="旅程与需求覆盖" state={cells.length?"content":"empty"} emptyText="尚无所选问题定义。" footnote="各类数量有独立单位；同一对象可关联多个需求，不能相加为漏斗或人群比例。未采样问题仍保留。">
      <Toolbar filters={[{kind:"select",label:"覆盖数量",value:selected?.key??"questions",options:columns.map(column=>({value:column.key,label:column.label})),onChange:value=>{if(value)setJourneyColumn(value);}}]} />
      <HeatGrid label="旅程与需求覆盖矩阵" columns={[{key:selected?.key??"questions",header:selected?.label??"原始问题"}]} rows={cells.map(cell=>({key:cell.rowKey,header:cell.label,cells:[{value:cell.state === "known" ? cell.value : null,text:word(cell),hint:cell.state !== "known" ? "部分主张缺少核实依据；已核实小计与待核实数量分别保留。" : selected?.label}]}))} />
      <ul aria-label="需求覆盖明细">{cells.map(cell=><li key={cell.rowKey}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{cell.label} · {selected?.label} {word(cell)}</Button></li>)}</ul>
    </ChartCard>;
  }
  if (chart.kind === "source_facets" || chart.kind === "source_history") {
    const history=chart.kind === "source_history", cells=chart.cells??[];
    const columnKey=(cell:GeoAnalysisChartCell)=>history?cell.roundId??"unknown":cell.facetKey??"remainder";
    const rowKey=(cell:GeoAnalysisChartCell)=>history?JSON.stringify([cell.sourceKey,cell.facetKey]):cell.sourceKey??"remainder";
    const columnLabel=(cell:GeoAnalysisChartCell)=>history?cell.roundLabel??"轮次未知":cell.engine?engineName(cell.engine):cell.groupName?`${cell.groupName} · 问题版本 ${cell.setVersion??"未知"}`:"其余交叉项";
    const columns=[...new Map(cells.map(cell=>[columnKey(cell),{key:columnKey(cell),header:columnLabel(cell)}])).values()];
    const grouped=new Map<string,GeoAnalysisChartCell[]>();
    for(const cell of cells){const key=rowKey(cell);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key)!.push(cell);}
    const observationWord=(cell:GeoAnalysisChartCell)=>cell.observation==="present"?"已观察引用":cell.observation==="absent"?"可观测未引用":"未知";
    const transitionWord=(value:string|null|undefined)=>({first_observed_in_scope:"所选范围内首次",new_appearance:"新出现",no_longer_observed:"同一可比范围内未再观察到"} as Record<string,string>)[value??""]??"";
    const title=history?"页面引用观察历史":"来源与平台或版本化问题群";
    return <ChartCard title={title} state={cells.length?"content":"empty"} emptyText="这个范围没有可核对的来源观察。"
      footnote={history?"未引用依赖采集端记录的引用列表完整性，只适用于同一问题、版本、平台和采样方式；不代表已穷尽全网或模型信息。未知区间留空。":"每项保留精确平台或问题群版本；图示范围之外的交叉项合计保留，完整数值见下表。"}>
      <HeatGrid label={title} columns={columns} rows={[...grouped].map(([key,items])=>({key,header:history?`${items[0].sourceKey} · ${engineName(items[0].engine??"")} · v${items[0].setVersion??"未知"} · 问题 ${items[0].questionId??"未知"}`:items[0].sourceLabel??items[0].label,cells:columns.map(column=>{const cell=items.find(cell=>columnKey(cell)===column.key);return {value:cell?.value??null,text:cell?(history?observationWord(cell):String(cell.value??"未知")):"无引用观测",hint:cell?`${cell.label} · ${history?transitionWord(cell.transition):cell.value??"未知"}`:"该交叉项未保留引用观测"};})}))}/>
      <ul aria-label={history?"逐轮引用与变化明细":"来源交叉明细"}>{cells.map(cell=><li key={cell.rowKey} className="min-w-0"><Button size="sm" variant="text" className="h-auto max-w-full whitespace-normal break-all text-left" onClick={()=>onSelect(cell)}>{cell.label} · {history?`${observationWord(cell)} ${transitionWord(cell.transition)}`:`${cell.value??"未知"} 回答`}</Button></li>)}</ul>
    </ChartCard>;
  }
  if (chart.kind === "opportunities") {
    const cells=chart.cells??[], known=cells.filter(cell=>cell.state==="known"&&cell.yState==="known"&&cell.x!=null&&cell.y!=null);
    const maxSample=Math.max(1,...cells.map(cell=>cell.sampleSize??0));
    return <ChartCard title="品牌提及与登记自有信源引用" state={known.length?"content":"empty"} emptyText="尚无完整坐标；每组的读数、分母和对象仍可在下表查看。"
      footnote="气泡面积表示实际回答样本；不代表需求规模、医学优先级或因果。人工信源关系与登记自有指标分开保留。"
      legend={<ul aria-label="机会图精确问题群">{cells.map(cell=><li key={cell.rowKey}><Button size="sm" variant="text" onClick={()=>onSelect(cell)}>{cell.label} · 样本 {cell.sampleSize??0} · X {cell.x??"未知"}% · Y {cell.y??"未知"}%</Button><span className="text-caption text-text-3">X 分母 {cell.xDenominator??"未知"} · Y 分母 {cell.yDenominator??"未知"}</span></li>)}</ul>}>
      <svg role="img" aria-label="品牌提及与登记自有信源引用" viewBox="0 0 600 360" className="w-full">
        <line x1="60" x2="560" y1="300" y2="300" className="stroke-border"/><line x1="60" x2="60" y1="40" y2="300" className="stroke-border"/>
        <text x="60" y="330" className="fill-current text-text-2">X：品牌提及 M-01（0—100%）</text><text x="60" y="24" className="fill-current text-text-2">Y：登记自有信源 {data.view.ownedMetricId??"M-08"}（0—100%）</text>
        {known.map(cell=><circle key={cell.rowKey} cx={60+cell.x!*5} cy={300-cell.y!*2.6} r={Math.sqrt((cell.sampleSize??0)/maxSample)*16} className="fill-current text-accent opacity-70"><title>{cell.label} · X {cell.x}% · Y {cell.y}% · 样本 {cell.sampleSize}</title></circle>)}
      </svg>
    </ChartCard>;
  }
  if (chart.kind === "source_relationships") {
    const cells=chart.cells??[];
    return <ChartCard title="已确认信源关系" footnote="当前人工注释按精确页面优先于域名解析；关系不推定为采样时状态，也不依赖品牌提及。">
      <BarList label="信源关系与回答页面配对" rows={cells.map(cell=>({key:cell.rowKey,label:cell.label,value:cell.value??0,unit:"配对"}))} onSelect={key=>{const cell=cells.find(cell=>cell.rowKey===key);if(cell)onSelect(cell);}}/>
    </ChartCard>;
  }
  if (chart.kind === "sources") {
    const cells=chart.cells??[], coverage=chart.mode==="type_coverage";
    return <ChartCard title={coverage?"来源类型回答覆盖率":"来源引用集中度"} state={cells.length?"content":"empty"} emptyText="这个范围没有可核对链接；无法观测的引用能力保留未知。"
      footnote={coverage?"同一回答可计入多个类型，覆盖率之和可以超过 100%。部分判定回答的可用引用仍保留。":"错误和品牌提及仅表示共同出现，不代表错误由该来源引起。"}
      legend={<p>{coverage?`分母：${chart.denominator??0} 个有可用引用的回答；类型覆盖可重叠。`:`分母：${chart.denominator??0} 个回答与页面配对；前 ${chart.topN??15} 项及完整余项。`}</p>}>
      <BarList label={coverage?"各类来源覆盖回答":"来源回答与页面配对"} rows={cells.filter(cell=>cell.value!==null).map(cell=>({key:cell.rowKey,label:cell.label,value:cell.value!,unit:coverage?"%":"配对"}))}
        onSelect={key=>{const cell=cells.find(cell=>cell.rowKey===key);if(cell)onSelect(cell);}}/>
    </ChartCard>;
  }
  if (chart.kind === "recommendations") {
    const cells = chart.cells ?? [], known = cells.filter(cell => cell.state === "known" && cell.value !== null);
    return <ChartCard title="推荐表达分布" state={known.length ? "content" : "empty"} emptyText="尚无完整分类；已保留的表达与未知覆盖见下表。"
      footnote="每条表达归入一个分类；同一回答可包含多条表达，并同时进入多个回答分类。合理不推荐不计为负面。"
      legend={<ul aria-label="推荐分类与覆盖">{cells.filter(cell => cell.value === null).map(cell => <li key={cell.rowKey}>{cell.label} · 分类覆盖不足</li>)}</ul>}>
      <BarList label="推荐表达分布" rows={known.map(cell => ({key:cell.rowKey,label:cell.label,value:cell.value!,unit:"表达"}))}
        onSelect={key => {const cell=cells.find(item=>item.rowKey===key);if(cell)onSelect(cell);}} />
    </ChartCard>;
  }
  if (chart.kind === "comparison") {
    const cells = chart.cells ?? [], known = cells.filter(cell => cell.state === "known" && cell.value !== null);
    const max = Math.max(1, ...known.map(cell => Math.abs(cell.value!)));
    return <ChartCard title="可比变化排序" state={known.length ? "content" : "empty"} emptyText="尚无可排序的可比读数；两期读数和原因保留在下表。" legend={<ul aria-label="变化与不可比状态">{cells.map(cell=><li key={cell.rowKey}><Button size="sm" variant="text" onClick={()=>onSelect(cell)}>{cell.label.replace(cell.engine ?? "\u0000",engineName(cell.engine ?? ""))} · {cell.value === null ? "不排序" : `${cell.value>0?"+":""}${cell.value} ${cell.unit === "percentage_points" ? "个百分点" : "分"}`}</Button>{cell.value===null&&<span className="text-caption text-text-3">{unavailableReason(cell)}</span>}</li>)}</ul>}>
      <svg role="img" aria-label="可比变化排序" viewBox={`0 0 600 ${Math.max(48,known.length*32)}`} className="w-full">
        <line x1="300" x2="300" y1="0" y2={known.length*32} className="stroke-border"/>
        {known.map((cell,index)=><rect key={cell.rowKey} x={cell.value!<0?300-Math.abs(cell.value!)/max*280:300} y={index*32+4} width={Math.abs(cell.value!)/max*280} height="24" className={cell.value!<0?"fill-current text-text-3":"fill-current text-accent"}><title>{cell.label}：{cell.value}</title></rect>)}
      </svg>
    </ChartCard>;
  }
  if (chart.kind === "rivals") {
    const cells = chart.cells ?? [];
    const cellKey = (cell: GeoAnalysisChartCell) => `${cell.rowKey}:${cell.columnKey}`;
    const known = cells.filter(cell => cell.state === "known" && cell.value !== null);
    const unavailable = cells.filter(cell => cell.state !== "known" || cell.value === null);
    const brandCells = known.filter(cell => cell.unit !== "answers");
    const genericCells = known.filter(cell => cell.unit === "answers");
    const lines = chart.series.map(line => ({ ...line, tone: line.own ? "accent" as const : "muted" as const }));
    const groups = new Map<string, typeof lines>();
    for (const line of lines) {
      const key = line.comparisonKey ?? line.key;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(line);
    }
    return <>
      <ChartCard
        title={data.view?.metricId === "M-17" ? "所选回答与登记品牌集合的相对提及声量份额" : "已登记实体的问句池比较"}
        footnote={data.view?.metricId === "M-17"
          ? "每个本品与竞品比较均使用该竞品的同一合资格回答。相对提及份额不代表市场份额。"
          : "每个本品与竞品比较均使用该竞品的同一合资格回答。"}
        state={known.length ? "content" : "empty"}
        emptyText="尚无可绘制的竞品读数；历史未知与样本不足均保留。"
        legend={<ul aria-label="竞品测量状态">{unavailable.map(cell => <li key={cellKey(cell)}>
          <Button size="sm" variant="text" onClick={() => onSelect(cell)}>{cell.entityName} · {cell.pool} · {unavailableWord(cell)}</Button>
          <span className="text-caption text-text-3">{unavailableReason(cell)}</span>
        </li>)}</ul>}
      >
        <svg role="img" aria-label={data.view?.metricId === "M-17" ? "已登记品牌相对提及声量份额" : "已登记品牌提及率"}
          viewBox={`0 0 600 ${Math.max(48, brandCells.length * 32)}`} className="w-full">
          {brandCells.map((cell, index) => <g key={cellKey(cell)}>
            <text x="0" y={index * 32 + 22} className="fill-current text-text-2">{cell.entityName} · {cell.pool}</text>
            <rect x="220" y={index * 32 + 4} width={cell.value! * 3} height="24" className={cell.own ? "fill-current text-accent" : "fill-current text-text-3"}/>
            <text x="530" y={index * 32 + 22} className="fill-current text-text">{cell.value}%</text>
          </g>)}
        </svg>
        {genericCells.length > 0 && <BarList label="通用名独立观测"
          rows={genericCells.map(cell => ({ key: cellKey(cell), label: `${cell.entityName} · ${cell.pool}`, value: cell.value!, unit: "回答" }))}
          onSelect={key => { const cell = cells.find(cell => cellKey(cell) === key); if (cell) onSelect(cell); }}/>}
        <ul aria-label="所选实体回答">{brandCells.map(cell => <li key={cellKey(cell)}>
          <Button size="sm" variant="text" onClick={() => onSelect(cell)}>{cell.entityName} · {cell.pool} · {cell.value}% · 查看回答</Button>
        </li>)}</ul>
      </ChartCard>
      {chart.labels.length > 0 && [...groups].map(([key, group]) => {
        const range = chartScale(group.flatMap(line => line.values));
        const paired = Boolean(group[0].comparisonKey);
        return <ChartCard key={key} title={paired ? `${group[0].comparisonLabel} · 同口径比较` : group[0].label}
          state={range ? "content" : "empty"} emptyText="这组比较尚无可绘制读数；缺失读数保留未知。"
          legend={<ul aria-label="趋势比较系列">{group.map(line => <li key={line.key}>{line.label}</li>)}</ul>}>
          <GeoLineChart series={group} labels={chart.labels} domain={range ? [range.low, range.high] : null} pointLabels/>
        </ChartCard>;
      })}
    </>;
  }
  if (chart.kind === "bars") {
    const cells = chart.cells ?? [];
    const known = cells.filter(cell => cell.state === "known" && cell.value !== null);
    const unavailable = cells.filter(cell => cell.state !== "known" || cell.value === null);
    return (
      <ChartCard
        title="各平台所选实测"
        state={known.length ? "content" : "empty"}
        emptyText={cells.length ? "这个范围尚无可绘制读数；未测与样本不足均未计为零。" : "这个范围尚无平台读数。"}
        legend={unavailable.length ? (
          <ul aria-label="未绘制的平台状态" className="flex w-full flex-col gap-2">
            {unavailable.map(cell => (
              <li key={cell.rowKey}>
                <Button size="sm" variant="text" aria-describedby={`${statusId}-${cell.rowKey}`} onClick={() => onSelect(cell)}>
                  {platformLabel(cell)} · {unavailableWord(cell)}
                </Button>
                <p id={`${statusId}-${cell.rowKey}`} className="text-caption text-text-3">{unavailableReason(cell)}</p>
              </li>
            ))}
          </ul>
        ) : undefined}
      >
        <BarList
          label="各平台所选实测"
          tone="own"
          rows={known.map(cell => ({
            key: cell.rowKey,
            label: platformLabel(cell),
            value: cell.value!,
            unit: cell.unit === "percent" ? "%" : cell.unit === "answers" ? "回答" : undefined,
          }))}
          onSelect={key => {
            const cell = cells.find(item => item.rowKey === key);
            if (cell) onSelect(cell);
          }}
        />
      </ChartCard>
    );
  }
  if (chart.kind === "matrix") {
    const cells = chart.cells ?? [];
    const engines = [...new Set(cells.map(cell => cell.engine).filter((engine): engine is string => engine !== null))];
    const groups = new Map<string, GeoAnalysisChartCell[]>();
    for (const cell of cells) {
      const key = JSON.stringify([cell.setVersion, cell.groupId, cell.pool]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(cell);
    }
    return (
      <ChartCard title="问题群与平台交叉实测">
        <HeatGrid
          label="问题群与平台交叉实测"
          columns={engines.map(engine => ({ key: engine, header: engineName(engine) }))}
          rows={[...groups].map(([key, items], index) => ({
            key,
            header: `${[items[0].groupName ?? "未命名问题群", items[0].setVersion != null ? `问题版本 ${items[0].setVersion}` : null, items[0].pool].filter(Boolean).join(" · ")}（组 ${index + 1}）`,
            cells: engines.map(engine => {
              const cell = items.find(item => item.engine === engine);
              const known = cell?.state === "known" && cell.value !== null;
              return {
                value: known ? cell.value : null,
                text: known ? String(cell.value) : cell ? unavailableWord(cell) : "未测",
                hint: cell ? `${cell.label}；${known ? "可在下表查看精确明细" : unavailableReason(cell)}` : "这个范围没有该平台的读数。",
              };
            }),
          }))}
        />
      </ChartCard>
    );
  }
  const lines = chart.series.map(line => ({ ...line, label: line.engine ? line.label.replace(line.engine, engineName(line.engine)) : line.label, tone: "accent" as const }));
  const range = chartScale(lines.flatMap(line => line.values)), counts = new Map<string, number>();
  for (const line of lines) counts.set(line.label, (counts.get(line.label) ?? 0) + 1);
  return <>{chart.labels.length > 1 && lines.map((line, index) => <ChartCard key={line.key} title={(counts.get(line.label) ?? 0) > 1 ? `${line.label}（同名组 ${index + 1}）` : line.label}><GeoLineChart series={[line]} labels={chart.labels} domain={range ? [range.low, range.high] : null}/></ChartCard>)}</>;
}
