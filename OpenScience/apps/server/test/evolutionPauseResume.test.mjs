import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionMissions} from '../src/evolutionMissions.mjs';
import {EvolutionWorker} from '../src/evolutionWorker.mjs';

// Pausing research stops its missions where they are (`status: 'paused'`, remembering where to go back to); the only thing that sends a
// paused mission on is the `search-resumed` event, and nothing in the platform ever emitted it (review D-E4).
const setup=async()=>{
 const f=evolutionServiceFixture(),config={evolutionSearchPaused:true};
 const missions=createEvolutionMissions({service:f.service,policy:{},map:{},taskPool:{},signals:{},config,adapters:{tools:{enabled:true}}});
 await f.service.save('mission','m1',{moduleId:'tools',kind:'research',status:'ready',dependencies:[]});
 assert.equal((await missions.run({missionId:'m1'})).payload.status,'paused');
 const worker=new EvolutionWorker({service:f.service,maintenance:{},decisions:{},config,callbacks:{onEvent:event=>missions.wake(event)}});
 const resumeEvents=async()=>(await Promise.all(f.jobs.filter(job=>job.kind==='evolution-event').map(job=>f.service.get(job.payload.eventId,job.payload.eventOwnerId)))).filter(row=>row.payload.type==='search-resumed');
 return{f,config,missions,worker,resumeEvents};
};
test('ending the pause resumes the missions it stopped, once, and not before',async()=>{
 const {f,config,missions,worker,resumeEvents}=await setup();
 await worker.housekeeping();
 assert.equal((await resumeEvents()).length,0,'research is still paused');
 config.evolutionSearchPaused=false;
 await worker.housekeeping();await worker.housekeeping();
 const [event]=await resumeEvents();assert.ok(event,'nothing announces that research is running again');
 assert.equal((await resumeEvents()).length,1,'one announcement for one set of paused missions');
 await worker.perform(f.jobs.find(job=>job.kind==='evolution-event'&&job.payload.eventId===event.id));
 assert.equal(f.jobs.filter(job=>job.kind.startsWith('evolution-mission')&&job.payload.missionId==='m1').length,1,'the paused mission is queued again');
 missions.register({tools:{enabled:false}});
 const resumed=await missions.run({missionId:'m1'});
 assert.equal(resumed.payload.reason,'module-disabled','the mission left its pause');
 await worker.housekeeping();assert.equal((await resumeEvents()).length,1,'nothing is paused any more');
});
test('a second pause is resumed as well as the first',async()=>{
 const {f,config,missions,worker,resumeEvents}=await setup();
 config.evolutionSearchPaused=false;await worker.housekeeping();
 await worker.perform(f.jobs.find(job=>job.kind==='evolution-event'));
 missions.register({tools:{enabled:false}});
 await missions.run({missionId:'m1'});
 config.evolutionSearchPaused=true;
 await f.service.save('mission','m2',{moduleId:'tools',kind:'research',status:'ready',dependencies:[]});
 await missions.run({missionId:'m2'});
 config.evolutionSearchPaused=false;await worker.housekeeping();
 assert.equal((await resumeEvents()).length,2);
});
