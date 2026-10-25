// The memory routes, over the real app and a real database, with the memory engine's wire doubled by the in-process OpenViking stub.
//
// What is worth proving is what a researcher does: read what the page lists and searches, pause and reset, have a deleted project retire
// the methods learnt only in it, and have an erased account leave nothing owed to nobody. Every one of those crosses the route, the
// store and the database together. (The cases that wrote the platform's own PostgreSQL records — confirming an inference, a raced
// edit, the undo of an automatic write, a project's records deleted with it — went with that engine on 2026-10-25; the engine's own
// edit, forget and undo are held in `nativeMemoryRoutes.integration.test.mjs` and its project and account deletion in
// `nativeMemoryApp.integration.test.mjs`.)
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LearningService } from "../src/learningService.mjs";
import { retiredMemosOwner } from "../src/retiredMemos.mjs";
import { OpenVikingClient } from "../src/openVikingClient.mjs";
import { OpenVikingSessions } from "../src/openVikingSessions.mjs";
import { createWebApiApp } from "../src/server.mjs";
import { startOpenVikingStub } from "./helpers/openVikingStub.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.match(url.pathname, /evimed_test/);
}
const options = { timeout: 20_000, skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** The real app, a real account, and a signed-in browser's headers.
 *  `extra` is spread over the same object the app reads both its configuration
 *  and its injected collaborators from. */
async function fixture(t, extra = {}) {
  const dataDir = await mkdtemp(path.join("/tmp", "evimed-memory-api-"));
  const stub = await startOpenVikingStub(t);
  const sessions = new OpenVikingSessions(new OpenVikingClient({ openVikingUrl: stub.url, openVikingApiKey: stub.apiKey, openVikingAccount: "evimed" }), { timeoutMs: 2_000, fastTimeoutMs: 1_000 });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl, memoryEngineEnabled: true, openVikingSessions: sessions, ...extra,
  });
  const username = `memory${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const password = "test-only-memory-password";
  const user = await app.store.createUser(username, password, "Memory fixture");
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [user.id]);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const auth = await login.json();
  const headers = {
    "content-type": "application/json",
    cookie: login.headers.get("set-cookie").split(";")[0],
    "x-open-science-csrf": auth.data.csrfToken,
  };
  /** A memory file of the account, written into the engine the way the engine would have. */
  const seed = (rel, text, how) => stub.seedMemory(sessions.engineUser(user.id), rel, text, how);
  return { app, base, headers, user, seed };
}

test("the memory page reads its rows and its search, and the note, status and timeline routes are gone", options, async (t) => {
  const { base, headers, seed } = await fixture(t);

  // `GET /api/memory/status` (no page read it since the 记忆 page lost its status line) and `GET /api/memory/timeline` (none since the
  // 成长 tab went; the overview's growth card and the map's time view are the map's own document) are not routes any more.
  for (const path of ["/api/memory/status", "/api/memory/timeline"]) {
    assert.equal((await fetch(`${base}${path}`, { headers })).status, 404, `GET ${path} is not a route any more`);
  }

  // 「你写下的笔记」 and its three routes went with `evimed_memory.notes` on
  // 2026-09-20: a composer for exactly what the extractor already writes.
  for (const [path, method] of [["/api/memory/memos", "GET"], ["/api/memory/memos", "POST"],
    ["/api/memory/memos/note_1", "PATCH"], ["/api/memory/memos/note_1", "DELETE"]]) {
    const gone = await fetch(`${base}${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(gone.status, 404, `${method} ${path} is not a route any more`);
  }

  seed("profile.md", "# Profile\n- 临床药师，主攻抗凝治疗", { type: "profile" });
  seed("preferences/format.md", "回答先给结论，再给依据。", { type: "preferences" });

  const profile = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  assert.deepEqual(profile.records.map((record) => record.value).sort(), ["回答先给结论，再给依据。", "临床药师，主攻抗凝治疗"].sort());
  assert.deepEqual(profile.usage, {}, "a memory file has no use counter of its own, and the page says so as an absence");

  const found = (await (await fetch(`${base}/api/memory/search?q=${encodeURIComponent("抗凝")}`, { headers })).json()).data;
  assert.deepEqual(found.items.map((item) => item.value), ["临床药师，主攻抗凝治疗"], "a memory is found by what it says");
  assert.equal(found.query, "抗凝");
});

