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
