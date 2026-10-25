import assert from "node:assert/strict";
import test from "node:test";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";

function fixture(initial = "2026-10-25T12:00:00Z") {
  let at = new Date(initial), serial = 0;
  const rows = new Map(), queue = [], notices = new Map();
  const key = (u, k, id) => `${u}:${k}:${id}`;
  const documents = {
    get: async (u, k, id) => rows.get(key(u, k, id)) ?? null,
    list: async (u, k, { projectId, filter = {}, limit = 100, cursor = null } = {}) => {
      const all = [...rows.values()].filter(r => r.userId === u && r.kind === k
        && (projectId === undefined || r.projectId === projectId) && Object.entries(filter).every(([k, v]) => r.payload[k] === v))
        .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const offset = cursor ? Number(cursor) : 0;
      return { items: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    },
    put: async (u, k, id, payload, { expectedRevision, projectId = null }) => {
      const old = rows.get(key(u, k, id));
      if ((old?.revision ?? 0) !== expectedRevision) throw Object.assign(Error("conflict"), { code: "product_revision_conflict" });
      const row = { id, userId: u, kind: k, projectId, payload, revision: expectedRevision + 1, createdAt: old?.createdAt ?? at.toISOString() };
      rows.set(key(u, k, id), row); return row;
    },
  };
  const jobs = {
    get: async (_u, id) => queue.find(j => j.id === id) ?? null,
    enqueue: async (userId, kind, payload, options) => {
      let job = queue.find(j => j.options.idempotencyKey === options.idempotencyKey);
      if (!job) { job = { id: `job-${queue.length}`, userId, kind, payload, options, projectId: options.projectId, status: "queued", attempts: 0, maxAttempts: 3 }; queue.push(job); }
      return job;
    },
    claim: async () => { const job = queue.find(j => j.status === "queued"); if (!job) return null;
      job.status = "running"; job.attempts++; return { ...job, leaseToken: "lease" }; },
    renew: async (_u,id) => queue.find(j=>j.id===id)?.status === "running",
    finish: async (_u, id, _lease, result) => { const j=queue.find(j=>j.id===id); j.status="succeeded";j.result=result;return j; },
    fail: async (_u,id,_lease,error,{retry}) => {const j=queue.find(j=>j.id===id);j.status=retry&&j.attempts<j.maxAttempts?"queued":"failed";j.error=error;return j;},
    cancelQueued: async (_u,_kind,match) => {let count=0;for(const j of queue)if(j.status==="queued"&&Object.entries(match).every(([k,v])=>j.payload[k]===v)){j.status="canceled";count++;}return count;},
    cancel: async (_u,id)=>{const j=queue.find(j=>j.id===id);if(j)j.status="canceled";return j;},
  };
  const notifications={create:async(userId,input)=>{notices.set(input.idempotencyKey,{userId,...input});}};
  const service = new AutopilotService({ documents, jobs, notifications, now: () => at, id: p => `${p}${++serial}` });
  const input = { projectId: "p", title: "Daily report", prompt: "Summarize the supplied file", taskTypes: ["routine"], schedule: {kind:"daily",timeZone:"UTC",time:"13:00"}, dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8 };
  async function create(extra={}) {const row=await service.create("u",{...input,...extra});return service.start("u",row.id,{expectedRevision:row.revision});}
  return {service,documents,jobs,queue,notices,input,create,setAt:value=>{at=new Date(value);}};
}

test("editing an old calendar bounds both the projected next run and dispatch at the edit time",async()=>{
  const f=fixture("2026-10-24T00:00:00Z"); let row=await f.create();f.setAt("2026-10-25T12:00:00Z");
  row=await f.service.update("u",row.id,{expectedRevision:row.revision,schedule:{kind:"daily",timeZone:"UTC",time:"07:00"}});
  assert.equal(f.service.projectAgenda(row).payload.nextRunAt,"2026-10-26T07:00:00.000Z");
  assert.equal(await f.service.scheduleDue("u",row.id),null);
});

test("a retry-pending dispatch can be canceled before its next worker claim",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"first"});let calls=0;
  const worker=new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>{calls++;throw Object.assign(Error("outage"),{code:"runtime_unavailable"});}});
  await worker.tick(); const pending=await f.service.getEpisode("u",execution.episode.id);
  assert.equal(pending.payload.status,"retry_pending");assert.ok(pending.payload.resourceDeferrals.episode.retryAt);
  assert.equal(f.notices.size,0,"transient attempts stay quiet");
  assert.equal((await f.service.cancelEpisode("u",row.id,pending.id)).payload.status,"canceled");
  assert.equal((await f.documents.get("u","episode",pending.id)).payload.status,"canceled","cancellation is durable before its reply");
  await worker.tick();assert.equal(calls,1);assert.equal(f.queue[0].status,"canceled");assert.equal((await f.service.get("u",row.id)).payload.status,"active");
});

