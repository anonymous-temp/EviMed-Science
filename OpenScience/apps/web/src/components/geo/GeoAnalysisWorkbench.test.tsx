import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { GeoAnalysisWorkbench } from './GeoAnalysisWorkbench';
const read=vi.hoisted(()=>vi.fn());
const navigation=vi.hoisted(()=>({open:vi.fn(),create:vi.fn(),current:vi.fn(),stage:vi.fn()}));
vi.mock('@/lib/geoAnalysisClient',()=>({getGeoAnalysis:read}));
vi.mock('./useOpenGeoConversation',()=>({useOpenGeoConversation:()=>navigation.open}));
vi.mock('@/lib/apiClient',async original=>({...await original<typeof import('@/lib/apiClient')>(),createWebRuntimeSession:navigation.create}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoProject:navigation.current,stageGeoPlanContext:navigation.stage}));
vi.mock('@/components/document/DocumentExportActions',()=>({DocumentExportActions:({source}:{source:unknown})=><div data-testid="export">{JSON.stringify(source)}</div>}));
vi.mock('./geoFrame',()=>({useGeoReadScope:()=>({round:'old'}),useGeoFrame:()=>null}));
const project={projectId:'control',sessionId:'session'};
describe('selected analysis workbench',()=>{
 it('retains exact selection through export and shows null distinct from zero',async()=>{
  read.mockResolvedValue({view:{viewId:'V01',metricId:null,dimension:'project'},selection:{reference:'gsel_old'},digest:'digest',columns:[{key:'current',label:'所选实测'},{key:'target',label:'当前目标'}],rows:[{key:'row',label:'品牌',metricId:'M-01S',dimensions:{},values:{current:{value:0,state:'known',metric:null,members:null},target:{value:null,state:'no_data',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'ready'}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never}/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V01',dimension:'project'},0,undefined));
  expect(await screen.findByText('未测')).toBeTruthy();
  expect(screen.getByText('0%')).toBeTruthy();
  expect(screen.getByTestId('export').textContent).toContain('gsel_old');
  expect(screen.getByTestId('export').textContent).toContain('digest');
 });
});


it('labels each series visibly instead of overlapping indistinguishable platform lines',async()=>{
  read.mockResolvedValue({view:{viewId:'V02',metricId:'M-01',dimension:'engine'},selection:{reference:'gsel_trend'},digest:'digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'},chart:{labels:['2026-10-01','2026-10-02'],series:[{key:'one',label:'品牌提及率 · deepseek',engine:'deepseek',values:[0,10]},{key:'two',label:'品牌提及率 · kimi',engine:'kimi',values:[50,60]},{key:'three',label:'品牌提及率 · doubao',engine:'doubao',values:[80,90]}]}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V02"/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  expect(await screen.findByRole('heading',{name:/品牌提及率.*DeepSeek/})).toBeTruthy();
  expect(screen.getByRole('heading',{name:/品牌提及率.*Kimi/})).toBeTruthy();
  expect(screen.getByRole('heading',{name:/品牌提及率.*豆包/})).toBeTruthy();
});

it('creates the intended ordinary session then stages the exact analysis and unsent draft on the first click',async()=>{
  navigation.open.mockReset().mockResolvedValue(true);
  navigation.current.mockResolvedValue({projectId:'control',sessionId:null});
  navigation.create.mockReset().mockResolvedValue({id:'created-session',kernel:'dsh'});
  navigation.stage.mockReset().mockImplementation(async (_geo,input)=>({referenceId:'gpc_exact',sessionId:input.sessionId,draft:'Selected unsent analysis'}));
  read.mockResolvedValue({view:{viewId:'V01',dimension:'project'},selection:{reference:'gsel_first'},digest:'exact-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={{...project,sessionId:null} as never}/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  fireEvent.click(await screen.findByRole('button',{name:'在对话中解释'}));
  await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({sessionId:'created-session',mode:'analysis',selectionRef:'gsel_first',expectedDigest:'exact-digest'})));
  expect(navigation.create).toHaveBeenCalledWith('control');
  expect(navigation.open).toHaveBeenCalledTimes(1);
  expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({projectId:'control',sessionId:'created-session',geoPlanContext:{referenceId:'gpc_exact'}}),'Selected unsent analysis');
});


it('retains the selected analysis with a recoverable error if first-session creation fails',async()=>{
  navigation.open.mockReset();navigation.stage.mockReset();
  navigation.current.mockResolvedValue({projectId:'control',sessionId:null});
  navigation.create.mockRejectedValueOnce(new Error('Session temporarily unavailable'));
  read.mockResolvedValue({view:{viewId:'V01',dimension:'project'},selection:{reference:'gsel_retry'},digest:'retry-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={{...project,sessionId:null} as never}/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  fireEvent.click(await screen.findByRole('button',{name:'在对话中解释'}));
  expect(await screen.findByRole('button',{name:'刷新分析'})).toBeTruthy();
  expect(navigation.stage).not.toHaveBeenCalled();expect(navigation.open).not.toHaveBeenCalled();
  expect(screen.getByTestId('export').textContent).toContain('gsel_retry');
  expect(screen.getByRole('button',{name:'在对话中解释'})).not.toBeDisabled();
});
