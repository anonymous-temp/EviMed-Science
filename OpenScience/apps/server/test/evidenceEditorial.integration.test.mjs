import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { EvidenceEditorial } from "../src/evidenceEditorial.mjs";
import { FrontierEditor } from "../src/frontierEditor.mjs";
import {
  evidenceHash,
  evidenceContentHash,
} from "../src/evidenceCardContent.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { createEvidenceSourceReader } from "../src/evidenceSourceReader.mjs";
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
let isolated,
  db,
  service,
  zone,
  card,
  worker,
  document,
  authorCalls,
  reviewCalls;
const user = { id: "editorial-owner" };
const identity = { kind: "ai", name: "Test AI editor", model: "test-model" };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "editorial");
  db = new ControlPlaneDatabase({
    databaseUrl: isolated.url,
    databasePoolMax: 4,
    databaseConnectionTimeoutMs: 2000,
  });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Editorial Owner','development')",
    [user.id],
  );
  service = new EvidenceZoneService({ database: db });
  await service.ready();
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query(
    "TRUNCATE evimed_frontier.evidence_zones,evimed_frontier.items,evimed_frontier.sources CASCADE",
  );
  zone = (
    await service.save(user, { title: "Kidney trials", state: "published" })
  ).zone;
  document =
    "The randomized trial observed benefit. Population was restricted to adults.";
  authorCalls = 0;
  reviewCalls = 0;
  card = (
    await service.saveEditorial(
      user,
      {
        title: "Kidney trial",
        subtype: "academic",
        summary: "Observed benefit",
        body: "The source reports benefit in adults.",
        limitations: "Adult population only.",
        sources: [
          {
            title: "Primary trial",
            url: "https://example.org/trial",
            excerpt: document,
            documentText: document,
            sha256: evidenceHash(document),
            checkedAt: "2026-10-01T00:00:00Z",
            coverage: "abstract",
          },
        ],
        content: {
          question: "What did the trial find?",
          answer: "Benefit in adults.",
          population: "Adults",
        },
        state: "published",
        editorial: {
          author: identity,
          status: "review-pending",
          sourceCheckedAt: "2026-10-01T00:00:00Z",
          findings: [],
        },
      },
      zone.id,
      null,
      true,
    )
  ).evidence;
  const editor = {
    available: true,
    model: "test-model",
    evidenceTarget: async () => null,
    evidenceCard: async () => {
      authorCalls++;
      return {
        title: "Updated kidney trial",
        summary: "New source observations",
        body: "The source describes updated findings.",
        limitations: "Abstract only.",
        content: {
          question: "What did the trial find?",
          answer: "Updated source observations",
          population: "Adults",
        },
      };
    },
    evidenceReview: async () => {
      reviewCalls++;
      return {
        findings: [
          {
            kind: "coverage",
            text: "Only the abstract was assessed.",
            sourceIndex: 1,
          },
        ],
      };
    },
  };
  worker = new EvidenceEditorial({
    database: db,
    service,
    editor,
    readSource: async () => ({
      text: document,
      receipt: { sha256: evidenceHash(document) },
    }),
    budget: async () => ({ state: "ok" }),
  });
  await worker.automation(
    user,
    zone.id,
    {
      enabled: true,
      query: "kidney",
      sourceTypes: ["journal"],
      intervalHours: 24,
      maxCardsPerRun: 2,
      expectedRevision: zone.revision,
    },
    "PUT",
  );
});
const reviewCard = async () => {
  card = (
    await service.saveEditorial(
      user,
      {
        expectedRevision: card.revision,
        editorial: {
          ...card.editorial,
          status: "ai-reviewed",
          reviewer: { ...identity, name: "Independent AI" },
          contentHash: evidenceContentHash(card),
          findings: [],
          reviewedAt: "2026-10-01T01:00:00Z",
        },
      },
      zone.id,
      card.id,
    )
  ).evidence;
};

test("owner rewrite of unchanged sources reuses one job and independent review; empty refresh remains a cheap check",options,async()=>{
  await reviewCard();
  await worker.tick();
  const first=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
  const due=(await db.query("SELECT next_run_at FROM evimed_frontier.evidence_automation WHERE zone_id=$1",[zone.id])).rows[0].next_run_at;
  await db.query("INSERT INTO evimed_frontier.evidence_editorial_jobs(id,zone_id,identity_key,state,attempts) VALUES('other-failed',$1,'other-question','failed',3)",[zone.id]);
  await service.act(user,zone.id,"feedback",{expectedRevision:zone.revision,feedbackInfo:"Clarify the comparison and effect measure."});
  const write=worker.editor.evidenceCard;
  let input;
  worker.editor.evidenceCard=async value=>{input=value;return write(value);};
  await worker.automation(user,zone.id,{cardId:card.id,expectedRevision:card.revision},"POST");
  const requested=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1",[first.id])).rows[0];
  assert.equal(requested.payload.rewriteRevision,card.revision);
  assert.equal(requested.state,"pending");
  assert.equal((await db.query("SELECT next_run_at FROM evimed_frontier.evidence_automation WHERE zone_id=$1",[zone.id])).rows[0].next_run_at.getTime(),due.getTime());
  assert.deepEqual((await db.query("SELECT state,attempts FROM evimed_frontier.evidence_editorial_jobs WHERE id='other-failed'")).rows[0],{state:"failed",attempts:3});
  await worker.tick();
  const revised=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(input.rewriteRequested,true,"the owner request reaches the normal author operation as an explicit revision intent");
  assert.deepEqual([authorCalls,reviewCalls],[1,1]);
  assert.equal(revised.revision,card.revision+2);
  assert.equal(revised.editorial.sourceChangedAt,card.editorial.sourceChangedAt);
  assert.equal(revised.editorial.status,"ai-reviewed");
  assert.equal(revised.editorial.reviewRevision,revised.revision);
  assert.equal(revised.editorial.contentHash,evidenceContentHash(revised));
  assert.equal(revised.editorial.reviewOrigin,"model");
  assert.ok(input.readerQuestions.some(question=>question.origin==="zone-question"&&question.text.includes("effect measure")));
  const completed=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1",[first.id])).rows[0];
  assert.equal(completed.payload.rewriteRevision,undefined);
  assert.equal(completed.state,"completed");
  await db.query("DELETE FROM evimed_frontier.evidence_editorial_jobs WHERE id='other-failed'");
  await worker.automation(user,zone.id,{},"POST");
  await worker.tick();
  assert.deepEqual([authorCalls,reviewCalls],[1,1]);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.revision,revised.revision);
});

test("a failed same-source rewrite atomically retains the successful source check without changing scientific content",options,async()=>{
  await reviewCard();
  const originalHash=evidenceContentHash(card);
  const originalRevision=card.revision;
  await worker.automation(user,zone.id,{cardId:card.id,expectedRevision:card.revision},"POST");
  worker.editor.evidenceCard=async()=>{authorCalls++;return {title:"Invalid draft",content:{sections:[{title:null,text:"Invalid section"}]}};};
  await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  const job=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
  assert.equal(job.state,"pending");
  assert.equal(job.last_error,"evidence_invalid");
  assert.equal(job.attempts,1);
  assert.equal(authorCalls,1);
  assert.equal(reviewCalls,0);
  assert.equal(current.revision,originalRevision);
  assert.equal(evidenceContentHash(current),originalHash);
  assert.equal(current.editorial.contentHash,originalHash);
  assert.equal(current.editorial.reviewRevision,originalRevision);
  assert.equal(current.editorial.status,"ai-reviewed");
  assert.equal(current.sources[0].documentText,card.sources[0].documentText);
  assert.equal(current.sources[0].sha256,card.sources[0].sha256);
  assert.notEqual(current.sources[0].checkedAt,card.sources[0].checkedAt);
  const checked=current.editorial.sourceChecks[0];
  assert.equal(checked.status,"checked");
  assert.ok(Date.parse(current.sources[0].checkedAt)>=Date.parse(checked.attemptedAt));
  assert.ok(Date.parse(current.editorial.sourceCheckedAt)>=Date.parse(current.sources[0].checkedAt));
});