test("retry exhaustion settles the episode once and produces one final failure notice",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"first"});
  const worker=new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>{throw Object.assign(Error("outage"),{code:"runtime_unavailable"});}});
  for(let i=0;i<3;i++)await worker.tick();
  const failed=await f.service.getEpisode("u",execution.episode.id),agenda=await f.service.get("u",row.id);
  assert.equal(f.queue[0].status,"failed");assert.equal(failed.payload.status,"failed");assert.equal(failed.payload.resourceDeferrals.episode.retryAt,null);
  assert.equal(agenda.payload.outcomes.length,1,"attempts are not separate task outcomes");assert.equal(f.notices.size,1);
  await f.service.markEpisodeFailed("u",failed.id,{code:"runtime_unavailable"});
  assert.equal((await f.service.get("u",row.id)).payload.outcomes.length,1);assert.equal(f.notices.size,1);
  assert.equal((await f.service.cancelEpisode("u",row.id,failed.id)).payload.status,"failed","a final failure retains its outcome");
});

test("two distinct failed routine executions pause their original ordinary intent",async()=>{
  const f=fixture(),row=await f.create({taskTypes:["routine","literature-sentinel","data-prospecting"]});
  for(const requestId of ["one","two"]){const e=await f.service.runNow("u",row.id,{requestId});await f.service.markEpisodeDispatched("u",e.episode.id,{runId:`run-${requestId}`,sessionId:"session"});await f.service.completeRun("u",{projectId:"p",runId:`run-${requestId}`,status:"failed",claims:[],artifacts:[]});}
  const paused=await f.service.get("u",row.id);assert.equal(paused.payload.status,"paused");assert.equal(paused.payload.taskIntent,"routine");
  const resumed=await f.service.start("u",row.id,{expectedRevision:paused.revision});
  const next=await f.service.runNow("u",row.id,{requestId:"three"});assert.equal(next.episode.payload.taskType,"routine");assert.equal(resumed.payload.status,"active");
});

test("a delayed once-only research job crossing the unread threshold settles its execution",async()=>{
  const f=fixture("2026-10-10T00:00:00Z"),row=await f.create({taskTypes:["evidence-update"],schedule:{kind:"once",timeZone:"UTC",time:"07:00",date:"2026-10-16"}});
  const manual=await f.service.runNow("u",row.id,{requestId:"manual"});
  await f.service.markEpisodeDispatched("u",manual.episode.id,{runId:"run-manual",sessionId:"session"});
  await f.service.completeRun("u",{projectId:"p",runId:"run-manual",status:"succeeded",deltaSchemaVersion:1,claims:[],artifacts:[]});f.queue[0].status="succeeded";
  f.setAt("2026-10-16T07:00:00Z");const once=await f.service.scheduleDue("u",row.id);f.setAt("2026-10-17T07:00:00Z");
  await new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>assert.fail("inactive research must not dispatch")}).tick();
  assert.equal(f.queue[1].result.reason,"agenda_inactive");assert.equal((await f.service.getEpisode("u",once.episode.id)).payload.status,"canceled");
  const paused=await f.service.get("u",row.id);assert.equal(paused.payload.status,"paused");assert.equal(f.notices.size,1);
  await f.service.start("u",row.id,{expectedRevision:paused.revision});assert.equal(await f.service.scheduleDue("u",row.id),null);
});

