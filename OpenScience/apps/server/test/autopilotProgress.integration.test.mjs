import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { AutopilotWorker } from "../src/autopilotWorker.mjs";
import { EvimedCreditsService } from "../src/evimedCreditsService.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
async function fixture(t) {
  const isolated = await createGeoTestDatabase(databaseUrl, "autoprogress");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  t.after(async () => { await database.close(); await isolated.drop(); });
  const owner = `auto_${randomUUID()}`; const other = `auto_${randomUUID()}`;
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Progress owner','development'),($2,'Other','development')", [owner,other]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'owned','Owned',1048576),($2,'owned','Other',1048576)", [owner,other]);
  let now = new Date();
  const documents = new ProductDocuments(database); const jobs = new ProductJobs(database);
  const service = new AutopilotService({ documents,jobs,now:()=>now });
  let agenda = await service.create(owner,{projectId:"owned",title:"Progress",topics:["research"],taskTypes:["evidence-update"],dailyBudgetCny:20,weeklyBudgetCny:80,maxEpisodeCny:8,scheduleHour:1,timeZone:"UTC"});
  agenda = await service.start(owner,agenda.id,{expectedRevision:agenda.revision});
  return { database, documents, jobs, service, owner, other, agenda, today: now.toISOString().slice(0,10), refreshClock:()=>{now=new Date();} };
}

test("Postgres scheduling freezes only owned prior records and reuses the real idempotent job after agenda edits", options, async t => {
  const f = await fixture(t);
  const date = new Date(Date.now()-86_400_000).toISOString().slice(0,10);
  const payload = {agendaId:f.agenda.id,date,status:"merged",runId:"previous-run",sessionId:"previous-session",claims:[{id:"known",statement:"Already checked the endpoint",tier:"gated"}]};
  await f.documents.put(f.owner,"episode","prior",payload,{expectedRevision:0,projectId:"owned"});
  await f.documents.put(f.other,"episode","prior",{...payload,claims:[{id:"foreign",statement:"Other account detail",tier:"gated"}]},{expectedRevision:0,projectId:"owned"});
  await f.documents.put(f.owner,"episode","future",{...payload,date:"2099-01-01"},{expectedRevision:0,projectId:"owned"});
  f.refreshClock();
  const first = await f.service.schedule(f.owner,f.agenda.id,{date:f.today});
  assert.deepEqual(first.episode.payload.progress.episodes.map(item=>item.id),["prior"]);
  assert.doesNotMatch(first.episode.payload.prompt,/Other account detail/);
  const current = await f.service.get(f.owner,f.agenda.id);
  await f.documents.put(f.owner,"agenda",f.agenda.id,{...current.payload,topics:["changed"],followUps:[{note:"Later question",digestId:"later",claimId:"q",at:new Date().toISOString()}]},{expectedRevision:current.revision,projectId:"owned"});
  const replay = await f.service.schedule(f.owner,f.agenda.id,{date:f.today});
  assert.equal(replay.job.id,first.job.id);
  assert.equal(replay.job.payload.prompt,first.job.payload.prompt);
  assert.equal((await f.service.get(f.owner,f.agenda.id)).payload.followUps[0].consumedBy,undefined);
});

test("Postgres credit refusal leaves a bounded queued job and resource reason without a scientific outcome; pause prevents its retry", options, async t => {
  const f = await fixture(t); const scheduled = await f.service.schedule(f.owner,f.agenda.id,{date:f.today});
  let reservations = 0;
  const credits = { enabled:true,balanceFor:async()=>({balance:0}),estimate:async()=>({low:1,high:2}),counters:{refusedStarts:0} };
  const worker = new AutopilotWorker({jobs:f.jobs,service:f.service,dispatchEpisode:async input=>{
    await EvimedCreditsService.prototype.assertBalanceForStart.call(credits,f.owner,"clinical-evidence-synthesis");
    await input.assertDispatchAllowed(); reservations++; return {runId:"run",sessionId:"session"};
  }});
  await worker.tick();
  const queued = await f.jobs.get(f.owner,scheduled.job.id);
  assert.equal(queued.status,"queued"); assert.equal(queued.error.code,"credits_exhausted");
  assert.ok(Date.parse(queued.runAfter)>Date.now()); assert.equal(reservations,0);
  const episode = await f.service.getEpisode(f.owner,scheduled.episode.id);
  assert.equal(episode.payload.status,"queued"); assert.equal(episode.payload.resourceDeferrals.episode.status,"waiting");
  const current = await f.service.get(f.owner,f.agenda.id);
  assert.equal(current.payload.consecutiveFailures,0); assert.equal(current.payload.episodesWithoutGatedClaim,0); assert.deepEqual(current.payload.outcomes,[]);
  await f.documents.put(f.owner,"agenda",f.agenda.id,{...current.payload,enabled:false,status:"paused"},{expectedRevision:current.revision,projectId:"owned"});
  await f.database.query("UPDATE evimed_product.jobs SET run_after=clock_timestamp() WHERE id=$1",[scheduled.job.id]);
  await worker.tick();
  assert.equal(reservations,0); assert.equal((await f.jobs.get(f.owner,scheduled.job.id)).result.reason,"agenda_inactive");
  await worker.close();
});

test("the existing credit service admits unknown and disabled balances without inventing a positive balance", options, async t => {
  const f = await fixture(t); const {episode} = await f.service.schedule(f.owner,f.agenda.id,{date:f.today});
  for (const result of [
    await EvimedCreditsService.prototype.assertBalanceForStart.call({enabled:false},f.owner,"meta-analysis"),
    await EvimedCreditsService.prototype.assertBalanceForStart.call({enabled:true,balanceFor:async()=>({balance:null,status:"unavailable"})},f.owner,"meta-analysis"),
  ]) {
    const saved = await f.service.recordBalanceCheck(f.owner,episode.id,{...result,capabilityId:"meta-analysis",checkedAt:new Date().toISOString()});
    assert.equal(saved.allowed,true); assert.equal(saved.balance,null); assert.equal(saved.reason,result.reason);
  }
});