test("same-source rewrite review retry consumes the request without repeating authoring",options,async()=>{
  await reviewCard();
  const reviewed=worker.editor.evidenceReview;
  worker.editor.evidenceReview=async()=>{reviewCalls++;throw Object.assign(new Error("Temporary deadline"),{code:"frontier_model_timeout"});};
  await worker.automation(user,zone.id,{cardId:card.id,expectedRevision:card.revision},"POST");
  await worker.tick();
  const waiting=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
  assert.equal(waiting.payload.rewriteRevision,undefined);
  assert.equal(waiting.payload.managedRevision,card.revision+1);
  assert.deepEqual([authorCalls,reviewCalls],[1,1]);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.editorial.status,"review-pending");
  worker.providerPausedUntil=0;
  worker.editor.evidenceReview=reviewed;
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp() WHERE id=$1",[waiting.id]);
  await worker.tick();
  assert.deepEqual([authorCalls,reviewCalls],[1,2]);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.editorial.status,"ai-reviewed");
});

test("owner rewrite rejects foreign, stale, running and manually revised cards",options,async()=>{
  await reviewCard();
  const request={cardId:card.id,expectedRevision:card.revision};
  await assert.rejects(worker.automation({id:"other-account"},zone.id,request,"POST"),{code:"evidence_owner_required"});
  await assert.rejects(worker.automation(user,zone.id,{...request,expectedRevision:card.revision-1},"POST"),{code:"evidence_revision_conflict"});
  await assert.rejects(worker.automation(user,zone.id,{cardId:card.id},"POST"),{code:"evidence_invalid"});
  await worker.automation(user,zone.id,request,"POST");
  const claimed=await worker.claim();
  await assert.rejects(worker.automation(user,zone.id,request,"POST"),{code:"evidence_revision_conflict"});
  assert.equal((await db.query("SELECT lease_owner FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1",[claimed.id])).rows[0].lease_owner,worker.workerId);
  await worker.finish(claimed,"completed");
  const edited=(await service.save(user,{expectedRevision:card.revision,body:"An account changed the scientific answer."},zone.id,card.id)).evidence;
  await assert.rejects(worker.automation(user,zone.id,{cardId:card.id,expectedRevision:edited.revision},"POST"),{code:"evidence_revision_conflict"});
  assert.equal(authorCalls,0);
});

test("a manual edit after a rewrite request conflicts before authoring",options,async()=>{
  await reviewCard();
  await worker.automation(user,zone.id,{cardId:card.id,expectedRevision:card.revision},"POST");
  await service.save(user,{expectedRevision:card.revision,body:"Manual correction wins."},zone.id,card.id);
  await worker.tick();
  assert.equal(authorCalls,0);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.body,"Manual correction wins.");
  assert.equal((await worker.automation(user,zone.id)).jobs.conflict,1);
});

test("provider outages preserve editorial attempts and content; restart waits and a later review recovers",options,async()=>{
  const original=(await service.detail(user,zone.id,card.id)).evidence;
  const review=worker.editor.evidenceReview;
  const failures=[
    {code:"frontier_model_timeout"},
    {code:"model_gateway_upstream_error",upstreamStatus:429},
    {code:"model_gateway_upstream_error",upstreamStatus:503},
    {code:"frontier_model_failed",networkCode:"ECONNRESET"},
    {code:"model_gateway_payment_required",waitMinutes:30},
  ];
  for (const failure of failures) {
    await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE card_id=$1",[card.id]);
    worker.providerPausedUntil=0;
    worker.editor.evidenceReview=async()=>{reviewCalls++;throw Object.assign(new Error("Provider unavailable"),failure);};
    const started=Date.now();
    await worker.tick();
    const waiting=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
    assert.deepEqual([waiting.state,waiting.attempts,waiting.lease_owner,waiting.lease_until,waiting.last_error],["pending",0,null,null,failure.code]);
    assert.ok(new Date(waiting.available_at).getTime()>=started+(failure.waitMinutes??5)*60_000);
    assert.equal(evidenceContentHash((await service.detail(user,zone.id,card.id)).evidence),evidenceContentHash(original));
    const before=reviewCalls;
    worker.providerPausedUntil=0; // Simulate restart; the database owns the due time.
    await worker.tick();
    assert.equal(reviewCalls,before);
  }
  worker.editor.evidenceReview=review;
  worker.providerPausedUntil=0;
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE card_id=$1",[card.id]);
  await worker.tick();
  const completed=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
  assert.deepEqual([completed.state,completed.attempts,completed.last_error],["completed",1,null]);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.editorial.status,"ai-reviewed");
});

