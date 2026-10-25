import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { GeoAnalysisVisual } from './GeoAnalysisVisual';
import type { GeoAnalysisView, GeoAnalysisChartCell } from '@/lib/geoAnalysisClient';
const cell = (groupId: string, engine: string, value: number | null, state = 'known'): GeoAnalysisChartCell => ({ rowKey: `${groupId}-${engine}`, columnKey: 'current', label: `品牌提及率 · Same · 问题版本 1 · ${engine}`, groupName: "Same", groupId, setVersion: 1, engine, value, state });
it('renders exact same-named group identities and unknown cells without replacing null with zero', () => {
  const cells = [cell('g1', 'deepseek', 0), cell('g1', 'kimi', 100), cell('g2', 'deepseek', 100), cell('g2', 'kimi', null, 'unknown')];
  render(<GeoAnalysisVisual data={{ chart: { kind: 'matrix', labels: [], series: [], cells } } as unknown as GeoAnalysisView} onSelect={() => { }}/>);
  expect(screen.getByRole('table', { name: '问题群与平台交叉实测' })).toBeTruthy();
  expect(screen.getAllByText(/Same.*组/)).toHaveLength(2);
  expect(screen.getByText('暂无可用读数')).toBeTruthy();
  expect(screen.getByText('0')).toBeTruthy();
});
it('platform bars retain full-data cell member context beyond the table page', () => {
  const chosen = vi.fn(), cells = [cell('g1', 'deepseek', 0), cell('g1', 'kimi', 100)];
  render(<GeoAnalysisVisual data={{ view: { viewId: 'V04' }, chart: { kind: 'bars', labels: [], series: [], cells } } as unknown as GeoAnalysisView} onSelect={chosen}/>);
  fireEvent.click(screen.getByRole('button', { name: /Kimi/ }));
  expect(chosen).toHaveBeenCalledWith(cells[1]);
  expect(screen.getByRole('button', { name: /DeepSeek/ })).toBeTruthy();
});