test("the researcher's switches pause learning and recall without deleting, and a reset deletes without touching them", options, async (t) => {
  // 2026-09-16 review, M4④: pause vs reset, and a project of its own.
  const { app, base, headers, user, seed } = await fixture(t);
  const put = (body) => fetch(`${base}/api/memory/settings`, { method: "PUT", headers, body: JSON.stringify(body) });
  const read = async () => (await (await fetch(`${base}/api/memory/settings`, { headers })).json()).data;

  assert.deepEqual(await read(), { learningPaused: false, recallPaused: false, pausedProjects: [], updatedAt: null },
    "an account that set nothing has every switch off");

  // Two tabs flipping different switches at the same moment both win.
  const [learning, projects] = await Promise.all([put({ learningPaused: true }), put({ pausedProjects: ["default", "default"] })]);
  assert.equal(learning.status, 200);
  assert.equal(projects.status, 200);
  const both = await read();
  assert.equal(both.learningPaused, true);
  assert.equal(both.recallPaused, false);
  assert.deepEqual(both.pausedProjects, ["default"], "a repeated id is one project");

  for (const [body, why] of [
    [{ learningPaused: "yes" }, "a switch is a boolean"],
    [{ pausedProjects: ["../escape"] }, "a paused project is a project id"],
    [{ somethingElse: true }, "an unknown setting is refused by name"],
  ]) {
    const refused = await put(body);
    assert.equal(refused.status, 400, why);
    assert.equal((await refused.json()).code, "memory_settings_invalid", why);
  }

  const file = seed("preferences/language.md", "Answer in Chinese.", { type: "preferences" });
  assert.ok(file);
  await put({ pausedProjects: [], recallPaused: true });

  const unconfirmed = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).code, "memory_reset_confirmation_required");
  assert.equal((await (await fetch(`${base}/api/memory/records`, { headers })).json()).data.length, 1, "a refused reset deletes nothing");

  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).data, { methods: 0, handbooks: 0, entries: 0, jobs: 0, feedback: 0, native: { files: 1, sessions: 0, revisions: 0 } },
    "the engine's file goes with the rest (and is counted as the engine's)");
  assert.equal((await (await fetch(`${base}/api/memory/records`, { headers })).json()).data.length, 0, "the engine's file is gone");
  assert.ok(await app.memorySettings.resetInstant(user.id), "and the instant of the reset is the account's, for what is learned afterwards");
  const after = await read();
  assert.equal(after.learningPaused, true, "a reset is a clean slate, not a change to the switches");
  assert.equal(after.recallPaused, true);
});

