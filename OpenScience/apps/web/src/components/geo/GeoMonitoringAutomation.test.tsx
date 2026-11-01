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
it('does not imply past scope authorization; starting and declining are explicit choices',async()=>{
  render(<GeoMonitoringAutomation project={geoProject({monitoring:'done'})}/>);
  expect(screen.getByRole('heading',{name:'尚未开启自动监测'})).toBeVisible();
  expect(screen.getByText(/监测范围.*覆盖窗口 90 天/)).toBeVisible();
  expect(screen.getByText(/开启后才会安排后续复测/)).toBeVisible();
  expect(screen.getByText(/每日风险抽查和发布后检查/)).toHaveTextContent('按实际调用使用项目额度');
  await userEvent.click(screen.getByRole('button',{name:'开始自动监测'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',true));
  await userEvent.click(screen.getByRole('button',{name:'暂不启动'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',false));
});
it('does not offer an enable action to paused or read-only projects',()=>{
  const first=render(<GeoMonitoringAutomation project={geoProject({}, {status:'paused'})}/>);
  expect(screen.queryByRole('button',{name:'开始自动监测'})).toBeNull();first.unmount();
  render(<GeoMonitoringAutomation project={geoProject({}, {access:{abilities:['read'],roles:['viewer'],owner:false}})}/>);
  expect(screen.queryByRole('button',{name:'开始自动监测'})).toBeNull();
});
it('requires the confirmed engine/window scope to match before calling monitoring enabled',()=>{
  const p=geoProject({monitoring:'done'});
  p.steps.monitoring!.automation={state:'confirmed',actorId:'actor',at:'2026-10-31T10:00:00Z',engines:[...p.engines],coverageDays:p.coverageDays};
  const view=render(<GeoMonitoringAutomation project={p}/>);
  expect(screen.getByRole('button',{name:'停止自动监测'})).toBeVisible();
  view.rerender(<GeoMonitoringAutomation project={{...p,coverageDays:180}}/>);
  expect(screen.getByRole('heading',{name:'尚未开启自动监测'})).toBeVisible();
  expect(screen.getByText(/当前引擎或覆盖窗口已经变化/)).toBeVisible();
});

it('allows stopping confirmed automation while the project is paused',async()=>{
  const p=geoProject({monitoring:'done'},{status:'paused'});
  p.steps.monitoring!.automation={state:'confirmed',actorId:'actor',at:'2026-10-31T10:00:00Z',engines:[...p.engines],coverageDays:p.coverageDays};
  render(<GeoMonitoringAutomation project={p}/>);
  await userEvent.click(screen.getByRole('button',{name:'停止自动监测'}));
  await waitFor(()=>expect(api.set).toHaveBeenCalledWith('geo_1',false));
  expect(screen.queryByRole('button',{name:'开始自动监测'})).toBeNull();
});
