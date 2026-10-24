import { useId } from "react";
import type { GeoAnalysisView, GeoAnalysisChartCell } from "@/lib/geoAnalysisClient";
import { ChartCard } from "@/components/ui/ChartCard";
import { Button } from "@/components/ui/Button";
import { BarList } from "@/components/charts/BarList";
import { HeatGrid } from "@/components/charts/HeatGrid";
import { GeoLineChart, chartScale } from "./tabs/GeoCharts";
import { engineName } from "./geoText";

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
  const chart = data.chart;
  if (!chart) return null;
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
