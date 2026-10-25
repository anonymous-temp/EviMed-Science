import {render,screen,fireEvent} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {expect,it,vi} from 'vitest';
import {GeoAnalysisMembersDrawer} from './GeoAnalysisMembersDrawer';
import type {GeoAnalysisMembers} from '@/lib/geoAnalysisClient';
const read=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/geoAnalysisClient',async original=>({...await original<typeof import('@/lib/geoAnalysisClient')>(),getGeoAnalysisMembers:read}));
it('links exact preserved expressions and assessment history while retaining the return scope',async()=>{
 const version='a'.repeat(64),member:GeoAnalysisMembers={selectionRef:'gsel_c3',view:{viewId:'V09'},rowKey:'condition',columnKey:'expressions',expectedDigest:'c3',unit:'expressions',total:1,exact:true};
 read.mockResolvedValue({unit:'expressions',total:1,nextOffset:null,digest:'c3',items:[{id:'expr',unit:'expressions',snapshotId:'answer1',assessmentVersion:version,question:{text:'Original question'},expression:{quote:'If adult, Alpha recommended.',entity:'Alpha',state:'conditional',conditionQuote:'If adult',claimRefs:[],explicitPosition:null,positionQuote:null}}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/visibility?round=r1&engines=kimi']}><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('If adult, Alpha recommended.')).toBeVisible();
 expect(screen.getByText('If adult')).toBeVisible();
 expect(screen.getByRole('link',{name:'查看这条表达的判定历史'})).toHaveAttribute('href',`/app/geo/g/answers/answer1?round=r1&engines=kimi&assessmentVersion=${version}#geo-judgment-history`);
 expect(screen.getByRole('link',{name:'查看原始回答与依据'})).toHaveAttribute('href','/app/geo/g/answers/answer1?round=r1&engines=kimi');
});

it('shows the preserved clinical condition basis for reasonable nonrecommendation',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_support',view:{viewId:'V09'},rowKey:'support',columnKey:'expressions',expectedDigest:'support',unit:'expressions',total:1,exact:true};
 read.mockResolvedValue({unit:'expressions',total:1,nextOffset:null,digest:'support',items:[{id:'supported',unit:'expressions',snapshotId:'answer-support',expression:{quote:'Alpha is contraindicated during pregnancy.',entity:'Alpha',state:'reasonable_nonrecommendation',conditionQuote:'during pregnancy',claimRefs:[{claimId:'c1',claimVersion:3}],explicitPosition:null,positionQuote:null,nonrecommendationBasis:{relation:'supports_nonrecommendation',entity:'Alpha',statementQuote:'Alpha is contraindicated during pregnancy.',conditionQuote:'during pregnancy',claimId:'c1',claimVersion:3,evidenceQuote:'Source confirms Alpha is contraindicated during pregnancy.',evidenceConditionQuote:'during pregnancy'}}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('合理不推荐')).toBeVisible();
 expect(screen.getByText('不推荐的依据原文')).toBeVisible();
 expect(screen.getByText('Source confirms Alpha is contraindicated during pregnancy.')).toBeVisible();
 expect(screen.getByText('条件的依据原文')).toBeVisible();
});

it('opens every preserved source page, original alias and partial judgment without source attribution',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_source',view:{viewId:'V18'},rowKey:'news',columnKey:'answers',expectedDigest:'source-digest',unit:'answers',total:1,exact:true};
 const pages=Array.from({length:251},(_,n)=>({sourceKey:`news.example/s?id=${n+1}`,domain:'news.example',sourceType:'news',originalUrls:[`https://news.example/s?id=${n+1}`],titles:[],snapshotIds:['source-answer']}));
 pages[250].originalUrls.push('http://www.news.example/s?id=251#original');
 read.mockResolvedValue({unit:'answers',total:1,nextOffset:null,digest:'source-digest',items:[{id:'source-answer',unit:'answers',snapshotId:'source-answer',question:{text:'Exact original question'},judgment:{checks:{judgementCoverage:{status:'partial'}}},source:{pages,cooccurrenceOnly:true},answer:{answer_text:'Full preserved source answer',asked_at:null,surface:{mode:'web'},citations:[{url:'https://news.example/s?id=251'}]}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Exact original question')).toBeVisible();
 screen.getByText('完整来源页面与原始地址').click();
 expect(screen.getByRole('link',{name:'http://www.news.example/s?id=251#original'})).toBeVisible();
 expect(new Set(screen.getAllByRole('link').filter(link=>link.textContent?.startsWith('http')).map(link=>link.getAttribute('href'))).size).toBe(252);
 expect(screen.getByText(/不能据此推断来源导致错误/)).toBeVisible();
});
it('source history exact old/new actions keep original questions and preserved marker and position',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_history',view:{viewId:'V22'},rowKey:'gone',columnKey:'transition',expectedDigest:'history',unit:'observations',total:2,exact:true};
 read.mockResolvedValue({unit:'observations',total:2,nextOffset:null,digest:'history',items:[{id:'old',unit:'answers',snapshotId:'old',question:{text:'Original unjudged?'},source:{pages:[{sourceKey:'news.example/page',originalUrls:['https://news.example/page'],preservedCitations:[{marker:'[7]',position:42}]}],cooccurrenceOnly:true}},{id:'new',unit:'answers',snapshotId:'new',question:{text:'Original unjudged?'}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findAllByText('Original unjudged?')).toHaveLength(2);fireEvent.click(screen.getByText('完整来源页面与原始地址'));
 expect(screen.getByText(/引用标记：\[7\].*保留位置：42/)).toBeVisible();expect(screen.getAllByRole('link',{name:'查看原始回答与依据'}).map(link=>link.getAttribute('href'))).toEqual(expect.arrayContaining([expect.stringContaining('/old?selectionRef=gsel_history'),expect.stringContaining('/new?selectionRef=gsel_history')]));
});
it('opens the actual missing scheduled repeat as an ask without fabricating an answer',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_missing',view:{viewId:'V22'},rowKey:'missing',columnKey:'observation',expectedDigest:'missing-plan',unit:'observations',total:1,exact:true};
 read.mockResolvedValue({unit:'observations',total:1,nextOffset:null,digest:'missing-plan',items:[{id:'actual-job-1',unit:'asks',roundId:'r2',questionId:'q1',repeatIndex:1,engine:'deepseek',status:'failed',reason:'scheduled_observation_missing',question:{text:'Original planned question?'}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Original planned question?')).toBeVisible();expect(screen.getByText(/计划中的重复采集尚无回答/)).toBeVisible();
 const href=screen.getByRole('link',{name:'查看采集进度与恢复选项'}).getAttribute('href')!;expect(new URL(href,'https://geo.invalid').searchParams.get('diagnosisRound')).toBe('r2');expect(screen.queryByRole('link',{name:'查看原始回答与依据'})).toBeNull();
});
vi.mock('./tabs/SourceRelationship',()=>({SourceRelationship:({target,canEdit}:{target:{value:string};canEdit:boolean})=><div data-testid="relationship-editor">{target.value} · editable {String(canEdit)}</div>}));
it('V20 pages beyond the first ten expose exact read-time annotation revisions and the existing editor with viewer abilities',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_relationship',view:{viewId:'V20'},rowKey:'own',columnKey:'pages',expectedDigest:'relation',unit:'source_pages',total:21,exact:true};
 const item=(n:number)=>({id:`page-${n}`,unit:'source_pages',source:{pages:[{sourceKey:`shared.example/s?id=${n}`,domain:'shared.example',sourceType:'news',originalUrls:[`https://shared.example/s?id=${n}`],annotations:[{url:`https://shared.example/s?id=${n}`,relation:'own',origin:'page',reference:{id:`annotation-${n}`,revision:n},reviewedAt:'2026-10-24T00:00:00Z'}]}],cooccurrenceOnly:true}});
 read.mockImplementation(async(_geo,_ref,offset=0)=>({unit:'source_pages',total:21,nextOffset:offset===0?20:null,digest:'relation',items:offset===0?Array.from({length:20},(_,n)=>item(n+1)):[item(21)]}));
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" project={{access:{abilities:['read'],roles:['viewer'],owner:false}} as never} members={member} onClose={()=>{}}/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'下一批'}));fireEvent.click(await screen.findByText('完整来源页面与原始地址'));
 expect(screen.getByText(/annotation-21.*21/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'查看或修改此页面关系'}));expect(screen.getByTestId('relationship-editor')).toHaveTextContent('https://shared.example/s?id=21 · editable false');
});
it('journey object members show explicit claim support and context actions instead of treating objects as answers',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_journey',view:{viewId:'V10'},rowKey:'need',columnKey:'verifiedClaims',expectedDigest:'exact',unit:'claims',total:1,exact:true};
 read.mockResolvedValue({unit:'claims',total:1,nextOffset:null,digest:'exact',items:[{id:'claim',unit:'claims',claimStatement:'Exact preserved claim',verification:'verified_preserved_quote',quote:'Exact source quote',version:1,sourceRef:'https://doi.org/10.1000/source'}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/journey?round=old']}><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Exact preserved claim')).toBeVisible();expect(screen.getByText('Exact source quote')).toBeVisible();expect(screen.getByRole('link',{name:'查看证据与关联'})).toHaveAttribute('href','/app/geo/g/evidence?round=old');expect(screen.queryByText('采集任务')).toBeNull();
});

it('journey source changes preserve historical quote verification and separate notice, record and check times',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_journey',view:{viewId:'V10'},rowKey:'need',columnKey:'linkedClaims',expectedDigest:'changed',unit:'claims',total:1,exact:true};
 read.mockResolvedValue({unit:'claims',total:1,nextOffset:null,digest:'changed',items:[{id:'claim',unit:'claims',claimStatement:'Preserved old claim',verification:'linked_not_verified',reason:'source_update_needed',
  quote:'Retained source quote',preservedQuoteVerification:{status:'verified'},sourceChanges:[{identifier:'doi:10.1000/exact',state:'changed',checkedAt:'2026-10-22T12:00:00Z',changes:[{kind:'retraction',date:'2026-10-21',recordedAt:'2026-10-22T11:00:00Z'}]}]}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('来源已有变更，需更新依据')).toBeVisible();expect(screen.getByText('所存历史原文已核实')).toBeVisible();
 for(const value of ['撤稿','2026-10-21','2026-10-22T11:00:00Z','2026-10-22T12:00:00Z'])expect(screen.getByText(value)).toBeVisible();
 expect(screen.getByText('来源通知日期')).toBeVisible();expect(screen.getByText('平台记录时间')).toBeVisible();expect(screen.getByText('最近检查时间')).toBeVisible();
});

it.each([['retracted','撤稿'],['corrected','更正'],['concern','关注声明']])('shows publisher %s status and every retained notice',async(kind,word)=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_pub',view:{viewId:'V10'},rowKey:'need',columnKey:'linkedClaims',expectedDigest:'pub',unit:'claims',total:1,exact:true};
 read.mockResolvedValue({unit:'claims',total:1,nextOffset:null,digest:'pub',items:[{id:'claim',unit:'claims',claimStatement:'Publisher status claim',sourcePublicationStatus:{kind,notices:['PMID:98765','10.1000/notice']}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText(word)).toBeVisible();
 expect(screen.getByText('PMID:98765')).toBeVisible();expect(screen.getByText('10.1000/notice')).toBeVisible();
 expect(screen.queryByText('来源状态日期')).toBeNull();
});

it('evidence statement members retain exact conditions, assessment basis, times and actionable selected answer',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_evidence',view:{viewId:'V16',evidenceKind:'claims'},rowKey:'exact',columnKey:'contradicted',expectedDigest:'evidence',unit:'statement_assessments',total:1,exact:true};
 read.mockResolvedValue({unit:'statement_assessments',total:1,nextOffset:null,digest:'evidence',items:[{id:'s:1',unit:'statement_assessments',snapshotId:'old-answer',claimStatement:'Original claim',claimVersion:1,cardRevision:3,applicability:{population:'Children',dose:'5 mg'},quote:'Original source quote',statement:{text:'Wrong answer statement',verdict:'wrong'},temporalBasis:'current_assessment_of_selected_answer',assessmentState:'active',askedAt:'2026-10-01',judgedAt:'2026-10-23'}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/evidence?view=coverage&round=old']}><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Original claim')).toBeVisible();expect(screen.getByText('Wrong answer statement')).toBeVisible();expect(screen.getByText('当前对历史回答的判定')).toBeVisible();expect(screen.getByText(/Children.*5 mg/)).toBeVisible();
 expect(screen.getByRole('link',{name:'查看原始回答与依据'})).toHaveAttribute('href',expect.stringContaining('/old-answer?'));
 expect(screen.getByRole('link',{name:'查看原始回答与依据'})).toHaveAttribute('href',expect.stringContaining('selectionRef=gsel_evidence'));
 expect(screen.getByRole('link',{name:'查看证据与关联'}).getAttribute('href')).not.toContain('view=coverage');
});

it('finding-expression members identify answer quotes separately from medical source support',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_find',view:{viewId:'V16',evidenceKind:'findings'},rowKey:'find',columnKey:'uncertain',expectedDigest:'finding',unit:'finding_observations',total:1,exact:true};
 read.mockResolvedValue({unit:'finding_observations',total:1,nextOffset:null,digest:'finding',items:[{id:'obs',unit:'finding_observations',finding:{statement:'Frozen finding'},basisVersion:1,status:'uncertain',recordedStatus:'not_addressed',quote:'Answer quotation',judgementCoverage:{status:'partial'}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Frozen finding')).toBeVisible();expect(screen.getByText('回答中的原文')).toBeVisible();expect(screen.getByText('回答对指定发现的表达；不代表医学来源核实')).toBeVisible();expect(screen.getByText('尚无法确定')).toBeVisible();
});

it('keeps the first preserved judgment visible beside a current reassessment',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_history',view:{viewId:'V16'},rowKey:'claim',columnKey:'supported',expectedDigest:'history',unit:'statement_assessments',total:1,exact:true};
 read.mockResolvedValue({unit:'statement_assessments',total:1,nextOffset:null,digest:'history',items:[{id:'s:1',unit:'statement_assessments',claimStatement:'Underlying source claim',statement:{text:'Current statement',verdict:'correct'},originalAssessment:{referenceId:'record',revision:1,assessmentVersion:'original',temporalBasis:'first_preserved_assessment',assessment:{judgedAt:'2026-09-30T01:00:00Z',statements:[{text:'Original statement',verdict:'wrong',applicability:{inLabel:false,dose:0}}]}}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Current statement')).toBeVisible();
 const toggle=screen.getByText('本回答首次保存的判定');
 fireEvent.click(toggle);
 expect(screen.getByText('Original statement')).toBeVisible();
 expect(screen.getByText('错误')).toBeVisible();expect(screen.getByText('正确')).toBeVisible();
 expect(screen.getByText('2026-09-30T01:00:00Z')).toBeVisible();
});

it('links an exact error group outside the visible list and preserves the selected answer scope',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_errors',view:{viewId:'V13'},rowKey:'rare',columnKey:'total',expectedDigest:'errors',unit:'error_records',total:1,exact:true};
 read.mockResolvedValue({unit:'error_records',total:1,nextOffset:null,digest:'errors',items:[{id:'rare',unit:'error_records',errorStatement:'Preserved error',fingerprint:' fp&rare ',snapshotId:'old-answer',severity:'S4',judgmentState:'withdrawn',status:'open',applicability:{inLabel:false,elements:{dose:0}},claimVersion:2}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/visibility?round=other&engines=kimi']}><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('Preserved error')).toBeVisible();expect(screen.getByText('判定已撤回')).toBeVisible();
 const action=new URL(screen.getByRole('link',{name:'查看说法的处置与历史'}).getAttribute('href')!,'https://local.example');
 expect(action.searchParams.get('error')).toBe('fp&rare');expect(action.searchParams.get('selectionRef')).toBe('gsel_errors');expect(action.searchParams.has('round')).toBe(false);
 const answer=new URL(screen.getByRole('link',{name:'查看所选关联回答'}).getAttribute('href')!,'https://local.example');
 expect(answer.pathname).toBe('/app/geo/g/answers/old-answer');expect(answer.searchParams.get('selectionRef')).toBe('gsel_errors');expect(answer.searchParams.has('round')).toBe(false);
});

it('labels original error conditions separately from current claim context',async()=>{
 const members:GeoAnalysisMembers={selectionRef:'gsel_original',view:{viewId:'V13'},rowKey:'original',columnKey:'total',expectedDigest:'original',unit:'error_records',total:1,exact:true};
 read.mockResolvedValue({total:1,nextOffset:null,unit:'error_records',items:[{id:'e',unit:'error_records',errorStatement:'Original misstatement',claimVersion:1,applicability:{population:'Adults'},originalErrorAssessment:{statement:{claimVersion:1}},currentClaim:{version:3,applicability:{population:'Children'}}}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={members} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('适用人群：Adults')).toBeVisible();expect(screen.getByText('最初判定结论版本')).toBeVisible();
 fireEvent.click(screen.getByText('当前结论信息'));expect(screen.getByText('适用人群：Children')).toBeVisible();expect(screen.getByText('当前结论版本')).toBeVisible();
});

it('opens row-scoped content versions instead of duplicating histories inside article members',async()=>{
 const members:GeoAnalysisMembers={selectionRef:'gsel_content',view:{viewId:'V23'},rowKey:'group',columnKey:'articles',expectedDigest:'content',unit:'articles',total:1,exact:true};
 read.mockReset().mockImplementation(async(_geo,current)=>current.columnKey==='articles'?{total:1,nextOffset:null,unit:'articles',items:[{id:'article',articleId:'article',title:'One article',unit:'articles',resultVersionCount:5000,rowResultVersionCount:5000}]}:{total:5000,nextOffset:20,unit:'result_versions',items:[{id:'old',articleId:'article',resultVersionId:'old-v1',digest:'a'.repeat(64),title:'Old exact version',unit:'result_versions'}]});
 render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={members} onClose={()=>{}}/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'查看本行内容版本明细'}));expect(await screen.findByText('Old exact version')).toBeVisible();
 expect(read).toHaveBeenLastCalledWith('g',expect.objectContaining({selectionRef:'gsel_content',rowKey:'group',columnKey:'resultVersions',expectedDigest:'content',total:5000}),0);
 fireEvent.click(screen.getByRole('button',{name:'返回内容明细'}));expect(await screen.findByText('One article')).toBeVisible();
});

it('keeps a pinned reported publication and an order action separate from intended distribution channels',async()=>{
 const members:GeoAnalysisMembers={selectionRef:'gsel_publications',view:{viewId:'V24'},rowKey:'orders',columnKey:'orders',expectedDigest:'pub',unit:'orders',total:1,exact:true};
 read.mockReset().mockResolvedValue({total:1,nextOffset:null,unit:'orders',items:[{id:'order:old',objectId:'old',unit:'orders',resultVersionId:'v1',digest:'a'.repeat(64),stateLabel:'状态待确认',association:{channel:'wechat_mp'},domain:'actual.example',at:null,timeBasis:'order_created_at'}]});
 render(<MemoryRouter initialEntries={['/app/geo/g/actions?round=other&step=distribution&order=stale&publication=stale&action=old&sessionId=session-one']}><GeoAnalysisMembersDrawer geoId="g" members={members} onClose={()=>{}}/></MemoryRouter>);
 expect(await screen.findByText('actual.example')).toBeVisible();expect(screen.getByText('版本中的预期渠道')).toBeVisible();
 const url=new URL(screen.getByRole('link',{name:'查看订单与可执行操作'}).getAttribute('href')!,'https://local.example');
 expect(url.searchParams.get('selectionRef')).toBe('gsel_publications');expect(url.searchParams.get('order')).toBe('old');expect(url.searchParams.has('round')).toBe(false);expect(url.searchParams.has('publication')).toBe(false);expect(url.searchParams.has('action')).toBe(false);
 const content=new URL(screen.getByRole('link',{name:'查看内容与版本'}).getAttribute('href')!,'https://local.example');
 expect(content.pathname).toBe('/app/geo/g/actions');expect(content.searchParams.get('step')).toBe('content');expect(content.searchParams.get('selectionRef')).toBe('gsel_publications');expect(content.searchParams.get('sessionId')).toBe('session-one');
 for(const key of ['order','publication','action','round'])expect(content.searchParams.has(key)).toBe(false);
});

it('describes a sampled answer in words: no round id, no raw state, no parser version, no claim id, no JSON conditions',async()=>{
 const member:GeoAnalysisMembers={selectionRef:'gsel_words',view:{viewId:'V07'},rowKey:'row',columnKey:'answers',expectedDigest:'words',unit:'answers',total:1,exact:true};
 read.mockResolvedValue({unit:'answers',total:1,nextOffset:null,digest:'words',items:[{id:'a1',unit:'answers',engine:'deepseek',roundId:'round_internal_41',repeatIndex:0,askedAt:'2026-10-02',status:'valid',reason:'a_reason_added_later',question:{text:'Which brand?'},
  statement:{text:'Alpha is for adults',verdict:'correct',claimVersion:3,applicability:{population:'Adults'},evidence:'Label says adults'},
  extraction:{parserVersion:'parser-9.9',judgedAt:'2026-10-02',genericMentions:[]},
  expression:{quote:'Alpha for adults',entity:'Alpha',state:'recommended',claimRefs:[{claimId:'claim_internal_8',claimVersion:2}]},
  answer:{answer_text:'Alpha.',surface:{mode:'web',deep:false,newChat:true},citations:[]}}]});
 const {container}=render(<MemoryRouter><GeoAnalysisMembersDrawer geoId="g" members={member} onClose={()=>{}}/></MemoryRouter>);
 fireEvent.click(await screen.findByText('实体提取依据'));
 expect(await screen.findByText(/DeepSeek · 第 1 次 · 2026-10-02 · 有回答/)).toBeVisible();
 expect(screen.getByText('适用人群：Adults')).toBeVisible();
 expect(screen.getByText('第 2 版')).toBeVisible();
 fireEvent.click(screen.getByText('完整回答与引用'));
 expect(screen.getByText('网页端、非深度思考、每题新对话')).toBeVisible();
 for(const leak of ['round_internal_41','parser-9.9','claim_internal_8','a_reason_added_later','"population"','{"'])expect(container.textContent).not.toContain(leak);
});
