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
