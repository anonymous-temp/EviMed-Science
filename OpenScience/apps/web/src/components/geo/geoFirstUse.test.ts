import { describe, expect, it } from 'vitest';
import { geoOverviewFirstUse, geoOverviewNeedsMeasurement } from './geoFirstUse';
const project = { steps: {}, needsYou: [], overview: { metrics: [], week: [] } } as never;
const diagnosis = { kind: 'ready', data: { round: null, rounds: [], errors: [] } } as never;
const monitoring = { kind: 'ready', data: { series: [], byEngine: [] } } as never;
const strategy = { kind: 'ready', data: { version: null, targets: { rows: [] } } } as never;
describe('proven GEO first use', () => {
  it('requires successful independent reads', () => {
    expect(geoOverviewFirstUse(project, diagnosis, monitoring, strategy)).toBe(true);
    expect(geoOverviewFirstUse(project, { kind: 'loading' }, monitoring, strategy)).toBe(false);
    expect(geoOverviewFirstUse(project, { kind: 'error', message: 'failed' } as never, monitoring, strategy)).toBe(false);
    expect(geoOverviewFirstUse(project, { ...diagnosis as object, refreshError: 'stale' } as never, monitoring, strategy)).toBe(false);
  });
  it('preserves history, partial answers and plans when current cells are absent', () => {
    expect(geoOverviewFirstUse(project, { kind: 'ready', data: { rounds: [{ id: 'old' }] } } as never, monitoring, strategy)).toBe(false);
    expect(geoOverviewFirstUse(project, { kind: 'ready', data: { round: { done: 1 } } } as never, monitoring, strategy)).toBe(false);
    expect(geoOverviewFirstUse(project, diagnosis, { kind: 'ready', data: { series: [{ points: [{ value: null }] }] } } as never, strategy)).toBe(false);
    expect(geoOverviewFirstUse(project, diagnosis, monitoring, { kind: 'ready', data: { version: 3 } } as never)).toBe(false);
  });
});

it.each([
  {battlefield:{name:'Preserved battlefield'}}, {tiers:[{name:'Client tier'}]}, {noGo:[{item:'Avoid'}]},
  {engines:[{engine:'kimi'}]}, {layout:{constraints:['Medical review']}}, {layout:{clientActions:[{text:'Review'}]}},
  {layout:{layers:{owned:['https://owned.example']}}}, {assumptions:[{field:'budget',value:500}]},
  {gaps:{total:1}}, {actions:{total:1}}, {targets:{targetsVersion:4}},
])('retains legitimate partial plan content %#', partial => {
  expect(geoOverviewFirstUse(project, diagnosis, monitoring, {kind:'ready',data:{version:null,...partial}} as never)).toBe(false);
});

it.each([
  {failureModes:{correct:{value:null,numerator:0,denominator:1}}}, {noise:{band:5,measuredAt:'2026-01-01'}},
  {errorPage:{total:1}}, {scopeErrorSummary:{total:1}}, {byClaim:[{claimId:'c1'}]},
])('retains partial diagnosis content %#', partial => {
  expect(geoOverviewFirstUse(project, {kind:'ready',data:{round:null,rounds:[],...partial}} as never, monitoring, strategy)).toBe(false);
});

it.each([
  {arms:{netEffect:{value:0}}}, {rivals:[{points:[{value:null}]}]}, {next:{date:'2026-01-02'}},
])('retains monitoring and operational content %#', partial => {
  expect(geoOverviewFirstUse(project, diagnosis, {kind:'ready',data:{series:[],...partial}} as never, strategy)).toBe(false);
});

it('does not mistake the default tier for retained work', () => {
  expect(geoOverviewFirstUse(project, diagnosis, monitoring, {kind:'ready',data:{version:null,chosenTier:'2',targets:{rows:[]}}} as never)).toBe(true);
});

it('uses a task workbench after evidence and questions, before there are any observations', () => {
  expect(geoOverviewNeedsMeasurement({...project as object,steps:{evidence:{status:'done'},questions:{status:'minimal'}}} as never,diagnosis,monitoring)).toBe(true);
});
it.each([{value:0},{denominator:1,numerator:0},{snapshotIds:['answer']}])('keeps partial or zero observations visible %#', cell => {
  expect(geoOverviewNeedsMeasurement({...project as object,overview:{metrics:[{cell,trend:[]}]}} as never,diagnosis,monitoring)).toBe(false);
});
it('does not use successful first-use copy while a measured read is unavailable', () => {
  expect(geoOverviewNeedsMeasurement(project,{kind:'loading'},monitoring)).toBe(false);
  expect(geoOverviewNeedsMeasurement(project,diagnosis,{kind:'error',message:'failed'} as never)).toBe(false);
});


it('recognizes an actual empty service response with engine/pool descriptors and empty member envelopes', () => {
  const absent = {value:null,numerator:null,denominator:null,status:'absent',snapshotIds:[],members:{exact:false,total:null,shown:0,more:false,basis:'historical_unknown'}};
  const project = {startedAt:'2026-10-31T00:00:00Z',steps:{},overview:{metrics:[{key:'gvi',cell:absent,trend:[]}]}};
  const d = {round:null,rounds:[],errors:[],byEngine:[{engine:'deepseek',mention:absent}],byPool:[{pool:'P1',mention:absent}],
    more:[{cell:absent}],failureModes:{omitted:{...absent,members:{total:0,shown:0,exact:true}}}};
  const m = {series:[{points:[]}],byEngine:[{points:[]}],arms:{netEffect:absent}};
  expect(geoOverviewNeedsMeasurement(project as never,{kind:'ready',data:d} as never,{kind:'ready',data:m} as never)).toBe(true);
  expect(geoOverviewNeedsMeasurement(project as never,{kind:'ready',data:{...d,byEngine:[{mention:{...absent,value:0,numerator:0,denominator:5,status:'insufficient'}}]}} as never,{kind:'ready',data:m} as never)).toBe(false);
});
