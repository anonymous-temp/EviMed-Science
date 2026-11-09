// Plan R11 (reworked after the engineering review, P0-1): continuing a study in a new conversation. The grant is the person's explicit,
// recorded, revocable act, the study OWNER's or a member's whose role holds read, write and run; it BINDS the conversation, so the gateway
// resolves the granted study as the conversation's study with no study argument; a member's grant is judged per operation against the
// member's role; a job's completion goes to the conversation that started it, and not to one the study was taken back from.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrGatewayHandler } from '../src/vcrGateway.mjs';
import { createVcrCompletionResolver } from '../src/vcrConversationCompletions.mjs';
import { validateVcrConversationReference } from '../src/vcrConversationReference.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = {skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required'};
let database,isolated,root,vcr,handler,earlier;
/** Which conversation (and account) the next native call proves to be. */
let caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
let callNumber = 0;
const config = {vcrEnabled:true,vcrAudience:'all'};
const runtimeManager = {boundedRuntimeScope:() => null,assertActiveModelGatewayToken:(/** @type {string} */ token) => ({userId:token.split(':')[1],projectId:token.split(':')[2]})};

const post = (/** @type {string} */ operation,/** @type {any} */ body,/** @type {string} */ token = 'token:alice:prj_default') => {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST',url:`/internal/vcr/v1/${operation}`,
    headers:{authorization:`Bearer ${token}`,'x-evimed-execution-context':'{}'}});
  const res = {status:0,body:'',writeHead(/** @type {number} */ s) {this.status = s;return this;},end(/** @type {string} */ chunk = '') {this.body = String(chunk);},json() {return JSON.parse(this.body);}};
  return handler(req,res,() => {}).then(() => res);
};

before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'vcrhand');
  database = new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:4,databaseConnectionTimeoutMs:2000});
  root = await fs.mkdtemp(path.join(os.tmpdir(),'vcr-handoff-'));
  vcr = composeVcr({config:{...config,vcrDataPlaneDir:root},productDatabase:database});
  await vcr.store.ready();
  // the earlier conversation's research, and a stranger's study in the same project
  earlier = await vcr.store.taskContext({userId:'alice',projectId:'prj_default',rootSessionId:'sess_old'});
  handler = createVcrGatewayHandler(config,runtimeManager,{vcr,resolveInvocation:async () => ({...caller,sessionId:caller.rootSessionId,runId:'run_1',callId:`call_${++callNumber}`})});
});
after(async () => {await database?.close();await isolated?.drop();if(root)await fs.rm(root,{recursive:true,force:true});});

const studyOf = async (/** @type {any} */ res) => res.json().data.study?.id ?? res.json().data.studyId ?? null;

test('the grant is recorded, idempotent, revocable and a re-grant is a new row; nobody\'s row is overwritten',options,async () => {
  const first = await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  assert.deepEqual([first.studyId,first.sessionId,first.grantedBy,first.revokedAt],[earlier.id,'sess_new','alice',null]);
  assert.equal((await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'})).grantedAt,first.grantedAt,'granting twice moves nothing');
  // a second person's grant of the same pair is a row of its own and leaves the first one's author alone
  await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'bob'});
  assert.equal((await vcr.store.studyConversationGrant(earlier.id,'sess_new','alice')).grantedBy,'alice');
  assert.equal((await vcr.store.studyConversationGrant(earlier.id,'sess_new','bob')).grantedBy,'bob');
  assert.equal(await vcr.store.revokeStudyConversation(earlier.id,'sess_new','bob'),true,'bob takes back only bob\'s row');
  assert.equal((await vcr.store.studyConversationGrant(earlier.id,'sess_new','alice')).grantedBy,'alice');
  assert.equal(await vcr.store.revokeStudyConversation(earlier.id,'sess_new'),true);
  assert.equal(await vcr.store.revokeStudyConversation(earlier.id,'sess_new'),false,'a second revocation finds nothing in force');
  assert.equal(await vcr.store.studyConversationGrant(earlier.id,'sess_new'),null);
  assert.ok((await vcr.store.studyConversationHandoff(earlier.id,'sess_new','alice')).revokedAt,'the revoked row is still the record');
  const again = await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  assert.equal(again.revokedAt,null);
  assert.ok(Date.parse(again.grantedAt) >= Date.parse(first.grantedAt));
  await vcr.store.revokeStudyConversation(earlier.id,'sess_new');
});

