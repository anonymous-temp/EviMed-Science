// The operator's decision cards and daily digest against the real stores: the inbox refuses a body over 8,000
// characters, a record has a size limit, an item can be resolved once, and a job is keyed. The in-memory doubles the
// unit tests use have none of these, which is how each of the defects below got through them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { EVOLUTION_EXECUTABLE_OPERATIONS, EVOLUTION_ONE_WAY_OPERATIONS, evolutionDecisionClass } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { NotificationService } from "../src/notificationService.mjs";
import { EvolutionService } from "../src/evolutionService.mjs";
import { EvolutionDecisions, evolutionExecutableOperation, renderEvolutionDigest } from "../src/evolutionDecisions.mjs";
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
const direction = (id, extra = {}) => ({ subjectId: id, category: "implementation", title: `选择方向 ${id}`, body: "已尝试两条路径。", directional: true, attemptedPaths: ["initial", "repair"],
  options: [{ id: "go", label: "继续研发", operation: "build" }, { id: "hold", label: "保留结果并等待", operation: "wait" }], recommended: "go", conservative: "hold", ...extra });
const day = () => { clock = new Date(clock.getTime() + 86_400_000); };
const reviews = { refresh: async () => ({ family: "deepseek", recommended: "go" }), review: async () => ({ independent: true, family: "qwen", recommended: "go" }) };

test("choosing the option that is not recommended is an override, and decisions nobody saw are not agreement (F13)", options, async () => {
  const { decisions } = engine();
  for (let index = 0; index < 10; index++) {
    day();
    const card = await decisions.deliver(await decisions.propose(direction(`overruled-${index}`)));
    const answered = await decisions.resolve(card.id, { expectedRevision: card.revision, option: "hold" });
    assert.equal(answered.payload.overridden, true, "an answer that is not the recommendation overrules it, on time or not");
  }
  day();
  const eleventh = await decisions.propose(direction("overruled-10"));
  assert.equal(eleventh.payload.status, "pending", "ten overruled cards in a row do not earn the engine its own decisions");
  assert.equal(eleventh.payload.decisionClass, "B");
  // Ten decisions the engine took itself (class A, the operator saw none of them) are not ten agreements either.
  for (let index = 0; index < 10; index++) await decisions.propose(direction(`unseen-${index}`, { category: "tool-repair", directional: false }));
  const next = await decisions.propose(direction("unseen-next", { category: "tool-repair" }));
  assert.equal(next.payload.status, "pending");
  assert.equal(next.payload.decisionClass, "B");
});

test("a card is delivered as one inbox item that marks its recommendation, and the item closes when the decision is made (F19)", options, async () => {
  const { decisions, service } = engine(reviews);
  day();
  const card = await decisions.deliver(await decisions.propose(direction("closing")));
  const item = await notifications.get(owner, card.payload.notificationId);
  assert.deepEqual(item.actions.map((action) => [action.id, action.style]), [["go", "primary"], ["hold", "neutral"]]);
  assert.equal(item.resolvedAt, null);
  await decisions.resolve(card.id, { expectedRevision: card.revision, option: "hold" });
  const closed = await notifications.get(owner, card.payload.notificationId);
  assert.ok(closed.resolvedAt);
  assert.deepEqual(closed.resolution, { actionId: "hold", source: "user" });
  // The same when the card expires instead of being answered: closed as a default, never as the operator's own answer.
  day();
  const lapsing = await decisions.deliver(await decisions.propose(direction("lapsing")));
  clock = new Date(Date.parse(lapsing.payload.dueAt) + 1000);
  await decisions.expire(lapsing.id);
  const lapsed = await notifications.get(owner, lapsing.payload.notificationId);
  assert.deepEqual(lapsed.resolution, { actionId: "go", source: "default" });
  assert.equal((await service.get(lapsing.id)).payload.status, "executed");
});

test("a one-way door is class C, takes its conservative option at expiry without any review, and nothing outside the executor's list can run (F14)", options, async () => {
  const review = { refresh: async () => { throw new Error("a one-way door is not refreshed"); }, review: async () => { throw new Error("nor reviewed"); } };
  const { decisions, service } = engine(review);
  day();
  const proposed = await decisions.propose(direction("one-way", { category: "data", options: [{ id: "delete", label: "删除原始数据", operation: "delete-data" }, { id: "keep", label: "保留", operation: "keep" }], recommended: "delete", conservative: "keep" }));
  assert.equal(proposed.payload.decisionClass, "C");
  const card = await decisions.deliver(proposed);
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  const expired = await decisions.expire(card.id);
  assert.equal(expired.payload.selected, "keep");
  assert.equal(expired.payload.source, "default");
  assert.deepEqual(executed.map((action) => action.option), ["keep"]);
  assert.equal((await service.get(card.id)).payload.decisionClass, "C");
  // The class comes from what an option can do, and the executor refuses what is not on its list, whoever chose it.
  for (const operation of EVOLUTION_ONE_WAY_OPERATIONS) {
    assert.equal(evolutionDecisionClass({ options: [{ id: "x", operation }, { id: "y" }] }), "C");
    assert.throws(() => evolutionExecutableOperation({ options: [{ id: "x", operation }], option: "x" }), { code: "evolution_action_unsupported" });
    assert.ok(!EVOLUTION_EXECUTABLE_OPERATIONS.includes(operation));
  }
  for (const operation of EVOLUTION_EXECUTABLE_OPERATIONS) assert.equal(evolutionExecutableOperation({ options: [{ id: "x", operation }], option: "x" }), operation);
  assert.throws(() => evolutionExecutableOperation({ options: [{ id: "x" }], option: "x" }), { code: "evolution_action_unsupported" });
});

