import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evolutionServiceFixture} from './helpers/evolutionServiceFixture.mjs';
import {createEvolutionLoops} from '../src/evolutionLoops.mjs';

// The monthly job reports, prunes and saves the month's metrics; a model that proposes a policy change it should not has not earned the
// month's report (review D-E7).
const monthly=async model=>{
 const f=evolutionServiceFixture();f.service.callbacks.monthlyMetrics=async month=>({month,measured:true});
 const loops=createEvolutionLoops({service:f.service,config:{},database:{query:async()=>({rows:[]})},registry:{list:()=>[]},model});
 return{f,loops};
};
test('a malformed policy proposal does not stop the monthly job: the metrics are saved and the report is sent',async()=>{
 const {f,loops}=await monthly(async()=>({field:'weights',value:{demand:4},hypothesis:'fewer terms',unexpected:true}));
 const result=await loops.monthly();
 assert.equal(result.proposal.payload.status,'proposal_invalid');
 assert.equal((await f.service.get('evolution-monthly-metrics-2026-09')).payload.metrics.measured,true);
 const notice=f.notices.find(item=>item.title==='进化月报');assert.ok(notice);assert.match(notice.body,/策略提案不合规/);
});
test('a valid proposal is still tried and the report does not mention an invalid one',async()=>{
 const {f,loops}=await monthly(async()=>({field:'stagnationRounds',value:2,hypothesis:'stop earlier'}));
 const result=await loops.monthly();
 assert.equal(result.proposal.payload.status,'replay_pending');
 assert.doesNotMatch(f.notices.find(item=>item.title==='进化月报').body,/不合规/);
});
