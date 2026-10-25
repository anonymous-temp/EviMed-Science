import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {GeoAnalysisView} from '@/lib/geoAnalysisClient';
import {GeoFinanceVisual} from './GeoFinanceVisual';
const cell=(value:number|null,unit='CNY')=>({value,state:value===null?'unknown':'known',unit,metric:null,members:null});
const base={view:{viewId:'V25',financeFacet:'ledger'},columns:[{key:'amountCny',label:'记录金额'},{key:'spentCny',label:'累计净支出'}],rows:[{key:'refund',label:'退款',dimensions:{date:'2026-10-05T00:00:00Z'},values:{amountCny:cell(10),spentCny:cell(70)}}],chart:{kind:'project_finance',cells:[{rowKey:'refund',columnKey:'amountCny',label:'退款',...cell(10),members:{selectionRef:'exact',unit:'ledger_entries',total:1}}]},contextualBasis:[]} as unknown as GeoAnalysisView;
afterEach(cleanup);
it('shows independent CNY amounts and cumulative balances, with exact amount drilldown',()=>{
 const select=vi.fn();render(<GeoFinanceVisual data={base} onSelect={select}/>);
 expect(screen.getByRole('img',{name:'人民币累计余额与净支出时间轴'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'记录金额：10 元'}));expect(select).toHaveBeenCalledWith(expect.objectContaining({rowKey:'refund',columnKey:'amountCny'}));
});
it('keeps frozen baseline, current reading and forecast target distinct and missing costs unknown',()=>{
 const values={frozenBaseline:cell(25,'percent'),recordedBaseline:cell(20,'percent'),current:cell(75,'percent'),target:cell(60,'percent'),budgetCny:cell(null),placements:cell(null,'placements'),horizonWeeks:cell(8,'weeks')};
 const data={...base,view:{viewId:'V26',strategyVersion:1,targetVersion:2},columns:Object.keys(values).map(key=>({key,label:({frozenBaseline:'方案冻结实测',recordedBaseline:'目标表登记基线',current:'当前所选实测',target:'方案目标'} as Record<string,string>)[key]??key})),rows:[{key:'plan',label:'品牌提及',metricId:'M-01',dimensions:{},values}],chart:{kind:'frozen_plan_targets',cells:Object.entries(values).map(([columnKey,value])=>({rowKey:'plan',columnKey,label:'品牌提及',...value}))},contextualBasis:[{kind:'frozen_plan',strategyVersion:1,targetVersion:2,costAssumptions:['报价仅作估计']}]} as unknown as GeoAnalysisView;
 render(<GeoFinanceVisual data={data} onSelect={()=>{}}/>);
 expect(screen.getByText('方案版本 1 · 冻结目标版本 2')).toBeVisible();
 for(const text of ['方案冻结实测：25%','目标表登记基线：20%','当前所选实测：75%','方案目标：60%'])expect(screen.getByRole('button',{name:text})).toBeDisabled();
 expect(screen.getByText(/规划费用 未估/)).toBeVisible();expect(screen.getByText('报价仅作估计')).toBeVisible();
});