// These cases use the public presenter and domain computation, including real metric floors.
import { presentGeoAnalysis, freezeGeoAnalysisDocument } from '../../../../server/src/geoAnalysis.mjs';
import { computeGeoSelection } from '../../../../server/src/geoReadScope.mjs';
function domainView({count=50,viewId='V04',metricId='M-01',pool='P2',groupName='Same · imported name'}: {count?:number;viewId?:'V04'|'V05';metricId?:string;pool?:string;groupName?:string} = {}) {
  const rows=Array.from({length:count},(_,index)=>({snapshotId:`s${index}`,questionId:`q${index}`,engine:'deepseek',roundId:'r1',roundKind:'baseline',repeatIndex:0,status:'valid',pool,groupId:'g1',askedAt:'2026-10-01T00:00:00Z',facts:{brands:[],recommendedOurs:false,statements:[],checks:{judgementCoverage:{status:'complete'}}}}));
  const metricOptions={
    engines:['deepseek','kimi'],
    samplingMode:'web',
    competitors:[],
    owned:{},
    arms:{pilot:['g1'],control:[]},
  };
  const selected={scope:{timeZone:'Asia/Shanghai'},selection:{reference:'gsel_visual',dataRevision:'visual',methodVersion:'visual',roundIds:['r1'],engines:metricOptions.engines,counts:{snapshots:rows.length}},rows,rounds:[{id:'r1',set_version:1}],questions:[],metricOptions,computed:computeGeoSelection(rows,metricOptions)};
  return presentGeoAnalysis(selected,{viewId,metricId},{allRows:true,groups:[{id:'g1',set_version:1,name:groupName}]}) as GeoAnalysisView;
}
it('keeps absent platforms and their reason beside a real known-zero platform bar',()=>{
 const view=domainView(),selected=vi.fn();
 expect(view.chart?.cells?.map(cell=>[cell.engine,cell.state,cell.value])).toEqual([['deepseek','known',0],['kimi','no_data',null]]);
 const frozen=structuredClone(freezeGeoAnalysisDocument(view));
 render(<GeoAnalysisVisual data={view} onSelect={selected}/>);
 expect(screen.getByRole('button',{name:/DeepSeek/})).toBeTruthy();
 const missing=screen.getByRole('button',{name:/Kimi.*未测/});
 expect(screen.getByText('这个范围没有该平台的回答。')).toBeTruthy();
 fireEvent.click(missing);expect(selected).toHaveBeenLastCalledWith(view.chart?.cells?.find(cell=>cell.engine==='kimi'));
 expect(view.chart?.cells?.find(cell=>cell.engine==='kimi')?.members?.selectionRef).toBe(view.selection.reference);
 expect(freezeGeoAnalysisDocument(view)).toEqual(frozen);
});
it('shows an explanatory empty plot with each insufficient or absent platform instead of an empty content list',()=>{
 const view=domainView({count:10});
 expect(view.chart?.cells?.map(cell=>cell.state)).toEqual(['insufficient','no_data']);
 const {container}=render(<GeoAnalysisVisual data={view} onSelect={()=>{}}/>);
 expect(container.querySelector('[data-chart-empty]')).toHaveTextContent('尚无可绘制读数');
 expect(screen.getByRole('button',{name:/DeepSeek.*样本不足/})).toBeTruthy();
 expect(screen.getByRole('button',{name:/Kimi.*未测/})).toBeTruthy();
 expect(screen.getByText('尚未达到该指标的样本要求。')).toBeTruthy();
 expect(screen.queryByRole('list',{name:'各平台所选实测'})).toBeNull();
 expect(view.rows.find(row=>row.dimensions.engine==='deepseek')?.values.current.value).toBe(0);
});
it('keeps unjudged real accuracy cells visible with their preserved reason',()=>{
 const view=domainView({metricId:'M-06'});
 const cell=view.rows.find(row=>row.dimensions.engine==='deepseek')?.values.current;
 expect(cell?.reason).toBe('not_adjudicated');
 const frozen=structuredClone(freezeGeoAnalysisDocument(view));
 render(<GeoAnalysisVisual data={view} onSelect={()=>{}}/>);
 expect(screen.getByRole('button',{name:/DeepSeek.*尚无法判定/})).toBeTruthy();
 expect(screen.getByText('回答中的陈述尚未完成判定。')).toBeTruthy();
 expect(freezeGeoAnalysisDocument(view)).toEqual(frozen);
});
it('retains both configured missing platforms when no observed answers exist',()=>{
 const view=domainView({count:0});const {container}=render(<GeoAnalysisVisual data={view} onSelect={()=>{}}/>);
 expect(container.querySelector('[data-chart-empty]')).toBeTruthy();
 expect(screen.getByRole('button',{name:/DeepSeek.*未测/})).toBeTruthy();
 expect(screen.getByRole('button',{name:/Kimi.*未测/})).toBeTruthy();
 expect(view.chart?.cells?.every(cell=>cell.value===null)).toBe(true);
});
it('builds actual M-15 matrix headings from the exact group, version and P4 pool without parsing engine labels',()=>{
 const view=domainView({viewId:'V05',metricId:'M-15',pool:'P4',groupName:'Risk group · 原始分类'});
 expect(view.rows.every(row=>row.dimensions.pool==='P4')).toBe(true);
 const frozen=structuredClone(freezeGeoAnalysisDocument(view));render(<GeoAnalysisVisual data={view} onSelect={()=>{}}/>);
 const heading=screen.getByRole('rowheader');
 expect(heading).toHaveTextContent('Risk group · 原始分类');expect(heading).toHaveTextContent('问题版本 1');expect(heading).toHaveTextContent('P4');
 expect(heading).not.toHaveTextContent(/deepseek|DeepSeek|kimi|Kimi/);
 expect(screen.getByRole('columnheader',{name:'DeepSeek'})).toBeTruthy();expect(screen.getByRole('columnheader',{name:'Kimi'})).toBeTruthy();
 expect(view.chart?.cells?.every(cell=>cell.members?.selectionRef===view.selection.reference)).toBe(true);
 expect(freezeGeoAnalysisDocument(view)).toEqual(frozen);
});
it('draws signed comparable changes and keeps unranked reasons reachable',()=>{
 const chosen=vi.fn(),cells=[{...cell('g','deepseek',20),unit:'percentage_points'},{...cell('h','kimi',null,'unknown'),reason:'measurement_method_changed'}];
 render(<GeoAnalysisVisual data={{chart:{kind:'comparison',cells,labels:[],series:[]}} as unknown as GeoAnalysisView} onSelect={chosen}/>);
 expect(screen.getByRole('img',{name:'可比变化排序'})).toBeTruthy();expect(screen.getByRole('button',{name:/\+20 个百分点/})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/Kimi.*不排序/}));expect(chosen).toHaveBeenCalledWith(cells[1]);
});
it('rival charts preserve insufficient and unknown rows with fixed names rather than hiding the chart',()=>{
 const cells=[{...cell('r','deepseek',0,'insufficient'),entityName:'Fixed Rival',pool:'P2',reason:'insufficient_sample'}, {...cell('r','kimi',null,'unknown'),entityName:'Legacy Rival',pool:'P3',reason:'rival_history_unknown'}];
 render(<GeoAnalysisVisual data={{chart:{kind:'rivals',cells,labels:[],series:[]}} as unknown as GeoAnalysisView} onSelect={()=>{}}/>);
 expect(screen.getByRole('button',{name:/Fixed Rival.*样本不足/})).toBeTruthy();expect(screen.getByRole('button',{name:/Legacy Rival/})).toBeTruthy();
});

