import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { GeoDiagnosis, GeoMeasurement, GeoMonitoring, GeoStrategyView } from '@/lib/geoClient';
import { geoProject, cell } from '../__fixtures__/geoTabs';
import { geoOverviewFirstUse } from '../geoFirstUse';
import { OverviewTab } from './OverviewTab';
const loads=vi.hoisted(()=>({diagnosis:vi.fn(),monitoring:vi.fn(),strategy:vi.fn()}));
vi.mock('../geoProjectData',async original=>({...await original<typeof import('../geoProjectData')>(),useGeoDiagnosis:loads.diagnosis,useGeoMonitoring:loads.monitoring,useGeoStrategy:loads.strategy}));
vi.mock('@/components/charts/TrendChart',()=>({TrendChart:()=>null}));
const empty=()=>cell(null,null,null);
const project=geoProject({}, {overview:{metrics:[],week:[],steps:{}}});
const diagnosis:GeoDiagnosis={round:null,rounds:[],byEngine:[],byPool:[],failureModes:{omitted:empty(),correct:empty(),wrongOurs:empty(),wrongCompetitor:empty()},errors:[],noise:null,more:[]};
const strategy:GeoStrategyView={version:null,createdAt:null,runId:null,summary:null,chosenTier:null,targets:{tier:'2',baselineRound:null,latestRound:null,targetsVersion:null,rows:[]},tiers:[],battlefield:null,noGo:[],engines:[],layout:{layers:null,constraints:[],clientActions:[]},assumptions:[],gaps:{total:0,withoutAction:0},actions:{total:0,byStatus:{}}};
const monitor=(measurement:GeoMeasurement,history=false):GeoMonitoring=>({series:history?[{key:'gvi',points:[{date:'2026-10-01',value:5,n:40,k:2}]}]:[],arms:{pilot:[],control:[],netEffect:{...empty(),noiseBand:null}},byEngine:[],cited:[],newErrors:[],next:null,measurement});
const ready=<T,>(data:T)=>({kind:'ready' as const,data});
function show(measurement:GeoMeasurement,history=false){const monitoring=monitor(measurement,history);loads.diagnosis.mockReturnValue({state:ready(diagnosis),reload:vi.fn()});loads.strategy.mockReturnValue({state:ready(strategy),reload:vi.fn()});loads.monitoring.mockReturnValue({state:ready(monitoring),reload:vi.fn()});return {monitoring,...render(<MemoryRouter><OverviewTab geoId="geo_1" project={project}/></MemoryRouter>)};}
it('recognizes the complete default server shapes as first use without claiming that measuring metadata is history',()=>{
 const {monitoring,container}=show({state:'measuring',since:null,engines:[]});
 expect(geoOverviewFirstUse(project,ready(diagnosis),ready(monitoring),ready(strategy))).toBe(true);
 expect(container.querySelector('[data-geo-first-use]')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'查看产品依据'})).toBeVisible();expect(screen.getByRole('link',{name:'整理问题'})).toBeVisible();
 expect(screen.queryByText(/暂停测量|测量暂停中/)).toBeNull();
});
it.each([
 [{state:'measuring',since:null,engines:['kimi']},/Kimi\s*暂停测量.*这些引擎暂时不可用/],
 [{state:'paused',since:'2026-10-01T00:00:00Z',engines:['kimi','deepseek']},/AI 回答测量暂停中.*测量服务暂时不可用/],
] as const)('keeps independent pause cause and impact visible in the aggregate first-use guide %#',(measurement,notice)=>{
 const {container}=show({...measurement,engines:[...measurement.engines]});
 expect(container.querySelector('[data-geo-first-use]')).toBeInTheDocument();expect(screen.getByText(notice)).toBeVisible();
 expect(screen.queryByText(/其余 AI 照常测量|恢复后自动继续/)).toBeNull();
});
it('keeps actual sampling history outside the first-use guide even with default measurement metadata',()=>{
 const {monitoring,container}=show({state:'measuring',since:null,engines:[]},true);
 expect(geoOverviewFirstUse(project,ready(diagnosis),ready(monitoring),ready(strategy))).toBe(false);
 expect(container.querySelector('[data-geo-first-use]')).toBeNull();expect(screen.queryByRole('heading',{name:'从现有资料和问题开始'})).toBeNull();
});