test("a reset clears every kind the memory page shows — memories, learned methods, handbooks, the researcher's own capsule notes — and nothing that is not theirs", options, async (t) => {
  // 2026-10-07 walk (C1 D-P0-1): the dialog said 「永久删除全部记忆」 and only the structured records went; the page still held
  // every method, every handbook and every capsule note.
  const { app, base, headers, user } = await fixture(t);
  const other = await app.store.createUser(`memory${randomUUID().replaceAll("-", "").slice(0, 10)}`, "test-only-memory-password", "Other");
  const documents = app.capsuleService.documents;
  const learning = new LearningService({ documents });
  const frontmatter = { name: "citation-alignment", description: "Align citations.", whenToUse: "When a report needs references.",
    metadata: { role: "functional", applies_when: "A report with references.", not_when: "No citations.", derived_from: "run:run_1", evimed_schema: "method-skill/1" } };
  const body = ["## Purpose", "Align every citation marker with one reference.", "## When to Use", "When a report needs references.", "## Inputs", "The report.",
    "## Workflow", "1. Match markers.", "## Verification", "- Every marker has one entry.", "## Constraints", "- Do not invent entries.", "## Output", "A reference list."].join("\n");
  const seed = async (owner) => {
    const method = await learning.createCandidate(owner, { projectId: null, frontmatter, body, provenance: { origin: "inferred", runId: "run_1", sourceProjectId: "default" } });
    await documents.put(owner, "method", `method:capability-handbook:geo-content:${frontmatter.name}`, { recordType: "capability-handbook", capabilityId: "geo-content",
      status: "active", frontmatter, body, contentDigest: "sha256:a", version: 1, createdAt: new Date().toISOString() }, { expectedRevision: 0 });
    await documents.put(owner, "method", "method:handbook:geo-content:waiting", { recordType: "handbook-candidate", status: "candidate", frontmatter, body, contentDigest: "sha256:b" }, { expectedRevision: 0 });
    const capsule = await app.capsuleService.ownCapsule(owner, { create: true });
    const note = await app.capsuleService.addEntry(owner, capsule.id, { factKind: "preference", layer: "profile", content: "先看一手研究" });
    const forgotten = await app.capsuleService.addEntry(owner, capsule.id, { factKind: "preference", layer: "profile", content: "旧偏好" });
    await app.capsuleService.updateEntry(owner, capsule.id, forgotten.id, { status: "retired", expectedRevision: forgotten.revision });
    const document = await app.capsuleService.addEntry(owner, capsule.id, { factKind: "project_fact", layer: "sources", origin: "inferred", content: "据资料：抗凝前查肾功能",
      derivedFrom: { sourceId: `src_${"a".repeat(32)}`, projectId: "default" } });
    const received = await app.capsuleService.create(owner, { title: "李主任的工作方式" });
    await documents.put(owner, "capsule", received.id, { ...received.payload, imported: true }, { expectedRevision: received.revision });
    const shared = await app.capsuleService.addEntry(owner, received.id, { factKind: "method_preference", layer: "methods", content: "别人的做法" });
    return { method, note, document, shared, received };
  };
  const mine = await seed(user.id);
  const theirs = await seed(other.id);
  // What the platform would learn the account from again (review M-11): a lesson waiting, and what the researcher did.
  const database = app.store.database;
  const lessons = {};
  for (const owner of [user.id, other.id]) {
    lessons[owner] = (await database.query(`INSERT INTO evimed_product.jobs(id,user_id,kind,payload,idempotency_key) VALUES ($1,$2,'distill','{}'::jsonb,$3) RETURNING id`,
      [`job_${randomUUID()}`, owner, `lesson:${randomUUID()}`])).rows[0].id;
    await database.query(`INSERT INTO evimed_product.feedback_events(id,user_id,trigger_kind,subject_type,subject_id,detail,occurred_at)
      VALUES ($1,$2,'memory-rejected','memory-record',$3,'{}'::jsonb,clock_timestamp())`, [`feedback:${randomUUID()}`, owner, `rec_${randomUUID()}`]);
  }

  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  const resetBody = await reset.json();
  assert.equal(reset.status, 200, JSON.stringify(resetBody));
  assert.deepEqual(resetBody.data, { methods: 1, handbooks: 1, entries: 2, jobs: 1, feedback: 1, native: { files: 0, sessions: 0, revisions: 0 } },
    "the method, the handbook and both own notes (in force and forgotten); the waiting lesson goes without being counted as one; and the lesson queued and the feedback recorded");
  assert.equal((await database.query("SELECT status FROM evimed_product.jobs WHERE id=$1", [lessons[user.id]])).rows[0].status, "canceled");
  assert.equal((await database.query("SELECT status FROM evimed_product.jobs WHERE id=$1", [lessons[other.id]])).rows[0].status, "queued", "another account's lesson stands");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.feedback_events WHERE user_id=$1", [user.id])).rows[0].n, 0);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_product.feedback_events WHERE user_id=$1", [other.id])).rows[0].n, 1);

  assert.deepEqual((await learning.listMethods(user.id)).items, []);
  assert.equal(await documents.get(user.id, "method", mine.method.id), null);
  assert.deepEqual((await documents.list(user.id, "method", { filter: { recordType: "capability-handbook" } })).items, []);
  assert.deepEqual((await documents.list(user.id, "method", { filter: { recordType: "handbook-candidate" } })).items, [], "a lesson waiting to become a handbook would put one back");
  const left = await app.capsuleService.mine(user.id);
  assert.deepEqual([left.entries, left.forgotten], [[], []]);
  assert.ok(await documents.get(user.id, "fact", mine.document.id), "a knowledge-base document's facts belong to the document");
  assert.ok(await documents.get(user.id, "fact", mine.shared.id), "another person's shared pack is not the researcher's memory");
  assert.ok(await documents.get(user.id, "capsule", mine.received.id));
  assert.deepEqual(await app.store.database.query("SELECT 1 FROM evimed_product.revisions WHERE user_id=$1 AND kind='fact' AND id=$2", [user.id, mine.note.id]).then((result) => result.rows), [],
    "deleted with its history: a reset that kept recoverable copies would not be the clean slate");

  // Another account is untouched, and a second reset finds nothing.
  assert.equal((await learning.listMethods(other.id)).items.length, 1);
  assert.equal((await app.capsuleService.mine(other.id)).entries.length, theirs.note ? 1 : 0);
  const again = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  assert.deepEqual((await again.json()).data, { methods: 0, handbooks: 0, entries: 0, jobs: 0, feedback: 0, native: { files: 0, sessions: 0, revisions: 0 } });
  // The fixture's own cleanup closes the pool, so the second account is removed here, while it is open.
  await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [other.id]);
});