test("fresh delayed routine jobs do not inherit unread research inactivity",async()=>{
  const f=fixture("2026-10-10T00:00:00Z"),row=await f.create({schedule:{kind:"once",timeZone:"UTC",time:"07:00",date:"2026-10-16"}});f.setAt("2026-10-25T07:00:00Z");
  const once=await f.service.scheduleDue("u",row.id);let calls=0;
  await new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>{calls++;await f.service.markEpisodeDispatched("u",once.episode.id,{runId:"routine",sessionId:"session"});return{runId:"routine",sessionId:"session"};}}).tick();
  assert.equal(calls,1);assert.equal((await f.service.get("u",row.id)).payload.status,"active");
});

test("episode history follows cursors past one hundred results without repeating records",async()=>{
  const f=fixture();for(let i=0;i<105;i++)await f.documents.put("u","episode",`episode-${String(i).padStart(3,"0")}`,{agendaId:"a",status:"merged",prompt:"private"},{expectedRevision:0,projectId:"p"});
  const first=await f.service.listEpisodes("u",{projectId:"p",agendaId:"a",limit:100});assert.equal(first.items.length,100);assert.ok(first.nextCursor);
  const second=await f.service.listEpisodes("u",{projectId:"p",agendaId:"a",cursor:first.nextCursor,limit:100});assert.equal(second.items.length,5);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,105);assert.ok(second.items.every(r=>!r.payload.prompt));
});

test("concurrent identical conversation creates and response-loss retry retain one active task including materials",async()=>{
  const f=fixture(),sourceId=`src_${"a".repeat(32)}`;await f.documents.put("u","source",sourceId,{},{expectedRevision:0,projectId:"p"});
  const input={...f.input,sourceIds:[sourceId]};
  const results=await Promise.all([f.service.createScheduledTask("u",input,{maxTasks:1}),f.service.createScheduledTask("u",input,{maxTasks:1})]);
  assert.equal(new Set(results.map(r=>r.agenda.id)).size,1);assert.equal(results.filter(r=>r.created).length,1);assert.equal(results[0].agenda.payload.status,"active");assert.equal(results[0].agenda.payload.materials[0].sourceId,sourceId);
  const retry=await f.service.createScheduledTask("u",input,{maxTasks:1});assert.equal(retry.created,false);
  await assert.rejects(f.service.createScheduledTask("u",{...input,prompt:"different"},{maxTasks:1}),{code:"task_limit_reached"});
});

test("material validation on create and update leaves no partial saved task",async()=>{
  const f=fixture(),other=`src_${"b".repeat(32)}`;await f.documents.put("u","source",other,{},{expectedRevision:0,projectId:"other"});
  await assert.rejects(f.service.create("u",{...f.input,sourceIds:[other]}),{code:"autopilot_material_not_found"});assert.equal((await f.service.list("u",{projectId:"p"})).items.length,0);
  const row=await f.create();await assert.rejects(f.service.update("u",row.id,{expectedRevision:row.revision,prompt:"changed",sourceIds:[other]}),{code:"autopilot_material_not_found"});assert.equal((await f.service.get("u",row.id)).payload.prompt,f.input.prompt);
});

test("pausing a task closes queued retries while retaining an earlier terminal failure",async()=>{
  const f=fixture(),row=await f.create();const ended=await f.service.runNow("u",row.id,{requestId:"ended"});f.queue[0].status="failed";
  await f.service.markEpisodeFailed("u",ended.episode.id,{code:"runtime_unavailable"});
  const pending=await f.service.runNow("u",row.id,{requestId:"pending"});
  await new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>{throw Object.assign(Error("outage"),{code:"runtime_unavailable"});}}).tick();
  const current=await f.service.get("u",row.id);await f.service.stop("u",row.id,{expectedRevision:current.revision});
  assert.equal((await f.service.getEpisode("u",ended.episode.id)).payload.status,"failed");
  assert.equal((await f.service.getEpisode("u",pending.episode.id)).payload.status,"canceled");assert.equal(f.queue[1].status,"canceled");
});

