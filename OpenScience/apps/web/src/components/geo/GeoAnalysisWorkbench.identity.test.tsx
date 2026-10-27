import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { GeoAnalysisDescriptor } from '@/lib/geoAnalysisClient';
import { GeoFrameHarness } from './__fixtures__/geoFrameHarness';
import { GeoAnalysisWorkbench } from './GeoAnalysisWorkbench';
vi.mock('./GeoAnalysisMembersDrawer',()=>({GeoAnalysisMembersDrawer:()=> <div role="dialog" aria-label="成员面板">Old exact members</div>}));
vi.mock('./tabs/SourceRelationship',()=>({SourceRelationship:()=> <div role="dialog" aria-label="关系面板">Old exact relationship</div>}));
const interactions=vi.hoisted(()=>({export:vi.fn(),chart:vi.fn(),current:vi.fn()}));
vi.mock('./GeoAnalysisVisual',()=>({GeoAnalysisVisual:({onSelect}:{onSelect:(cell:{rowKey:string;columnKey:string})=>void})=>{interactions.chart(onSelect);return <button onClick={()=>onSelect({rowKey:'row',columnKey:'missing'})}>图表回到首批</button>;}}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoProject:interactions.current}));
const read = vi.hoisted(() => vi.fn());
const scope = vi.hoisted(() => ({value:{round:'old'}}));
vi.mock('@/lib/geoAnalysisClient', () => ({getGeoAnalysis:read}));
vi.mock('./geoFrame', async original => ({...await original<typeof import('./geoFrame')>(),useGeoReadScope:()=>scope.value}));
vi.mock('@/components/document/DocumentExportActions', () => ({DocumentExportActions:({source}:{source:unknown})=><><output data-testid="export-identity">{JSON.stringify(source)}</output><button onClick={()=>interactions.export(source)}>导出精确范围</button></>}));
vi.mock('./useOpenGeoConversation', () => ({useOpenGeoConversation:()=>vi.fn()}));
const project = {projectId:'control',sessionId:'session'} as never;
const result = (view:GeoAnalysisDescriptor, ref:string, label:string) => ({view,selection:{reference:ref},digest:`digest-${ref}`,columns:[],rows:[{key:label,label,metricId:null,dimensions:{},values:{}}],page:{total:4,shown:2,nextOffset:2},availability:{status:'ready'}});
const tree = (view:GeoAnalysisDescriptor, geoId='geo', shown=true) => <MemoryRouter>{shown && <GeoAnalysisWorkbench geoId={geoId} project={project} mainArea={{descriptor:view,onChange:vi.fn()}} />}</MemoryRouter>;
beforeEach(()=>{Object.values(interactions).forEach(mock=>mock.mockClear());scope.value={round:'old'};read.mockReset().mockImplementation(async (_id,selected,view)=>result(view,selected.selectionRef??selected.round,'Current rows'));});

it.each(['scope','descriptor','project','return'] as const)('drops the old pagination identity on %s change and ignores its late reply',async change=>{
  const view:GeoAnalysisDescriptor={viewId:'V01',metricId:'M-01'};
  const mounted=render(tree(view));
  await screen.findByText('Current rows');
  let finish!:(value:unknown)=>void;
  read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole('button',{name:'下一批数据'}));
  await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{selectionRef:'old'},view,2,'digest-old'));
  let nextView=view, nextGeo='geo';
  if(change==='scope') scope.value={round:'new'};
  if(change==='descriptor') nextView={...view,metricId:'M-06'};
  if(change==='project') nextGeo='geo-other';
  if(change==='return') mounted.rerender(tree(view,'geo',false));
  read.mockImplementation(async (_id,_selected,next)=>result(next,'new-selection',`New ${change} rows`));
  mounted.rerender(tree(nextView,nextGeo));
  await screen.findByText(`New ${change} rows`);
  expect(read).toHaveBeenLastCalledWith(nextGeo,scope.value,nextView,0,undefined);
  expect(screen.getByTestId('export-identity')).toHaveTextContent('new-selection');
  await act(async()=>{finish(result(view,'old','Obsolete late page'));});
  expect(screen.queryByText('Obsolete late page')).toBeNull();
  expect(screen.getByTestId('export-identity')).toHaveTextContent('new-selection');
});