test("schema failures and explicit HTTP 400 still consume editorial attempts without replacing old content",options,async()=>{
  const original=(await service.detail(user,zone.id,card.id)).evidence;
  for (let attempt=1;attempt<=3;attempt++) {
    worker.editor.evidenceReview=async()=>({findings:[{kind:"source",text:null}]});
    await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE card_id=$1",[card.id]);
    await worker.tick();
    const failed=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
    assert.equal(failed.attempts,attempt);
    assert.equal(failed.last_error,"evidence_invalid");
    assert.equal(failed.state,attempt===3?"failed":"pending");
    assert.equal(evidenceContentHash((await service.detail(user,zone.id,card.id)).evidence),evidenceContentHash(original));
  }
  await worker.automation(user,zone.id,{},"POST");
  worker.editor.evidenceReview=async()=>{throw Object.assign(new Error("Bad request"),{code:"model_gateway_upstream_error",upstreamStatus:400});};
  await worker.tick();
  const badRequest=(await db.query("SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0];
  assert.equal(badRequest.attempts,1);
  assert.equal(badRequest.last_error,"model_gateway_upstream_error");
  assert.equal(worker.providerPausedUntil,0);
});

for (const scenario of [
  {
    name: "empty anticoagulation zone skips ectopic atrial tissue",
    title: "Right Atrial Ectopic Hepatic Tissue at the Caval Inflow",
    zoneTitle: "房颤抗凝",
    description: "原始抗凝研究的获益、出血与瓣膜病适用边界。",
    query: "atrial",
    empty: true,
    text: "This case describes ectopic hepatic tissue at the right atrial caval inflow.",
    decision: {
      skip: true,
      reason: "该病例描述右心房异位肝组织，无法回答房颤抗凝问题。",
    },
  },
  {
    name: "populated interpretation zone skips unrelated drug news",
    title:
      "Clinical evaluation of compound jinji granules in primary premature ejaculation: a randomized controlled trial",
    zoneTitle: "研究解读",
    description: "核对相对效应、绝对差异、复合终点与试验设计。",
    query: "randomized",
    empty: false,
    text: "The available excerpt lists the premature-ejaculation trial title without design or endpoint results.",
    decision: {
      skip: true,
      reason: "提供的短摘录没有足够设计或结局信息，不能支持研究解读问题。",
    },
  },
  {
    name: "empty anticoagulation zone accepts a supported new question",
    title:
      "Inequalities in oral anticoagulant treatment patterns associated with atrial fibrillation",
    zoneTitle: "房颤抗凝",
    description: "原始抗凝研究的获益、出血与瓣膜病适用边界。",
    query: "atrial",
    empty: true,
    text: "This atrial-fibrillation cohort examines inequalities in oral anticoagulant treatment patterns. It is observational, not a randomized treatment comparison.",
    decision: { cardId: null },
  },
])
  test(`discovery relevance: ${scenario.name}`, options, async () => {
    zone = (
      await service.save(
        user,
        {
          title: scenario.zoneTitle,
          description: scenario.description,
          background:
            "Retain source coverage and only answer questions supported by the supplied material.",
          expectedRevision: zone.revision,
        },
        zone.id,
      )
    ).zone;
    if (scenario.empty)
      await db.query("DELETE FROM evimed_frontier.evidence_cards WHERE id=$1", [
        card.id,
      ]);
    await worker.automation(
      user,
      zone.id,
      {
        enabled: true,
        query: scenario.query,
        sourceTypes: ["journal"],
        intervalHours: 24,
        maxCardsPerRun: 1,
        expectedRevision: zone.revision,
      },
      "PUT",
    );
    await insertSource(db, "discovery-journal");
    await insertItem(db, {
      sourceId: "discovery-journal",
      title: scenario.title,
    });
    let targetCalls = 0;
    const realEditor = new FrontierEditor(
      {
        deepseekProviderEnabled: true,
        deepseekApiKey: "test-only-key",
        frontierModel: "deepseek-flash",
      },
      {
        owner: { userId: user.id, projectId: "evimed-frontier" },
        callModel: async (_deps, call) => {
          targetCalls++;
          assert.equal(call.purpose, "frontier");
          assert.equal(call.body.max_tokens, 500);
          const input = JSON.parse(call.body.messages[1].content);
          assert.equal(input.description, scenario.description);
          assert.equal(input.source.text, scenario.text);
          assert.equal(input.cards.length, scenario.empty ? 0 : 1);
          assert.match(
            call.body.messages[0].content,
            /Make this decision even when cards is empty/,
          );
          return {
            choices: [
              { message: { content: JSON.stringify(scenario.decision) } },
            ],
          };
        },
      },
    );
    worker.editor.evidenceTarget = (input) => realEditor.evidenceTarget(input);
    worker.readSource = async () => ({
      text: scenario.text,
      coverage: "abstract",
    });
    await worker.tick();
    const jobs = (
      await db.query(
        "SELECT state,card_id,last_error,payload FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "completed");
    assert.equal(jobs[0].last_error, null);
    assert.equal(targetCalls, 1);
    const savedCards = (
      await db.query(
        "SELECT id,editorial FROM evimed_frontier.evidence_cards WHERE zone_id=$1",
        [zone.id],
      )
    ).rows;
    if (scenario.decision.skip) {
      assert.equal(authorCalls, 0);
      assert.equal(reviewCalls, 0);
      assert.equal(jobs[0].card_id, null);
      assert.equal(jobs[0].payload.skipReason, scenario.decision.reason);
      assert.equal(savedCards.length, scenario.empty ? 0 : 1);
      assert.equal(worker.counters.skipped, 1);
      const status = await worker.automation(user, zone.id);
      assert.equal(status.recent[0].skipReason, scenario.decision.reason);
    } else {
      assert.equal(authorCalls, 1);
      assert.equal(reviewCalls, 1);
      assert.equal(savedCards.length, 1);
      assert.equal(savedCards[0].editorial.status, "ai-reviewed");
      assert.equal(worker.counters.skipped, 0);
    }
  });

async function skippedDiscovery() {
  await db.query("DELETE FROM evimed_frontier.evidence_cards WHERE id=$1", [
    card.id,
  ]);
  await worker.automation(
    user,
    zone.id,
    {
      enabled: true,
      query: "kidney",
      sourceTypes: ["journal"],
      intervalHours: 24,
      maxCardsPerRun: 1,
      expectedRevision: zone.revision,
    },
    "PUT",
  );
  await insertSource(db, "retry-journal");
  await insertItem(db, {
    sourceId: "retry-journal",
    title: "Kidney trial methods and endpoint interpretation",
  });
  document = "Only the title is available.";
  const operation = {
    calls: 0,
    decision: { skip: true, reason: "尚无足够正文回答结局解读问题。" },
  };
  const actualEditor = new FrontierEditor(
    {
      deepseekProviderEnabled: true,
      deepseekApiKey: "test-only-key",
      frontierModel: "deepseek-flash",
    },
    {
      owner: { userId: user.id, projectId: "evimed-frontier" },
      callModel: async () => {
        operation.calls++;
        return {
          choices: [
            { message: { content: JSON.stringify(operation.decision) } },
          ],
        };
      },
    },
  );
  worker.editor.evidenceTarget = (input) => actualEditor.evidenceTarget(input);
  await worker.tick();
  const job = (
    await db.query(
      "SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
      [zone.id],
    )
  ).rows[0];
  assert.equal(job.state, "completed");
  assert.equal(job.card_id, null);
  assert.equal(operation.calls, 1);
  return { operation, job };
}

test(
  "explicit refresh retries a skipped identity with enriched source and leaves successful jobs alone",
  options,
  async () => {
    const { operation, job } = await skippedDiscovery();
    const kept = (
      await service.saveEditorial(
        user,
        {
          title: "Existing successful question",
          subtype: "academic",
          summary: card.summary,
          body: card.body,
          limitations: card.limitations,
          sources: card.sources,
          state: "published",
          editorial: {
            author: identity,
            status: "review-pending",
            findings: [],
          },
        },
        zone.id,
        null,
        true,
      )
    ).evidence;
    await db.query(
      `INSERT INTO evimed_frontier.evidence_editorial_jobs(id,zone_id,identity_key,card_id,state,attempts,payload)
    VALUES('successful',$1,'successful',$2,'completed',2,'{}'),('another-skip',$1,'another-skip',NULL,'completed',0,'{"decision":"skip","skipReason":"Earlier unavailable source"}')`,
      [zone.id, kept.id],
    );
    await worker.automation(user, zone.id, {}, "POST");
    const refreshed = (
      await db.query(
        "SELECT id,state,attempts FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows;
    assert.equal(
      refreshed.filter((row) => row.state === "pending").length,
      1,
      "explicit skip retries are capped by maxCardsPerRun",
    );
    assert.equal(refreshed.find((row) => row.id === job.id).state, "pending");
    assert.equal(
      refreshed.find((row) => row.id === "successful").state,
      "completed",
    );
    assert.equal(refreshed.find((row) => row.id === "successful").attempts, 2);
    document =
      "The full abstract now identifies the kidney trial population, outcome definition and follow-up, supporting an endpoint interpretation question.";
    operation.decision = { cardId: null };
    await worker.tick();
    const completed = (
      await db.query(
        "SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(completed.id, job.id);
    assert.equal(completed.identity_key, job.identity_key);
    assert.equal(completed.state, "completed");
    assert.ok(completed.card_id);
    assert.equal(completed.payload.skipReason, undefined);
    assert.equal(completed.payload.decision, undefined);
    assert.equal(operation.calls, 2);
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 1);
    assert.equal(
      (await service.detail(user, zone.id, completed.card_id)).evidence
        .editorial.status,
      "ai-reviewed",
    );
  },
);

test(
  "automatic skipped-source retries observe a seven-day cooldown and remain capped",
  options,
  async () => {
    const { operation, job } = await skippedDiscovery();
    const days =
      (new Date(job.available_at).getTime() -
        new Date(job.updated_at).getTime()) /
      86400000;
    assert.ok(days > 6.99 && days < 7.01);
    for (let index = 0; index < 2; index++) {
      await db.query(
        "UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1",
        [zone.id],
      );
      await worker.tick();
    }
    assert.equal(
      operation.calls,
      1,
      "daily scheduling cannot repeatedly spend on an unchanged skipped source",
    );
    await db.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [job.id],
    );
    await db.query(
      "UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1",
      [zone.id],
    );
    await worker.tick();
    const retried = (
      await db.query(
        "SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(retried.state, "completed");
    assert.equal(retried.id, job.id);
    assert.equal(operation.calls, 2);
    assert.equal(authorCalls, 0);
    assert.equal(reviewCalls, 0);
    assert.ok(
      new Date(retried.available_at).getTime() > Date.now() + 6.9 * 86400000,
    );
    await worker.tick();
    assert.equal(operation.calls, 2);
  },
);

test(
  "public owners cannot forge AI review receipts or retained source metadata",
  options,
  async () => {
    await assert.rejects(
      service.save(
        user,
        {
          expectedRevision: card.revision,
          editorial: {
            ...card.editorial,
            status: "ai-reviewed",
            reviewer: identity,
            contentHash: evidenceContentHash(card),
          },
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    await assert.rejects(
      service.save(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: "Forged",
              url: "https://example.org",
              excerpt: "x",
              sha256: evidenceHash("x"),
              coverage: "full-text",
              documentText: "x",
            },
          ],
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    await assert.rejects(
      service.save(
        user,
        { expectedRevision: card.revision, sources: [null] },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    assert.equal(card.editorial.reviewOperationId, undefined);
  },
);
test(
  "independent AI receipt binds final content and manual edits preserve unchanged retained sources",
  options,
  async () => {
    await reviewCard();
    assert.equal(card.editorial.reviewRevision, card.revision);
    assert.ok(card.editorial.reviewOperationId);
    assert.equal(card.editorial.reviewOrigin, "import");
    await assert.rejects(
      service.saveEditorial(
        user,
        {
          expectedRevision: card.revision,
          editorial: { ...card.editorial, contentHash: evidenceHash("wrong") },
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    const sources = card.sources.map(({ title, url, excerpt }) => ({
      title,
      url,
      excerpt,
    }));
    const edited = (
      await service.save(
        user,
        {
          expectedRevision: card.revision,
          title: "Manual correction",
          sources,
        },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(edited.sources[0].coverage, "abstract");
    assert.equal(edited.sources[0].sha256, evidenceHash(document));
    assert.equal(edited.editorial.status, "review-pending");
    assert.equal(edited.editorial.reviewer, null);
    const row = (
      await db.query(
        "SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1",
        [card.id],
      )
    ).rows[0];
    assert.equal(row.sources[0].documentText, document);
    assert.equal(edited.sources[0].documentText, undefined);
    assert.equal(edited.revisions.length, 3);
  },
);
test(
  "source hash checks retained text and changed manual sources lose old coverage receipt",
  options,
  async () => {
    await assert.rejects(
      service.saveEditorial(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: "Source",
              url: "https://example.org",
              excerpt: "x",
              documentText: "actual",
              sha256: evidenceHash("different"),
            },
          ],
        },
        zone.id,
        card.id,
      ),
      { code: "evidence_invalid" },
    );
    const edited = (
      await service.save(
        user,
        {
          expectedRevision: card.revision,
          sources: [
            {
              title: card.sources[0].title,
              url: card.sources[0].url,
              excerpt: "Changed excerpt",
            },
          ],
        },
        zone.id,
        card.id,
      )
    ).evidence;
    assert.equal(edited.sources[0].coverage, "excerpt");
    assert.equal(edited.sources[0].sha256, evidenceHash("Changed excerpt"));
  },
);
test(
  "unchanged sources are checked without authoring or review calls",
  options,
  async () => {
    await reviewCard();
    await worker.tick();
    assert.equal(authorCalls, 0);
    assert.equal(reviewCalls, 0);
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.revision, card.revision);
    assert.equal(worker.counters.unchanged, 1);
    assert.equal((await worker.automation(user, zone.id)).jobs.completed, 1);
  },
);
test(
  "changed source updates the same card and records independent review and revision history",
  options,
  async () => {
    await reviewCard();
    await service.act(user, zone.id, "feedback", {
      expectedRevision: zone.revision,
      feedbackInfo: "Please clarify kidney population coverage.",
    });
    await service.act(
      user,
      zone.id,
      "comments",
      { text: "What about older adults?" },
      card.id,
    );
    let writerContext;
    const write = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      writerContext = input;
      return write(input);
    };
    document += " Newly reported outcome.";
    await worker.tick();
    assert.ok(
      writerContext.readerQuestions.some(
        (question) => question.origin === "zone-question",
      ),
    );
    assert.ok(
      writerContext.readerQuestions.some(
        (question) => question.origin === "card-comment",
      ),
    );
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 1);
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.id, card.id);
    assert.equal(current.editorial.status, "ai-reviewed");
    assert.equal(current.editorial.reviewRevision, current.revision);
    assert.equal(current.editorial.reviewOrigin, "model");
    assert.equal(current.editorial.findings[0].kind, "coverage");
    assert.equal(current.revisions.length, 4);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM evimed_frontier.evidence_cards",
          )
        ).rows[0].n,
      ),
      1,
    );
  },
);
test(
  "review outage preserves produced card and retry reviews without reauthoring unchanged sources",
  options,
  async () => {
    await reviewCard();
    document += " Changed outcome.";
    worker.editor.evidenceReview = async () => {
      reviewCalls++;
      throw Object.assign(new Error("offline"), {
        code: "evidence_review_offline",
      });
    };
    await worker.tick();
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 1);
    let current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.editorial.status, "review-pending");
    assert.equal(current.state, "published");
    await db.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()",
    );
    worker.editor.evidenceReview = async () => {
      reviewCalls++;
      return { findings: [] };
    };
    await worker.tick();
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 2);
    current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.editorial.status, "ai-reviewed");
  },
);
test(
  "manual edit stops automatic overwrites and leased internal writes require current ownership",
  options,
  async () => {
    await reviewCard();
    await worker.tick();
    card = (await service.detail(user, zone.id, card.id)).evidence;
    await service.save(
      user,
      { expectedRevision: card.revision, body: "Researcher correction" },
      zone.id,
      card.id,
    );
    await worker.automation(user, zone.id, {}, "POST");
    await worker.tick();
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.conflict, 1);
    assert.equal(authorCalls, 0);
    await assert.rejects(
      service.saveEditorial(
        user,
        { expectedRevision: card.revision, title: "Stale lease writer" },
        zone.id,
        card.id,
        false,
        "model",
        { jobId: status.recent[0].id, workerId: "not-the-owner" },
      ),
      { code: "evidence_lease_lost" },
    );
  },
);

test(
  "discovery is not starved by a full existing-card batch and new sources update the same clinical question",
  options,
  async () => {
    await reviewCard();
    for (let index = 0; index < 3; index++)
      await service.saveEditorial(
        user,
        {
          title: `Existing card ${index}`,
          subtype: "academic",
          summary: "Existing",
          body: "Existing source-based card",
          limitations: "Abstract only",
          state: "published",
          sources: [
            {
              title: "Existing",
              url: `https://example.org/old-${index}`,
              excerpt: document,
              documentText: document,
              coverage: "abstract",
            },
          ],
          editorial: {
            author: identity,
            status: "review-pending",
            findings: [],
          },
        },
        zone.id,
        null,
        true,
      );
    await insertSource(db, "trial-journal");
    await insertItem(db, {
      sourceId: "trial-journal",
      title: "A new kidney trial",
    });
    let mappedInput;
    const write = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      if (input.previous?.title === card.title) mappedInput = input;
      return write(input);
    };
    let targetCalls = 0;
    worker.editor.evidenceTarget = async (input) => {
      targetCalls++;
      assert.ok(input.cards.some((c) => c.id === card.id));
      return card.id;
    };
    await worker.tick();
    await worker.tick();
    const jobs = (
      await db.query(
        "SELECT source_item_id,card_id FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows;
    const candidate = jobs.find((j) => j.source_item_id);
    assert.ok(
      candidate,
      "New primary source must be queued even when existing cards exceed the batch size",
    );
    assert.equal(candidate.card_id, card.id);
    assert.ok(
      (
        await db.query(
          "SELECT state FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
          [zone.id],
        )
      ).rows.every((job) => job.state === "completed"),
      "An automatic revision must advance sibling pending jobs rather than masquerading as a researcher edit",
    );
    assert.equal(targetCalls, 1);
    assert.equal(mappedInput.sources[0].url, card.sources[0].url);
    assert.equal(mappedInput.sources[0].sourceIndex, 1);
    assert.equal(mappedInput.sources.length, 2);
    assert.equal(mappedInput.previous.sources[0].sourceIndex, 1);
    assert.equal(mappedInput.previous.sources[0].url, card.sources[0].url);
    const updated = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(updated.sources[0].url, card.sources[0].url);
    assert.notEqual(updated.sources[1].url, card.sources[0].url);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM evimed_frontier.evidence_cards",
          )
        ).rows[0].n,
      ),
      4,
    );
  },
);
test(
  "budget exhaustion permits free source checks and leaves changed content waiting without author calls",
  options,
  async () => {
    await reviewCard();
    worker.budget = async () => ({ state: "exhausted" });
    await worker.tick();
    assert.equal(worker.counters.unchanged, 1);
    assert.equal(authorCalls, 0);
    document += " Source changed.";
    await worker.automation(user, zone.id, {}, "POST");
    await worker.tick();
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.ok(current.editorial.sourceChangedAt);
    assert.equal(current.revision, card.revision);
    assert.equal(current.editorial.status, "review-pending");
    assert.equal(current.editorial.reviewer, null);
    assert.equal(authorCalls, 0);
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.pending, 1);
    assert.equal(status.recent[0].attempts, 0);
    assert.equal(status.recent[0].lastError, "evidence_budget_wait");
  },
);

