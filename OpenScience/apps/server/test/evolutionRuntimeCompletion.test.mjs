import test from 'node:test';
import assert from 'node:assert/strict';
import { completeEvolutionRuntime } from '../src/evolutionRuntimeCompletion.mjs';

test('production completion awaits the end probe before bounded cleanup and tolerates probe failure', async () => {
  for (const fail of [false, true]) {
    const project={id:'eval-paper-completion',userId:'operator'},run={id:'run_actual',dispatchId:'dispatch_actual',finishedAt:'2026-10-05T00:00:00Z'},events=[];
    let exists=true,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    const task=completeEvolutionRuntime({config:{evolutionEnabled:true},evolution:{},project,run,
      evaluationIsolation:{recordCitations:async id=>{assert.equal(id,run.id);events.push('citations');}},
      runtimeManager:{captureRunEgressProof:async input=>{assert.deepEqual(input,{project,runId:run.id,phase:'end'});assert.equal(exists,true);assert.equal(run.finishedAt,'2026-10-05T00:00:00Z');events.push('probe');await barrier;if(fail)throw new Error('Observed end unavailable');return {nativeCoverageVerified:false};},
        endBoundedRuntime:async (owned,id)=>{assert.equal(owned,project);assert.equal(id,run.dispatchId);exists=false;events.push('cleanup');}},
      independentProductWork:work=>work()});
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['citations','probe']);assert.equal(exists,true);
    release();assert.equal(await task,true);assert.deepEqual(events,['citations','probe','cleanup']);
  }
});
test('ordinary, disabled and absent evolution completion never probes or schedules bounded cleanup', async () => {
  for(const [enabled,projectId,evolution] of [[false,'eval-paper-completion',{}],[true,'ordinary-research',{}],[true,'eval-paper-completion',null]]){
    const forbidden=()=>{throw new Error('Unscoped lifecycle side effect');};
    assert.equal(await completeEvolutionRuntime({config:{evolutionEnabled:enabled},evolution,project:{id:projectId},run:{},evaluationIsolation:{recordCitations:forbidden},runtimeManager:{captureRunEgressProof:forbidden,endBoundedRuntime:forbidden},independentProductWork:forbidden}),false);
  }
});