import { brandRegistry, registryKey } from '../../../../server/src/geoParse.mjs';
function registeredRivalView(refusals = false): GeoAnalysisView {
  const product = { brandName: 'Ours' }, competitors = [{ id: 'fixed-rival', brandName: 'Rival', aliases: ['Alias'] }];
  const owned = {}, metricOptions = { engines: ['deepseek'], samplingMode: 'web', competitors: ['Rival'], owned, arms: { pilot: ['g'], control: [] } };
  const rows = ['old', 'now'].flatMap(round => Array.from({ length: 50 }, (_, index) => ({
    snapshotId: `${round}-${index}`, questionId: `q${index}`, engine: 'deepseek', roundId: round, roundKind: 'baseline', repeatIndex: 0,
    status: 'valid', pool: 'P2', groupId: 'g', askedAt: round === 'old' ? '2026-10-01T00:00:00Z' : '2026-10-02T00:00:00Z', surface: { mode: 'web' },
    facts: { registryKey: registryKey(brandRegistry(product, round === 'old' ? [] : competitors), owned), brands: [{ name: 'Ours', ours: true, count: round === 'old' || index < 10 ? 1 : 0 }, ...(round === 'now' ? [{ name: 'Rival', competitor: true, count: index < 20 ? 1 : 0 }] : [])], checks: { judgementCoverage: { status: 'complete' } } },
  })));
  if (refusals) {
    rows.splice(0, 50);
    rows.push(...Array.from({ length: 50 }, (_, index) => ({ ...rows[index], snapshotId: `refusal-${index}`, questionId: `refusal-q${index}`, status: 'refusal', facts: null as never })));
  }
  const selected = { scope: { timeZone: 'Asia/Shanghai' }, selection: { reference: 'gsel_review_visual', dataRevision: 'review-visual', methodVersion: 'review-visual', counts: {}, engines: ['deepseek'] }, rows, questions: [], rounds: ['old', 'now'].map(id => ({ id, ref: { evaluationBasis: { product, competitors: id === 'old' ? [] : competitors, owned } } })), metricOptions, computed: computeGeoSelection(rows, metricOptions) };
  return presentGeoAnalysis(selected, { viewId: 'V08' }, { product, competitors, allRows: true }) as GeoAnalysisView;
}
it('uses the exact rival-paired own value in bars and both lines of the same comparison chart', () => {
  const view = registeredRivalView(), chosen = vi.fn();
  const { container } = render(<GeoAnalysisVisual data={view} onSelect={chosen} />);
  expect(screen.queryByText('60%')).toBeNull();
  const own = screen.getByRole('button', { name: /Ours.*20%.*查看回答/ });
  fireEvent.click(own);
  expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ columnKey: 'pairedOwn', value: 20, members: expect.objectContaining({ columnKey: 'pairedOwn', total: 50 }) }));
  fireEvent.click(screen.getByRole('button', { name: /Rival.*40%.*查看回答/ }));
  expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ columnKey: 'current', value: 40, members: expect.objectContaining({ columnKey: 'current', total: 50 }) }));
  const heading = screen.getByRole('heading', { name: 'Rival · P2 · 同口径比较' });
  expect(heading.closest('section')?.querySelectorAll('[data-geo-chart-series]')).toHaveLength(2);
  expect(container.querySelectorAll('g rect')[0]).toHaveAttribute('width', '60');
});
it('displays the domain M16 rate with registry-qualified refusal members instead of inflating the rate', () => {
  const view = registeredRivalView(true), chosen = vi.fn();
  render(<GeoAnalysisVisual data={view} onSelect={chosen} />);
  const rival = screen.getByRole('button', { name: /Rival.*20%.*查看回答/ });
  fireEvent.click(rival);
  expect(chosen).toHaveBeenLastCalledWith(expect.objectContaining({ value: 20, members: expect.objectContaining({ total: 100 }) }));
  expect(screen.queryByText('40%')).toBeNull();
});

