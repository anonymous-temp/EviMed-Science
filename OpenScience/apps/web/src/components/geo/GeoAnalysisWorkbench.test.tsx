import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { GeoAnalysisWorkbench } from './GeoAnalysisWorkbench';
const read=vi.hoisted(()=>vi.fn());
const memberRead=vi.hoisted(()=>vi.fn());
const navigation=vi.hoisted(()=>({open:vi.fn(),create:vi.fn(),current:vi.fn(),stage:vi.fn(),scope:vi.fn()}));
vi.mock('@/lib/geoAnalysisClient',()=>({getGeoAnalysis:read,getGeoAnalysisMembers:memberRead}));
vi.mock('./useOpenGeoConversation',()=>({useOpenGeoConversation:()=>navigation.open}));
vi.mock('@/lib/apiClient',async original=>({...await original<typeof import('@/lib/apiClient')>(),createWebRuntimeSession:navigation.create}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoProject:navigation.current,stageGeoPlanContext:navigation.stage}));
vi.mock('@/components/document/DocumentExportActions',()=>({DocumentExportActions:({source}:{source:unknown})=><div data-testid="export">{JSON.stringify(source)}</div>}));
vi.mock('./geoFrame',()=>({useGeoReadScope:()=>({round:'old'}),useGeoFrame:()=>({openAnalysisScope:navigation.scope})}));
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