test("the page's new reads answer through the real app: handbooks to read and stop, a method's sources, the notes the researcher forgot", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const documents = app.capsuleService.documents;
  const learning = new LearningService({ documents });
  const frontmatter = { name: "citation-alignment", description: "Align citations.", whenToUse: "When a report needs references.",
    metadata: { role: "functional", applies_when: "A report with references.", not_when: "No citations.", derived_from: "run:run_1", evimed_schema: "method-skill/1" } };
  const body = ["## Purpose", "Align every citation marker with one reference.", "## When to Use", "When a report needs references.", "## Inputs", "The report.",
    "## Workflow", "1. Match markers.", "## Verification", "- Every marker has one entry.", "## Constraints", "- Do not invent entries.", "## Output", "A reference list."].join("\n");
  const method = await learning.createCandidate(user.id, { projectId: null, frontmatter, body, provenance: { origin: "inferred", runId: "run_1", sourceProjectId: "default" },
    display: { title: "引用标记对齐", summary: "每个标记对应一条。" } });
  await documents.put(user.id, "method", method.id, { ...method.payload, status: "approved" }, { expectedRevision: method.revision });
  const handbookId = "method:capability-handbook:geo-content:citation-alignment";
  await documents.put(user.id, "method", handbookId, { recordType: "capability-handbook", capabilityId: "geo-content", status: "active", frontmatter, body,
    contentDigest: "sha256:a", version: 1, display: { title: "每一句结论落回来源", summary: "写结论时同时写出处。" }, createdAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(), source: { projectId: "default", runId: "run_9", sessionId: "ses_9" } }, { expectedRevision: 0 });
  const capsule = await app.capsuleService.ownCapsule(user.id, { create: true });
  const old = await app.capsuleService.addEntry(user.id, capsule.id, { factKind: "preference", layer: "profile", content: "旧偏好" });
  await app.capsuleService.updateEntry(user.id, capsule.id, old.id, { status: "retired", expectedRevision: old.revision });
  const read = async (path) => { const response = await fetch(`${base}${path}`, { headers }); assert.equal(response.status, 200, path); return (await response.json()).data; };

  const handbooks = await read("/api/handbooks");
  assert.deepEqual(handbooks.items.map((item) => [item.title, item.capabilityId]), [["每一句结论落回来源", "geo-content"]]);
  const detail = await read(`/api/handbooks/${encodeURIComponent(handbookId)}`);
  assert.equal(detail.body, body);
  assert.deepEqual(detail.sources, [], "a run this deployment cannot find is a link not shown, and the drawer still opens");
  const stopped = await fetch(`${base}/api/handbooks/${encodeURIComponent(handbookId)}/retire`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: detail.revision }) });
  assert.equal(stopped.status, 200);
  assert.equal((await read("/api/handbooks")).items.length, 0);
  assert.equal((await read("/api/handbooks?status=retired")).items.length, 1);

  assert.deepEqual((await read(`/api/methods/${encodeURIComponent(method.id)}/sources`)).items, []);
  const mine = await read("/api/capsules/mine");
  assert.deepEqual([mine.entries.length, mine.forgotten.map((entry) => entry.payload.content)], [0, ["旧偏好"]]);
});

