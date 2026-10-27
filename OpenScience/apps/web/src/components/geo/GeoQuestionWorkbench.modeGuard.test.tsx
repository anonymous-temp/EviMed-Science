import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { UnsavedRouteGuard } from '@/app/layout/UnsavedRouteGuard';
import { GeoQuestionWorkbench } from './GeoQuestionWorkbench';
import { QuestionsTab } from './tabs/QuestionsTab';
import { geoProject } from './__fixtures__/geoTabs';
import type { GeoQuestions } from '@/lib/geoClient';
vi.mock('@/lib/apiClient',async original=>({...await original<typeof import('@/lib/apiClient')>(),fetchWebMe:async()=>({user:{id:'u1'},tenant:{id:'t1'}})}));
vi.mock('./useOpenGeoConversation',()=>({useOpenGeoConversation:()=>vi.fn()}));
const operations=vi.hoisted(()=>({previewGeoQuestions:vi.fn(),importGeoQuestions:vi.fn(),getGeoQuestions:vi.fn(),getGeoClusters:vi.fn()}));
vi.mock('@/lib/geoQuestionWorkbenchClient',async original=>({...await original<typeof import('@/lib/geoQuestionWorkbenchClient')>(),previewGeoQuestions:operations.previewGeoQuestions,importGeoQuestions:operations.importGeoQuestions}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoQuestions:operations.getGeoQuestions,getGeoClusters:operations.getGeoClusters}));
const NativeRequest=globalThis.Request;
beforeAll(()=>{globalThis.Request=class extends NativeRequest{constructor(input:RequestInfo|URL,init?:RequestInit){super(input,init?{...init,signal:undefined}:init);}};});
afterAll(()=>{globalThis.Request=NativeRequest;});
const questions:GeoQuestions={sets:[],version:3,contract:{samplingMode:'one_shot',repeats:1,engines:['kimi'],metricIds:['M-01S'],reportPresentation:'summary',sourceBasis:'answers'},groups:[{id:'g',name:'Original group',pool:null,typicalQuestion:'',journeyStage:null,audience:null,weight:null,isControl:false,signal:null,questions:[{id:'q',originalId:'001',text:'Original question',kind:'client',platform:null,sourceUrl:null,isMeasured:true}]}]};
function Host(){const location=useLocation();return <><UnsavedRouteGuard/>{new URLSearchParams(location.search).has('analysis')?<h1>Analysis destination</h1>:<GeoQuestionWorkbench geoId="g1" project={geoProject()} data={questions} onSaved={vi.fn()}/>}</>;}
it('keeps actual original rows, focus and version through cancelled query-mode exits, including back and forward',async()=>{
 window.localStorage.clear();window.sessionStorage.clear();
 const router=createMemoryRouter([{path:'/questions',element:<Host/>}],{initialEntries:['/questions?analysis=V01','/questions?questionVersion=3','/questions?analysis=V26'],initialIndex:1});
 render(<RouterProvider router={router}/>);
 fireEvent.click(screen.getByRole('button',{name:'编辑为新版本'}));
 const input=await screen.findByLabelText('第 1 题文本');fireEvent.change(input,{target:{value:'Unsaved exact original'}});
 await act(()=>router.navigate('/questions?questionMode=edit&questionVersion=3&sourceSearch=allowed',{replace:true}));
 expect(screen.queryByRole('alertdialog')).toBeNull();expect(input).toHaveValue('Unsaved exact original');
 for(const direction of [-1,1]){
  input.focus();await act(()=>router.navigate(direction));
  expect(screen.getByRole('alertdialog')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'取消'}));
  expect(input).toHaveValue('Unsaved exact original');expect(input).toHaveFocus();expect(router.state.location.search).toContain('questionVersion=3');
 }
 await act(()=>router.navigate('/questions?questionMode=edit&analysis=V26'));
 fireEvent.click(screen.getByRole('button',{name:'放弃修改并离开'}));
 expect(await screen.findByRole('heading',{name:'Analysis destination'})).toBeVisible();
 await act(()=>router.navigate(-1));
 fireEvent.click(screen.getByRole('button',{name:'返回问题列表'}));
 fireEvent.click(screen.getByRole('button',{name:'导入问句'}));
 await waitFor(()=>expect(screen.queryByLabelText('第 1 题文本')).toBeNull());
 expect(questions.version).toBe(3);expect(questions.groups[0].questions[0].text).toBe('Original question');
});


function TabHost(){const location=useLocation();return <><UnsavedRouteGuard/>{new URLSearchParams(location.search).has('analysis')?<h1>Analysis destination</h1>:<QuestionsTab geoId="g1" project={geoProject()}/>}</>;}
it('offers exact unknown-save recovery in the real QuestionsTab both in-place and after an analysis round trip',async()=>{
 window.localStorage.clear();window.sessionStorage.clear();
 operations.getGeoQuestions.mockResolvedValue(questions);operations.getGeoClusters.mockResolvedValue({engines:[],groups:[]});
 operations.previewGeoQuestions.mockImplementation(async (_id,input)=>({...input,actualRows:1,measuredRows:1,plannedCalls:1,duplicateCandidates:[]}));
 operations.importGeoQuestions.mockRejectedValueOnce(new Error('Unknown server result')).mockResolvedValueOnce({version:4});
 const router=createMemoryRouter([{path:'/questions',element:<TabHost/>}],{initialEntries:['/questions?questionVersion=3&session=s1']});
 render(<RouterProvider router={router}/>);
 fireEvent.click(await screen.findByRole('button',{name:'编辑为新版本'}));
 await screen.findByLabelText('第 1 题文本');fireEvent.click(screen.getByRole('button',{name:'核对导入预览'}));
 fireEvent.click(await screen.findByRole('button',{name:'保存为新版本'}));await screen.findByRole('alert');
 const original=operations.importGeoQuestions.mock.calls[0][1];
 const close=async()=>{fireEvent.click(screen.getByRole('button',{name:'返回问题列表'}));fireEvent.click(await screen.findByRole('button',{name:'放弃修改'}));await screen.findByRole('button',{name:'继续核查上次保存'});};
 await close();fireEvent.click(screen.getByRole('button',{name:'继续核查上次保存'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue(original.rows[0].text);expect(screen.getByRole('button',{name:'保存为新版本'})).toBeVisible();
 expect(operations.importGeoQuestions).toHaveBeenCalledTimes(1);expect(operations.previewGeoQuestions).toHaveBeenCalledTimes(1);
 await close();await act(()=>router.navigate('/questions?questionVersion=3&session=s1&analysis=V26'));
 expect(await screen.findByRole('heading',{name:'Analysis destination'})).toBeVisible();
 await act(()=>router.navigate(-1));
 fireEvent.click(await screen.findByRole('button',{name:'继续核查上次保存'}));
 expect(screen.getByLabelText('第 1 题文本')).toHaveValue(original.rows[0].text);expect(screen.getByRole('button',{name:'保存为新版本'})).toBeVisible();
 expect(operations.importGeoQuestions).toHaveBeenCalledTimes(1);expect(operations.previewGeoQuestions).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'保存为新版本'}));
 await waitFor(()=>expect(operations.importGeoQuestions).toHaveBeenCalledTimes(2));
 expect(operations.importGeoQuestions.mock.calls[1][1]).toEqual(original);
 expect(router.state.location.search).toContain('session=s1');
});