it('keeps answer and statement count units separate and opens exact paginated members',async()=>{
 const member={selectionRef:'gsel_clinical',view:{viewId:'V12',dimension:'project'},rowKey:'statements',columnKey:'correct',expectedDigest:'clinical-digest',unit:'statements',total:21,exact:true};
 read.mockResolvedValue({view:member.view,selection:{reference:member.selectionRef},digest:member.expectedDigest,columns:[{key:'correct',label:'正确'},{key:'not_applicable',label:'无临床陈述'}],rows:[{key:'statements',label:'陈述级正确性',metricId:null,dimensions:{unit:'statements'},values:{correct:{value:21,state:'known',unit:'statements',metric:null,members:member},not_applicable:{value:null,state:'unknown',reason:'no_validated_applicability_assessment',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'partial',reasons:['statement_not_applicable_not_a_verdict']}});
 memberRead.mockImplementation(async(_id,_member,offset)=>({unit:'statements',total:21,items:[{id:`s${offset}`,unit:'statements',snapshotId:'answer-exact',statement:{text:`Exact sentence ${offset}`,verdict:'wrong',evidence:'Source quote',claimVersion:2,applicability:{population:'Adults'}},answer:{answer_text:'Complete original answer',asked_at:null,surface:{mode:'web'},citations:[{url:'https://example.org/source'}]}}],nextOffset:offset===0?20:null}));
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V12"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));fireEvent.click(await screen.findByRole('button',{name:'21 陈述'}));
 expect(await screen.findByText('Exact sentence 0')).toBeTruthy();
 expect(memberRead).toHaveBeenLastCalledWith('geo',member,0);
 expect(screen.getByRole('link',{name:'查看原始回答与依据'}).getAttribute('href')).toContain('answer-exact');
 fireEvent.click(screen.getByRole('button',{name:'下一批'}));
 expect(await screen.findByText('Exact sentence 20')).toBeTruthy();expect(memberRead).toHaveBeenLastCalledWith('geo',member,20);
 expect(screen.getByTestId('export').textContent).toContain('gsel_clinical');
});

it('missing-task members link to the existing recovery workbench while preserving scope and session',async()=>{
 const member={selectionRef:'gsel_jobs',view:{viewId:'V07',dimension:'project'},rowKey:'q1',columnKey:'not_obtained',expectedDigest:'job-digest',unit:'asks',total:1,exact:true};
 read.mockResolvedValue({view:member.view,selection:{reference:member.selectionRef},digest:member.expectedDigest,columns:[{key:'not_obtained',label:'未取得回答'}],rows:[{key:'q1',label:'Original',metricId:null,dimensions:{},values:{not_obtained:{value:1,state:'known',unit:'asks',metric:null,members:member}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'ready'}});
 memberRead.mockResolvedValue({unit:'asks',total:1,items:[{id:'job',unit:'asks',roundId:'actual-round',status:'failed',reason:'timeout'}],nextOffset:null});
 render(<MemoryRouter initialEntries={['/app/geo/geo/diagnosis?from=2026-10-01&to=2026-10-02&session=current-session']}><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V07"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));fireEvent.click(await screen.findByRole('button',{name:'1 任务'}));
 const href=(await screen.findByRole('link',{name:'查看采集进度与恢复选项'})).getAttribute('href');expect(href).toContain('diagnosisRound=actual-round');expect(href).toContain('session=current-session');expect(href).toContain('from=2026-10-01');
});

it('reloads the actual platform metric, exact generic entity and round grain through the closed descriptor',async()=>{
 read.mockReset().mockImplementation(async(_geo,_scope,view)=>({view,selection:{reference:'gsel_switch'},digest:'switch-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}}));
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={{...project,product:{genericName:'Generic'}} as never} initialView="V04"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));
 fireEvent.click(await screen.findByRole('button',{name:'指标：品牌提及率'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'事实准确率'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V04',metricId:'M-06'}),0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'实体：品牌指标'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'当前配置通用名：Generic'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V04',entityKind:'generic',entityKey:'Generic',metricId:null}),0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'分析：平台指标比较'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'指标趋势'}));
 fireEvent.click(await screen.findByRole('button',{name:'时间粒度：按实测日期'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'按实际轮次'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V02',timeGrain:'round'}),0,undefined));
});

it('identifies a renamed generic as current configuration while retaining unknown historical extraction',async()=>{
 const view={viewId:'V04',entityKind:'generic',entityKey:'Renamed',dimension:'engine'};
 read.mockResolvedValue({view,selection:{reference:'gsel_historical'},digest:'historical-digest',columns:[{key:'unknown',label:'实体提取未能定位'}],rows:[{key:'historical',label:'当前配置通用名：Renamed · 提及回答 · deepseek',metricId:null,dimensions:{engine:'deepseek',entityKey:'Renamed',entityKind:'generic'},values:{unknown:{value:50,state:'known',unit:'answers',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'partial',reasons:['generic_observation_identity_only']}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={{...project,product:{genericName:'Renamed'}} as never} initialView="V04"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));
 expect(await screen.findByText(/当前配置通用名：Renamed.*提及回答/)).toBeTruthy();
 expect(screen.getByText(/通用名来自当前配置，不代表所选历史轮次的登记名称/)).toBeTruthy();
 expect(screen.getByText('50 回答')).toBeTruthy();
 expect(screen.getByTestId('export').textContent).toContain('Renamed');
});

it('V03 keeps a working comparison action and both exact period member requests',async()=>{
 const view={viewId:'V03',metricId:'M-01',dimension:'engine'},member=(columnKey:string)=>({selectionRef:'gsel_compare',view,rowKey:'compared',columnKey,expectedDigest:'compare-digest',unit:'answers',total:1,exact:true});
 read.mockResolvedValue({view,selection:{reference:'gsel_compare'},digest:'compare-digest',columns:[{key:'previous',label:'对照实测'},{key:'current',label:'所选实测'},{key:'delta',label:'变化'}],rows:[{key:'compared',label:'品牌提及率',metricId:'M-01',dimensions:{},values:{previous:{value:0,state:'known',unit:'percent',metric:null,members:member('previous')},current:{value:20,state:'known',unit:'percent',metric:null,members:member('current')},delta:{value:null,state:'unknown',reason:'comparison_not_selected',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'partial',reasons:['comparison_not_selected']}});
 memberRead.mockResolvedValue({unit:'answers',total:1,items:[{id:'exact-snapshot',unit:'answers'}],nextOffset:null,digest:'compare-digest'});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V03" embedded/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'选择对照区间'}));expect(navigation.scope).toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'0 %'}));await waitFor(()=>expect(memberRead).toHaveBeenCalledWith('geo',expect.objectContaining({columnKey:'previous',expectedDigest:'compare-digest'}),0));
 expect(screen.getByTestId('export').textContent).toContain('gsel_compare');
});

it('V09 retains quoted conditions and independent units while staging the same selected unsent native context',async()=>{
 navigation.open.mockReset().mockResolvedValue(true);navigation.current.mockResolvedValue({projectId:'control',sessionId:'session-c3'});navigation.stage.mockReset().mockResolvedValue({referenceId:'gpc_c3',sessionId:'session-c3',draft:'Explain preserved expressions'});
 read.mockResolvedValue({view:{viewId:'V09',dimension:'project'},selection:{reference:'gsel_c3'},digest:'c3-digest',columns:[{key:'expressions',label:'表达数（互斥分类）'},{key:'answers',label:'独立回答数（分类间可重叠）'}],rows:[{key:'expression',label:'条件性推荐 · Alpha',metricId:null,dimensions:{kind:'expression',conditionQuote:'If adult',explicitPosition:null},values:{expressions:{value:2,state:'known',unit:'expressions',metric:null,members:null},answers:{value:1,state:'known',unit:'answers',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'partial'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V09"/></MemoryRouter>);fireEvent.click(screen.getByText('所选数据分析'));
 expect(await screen.findByText(/条件：If adult/)).toBeVisible();expect(screen.getByText('2 表达')).toBeVisible();expect(screen.getByText('1 回答')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'在对话中解释'}));
 await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({mode:'analysis',view:{viewId:'V09',dimension:'project'},selectionRef:'gsel_c3',expectedDigest:'c3-digest'})));
 expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({geoPlanContext:{referenceId:'gpc_c3'}}),'Explain preserved expressions');
 expect(screen.getByTestId('export')).toHaveTextContent('gsel_c3');
});

it('keeps source type, actual URL search and cooccurrence filters in the exact server descriptor',async()=>{
 read.mockReset().mockResolvedValue({view:{viewId:'V18',sourceLevel:'page'},selection:{reference:'gsel_sources'},digest:'sources-digest',definition:{sourceTypes:['news','forum','unknown']},columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V18"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));
 fireEvent.click(await screen.findByRole('button',{name:'来源类型'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'forum'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V18',sourceType:'forum'}),0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'共同出现：全部引用回答'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'共同出现我方错误'}));
 fireEvent.click(screen.getByRole('button',{name:'排名对象：域名'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'页面'}));
 const search=screen.getByRole('searchbox',{name:'搜索引用来源'});
 fireEvent.change(search,{target:{value:'s?id=251'}});
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({sourceType:'forum',sourceRelationship:'wrong',sourceLevel:'page',sourceSearch:'s?id=251'}),0,undefined));
 expect(screen.getByRole('searchbox',{name:'搜索引用来源'})).toBe(search);
 expect(screen.getByTestId('export').textContent).toContain('sources-digest');
});

it('opens preserved page actions with the exact selection and keeps the existing conversation context',async()=>{
 read.mockResolvedValue({view:{viewId:'V18',sourceLevel:'page'},selection:{reference:'gsel_page_action'},digest:'page-action',columns:[],rows:[{key:'page',label:'Actual page',metricId:null,dimensions:{sourceType:'news',sourceKey:'news.example/s?id=251',domain:'news.example',sourceId:'source-news',originalUrls:['https://news.example/s?id=251'],history:[]},values:{}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'ready'}});
 render(<MemoryRouter initialEntries={['/app/geo/geo/visibility?round=old&session=s1']}><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V18"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));fireEvent.click(await screen.findByText('原始引用地址与所选轮次'));
 for(const name of ['查看来源与行动','将此页面用于方案']){
  const href=screen.getByRole('link',{name}).getAttribute('href')!;const query=new URL(href,'https://geo.invalid').searchParams;
  expect(query.get('selectionRef')).toBe('gsel_page_action');expect(query.get('session')).toBe('s1');expect(query.has('round')).toBe(false);
 }
 expect(new URL(screen.getByRole('link',{name:'将此页面用于方案'}).getAttribute('href')!,'https://geo.invalid').searchParams.get('planUrl')).toBe('https://news.example/s?id=251');
});
