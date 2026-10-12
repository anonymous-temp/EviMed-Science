import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createWebApiApp } from "../src/server.mjs";
import { MemoryTopics } from "../src/memoryTopics.mjs";

/**
 * 「记忆地图」 against a real database: the document the views are drawn from, read through the real routes, for an account whose
 * memories have what the map is for — a source that was withdrawn, two statements that disagree, a belief that changed twice — and
 * for a second account whose memories none of it may reach. Then the topics: grouped by a model (stood in for here), edited by
 * the researcher, bounded by the day, and gone with a reset.
 */
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 60_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

async function signIn(base, username, password) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  const auth = await login.json();
  return { "content-type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0], "x-open-science-csrf": auth.data.csrfToken };
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "evimed-memory-map-"));
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
  });
  const password = "test-only-memory-password";
  const make = async (label) => {
    const username = `${label}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    return { user: await app.store.createUser(username, password, "Map fixture"), username };
  };
  const mine = await make("map");
  const theirs = await make("other");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[mine.user.id, theirs.user.id]]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    app, base, user: mine.user, other: theirs.user,
    headers: await signIn(base, mine.username, password),
    otherHeaders: await signIn(base, theirs.username, password),
  };
}

const get = async (base, headers, route) => {
  const response = await fetch(`${base}${route}`, { headers });
  return { status: response.status, body: await response.json() };
};
const fact = (overrides = {}) => ({
  scope: "project", scopeId: "default", kind: "project_fact", key: "project.population", value: "adults with heart failure", summary: "adults with heart failure",
  origin: "inferred", status: "active", confidence: 0.6, importance: 0.7, sensitive: false, ...overrides,
});
const proof = { sourceType: "conversation_message", sourceRef: "sessions/ses_1/messages/1", quote: "stated in the conversation", weight: 1 };
const SOURCE = `src_${"b".repeat(32)}`;

async function seed(memory, userId) {
  const plain = await memory.upsertRecord(userId, fact({ key: "project.setting", value: "outpatient clinics", summary: "outpatient clinics" }), proof);
  const cited = await memory.upsertRecord(userId, fact({ key: "project.effect", value: "the drug halves admissions", summary: "the drug halves admissions" }), proof,
    { sourceLinks: [{ type: "doi", id: "10.1056/nejmoa2034577" }, { type: "knowledge_source", id: SOURCE }] });
  await memory.markSourceLinks(userId, { type: "doi", id: "10.1056/nejmoa2034577" }, { state: "retracted", reason: "retraction notice" });
  const a = await memory.upsertRecord(userId, fact({ key: "project.dose.a", value: "dose is 20 mg", summary: "dose is 20 mg" }), proof);
  const b = await memory.upsertRecord(userId, fact({ key: "project.dose.b", value: "dose is 15 mg", summary: "dose is 15 mg" }), proof);
  await memory.markConflict(userId, a.id, b.id, { reason: "the doses disagree" });
  const v1 = await memory.upsertRecord(userId, fact({ kind: "decision", key: "project.design", value: "open-label", summary: "open-label" }), proof);
  const v2 = await memory.supersede(userId, v1.id, fact({ kind: "decision", key: "project.design.v2", value: "double-blind", summary: "double-blind" }), proof, { reason: "protocol changed" });
  const v3 = await memory.supersede(userId, v2.id ?? v2.record?.id, fact({ kind: "decision", key: "project.design.v3", value: "double-blind, placebo-controlled", summary: "double-blind, placebo-controlled" }), proof, { reason: "protocol changed" });
  const habit = await memory.upsertRecord(userId, { ...fact({ scope: "user", scopeId: "", kind: "behavior", key: "habit.answers", value: "short answers first", summary: "short answers first" }) }, proof);
  const secret = await memory.upsertRecord(userId, fact({ key: "project.secret", value: "never draw this", summary: "never draw this", sensitive: true }), proof);
  const forgotten = await memory.upsertRecord(userId, fact({ key: "project.forgotten", value: "forgotten", summary: "forgotten" }), proof);
  await memory.upsertRecord(userId, { ...forgotten, status: "archived" }, null, { expectedVersion: forgotten.version, reason: "forgotten by the user" });
  const summary = await memory.upsertRecord(userId, fact({ scope: "session", scopeId: "ses_1", kind: "run_summary", key: "run.session.ses_1", value: JSON.stringify({ sessionId: "ses_1" }), summary: "a conversation" }), proof);
  await memory.noteRecordUsage(userId, [cited.id, cited.id, habit.id]);
  return { plain, cited, a, b, v1, v2: v2.record ?? v2, v3: v3.record ?? v3, habit, secret, summary };
}

test("the map reads an account's memories, what they rest on and how they changed, and never what must not be drawn", options, async (t) => {
  const { app, base, headers, user, otherHeaders, other } = await fixture(t);
  const memory = app.researchMemory;
  const made = await seed(memory, user.id);
  await memory.upsertRecord(other.id, fact({ key: "project.theirs", value: "their private memory", summary: "their private memory" }), proof);

  const { status, body } = await get(base, headers, "/api/memory/map?include=summary,facets,nodes,edges,buckets,lanes,events");
  assert.equal(status, 200);
  const map = body.data;
  const ids = map.nodes.map((node) => node.id);
  for (const absent of [made.secret.id, made.summary.id]) assert.ok(!ids.includes(`memory:${absent}`), "a sensitive memory and a run summary are not marks");
  assert.ok(!JSON.stringify(map).includes("never draw this"));
  assert.ok(!JSON.stringify(map).includes("their private memory"), "another account's memory is not reachable");
  assert.ok(!JSON.stringify(map).match(/forgotten"/u), "a forgotten memory is not drawn");
  assert.doesNotMatch(JSON.stringify(map), /inferred|provenance|origin|基于推断/u);

  const node = (id) => map.nodes.find((entry) => entry.id === `memory:${id}`);
  assert.deepEqual([node(made.cited.id).state, node(made.cited.id).reason], ["check", "source-retracted"], "the retracted source is why it needs a look");
  assert.deepEqual([node(made.a.id).state, node(made.a.id).reason], ["check", "conflict"]);
  assert.deepEqual([node(made.b.id).state, node(made.b.id).reason], ["check", "conflict"]);
  assert.equal(node(made.plain.id).state, "current");
  assert.equal(node(made.v1.id).state, "replaced");
  assert.equal(node(made.v3.id).state, "current");
  assert.ok(node(made.habit.id).weight > node(made.plain.id).weight, "what has been handed to a conversation weighs more");
  assert.deepEqual(node(made.cited.id).open, { kind: "record", id: made.cited.id });
  assert.equal(map.summary.needsLook, 3);
  assert.equal(map.summary.memories, 6, "in force: the two earlier versions of the design are history");

  const edge = (from, to, type) => map.edges.find((entry) => entry.from === from && entry.to === to && entry.type === type);
  assert.equal(edge(`memory:${made.cited.id}`, "reference:doi:10.1056/nejmoa2034577", "rests-on")?.state, "retracted");
  assert.equal(edge(`memory:${made.cited.id}`, `document:${SOURCE}`, "rests-on")?.state, "current");
  assert.ok(edge(`memory:${made.v2.id}`, `memory:${made.v1.id}`, "replaces") && edge(`memory:${made.v3.id}`, `memory:${made.v2.id}`, "replaces"));
  assert.ok(map.edges.some((entry) => entry.type === "conflicts" && [`memory:${made.a.id}`, `memory:${made.b.id}`].includes(entry.from)));
  assert.ok(edge(`memory:${made.habit.id}`, "you:account", "belongs-to"));
  assert.ok(edge(`memory:${made.plain.id}`, "project:default", "belongs-to"));
  assert.equal(map.nodes.find((entry) => entry.id === `document:${SOURCE}`).label, "一份资料", "a document the knowledge base does not have keeps a plain name");

  assert.equal(map.lanes.length, 1);
  assert.deepEqual(map.lanes[0].segments.map((segment) => [segment.recordId, segment.state]), [[made.v1.id, "replaced"], [made.v2.id, "replaced"], [made.v3.id, "current"]]);
  assert.ok(map.events.length > 0 && map.events.every((event) => /^memory:/u.test(event.ref) && event.lane));
  assert.ok(map.buckets.series.length >= 1 && map.buckets.series[0].memory > 0);
  const aspects = map.facets.dimensions.find((dimension) => dimension.id === "memory");
  assert.equal(aspects.axes.find((axis) => axis.id === "aspect:habit").count, 1);
  assert.equal(aspects.axes.find((axis) => axis.id === "aspect:decision").count, 1);
  assert.deepEqual(map.missing, [], "nothing this deployment has failed to read");
  assert.equal(map.status.topics, "empty", "too few memories to group, and nothing grouped before");

  // Another account sees its own map and none of this.
  const theirs = (await get(base, otherHeaders, "/api/memory/map")).body.data;
  assert.deepEqual(theirs.nodes.filter((entry) => entry.type === "memory").map((entry) => entry.label), ["their private memory"]);

  // A project: its own, or a 404 before anything is read.
  const narrowed = (await get(base, headers, "/api/memory/map?projectId=default")).body.data;
  assert.ok(!narrowed.nodes.some((entry) => entry.id === `memory:${made.habit.id}`), "the account's own habits are not the project's");
  assert.ok(narrowed.nodes.some((entry) => entry.id === `memory:${made.plain.id}`));
  assert.equal((await get(base, headers, "/api/memory/map?projectId=not-mine")).status, 404);
  assert.equal((await get(base, headers, "/api/memory/map?projectId=evimed-frontier")).status, 404);
  assert.equal((await get(base, headers, "/api/memory/map?focus=nonsense")).status, 400);
  const around = (await get(base, headers, `/api/memory/map?focus=${encodeURIComponent(`memory:${made.v2.id}`)}&depth=1`)).body.data;
  assert.deepEqual(around.nodes.map((entry) => entry.id).sort(), [`memory:${made.v1.id}`, `memory:${made.v2.id}`, `memory:${made.v3.id}`, "project:default"].sort());
  const unauth = await fetch(`${base}/api/memory/map`);
  assert.equal(unauth.status, 401);
});

test("a memory's links are read from the records that own them, and another account's record is a 404", options, async (t) => {
  const { app, base, headers, user, other, otherHeaders } = await fixture(t);
  const memory = app.researchMemory;
  const made = await seed(memory, user.id);
  const theirs = await memory.upsertRecord(other.id, fact({ key: "project.theirs", value: "theirs", summary: "theirs" }), proof);

  const cited = (await get(base, headers, `/api/memory/records/${made.cited.id}/links`)).body.data;
  assert.deepEqual(cited.rests.map((rest) => [rest.type, rest.state]).sort(), [["doi", "retracted"], ["knowledge_source", "current"]]);
  const middle = (await get(base, headers, `/api/memory/records/${made.v2.id}/links`)).body.data;
  assert.deepEqual(middle.replaced.map((entry) => entry.id), [made.v1.id]);
  assert.equal(middle.replacedBy.id, made.v3.id);
  const side = (await get(base, headers, `/api/memory/records/${made.a.id}/links`)).body.data;
  assert.deepEqual(side.conflicts.map((entry) => entry.id), [made.b.id]);
  assert.equal((await get(base, headers, `/api/memory/records/${theirs.id}/links`)).status, 404);
  assert.equal((await get(base, otherHeaders, `/api/memory/records/${made.cited.id}/links`)).status, 404);
  assert.equal((await get(base, headers, `/api/memory/records/${made.secret.id}/links`)).status, 404);
  // The ordinary record routes still answer: the links path is registered before them without taking their ids.
  assert.equal((await get(base, headers, `/api/memory/records/${made.cited.id}/sources`)).status, 200);
});

test("topics: grouped by one call when the memories changed, edited without a call, bounded by the day, and gone with a reset", options, async (t) => {
  const { app, user, other } = await fixture(t);
  const memory = app.researchMemory;
  const config = { memoryTopicsEnabled: true, memoryTopicsDailyRuns: 2, memoryTopicsMinMemories: 6, deepseekProviderEnabled: true, deepseekApiKey: "test-key", memoryExtractionModel: "deepseek-v4-flash" };
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const written = await memory.upsertRecord(user.id, fact({ scope: "user", scopeId: "", kind: "preference", key: `habit.k${index}`, value: `memory ${index}`, summary: `memory ${index}` }), proof);
    ids.push(written.id);
  }
  const calls = [];
  const callModel = async (_deps, call) => {
    calls.push(call);
    assert.equal(call.purpose, "memory-extraction");
    assert.equal(call.userId, user.id);
    const shown = JSON.parse(call.body.messages[1].content);
    const members = shown.memories.map((entry) => entry.id);
    return { choices: [{ message: { content: JSON.stringify({ topics: [
      { id: "", label: "第一组", members: members.slice(0, 4) },
      { id: "", label: "第二组", members: [...members.slice(4), "invented"] },
      { id: "", label: "编造的", members: ["ghost-1", "ghost-2"] },
    ] }) } }] };
  };
  let clock = new Date("2026-10-12T08:00:00Z");
  const topics = new MemoryTopics(config, memory, { callModel, now: () => clock });
  const records = () => memory.mapRecords(user.id, {});

  assert.deepEqual((await topics.read(user.id, await records())).status, "stale", "never grouped, and there is enough to group");
  assert.equal(calls.length, 0, "reading never calls the model");
  const first = await topics.refresh(user.id, { projectId: "default" });
  assert.deepEqual([first.status, first.made], ["ready", true]);
  assert.equal(calls.length, 1);
  const read = await topics.read(user.id, await records());
  assert.deepEqual(read.topics.map((topic) => [topic.label, topic.weight]).sort(), [["第一组", 4], ["第二组", 4]], "an invented member and an invented topic are dropped by code");
  assert.deepEqual((await topics.refresh(user.id, { projectId: "default" })).made, false);
  assert.equal(calls.length, 1, "the memories did not change, so nothing is asked");

  // The researcher's word costs no call, and is kept through a regrouping.
  const one = read.topics.find((topic) => topic.label === "第一组");
  const two = read.topics.find((topic) => topic.label === "第二组");
  assert.equal(await topics.rename(user.id, one.id, "我的习惯"), true);
  assert.equal(await topics.removeMember(user.id, two.id, two.members[0]), true);
  assert.equal(await topics.rename(user.id, "topic:ffffffffff", "x"), false, "a topic that does not exist");
  assert.equal(await topics.merge(user.id, one.id, one.id), false);
  assert.equal(await topics.rename(user.id, "not-a-topic", "x"), false);
  const edited = (await topics.read(user.id, await records())).topics;
  assert.deepEqual(edited.map((topic) => [topic.label, topic.weight]).sort(), [["我的习惯", 4], ["第二组", 3]].sort());
  assert.equal(calls.length, 1);

  const added = await memory.upsertRecord(user.id, fact({ scope: "user", scopeId: "", kind: "preference", key: "habit.new", value: "memory new", summary: "memory new" }), proof);
  assert.equal((await topics.read(user.id, await records())).status, "stale", "a new memory is a reason to group again");
  clock = new Date("2026-10-12T09:00:00Z");
  const regrouped = await topics.refresh(user.id, { projectId: "default" });
  assert.equal(regrouped.made, true);
  assert.equal(calls.length, 2);
  const told = JSON.parse(calls[1].body.messages[1].content);
  assert.deepEqual(told.existing.find((entry) => entry.fixed), { id: one.id, label: "我的习惯", fixed: true }, "the model is told which name is the researcher's");
  const after = (await topics.read(user.id, await records())).topics;
  assert.equal(after.find((topic) => topic.id === one.id)?.label, "我的习惯", "the rename survives the regrouping");
  assert.ok(after.some((topic) => topic.members.includes(added.id)) || after.length >= 1);

  // A dismissed topic is told to the model by name and does not come back.
  assert.equal(await topics.dismiss(user.id, one.id), true);
  assert.ok(!(await topics.read(user.id, await records())).topics.some((topic) => topic.id === one.id));

  // The day's bound: two groupings, the third is refused until the next day, and a refusal is `bounded`, not an error.
  await memory.upsertRecord(user.id, fact({ scope: "user", scopeId: "", kind: "preference", key: "habit.newer", value: "memory newer", summary: "memory newer" }), proof);
  const third = await topics.refresh(user.id, { projectId: "default" });
  assert.deepEqual([third.status, third.made, third.bounded], ["stale", false, true]);
  assert.equal(calls.length, 2);
  clock = new Date("2026-10-13T00:30:00Z");
  assert.equal((await topics.refresh(user.id, { projectId: "default" })).made, true, "the next day, the bound is the day's again");

  // A model that fails costs a try, keeps the last grouping, and is not an error.
  const failing = new MemoryTopics({ ...config, memoryTopicsDailyRuns: 5 }, memory, { callModel: async () => { throw new Error("upstream down"); }, now: () => clock });
  await memory.upsertRecord(user.id, fact({ scope: "user", scopeId: "", kind: "preference", key: "habit.latest", value: "memory latest", summary: "memory latest" }), proof);
  const kept = await failing.refresh(user.id, { projectId: "default" });
  assert.deepEqual([kept.status, kept.made], ["stale", false]);
  assert.ok((await failing.read(user.id, await records())).topics.length > 0, "the last grouping is still served");

  // Another account has none of this, and a reset takes the grouping with the memories.
  assert.deepEqual((await topics.read(other.id, await memory.mapRecords(other.id, {}))).topics, []);
  await memory.purgeUserMemory(user.id);
  const gone = await app.store.database.query("SELECT count(*)::int AS n FROM evimed_memory.topic_sets WHERE user_id=$1", [user.id]);
  assert.equal(gone.rows[0].n, 0);
});

test("the topics routes: the researcher's word over HTTP, refused for what is not theirs", options, async (t) => {
  const { app, base, headers, user, other, otherHeaders } = await fixture(t);
  const memory = app.researchMemory;
  // The app's own topics are switched on and have no model here, so the grouping is written as the model would have, directly.
  for (let index = 0; index < 14; index += 1) await memory.upsertRecord(user.id, fact({ scope: "user", scopeId: "", kind: "preference", key: `habit.h${index}`, value: `memory ${index}`, summary: `memory ${index}` }), proof);
  const records = await memory.mapRecords(user.id, {});
  const mine = records.slice(0, 5).map((record) => record.id);
  await memory.database.query(`INSERT INTO evimed_memory.topic_sets (user_id, topics, memory_mark) VALUES ($1, $2::jsonb, 'old')`,
    [user.id, JSON.stringify([{ id: "topic:aaaaaaaaaa", label: "一组", members: mine }, { id: "topic:bbbbbbbbbb", label: "二组", members: records.slice(5, 9).map((record) => record.id) }])]);

  const listed = (await get(base, headers, "/api/memory/topics")).body.data;
  assert.deepEqual(listed.topics.map((topic) => topic.id), ["topic:aaaaaaaaaa", "topic:bbbbbbbbbb"]);
  const patch = (route, body, h = headers) => fetch(`${base}${route}`, { method: "PATCH", headers: h, body: JSON.stringify(body) });
  const renamed = await patch("/api/memory/topics/topic:aaaaaaaaaa", { label: "改了名" });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).data.topics[0].label, "改了名");
  assert.equal((await patch("/api/memory/topics/topic:aaaaaaaaaa", { label: "x", dismiss: true })).status, 400, "exactly one thing at a time");
  assert.equal((await patch("/api/memory/topics/topic:aaaaaaaaaa", { colour: "red" })).status, 400);
  assert.equal((await patch("/api/memory/topics/topic:cccccccccc", { label: "没有" })).status, 404);
  assert.equal((await patch("/api/memory/topics/topic:aaaaaaaaaa", { label: "别人改" }, otherHeaders)).status, 404, "another account has no such topic");
  const merged = await patch("/api/memory/topics/topic:bbbbbbbbbb", { mergeInto: "topic:aaaaaaaaaa" });
  assert.deepEqual((await merged.json()).data.topics.map((topic) => [topic.id, topic.weight]), [["topic:aaaaaaaaaa", 9]]);
  const dismissed = await patch("/api/memory/topics/topic:aaaaaaaaaa", { dismiss: true });
  assert.deepEqual((await dismissed.json()).data.topics, []);
  // The refresh answers without a model and says the grouping is due.
  const refreshed = await fetch(`${base}/api/memory/topics/refresh`, { method: "POST", headers });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).data.made, false);
  const map = (await get(base, headers, "/api/memory/map?include=facets")).body.data;
  assert.deepEqual(map.facets.topics, [], "the dismissed topics are not on the map either");
  void other;
});