test("a terminal attempt cannot become a new task failure after bounded agenda history ages out",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"old-failure"});f.queue[0].status="failed";
  await f.service.markEpisodeFailed("u",execution.episode.id,{code:"runtime_unavailable"});
  for(let i=0;i<100;i++){const agenda=await f.service.get("u",row.id);await f.service.recordOutcome("u",row.id,{expectedRevision:agenda.revision,episodeId:`later-${i}`,taskType:"routine",status:"succeeded",gatedClaims:0});}
  const before=await f.service.get("u",row.id);assert.equal(before.payload.outcomes.some(o=>o.episodeId===execution.episode.id),false);
  await f.service.markEpisodeFailed("u",execution.episode.id,{code:"runtime_unavailable"});
  assert.equal((await f.service.get("u",row.id)).payload.consecutiveFailures,0);assert.equal(f.notices.size,1);
});

test("ordinary title and calendar edits keep the classified intent when a form resubmits the same type set",async()=>{
  const f=fixture(),types=["routine","literature-sentinel","evidence-update","data-prospecting"],row=await f.create({taskTypes:types});
  await f.service.runNow("u",row.id,{requestId:"classified"});
  const before=await f.service.get("u",row.id);assert.equal(before.payload.taskIntent,"routine");
  const edited=await f.service.update("u",row.id,{expectedRevision:before.revision,title:"Renamed",taskTypes:[...types].reverse(),schedule:{kind:"daily",timeZone:"UTC",time:"14:00"}});
  assert.equal(edited.payload.taskIntent,"routine");
  f.service.planner={decide:async()=>({action:"run",taskType:"evidence-update",source:"model"})};
  assert.equal((await f.service.runNow("u",row.id,{requestId:"after-edit"})).episode.payload.taskType,"routine");
});

test("a dispatch binding persisted before a lost callback keeps its accepted run cancellable",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"accepted-lost-return"});
  await new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async()=>{
    await f.service.markEpisodeDispatched("u",execution.episode.id,{runId:"accepted-run",sessionId:"session"});
    throw Object.assign(Error("lost dispatcher return"),{code:"runtime_unavailable"});
  }}).tick();
  assert.equal((await f.service.getEpisode("u",execution.episode.id)).payload.status,"running");assert.equal(f.notices.size,0);
  let stopped=null;await f.service.cancelEpisode("u",row.id,execution.episode.id,{stopRun:async target=>{stopped=target;await f.service.markEpisodeCanceled("u",execution.episode.id);}});
  assert.equal(stopped.runId,"accepted-run");assert.equal((await f.service.getEpisode("u",execution.episode.id)).payload.status,"canceled");
});

test("task identity preserves meaningful instruction whitespace instead of merging different code requests",async()=>{
  const f=fixture();
  const first=await f.service.createScheduledTask("u",{...f.input,prompt:"Write code:\nif ready:\n  run()"},{maxTasks:2});
  const second=await f.service.createScheduledTask("u",{...f.input,prompt:"Write code:\nif ready:\nrun()"},{maxTasks:2});
  assert.equal(first.created,true);assert.equal(second.created,true);assert.notEqual(first.agenda.id,second.agenda.id);
});

test("the disabled service refuses every execution entrypoint before changing task state or scanning",async()=>{
  const f=fixture(),row=await f.create();
  const disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false,now:()=>new Date("2026-10-25T13:00:00Z")});
  const before=await f.service.get("u",row.id);let scans=0;
  const attempts=[()=>disabled.start("u",row.id,{expectedRevision:before.revision}),()=>disabled.runNow("u",row.id,{requestId:"disabled"}),
    ()=>disabled.followUp("u",row.id,{requestId:"disabled-followup",note:"Look again"}),()=>disabled.schedule("u",row.id,{date:"2026-10-25"}),
    ()=>disabled.scheduleDue("u",row.id),()=>disabled.scheduleActive({query:async()=>{scans++;return{rows:[]};}}),
    ()=>disabled.createScheduledTask("u",{...f.input,prompt:"Disabled active creation"},{maxTasks:10})];
  for(const attempt of attempts)await assert.rejects(attempt,{code:"task_tools_disabled",status:503});
  assert.equal(scans,0);assert.equal(f.queue.length,0);assert.equal((await f.service.get("u",row.id)).revision,before.revision);
  const edited=await disabled.update("u",row.id,{expectedRevision:before.revision,title:"Still editable"});
  assert.equal(edited.payload.title,"Still editable");await disabled.stop("u",row.id,{expectedRevision:edited.revision});
  assert.equal((await disabled.get("u",row.id)).payload.status,"stopped");
});