// 2026-10-10 review M-10/M-11 (owner ruling): deleting a project stops the methods learnt only there.
test("deleting a project retires the methods learnt only in it, and a method another project's lesson also shaped stands", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const learning = new LearningService({ documents: app.capsuleService.documents });
  const frontmatter = (name) => ({ name, description: "Align citations.", whenToUse: "When a report needs references.",
    metadata: { role: "functional", applies_when: "A report with references.", not_when: "No citations.", derived_from: "run:run_1", evimed_schema: "method-skill/1" } });
  const body = ["## Purpose", "Align every citation marker with one reference.", "## When to Use", "When a report needs references.", "## Inputs", "The report.",
    "## Workflow", "1. Match markers.", "## Verification", "- Every marker has one entry.", "## Constraints", "- Do not invent entries.", "## Output", "A reference list."].join("\n");
  for (const id of ["project-gone", "project-kept"]) {
    assert.equal((await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id, name: id }) })).status, 200);
  }
  const only = await learning.createCandidate(user.id, { projectId: "project-gone", frontmatter: frontmatter("only-here"), body, provenance: { origin: "inferred", runId: "run_1" } });
  const both = await learning.createCandidate(user.id, { projectId: "project-gone", frontmatter: frontmatter("here-and-there"), body, provenance: { origin: "inferred", runId: "run_2" } });
  await learning.amendMethod(user.id, both.id, { expectedRevision: both.revision, frontmatter: frontmatter("here-and-there"), body: `${body}\n\nA second project taught this too.`,
    provenance: { origin: "inferred", runId: "run_3", sourceProjectId: "project-kept" } });
  const elsewhere = await learning.createCandidate(user.id, { projectId: "project-kept", frontmatter: frontmatter("only-there"), body, provenance: { origin: "inferred", runId: "run_4" } });

  const deleted = await fetch(`${base}/api/projects/project-gone`, { method: "DELETE", headers, body: JSON.stringify({ confirm: "project-gone" }) });
  assert.equal(deleted.status, 200, await deleted.clone().text());

  const documents = app.capsuleService.documents;
  const read = async (id) => (await documents.get(user.id, "method", id)).payload;
  assert.equal((await read(only.id)).status, "retired", "learnt only in the deleted project");
  assert.equal((await read(only.id)).statusReason, "它只是从已删除的项目里学到的，已停用。");
  assert.notEqual((await read(both.id)).status, "retired", "a lesson from another project also shaped it");
  assert.notEqual((await read(elsewhere.id)).status, "retired", "learnt in a project that stands");
});

