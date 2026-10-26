import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeoAnalysisWorkbench } from './GeoAnalysisWorkbench';
const read=vi.hoisted(()=>vi.fn());
const memberRead=vi.hoisted(()=>vi.fn());
const navigation=vi.hoisted(()=>({open:vi.fn(),create:vi.fn(),current:vi.fn(),stage:vi.fn(),scope:vi.fn(),publication:vi.fn()}));
vi.mock('@/lib/geoAnalysisClient',()=>({getGeoAnalysis:read,getGeoAnalysisMembers:memberRead}));
vi.mock('./spine/useOpenPublication',()=>({useOpenPublication:()=>navigation.publication}));
vi.mock('./useOpenGeoConversation',()=>({useOpenGeoConversation:()=>navigation.open}));
vi.mock('@/lib/geoNativeClient',async original=>({...await original<typeof import('@/lib/geoNativeClient')>(),openGeoConversation:navigation.create}));
vi.mock('@/lib/geoClient',async original=>({...await original<typeof import('@/lib/geoClient')>(),getGeoProject:navigation.current,stageGeoPlanContext:navigation.stage}));
vi.mock('@/components/document/DocumentExportActions',()=>({DocumentExportActions:({source}:{source:unknown})=><div data-testid="export">{JSON.stringify(source)}</div>}));
vi.mock('./geoFrame',async original=>({...await original<typeof import('./geoFrame')>(),useGeoReadScope:()=>({round:'old'}),useGeoFrame:()=>({openAnalysisScope:navigation.scope})}));
const project={projectId:'control',sessionId:'session'};
it('opens both history views and keeps metric selection on the business timeline in the existing workbench',async()=>{
 read.mockReset().mockImplementation(async(_geo,_scope,view)=>({view,selection:{reference:'gsel_history'},digest:'history-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}}));
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V15"/></MemoryRouter>);
 fireEvent.click(screen.getByText('所选数据分析'));
 fireEvent.click(await screen.findByRole('button',{name:'分析：错误观察与处理历史'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'事件与采样观察'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V27'}),0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'指标：品牌提及率'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'事实准确率'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V27',metricId:'M-06'}),0,undefined));
 expect(screen.getByTestId('export')).toHaveTextContent('gsel_history');
});
beforeEach(()=>{navigation.create.mockReset().mockImplementation(async(_geo,target)=>({projectId:'control',sessionId:target.sessionId??'created-session',scope:{kind:'geo',geoProjectId:'geo',sessionId:target.sessionId??'created-session'}}));});
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

it('resolves the exact GEO primary then stages the exact analysis and unsent draft on the first click',async()=>{
  navigation.open.mockReset().mockResolvedValue(true);
  navigation.current.mockResolvedValue({projectId:'control',sessionId:null});
  navigation.create.mockReset().mockResolvedValue({projectId:'control',sessionId:'created-session',scope:{kind:'geo',geoProjectId:'geo',sessionId:'created-session'}});
  navigation.stage.mockReset().mockImplementation(async (_geo,input)=>({referenceId:'gpc_exact',sessionId:input.sessionId,draft:'Selected unsent analysis'}));
  read.mockResolvedValue({view:{viewId:'V01',dimension:'project'},selection:{reference:'gsel_first'},digest:'exact-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={{...project,sessionId:null} as never}/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  fireEvent.click(await screen.findByRole('button',{name:'在对话中解释'}));
  await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({sessionId:'created-session',mode:'analysis',selectionRef:'gsel_first',expectedDigest:'exact-digest'})));
  expect(navigation.create).toHaveBeenCalledWith('geo',{kind:'primary'});
  expect(navigation.open).toHaveBeenCalledTimes(1);
  expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({projectId:'control',sessionId:'created-session',geoPlanContext:{referenceId:'gpc_exact'}}),'Selected unsent analysis');
});


describe('what the role may do with the selected analysis',()=>{
 const access=(abilities:string[])=>({...project,access:{roles:['role'],abilities,owner:false}});
 const renderAs=async(who:unknown)=>{
  read.mockResolvedValue({view:{viewId:'V01',dimension:'project'},selection:{reference:'gsel_role'},digest:'role-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'ready'}});
  render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={who as never}/></MemoryRouter>);
  fireEvent.click(screen.getByText('所选数据分析'));
  await waitFor(()=>expect(read).toHaveBeenCalled());
  await screen.findByText('所选数据分析');
 };
 it('shows a viewer the analysis, with neither the conversation nor the export',async()=>{
  await renderAs(access(['read']));
  await waitFor(()=>expect(screen.getByRole('button',{name:'首批数据'})).toBeTruthy());
  expect(screen.queryByRole('button',{name:'在对话中解释'})).toBeNull();
  expect(screen.queryByTestId('export')).toBeNull();
 });
 it('shows an editor both',async()=>{
  await renderAs(access(['read','run','edit']));
  expect(await screen.findByRole('button',{name:'在对话中解释'})).toBeTruthy();
  expect(screen.getByTestId('export').textContent).toContain('gsel_role');
 });
 it('offers a role that may run but not edit the export alone: the conversation takes both',async()=>{
  await renderAs(access(['read','run']));
  expect(await screen.findByTestId('export')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'在对话中解释'})).toBeNull();
 });
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
it('V19 chooses exact group facets and V22 stages categorical history with the same unsent context and five-format export source',async()=>{
 navigation.open.mockReset().mockResolvedValue(true);navigation.current.mockResolvedValue({projectId:'control',sessionId:'session-d2'});navigation.stage.mockReset().mockResolvedValue({referenceId:'gpc_d2',sessionId:'session-d2',draft:'Explain selected history'});
 read.mockResolvedValue({view:{viewId:'V19',sourceLevel:'page',sourceFacet:'group'},selection:{reference:'gsel_d2'},digest:'d2-digest',columns:[],rows:[{key:'group',label:'Source group',dimensions:{groupState:'known',groupName:'Same',groupId:'g-v1',setVersion:1},values:{}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'ready'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V19"/></MemoryRouter>);fireEvent.click(screen.getByText('所选数据分析'));
 const groupAction=new URL((await screen.findByRole('link',{name:'查看问题群与行动'})).getAttribute('href')!,'https://geo.invalid');expect(groupAction.searchParams.get('group')).toBe('g-v1');expect(groupAction.searchParams.get('selectionRef')).toBe('gsel_d2');
 fireEvent.click(await screen.findByRole('button',{name:'来源交叉维度：平台'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'版本化问题群'}));await waitFor(()=>expect(read).toHaveBeenLastCalledWith('geo',{round:'old'},expect.objectContaining({viewId:'V19',sourceFacet:'group'}),0,undefined));
 read.mockResolvedValue({view:{viewId:'V22',sourceLevel:'page'},selection:{reference:'gsel_history'},digest:'history-digest',columns:[{key:'observation',label:'页面观察状态'},{key:'transition',label:'可比观察变化'}],rows:[{key:'history',label:'Page · r3',metricId:null,dimensions:{kind:'source_history',sourceKey:'news.example/page',roundLabel:'第 3 轮',setVersion:1,questionId:'q1',mode:'web'},values:{observation:{value:'absent',state:'known',unit:'observations'},transition:{value:'no_longer_observed',state:'known',unit:'observations'}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'ready',reasons:['citation_history_selected_scope','citation_completeness_required']}});
 fireEvent.click(screen.getByRole('button',{name:/分析：来源与平台/}));fireEvent.click(screen.getByRole('menuitemradio',{name:'页面引用观察历史'}));
 expect(await screen.findByText('可观测未引用')).toBeVisible();expect(screen.getByText('同一可比范围内未再观察到')).toBeVisible();expect(screen.getByText(/采集端记录的引用列表完整性/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'在对话中解释'}));await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({selectionRef:'gsel_history',view:{viewId:'V22',sourceLevel:'page'},expectedDigest:'history-digest'})));
 expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({geoPlanContext:{referenceId:'gpc_d2'}}),'Explain selected history');expect(screen.getByTestId('export')).toHaveTextContent('history-digest');
});
it.each(['V19','V22'] as const)('%s retains loading, read error and empty states in the shared workbench',async(viewId)=>{
 read.mockImplementationOnce(()=>new Promise(()=>{}));const first=render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView={viewId} embedded/></MemoryRouter>);expect(first.container.querySelector('.animate-pulse')).toBeTruthy();first.unmount();
 read.mockRejectedValueOnce(new Error('Selected source read failed'));const failed=render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView={viewId} embedded/></MemoryRouter>);expect(await screen.findByRole('button',{name:'重试'})).toBeVisible();failed.unmount();
 read.mockResolvedValueOnce({view:{viewId},selection:{reference:'gsel_empty'},digest:'empty',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView={viewId} embedded/></MemoryRouter>);expect(await screen.findByText('这个范围尚无可用读数。')).toBeVisible();
});

it('V21 stages an unsent next-steps draft with exact row, metric and frozen gaps; keeps own configuration action for missing Y',async()=>{
 navigation.open.mockReset().mockResolvedValue(true);navigation.current.mockResolvedValue({projectId:'control',sessionId:'session'});
 navigation.stage.mockReset().mockResolvedValue({referenceId:'gpc_opportunity',sessionId:'session',draft:'Unsent exact group plan'});
 read.mockReset().mockResolvedValue({view:{viewId:'V21',dimension:'project',ownedMetricId:'M-08'},selection:{reference:'gsel_d3'},digest:'d'.repeat(64),columns:[{key:'owned',label:'登记自有 M-08'}],rows:[{key:'exact-row',label:'Same · v1',metricId:null,dimensions:{kind:'opportunity',groupId:'g1',setVersion:1,configureAction:{step:'sources',action:'configure_owned_sources'},gaps:{evidence:{state:'linked',items:[{id:'claim-1',version:1,statement:'Claim',quote:'Preserved source quote',sourceRef:'https://evidence.example/a',status:'active'}],action:{step:'evidence',groupId:'g1',setVersion:1}},source:{state:'observed',items:[{url:'https://shared.example/a?id=1'}],action:{step:'sources',groupId:'g1',setVersion:1}},content:{state:'linked',items:[{id:'article-old',resultVersionId:'001',digest:'a'.repeat(64)}],action:{step:'content',groupId:'g1',setVersion:1}}}},values:{owned:{value:null,state:'unknown',reason:'owned_not_registered',metric:null,members:null}}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'partial',reasons:['owned_not_registered']}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V21" embedded/></MemoryRouter>);
 const action=await screen.findByRole('button',{name:'按此问题群拟定方案'});fireEvent.click(action);
 await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({intent:'next_steps',mode:'strategy',selectionRef:'gsel_d3',expectedDigest:'d'.repeat(64),focus:{rowKey:'exact-row',columnKey:'owned'}})));
 expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({geoPlanContext:{referenceId:'gpc_opportunity'}}),'Unsent exact group plan');
 expect(screen.getByRole('link',{name:'登记自有发布地址'})).toBeTruthy();
 expect(screen.getByRole('link',{name:'https://shared.example/a?id=1'})).toHaveAttribute('href','https://shared.example/a?id=1');
 fireEvent.click(screen.getByRole('button',{name:/稿件 1 · 查看发布版本/}));expect(navigation.publication).toHaveBeenCalledWith('001','a'.repeat(64));
 fireEvent.click(screen.getByText('依据 1 · 第 1 版'));expect(screen.getByText('Preserved source quote')).toBeTruthy();
});

it('switches evidence perspectives while retaining the selected question scope',async()=>{
 read.mockResolvedValue({view:{viewId:'V16',evidenceKind:'claims'},selection:{reference:'gsel_evidence'},digest:'evidence',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V16" embedded/></MemoryRouter>);
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V16',dimension:'project'},0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'证据视角：结论与来源'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'发现表达'}));
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V16',dimension:'project',evidenceKind:'findings'},0,undefined));
});

it.each([['V10','journey_need','查看问题与采集'],['V16','clinical_source_support','查看或更新证据']] as const)('keeps %s object action on its exact saved selection without conflicting date/round filters',async(viewId,kind,label)=>{
 read.mockResolvedValue({view:{viewId},selection:{reference:'gsel_exact_action'},digest:'action',columns:[],rows:[{key:'one',label:'Exact object',dimensions:{kind,groupId:'group-old',groupState:'known',setVersion:1,applicability:{population:'Adults',elements:{dose:'10 mg'}}},values:{}}],page:{total:1,shown:1,nextOffset:null},availability:{status:'available'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView={viewId} embedded/></MemoryRouter>);
 const link=await screen.findByRole('link',{name:label});const url=new URL(link.getAttribute('href')!,'https://local.example');
 expect(url.searchParams.get('selectionRef')).toBe('gsel_exact_action');expect(url.searchParams.get('round')).toBeNull();expect(url.searchParams.has('?selectionRef')).toBe(false);
 if(viewId==='V10')expect(url.searchParams.get('group')).toBe('group-old');
});

it('switches error dimensions and withdrawn judgments without replacing the selected observation scope',async()=>{
 read.mockResolvedValue({view:{viewId:'V13'},selection:{reference:'gsel_errors'},digest:'errors',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V13" embedded/></MemoryRouter>);
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V13',dimension:'project'},0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'错误维度：错误类型'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'严重程度'}));
 fireEvent.click(screen.getByRole('button',{name:'判定状态：当前有效判定'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'已撤回判定'}));
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V13',dimension:'project',errorFacet:'severity',errorView:'withdrawn'},0,undefined));
});

it('switches content coverage grouping while retaining the exact selected observation scope',async()=>{
 read.mockResolvedValue({view:{viewId:'V23',publicationFacet:'group'},selection:{reference:'gsel_content'},digest:'content',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V23" embedded/></MemoryRouter>);
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V23',dimension:'project'},0,undefined));
 fireEvent.click(screen.getByRole('button',{name:'内容覆盖维度：问题群'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'预期渠道'}));
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V23',dimension:'project',publicationFacet:'channel'},0,undefined));
});

it('content and execution tables display localized object units',async()=>{
 const units=[['article_formats','内容文件格式'],['orders','订单'],['order_events','订单事件'],['error_records','错误记录']];
 read.mockReset().mockResolvedValue({view:{viewId:'V23'},selection:{reference:'gsel_units'},digest:'units',columns:units.map(([key])=>({key,label:key+' label'})),rows:[{key:'row',label:'Object counts',metricId:null,dimensions:{},values:Object.fromEntries(units.map(([unit])=>[unit,{value:2,state:'known',unit,members:null}]))}],page:{total:1,shown:1,nextOffset:null},availability:{status:'available'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V23" embedded/></MemoryRouter>);
 for(const [,label] of units)expect(await screen.findByText('2 '+label)).toBeVisible();
 for(const [unit] of units)expect(screen.queryByText('2 '+unit)).toBeNull();
});

it('switches ledger attribution without replacing the observation scope',async()=>{
 read.mockResolvedValue({view:{viewId:'V25',financeFacet:'ledger'},selection:{reference:'gsel_finance'},digest:'finance',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V25" embedded/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'收支维度：逐条账目与余额'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'明确关联的问题群'}));
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V25',dimension:'project',financeFacet:'group'},0,undefined));
});

it('keeps an exact historical plan descriptor for export and native explanation',async()=>{
 navigation.open.mockReset().mockResolvedValue(true);navigation.current.mockResolvedValue(project);navigation.stage.mockReset().mockResolvedValue({referenceId:'gpc_old_plan',sessionId:'session',draft:'Explain preserved plan'});
 const view={viewId:'V26' as const,strategyVersion:3,targetVersion:2};
 read.mockResolvedValue({view,selection:{reference:'gsel_current'},digest:'historical-digest',columns:[],rows:[],page:{total:0,shown:0,nextOffset:null},availability:{status:'empty'}});
 render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V26" initialDescriptor={view} embedded/></MemoryRouter>);
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},view,0,undefined));
 expect(screen.getByTestId('export').textContent).toContain('"strategyVersion":3');expect(screen.getByTestId('export').textContent).toContain('"targetVersion":2');
 fireEvent.click(screen.getByRole('button',{name:'在对话中解释'}));
 await waitFor(()=>expect(navigation.stage).toHaveBeenCalledWith('geo',expect.objectContaining({view,mode:'analysis',selectionRef:'gsel_current',expectedDigest:'historical-digest'})));
 fireEvent.click(screen.getByRole('button',{name:'方案版本：方案版本 3'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'所选范围最新方案'}));
 await waitFor(()=>expect(read).toHaveBeenCalledWith('geo',{round:'old'},{viewId:'V26',strategyVersion:undefined,targetVersion:undefined},0,undefined));
});

const ready = (extra: Record<string, unknown> = {}) => ({
  view: { viewId: 'V01', dimension: 'project' }, selection: { reference: 'gsel_words' }, digest: 'words-digest',
  columns: [], rows: [], page: { total: 0, shown: 0, nextOffset: null }, availability: { status: 'ready' }, ...extra,
});
/** The text nodes of a tree that read exactly as a bare number; a `{n && <X/>}` with n = 0 leaves one. */
const bareZeros = (root: HTMLElement) => {
  const found: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.trim() === '0') found.push(node.textContent);
  return found;
};

describe('what the analysis says about its own availability', () => {
  it('draws nothing, and in particular no stray 0, when a complete view has no reasons to give', async () => {
    read.mockReset().mockResolvedValue(ready({ availability: { status: 'ready', reasons: [] }, rows: [{ key: 'row', label: '品牌', metricId: null, dimensions: {}, values: {} }], page: { total: 1, shown: 1, nextOffset: null } }));
    const { container } = render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} embedded /></MemoryRouter>);
    await screen.findByText('品牌');
    // the row count is the only sentence on the page: no availability note, and no bare 0 where `reasons.length &&` would leave one
    expect([...container.querySelectorAll('[data-note]')].map((note) => note.textContent)).toEqual(['共 1 行，当前显示 1 行。']);
    expect(bareZeros(container)).toEqual([]);
  });

  it('words the reasons it has and says one neutral sentence, once, for the codes it has not', async () => {
    read.mockReset().mockResolvedValue(ready({ availability: { status: 'partial', reasons: ['no_selected_records', 'no_linked_error_records', 'recommendation_coverage_incomplete', 'a_code_added_later', 'another_code_added_later'] } }));
    const { container } = render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} embedded /></MemoryRouter>);
    const note = (await screen.findByText(/这个范围暂无可用记录/)).closest('[data-note]') as HTMLElement;
    expect(note).toHaveTextContent('这个范围暂无与之关联的错误记录');
    expect(note).toHaveTextContent('推荐覆盖不完整');
    expect(note.textContent?.split('部分数据暂不可用')).toHaveLength(2);
    for (const code of ['no_selected_records', 'no_linked_error_records', 'recommendation_coverage_incomplete', 'a_code_added_later']) expect(container.textContent).not.toContain(code);
  });
});

describe('the source search', () => {
  const sourceRow = { key: 'source-a', label: 'Source A', metricId: null, dimensions: { sourceType: 'news', domain: 'a.example' }, values: {} };
  const sourceView = (extra: Record<string, unknown> = {}) => ready({ view: { viewId: 'V17' }, rows: [sourceRow], page: { total: 1, shown: 1, nextOffset: null }, ...extra });

  it('asks once after the person pauses, not once per keystroke', async () => {
    read.mockReset().mockResolvedValue(sourceView());
    render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V17" embedded /></MemoryRouter>);
    const search = await screen.findByRole('searchbox', { name: '搜索引用来源' });
    await screen.findByText('Source A');
    const before = read.mock.calls.length;
    for (const value of ['n', 'ne', 'new', 'news']) fireEvent.change(search, { target: { value } });
    // the box follows every keystroke at once; nothing has been asked yet
    expect(search).toHaveValue('news');
    expect(read.mock.calls.length).toBe(before);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith('geo', { round: 'old' }, expect.objectContaining({ viewId: 'V17', sourceSearch: 'news' }), 0, undefined));
    expect(read.mock.calls.length).toBe(before + 1);
  });

  it('keeps the rows on screen while the next read is on its way, and does not flip back to the skeleton', async () => {
    read.mockReset().mockResolvedValueOnce(sourceView());
    const { container } = render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V17" embedded /></MemoryRouter>);
    const search = await screen.findByRole('searchbox', { name: '搜索引用来源' });
    await screen.findByText('Source A');
    let finish: (value: unknown) => void = () => {};
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(search, { target: { value: 'b' } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Source A')).toBeVisible();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    finish(sourceView({ rows: [{ ...sourceRow, key: 'source-b', label: 'Source B' }] }));
    expect(await screen.findByText('Source B')).toBeVisible();
    expect(screen.queryByText('Source A')).toBeNull();
  });
});

describe('the analysis rows carry words, not ids', () => {
  it('names the sampling surface of a page observation and never prints the question id', async () => {
    read.mockReset().mockResolvedValue(ready({ view: { viewId: 'V22', sourceLevel: 'page' }, rows: [{ key: 'history', label: 'Page · r3', metricId: null, dimensions: { kind: 'source_history', sourceKey: 'news.example/page', roundLabel: '第 3 轮', setVersion: 1, questionId: 'q_internal_77', mode: 'web' }, values: {} }], page: { total: 1, shown: 1, nextOffset: null } }));
    const { container } = render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V22" embedded /></MemoryRouter>);
    expect(await screen.findByText(/第 3 轮 · 问题版本 1 · 网页端/)).toBeVisible();
    expect(container.textContent).not.toContain('q_internal_77');
  });

  it('lists the rounds behind a cited page by their kind, not their id', async () => {
    read.mockReset().mockResolvedValue(ready({ view: { viewId: 'V18', sourceLevel: 'page' }, rows: [{ key: 'page', label: 'Actual page', metricId: null, dimensions: { sourceType: 'news', sourceKey: 'news.example/s', domain: 'news.example', originalUrls: ['https://news.example/s'], history: [{ roundId: 'round_internal_9', kind: 'weekly', citedAnswers: 2 }] }, values: {} }], page: { total: 1, shown: 1, nextOffset: null } }));
    const { container } = render(<MemoryRouter><GeoAnalysisWorkbench geoId="geo" project={project as never} initialView="V18" embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByText('原始引用地址与所选轮次'));
    expect(screen.getByText('每周复测 · 2 个引用回答')).toBeVisible();
    expect(container.textContent).not.toContain('round_internal_9');
  });
});