test("disabled evolution wake retains its exact paused authorization and existing runs may still settle",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"already-running"});
  await f.service.markEpisodeDispatched("u",execution.episode.id,{runId:"accepted-before-disabled",sessionId:"session"});
  const current=await f.service.get("u",row.id);
  const paused=await f.documents.put("u","agenda",row.id,{...current.payload,enabled:false,status:"paused",plannerStop:{kind:"needs_input"},evolutionWaiting:{sourceEpisodeId:"source-episode"}},{expectedRevision:current.revision,projectId:current.projectId});
  const disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false,now:()=>new Date("2026-10-25T13:00:00Z")});
  await assert.rejects(disabled.wakeForEvolution({userId:"u",agendaId:row.id,sourceEpisodeId:"source-episode",event:{id:"resource-ready"}}),{code:"task_tools_disabled",status:503});
  const held=await disabled.get("u",row.id);assert.equal(held.revision,paused.revision);assert.equal(held.payload.status,"paused");assert.equal(held.payload.lastEvolutionWake,undefined);
  await disabled.completeRun("u",{projectId:"p",runId:"accepted-before-disabled",status:"succeeded",claims:[],artifacts:[]});
  assert.equal((await disabled.getEpisode("u",execution.episode.id)).payload.status,"merged");
});

test("disabled research settlement preserves its report and labels unstarted verification without queuing more work",async()=>{
  const f=fixture(),row=await f.create({taskTypes:["evidence-update"]}),execution=await f.service.runNow("u",row.id,{requestId:"research-before-disable"});
  await f.service.markEpisodeDispatched("u",execution.episode.id,{runId:"research-running",sessionId:"session"});
  const disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false,now:()=>new Date("2026-10-25T13:00:00Z")});
  const digest=await disabled.completeRun("u",{projectId:"p",runId:"research-running",status:"succeeded",deltaSchemaVersion:1,artifacts:["report.md"],claims:[{id:"claim-one",statement:"A retained finding",type:"direct",tier:"unverified",sources:["doi:10.1000/one"],provenance:{episodeId:execution.episode.id,artifact:"report.md"}}]});
  const ended=await disabled.getEpisode("u",execution.episode.id);assert.equal(ended.payload.status,"merged");assert.equal(ended.payload.claims.length,1);
  assert.equal(f.queue.filter(j=>j.kind==="verify").length,0);assert.equal(ended.payload.claims[0].verification.status,"unscheduled");assert.equal(ended.payload.claims[0].verification.reason,"task_tools_disabled");
  assert.equal(digest.payload.leads[0].verification.reason,"task_tools_disabled");
});

for(const action of ["stop","archive"])test(`disabled ${action} stops the exact accepted run and makes queued launches inert`,async()=>{
  const f=fixture(),row=await f.create(),running=await f.service.runNow("u",row.id,{requestId:`running-${action}`});
  await f.service.markEpisodeDispatched("u",running.episode.id,{runId:`accepted-${action}`,sessionId:"session"});f.queue[0].status="succeeded";
  const queued=await f.service.runNow("u",row.id,{requestId:`queued-${action}`}),current=await f.service.get("u",row.id),calls=[];
  const disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false});
  await disabled[action]("u",row.id,{expectedRevision:current.revision},{stopRun:async target=>{calls.push(target);}});
  assert.deepEqual(calls.map(target=>target.runId),[`accepted-${action}`]);assert.equal((await f.service.getEpisode("u",running.episode.id)).payload.cancellation.status,"completed");
  assert.equal((await f.service.getEpisode("u",queued.episode.id)).payload.status,"canceled");assert.equal(f.queue[1].status,"canceled");
  assert.ok(f.queue.filter(job=>job.payload.action==="cancel").every(job=>job.status==="canceled"));
});

