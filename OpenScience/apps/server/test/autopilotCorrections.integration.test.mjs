import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";
import { NotificationService } from "../src/notificationService.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "Private test PostgreSQL is not configured" };
const owner = `corrections_${randomUUID()}`;
let database, isolated, documents, jobs, service;
const at = new Date("2026-10-25T12:00:00Z");
const notices = new Map();
let notificationFailure = false;
before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "autocorrections");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 12, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Corrections','development')", [owner]);
  for (const id of ["project-test", "project-other"]) await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Corrections',1000000)", [owner,id]);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
  service = new AutopilotService({ documents, jobs, now:()=>at, notifications: { create: async (_user, input) => {
    if (notificationFailure) throw Error("inbox unavailable"); notices.set(input.idempotencyKey, input);
  } } });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1",[owner]);
  await database.close(); await isolated.drop();
});
const input = { projectId:"project-test",title:"Scheduled correction",prompt:"Summarize this task",taskTypes:["routine"],schedule:{kind:"daily",timeZone:"UTC",time:"13:00"},dailyBudgetCny:20,weeklyBudgetCny:80,maxEpisodeCny:8 };
async function active(extra={}) {
  const agenda=await service.create(owner,{...input,...extra});return service.start(owner,agenda.id,{expectedRevision:agenda.revision});
}
async function makeDue(jobId) { await database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp()-interval '1 second' WHERE id=$1",[jobId]); }
function worker(dispatchEpisode) { return new AutopilotWorker({jobs,service,dispatchEpisode}); }

test("real concurrent service replicas admit one identity, one quota slot and one active material-bearing task",options,async()=>{
  const sourceId=`src_${"c".repeat(32)}`;
  await documents.put(owner,"source",sourceId,{title:"Input"},{expectedRevision:0,projectId:"project-other"});
  const scoped={...input,projectId:"project-other",sourceIds:[sourceId]};
  const other=new AutopilotService({documents:new ProductDocuments(database),jobs:new ProductJobs(database),now:()=>at});
  const results=await Promise.all([service.createScheduledTask(owner,scoped,{maxTasks:1}),other.createScheduledTask(owner,scoped,{maxTasks:1})]);
  assert.equal(new Set(results.map(r=>r.agenda.id)).size,1);assert.equal(results.filter(r=>r.created).length,1);
  const saved=await service.get(owner,results[0].agenda.id);assert.equal(saved.payload.status,"active");assert.equal(saved.payload.materials[0].sourceId,sourceId);
  await assert.rejects(other.createScheduledTask(owner,{...scoped,prompt:"Another task"},{maxTasks:1}),{code:"task_limit_reached"});
  const paused=await service.stop(owner,saved.id,{expectedRevision:saved.revision});
  const retry=await other.createScheduledTask(owner,scoped,{maxTasks:1});assert.equal(retry.created,false);assert.equal(retry.agenda.payload.status,paused.payload.status);
});

test("real retry waiting is cancellable and a restarted worker cannot launch its old job",options,async()=>{
  const agenda=await active({prompt:"Cancelable retry"}),execution=await service.runNow(owner,agenda.id,{requestId:"retry-cancel"});let calls=0;
  const dispatch=async()=>{calls++;throw Object.assign(Error("outage"),{code:"runtime_unavailable"});};
  await worker(dispatch).tick();const pending=await service.getEpisode(owner,execution.episode.id);
  assert.equal(pending.payload.status,"retry_pending");assert.equal((await jobs.get(owner,execution.job.id)).status,"queued");
  assert.equal((await service.cancelEpisode(owner,agenda.id,pending.id)).payload.status,"canceled");
  await makeDue(execution.job.id);await worker(dispatch).tick();assert.equal(calls,1);assert.equal((await jobs.get(owner,execution.job.id)).status,"canceled");
  assert.equal((await service.get(owner,agenda.id)).payload.status,"active");
});

test("legacy failed records backed by a queued retry project as retry-pending and remain cancellable",options,async()=>{
  const agenda=await active({prompt:"Legacy retry"}),execution=await service.runNow(owner,agenda.id,{requestId:"legacy"});
  const stored=await documents.get(owner,"episode",execution.episode.id);
  await documents.put(owner,"episode",stored.id,{...stored.payload,status:"failed",launchJobId:null,error:{code:"runtime_unavailable"}},{expectedRevision:stored.revision,projectId:stored.projectId});
  const pending=await service.getEpisode(owner,stored.id);assert.equal(pending.payload.status,"retry_pending");
  const list=await service.listEpisodes(owner,{projectId:agenda.projectId,agendaId:agenda.id});assert.equal(list.items[0].payload.status,"retry_pending");
  await service.cancelEpisode(owner,agenda.id,stored.id);assert.equal((await jobs.get(owner,execution.job.id)).status,"canceled");
});

test("a crash after final queue failure reconciles its episode and sends a deduplicated final notice",options,async()=>{
  const agenda=await active({prompt:"Final crash recovery"}),execution=await service.runNow(owner,agenda.id,{requestId:"crash-final"});
  const claimed=await jobs.claim(["episode"],"test-crashed-worker",{leaseMs:1000});assert.equal(claimed.id,execution.job.id);
  await jobs.fail(owner,claimed.id,claimed.leaseToken,{code:"runtime_unavailable",message:"outage"},{retry:false});
  const before=notices.size;notificationFailure=true;
  await service.reconcileStopWork();assert.equal((await service.getEpisode(owner,execution.episode.id)).payload.status,"failed");
  assert.equal((await service.get(owner,agenda.id)).payload.outcomes.filter(o=>o.episodeId===execution.episode.id).length,1);assert.equal(notices.size,before);
  notificationFailure=false;await service.reconcileStopWork();assert.equal(notices.size,before+1);
  await service.reconcileStopWork();assert.equal(notices.size,before+1);
  assert.equal((await service.cancelEpisode(owner,agenda.id,execution.episode.id)).payload.status,"failed");
});

test("a lost final-attempt lease is reconciled as final failure rather than an orphaned queued episode",options,async()=>{
  const agenda=await active({prompt:"Final lease recovery"}),execution=await service.runNow(owner,agenda.id,{requestId:"expired"});
  await database.query("UPDATE evimed_product.jobs SET attempts=max_attempts-1 WHERE id=$1",[execution.job.id]);
  const claimed=await jobs.claim(["episode"],"lost-last-lease",{leaseMs:1000});assert.equal(claimed.id,execution.job.id);
  await database.query("UPDATE evimed_product.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[claimed.id]);
  await jobs.claim(["episode"],"recover-last-lease",{leaseMs:1000});await service.reconcileStopWork();
  assert.equal((await service.getEpisode(owner,execution.episode.id)).payload.status,"failed");
  assert.equal((await jobs.get(owner,execution.job.id)).error.code,"product_job_attempts_exhausted");
});

test("real history cursor pages retain all 105 executions and keep account/project filters",options,async()=>{
  const agenda=await active({prompt:"History pagination"});
  for(let i=0;i<105;i++)await documents.put(owner,"episode",`history-${randomUUID()}`,{agendaId:agenda.id,status:"merged",prompt:"private",createdAt:at.toISOString()},{expectedRevision:0,projectId:agenda.projectId});
  const first=await service.listEpisodes(owner,{projectId:agenda.projectId,agendaId:agenda.id,limit:100});
  const second=await service.listEpisodes(owner,{projectId:agenda.projectId,agendaId:agenda.id,limit:100,cursor:first.nextCursor});
  assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,105);
  assert.ok([...first.items,...second.items].every(x=>x.payload.prompt===undefined));
  assert.equal((await service.listEpisodes("another-account",{projectId:agenda.projectId,agendaId:agenda.id})).items.length,0);
  assert.equal((await service.listEpisodes(owner,{projectId:"project-other",agendaId:agenda.id})).items.length,0);
});

test("atomic admission needs only its held connection in a single-connection pool",options,async()=>{
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'pool-one','Pool one',1000000)",[owner]);
  const single=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:200});
  const singleDocuments=new ProductDocuments(single),singleService=new AutopilotService({documents:singleDocuments,jobs:new ProductJobs(single),now:()=>at});
  try {
    await singleDocuments.list(owner,"agenda",{projectId:"pool-one"});
    const result=await singleService.createScheduledTask(owner,{...input,projectId:"pool-one"},{maxTasks:1});
    assert.equal(result.created,true);assert.equal((await singleService.createScheduledTask(owner,{...input,projectId:"pool-one"},{maxTasks:1})).created,false);
  } finally {await single.close();}
});

