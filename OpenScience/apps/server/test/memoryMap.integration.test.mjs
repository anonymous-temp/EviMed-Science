import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { MemoryTopics } from "../src/memoryTopics.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

/**
 * 「记忆地图」 against a real database and the memory engine's store (its wire doubled by the in-process OpenViking stub): the document the
 * views are drawn from, read through the real routes, for an account whose memory files have what the map is for — a source that was
 * withdrawn, a belief that changed — and for a second account whose memories none of it may reach. Then the topics: grouped by a model
 * (stood in for here), edited by the researcher, bounded by the day, and gone with a reset. (Until 2026-10-25 the memories were the
 * platform's own records, with disagreements between them and replacements of one by another; a memory file has neither, and those
 * cases went with that engine.)
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
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" }), { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true, databaseUrl,
    memoryEngineEnabled: true, openVikingSessions: sessions,
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
  /** A memory file of an account, written into the engine the way the engine would have. */
  const seedFor = (user) => (rel, text, extra) => stub.seedMemory(sessions.engineUser(user.id), rel, text, extra);
  return {
    app, base, user: mine.user, other: theirs.user,
    headers: await signIn(base, mine.username, password),
    otherHeaders: await signIn(base, theirs.username, password),
    seed: seedFor(mine.user), seedOther: seedFor(theirs.user),
  };
}

const get = async (base, headers, route) => {
  const response = await fetch(`${base}${route}`, { headers });
  return { status: response.status, body: await response.json() };
};
const SOURCE = `src_${"b".repeat(32)}`;
const DOI = "10.1056/nejmoa2034577";
/** The page's record of a memory file, by the file. */
const recordOf = async (base, headers, uri) => (await get(base, headers, "/api/memory/records")).body.data.find((entry) => entry.uri === uri);

test("the map reads an account's memory files, what they rest on and how they changed, and never what must not be drawn", options, async (t) => {
  const { app, base, headers, user, otherHeaders, seed, seedOther } = await fixture(t);
  const overlay = app.nativeMemory.overlay;
  const plain = seed("project_facts/setting.md", "outpatient clinics", { type: "project_facts", tags: ["project=default"] });
  const cited = seed("project_facts/effect.md", "the drug halves admissions", { type: "project_facts", tags: ["project=default"] });
  await overlay.setSources(user.id, cited, [{ type: "doi", id: DOI }, { type: "knowledge_source", id: SOURCE }]);
  await overlay.markSource(user.id, cited, { type: "doi", id: DOI }, "retracted");
  const habit = seed("preferences/answers.md", "short answers first", { type: "preferences" });
  const secret = seed("project_facts/secret.md", "never draw this", { type: "project_facts", tags: ["project=default"] });
  await overlay.upsertFile({ userId: user.id, uri: secret, memoryType: "project_facts", sensitive: true, body: "never draw this" });
  seedOther("project_facts/theirs.md", "their private memory", { type: "project_facts" });
  // A page edit is a change the map's growth strip shows.
  const edited = await recordOf(base, headers, plain);
  assert.equal((await fetch(`${base}/api/memory/records/${encodeURIComponent(edited.id)}`, { method: "PATCH", headers,
    body: JSON.stringify({ value: "outpatient and inpatient clinics", expectedVersion: edited.version }) })).status, 200);

  const { status, body } = await get(base, headers, "/api/memory/map?include=summary,facets,nodes,edges,buckets,lanes,events");
  assert.equal(status, 200);
  const map = body.data;
  const idOf = async (uri) => (await recordOf(base, headers, uri))?.id;
  assert.ok(!map.nodes.some((node) => node.label === "never draw this"), "a sensitive memory is not a mark");
  assert.ok(!JSON.stringify(map).includes("never draw this"));
  assert.ok(!JSON.stringify(map).includes("their private memory"), "another account's memory is not reachable");
  assert.doesNotMatch(JSON.stringify(map), /inferred|provenance|origin|基于推断/u);

  const node = (id) => map.nodes.find((entry) => entry.id === `memory:${id}`);
  const citedId = await idOf(cited);
  const plainId = await idOf(plain);
  const habitId = await idOf(habit);
  assert.deepEqual([node(citedId).state, node(citedId).reason], ["check", "source-retracted"], "the retracted source is why it needs a look");
  assert.equal(node(plainId).state, "current");
  assert.deepEqual(node(citedId).open, { kind: "record", id: citedId });
  assert.equal(map.summary.needsLook, 1);
  assert.equal(map.summary.memories, 3, "the three files that may be drawn");

  const edge = (from, to, type) => map.edges.find((entry) => entry.from === from && entry.to === to && entry.type === type);
  assert.equal(edge(`memory:${citedId}`, `reference:doi:${DOI}`, "rests-on")?.state, "retracted");
  assert.equal(edge(`memory:${citedId}`, `document:${SOURCE}`, "rests-on")?.state, "current");
  assert.ok(edge(`memory:${habitId}`, "you:account", "belongs-to"));
  assert.ok(edge(`memory:${plainId}`, "project:default", "belongs-to"));
  assert.equal(map.nodes.find((entry) => entry.id === `document:${SOURCE}`).label, "一份资料", "a document the knowledge base does not have keeps a plain name");
  assert.deepEqual(map.lanes ?? [], [], "a memory file has no earlier versions of itself to lay out as a lineage");
  assert.ok(map.events.some((event) => event.ref === `memory:${plainId}` && event.change === "updated") && map.events.every((event) => /^memory:/u.test(event.ref) && event.lane));
  assert.ok(map.buckets.series.length >= 1 && map.buckets.series[0].memory > 0);
  assert.deepEqual(map.missing, [], "nothing this deployment has failed to read");

  // Another account sees its own map and none of this.
  const theirs = (await get(base, otherHeaders, "/api/memory/map")).body.data;
  assert.deepEqual(theirs.nodes.filter((entry) => entry.type === "memory").map((entry) => entry.label), ["theirs"], "its own file, named by its topic, and nothing of the first account's");

  // A project: its own, or a 404 before anything is read.
  const narrowed = (await get(base, headers, "/api/memory/map?projectId=default")).body.data;
  assert.ok(!narrowed.nodes.some((entry) => entry.id === `memory:${habitId}`), "the account's own habits are not the project's");
  assert.ok(narrowed.nodes.some((entry) => entry.id === `memory:${plainId}`));
  assert.equal((await get(base, headers, "/api/memory/map?projectId=not-mine")).status, 404);
  assert.equal((await get(base, headers, "/api/memory/map?projectId=evimed-frontier")).status, 404);
  assert.equal((await get(base, headers, "/api/memory/map?focus=nonsense")).status, 400);
  const around = (await get(base, headers, `/api/memory/map?focus=${encodeURIComponent(`memory:${citedId}`)}&depth=1`)).body.data;
  assert.ok(around.nodes.some((entry) => entry.id === `memory:${citedId}`) && around.nodes.some((entry) => entry.id === `reference:doi:${DOI}`));
  assert.ok(!around.nodes.some((entry) => entry.id === `memory:${habitId}`));
  const unauth = await fetch(`${base}/api/memory/map`);
  assert.equal(unauth.status, 401);
});