test("an expiry whose review cannot be had is said on the card, tried again, and then takes the conservative option (F14)", options, async () => {
  const { decisions, service } = engine({ refresh: async () => { throw Object.assign(new Error("crossref down"), { code: "evolution_refresh_unavailable" }); }, review: async () => null });
  day();
  const card = await decisions.deliver(await decisions.propose(direction("review-down")));
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  const first = await decisions.expire(card.id);
  assert.equal(first.payload.status, "pending");
  assert.deepEqual([first.payload.expiry.state, first.payload.expiry.attempts, first.payload.expiry.code], ["review-unavailable", 1, "evolution_refresh_unavailable"]);
  const retry = await database.query("SELECT run_after FROM evimed_product.jobs WHERE user_id=$1 AND idempotency_key=$2", [owner, `evolution:expire:${card.id}:retry:1`]);
  assert.equal(retry.rows.length, 1);
  assert.ok(new Date(retry.rows[0].run_after) > clock, "asked again later, not at once");
  clock = new Date(clock.getTime() + 3_600_000 + 1000);
  assert.equal((await decisions.expire(card.id)).payload.expiry.attempts, 2);
  clock = new Date(clock.getTime() + 3_600_000 + 1000);
  const last = await decisions.expire(card.id);
  assert.equal(last.payload.status, "executed");
  assert.equal(last.payload.selected, "hold", "never the unreviewed recommendation");
  assert.equal(last.payload.source, "conservative");
  assert.equal(last.payload.evidence.reviewUnavailable.attempts, 3);
  assert.equal((await service.get(card.id)).payload.expiry.state, "conservative-taken");
  assert.equal((await notifications.get(owner, card.payload.notificationId)).resolution.source, "default");
});

test("an answer that arrives while the expiry is carrying out another option does not borrow its action (F14)", options, async () => {
  let failOnce = true;
  const { decisions, service } = engine({ ...reviews, execute: async (action) => {
    if (failOnce) { failOnce = false; throw Object.assign(new Error("executor unavailable"), { status: 503 }); }
    executed.push(action); return { option: action.option };
  } });
  day();
  const card = await decisions.deliver(await decisions.propose(direction("racing")));
  clock = new Date(Date.parse(card.payload.dueAt) + 1000);
  await assert.rejects(decisions.expire(card.id), { status: 503 });
  const inFlight = await service.get(card.id);
  assert.equal(inFlight.payload.status, "executing");
  await assert.rejects(decisions.resolve(card.id, { expectedRevision: inFlight.revision, option: "hold" }), { code: "evolution_decision_executing" });
  const done = await decisions.expire(card.id);
  assert.equal(done.payload.selected, "go");
  assert.deepEqual(executed.map((action) => action.option), ["go"]);
});

test("a digest over the inbox's limit is cut with a count and still delivered, and lists what was achieved, not what was used (F15)", options, async () => {
  const { decisions, service } = engine();
  day();
  for (let index = 0; index < 120; index++) {
    await decisions.propose({ category: index % 2 ? "resource" : "worker-resource", subjectId: `wait-${index}`, resourceOnly: true, title: index % 2 ? "研发线索等待资料" : "进化任务等待资源",
      body: `${"需要新的公开数据。".repeat(30)}${index}`, options: [{ id: "wait", label: "等待", operation: "wait" }, { id: "rescout", label: "重新检索", operation: "rescout" }], recommended: "wait", conservative: "wait" });
  }
  await service.registerTool({ id: "new-today", track: "M", status: "active", name: "今日新工具", artifactDigest: "d1", toolKind: "workflow", smokePassed: true });
  const old = await service.registerTool({ id: "used-today", track: "M", status: "active", name: "早已上线的工具", artifactDigest: "d2", toolKind: "workflow", smokePassed: true });
  clock = new Date(clock.getTime() + 3600_000);
  await service.save("tool", old.id, { ...old.payload, createdAt: "2026-09-01T00:00:00.000Z", usage: { invoked: 9 } }, old);
  const digest = await decisions.digest(clock.toISOString().slice(0, 10));
  const notice = await notifications.get(owner, digest.payload.notificationId);
  assert.ok(notice.body.length <= 8000);
  assert.match(notice.body, /另有 \d+ 项未列出/);
  assert.match(notice.body, /今日新工具/);
  assert.doesNotMatch(notice.body, /早已上线的工具/);
  assert.doesNotMatch(notice.body, /worker-resource|任务类型|缺口类别/);
  assert.deepEqual(notice.source, { type: "system", id: digest.id }, "an evolution digest is not an autopilot digest and links to the inbox");
  assert.ok(JSON.stringify(digest.payload).length < 100_000, "the snapshot holds what the text says, not the documents it was read from");
  // Every wait it counted is reported once; none is left to be reported again tomorrow.
  const unreported = (await service.list("decision")).filter((row) => row.payload.decisionClass === "D" && !row.payload.resourceReportedAt);
  assert.equal(unreported.length, 0);
});

test("whatever a snapshot holds, the text of a digest fits the inbox and says what it left out (F15)", () => {
  const long = "很长的一行。".repeat(400);
  const snapshot = { decisions: [{ title: long }, { title: long }, { title: long }], autonomous: [], resources: [], achievements: [], evaluationSummaries: [{ capabilityIds: [], lines: Array.from({ length: 30 }, () => long) }] };
  const body = renderEvolutionDigest(snapshot);
  assert.ok(body.length <= 8000);
  assert.match(body, /日报过长，另有 \d+ 行未显示/);
  assert.match(renderEvolutionDigest({ decisions: [], autonomous: [], resources: [], achievements: [], evaluationSummaries: [] }), /^今天平台进步了什么\n尚无已确认的新进展。[\s\S]*待你裁决\n暂无/);
});