test('a granted conversation works in the handed-over study with no study argument, and a revocation holds at the next call',options,async () => {
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  // no grant: the conversation's own study, never the earlier one
  const own = await post('read',{what:'study'});
  assert.equal(own.status,200,own.body);
  assert.notEqual(await studyOf(own),earlier.id);
  await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  const served = await post('read',{what:'study'});
  assert.equal(served.status,200,served.body);
  assert.equal(await studyOf(served),earlier.id,'the grant binds the conversation to the study');
  // a study argument is no field of the call any more
  assert.equal((await post('read',{what:'study',studyId:earlier.id})).status,400);
  // the grant is for that conversation: another one of the same account is on its own study
  caller = {...caller,rootSessionId:'sess_other'};
  assert.notEqual(await studyOf(await post('read',{what:'study'})),earlier.id);
  caller = {...caller,rootSessionId:'sess_new'};
  // another account's call in the same conversation id is never served the grant of alice
  caller = {userId:'mallory',projectId:'prj_default',rootSessionId:'sess_new'};
  assert.notEqual(await studyOf(await post('read',{what:'study'},'token:mallory:prj_default')),earlier.id);
  // the owner's study is compared as a (person, project) pair: another project of the same account is refused by name
  caller = {userId:'alice',projectId:'prj_elsewhere',rootSessionId:'sess_new'};
  assert.equal((await post('read',{what:'study'},'token:alice:prj_elsewhere')).json().code,'vcr_study_not_granted');
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  // a second grant by the same person for another study wins as the newest
  const second = await vcr.store.taskContext({userId:'alice',projectId:'prj_default',rootSessionId:'sess_second_study'});
  await vcr.store.grantStudyConversation({studyId:second.id,sessionId:'sess_new',grantedBy:'alice'});
  assert.equal(await studyOf(await post('read',{what:'study'})),second.id,'the newest grant the person made there wins');
  await vcr.store.revokeStudyConversation(second.id,'sess_new');
  assert.equal(await studyOf(await post('read',{what:'study'})),earlier.id);
  // revoked: the conversation is back on its own study at the very next call
  await vcr.store.revokeStudyConversation(earlier.id,'sess_new');
  assert.notEqual(await studyOf(await post('read',{what:'study'})),earlier.id);
});