test("the notes of the account's own capsule are marks of the map and the overview's read answers what it counts, through the real routes", options, async (t) => {
  const { app, base, headers, user, otherHeaders, seed } = await fixture(t);
  const style = seed("preferences/style.md", "short answers first", { type: "preferences" });
  const capsule = await app.capsuleService.ownCapsule(user.id, { create: true });
  const note = await app.capsuleService.addEntry(user.id, capsule.id, { factKind: "writing_style", layer: "profile", content: "Cite page numbers." });
  const gone = await app.capsuleService.addEntry(user.id, capsule.id, { factKind: "preference", layer: "profile", content: "A note forgotten." });
  await app.capsuleService.updateEntry(user.id, capsule.id, gone.id, { status: "retired", expectedRevision: gone.revision });
  const projectNote = await app.capsuleService.addEntry(user.id, capsule.id, { factKind: "project_fact", layer: "knowledge", content: "Adults only." });

  // What the overview asks for: no lines and no lineages.
  const { status, body } = await get(base, headers, "/api/memory/map?include=summary,facets,nodes,buckets,events");
  assert.equal(status, 200);
  const map = body.data;
  assert.equal("engine" in map, false, "one engine: the document says nothing of which");
  assert.equal(map.edges, undefined);
  assert.equal(map.lanes, undefined);
  const marks = map.nodes.filter((entry) => entry.type === "memory");
  const styleId = (await recordOf(base, headers, style)).id;
  assert.deepEqual(marks.map((entry) => entry.id).sort(), [`memory:entry:${note.id}`, `memory:entry:${projectNote.id}`, `memory:${styleId}`].sort(),
    "a note is a mark of the memory kind; the one the researcher forgot is not drawn");
  const noteMark = marks.find((entry) => entry.id === `memory:entry:${note.id}`);
  assert.deepEqual(noteMark.open, { kind: "entry", id: note.id });
  assert.equal(noteMark.subtype, "writing_style");
  assert.equal(map.summary.memories, 3, "the headline counts the notes with the memories");
  // What is about the person, by kind, counted before anything is folded: a project's kind is not.
  assert.deepEqual(map.facets.aboutYou.map((kind) => [kind.id, kind.count]).sort(), [["preference", 1], ["writing_style", 1]]);
  assert.ok(map.events.some((event) => event.ref === `memory:entry:${note.id}` && event.change === "created"), "a note is a gain on the growth strip");
  assert.ok(map.buckets.series.every((day) => typeof day.document === "number"), "a day counts the documents added as well");
  assert.deepEqual(map.facets.documentTypes, [], "no document in this account's knowledge base");
  assert.equal(map.facets.dimensions.find((dimension) => dimension.id === "memory").axes.find((axis) => axis.id === "aspect:habit").count, 1, "a writing style is a habit in the radar");
  assert.deepEqual(map.missing, []);
  // Another account has none of it.
  const theirs = (await get(base, otherHeaders, "/api/memory/map?include=summary,nodes")).body.data;
  assert.deepEqual(theirs.nodes.filter((entry) => entry.type === "memory"), []);
  // The two routes the overview replaced are not served.
  assert.equal((await fetch(`${base}/api/memory/growth`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/memory/learned`, { headers })).status, 404);
});

/** The account's memories as the map draws them, for a topics service that is handed them directly. */
const memoryRows = (count, prefix = "memory") => Array.from({ length: count }, (_, index) => ({
  id: `nm_${String(index).padStart(24, "0")}`, scope: "user", scopeId: "", kind: "preference", status: "active", sensitive: false,
  summary: `${prefix} ${index}`, value: `${prefix} ${index}`, updatedAt: "2026-10-10T00:00:00Z", createdAt: "2026-10-10T00:00:00Z", version: 1,
}));

test("topics: grouped by one call when the memories changed, edited without a call, bounded by the day, and gone with a reset", options, async (t) => {
  const { app, user, other } = await fixture(t);
  const memory = app.memorySettings;
  const config = { memoryTopicsEnabled: true, memoryTopicsDailyRuns: 2, memoryTopicsMinMemories: 6, deepseekProviderEnabled: true, deepseekApiKey: "test-key", memoryExtractionModel: "deepseek-v4-flash" };
  /** The account's memories, which the test changes under the topics. */
  const held = memoryRows(8);
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
  const topics = new MemoryTopics(config, memory, { callModel, now: () => clock, accountRecords: async (userId) => (userId === user.id ? held : []) });
  const records = () => held;

  assert.deepEqual((await topics.read(user.id, records())).status, "stale", "never grouped, and there is enough to group");
  assert.equal(calls.length, 0, "reading never calls the model");
  const first = await topics.refresh(user.id, { projectId: "default" });
  assert.deepEqual([first.status, first.made], ["ready", true]);
  assert.equal(calls.length, 1);
  const read = await topics.read(user.id, records());
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
  const edited = (await topics.read(user.id, records())).topics;
  assert.deepEqual(edited.map((topic) => [topic.label, topic.weight]).sort(), [["我的习惯", 4], ["第二组", 3]].sort());
  assert.equal(calls.length, 1);

  const added = memoryRows(1, "memory new")[0];
  held.push({ ...added, id: `nm_${"a".repeat(24)}` });
  assert.equal((await topics.read(user.id, records())).status, "stale", "a new memory is a reason to group again");
  clock = new Date("2026-10-12T09:00:00Z");
  const regrouped = await topics.refresh(user.id, { projectId: "default" });
  assert.equal(regrouped.made, true);
  assert.equal(calls.length, 2);
  const told = JSON.parse(calls[1].body.messages[1].content);
  assert.deepEqual(told.existing.find((entry) => entry.fixed), { id: one.id, label: "我的习惯", fixed: true }, "the model is told which name is the researcher's");
  const after = (await topics.read(user.id, records())).topics;
  assert.equal(after.find((topic) => topic.id === one.id)?.label, "我的习惯", "the rename survives the regrouping");

  // A dismissed topic is told to the model by name and does not come back.
  assert.equal(await topics.dismiss(user.id, one.id), true);
  assert.ok(!(await topics.read(user.id, records())).topics.some((topic) => topic.id === one.id));

  // The day's bound: two groupings, the third is refused until the next day, and a refusal is `bounded`, not an error.
  held.push({ ...added, id: `nm_${"b".repeat(24)}`, summary: "memory newer", value: "memory newer" });
  const third = await topics.refresh(user.id, { projectId: "default" });
  assert.deepEqual([third.status, third.made, third.bounded], ["stale", false, true]);
  assert.equal(calls.length, 2);
  clock = new Date("2026-10-13T00:30:00Z");
  assert.equal((await topics.refresh(user.id, { projectId: "default" })).made, true, "the next day, the bound is the day's again");

  // A model that fails costs a try, keeps the last grouping, and is not an error.
  const failing = new MemoryTopics({ ...config, memoryTopicsDailyRuns: 5 }, memory, { callModel: async () => { throw new Error("upstream down"); }, now: () => clock,
    accountRecords: async () => held });
  held.push({ ...added, id: `nm_${"c".repeat(24)}`, summary: "memory latest", value: "memory latest" });
  const kept = await failing.refresh(user.id, { projectId: "default" });
  assert.deepEqual([kept.status, kept.made], ["stale", false]);
  assert.ok((await failing.read(user.id, records())).topics.length > 0, "the last grouping is still served");

  // Another account has none of this, and a reset takes the grouping with the memories.
  assert.deepEqual((await topics.read(other.id, [])).topics, []);
  await memory.purgeUserMemory(user.id);
  const gone = await app.store.database.query("SELECT count(*)::int AS n FROM evimed_memory.topic_sets WHERE user_id=$1", [user.id]);
  assert.equal(gone.rows[0].n, 0);
});

test("the topics routes: the researcher's word over HTTP, refused for what is not theirs", options, async (t) => {
  const { app, base, headers, user, otherHeaders, seed } = await fixture(t);
  const memory = app.memorySettings;
  // The app's own topics are switched on and have no model here, so the grouping is written as the model would have, directly.
  const uris = Array.from({ length: 14 }, (_, index) => seed(`preferences/h${index}.md`, `memory ${index}`, { type: "preferences" }));
  const listing = (await get(base, headers, "/api/memory/records")).body.data;
  const records = uris.map((uri) => listing.find((entry) => entry.uri === uri));
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
});

test("a line the researcher calls wrong stays out of their map until they take it back, and is nobody else's business", options, async (t) => {
  const { app, base, headers, user, otherHeaders, other, seed, seedOther } = await fixture(t);
  const overlay = app.nativeMemory.overlay;
  const cited = seed("project_facts/effect.md", "the drug halves admissions", { type: "project_facts", tags: ["project=default"] });
  await overlay.setSources(user.id, cited, [{ type: "doi", id: DOI }]);
  const theirs = seedOther("project_facts/theirs.md", "their private memory", { type: "project_facts" });
  await overlay.setSources(other.id, theirs, [{ type: "doi", id: DOI }]);
  const citedId = (await recordOf(base, headers, cited)).id;
  const read = async (headersOf = headers) => (await get(base, headersOf, "/api/memory/map?include=nodes,edges")).body.data;
  const put = async (id, hidden, headersOf = headers) => {
    const response = await fetch(`${base}/api/memory/map/edges/${id}`, { method: "PUT", headers: headersOf, body: JSON.stringify({ hidden }) });
    return { status: response.status, body: await response.json() };
  };
  const rests = (map) => map.edges.find((entry) => entry.type === "rests-on" && entry.from === `memory:${citedId}` && entry.to === `reference:doi:${DOI}`);

  const before = await read();
  const line = rests(before);
  assert.match(line.id, /^e_[0-9a-f]{24}$/u);
  assert.equal((await put(line.id, true)).status, 200);
  const after = await read();
  assert.equal(rests(after), undefined, "the line is hidden");
  assert.ok(after.nodes.some((node) => node.id === `memory:${citedId}`), "the memory itself is still drawn");
  assert.ok(!after.nodes.some((node) => node.id === `reference:doi:${DOI}`), "and so is no longer a mark of the paper nothing rests on");
  // Said twice is said once; another account sees its own line, with the same id, untouched.
  assert.equal((await put(line.id, true)).status, 200);
  const theirMap = await read(otherHeaders);
  const theirLine = theirMap.edges.find((entry) => entry.type === "rests-on");
  assert.ok(theirLine, "another account's line to the same paper is drawn");
  assert.equal(theirLine.id === line.id, false, "a line is a memory's: the same paper under another account's memory is another line");
  // Taken back, the line is drawn again.
  assert.equal((await put(line.id, false)).status, 200);
  assert.ok(rests(await read()), "taking it back draws it again");
  // The answers by name: a malformed id and body, and the structure that cannot be called wrong.
  assert.equal((await put("not-a-line", true)).status, 400);
  assert.equal((await fetch(`${base}/api/memory/map/edges/${line.id}`, { method: "PUT", headers, body: JSON.stringify({ hidden: "yes" }) })).status, 400);
  assert.equal((await fetch(`${base}/api/memory/map/edges/${line.id}`, { method: "GET", headers })).status, 405);
  const structure = before.edges.find((entry) => entry.type === "belongs-to");
  assert.equal((await put(structure.id, true)).status, 200);
  assert.ok((await read()).edges.some((entry) => entry.id === structure.id), "a belongs-to line is structure: saying it is wrong hides nothing");
  // The correction is a row of its own, keyed by account and line.
  const rows = await app.store.database.query("SELECT edge_id FROM evimed_memory.map_edge_dismissals WHERE user_id=$1", [user.id]);
  assert.ok(rows.rows.length >= 1);
});
