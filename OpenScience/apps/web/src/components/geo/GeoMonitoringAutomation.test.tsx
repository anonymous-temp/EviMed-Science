import { MemoryRouter } from 'react-router';
import { render as rtlRender,screen,waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach,expect,it,vi } from 'vitest';
import { geoProject } from './__fixtures__/geoTabs';
import { GeoMonitoringAutomation } from './GeoMonitoringAutomation';
const api=vi.hoisted(()=>({set:vi.fn()}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),setGeoMonitoringAutomation:api.set}));
const render=(node:React.ReactNode)=>rtlRender(node,{wrapper:MemoryRouter});
beforeEach(()=>{api.set.mockReset().mockResolvedValue({enabled:true});});
it('does not imply past scope authorization; turning it on and declining are explicit choices',async()=>{
  render(<GeoMonitoringAutomation project={geoProject({monitoring:'done'})}/>);
  expect(screen.getByRole('heading',{name:'等你开启自动监测'})).toBeVisible();
  expect(screen.getByText('监测范围')).toBeVisible();
  expect(screen.getByText(/覆盖窗口 90 天/)).toBeVisible();
  expect(screen.getByText(/开启后才会安排后续复测/)).toBeVisible();
  expect(screen.getByText(/每日风险抽查和发布后检查/)).toBeVisible();
  expect(screen.getByText('这些任务均按实际调用使用项目额度')).toBeVisible();
  expect(screen.getByText('不再创建新任务，已经受理的任务会继续')).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'开启自动监测'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',true));
  await userEvent.click(screen.getByRole('button',{name:'暂不启动'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',false));
});
it('does not offer an enable action to paused or read-only projects',()=>{
  const first=render(<GeoMonitoringAutomation project={geoProject({}, {status:'paused'})}/>);
  expect(screen.queryByRole('button',{name:'开启自动监测'})).toBeNull();first.unmount();
  render(<GeoMonitoringAutomation project={geoProject({}, {access:{abilities:['read'],roles:['viewer'],owner:false}})}/>);
  expect(screen.queryByRole('button',{name:'开启自动监测'})).toBeNull();
});
it('points a member who cannot change monitoring at the scope the measurements cover',()=>{
  render(<GeoMonitoringAutomation project={geoProject({}, {access:{abilities:['read'],roles:['viewer'],owner:false}})}/>);
  expect(screen.getByRole('link',{name:'查看测量范围'})).toHaveAttribute('href','/app/geo/geo_1/questions');
  expect(screen.queryByRole('link',{name:'查看这轮测量'})).toBeNull();
});
it('requires the confirmed engine/window scope to match before calling monitoring enabled',()=>{
  const p=geoProject({monitoring:'done'});
  p.steps.monitoring!.automation={state:'confirmed',actorId:'actor',at:'2026-10-31T10:00:00Z',engines:[...p.engines],coverageDays:p.coverageDays};
  const view=render(<GeoMonitoringAutomation project={p}/>);
  expect(screen.getByRole('button',{name:'停止自动监测'})).toBeVisible();
  view.rerender(<GeoMonitoringAutomation project={{...p,coverageDays:180}}/>);
  expect(screen.getByRole('heading',{name:'等你开启自动监测'})).toBeVisible();
  expect(screen.getByText(/当前引擎或覆盖窗口已经变化/)).toBeVisible();
});

it('allows stopping confirmed automation while the project is paused',async()=>{
  const p=geoProject({monitoring:'done'},{status:'paused'});
  p.steps.monitoring!.automation={state:'confirmed',actorId:'actor',at:'2026-10-31T10:00:00Z',engines:[...p.engines],coverageDays:p.coverageDays};
  render(<GeoMonitoringAutomation project={p}/>);
  await userEvent.click(screen.getByRole('button',{name:'停止自动监测'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',false));
  expect(screen.queryByRole('button',{name:'开启自动监测'})).toBeNull();
});

it('lets a read-only member inspect the exact accepted round without offering new work',()=>{
  const p=geoProject({}, {access:{abilities:['read'],roles:['viewer'],owner:false},activeMeasurement:{id:'round_weekly_1',kind:'weekly',status:'running'}});
  render(<GeoMonitoringAutomation project={p}/>);
  expect(screen.getByRole('link',{name:'查看这轮测量'})).toHaveAttribute('href','/app/geo/geo_1/questions?diagnosisRound=round_weekly_1');
  expect(screen.queryByRole('button',{name:'开始自动监测'})).toBeNull();
  expect(screen.queryByRole('button',{name:'在对话中调整监测范围'})).toBeNull();
  expect(api.set).not.toHaveBeenCalled();
});

it('keeps the addressed conversation and analysis context when opening an accepted round',()=>{
 const p=geoProject({}, {activeMeasurement:{id:'round_weekly_2',kind:'weekly',status:'queued'}});
 rtlRender(<MemoryRouter initialEntries={['/app/geo/geo_1/visibility?session=history-session&engines=kimi']}><GeoMonitoringAutomation project={p}/></MemoryRouter>);
 const href=screen.getByRole('link',{name:'查看这轮测量'}).getAttribute('href')!;
 const target=new URL(href,'https://geo.invalid');
 expect(target.searchParams.get('session')).toBe('history-session');
 expect(target.searchParams.get('engines')).toBe('kimi');
 expect(target.searchParams.get('diagnosisRound')).toBe('round_weekly_2');
});
