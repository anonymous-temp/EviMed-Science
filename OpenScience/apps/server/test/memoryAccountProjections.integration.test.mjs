import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeIntegration } from './helpers/nativeFixture.mjs';
import { createAccountProjections } from '../src/memoryAccountProjections.mjs';
import { humanInputReceipt } from '../src/memoryHumanSegments.mjs';
import { statementSourceReviewer } from '../src/memoryStatementSources.mjs';
import { createVerificationJudge } from '../src/nativeMemoryVerification.mjs';

const { options, fixture } = nativeIntegration();
for (const reviewer of ['statement', 'clauses']) {
  test(`a ${reviewer} binding projects a conversation paraphrase until the native file is forgotten`, options, async t => {
    const original = '以后报告先给结论再给依据。', stored = '报告一律先给结论，再给依据。';
    const f = await fixture(t, {config:{memoryAccountPresentationEnabled:true, memoryCommitVerificationEnabled:reviewer === 'clauses'}});
    const project = { userId:f.userId, id:'default' };
    const epoch = (await f.database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'default','Default',1048576) RETURNING created_at::text AS epoch", [f.userId])).rows[0].epoch;
    const uri = f.root + '/preferences/self/order.md';
    f.stub.extract = () => ({ adds:[{uri, memory_type:'preferences', after:'- ' + stored}] });
    const respond = data => ({choices:[{message:{content:JSON.stringify(data)}}]});
    f.worker.reviewStatementSources = statementSourceReviewer({config:f.config, callModel:async () => respond({rows:[
      {line:0, kind:'user_statement', subject:'self', conditions:'preserved', message:0, quote:original, presentationMatch:true},
    ]})});
    f.worker.verification.judge = createVerificationJudge({config:{deepseekModel:'fixture', deepseekApiKey:'fixture'},
      callModel:async () => respond({results:[{index:0, verdict:'supported', corrected:null, evidence:[{clause:stored, source:0, quote:original}]}]})});
    const run = {id:'r', sessionId:'session_original', kernelRequestIds:['k'], memoryInput:humanInputReceipt(original)};
    await f.commitConversation('original', [{role:'user', text:original}, {role:'assistant', text:'好的。'}], {projectId:project.id});
    await f.worker.processCommits({userId:f.userId});
    const projection = createAccountProjections({config:f.config, native:f.store, overlay:f.overlay, verification:f.worker.verification,
      methods:null, provenance:null, settings:f.memorySettings, contexts:{forProject:async()=>({kind:'owned', projectCreatedAt:epoch}), assertLive:async()=>{}},
      projectFor:async()=>project, projectRuns:async()=>[run], deleted:async()=>false, clinical:async()=>false});
    const read = () => projection.presentation(f.userId, 'default', 'next');
    assert.deepEqual((await read()).map(memo=>memo.content), [original]);
    const record = (await f.store.records(f.userId)).find(row=>row.uri === uri);
    await f.store.remove(f.userId, record.id, {keepText:true});
    assert.deepEqual(await read(), []);
  });
}