it('V09 bars use exclusive expression counts and leave an incomplete category unknown',()=>{
 const choose=vi.fn(),cells=[{...cell('recommended','deepseek',2),columnKey:'expressions',label:'推荐',unit:'expressions'},{...cell('conditional','deepseek',null,'unknown'),columnKey:'expressions',label:'条件性推荐',reason:'recommendation_coverage_incomplete',unit:'expressions'}];
 render(<GeoAnalysisVisual data={{chart:{kind:'recommendations',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={choose}/>);
 expect(screen.getByText('条件性推荐 · 分类覆盖不足')).toBeVisible();
 expect(screen.getByText(/合理不推荐不计为负面/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:/推荐.*2/}));
 expect(choose).toHaveBeenCalledWith(cells[0]);
});

it('source coverage and concentration show the explicit denominator and exact remainder action',()=>{
 const member={selectionRef:'gsel_sources',view:{viewId:'V18'},rowKey:'rest',columnKey:'pairs',expectedDigest:'digest',unit:'source_pairs',total:251,exact:true};
 const cells=[{rowKey:'one',columnKey:'pairs',label:'news.example',value:2,state:'known',unit:'source_pairs',engine:null,groupId:null,setVersion:null},{rowKey:'rest',columnKey:'pairs',label:'其余来源',value:251,state:'known',unit:'source_pairs',engine:null,groupId:null,setVersion:null,members:member}];
 const data={view:{viewId:'V18'},rows:[],chart:{kind:'sources',mode:'source_concentration',labels:[],series:[],cells,denominator:253}} as unknown as GeoAnalysisView,select=vi.fn();
 render(<GeoAnalysisVisual data={data} onSelect={select}/>);
 expect(screen.getByText(/253.*回答与页面配对/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/其余来源/}));expect(select).toHaveBeenCalledWith(cells[1]);
 expect(screen.getByText(/共同出现.*不代表/)).toBeTruthy();
});

it('V19 shows source by exact versioned facet and opens exact source cells',()=>{
 const selected=vi.fn(), cells=[{rowKey:'v1',columnKey:'pairs',label:'news · Same v1',sourceKey:'news.example',sourceLabel:'news.example',facetKey:'[1,"g1"]',groupId:'g1',groupName:'Same',setVersion:1,engine:null,value:2,state:'known'},{rowKey:'v2',columnKey:'pairs',label:'news · Same v2',sourceKey:'news.example',sourceLabel:'news.example',facetKey:'[2,"g2"]',groupId:'g2',groupName:'Same',setVersion:2,engine:null,value:1,state:'known'}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V19',sourceFacet:'group'},chart:{kind:'source_facets',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={selected}/>);
 expect(screen.getByRole('table',{name:'来源与平台或版本化问题群'})).toBeTruthy();
 expect(screen.getByText(/Same.*问题版本 1/)).toBeTruthy();expect(screen.getByText(/Same.*问题版本 2/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/news · Same v2/}));expect(selected).toHaveBeenLastCalledWith(cells[1]);
});
it('V22 history shows unknown intervals and selected-scope first observations without fabricating absence',()=>{
 const selected=vi.fn(),cells=[{rowKey:'present',columnKey:'observation',label:'page r1',sourceKey:'news.example/page',facetKey:'cohort',roundId:'r1',roundLabel:'第 1 轮',groupId:null,setVersion:1,engine:'deepseek',value:1,state:'known',observation:'present',transition:'first_observed_in_scope'},{rowKey:'unknown',columnKey:'observation',label:'page r2',sourceKey:'news.example/page',facetKey:'cohort',roundId:'r2',roundLabel:'第 2 轮',groupId:null,setVersion:1,engine:'deepseek',value:null,state:'unknown',reason:'citation_completeness_unknown'},{rowKey:'absent',columnKey:'observation',label:'page r3',sourceKey:'news.example/page',facetKey:'cohort',roundId:'r3',roundLabel:'第 3 轮',groupId:null,setVersion:1,engine:'deepseek',value:0,state:'known',observation:'absent',transition:'no_longer_observed'}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V22'},chart:{kind:'source_history',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={selected}/>);
 expect(screen.getByRole('table',{name:'页面引用观察历史'})).toBeTruthy();expect(screen.getAllByText(/所选范围内首次/).length).toBeGreaterThan(0);
 expect(screen.getByText('未知')).toBeTruthy();expect(screen.getByText('可观测未引用')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/page r2/}));expect(selected).toHaveBeenLastCalledWith(cells[1]);
});