// 2026-10-10 review M-10: a conversation's own records (scope "session") carry no project, so the project's deletion
// has to be told which conversations the project had; the route names them from the project's sessions and runs.
// A pause turned on under a runtime that is already up: its methods were mounted at launch (2026-10-10 review L-5), so the
// idle ones are let go and the next launch mounts none. Turning learning off, or recall back on, lets go of nothing.
test("turning recall off asks the runtime manager to let go of the account's idle runtimes that carry methods", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  /** @type {string[]} */ const asked = [];
  app.runtimeManager.releasePausedMethodRuntimes = async (/** @type {string} */ userId) => { asked.push(userId); return []; };
  const put = async (/** @type {any} */ body) => {
    const response = await fetch(`${base}/api/memory/settings`, { method: "PUT", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  await put({ learningPaused: true });
  assert.deepEqual(asked, [], "pausing learning mounts and unmounts nothing");
  await put({ recallPaused: true });
  assert.deepEqual(asked, [user.id]);
  await put({ recallPaused: false, pausedProjects: ["default"] });
  assert.deepEqual(asked, [user.id, user.id], "and so does 「本项目不使用记忆」");
  await put({ recallPaused: false, pausedProjects: [] });
  assert.deepEqual(asked, [user.id, user.id], "turning it back on asks for nothing");
});

// 2026-10-10 review M-11: the retired usememos tables sit in `public`, reach nothing in `evimed_control`, and outlived every
// account. Erasing an account takes its rows with it where the tables are still there.
test("deleting an account takes its rows out of the retired usememos tables and leaves the digests an archive is re-sealed against", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const database = app.store.database;
  const owner = retiredMemosOwner(user.id);
  const stranger = retiredMemosOwner(`someone-else-${randomUUID()}`);
  await database.query("CREATE TABLE IF NOT EXISTS public.memory_record (id serial PRIMARY KEY, namespace text, value text)");
  await database.query("CREATE TABLE IF NOT EXISTS public.memo (id serial PRIMARY KEY, content text)");
  try {
    await database.query("INSERT INTO public.memory_record (namespace, value) VALUES ($1,'mine'),($2,'theirs')", [owner.namespace, stranger.namespace]);
    await database.query("INSERT INTO public.memo (content) VALUES ($1),($2)", [`mine\n\n#evimed-user-${owner.tag}`, `theirs\n\n#evimed-user-${stranger.tag}`]);

    const deleted = await fetch(`${base}/api/account`, {
      method: "DELETE", headers, body: JSON.stringify({ confirm: user.id, password: "test-only-memory-password" }),
    });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual((await database.query("SELECT value FROM public.memory_record")).rows, [{ value: "theirs" }]);
    assert.deepEqual((await database.query("SELECT content FROM public.memo")).rows.map((row) => row.content.startsWith("theirs")), [true]);
    assert.deepEqual((await database.query("SELECT namespace, tag FROM evimed_memory.retired_erasures WHERE namespace=$1", [owner.namespace])).rows,
      [{ namespace: owner.namespace, tag: owner.tag }]);
  } finally {
    // Inside the test: the fixture closes the pool when the test ends.
    await database.query("DROP TABLE IF EXISTS public.memory_record, public.memo");
    await database.query("DELETE FROM evimed_memory.retired_erasures WHERE namespace=ANY($1::text[])", [[owner.namespace, stranger.namespace]]);
  }
});

// The index is derived and owns no record: every hit is re-read from PostgreSQL
// and a copy whose row is gone is dropped there. So a slow index must not decide
// whether a project can be deleted. Until 2026-10-05 the route asked the index to
// forget the subtree first and answered 503 `memory_index_timeout` when it was slow
// (live, right after the project's runs ended; the same request succeeded two
// minutes later). The rows go, the withdrawal is owed in the same transaction, and
// the index worker tells the index until it answers.
function slowIndex() {
  const asked = [];
  const index = {
    configured: true,
    down: true,
    asked,
    async status() { return { configured: true, connected: true, code: null }; },
    async find() { return []; },
    async write() { return { ok: true }; },
    async list() { return []; },
    async listAll() { return []; },
    async remove(userId, uri, opts) {
      asked.push({ uri, recursive: opts?.recursive === true });
      if (index.down) throw Object.assign(new Error("The memory index is unavailable."), { code: "memory_index_timeout", status: 503 });
      return true;
    },
  };
  return index;
}

test("erasing an account never waits on the index: the account goes and its copies are owed, past the account's own end", options, async (t) => {
  const index = slowIndex();
  const { app, base, headers, user } = await fixture(t, { memoryIndexProvider: "openviking", openVikingClient: index });
  const deleted = await fetch(`${base}/api/account`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: user.id, password: "test-only-memory-password" }),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  const db = app.store.database;
  assert.equal((await db.query("SELECT 1 FROM evimed_control.users WHERE id=$1", [user.id])).rowCount, 0);
  const owed = await db.query("SELECT uri FROM evimed_memory.index_withdrawals WHERE user_id=$1", [user.id]);
  assert.ok(owed.rows.some((row) => row.uri.endsWith("/memories/evimed")), "everything of the account in the index is owed");
  await db.query("DELETE FROM evimed_memory.index_withdrawals WHERE user_id=$1", [user.id]);
});

