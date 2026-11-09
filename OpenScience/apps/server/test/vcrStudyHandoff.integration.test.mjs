// Plan R11: continuing a study in a new conversation. The grant is the person's explicit, recorded, revocable act; the gateway serves an
// explicit studyId to the conversation holding it and to no other; per-operation authorization is unchanged; a job's completion goes to
// the conversation that started it, and not to one the study was taken back from.
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

test('the grant is recorded, idempotent, revocable and a re-grant is a new one',options,async () => {
  const first = await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  assert.deepEqual([first.studyId,first.sessionId,first.grantedBy,first.revokedAt],[earlier.id,'sess_new','alice',null]);
  assert.equal((await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'})).grantedAt,first.grantedAt,'granting twice moves nothing');
  assert.equal(await vcr.store.revokeStudyConversation(earlier.id,'sess_new'),true);
  assert.equal(await vcr.store.revokeStudyConversation(earlier.id,'sess_new'),false,'a second revocation finds nothing in force');
  assert.equal(await vcr.store.studyConversationGrant(earlier.id,'sess_new'),null);
  assert.ok((await vcr.store.studyConversationHandoff(earlier.id,'sess_new')).revokedAt,'the revoked row is still the record');
  const again = await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  assert.equal(again.revokedAt,null);
  assert.ok(Date.parse(again.grantedAt) >= Date.parse(first.grantedAt));
  await vcr.store.revokeStudyConversation(earlier.id,'sess_new');
});

test('the gateway serves an explicit studyId to the granted conversation only, and a revocation holds at the next call',options,async () => {
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  // no studyId: the conversation's own study, never the earlier one (no implicit read is widened)
  const own = await post('read',{what:'study'});
  assert.equal(own.status,200,own.body);
  assert.notEqual(await studyOf(own),earlier.id);
  // an explicit one without a grant is refused by name
  const refused = await post('read',{what:'study',studyId:earlier.id});
  assert.equal(refused.status,403);
  assert.equal(refused.json().code,'vcr_study_not_granted');
  await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  const served = await post('read',{what:'study',studyId:earlier.id});
  assert.equal(served.status,200,served.body);
  assert.equal(await studyOf(served),earlier.id);
  // the grant is for that conversation: another one of the same account is refused
  caller = {...caller,rootSessionId:'sess_other'};
  assert.equal((await post('read',{what:'study',studyId:earlier.id})).json().code,'vcr_study_not_granted');
  caller = {...caller,rootSessionId:'sess_new'};
  // another project, a malformed id, another account's grant of the same pair
  assert.equal((await post('read',{what:'study',studyId:'bad id!'})).json().code,'vcr_study_id_invalid');
  caller = {...caller,projectId:'prj_elsewhere'};
  assert.equal((await post('read',{what:'study',studyId:earlier.id},'token:alice:prj_elsewhere')).json().code,'vcr_study_not_granted');
  caller = {userId:'mallory',projectId:'prj_default',rootSessionId:'sess_new'};
  assert.equal((await post('read',{what:'study',studyId:earlier.id},'token:mallory:prj_default')).json().code,'vcr_study_not_granted');
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  // revoked: denied at the very next call
  await vcr.store.revokeStudyConversation(earlier.id,'sess_new');
  assert.equal((await post('read',{what:'study',studyId:earlier.id})).json().code,'vcr_study_not_granted');
  assert.equal((await post('read',{what:'study'})).status,200,'the conversation\'s own study still works');
});

test('a member removed from the study is denied through a grant, as through any route',options,async () => {
  const shared = await vcr.store.createStudy({userId:'carol',projectId:'prj_default',name:'Carol',question:'q',dataTier:'T0'});
  await vcr.store.query(`INSERT INTO evimed_vcr.members (study_id,user_id,role,invited_by) VALUES ($1,'alice','viewer','carol')`,[shared.id]);
  await vcr.store.grantStudyConversation({studyId:shared.id,sessionId:'sess_new',grantedBy:'alice'});
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  assert.equal((await post('read',{what:'study',studyId:shared.id})).status,200);
  await vcr.store.query(`DELETE FROM evimed_vcr.members WHERE study_id=$1 AND user_id='alice'`,[shared.id]);
  assert.equal((await post('read',{what:'study',studyId:shared.id})).json().code,'vcr_study_not_granted','no membership, no study');
});

test('a job started in the granted conversation completes there, and a revoked conversation is not woken',options,async () => {
  caller = {userId:'alice',projectId:'prj_default',rootSessionId:'sess_new'};
  await vcr.store.grantStudyConversation({studyId:earlier.id,sessionId:'sess_new',grantedBy:'alice'});
  const started = await post('simulate',{studyId:earlier.id,action:'start',kind:'design_analytic',scenario:{design:{kind:'two_arm_fixed',allocation:.5},
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