test("callers at and beyond pool capacity serialize quota admission without borrowing a second connection",options,async()=>{
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'pool-many','Pool many',1000000)",[owner]);
  const small=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:2,databaseConnectionTimeoutMs:300});
  const smallDocuments=new ProductDocuments(small),smallService=new AutopilotService({documents:smallDocuments,jobs:new ProductJobs(small),now:()=>at});
  try {
    await smallDocuments.list(owner,"agenda",{projectId:"pool-many"});
    const results=await Promise.allSettled(Array.from({length:4},(_,i)=>smallService.createScheduledTask(owner,{...input,projectId:"pool-many",prompt:`Concurrent ${i}`},{maxTasks:2})));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,2);
    assert.ok(results.filter(r=>r.status==="rejected").every(r=>r.reason.code==="task_limit_reached"));
  } finally {await small.close();}
});

test("a source removed after prevalidation cannot leave an active task with a newly associated missing input",options,async()=>{
  const sourceId=`src_${randomUUID().replaceAll("-","")}`;
  const source=await documents.put(owner,"source",sourceId,{title:"Removed during admission"},{expectedRevision:0,projectId:"project-test"});
  const racing=new AutopilotService({documents,jobs,now:()=>at});const prepare=racing.prepareAgenda.bind(racing);
  racing.prepareAgenda=async(...args)=>{const prepared=await prepare(...args);await documents.remove(owner,"source",sourceId,source.revision);return prepared;};
  await assert.rejects(racing.createScheduledTask(owner,{...input,prompt:"Removed source race",sourceIds:[sourceId]},{maxTasks:100}),{code:"autopilot_material_not_found"});
  assert.equal((await service.list(owner,{projectId:"project-test"})).items.some(a=>a.payload.prompt==="Removed source race"),false);
});