// The reviewer's probe (review-eng-probes/r11-escalation.test.mjs), as a regression test: a viewer, in a project of the same id string,
// handed the owner's study to their own conversation and wrote, ran and cancelled as the owner.
test('a viewer or a reviewer member cannot hand a study over, and a grant a lost role no longer backs is refused per operation',options,async () => {
  const shared = await vcr.store.createStudy({userId:'carol',projectId:'prj_default',name:'Carol',question:'q',dataTier:'T0'});
  await vcr.store.setConversationSession(shared.id,'sess_carol');
  for (const role of ['viewer','clinical_reviewer','statistical_reviewer']) {
    await vcr.store.query(`DELETE FROM evimed_vcr.members WHERE study_id=$1 AND user_id='alice'`,[shared.id]);
    await vcr.store.query(`INSERT INTO evimed_vcr.members (study_id,user_id,role,invited_by) VALUES ($1,'alice',$2,'carol')`,[shared.id,role]);
    await assert.rejects(validateVcrConversationReference(vcr,{id:'alice'},{id:'prj_default'},'sess_new',{studyId:shared.id,kind:'study',objectId:'study'},{grant:true}),{code:'vcr_role_forbids'},role);
    assert.equal(await vcr.store.studyConversationGrant(shared.id,'sess_new','alice'),null,`${role} wrote no grant`);
  }
  // a row written around the staging check (an old grant, a role changed since) is refused again at the gateway, operation by operation
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  await vcr.store.grantStudyConversation({studyId:shared.id,sessionId:'sess_new',grantedBy:'alice'});
  const refusal = async (/** @type {string} */ operation,/** @type {any} */ body) => { const r = await post(operation,body); return [r.status,r.json().code]; };
  assert.deepEqual(await refusal('read',{what:'study'}),[200,undefined],'a viewer may read');
  assert.deepEqual(await refusal('write',{what:'research_question',data:{question:'viewer wrote this'}}),[403,'vcr_study_not_granted']);
  assert.deepEqual(await refusal('simulate',{action:'start',kind:'design_analytic',scenario:{design:{kind:'two_arm_fixed',allocation:.5},endpoint:{type:'binary'},truth:{controlRate:.3,treatmentRate:.2},analysis:{alpha:.05,power:.9,sided:2}}}),[403,'vcr_study_not_granted']);
  assert.deepEqual(await refusal('simulate',{action:'cancel',jobId:'job_x'}),[403,'vcr_study_not_granted']);
  assert.equal((await vcr.store.one(`SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id=$1`,[shared.id])).n,0,'nothing was queued');
  assert.equal(await vcr.store.one(`SELECT 1 FROM evimed_vcr.research_questions WHERE study_id=$1`,[shared.id]),null,'nothing was written');
  // a member whose role holds read, write and run is served; the abilities are judged now, so a removal denies the next call
  await vcr.store.query(`UPDATE evimed_vcr.members SET role='data_manager' WHERE study_id=$1 AND user_id='alice'`,[shared.id]);
  assert.equal((await post('write',{what:'research_question',data:{question:'member wrote this'}})).status,200);
  await vcr.store.query(`DELETE FROM evimed_vcr.members WHERE study_id=$1 AND user_id='alice'`,[shared.id]);
  assert.equal((await post('read',{what:'study'})).status,200,'no membership: the grant resolves to nothing and the conversation is on its own study');
  assert.notEqual(await studyOf(await post('read',{what:'study'})),shared.id);
});

test('a job started in the granted conversation completes there, and a revoked conversation is not woken',options,async () => {
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  const started = await post('simulate',{action:'start',kind:'design_analytic',scenario:{design:{kind:'two_arm_fixed',allocation:.5},
    endpoint:{type:'binary'},truth:{controlRate:.3,treatmentRate:.2},analysis:{alpha:.05,power:.9,sided:2}}});
  assert.equal(started.status,200,started.body);
  const job = await vcr.store.one(`SELECT * FROM evimed_vcr.jobs WHERE study_id=$1 ORDER BY created_at DESC LIMIT 1`,[earlier.id]);
  assert.equal(job.checkpoint.conversationOrigin.rootSessionId,'sess_new','the job belongs to the conversation that started it');
  const sessions = {get:async (/** @type {any} */ _project,/** @type {string} */ id) => ({id})};
  const resolve = createVcrCompletionResolver({accounts:{userById:async (/** @type {string} */ id) => ({id}),requireProject:async (/** @type {any} */ _u,/** @type {string} */ id) => ({id})},
    studies:vcr.store,sessions,allows:() => true});
  const row = {user_id:'alice',project_id:'prj_default',study_id:earlier.id,root_session_id:'sess_new'};
  assert.equal((await resolve(row)).session?.id,'sess_new');
  assert.equal((await resolve({...row,root_session_id:'sess_old'})).session?.id,'sess_old','the study\'s own conversation keeps being woken');
  assert.equal((await resolve({...row,root_session_id:'sess_never'})).session,null,'a conversation the study was never handed to is not');
  await vcr.store.revokeStudyConversation(earlier.id,'sess_new');
  assert.equal((await resolve(row)).session,null,'taking the study back means its jobs no longer wake that conversation');
});
