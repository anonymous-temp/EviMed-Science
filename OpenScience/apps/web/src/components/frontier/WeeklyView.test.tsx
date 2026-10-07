import {render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {beforeEach,expect,it,vi} from 'vitest';
import userEvent from '@testing-library/user-event';
import {WeeklyView} from './WeeklyView';
import {frontierItem} from './__fixtures__/frontierItems';
const client=vi.hoisted(()=>({listFrontierWeeklies:vi.fn(),fetchFrontierWeekly:vi.fn()}));
vi.mock('@/lib/frontierClient',async original=>({...await original<typeof import('@/lib/frontierClient')>(),...client}));
beforeEach(()=>{vi.resetAllMocks();client.listFrontierWeeklies.mockResolvedValue([{weekStart:'2026-09-21',weekEnd:'2026-09-27',title:null,itemCount:0,generatedAt:null}]);client.fetchFrontierWeekly.mockResolvedValue({day:'2026-09-21',weekStart:'2026-09-21',weekEnd:'2026-09-27',lead:null,sections:[],safety:[],aiMinute:null,markdown:'Weekly',itemCount:0,readingMinutes:1,previousDay:'2026-09-14',nextDay:null});});
it('shows a calendar range, previous issue navigation and reload-selected week',async()=>{const onWeek=vi.fn();render(<MemoryRouter><WeeklyView week="2026-09-21" onWeek={onWeek}/></MemoryRouter>);await screen.findByText(/9月21日.*9月27日/);expect(client.fetchFrontierWeekly).toHaveBeenCalledWith('2026-09-21');await userEvent.click(screen.getByRole('button',{name:'‹ 前一期'}));expect(onWeek).toHaveBeenCalledWith('2026-09-14');});
it('empty archive is a calm weekly empty state',async()=>{client.listFrontierWeeklies.mockResolvedValue([]);render(<MemoryRouter><WeeklyView week={null} onWeek={()=>{}}/></MemoryRouter>);await waitFor(()=>expect(screen.getByText('暂无周报')).toBeInTheDocument());expect(client.fetchFrontierWeekly).not.toHaveBeenCalled();});
it('failed archive is retryable',async()=>{client.listFrontierWeeklies.mockRejectedValueOnce(new Error('offline'));render(<MemoryRouter><WeeklyView week={null} onWeek={()=>{}}/></MemoryRouter>);await userEvent.click(await screen.findByRole('button',{name:'重试'}));await screen.findByText(/9月21日.*9月27日/);});
it('previews five rows of each lane and opens the rest in place, so a week of 70 items is a few minutes of reading',async()=>{
  const lane=(key:string,label:string,count:number)=>({lane:key,laneLabel:label,items:Array.from({length:count},(_,index)=>frontierItem({id:`${key}${index}`,title:`${label}第${index+1}条`}))});
  client.fetchFrontierWeekly.mockResolvedValue({day:'2026-09-21',weekStart:'2026-09-21',weekEnd:'2026-09-27',lead:null,sections:[lane('evidence','临床证据',12),lane('guideline','指南共识',4),lane('industry','研发产业',6)],safety:lane('safety','药物安全',10).items,aiMinute:null,markdown:'Weekly',itemCount:32,readingMinutes:25,previousDay:null,nextDay:null});
  render(<MemoryRouter><WeeklyView week="2026-09-21" onWeek={()=>{}}/></MemoryRouter>);
  const evidence=await screen.findByRole('list',{name:'临床证据'});
  expect(within(evidence).getAllByRole('listitem')).toHaveLength(5);
  expect(within(screen.getByRole('list',{name:'指南共识'})).getAllByRole('listitem')).toHaveLength(4);
  expect(within(screen.getByRole('list',{name:'安全警示'})).getAllByRole('listitem')).toHaveLength(5);
  // The weekly reaches its lanes through the same 分类 menu as the daily, from its sticky header.
  expect(screen.getByRole('button',{name:'分类'})).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'展开其余 7 条'}));
  expect(within(screen.getByRole('list',{name:'临床证据'})).getAllByRole('listitem')).toHaveLength(12);
  expect(screen.getByRole('button',{name:'展开其余 1 条'})).toBeInTheDocument();
});