it('opportunity scatter preserves actual sample bubble areas and keyboard accessible exact cohorts while null Y stays unplotted',()=>{
 const selected=vi.fn(),cells=[{rowKey:'a',columnKey:'mention',label:'Same v1',groupId:'g1',setVersion:1,engine:null,x:20,y:50,sampleSize:50,value:20,state:'known',yState:'known',xDenominator:50,yDenominator:25},{rowKey:'b',columnKey:'mention',label:'Same v2',groupId:'g2',setVersion:2,engine:null,x:20,y:null,sampleSize:200,value:20,state:'known',yState:'unknown'}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V21',ownedMetricId:'M-08'},chart:{kind:'opportunities',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={selected}/>);
 expect(screen.getByRole('img',{name:'品牌提及与登记自有信源引用'}).querySelectorAll('circle')).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:/Same v2.*200/}));expect(selected).toHaveBeenCalledWith(cells[1]);
 expect(screen.getByText(/气泡面积.*实际回答样本/)).toBeTruthy();expect(screen.getByText(/X 分母 50.*Y 分母 25/)).toBeTruthy();
});
it('confirmed relationship bars have exact members independently of brand mentions',()=>{
 const selected=vi.fn(),cells=[{rowKey:'other',columnKey:'pairs',label:'其他',value:50,state:'known',unit:'source_pairs',engine:null,groupId:null,setVersion:null}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V20'},chart:{kind:'source_relationships',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={selected}/>);
 fireEvent.click(screen.getByRole('button',{name:/其他/}));expect(selected).toHaveBeenCalledWith(cells[0]);expect(screen.getByText(/当前人工注释/)).toBeTruthy();
});
it('journey coverage selects independent units, keeps zero and unknown and drills into full chart members',()=>{
 const chosen=vi.fn(),members={selectionRef:'selected',view:{viewId:'V10'},rowKey:'old',columnKey:'questions',expectedDigest:'digest',unit:'questions',total:2,exact:true};
 const cells=[{rowKey:'old',columnKey:'questions',label:'同名群 · 问题版本 1',groupId:'old',setVersion:1,engine:null,value:2,state:'known',members},{rowKey:'new',columnKey:'questions',label:'同名群 · 问题版本 2',groupId:'new',setVersion:2,engine:null,value:0,state:'known',members},{rowKey:'old',columnKey:'articles',label:'同名群 · 问题版本 1',groupId:'old',setVersion:1,engine:null,value:null,state:'unknown',members:null}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V10'},columns:[{key:'questions',label:'原始问题'},{key:'articles',label:'内容'}],chart:{kind:'journey',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={chosen}/>);
 expect(screen.getByRole('table',{name:'旅程与需求覆盖矩阵'})).toBeTruthy();expect(screen.getByText('0')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:/问题版本 1 · 原始问题 2/}));expect(chosen).toHaveBeenCalledWith(cells[0]);
 fireEvent.click(screen.getByRole('button',{name:'覆盖数量：原始问题'}));fireEvent.click(screen.getByRole('menuitemradio',{name:'内容'}));expect(screen.getByText('未知')).toBeTruthy();
});

it('journey verified support labels a partial subtotal while unavailable verification stays unknown',()=>{
 const cells=[{rowKey:'partial',columnKey:'verifiedClaims',label:'部分依据',groupId:'g1',setVersion:1,engine:null,value:1,knownSubtotal:1,unknownCandidates:2,state:'partial'},
  {rowKey:'unknown',columnKey:'verifiedClaims',label:'缺少依据',groupId:'g2',setVersion:1,engine:null,value:null,knownSubtotal:0,unknownCandidates:2,state:'unknown'},
  {rowKey:'empty',columnKey:'verifiedClaims',label:'已知为空',groupId:'g3',setVersion:1,engine:null,value:0,knownSubtotal:0,unknownCandidates:0,state:'known'}];
 render(<GeoAnalysisVisual data={{view:{viewId:'V10'},columns:[{key:'verifiedClaims',label:'原文已核实主张'}],chart:{kind:'journey',labels:[],series:[],cells}} as unknown as GeoAnalysisView} onSelect={()=>{}}/>);
 expect(screen.getByText('1（已核实小计；另有 2 条待核实）')).toBeVisible();
 expect(screen.getByText('未知')).toBeVisible();expect(screen.getByText('0')).toBeVisible();
});

