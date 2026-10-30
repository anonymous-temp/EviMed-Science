import { runHistory } from '../src/agentRuns.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVcrReplyStudy } from '../src/vcrReplyContext.mjs';
const projectStudy={id:'project-study',projectId:'project',conversationSessionId:'canonical'};
const task={id:'task-a',projectId:'project',conversationSessionId:'session-a'};
const store={studyByControlProject:async()=>projectStudy,studyByRuntimeDispatch:async(_user,_project,id)=>id==='dispatch' ? projectStudy : null,
 one:async(_sql,values)=>values[2]==='session-a' ? {id:task.id} : null,getStudy:async(_user,id)=>id===task.id ? task : null,
 taskContext:async()=>{throw new Error('Reply checking must not create a task');}};
const scope=run=>({store,userId:'owner',projectId:'project',run:{id:'ended-run',status:'succeeded',...run}});
test('reply facts select the exact ended conversation and preserve canonical/programme associations',async()=>{
 assert.equal((await resolveVcrReplyStudy(scope({sessionId:'session-a'}))).id,task.id);
 assert.equal((await resolveVcrReplyStudy(scope({sessionId:'canonical'}))).id,projectStudy.id);
 assert.equal(await resolveVcrReplyStudy(scope({sessionId:'unrelated'})),null);
 assert.equal((await resolveVcrReplyStudy(scope({sessionId:'hidden',dispatchId:'dispatch',effectiveRouteReason:'vcr:analysis'}))).id,projectStudy.id);
 assert.equal(await resolveVcrReplyStudy(scope({sessionId:'hidden',dispatchId:'unknown',effectiveRouteReason:'vcr:analysis'})),null);
});
test('reply facts reject mismatched recorded session, study and nonterminal runs',async()=>{
 assert.equal(await resolveVcrReplyStudy({...scope({sessionId:'session-a'}),sessionId:'another'}),null);
 assert.equal(await resolveVcrReplyStudy({...scope({sessionId:'session-a'}),studyId:'project-study'}),null);
 assert.equal(await resolveVcrReplyStudy(scope({sessionId:'session-a',status:'running'})),null);
});

test('VCR numerical review requires current-run participation and excludes standalone or mixed calculations',async()=>{
 const {vcrReplyUsesStudy}=await import('../src/vcrReplyContext.mjs');
 const transcript=tools=>({header:{runId:'run',completeness:'complete'},messages:[{sessionId:'session-a',turnStartSeq:1,parts:tools.map(tool=>({type:'tool',tool}))}]});
 const base={store,selectRunHistory:runHistory,userId:'owner',projectId:'project',studyId:task.id,run:{id:'run',status:'succeeded',sessionId:'session-a',nativeTurn:{startSeq:1}}};
 assert.equal(await vcrReplyUsesStudy({...base,transcript:transcript([])}),false);
 assert.equal(await vcrReplyUsesStudy({...base,transcript:transcript(['mcp__evimed__research_calculate'])}),false);
 assert.equal(await vcrReplyUsesStudy({...base,transcript:transcript(['mcp__evimed__vcr_read'])}),true);
 assert.equal(await vcrReplyUsesStudy({...base,transcript:transcript(['mcp__evimed__vcr_read','mcp__evimed__research_calculate'])}),false);
 assert.equal(await vcrReplyUsesStudy({...base,run:{...base.run,effectiveAgentId:'vcr-analysis'},transcript:transcript([])}),true);
 assert.equal(await vcrReplyUsesStudy({...base,run:{...base.run,effectiveAgentId:'vcr-analysis'},transcript:transcript(['research_calculate'])}),false);
 assert.equal(await vcrReplyUsesStudy({...base,transcript:{...transcript(['vcr_read']),header:{completeness:'partial'}}}),false);
});

test('the shared completion route requires an exact owned VCR job rather than a generic replay origin',async()=>{
 const {vcrReplyUsesStudy}=await import('../src/vcrReplyContext.mjs');
 let completion={study_id:task.id,job_id:'job',payload:{}};
 const completionStore={one:async(sql,values)=>{assert.ok(sql.includes('conversation_completions'));assert.deepEqual(values,['owner','project','session-a','vcr-completion-owned','a'.repeat(64)]);return completion;}};
 const input={store:completionStore,selectRunHistory:runHistory,userId:'owner',projectId:'project',studyId:task.id,run:{id:'run',status:'succeeded',sessionId:'session-a',dispatchId:'vcr-completion-owned-retry-1',dispatchFingerprint:'a'.repeat(64),effectiveRouteReason:'vcr-job-completion',nativeTurn:{startSeq:1}},transcript:{header:{runId:'run',completeness:'complete'},messages:[{sessionId:'session-a',role:'user',turnStartSeq:1,parts:[]}]}};
 assert.equal(await vcrReplyUsesStudy(input),true);
 completion={study_id:null,job_id:null,payload:{replayId:'owned-replay'}};assert.equal(await vcrReplyUsesStudy(input),false);
 completion=null;assert.equal(await vcrReplyUsesStudy(input),false);
});

test('whole retained histories use only exact current turns and admitted current child sessions',async()=>{
 const {vcrReplyUsesStudy}=await import('../src/vcrReplyContext.mjs');
 const {serializeRunTranscript}=await import('../src/runTranscripts.mjs');
 const root=(turn,tool)=>({role:'assistant',source:'system',seq:turn+1,turnStartSeq:turn,parts:tool ? [{type:'tool',tool,status:'completed'}] : [{type:'text',text:'普通回复 5。'}]});
 const saved=messages=>{const serialized=serializeRunTranscript({runId:'retained',capturedAt:new Date().toISOString(),sessions:[{sessionId:'session-a',parentSessionId:null,label:'root',capability:null,transcript:{sessionId:'session-a',exhausted:true,lastSeq:22,messages}}]});return{header:serialized.header,messages:serialized.text.trim().split('\n').slice(1).map(line=>JSON.parse(line))};};
 const input={store,selectRunHistory:runHistory,userId:'owner',projectId:'project',studyId:task.id,run:{id:'retained',sessionId:'session-a',status:'succeeded',nativeTurn:{startSeq:20}}};
 assert.equal(await vcrReplyUsesStudy({...input,transcript:saved([root(10,'vcr_read'),root(20,null)])}),false);
 assert.equal(await vcrReplyUsesStudy({...input,transcript:saved([root(10,'research_calculate'),root(20,'vcr_read')])}),true);
 assert.equal(await vcrReplyUsesStudy({...input,replySeq:11,transcript:saved([root(10,'research_calculate'),root(20,'vcr_read')])}),false);
 assert.equal(await vcrReplyUsesStudy({...input,run:{...input.run,nativeTurn:null},transcript:saved([root(20,'vcr_read')])}),false);
 const transcript=saved([root(10,'research_calculate'),root(20,null)]);transcript.header.sessions.push({sessionId:'current-child',parentSessionId:'session-a'},{sessionId:'old-child',parentSessionId:'session-a'});
 transcript.messages.push({sessionId:'current-child',role:'assistant',parts:[{type:'tool',tool:'vcr_read'}]},{sessionId:'old-child',role:'assistant',parts:[{type:'tool',tool:'research_calculate'}]});
 assert.equal(await vcrReplyUsesStudy({...input,transcript,children:[{sessionId:'current-child'}]}),true);
});