test("failed disabled stop reports its persisted partial state and the same request can finish cancellation",async()=>{
  const f=fixture(),row=await f.create(),running=await f.service.runNow("u",row.id,{requestId:"retry-stop"});
  await f.service.markEpisodeDispatched("u",running.episode.id,{runId:"accepted-to-stop",sessionId:"session"});f.queue[0].status="succeeded";
  const current=await f.service.get("u",row.id),disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false});
  await assert.rejects(disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async()=>{throw Error("provider unavailable");}}),{code:"autopilot_cancellation_failed",status:503});
  assert.equal((await f.service.get("u",row.id)).payload.status,"stopped");assert.equal((await f.service.getEpisode("u",running.episode.id)).payload.cancellation.status,"queued");
  let calls=0;await disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async()=>{calls++;}});
  assert.equal(calls,1);assert.equal((await f.service.getEpisode("u",running.episode.id)).payload.cancellation.status,"completed");
});

test("disabled stop drains accepted cancellations beyond one hundred episodes",async()=>{
  const f=fixture(),row=await f.create();for(let i=0;i<105;i++)await f.documents.put("u","episode",`accepted-${String(i).padStart(3,"0")}`,{agendaId:row.id,status:"running",runId:`run-${i}`,sessionId:`session-${i}`},{expectedRevision:0,projectId:"p"});
  const current=await f.service.get("u",row.id),disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false}),stopped=new Set();
  await disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async target=>{stopped.add(target.runId);}});
  assert.equal(stopped.size,105);assert.equal((await f.service.get("u",row.id)).payload.stopSweep.cancellationPending,false);
});

test("disabled stop also stops an accepted verifier by its saved run and generation",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"verifier-before-disable"});
  const episode=await f.documents.get("u","episode",execution.episode.id),verificationId=`${episode.id}-v0`;
  await f.documents.put("u","episode",episode.id,{...episode.payload,status:"merged",verificationDispatches:[{verificationId,dispatchId:verificationId,runId:"accepted-verifier",sessionId:"verifier-session",runtimeGeneration:"old-generation",status:"running"}]},{expectedRevision:episode.revision,projectId:episode.projectId});
  const current=await f.service.get("u",row.id),disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false}),calls=[];
  await disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async target=>{calls.push(target);}});
  assert.equal(calls.length,1);assert.equal(calls[0].runId,"accepted-verifier");assert.equal(calls[0].runtimeGeneration,"old-generation");
  assert.equal((await f.service.getEpisode("u",episode.id)).payload.verificationDispatches[0].status,"canceled");
});

test("disabled cancellation remains replayable if retiring its durable queue job fails after the run stops",async()=>{
  const f=fixture(),row=await f.create(),execution=await f.service.runNow("u",row.id,{requestId:"queue-retirement"});
  await f.service.markEpisodeDispatched("u",execution.episode.id,{runId:"stopped-before-receipt",sessionId:"session"});f.queue[0].status="succeeded";
  const current=await f.service.get("u",row.id),disabled=new AutopilotService({documents:f.documents,jobs:f.jobs,enabled:false}),cancel=f.jobs.cancel;
  f.jobs.cancel=async()=>{throw Error("queue unavailable");};
  await assert.rejects(disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async()=>{}}),{code:"autopilot_cancellation_failed"});
  assert.equal((await f.service.getEpisode("u",execution.episode.id)).payload.cancellation.status,"queued");
  f.jobs.cancel=cancel;await disabled.stop("u",row.id,{expectedRevision:current.revision},{stopRun:async()=>{}});
  assert.equal((await f.service.getEpisode("u",execution.episode.id)).payload.cancellation.status,"completed");assert.ok(f.queue.filter(job=>job.payload.action==="cancel").every(job=>job.status==="canceled"));
});