it('evidence coverage keeps unknown, partial subtotal and known zero separate on the current page',()=>{
 const cells:GeoAnalysisChartCell[]=[
  {...cell('known','deepseek',0),rowKey:'known',columnKey:'supported',label:'Adult'},
  {...cell('unknown','deepseek',null,'unknown'),rowKey:'unknown',columnKey:'supported',label:'Child'},
  {...cell('offpage','deepseek',99),rowKey:'offpage',columnKey:'supported',label:'Not on this page'},
 ];
 cells[0].members={selectionRef:'gsel_evidence',view:{viewId:'V16',evidenceKind:'claims'},rowKey:'known',columnKey:'supported',expectedDigest:'digest',unit:'statement_assessments',total:0,exact:true};
 const selected=vi.fn(),data={view:{viewId:'V16',evidenceKind:'claims'},rows:[{key:'known',label:'Adult'},{key:'unknown',label:'Child'}],columns:[{key:'supported',label:'依据已核实且表达一致'}],chart:{kind:'evidence',labels:[],series:[],cells}} as unknown as GeoAnalysisView;
 render(<GeoAnalysisVisual data={data} onSelect={selected}/>);
 expect(screen.getByRole('table',{name:'主张条件与来源覆盖矩阵'})).toBeVisible();
 expect(screen.getByText('未知')).toBeVisible();expect(screen.getByText('0')).toBeVisible();expect(screen.queryByText('Not on this page')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/Adult.*表达一致/}));expect(selected).toHaveBeenCalledWith(cells[0]);
 expect(screen.getByRole('button',{name:/Child.*未知/})).toBeDisabled();
});

it('renders error records as a paged platform matrix with exact member actions',()=>{
 const selected=vi.fn(),member={selectionRef:'gsel_errors',view:{viewId:'V13'},rowKey:'rare',columnKey:'engine_kimi',expectedDigest:'errors',unit:'error_records',total:1,exact:true};
 const item={rowKey:'rare',columnKey:'engine_kimi',engine:'kimi',label:'条件遗漏',value:1,state:'known',members:member};
 const view={view:{viewId:'V13',errorFacet:'type'},columns:[{key:'engine_kimi',label:'Kimi'}],rows:[{key:'rare',label:'条件遗漏',values:{engine_kimi:{value:1}}}],chart:{kind:'error_distribution',cells:[item,{...item,rowKey:'off-page'}],labels:[],series:[]}} as unknown as GeoAnalysisView;
 render(<GeoAnalysisVisual data={view} onSelect={selected}/>);
 expect(screen.getByRole('table',{name:'错误记录分布'})).toBeVisible();
 expect(screen.getAllByRole('button',{name:/条件遗漏.*Kimi.*1 条记录/})).toHaveLength(1);
 fireEvent.click(screen.getByRole('button',{name:/条件遗漏.*Kimi.*1 条记录/}));expect(selected).toHaveBeenCalledWith(item);
 expect(screen.getByText(/不能当作当时状态或回答错误率/)).toBeVisible();
});

it('keeps publication units independent and opens the full exact current-state and event memberships',()=>{
 const selected=vi.fn(),members={selectionRef:'gsel_publication',view:{viewId:'V24'},rowKey:'state',columnKey:'orderEvents',expectedDigest:'publication',unit:'order_events',total:3,exact:true};
 const item={rowKey:'state',columnKey:'orderEvents',label:'状态待确认',value:3,state:'known',members};
 const view={view:{viewId:'V24'},columns:[{key:'orders',label:'投放订单'},{key:'orderEvents',label:'已记录订单变更'}],rows:[{key:'state',label:'状态待确认',values:{orders:{value:1},orderEvents:{value:3}}}],chart:{kind:'publication_execution',cells:[item],labels:[],series:[],timeline:{total:3,dated:2,undated:1,events:[{id:'e1',rowKey:'state',columnKey:'orderEvents',at:'2026-10-01T00:00:00Z',label:'提交'},{id:'e2',rowKey:'state',columnKey:'orderEvents',at:'2026-10-03T00:00:00Z',label:'未知'}]}}} as unknown as GeoAnalysisView;
 render(<GeoAnalysisVisual data={view} onSelect={selected}/>);
 expect(screen.getByRole('table',{name:'内容、版本与发布记录'})).toBeVisible();expect(screen.getByRole('img',{name:'订单实际事件时间轴'})).toBeVisible();
 expect(screen.getByText(/1 条时间未知记录保留在明细/)).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'状态待确认 · 查看 3 条事件'}));expect(selected).toHaveBeenCalledWith(item);
});