it('invalidates pagination and isolates a late old-page reply when an external same-view source search changes',async()=>{
  const view:GeoAnalysisDescriptor={viewId:'V18',sourceSearch:'before'};
  const mounted=render(tree(view));await screen.findByText('Current rows');
  let finish!:(value:unknown)=>void;read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole('button',{name:'下一批数据'}));
  await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{selectionRef:'old'},view,2,'digest-old'));
  const next={...view,sourceSearch:'after'};
  read.mockImplementation(async (_id,_scope,descriptor)=>result(descriptor,'new-search','New search rows'));
  mounted.rerender(tree(next));
  await screen.findByText('New search rows');
  expect(read).toHaveBeenLastCalledWith('geo',scope.value,next,0,undefined);
  await act(async()=>{finish(result(view,'old','Obsolete search page'));});
  expect(screen.queryByText('Obsolete search page')).toBeNull();
  expect(screen.getByTestId('export-identity')).toHaveTextContent('new-search');
});


it('keeps stale rows readable but locks pagination, chart fallback, export and explanation until the new exact search resolves',async()=>{
 const before:GeoAnalysisDescriptor={viewId:'V18',sourceSearch:'before'},after={...before,sourceSearch:'after'};
 let finish!:(value:unknown)=>void;
 read.mockImplementation(async (_geo,selected,view)=>{
   if(view.sourceSearch==='after') {
     if(selected.selectionRef==='old')throw new Error('409 digest mismatch: old selection cannot serve the new descriptor');
     return await new Promise(resolve=>{finish=resolve;});
   }
   return result(view,'old','Preserved old source rows');
 });
 const host=(view:GeoAnalysisDescriptor)=><MemoryRouter><GeoFrameHarness project={project} geoId="geo" tab="sources"><GeoAnalysisWorkbench geoId="geo" project={project} mainArea={{descriptor:view,onChange:vi.fn()}}/></GeoFrameHarness></MemoryRouter>;
 const mounted=render(host(before));await screen.findByText('Preserved old source rows');
 mounted.rerender(host(after));
 expect(await screen.findByText(/以下仍为上次范围/)).toBeVisible();expect(screen.getByText('Preserved old source rows')).toBeVisible();
 const requests=read.mock.calls.length;
 fireEvent.click(screen.getByRole('button',{name:'下一批数据'}));
 fireEvent.click(screen.getByRole('button',{name:'导出精确范围'}));
 fireEvent.click(screen.getByRole('button',{name:'在对话中解释'}));
 act(()=>interactions.chart.mock.lastCall![0]({rowKey:'row',columnKey:'missing'}));
 expect(read).toHaveBeenCalledTimes(requests);expect(interactions.export).not.toHaveBeenCalled();expect(interactions.current).not.toHaveBeenCalled();
 expect(read.mock.calls.every(call=>call[2].sourceSearch!=='after'||call[1].selectionRef!=='old')).toBe(true);
 await act(async()=>{finish(result(after,'new','New exact source rows'));});
 expect(await screen.findByText('New exact source rows')).toBeVisible();expect(screen.queryByText(/以下仍为上次范围/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'导出精确范围'}));expect(interactions.export).toHaveBeenLastCalledWith(expect.objectContaining({selectionRef:'new',view:after,expectedDigest:'digest-new'}));
});


