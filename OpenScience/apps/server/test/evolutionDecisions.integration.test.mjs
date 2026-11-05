// The operator's decision cards and daily digest against the real stores: the inbox refuses a body over 8,000
// characters, a record has a size limit, an item can be resolved once, and a job is keyed. The in-memory doubles the
// unit tests use have none of these, which is how each of the defects below got through them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { EVOLUTION_EXECUTABLE_OPERATIONS } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { EvolutionService } from "../src/evolutionService.mjs";
import { EvolutionDecisions, evolutionExecutableOperation, renderEvolutionDigest } from "../src/evolutionDecisions.mjs";
import { EvolutionMaintenance } from "../src/evolutionMaintenance.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `decisions_${randomUUID()}`;
let isolated, database, documents, jobs, notifications, clock, executed;

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "evodec");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 2000 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Evolution operator','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576)", [owner]);
  documents = new ProductDocuments(database); jobs = new ProductJobs(database); notifications = new NotificationService(database);
  clock = new Date("2026-10-05T00:30:00Z");
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

/** A fresh service and decisions over the shared stores; `callbacks` are the review and the executor. */
function engine(callbacks = {}, config = {}) {
  executed = [];
  const service = new EvolutionService({ documents, jobs, notifications, ownerId: owner, now: () => clock, config });
  const decisions = new EvolutionDecisions({ service, notifications, now: () => clock, config: service.config, callbacks: {
    execute: async (action) => { executed.push(action); return { option: action.option }; }, ...callbacks } });
  return { service, decisions };
}
/** A card as the harm review writes one: saved pending, delivered when the digest or the proposer delivers it. */
let cards = 0;
const pending = (id, extra = {}) => { cards += 1; const service = new EvolutionService({ documents, jobs, notifications, ownerId: owner, now: () => clock });
  return service.save("decision", `card-${id}-${cards}`, { subjectId: `subject-${id}`, category: "tool-retire", decisionClass: "B", status: "pending", history: [], overridden: false, title: `选择方向 ${id}`, body: "已尝试两条路径。",
    options: [{ id: "go", label: "保留", operation: "keep" }, { id: "hold", label: "保留结果并等待", operation: "wait" }], recommended: "go", conservative: "hold", createdAt: clock.toISOString(), ...extra }); };
const day = () => { clock = new Date(clock.getTime() + 86_400_000); };

test("choosing the option that is not recommended is an override, and the latest answer is the one that counts (F13)", options, async () => {
  const { decisions } = engine();
  day();
  const card = await decisions.deliver(await pending("overruled"));
  const answered = await decisions.resolve(card.id, { expectedRevision: card.revision, option: "hold" });
  assert.equal(answered.payload.overridden, true, "an answer that is not the recommendation overrules it, on time or not");
  const again = await decisions.resolve(card.id, { expectedRevision: answered.revision, option: "go" });
  assert.equal(again.payload.overridden, false);
  assert.equal(again.payload.history.length, 2);
});

test("a card is delivered as one inbox item that marks its recommendation, and the item closes when the decision is made (F19)", options, async () => {
  const { decisions, service } = engine();
  day();
  const card = await decisions.deliver(await pending("closing"));
  const item = await notifications.get(owner, card.payload.notificationId);
  assert.deepEqual(item.actions.map((action) => [action.id, action.style]), [["go", "primary"], ["hold", "neutral"]]);
  assert.equal(item.resolvedAt, null);
  await decisions.resolve(card.id, { expectedRevision: card.revision, option: "hold" });
  const closed = await notifications.get(owner, card.payload.notificationId);
  assert.ok(closed.resolvedAt);
  assert.deepEqual(closed.resolution, { actionId: "hold", source: "user" });
  // The same when the card expires instead of being answered: closed as a default, never as the operator's own answer.
  day();
  const lapsing = await decisions.deliver(await pending("lapsing"));
  clock = new Date(Date.parse(lapsing.payload.dueAt) + 1000);
  await decisions.expire(lapsing.id);
  const lapsed = await notifications.get(owner, lapsing.payload.notificationId);
  assert.deepEqual(lapsed.resolution, { actionId: "hold", source: "default" });
  assert.equal((await service.get(lapsing.id)).payload.status, "executed");
});

test("an unanswered card takes its conservative option, never the recommendation, and nothing outside the executor's list can run (F14)", options, async () => {
  const { decisions, service } = engine();
  day();
  const card = await decisions.deliver(await pending("one-way", { decisionClass: "C", options: [{ id: "keep", label: "保留", operation: "keep" }, { id: "wait", label: "等待", operation: "wait" }], recommended: "wait", conservative: "keep" }));
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  const expired = await decisions.expire(card.id);
  assert.equal(expired.payload.selected, "keep");
  assert.equal(expired.payload.source, "conservative");
  assert.deepEqual(executed.map((action) => action.option), ["keep"]);
  assert.equal((await service.get(card.id)).payload.decisionClass, "C");
  // The executor refuses what is not on its list, whoever chose it.
  assert.throws(() => evolutionExecutableOperation({ options: [{ id: "x", operation: "delete-data" }], option: "x" }), { code: "evolution_action_unsupported" });
  for (const operation of EVOLUTION_EXECUTABLE_OPERATIONS) assert.equal(evolutionExecutableOperation({ options: [{ id: "x", operation }], option: "x" }), operation);
  assert.throws(() => evolutionExecutableOperation({ options: [{ id: "x" }], option: "x" }), { code: "evolution_action_unsupported" });
});