test(
  "an expired worker cannot overwrite the new lease owner's durable status",
  options,
  async () => {
    await reviewCard();
    await worker.schedule();
    const first = await worker.claim();
    await db.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    const replacement = new EvidenceEditorial({
      database: db,
      service,
      editor: worker.editor,
      readSource: worker.readSource,
      workerId: "replacement-worker",
    });
    const second = await replacement.claim();
    assert.equal(second.id, first.id);
    await replacement.finish(second, "completed");
    await worker.finish(first, "failed", "evidence_stale_worker");
    const status = await worker.automation(user, zone.id);
    assert.equal(status.automation.lastError, null);
    assert.equal(status.recent[0].state, "completed");
    assert.equal(status.recent[0].lastError, null);
  },
);
test(
  "a manual revision racing an unchanged source check is a conflict, not a successful update",
  options,
  async () => {
    await reviewCard();
    let changed = false;
    worker.readSource = async () => {
      if (!changed) {
        changed = true;
        await service.save(
          user,
          {
            expectedRevision: card.revision,
            title: "Concurrent researcher edit",
          },
          zone.id,
          card.id,
        );
      }
      return { text: document, receipt: { sha256: evidenceHash(document) } };
    };
    await worker.tick();
    const status = await worker.automation(user, zone.id);
    assert.equal(status.jobs.conflict, 1);
    assert.equal(worker.counters.unchanged, 0);
    assert.equal(authorCalls, 0);
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.title,
      "Concurrent researcher edit",
    );
  },
);

