import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EVOLUTION_JOB_KINDS} from '@evimed/domain';
import {loadConfig} from '../src/config.mjs';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';
import {EVOLUTION_HEAVY_WINDOW_DEFAULT,EVOLUTION_HEAVY_WINDOW_KINDS,evolutionHeavyWindowOpen,parseEvolutionHeavyWindow} from '../src/evolutionHeavyWindow.mjs';

// The heavy, model-intensive work waits for 22:00-07:00 China time, which is 14:00-23:00 UTC and wholly inside DeepSeek's half-price hours (peak: weekdays
// 01:00-04:00 and 06:00-10:00 UTC). Collection and the light jobs run at any hour.
const at=iso=>new Date(iso);
test('the default window opens at 22:00 China time and closes at 07:00, which is 14:00 to 23:00 UTC',()=>{
 const config={evolutionHeavyWindow:EVOLUTION_HEAVY_WINDOW_DEFAULT};
 assert.equal(EVOLUTION_HEAVY_WINDOW_DEFAULT,'22:00-07:00');
 for(const [instant,expected] of [['2026-10-12T13:59:59Z',false],['2026-10-12T14:00:00Z',true],['2026-10-12T18:30:00Z',true],['2026-10-12T22:59:59Z',true],['2026-10-12T23:00:00Z',false],['2026-10-12T01:00:00Z',false],['2026-10-12T09:30:00Z',false]])
  assert.equal(evolutionHeavyWindowOpen(config,at(instant)),expected,instant);
 // Saturday and Sunday are off-peak all day for the provider, but the module keeps its own night: the window is a daily one.
 assert.equal(evolutionHeavyWindowOpen(config,at('2026-10-10T20:00:00Z')),true);assert.equal(evolutionHeavyWindowOpen(config,at('2026-10-10T05:00:00Z')),false);
});
test('the window is written in China time whatever the container\'s clock zone is, and a configured window is read as written',()=>{
 const before=process.env.TZ;
 try{
  for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
   process.env.TZ=zone;
   assert.equal(evolutionHeavyWindowOpen({evolutionHeavyWindow:'22:00-07:00'},at('2026-10-12T15:00:00Z')),true,zone);
   assert.equal(evolutionHeavyWindowOpen({evolutionHeavyWindow:'22:00-07:00'},at('2026-10-12T04:00:00Z')),false,zone);
  }
 }finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
 const daytime={evolutionHeavyWindow:'09:00-12:30'};
 assert.equal(evolutionHeavyWindowOpen(daytime,at('2026-10-12T01:00:00Z')),true);assert.equal(evolutionHeavyWindowOpen(daytime,at('2026-10-12T04:30:00Z')),false);
});
test('no window means always open: `always`, nothing, nothing readable, or a window with equal ends',()=>{
 for(const value of ['always','ALWAYS',' always ','',undefined,null,'night','25:00-07:00','22-07','22:00-22:00']){
  assert.equal(parseEvolutionHeavyWindow(value),null,String(value));
  assert.equal(evolutionHeavyWindowOpen({evolutionHeavyWindow:value},at('2026-10-12T04:00:00Z')),true,String(value));
 }
 assert.equal(evolutionHeavyWindowOpen(undefined,at('2026-10-12T04:00:00Z')),true,'a hand-made config has no window');
});
test('the setting is read from the environment with the night as its default',()=>{
 const name='OPEN_SCIENCE_EVOLUTION_HEAVY_WINDOW',prior=process.env[name];
 try{
  delete process.env[name];assert.equal(loadConfig().evolutionHeavyWindow,'22:00-07:00');
  process.env[name]='20:00-06:30';assert.equal(loadConfig().evolutionHeavyWindow,'20:00-06:30');
  process.env[name]='always';assert.equal(loadConfig().evolutionHeavyWindow,'always');
 }finally{if(prior===undefined)delete process.env[name];else process.env[name]=prior;}
});
test('the jobs that wait for the window are the module\'s model-intensive ones, and the light ones are not among them',()=>{
 for(const kind of EVOLUTION_HEAVY_WINDOW_KINDS)assert.ok(EVOLUTION_JOB_KINDS.includes(kind),kind);
 for(const kind of ['evolution-research','evolution-audit','evolution-mission','evolution-mission-heavy','evolution-evaluate','evolution-scout','evolution-build','evolution-meta'])assert.ok(EVOLUTION_HEAVY_WINDOW_KINDS.includes(kind),`${kind} waits for the night`);
 for(const kind of ['evolution-event','evolution-decision','evolution-digest','evolution-maintain','evolution-plan','evolution-self-check'])assert.ok(!EVOLUTION_HEAVY_WINDOW_KINDS.includes(kind),`${kind} runs at any hour`);
});