it.each(['paging','search'] as const)('retains readable old results on %s failure, reports failure and unlocks only after an exact retry',async operation=>{
 const view:GeoAnalysisDescriptor={viewId:'V18',sourceSearch:'before'};
 const mounted=render(tree(view));await screen.findByText('Current rows');
 read.mockRejectedValueOnce(new Error('Upstream read unavailable'));
 const activeView=operation==='search'?{...view,sourceSearch:'after'}:view;
 if(operation==='search')mounted.rerender(tree(activeView));else fireEvent.click(screen.getByRole('button',{name:'下一批数据'}));
 expect(await screen.findByText(/读取失败，以下仍为上次已读范围/)).toBeVisible();
 expect(screen.getByText('Current rows')).toBeVisible();expect(screen.queryByText(/正在读取新筛选结果/)).toBeNull();
 expect(screen.getByRole('button',{name:'下一批数据'})).toBeDisabled();
 expect(screen.getByText('暂时无法读取，请稍后重试。')).toBeVisible();
 const calls=read.mock.calls.length;act(()=>interactions.chart.mock.lastCall![0]({rowKey:'row',columnKey:'missing'}));expect(read).toHaveBeenCalledTimes(calls);
 read.mockImplementation(async (_geo,_selected,descriptor)=>result(descriptor,'retry-exact','Recovered exact rows'));
 fireEvent.click(screen.getByRole('button',{name:'重试读取分析'}));
 expect(await screen.findByText('Recovered exact rows')).toBeVisible();expect(screen.queryByText(/读取失败，以下/)).toBeNull();
 expect(read).toHaveBeenLastCalledWith('geo',scope.value,activeView,0,undefined);expect(screen.getByRole('button',{name:'下一批数据'})).toBeEnabled();
});

it.each(['members','relationship'] as const)('closes an open %s panel as soon as source-search debounce locks the old results',async panel=>{
 const view:GeoAnalysisDescriptor={viewId:panel==='relationship'?'V20':'V18'};
 read.mockImplementation(async()=>({...result(view,'old','Current rows'),rows:[{key:'row',label:'Source relation',metricId:null,dimensions:panel==='relationship'?{kind:'source_relationship',annotationContext:{pages:[{url:'https://example.org/page',recordIndex:0}],records:[{relation:'owned',origin:'user',reference:{id:'r1',revision:1}}]}}:{},values:{}}]}));
 const changed=vi.fn();
 render(<MemoryRouter><GeoFrameHarness project={project} geoId="geo" tab="sources"><GeoAnalysisWorkbench geoId="geo" project={project} mainArea={{descriptor:view,onChange:changed}}/></GeoFrameHarness></MemoryRouter>);
 await screen.findByText('Source relation');
 if(panel==='members')act(()=>interactions.chart.mock.lastCall![0]({rowKey:'row',columnKey:'x',members:{rowKey:'row'}}));
 else {fireEvent.click(screen.getByText('当前关系注释与编辑'));fireEvent.click(screen.getByRole('button',{name:/https:\/\/example.org\/page/}));}
 expect(screen.getByRole('dialog',{name:panel==='members'?'成员面板':'关系面板'})).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索引用来源'),{target:{value:'different source'}});
 expect(screen.queryByRole('dialog')).toBeNull();expect(changed).not.toHaveBeenCalled();
 expect(screen.getByText(/以下仍为上次范围/)).toBeVisible();
});

it('keeps frozen plan version as explicit navigation without counting it as a query filter or changing scope',async()=>{
 function Host(){const [view,setView]=useState<GeoAnalysisDescriptor>({viewId:'V26',strategyVersion:7,targetVersion:3});return <GeoFrameHarness project={project} geoId="geo" tab="plan"><GeoAnalysisWorkbench geoId="geo" project={project} mainArea={{descriptor:view,onChange:setView}}/></GeoFrameHarness>;}
 render(<MemoryRouter><Host/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'方案版本：方案版本 7'}));
 expect(screen.queryByRole('button',{name:/^筛选/})).toBeNull();expect(screen.queryByRole('button',{name:'清除筛选'})).toBeNull();
 fireEvent.click(screen.getByRole('menuitemradio',{name:'所选范围最新方案'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',scope.value,{viewId:'V26',strategyVersion:undefined,targetVersion:undefined},0,undefined));
 expect(scope.value).toEqual({round:'old'});expect(screen.queryByRole('button',{name:'清除筛选'})).toBeNull();
});
