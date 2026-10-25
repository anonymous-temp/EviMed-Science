import type { GeoAnalysisView, GeoAnalysisChartCell } from '@/lib/geoAnalysisClient';
import { ChartCard } from '@/components/ui/ChartCard';
import { Button } from '@/components/ui/Button';
import { FactList } from '@/components/ui/FactList';
import { chartScale } from './tabs/GeoCharts';

/** Geometry uses the server's readings and their own units, without combining finance and metric scales. */
export function GeoFinanceVisual({data,onSelect}:{data:GeoAnalysisView;onSelect(cell:GeoAnalysisChartCell):void}) {
  const plan=data.view.viewId==='V26',ledger=data.view.viewId==='V25'&&data.view.financeFacet!=='group';
  const visible=new Set(data.rows.map(row=>row.key)),cells=(data.chart?.cells??[]).filter(cell=>visible.has(cell.rowKey));
  const metricKeys=['frozenBaseline','recordedBaseline','current','target'];
  const amountKeys=ledger?['amountCny']:['reserveCny','releaseCny','settleCny','refundCny','spentCny'];
  const keys=plan?metricKeys:amountKeys;
  const word=(cell:GeoAnalysisChartCell)=>cell.value===null?'未知':`${cell.value}${cell.unit==='percent'?'%':cell.unit==='CNY'?' 元':cell.unit==='weeks'?' 周':cell.unit==='placements'?' 次':''}${cell.state==='known'?'':cell.state==='insufficient'?'（样本不足）':'（依据尚不完整）'}`;
  const basis=data.contextualBasis?.find(item=>item.kind==='frozen_plan');
  return <>
    <ChartCard title={plan?'方案冻结实测、当前实测与目标':'项目金额记录'} state={data.rows.length?'content':'empty'} emptyText={plan?'这个范围没有匹配的冻结方案与目标。':'这个范围没有账目记录。'}
      footnote={plan?'冻结实测与目标表登记基线分别保留；当前实测来自当前选择。目标、费用与工作量是规划，未知值保持为空。':'本图显示当前页；预留、释放、结算和退款分别保留，不能相加当作项目支出。项目整体预算与未归属金额单列。'}>
      {plan&&basis&&<p className="text-caption text-text-2">方案版本 {basis.strategyVersion??'未知'} · 冻结目标版本 {basis.targetVersion??'未知'}</p>}
      {data.rows.map(row=>{
        const values=cells.filter(cell=>cell.rowKey===row.key&&keys.includes(cell.columnKey));
        const scale=chartScale(values.map(cell=>cell.value),null,[0,0]);
        const x=(value:number)=>scale?10+(value-scale.low)/(scale.high-scale.low)*480:10;
        return <div key={row.key} className="flex flex-col gap-2">
          <p className="text-caption">{row.label}</p>
          <svg role="img" aria-label={`${row.label} · ${plan?'实测与目标':'人民币金额'}`} viewBox={`0 0 500 ${Math.max(1,values.length)*18}`} className="w-full">
            {values.filter(cell=>cell.value!==null).map((cell,index)=><line key={cell.columnKey} x1={x(0)} x2={x(cell.value!)} y1={index*18+8} y2={index*18+8} strokeWidth="6" className={cell.columnKey==='target'?'stroke-text-3':'stroke-accent'} strokeDasharray={cell.columnKey==='target'?'4 3':undefined}><title>{data.columns.find(column=>column.key===cell.columnKey)?.label}：{word(cell)}</title></line>)}
          </svg>
          <ul aria-label={`${row.label}精确读数`}>{values.map(cell=><li key={cell.columnKey}><Button size="sm" variant="text" disabled={!cell.members} onClick={()=>onSelect(cell)}>{data.columns.find(column=>column.key===cell.columnKey)?.label}：{word(cell)}</Button></li>)}</ul>
          {plan&&<p className="text-caption text-text-2">规划费用 {row.values.budgetCny?.value??'未估'} {row.values.budgetCny?.value!=null?'元':''} · 投放 {row.values.placements?.value??'未估'} · 周期 {row.values.horizonWeeks?.value??'未估'} 周</p>}
        </div>;
      })}
      {plan&&Array.isArray(basis?.costAssumptions)&&<FactList rows={[{label:'费用假设',value:basis.costAssumptions.filter(item=>typeof item==='string').join('；')||'费用假设详见方案；缺少报价时保持未估。'}]}/>}
    </ChartCard>
    {ledger&&<BalanceTimeline data={data}/>}
  </>;
}

function BalanceTimeline({data}:{data:GeoAnalysisView}) {
  const keys=['reservedCny','settledCny','spentCny','availableCny'];
  const dated=data.rows.filter(row=>row.dimensions.date&&Number.isFinite(Date.parse(row.dimensions.date)));
  const times=dated.map(row=>Date.parse(row.dimensions.date!)),low=Math.min(...times),high=Math.max(...times);
  const scale=chartScale(dated.flatMap(row=>keys.map(key=>typeof row.values[key]?.value==='number'?row.values[key].value as number:null)),null,[0,0]);
  const x=(at:number)=>high>low?10+(at-low)/(high-low)*580:300;
  return <ChartCard title="累计余额与净支出" state={dated.length?'content':'empty'} emptyText="所选页没有可用于时间轴的明确记账时间。" footnote="单位：人民币元。每个余额使用完整项目账目前缀和当时预算；当前页按真实记账时间展示，日期区间的期初不采用今日配置预算。">
    <svg role="img" aria-label="人民币累计余额与净支出时间轴" viewBox="0 0 600 150" className="w-full">
      {scale&&keys.map((key,index)=>{
        const points=dated.map((row,i)=>{const value=row.values[key]?.value;return typeof value==='number'?`${x(times[i])},${140-(value-scale.low)/(scale.high-scale.low)*130}`:null;});
        // Unknown readings break the line instead of becoming zeros or bridging an unavailable interval.
        const segments=points.map(point=>point??'|').join(' ').split('|').filter(point=>point.trim());
        return <g key={key}>{segments.map((points,segment)=><polyline key={segment} points={points} fill="none" strokeWidth="2" strokeDasharray={index===1?'8 3':index===2?'2 3':index===3?'12 3 2 3':undefined} className={index?'stroke-text-3':'stroke-accent'}><title>{data.columns.find(column=>column.key===key)?.label}</title></polyline>)}</g>;
      })}
    </svg>
    <p className="text-caption text-text-2">{keys.map(key=>data.columns.find(column=>column.key===key)?.label).join(' · ')}</p>
  </ChartCard>;
}