test(
  "withdrawal after first scheduling cannot be undone by a changed-source editorial task",
  options,
  async () => {
    await reviewCard();
    await worker.schedule();
    const scheduled = (
      await db.query(
        "SELECT payload FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1",
        [zone.id],
      )
    ).rows[0];
    assert.equal(scheduled.payload.managedRevision, card.revision);
    await service.save(
      user,
      { expectedRevision: card.revision, state: "draft" },
      zone.id,
      card.id,
    );
    document += " Changed source after scheduling.";
    await worker.tick();
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.state,
      "draft",
    );
    assert.equal(authorCalls, 0);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);
test(
  "a zone withdrawn during authoring is rejected inside the save transaction",
  options,
  async () => {
    await reviewCard();
    document += " Changed source.";
    const originalWrite = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      const output = await originalWrite(input);
      await service.save(
        user,
        { expectedRevision: zone.revision, state: "draft" },
        zone.id,
      );
      return output;
    };
    await worker.tick();
    assert.equal((await service.detail(user, zone.id)).zone.state, "draft");
    assert.equal(
      (await service.detail(user, zone.id, card.id)).evidence.title,
      card.title,
    );
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);
test(
  "a card withdrawn during authoring is rejected by the saved revision and publication guard",
  options,
  async () => {
    await reviewCard();
    document += " Changed source.";
    const originalWrite = worker.editor.evidenceCard;
    worker.editor.evidenceCard = async (input) => {
      const output = await originalWrite(input);
      await service.save(
        user,
        { expectedRevision: card.revision, state: "draft" },
        zone.id,
        card.id,
      );
      return output;
    };
    await worker.tick();
    const current = (await service.detail(user, zone.id, card.id)).evidence;
    assert.equal(current.state, "draft");
    assert.equal(current.title, card.title);
    assert.equal(authorCalls, 1);
    assert.equal(reviewCalls, 0);
    assert.equal((await worker.automation(user, zone.id)).jobs.conflict, 1);
  },
);

