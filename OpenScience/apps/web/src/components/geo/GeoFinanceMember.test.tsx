import {render,screen,cleanup} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {afterEach,expect,it} from 'vitest';
import {GeoFinanceMember} from './GeoFinanceMember';
afterEach(cleanup);
it('opens the exact order while preserving selected scope and clearing conflicting publication/actions',()=>{
 render(<MemoryRouter initialEntries={['/app/geo/g/actions?session=s&publication=stale&order=stale&action=stale&groupIds=g']}><GeoFinanceMember geoId="g" selectionRef="gsel_exact" item={{id:'ledger:refund',unit:'ledger_entries',kind:'refund',orderId:'exact-order',amountCny:10,balance:{spentCny:70,availableCny:430}}}/></MemoryRouter>);
 const url=new URL(screen.getByRole('link',{name:'查看对应订单与结算记录'}).getAttribute('href')!,'https://test.local');
 expect(url.searchParams.get('order')).toBe('exact-order');expect(url.searchParams.get('selectionRef')).toBe('gsel_exact');expect(url.searchParams.get('session')).toBe('s');expect(url.searchParams.has('publication')).toBe(false);expect(url.searchParams.has('action')).toBe(false);
 expect(screen.getByText('70 元')).toBeVisible();
});
it('opens the existing exact plan version and labels retained historical members without substituting current ones',()=>{
 render(<MemoryRouter initialEntries={['/app/geo/g/plan?session=s&order=stale']}><GeoFinanceMember geoId="g" selectionRef="gsel_current" item={{id:'frozen',unit:'frozen_metric_readings',strategyVersion:3,targetVersion:2,value:25,memberCount:4,memberReference:'unavailable-old'}}/></MemoryRouter>);
 const url=new URL(screen.getByRole('link',{name:'查看此版本方案与调整费用目标'}).getAttribute('href')!,'https://test.local');
 expect(url.pathname).toBe('/app/geo/g/plan');expect(url.searchParams.get('strategyVersion')).toBe('3');expect(url.searchParams.get('selectionRef')).toBe('gsel_current');expect(url.searchParams.has('order')).toBe(false);
 expect(screen.getByText(/原有成员可能已无法读取/)).toBeVisible();
});

it('keeps historical group identity while labelling unavailable current metadata and unknown business scope',()=>{
 render(<MemoryRouter><GeoFinanceMember geoId="g" item={{id:'historical',unit:'ledger_entries',kind:'settle',amountCny:0.3,association:{groupId:'retired'},groupContext:'historical_association_current_metadata_unavailable',businessScopeState:'unknown'}}/></MemoryRouter>);
 expect(screen.getByText('0.3 元')).toBeVisible();expect(screen.queryByText(/0\.300000000/)).not.toBeInTheDocument();
 expect(screen.getByText('历史版本明确关联；当前问题群资料未知')).toBeVisible();expect(screen.getByText('部分历史关联未保留，范围归属未知，保留原始金额')).toBeVisible();
});