test("an answer that arrives while the expiry is carrying out another option does not borrow its action (F14)", options, async () => {
  let failOnce = true;
  const { decisions, service } = engine({ execute: async (action) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error("executor unavailable"), { status: 503 }); }
    executed.push(action); return { option: action.option };
  } });
  day();
  const card = await decisions.deliver(await pending("racing"));
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  await assert.rejects(decisions.expire(card.id), { status: 503 });
  const inFlight = await service.get(card.id);
  assert.equal(inFlight.payload.status, "executing");
  await assert.rejects(decisions.resolve(card.id, { expectedRevision: inFlight.revision, option: "go" }), { code: "evolution_decision_executing" });
  const done = await decisions.expire(card.id);
  assert.equal(done.payload.selected, "hold");
  assert.deepEqual(executed.map((action) => action.option), ["hold"]);
});

test("a digest with more than it can list says so and still delivers, and lists what was achieved, not what was used (F15)", options, async () => {
  const { decisions, service } = engine();
  day();
  const publishedAt = new Date(clock.getTime() + 3600_000 - 60_000).toISOString();
  for (let index = 0; index < 12; index++) await service.save("tool", `new-today-${index}`, { track: "M", status: "active", name: `今日新工具${index}`, artifactDigest: `d${index}`, toolKind: "workflow", smokePassed: true, createdAt: publishedAt });
  await service.save("tool", "used-today", { track: "M", status: "active", name: "早已上线的工具", artifactDigest: "old", toolKind: "workflow", smokePassed: true, createdAt: "2026-09-01T00:00:00.000Z", usage: { invoked: 9 } });
  clock = new Date(clock.getTime() + 3600_000);
  const digest = await decisions.digest(clock.toISOString().slice(0, 10));
  const notice = await notifications.get(owner, digest.payload.notificationId);
  assert.ok(notice.body.length <= 8000);
  assert.match(notice.body, /另有 2 项未列出/);
  assert.match(notice.body, /今日新工具\d+/);
  assert.doesNotMatch(notice.body, /早已上线的工具/);
  assert.deepEqual(notice.source, { type: "system", id: digest.id }, "an evolution digest is not an autopilot digest and links to the inbox");
  assert.ok(JSON.stringify(digest.payload).length < 100_000, "the snapshot holds what the text says, not the documents it was read from");
});

test("whatever a snapshot holds, the text of a digest fits the inbox and says what it left out (F15)", () => {
  const long = "很长的一行。".repeat(400);
  const snapshot = { decisions: [{ title: long }, { title: long }, { title: long }], autonomous: [], resources: [], achievements: Array.from({ length: 30 }, () => ({ name: long, level: "V2" })) };
  const body = renderEvolutionDigest(snapshot);
  assert.ok(body.length <= 8000);
  assert.match(body, /日报过长，另有 \d+ 行未显示/);
  assert.match(renderEvolutionDigest({ decisions: [], autonomous: [], resources: [], achievements: [] }), /^待你裁决\n暂无/);
});

test("a retirement's progress survives a failure after its pin changed: the decision's action no longer holds it in one transaction (review 2026-10-26)", options, async () => {
  const service = new EvolutionService({ documents, jobs, notifications, ownerId: owner, now: () => clock });
  const pins = [];
  let inboxDown = true;
  const maintenance = new EvolutionMaintenance({ service, callbacks: { notifyAffected: async ({ toolId }) => {
    pins.push(toolId);
    if (inboxDown) { inboxDown = false; throw Object.assign(new Error("inbox down"), { code: "notification_unavailable" }); }
  } } });
  const decisions = new EvolutionDecisions({ service, notifications, now: () => clock, config: service.config,
    callbacks: { execute: (action) => service.executeDecisionAction(action, () => maintenance.executeReview(action)) } });
  const id = `durable-${randomUUID()}`;
  await service.save("tool", id, { track: "M", status: "active", artifactDigest: "digest" });
  const review = await service.save("maintenance-review", `review-${id}`, { kind: "sequential-harm", parentToolIds: [id], status: "pending" });
  const card = await service.save("decision", `card-${id}`, { category: "tool-retire", subjectId: review.id, decisionClass: "C", status: "pending", history: [],
    options: [{ id: "retire", label: "软退役", operation: "maintenance-retire" }, { id: "keep", label: "保留", operation: "keep" }], recommended: "retire", conservative: "retire" });
  await assert.rejects(decisions.resolve(card.id, { expectedRevision: card.revision, option: "retire" }), { code: "notification_unavailable" });
  assert.deepEqual(pins, [id], "the serving pin was retired on disk");
  const halfway = await service.get(id);
  assert.deepEqual([halfway.payload.status, halfway.payload.retirement?.state], ["retired", "pending"], "and the ledger kept that, for the retry or retirement-reconcile to finish");
  const executing = await service.get(card.id);
  assert.equal(executing.payload.status, "executing");
  const settled = await decisions.resolve(card.id, { expectedRevision: executing.revision, option: "retire" });
  assert.equal(settled.payload.status, "executed");
  assert.equal((await service.get(id)).payload.retirement.state, "complete");
  assert.deepEqual(pins, [id, id]);
});