// The polling worker, with a clock the test moves.
const harness=(pending,{config={}}={})=>{
 let clock=at('2026-10-12T04:00:00Z');const offered=new Set(),ran=[];
 const service={now:()=>clock,list:async()=>[],jobs:{
  claim:async kinds=>{kinds.forEach(kind=>offered.add(kind));const index=pending.findIndex(job=>kinds.includes(job.kind));return index<0?null:{...pending.splice(index,1)[0],userId:'operator',payload:{},leaseToken:'lease',attempts:1};},
  renew:async()=>true,finish:async()=>({}),fail:async()=>({})}};
 const done=async name=>{ran.push(name);return{status:'complete'};};
 const worker=new EvolutionWorker({service,config:{evolutionEnabled:true,evolutionLightConcurrency:2,evolutionHeavyWindow:'22:00-07:00',...config},decisions:{digest:async()=>done('digest')},
  callbacks:{plan:()=>done('plan'),research:()=>done('research'),mission:()=>done('mission'),audit:()=>done('audit'),meta:()=>done('meta'),build:()=>done('build'),scout:()=>done('scout'),evaluate:()=>done('evaluate'),selfCheck:()=>done('self-check')}});
 worker.housekeeping=async()=>{};
 return{worker,offered,ran,at:instant=>{clock=at(instant);}};
};
test('by day the polling worker offers the light jobs only; by night it offers the heavy ones too',async()=>{
 const day=harness([]);
 await day.worker.tick();
 for(const kind of EVOLUTION_HEAVY_WINDOW_KINDS)assert.ok(!day.offered.has(kind),`${kind} is not claimed by day`);
 for(const kind of ['evolution-event','evolution-decision','evolution-digest','evolution-maintain','evolution-plan','evolution-self-check'])assert.ok(day.offered.has(kind),`${kind} is claimed by day`);
 assert.equal(day.worker.status().heavyWindowOpen,false);
 const night=harness([]);night.at('2026-10-12T16:00:00Z');
 await night.worker.tick();
 for(const kind of EVOLUTION_JOB_KINDS)assert.ok(night.offered.has(kind),`${kind} is claimed by night`);
 assert.equal(night.worker.status().heavyWindowOpen,true);
});
test('a queued mission waits for the night, a queued plan does not, and the counter says which hour the heavy work started in',async()=>{
 const h=harness([{id:'mission',kind:'evolution-mission'},{id:'research',kind:'evolution-research'},{id:'build',kind:'evolution-build'},{id:'plan',kind:'evolution-plan'},{id:'digest',kind:'evolution-digest'}]);
 await h.worker.tick();await h.worker.tick();
 assert.deepEqual(h.ran.sort(),['digest','plan'],'by day only the light jobs run');
 assert.deepEqual(h.worker.counters.heavyStarted,{inside:0,outside:0});
 h.at('2026-10-12T15:30:00Z');
 await h.worker.tick();await h.worker.tick();
 assert.deepEqual(h.ran.sort(),['build','digest','mission','plan','research']);
 assert.deepEqual(h.worker.counters.heavyStarted,{inside:3,outside:0});
});
test('a caller that names the kinds it wants run is not held by the window, and is counted outside it',async()=>{
 const h=harness([{id:'research',kind:'evolution-research'}]);
 const result=await h.worker.tick({kinds:['evolution-research']});
 assert.ok(result);assert.deepEqual(h.ran,['research']);assert.deepEqual(h.worker.counters.heavyStarted,{inside:0,outside:1});
});
test('without a window the worker is as it was: every kind at every hour',async()=>{
 const h=harness([{id:'research',kind:'evolution-research'}],{config:{evolutionHeavyWindow:'always'}});
 await h.worker.tick();
 assert.deepEqual(h.ran,['research']);assert.equal(h.worker.status().heavyWindowOpen,true);assert.deepEqual(h.worker.counters.heavyStarted,{inside:1,outside:0});
});
