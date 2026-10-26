import test from "node:test";
import assert from "node:assert/strict";
import { VcrService } from "../src/vcrService.mjs";

function scene({allowed=true,withdrawn=[],episodes=[]}={}) {
 const checks=[],reads=[];
 const service=new VcrService({config:{},store:{async getStudy(user,id){return user==='owner'&&id==='std1'?{id,userId:user}:null;}},
  access:{async require(input){checks.push(input);if(!allowed)throw Object.assign(new Error('denied'),{status:403});}},
  matchStore:{async withdrawnSubjects(){return new Set(withdrawn);},async listFollowupEpisodes(input){reads.push(input);return episodes;}}});
 return {service,checks,reads};
}
test("historical observations remain useful to authorized human readers without reviving writers or sending them to cloud",async()=>{
 const f=scene({episodes:[{id:'f1',subjectKey:'P1',kind:'routine_care',observations:[{variable:'ecog',value:1,unit:null,at:'2026-01-01'}],restricted:{}}]});
 const page=await f.service.followupHistory({id:'owner'},'std1',{limit:'10'});
 assert.equal(page.episodes[0].measurements[0].value,1);
 assert.equal(f.checks[0].ability,'read_patient_level'); assert.equal(f.reads[0].limit,11);
 const cloud=await f.service.followupHistoryForRuntime({id:'std1',userId:'owner'});
 assert.equal(cloud.readOnly,true);assert.equal(cloud.browserPath,'/app/virtual-research/std1/data');
 assert.equal(JSON.stringify(cloud).includes('ecog'),false);
 const csv=await f.service.followupHistory({id:'owner'},'std1',{format:'csv'});
 assert.match(csv.csv,/ecog/);assert.equal(f.checks.at(-1).ability,'export');
 await assert.rejects(f.service.followupHistory({id:'stranger'},'std1'),{code:'vcr_study_not_found'});
 await assert.rejects(scene({allowed:false}).service.followupHistory({id:'owner'},'std1'),{status:403});
});
test("history omits withdrawn patients, restricted fields and original trial outcomes even in post-exit records",async()=>{
 const f=scene({withdrawn:['P2'],episodes:[
  {id:'f1',subjectKey:'P1',kind:'study_specific',exitDate:'2026-01-03',exitReason:'Original reason',restricted:{secret:{visible:false}},observations:[{variable:'ecog',value:2},{variable:'secret',value:5},{variable:'treatment',value:'hidden'}]},
  {id:'f2',subjectKey:'P2',kind:'routine_care',observations:[{variable:'ecog',value:1}]},
  {id:'f3',subjectKey:'P1',kind:'post_exit',windowStart:'2026-02-01',trialWindows:[{start:'2026-01-01',end:'2026-01-03'}],observations:[{variable:'outcome',value:'hidden',at:'2026-01-02'},{variable:'treatment',value:'post care',at:'2026-02-02'}]},
 ]});
 const page=await f.service.followupHistory({id:'owner'},'std1');
 assert.deepEqual(page.episodes.map(row=>row.id),['f1','f3']);
 assert.deepEqual(page.episodes[0].measurements.map(row=>row.field),['ecog']);
 assert.equal(page.episodes[0].exitReason,'Original reason');
 assert.deepEqual(page.episodes[1].measurements.map(row=>row.value),['post care']);
 assert.equal(JSON.stringify(page).includes('hidden'),false);
});