test("real inbox persistence receives one useful final failure or automatic-pause notice per execution",options,async()=>{
  const notifications=new NotificationService(database),notifying=new AutopilotService({documents,jobs,notifications,now:()=>at});
  const created=await notifying.create(owner,{...input,prompt:"Real inbox failure notices"});
  const agenda=await notifying.start(owner,created.id,{expectedRevision:created.revision});
  for(const requestId of ["failure-one","failure-two"]){
    const execution=await notifying.runNow(owner,agenda.id,{requestId});
    await notifying.markEpisodeFailed(owner,execution.episode.id,{code:"runtime_unavailable"});
    await notifying.markEpisodeFailed(owner,execution.episode.id,{code:"runtime_unavailable"});
  }
  const saved=await notifying.get(owner,agenda.id);assert.equal(saved.payload.status,"paused");
  const notices=(await notifications.list(owner,{projectId:agenda.projectId})).items;
  assert.equal(notices.length,2);assert.ok(notices.every(n=>n.source.type==="system"&&n.source.id===`autopilot-task:${agenda.id}`&&n.severity==="attention"));
  assert.ok(notices.every(n=>n.actions.some(a=>a.id==="open")));assert.ok(notices.some(n=>n.title.endsWith("已暂停")));
  await notifying.reconcileStopWork();assert.equal((await notifications.list(owner,{projectId:agenda.projectId})).items.length,2);
});

test("disabled direct timer and evolution admission leave the PostgreSQL occurrence and queue untouched",options,async()=>{
  const agenda=await active({prompt:"Disabled direct admission"});
  const disabled=new AutopilotService({documents,jobs,enabled:false,now:()=>new Date("2026-10-25T13:00:00Z")});
  const before=await service.get(owner,agenda.id);
  await assert.rejects(disabled.scheduleDue(owner,agenda.id),{code:"task_tools_disabled",status:503});
  assert.equal((await service.get(owner,agenda.id)).revision,before.revision);assert.equal((await service.get(owner,agenda.id)).payload.lastScheduledOccurrence,null);
  const paused=await documents.put(owner,"agenda",agenda.id,{...before.payload,enabled:false,status:"paused",plannerStop:{kind:"needs_input"},evolutionWaiting:{sourceEpisodeId:"waiting-source"}},{expectedRevision:before.revision,projectId:before.projectId});
  await assert.rejects(disabled.wakeForEvolution({userId:owner,agendaId:agenda.id,sourceEpisodeId:"waiting-source",event:{id:"ready-resource"}}),{code:"task_tools_disabled",status:503});
  const held=await service.get(owner,agenda.id);assert.equal(held.revision,paused.revision);assert.equal(held.payload.status,"paused");assert.equal(held.payload.lastEvolutionWake,undefined);
  const count=await database.query("SELECT count(*)::int AS n FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'agendaId'=$2",[owner,agenda.id]);assert.equal(count.rows[0].n,0);
});