const addSupportingSource = async (count=1) => {
  const original = (await db.query('SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0].sources;
  card=(await service.saveEditorial(user,{expectedRevision:card.revision,sources:[...original,...Array.from({length:count},(_,i)=>({...original[0],title:`Supporting source ${i+1}`,url:`https://example.org/support-${i+1}`}))],editorial:{...card.editorial,status:'review-pending'}},zone.id,card.id)).evidence;
  await reviewCard();
};
const unreadable = () => Object.assign(new Error('Publisher refuses this source.'),{code:'web_read_unreadable'});

test('partial source checks preserve retained material and review without extra model calls, then recover on the next interval',options,async()=>{
  await addSupportingSource();
  const previousDate=card.editorial.sourceCheckedAt;
  worker.readSource=async url=>{if(url.includes('support')) throw unreadable();return{text:document};};
  await worker.tick();
  let current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  assert.equal(current.revision,card.revision);assert.equal(current.editorial.status,'ai-reviewed');
  assert.equal(current.editorial.sourceCheckedAt,previousDate);
  assert.deepEqual(current.editorial.sourceChecks.map(s=>s.status),['checked','retained']);
  assert.equal(current.sources[1].checkedAt,'2026-10-01T00:00:00Z');
  assert.equal(current.sources[1].sha256,evidenceHash(document));
  let status=await worker.automation(user,zone.id);
  assert.equal(status.jobs.completed,1);assert.equal(status.recent[0].sourceCheckStatus,'partial');
  const next=(await db.query('SELECT next_run_at FROM evimed_frontier.evidence_automation WHERE zone_id=$1',[zone.id])).rows[0].next_run_at;
  assert.ok(new Date(next).getTime()>Date.now()+23*3600000);
  worker.readSource=async()=>({text:document});
  await db.query("UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1",[zone.id]);
  await worker.tick();
  current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.ok(current.editorial.sourceChecks.every(s=>s.status==='checked'&&!s.code));
  assert.notEqual(current.editorial.sourceCheckedAt,previousDate);
  status=await worker.automation(user,zone.id);assert.equal(status.recent[0].sourceCheckStatus,'complete');
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('all unavailable preserved sources complete honestly without advancing any check or spending on models',options,async()=>{
  await addSupportingSource();worker.readSource=async()=>{throw unreadable();};
  await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.editorial.sourceCheckedAt,card.editorial.sourceCheckedAt);
  assert.ok(current.sources.every(s=>s.checkedAt==='2026-10-01T00:00:00Z'));
  assert.ok(current.editorial.sourceChecks.every(s=>s.status==='retained'));
  assert.equal((await worker.automation(user,zone.id)).recent[0].sourceCheckStatus,'partial');
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('changed readable source can update with an unavailable preserved source and sends independent check metadata to both model operations',options,async()=>{
  await addSupportingSource();const previousDate=card.editorial.sourceCheckedAt;
  document+=' New findings in the primary trial.';
  worker.readSource=async url=>{if(url.includes('support'))throw unreadable();return{text:document};};
  const write=worker.editor.evidenceCard,review=worker.editor.evidenceReview;
  const assertChecks=input=>{assert.equal(input.sourceChecks[1].status,'retained');assert.equal(input.sources[1].text.includes('New findings'),false);};
  worker.editor.evidenceCard=async input=>{assertChecks(input);const pending=(await db.query('SELECT editorial FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0].editorial;assert.equal(pending.status,'review-pending');assert.equal(pending.reviewer,null);assert.equal(pending.sourceChecks[1].status,'retained');assert.equal(pending.sourceCheckedAt,previousDate);return write(input);};
  worker.editor.evidenceReview=async input=>{assertChecks(input);return review(input);};
  await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(authorCalls,1);assert.equal(reviewCalls,1);
  assert.equal(current.editorial.sourceCheckedAt,previousDate);
  assert.equal(current.editorial.sourceChecks[1].status,'retained');
  assert.equal(current.editorial.reviewRevision,current.revision);
  assert.equal(current.editorial.contentHash,evidenceContentHash(current));
  assert.equal(current.editorial.reviewOrigin,'model');
  assert.equal((await worker.automation(user,zone.id)).recent[0].sourceCheckStatus,'partial');
});

for(const scenario of ['no retained text','invalid retained hash','programming error'])test(`unavailable source cannot silently fall back with ${scenario}`,options,async()=>{
  await reviewCard();
  if(scenario==='no retained text') await db.query("UPDATE evimed_frontier.evidence_cards SET sources=jsonb_set(sources,'{0}',(sources->0)-'documentText') WHERE id=$1",[card.id]);
  if(scenario==='invalid retained hash') await db.query(`UPDATE evimed_frontier.evidence_cards SET sources=jsonb_set(sources,'{0,${scenario==='no retained text'?'documentText':'sha256'}}','"invalid"'::jsonb) WHERE id=$1`,[card.id]);
  worker.readSource=async()=>{throw scenario==='programming error'?new TypeError('Reader implementation defect'):unreadable();};
  await worker.tick();
  assert.equal((await worker.automation(user,zone.id)).jobs.pending,1);
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.deepEqual(current.editorial.sourceChecks,[]);
});

test('new discovery without retained source text still fails instead of creating an unsupported card',options,async()=>{
  await insertSource(db,'unreadable-new-source');
  await insertItem(db,{publicId:'unreadablenewitem',identityKey:'unreadable-new-item',sourceId:'unreadable-new-source',title:'Kidney randomized trial',canonicalUrl:'https://example.org/new-trial',state:'published'});
  worker.readSource=async()=>{throw unreadable();};
  await worker.tick();
  assert.equal((await worker.automation(user,zone.id)).jobs.pending,2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM evimed_frontier.evidence_cards WHERE zone_id=$1',[zone.id])).rows[0].count,1);
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

for(const race of ['manual edit','lost lease'])test(`retained-source fallback cannot overwrite ${race}`,options,async()=>{
  await reviewCard();let raced=false;
  worker.readSource=async()=>{
    if(!raced){raced=true;
      if(race==='manual edit')await service.save(user,{expectedRevision:card.revision,title:'Researcher correction'},zone.id,card.id);
      else await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET lease_owner='other-worker' WHERE card_id=$1 AND state='running'",[card.id]);
    }throw unreadable();
  };
  await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.deepEqual(current.editorial.sourceChecks,[]);assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  if(race==='manual edit')assert.equal((await worker.automation(user,zone.id)).jobs.conflict,1);
  else assert.equal((await db.query("SELECT lease_owner FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1",[card.id])).rows[0].lease_owner,'other-worker');
});

test('eight-source read cap never advances the date of all sources',options,async()=>{
  await addSupportingSource(8);await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.editorial.sourceCheckedAt,card.editorial.sourceCheckedAt);
  assert.equal(current.editorial.sourceChecks[8].code,'evidence_source_check_deferred');
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('public sourceChecks forgery is rejected and a manual source edit clears old indexed checks',options,async()=>{
  await reviewCard();worker.readSource=async()=>{throw unreadable();};await worker.tick();
  await assert.rejects(()=>service.save(user,{expectedRevision:card.revision,editorial:{...card.editorial,sourceChecks:[{sourceIndex:1,status:'checked',attemptedAt:new Date().toISOString()}]}},zone.id,card.id),{status:400});
  const edited=(await service.save(user,{expectedRevision:card.revision,sources:[{title:'New primary',url:'https://example.org/new',excerpt:'New excerpt'}]},zone.id,card.id)).evidence;
  assert.deepEqual(edited.editorial.sourceChecks,[]);assert.equal(edited.editorial.status,'review-pending');assert.equal(edited.editorial.sourceCheckedAt,null);
});

test('maintenance rotates past partial and terminal failed cards while discovery remains available',options,async()=>{
  await reviewCard();
  const original=(await db.query('SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0];
  const second=(await service.saveEditorial(user,{title:'Second kidney question',subtype:original.subtype,summary:original.summary,body:original.body,limitations:original.limitations,sources:original.sources,content:original.content,editorial:{...original.editorial,status:'review-pending'},state:'published'},zone.id,null,true)).evidence;
  await worker.automation(user,zone.id,{enabled:true,query:'kidney',sourceTypes:['journal'],intervalHours:24,maxCardsPerRun:1,expectedRevision:zone.revision},'PUT');
  worker.readSource=async()=>{throw unreadable();};
  // Both cards have legitimate retained material; only the reviewed card can finish without AI.
  await service.saveEditorial(user,{expectedRevision:second.revision,editorial:{...second.editorial,status:'ai-reviewed',reviewer:identity,contentHash:evidenceContentHash(second),findings:[]}},zone.id,second.id);
  await worker.tick();
  const first=(await db.query('SELECT card_id FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1',[zone.id])).rows[0].card_id;
  await insertSource(db,'rotation-discovery');await insertItem(db,{sourceId:'rotation-discovery',title:'Kidney randomized discovery trial'});
  await db.query('UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1',[zone.id]);
  await worker.tick();
  const jobs=(await db.query('SELECT card_id,state FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 ORDER BY updated_at',[zone.id])).rows;
  assert.equal(jobs.length,2);assert.notEqual(jobs[1].card_id,first);assert.ok(jobs.every(j=>j.state==='completed'));
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET state='failed' WHERE card_id=$1",[first]);
  await db.query('UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1',[zone.id]);
  await worker.schedule();
  assert.equal((await db.query('SELECT state FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=$1',[first])).rows[0].state,'failed');
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

// Synthetic API metadata exercises the real reader and native refresh path.
const coreReader = (record) => createEvidenceSourceReader({
  userAgent: 'EviMedTest',
  readWeb: async () => { throw new Error('Expected primary scholarly API'); },
  transport: async ({url}) => ({status:200,headers:{},body:Buffer.from(url.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /\n' : JSON.stringify({resultList:{result:[{id:'12345',source:'MED',title:'Synthetic trial fixture',abstractText:document,...record()}]}}))}),
});
const preparePubmedCard = async () => {
  const retained=(await db.query('SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0].sources;
  card=(await service.saveEditorial(user,{expectedRevision:card.revision,sources:retained.map(source=>({...source,url:'https://pubmed.ncbi.nlm.nih.gov/12345/'})),editorial:{...card.editorial,status:'review-pending'}},zone.id,card.id)).evidence;
  await reviewCard();
};
const refreshAgain = async () => {
  await db.query('UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1',[zone.id]);
  await worker.tick();
  return (await service.detail(user,zone.id,card.id)).evidence;
};
test('same abstract N to Y invalidates the receipt and exposes the retraction; unknown retains it and explicit N clears it before new review',options,async()=>{
  await preparePubmedCard();
  let metadata={isRetracted:'N'};
  worker.readSource=coreReader(()=>metadata);
  await worker.tick();
  const previous=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(previous.editorial.status,'ai-reviewed');
  metadata={isRetracted:'Y',commentCorrectionList:{commentCorrection:[{type:'Retraction in',reference:'Synthetic journal notice',source:'MED',id:'54321'}]}};
  let current=await refreshAgain();
  assert.equal(current.sources[0].sha256,previous.sources[0].sha256);
  assert.notEqual(current.editorial.contentHash,previous.editorial.contentHash);
  assert.notEqual(current.editorial.sourceFingerprint,previous.editorial.sourceFingerprint);
  assert.equal(current.sources[0].publicationStatus.kind,'retracted');
  assert.ok(current.sources[0].publicationStatus.notices.some(notice=>notice.includes('Synthetic journal notice')));
  assert.equal(current.sources[0].documentText,undefined,'Public details must not expose retained full text');
  assert.equal(current.editorial.status,'review-pending');
  assert.equal(current.editorial.reviewer,null);
  assert.equal(current.editorial.reviewRevision,null);
  assert.equal(current.body,previous.body);
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  assert.ok(current.editorial.findings.some(finding=>finding.kind==='publication-status'));
  const flaggedDate=current.sources[0].checkedAt, flaggedRevision=current.revision;
  metadata={};current=await refreshAgain();
  assert.equal(current.sources[0].publicationStatus.kind,'retracted');
  assert.equal(current.sources[0].checkedAt,flaggedDate);
  assert.equal(current.revision,flaggedRevision);
  assert.equal(current.editorial.sourceChecks[0].status,'retained');
  assert.equal(current.editorial.sourceChecks[0].code,'evidence_publication_status_unavailable');
  metadata={isRetracted:'N'};current=await refreshAgain();
  assert.equal(current.sources[0].publicationStatus,undefined);
  assert.equal(current.editorial.status,'ai-reviewed');
  assert.equal(current.editorial.reviewRevision,current.revision);
  assert.equal(authorCalls,1);assert.equal(reviewCalls,1);
  assert.equal(current.editorial.findings.some(finding=>finding.kind==='publication-status'),false);
});
test('explicit erratum with unchanged abstract requires review while ordinary comments do not',options,async()=>{
  await preparePubmedCard();
  let type='Comment in';
  worker.readSource=coreReader(()=>({isRetracted:'N',commentCorrectionList:{commentCorrection:[{type,reference:'Synthetic relation fixture',source:'MED',id:'54321'}]}}));
  await worker.tick();
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.editorial.status,'ai-reviewed');
  type='Erratum in';const current=await refreshAgain();
  assert.equal(current.sources[0].publicationStatus.kind,'corrected');
  assert.equal(current.editorial.status,'review-pending');assert.equal(current.editorial.reviewer,null);
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});
test('truncated refresh retains complete source hash and old dates rather than re-signing it as full text',options,async()=>{
  const retained=(await db.query('SELECT sources FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id])).rows[0].sources;
  card=(await service.saveEditorial(user,{expectedRevision:card.revision,sources:retained.map(source=>({...source,coverage:'full-text'})),editorial:{...card.editorial,status:'review-pending'}},zone.id,card.id)).evidence;
  await reviewCard();
  const original=card.sources[0],previousDate=card.editorial.sourceCheckedAt;
  worker.readSource=createEvidenceSourceReader({userAgent:'EviMedTest',transport:async()=>{throw new Error('No scholarly API');},readWeb:async()=>({text:'Truncated changed source',coverage:'full-text',receipt:{sha256:evidenceHash('Truncated changed source'),truncated:true}})});
  await worker.tick();const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.sources[0].sha256,original.sha256);
  assert.equal(current.sources[0].checkedAt,original.checkedAt);
  assert.equal(current.sources[0].coverage,'full-text');
  assert.equal(current.editorial.sourceCheckedAt,previousDate);
  assert.equal(current.editorial.sourceChecks[0].status,'retained');
  assert.equal(current.editorial.sourceChecks[0].code,'evidence_source_truncated');
  assert.equal(current.editorial.status,'ai-reviewed');assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('publication notice survives a removed abstract and cannot acquire a forged current AI receipt',options,async()=>{
  await preparePubmedCard();
  worker.readSource=coreReader(()=>({isRetracted:'Y',abstractText:undefined}));
  await worker.tick();
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.sources[0].publicationStatus.kind,'retracted');
  assert.equal(current.sources[0].sha256,card.sources[0].sha256);
  assert.equal(current.sources[0].checkedAt,card.sources[0].checkedAt);
  assert.equal(current.editorial.sourceChecks[0].status,'retained');
  assert.equal(current.editorial.sourceCheckedAt,card.editorial.sourceCheckedAt);
  assert.equal(current.editorial.status,'review-pending');
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  await assert.rejects(()=>service.saveEditorial(user,{expectedRevision:current.revision,editorial:{...current.editorial,status:'ai-reviewed',reviewer:identity,contentHash:current.editorial.contentHash}},zone.id,card.id),{status:400});
});
test('new discoveries with publisher retraction status complete as skipped without authoring or review',options,async()=>{
  await db.query('DELETE FROM evimed_frontier.evidence_cards WHERE id=$1',[card.id]);
  await insertSource(db,'synthetic-source');
  const item=await insertItem(db,{sourceId:'synthetic-source',title:'Kidney synthetic fixture',state:'published'});
  await db.query("UPDATE evimed_frontier.items SET canonical_url='https://pubmed.ncbi.nlm.nih.gov/12345/' WHERE id=$1",[item.id]);
  worker.readSource=coreReader(()=>({isRetracted:'Y'}));
  await worker.tick();
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM evimed_frontier.evidence_cards')).rows[0].n,0);
  const jobs=(await db.query('SELECT state,payload FROM evimed_frontier.evidence_editorial_jobs')).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].state,'completed');assert.equal(jobs[0].payload.decision,'skip');
});

test('bounded processing renews its lease across the original deadline and excludes a second claimant',options,async()=>{
  await reviewCard();await worker.schedule();const job=await worker.claim();
  const deadline=(await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1 RETURNING lease_until",[job.id])).rows[0].lease_until;
  let entered,release;const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  worker.readSource=async()=>{entered();await gate;return{text:document};};
  const processing=worker.process(job);
  try {
    await started;
    await db.query("SELECT pg_sleep(greatest(0,extract(epoch from $1::timestamptz-clock_timestamp()))+0.02)",[deadline]);
    assert.equal((await db.query('SELECT clock_timestamp()>$1::timestamptz AS expired',[deadline])).rows[0].expired,true);
    const second=new EvidenceEditorial({database:db,service,editor:worker.editor,readSource:worker.readSource,workerId:'second-claimant'});
    assert.equal(await second.claim(),null);
  } finally {release();await processing;}
  assert.equal((await worker.automation(user,zone.id)).jobs.completed,1);assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('all eight source checks and separate author and review operations renew the durable lease',options,async()=>{
  await addSupportingSource(7);const observed=[];
  const check=async phase=>{
    const row=(await db.query("SELECT id,lease_until>clock_timestamp()+interval '5 minutes' AS fresh FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 AND state='running'",[zone.id])).rows[0];
    assert.equal(row.fresh,true,`${phase} starts with a renewed lease`);observed.push(phase);
    await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",[row.id]);
  };
  worker.readSource=async()=>{await check('source');return{text:document+' New observations.'};};
  const write=worker.editor.evidenceCard,review=worker.editor.evidenceReview;
  worker.editor.evidenceCard=async input=>{await check('author');return write(input);};
  worker.editor.evidenceReview=async input=>{await check('review');return review(input);};
  await worker.tick();assert.deepEqual(observed,[...Array(8).fill('source'),'author','review']);
  assert.equal((await worker.automation(user,zone.id)).jobs.completed,1);
  assert.equal((await service.detail(user,zone.id,card.id)).evidence.editorial.status,'ai-reviewed');
});

test('renewal never revives an expired lease or takes over another owner',options,async()=>{
  await reviewCard();await worker.schedule();const job=await worker.claim();
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
  await assert.rejects(worker.renew(job),{code:'evidence_revision_conflict'});
  const second=new EvidenceEditorial({database:db,service,editor:worker.editor,readSource:worker.readSource,workerId:'renewal-replacement'});
  assert.equal((await second.claim()).id,job.id);
  const before=(await db.query('SELECT lease_owner,lease_until,attempts FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1',[job.id])).rows[0];
  await assert.rejects(worker.process(job),{code:'evidence_revision_conflict'});
  assert.deepEqual((await db.query('SELECT lease_owner,lease_until,attempts FROM evimed_frontier.evidence_editorial_jobs WHERE id=$1',[job.id])).rows[0],before);
  assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

for(const stop of ['disabled','maintenance'])test(`source checks cannot commit or start a model call after ${stop}`,options,async()=>{
  await reviewCard();worker.readSource=async()=>{
    if(stop==='disabled')await db.query('UPDATE evimed_frontier.evidence_automation SET enabled=false WHERE zone_id=$1',[zone.id]);else worker.canRun=()=>false;
    return{text:document+' Changed observations.'};
  };
  await worker.tick();const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.revision,card.revision);assert.equal(current.editorial.status,'ai-reviewed');assert.deepEqual(current.editorial.sourceChecks,[]);
  assert.equal(current.sources[0].sha256,card.sources[0].sha256);assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('expired review cannot publish a receipt and a new lease resumes only the pending review',options,async()=>{
  worker.readSource=async()=>({text:document+' Changed observations.'});const review=worker.editor.evidenceReview;
  worker.editor.evidenceReview=async input=>{const answer=await review(input);
    await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE zone_id=$1 AND state='running'",[zone.id]);return answer;};
  await worker.tick();let current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.editorial.status,'review-pending');assert.equal(current.editorial.reviewer,null);assert.equal(authorCalls,1);assert.equal(reviewCalls,1);
  worker.editor.evidenceReview=review;await worker.tick();current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.equal(current.editorial.status,'ai-reviewed');assert.equal(authorCalls,1);assert.equal(reviewCalls,2);assert.equal((await worker.automation(user,zone.id)).jobs.completed,1);
});

test('source checks rotate beyond eight without moving citations or claiming full freshness',options,async()=>{
  await addSupportingSource(9);const reads=[],before=card.sources.map(source=>source.url);
  worker.readSource=async url=>{reads.push(url);if(url===before[0])throw unreadable();return{text:document};};
  await worker.tick();assert.equal(reads.length,8);assert.equal(reads.includes(before[9]),false);
  await db.query('UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1',[zone.id]);await worker.tick();
  assert.equal(reads.length,16);assert.deepEqual(new Set(reads),new Set(before));
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.deepEqual(current.sources.map(source=>source.url),before);assert.equal(current.editorial.sourceCheckedAt,card.editorial.sourceCheckedAt);
  assert.equal(current.sources[0].checkedAt,card.sources[0].checkedAt);assert.equal(current.editorial.status,'ai-reviewed');assert.equal(authorCalls,0);assert.equal(reviewCalls,0);
});

test('new discovery jobs inherit the card source cursor while reading their new source within the cap',options,async()=>{
  await addSupportingSource(9);const before=card.sources.map(source=>source.url),reads=[];
  worker.readSource=async url=>{reads.push(url);return{text:document};};await worker.tick();assert.equal(reads.length,8);
  await insertSource(db,'cursor-discovery');const item=await insertItem(db,{sourceId:'cursor-discovery',title:'Kidney new randomized evidence'});
  const url='https://example.org/new-cursor-primary';await db.query('UPDATE evimed_frontier.items SET canonical_url=$2 WHERE id=$1',[item.id,url]);
  worker.editor.evidenceTarget=async()=>card.id;reads.length=0;
  await db.query('UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1',[zone.id]);await worker.schedule();
  // Select the discovery job explicitly; this schedule also queues ordinary maintenance.
  const discovery=(await db.query('SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE source_item_id=$1',[item.publicId])).rows[0];
  assert.equal(discovery.payload.sourceReadCursor,undefined);
  await db.query("UPDATE evimed_frontier.evidence_editorial_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[discovery.id]);
  await worker.tick();
  assert.ok(reads.includes(before[8])&&reads.includes(before[9]),'a different job continues the previous rotation');
  assert.equal(reads.filter(value=>value===url).length,1);assert.equal(reads.length,8);
  const current=(await service.detail(user,zone.id,card.id)).evidence;
  assert.deepEqual(current.sources.slice(0,10).map(source=>source.url),before);assert.equal(current.sources[10].url,url);
  assert.equal(current.editorial.status,'ai-reviewed');assert.equal(authorCalls,1);assert.equal(reviewCalls,1);
});