// 2026-10-10 review M-7: the capsule half of recall falls back to lexical search when the index cannot answer, and said so
// to nobody: `CapsuleService.lastIndexError` was read only by a test. The research-memory arm reports the same state in
// readiness and in the degraded gauge (whose alert covers both); the capsule arm now does too.
test("an index that cannot answer a capsule recall is visible in readiness and in the degraded gauge, and clears when it answers", options, async (t) => {
  const index = slowIndex();
  const { app, base, user } = await fixture(t, { memoryIndexProvider: "openviking", openVikingClient: index, operatorMetricsToken: "metrics-secret" });
  const capsule = await app.capsuleService.create(user.id, { title: "Index outage" });
  await app.capsuleService.addEntry(user.id, capsule.id, { factKind: "preference", layer: "profile", content: "Prefer forest plots." });
  await app.capsuleService.activate(user.id, capsule.id, { mode: "own" });
  const account = (await app.store.userById(user.id)).accountCreatedAt;
  const readiness = async () => (await (await fetch(`${base}/api/ready`)).json()).data.checks.memoryIndex;
  const gauge = async () => (await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer metrics-secret" } })).text())
    .split("\n").filter((line) => line.startsWith("open_science_memory_recall_degraded"));

  assert.equal((await readiness()).capsuleRecall, undefined, "nothing has failed yet");
  assert.deepEqual(await gauge(), ['open_science_memory_recall_degraded{arm="capsule",code="none"} 0']);

  index.find = async () => { throw Object.assign(new Error("index down"), { code: "memory_index_timeout", status: 503 }); };
  const answered = await app.capsuleService.recall(user.id, { query: "forest", projectId: "default", accountCreatedAt: account });
  assert.equal(answered.mode, "lexical", "the answer still comes, from PostgreSQL");
  assert.deepEqual((await readiness()).capsuleRecall, { lastError: "memory_index_timeout" });
  assert.equal((await readiness()).recall, undefined, "there is no research-memory arm any more: the capsule's is the only one");
  assert.deepEqual(await gauge(), ['open_science_memory_recall_degraded{arm="capsule",code="memory_index_timeout"} 1']);

  index.find = async () => [];
  await app.capsuleService.recall(user.id, { query: "forest", projectId: "default", accountCreatedAt: account });
  assert.equal((await readiness()).capsuleRecall, undefined, "the index answered: no longer degraded");
  assert.deepEqual(await gauge(), ['open_science_memory_recall_degraded{arm="capsule",code="none"} 0']);
});
