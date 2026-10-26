import {Link,useLocation} from 'react-router';
import type {GeoAnalysisMemberItem} from '@/lib/geoAnalysisClient';
import {geoSearchWithScope} from '@/lib/geoReadScope';
import {FactList} from '@/components/ui/FactList';
import {Note} from '@/components/ui/Note';
import {useGeoPath} from './useGeoPath';

export function GeoFinanceMember({geoId,item,selectionRef}:{geoId:string;item:GeoAnalysisMemberItem;selectionRef?:string}) {
 const location=useLocation(),contextPath=useGeoPath();
 const query=new URLSearchParams(geoSearchWithScope(location.search,selectionRef?{selectionRef}:{}));
 for(const key of ['publication','action','order'])query.delete(key);
 if(item.orderId)query.set('order',item.orderId);
 query.set('step','distribution');
 const planQuery=new URLSearchParams(geoSearchWithScope(location.search,selectionRef?{selectionRef}:{}));
 for(const key of ['publication','action','order','step'])planQuery.delete(key);
 if(item.strategyVersion)planQuery.set('strategyVersion',String(item.strategyVersion));
 const ledger=['ledger_entries','ledger_balance_readings'].includes(item.unit);
 const kinds:Record<string,string>={budget_set:'预算设置',reserve:'预留',release:'释放预留',settle:'结算',refund:'退款'};
 return <article className="flex flex-col gap-2">
  <p className="text-ui">{ledger?kinds[item.kind??'']??'账目记录':item.unit==='target_rows'?'方案保存的规划目标':'方案冻结的实测读数'}</p>
  <FactList rows={ledger?[
   {label:'记账金额',value:item.amountCny==null?'未知':`${item.amountCny} 元`},
   {label:'记账时间',value:item.at??item.createdAt??'未知'},
   {label:'问题群归属',value:item.association?.groupId?item.groupContext==='historical_association_current_metadata_unavailable'?'历史版本明确关联；当前问题群资料未知':'当时内容版本中明确关联':'未归属或项目整体预算'},
   ...(item.businessScopeState==='unknown'?[{label:'所选业务范围',value:'部分历史关联未保留，范围归属未知，保留原始金额'}]:[]),
   ...Object.entries(item.balance??{}).filter(([key])=>key!=='dailyCny').map(([key,value])=>({label:({budgetCny:'当时项目预算',reservedCny:'累计预留余额',settledCny:'累计结算',refundedCny:'累计退款',spentCny:'累计净支出',availableCny:'当时项目可用预算'} as Record<string,string>)[key]??key,value:value==null?'未知':`${value} 元`}))
  ]:[
   {label:'方案版本',value:item.strategyVersion??'未知'},{label:'冻结目标版本',value:item.targetVersion??'未知'},
   ...(item.unit==='frozen_metric_readings'?[{label:'冻结读数',value:item.value??'未知'},{label:'分子 / 分母',value:`${item.numerator??'未知'} / ${item.denominator??'未知'}`},{label:'原有成员数',value:item.memberCount??'未知'}]:[
    {label:'目标表登记基线',value:item.baseline??'未记录'},{label:'规划目标',value:item.target??'未记录'},{label:'规划费用',value:item.budgetCny==null?'未估':`${item.budgetCny} 元`},{label:'计划投放数',value:item.placements??'未估'},{label:'目标周期',value:item.horizonWeeks==null?'未估':`${item.horizonWeeks} 周`}
   ])
  ]}/>
  {item.unit==='frozen_metric_readings'&&<Note action={<Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/plan?${planQuery}`)}>查看此版本方案与调整费用目标</Link>}>这里保留方案制定时的数值与成员依据；原有成员可能已无法读取，不能用当前成员替换。</Note>}
  {ledger&&<Note action={<Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/actions?${query}#geo-distribution`)}>{item.orderId?'查看对应订单与结算记录':'查看项目预算与账目'}</Link>}>余额按完整项目账目前缀计算；充值、预留与退款不作为新增支出相加。</Note>}
  {item.unit==='target_rows'&&item.strategyVersion&&<Link className="text-accent" to={contextPath(`/app/geo/${encodeURIComponent(geoId)}/plan?${planQuery}`)}>查看此版本方案与调整费用目标</Link>}
 </article>;
}
