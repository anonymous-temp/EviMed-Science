import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEvolutionConversationSession } from '../../../scripts/ops/evolution-conversation-session.mjs';
test('public conversation replaces only unused reserve-only checkpoint and creates real kernel plus research binding',async()=>{
  const calls=[],request=async(...args)=>{calls.push(args);return{id:'real'};};
  const result=await prepareEvolutionConversationSession({checkpoint:{session:{id:'reserved'}},runs:[],request});
  assert.equal(result.session.id,'real');assert.equal(result.replacedSessionId,'reserved');
  assert.deepEqual(calls,[['/api/runtime/sessions',{},'POST'],['/api/research-sessions/real',{mode:'open-domain'},'PUT']]);
  calls.length=0;const used=await prepareEvolutionConversationSession({checkpoint:{session:{id:'existing'}},runs:[{sessionId:'existing',id:'actual-run'}],request});
  assert.equal(used.session.id,'existing');assert.equal(calls.length,0);
  const resumed=await prepareEvolutionConversationSession({checkpoint:{session:{id:'real'},createdThroughPublicApi:true},runs:[],request});
  assert.equal(resumed.session.id,'real');assert.equal(calls.length,1);assert.equal(calls[0][2],'PUT');
});