const experimentOptions = [{ id: "repair", label: "研发修复版本", operation: "maintenance-repair" }, { id: "merge", label: "研发合并版本", operation: "maintenance-merge" }];

test("the digest delivers only what serving can carry out: a card of experiments closes and takes no slot", options, async () => {
  const { decisions, service } = engine({}, { evolutionMaxDecisionCards: 1 });
  day();
  const experiment = await pending("only-experiments", { options: experimentOptions, recommended: "repair", conservative: "repair", impact: 9 });
  const servable = await pending("carried-out", { impact: 1 });
  await decisions.digest(clock.toISOString().slice(0, 10));
  const closed = await service.get(experiment.id), delivered = await service.get(servable.id);
  assert.equal(closed.payload.status, "closed");
  assert.equal(closed.payload.notificationId, undefined, "no inbox item for it");
  assert.ok(delivered.payload.deliveredAt, "the one slot went to the card serving can carry out");
});

test("closing a delivered card closes its inbox item, as a default and never as the operator's answer", options, async () => {
  const { decisions } = engine();
  day();
  const card = await decisions.deliver(await pending("close-notice", { options: experimentOptions, recommended: "repair", conservative: "repair" }));
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  assert.equal((await decisions.expire(card.id)).payload.status, "closed");
  const item = await notifications.get(owner, card.payload.notificationId);
  assert.ok(item.resolvedAt);
  assert.equal(item.resolution.source, "default");
});

test("a stranded execution with nothing serving can carry out closes on an answer instead of answering `executing` for ever", options, async () => {
  const { decisions, service } = engine();
  day();
  const card = await pending("stranded", { options: experimentOptions, recommended: "repair", conservative: "repair", status: "executing", execution: { actionId: "stranded:1:repair", option: "repair", source: "default", evidence: {} } });
  const answered = await decisions.resolve(card.id, { expectedRevision: card.revision, option: "repair" });
  assert.equal(answered.payload.status, "closed");
  assert.equal(answered.payload.closedReason, "retired-to-lab");
  assert.equal((await service.get(card.id)).payload.execution, undefined, "kept in the history, no longer holding the card");
  // One serving can carry out still supersedes it, as before.
  const second = await pending("stranded-servable", { status: "executing", execution: { actionId: "stranded:2:repair", option: "repair", source: "default", evidence: {} }, options: [...experimentOptions, { id: "keep", label: "保留", operation: "keep" }], conservative: "keep" });
  assert.equal((await decisions.resolve(second.id, { expectedRevision: second.revision, option: "keep" })).payload.status, "executed");
});

test("what a card becomes at its due date is what expiry will do, from what the server knows", options, async () => {
  const { decisions, service } = engine();
  day();
  const review = await service.save("maintenance-review", `review-due-${randomUUID()}`, { kind: "sequential-harm", parentToolIds: ["t"], status: "pending" });
  const harmOptions = [{ id: "retire", label: "软退役并保留历史", operation: "maintenance-retire" }, { id: "keep", label: "保留现有工具", operation: "keep" }];
  const harm = await decisions.deliver(await pending("due-harm", { subjectId: review.id, decisionClass: "C", options: harmOptions, recommended: "retire", conservative: "keep" }));
  assert.deepEqual(await decisions.dueOutcome(harm), { kind: "option", option: "retire", label: "软退役并保留历史" }, "a card written before 2026-10-26 stored `keep`; expiry retires, so the card says so");
  const ordinary = await decisions.deliver(await pending("due-ordinary"));
  assert.deepEqual(await decisions.dueOutcome(ordinary), { kind: "option", option: "hold", label: "保留结果并等待" });
  const experiment = await decisions.deliver(await pending("due-experiment", { options: [...experimentOptions, { id: "keep", label: "保留", operation: "keep" }], recommended: "keep", conservative: "repair" }));
  assert.deepEqual(await decisions.dueOutcome(experiment), { kind: "close" });
  assert.equal(await decisions.dueOutcome(await service.save("decision", `card-executed-${randomUUID()}`, { ...ordinary.payload, status: "executed" })), null, "nothing is due on a decided card");
});