test("disabled platform research admission cannot enqueue an internal programme episode",options,async()=>{
  const publisher="evimed-evidence-center",projectId="evimed-evidence";
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,$2,'Internal evidence',1000000) ON CONFLICT DO NOTHING",[publisher,projectId]);
  const created=await service.create(publisher,{...input,projectId,prompt:"Internal programme",taskTypes:["evidence-update"]});
  const agenda=await service.start(publisher,created.id,{expectedRevision:created.revision});let plans=0,admissions=0;
  const disabled=new AutopilotService({documents,jobs,enabled:false,planner:{decide:async()=>{plans++;return{action:"run",taskType:"evidence-update"};}},programme:{owns:()=>true,assertAdmitted:async()=>{admissions++;}},now:()=>at});
  await assert.rejects(disabled.runNow(publisher,agenda.id,{requestId:"programme-day"}),{code:"task_tools_disabled",status:503});
  assert.equal(plans,0);assert.equal(admissions,0);assert.equal((await documents.list(publisher,"episode",{projectId})).items.length,0);
  assert.equal((await service.get(publisher,agenda.id)).revision,agenda.revision);
});

for(const action of ["stop","archive"])test(`disabled PostgreSQL ${action} directly stops accepted work and retires queued launches`,options,async()=>{
  const agenda=await active({prompt:`Disabled accepted ${action}`}),execution=await service.runNow(owner,agenda.id,{requestId:`accepted-${action}`});
  await service.markEpisodeDispatched(owner,execution.episode.id,{runId:`accepted-${action}`,sessionId:`session-${action}`});
  await database.query("UPDATE evimed_product.jobs SET status='succeeded',finished_at=clock_timestamp() WHERE id=$1",[execution.job.id]);
  const waiting=await service.runNow(owner,agenda.id,{requestId:`waiting-${action}`}),current=await service.get(owner,agenda.id),stops=[];
  const disabled=new AutopilotService({documents,jobs,enabled:false,now:()=>at});
  const result=await disabled[action](owner,agenda.id,{expectedRevision:current.revision},{stopRun:async target=>{stops.push(target.runId);}});
  assert.deepEqual(stops,[`accepted-${action}`]);assert.equal(result.payload.stopSweep.cancellationPending,false);
  assert.equal((await jobs.get(owner,waiting.job.id)).status,"canceled");assert.equal((await service.getEpisode(owner,execution.episode.id)).payload.cancellation.status,"completed");
  assert.equal(Boolean(result.payload.archivedAt),action==="archive");
});

test("a failed disabled deletion remains visible and the original request can retry its exact saved cancellation",options,async()=>{
  const agenda=await active({prompt:"Retry incomplete disabled deletion"}),execution=await service.runNow(owner,agenda.id,{requestId:"delete-failure"});
  await service.markEpisodeDispatched(owner,execution.episode.id,{runId:"delete-recovery-run",sessionId:"delete-recovery-session"});
  const current=await service.get(owner,agenda.id),disabled=new AutopilotService({documents,jobs,enabled:false,now:()=>at});
  await assert.rejects(disabled.archive(owner,agenda.id,{expectedRevision:current.revision},{stopRun:async()=>{throw Error("cancel provider unavailable");}}),{code:"autopilot_cancellation_failed",status:503});
  const pending=await service.get(owner,agenda.id);assert.equal(pending.payload.archivedAt,undefined);assert.equal(pending.payload.stopSweep.cancellationPending,true);
  assert.ok((await service.list(owner,{projectId:agenda.projectId})).items.some(item=>item.id===agenda.id));
  const retried=await disabled.archive(owner,agenda.id,{expectedRevision:current.revision},{stopRun:async target=>{assert.equal(target.runId,"delete-recovery-run");}});
  assert.ok(retried.payload.archivedAt);assert.equal(retried.payload.stopSweep.cancellationPending,false);
  assert.equal((await service.list(owner,{projectId:agenda.projectId})).items.some(item=>item.id===agenda.id),false);
});
