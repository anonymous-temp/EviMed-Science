import { describe, expect, it } from 'vitest';
import { geoJourney, geoActionPermission } from './geoJourney';
import type { GeoProject } from '@/lib/geoClient';
const project = (patch: Partial<GeoProject> = {}) => ({id:'g1',projectId:'p1',name:'New project',product:{},status:'active',steps:{},...patch}) as GeoProject;
describe('one GEO journey across list, workbench and conversation', () => {
  it('starts with product and task inputs rather than a full programme', () => {
    const journey = geoJourney(project());
    expect(journey.stage).toBe('inputs');
    expect(journey.next.kind).toBe('conversation');
    expect(journey.next.draft).toContain('目标受众');
    expect(journey.intents.map(item => item.key)).toEqual(['answers','optimize','strategy']);
    expect(journey.requested).toBe('尚未提交工作');
  });
  it('uses the real dependency of a standalone monitoring task', () => {
    const journey = geoJourney(project({product:{brandName:'Product'},steps:{monitoring:{status:'none',requested:true},questions:{status:'done',requested:false},evidence:{status:'done',requested:false}}}));
    expect(journey.requested).toContain('监测');
    expect(journey.waitingFor).toEqual(['diagnosis']);
    expect(journey.next.step).toBe('monitoring');
    expect(journey.title).toBe('尚未开启自动监测');
    expect(journey.detail).not.toContain('投放');
  });
  it('does not turn completed questions into an all-step request', () => {
    const journey = geoJourney(project({product:{brandName:'Product'},steps:{questions:{status:'done',requested:false}}}));
    expect(journey.workflow.full).toBe(false);
    expect(journey.workflow.requested).toEqual([]);
    expect(journey.next.step).toBe('diagnosis');
  });
  it('retains failed execution identity and partial output', () => {
    const journey = geoJourney(project({steps:{content:{status:'failed',requested:true,runId:'r1',note:'Unable to finish',summary:{text:'2 articles',count:2,unit:'articles'}}}}));
    expect(journey.stage).toBe('failed');
    expect(journey.runId).toBe('r1');
    expect(journey.retained).toContain('2 articles');
  });
  it('never offers mutations to paused or unauthorized accounts', () => {
    expect(geoActionPermission(project({status:'paused'}),'run')).toMatchObject({allowed:false,reason:expect.stringContaining('暂停')});
    expect(geoActionPermission(project({access:{abilities:['read'],owner:false,roles:['viewer']}}),'edit').allowed).toBe(false);
    expect(geoJourney(project({status:'paused'})).next.kind).toBe('view');
  });
});

it('keeps legacy unconfirmed step flags out of new work scope',()=>{
  const p=project({product:{brandName:'Product'},steps:{evidence:{status:'done',requested:true,requestOrigin:'legacy',summary:{text:'Product evidence',count:1,unit:'claim'}},content:{status:'none',requested:true,requestOrigin:'legacy'}}});
  const journey=geoJourney(p);
  expect(journey.workflow.requested).toEqual([]);
  expect(journey.requested).toBe('历史工作范围待确认');
  expect(journey.title).toContain('选择需要继续的任务');
  expect(journey.retained).toContain('Product evidence');
});

 it('separates a stopped daemon flag from an accepted recurring round',()=>{
  const p=project({engines:['qianwen'],coverageDays:90,steps:{monitoring:{status:'running',requested:true}},activeMeasurement:null});
  expect(geoJourney(p)).toMatchObject({stage:'blocked',title:'尚未开启自动监测'});
  expect(geoJourney({...p,activeMeasurement:{id:'round_1',kind:'weekly',status:'running'}})).toMatchObject({stage:'running',current:'monitoring'});
  p.steps.monitoring!.automation={state:'confirmed',actorId:'actor',at:'2026-10-31T10:00:00Z',engines:['qianwen'],coverageDays:90};
  expect(geoJourney(p)).toMatchObject({stage:'ready',title:'自动监测已开启，等待下一轮'});
 });

it('shows a new accepted monitoring round even after a previous completed measurement',()=>{
 const p=project({engines:['qianwen'],coverageDays:90,steps:{monitoring:{status:'done',requested:true}},activeMeasurement:{id:'new_round',kind:'weekly',status:'running'}});
 expect(geoJourney(p)).toMatchObject({stage:'running',current:'monitoring'});
 expect(geoJourney({...p,activeMeasurement:{id:'new_round',kind:'weekly',status:'queued'}})).toMatchObject({stage:'queued',current:'monitoring'});
});
