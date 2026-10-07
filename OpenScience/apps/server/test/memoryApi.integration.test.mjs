// The memory routes, over the real store, on a real database.
//
// These used to run against an HTTP fake of a separate memory service, which
// could only ever prove that the routes spoke that service's dialect. The store
// is in-process now, so what is worth proving is what a researcher does: write a
// note and get it back, confirm an inference the product made about them,
// refuse an edit that raced another, and have a deleted project take its
// memories with it. Every one of those crosses the route, the store and the
// database together, and none of them is decidable in any single layer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { LearningService } from "../src/learningService.mjs";
import { createWebApiApp } from "../src/server.mjs";

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
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local",
    bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl, ...extra,
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
  return { app, base, headers, user };
}

test("the memory page reads its status, its rows and its search, and the note routes are gone", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);

  const status = await (await fetch(`${base}/api/memory/status`, { headers })).json();
  assert.deepEqual(status.data, { configured: true, connected: true, code: null, structured: true },
    "the status page reads these four fields; a store on the database answers all four");

  // 「你写下的笔记」 and its three routes went with `evimed_memory.notes` on
  // 2026-09-20: a composer for exactly what the extractor already writes.
  for (const [path, method] of [["/api/memory/memos", "GET"], ["/api/memory/memos", "POST"],
    ["/api/memory/memos/note_1", "PATCH"], ["/api/memory/memos/note_1", "DELETE"]]) {
    const gone = await fetch(`${base}${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(gone.status, 404, `${method} ${path} is not a route any more`);
  }

  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "profile", key: "profile.who",
    value: "临床药师，主攻抗凝治疗", summary: "临床药师，主攻抗凝治疗",
    origin: "explicit", status: "active", confidence: 1, importance: 0.8, sensitive: false,
  }, { sourceType: "conversation_message", sourceRef: "sessions/ses_9/messages/m1", quote: "我是临床药师",
    observedAt: new Date().toISOString(), weight: 1 });
  // A 「做过的研究」 summary, which recall never serves and the page must still
  // be able to find: searching a drug name is how a person looks for one.
  await app.researchMemory.upsertRecord(user.id, {
    scope: "project", scopeId: "default", kind: "run_summary", key: "run.session.ses_9",
    value: JSON.stringify({ sessionId: "ses_9", question: "阿司匹林一级预防还值得做吗" }),
    summary: "阿司匹林一级预防还值得做吗", origin: "system", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });

  const profile = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  assert.equal(profile.conversations.ses_9, "阿司匹林一级预防还值得做吗", "what the row says as 「来自 …《…》」");
  assert.deepEqual(profile.usage, {}, "a memory nothing has used has no usage row, and says so as an absence");

  const found = (await (await fetch(`${base}/api/memory/search?q=${encodeURIComponent("阿司匹林")}`, { headers })).json()).data;
  assert.deepEqual(found.items.map((item) => item.key), ["profile.who"],
    "a memory is found by the conversation it came out of; the run summary that names it is not a row (audit 2026-09-26, M-4)");
  assert.equal(found.query, "阿司匹林");

  // A memory handed to a run is counted, which is 「用过 N 次，上次 …」.
  const recalled = await app.memorySubstrate.recall(user.id, "临床药师 抗凝", { projectId: "default" });
  assert.ok(recalled.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const counted = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  const [usage] = Object.values(counted.usage);
  assert.equal(usage?.count, 1);
  assert.ok(usage?.lastUsedAt);
});

test("a pending inference is confirmed by the researcher, and a raced edit is refused", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const pending = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "response.evidence_depth",
    value: "Prefer primary evidence and explicit uncertainty.",
    summary: "Primary evidence first; uncertainty must remain visible.",
    origin: "inferred", status: "pending", confidence: 0.7, importance: 0.9, sensitive: false,
  }, {
    sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1",
    quote: "优先给原始证据，并明确保留不确定性。", observedAt: new Date().toISOString(), weight: 1,
  });

  const profile = (await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data;
  assert.equal(profile.pendingCount, 1);
  assert.equal(profile.groups.preference[0].id, pending.id);

  const confirmed = (await (await fetch(`${base}/api/memory/records/${pending.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: pending.version, status: "active" }),
  })).json()).data;
  // Confirming an inference is the researcher taking ownership of it: the origin
  // stops being the product's guess and the confidence stops being a score.
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.origin, "explicit");
  assert.equal(confirmed.confidence, 1);
  assert.equal(confirmed.version, pending.version + 1);

  const stale = await fetch(`${base}/api/memory/records/${pending.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ expectedVersion: pending.version, value: "something else" }),
  });
  assert.equal(stale.status, 409, "an edit against the version that was already replaced must not win");
  assert.equal((await stale.json()).code, "memory_conflict");

  const filtered = (await (await fetch(`${base}/api/memory/records?status=active&kind=preference`, { headers })).json()).data;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].evidence.length, 1, "the quote the inference was drawn from travels with it");

  assert.equal((await fetch(`${base}/api/memory/records/${pending.id}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await (await fetch(`${base}/api/memory/profile`, { headers })).json()).data.records.length, 0);
});

test("the researcher's switches pause learning and recall without deleting, and a reset deletes without touching them", options, async (t) => {
  // 2026-09-16 review, M4④: pause vs reset, and a project of its own.
  const { app, base, headers, user } = await fixture(t);
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

  const record = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "response.language",
    value: "Answer in Chinese.", summary: "Chinese answers.", origin: "explicit", status: "active",
    confidence: 1, importance: 0.9, sensitive: false,
  }, { sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1", quote: "请用中文回答。", observedAt: new Date().toISOString(), weight: 1 });
  assert.ok(record.id);

  // Paused for this project: nothing recalled here, even for a matching query.
  assert.deepEqual(await app.memorySubstrate.recall(user.id, "Chinese answers language", { projectId: "default" }), []);
  await put({ pausedProjects: [] });
  const recalled = await app.memorySubstrate.recall(user.id, "Chinese answers language", { projectId: "default" });
  assert.ok(recalled.length > 0, "with the project unpaused the same query recalls the record");
  await put({ recallPaused: true });
  assert.deepEqual(await app.memorySubstrate.recall(user.id, "Chinese answers language", { projectId: "default" }), [],
    "paused recall holds for every project");

  const unconfirmed = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).code, "memory_reset_confirmation_required");
  assert.equal((await app.researchMemory.listAllRecords(user.id)).length, 1, "a refused reset deletes nothing");

  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).data, { structured: 1, methods: 0, handbooks: 0, entries: 0 });
  assert.equal((await app.researchMemory.listAllRecords(user.id)).length, 0);
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
    await app.researchMemory.upsertRecord(owner, { scope: "user", scopeId: "", kind: "preference", key: "response.language", value: "Answer in Chinese.", summary: "Chinese answers.",
      origin: "explicit", status: "active", confidence: 1, importance: 0.9, sensitive: false },
    { sourceType: "conversation_message", sourceRef: "sessions/s1/messages/m1", quote: "请用中文回答。", observedAt: new Date().toISOString(), weight: 1 });
    return { method, note, document, shared, received };
  };
  const mine = await seed(user.id);
  const theirs = await seed(other.id);

  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  const resetBody = await reset.json();
  assert.equal(reset.status, 200, JSON.stringify(resetBody));
  assert.deepEqual(resetBody.data, { structured: 1, methods: 1, handbooks: 1, entries: 2 },
    "the memory, the method, the handbook and both own notes (in force and forgotten); the waiting lesson goes without being counted as one");

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
  assert.deepEqual((await again.json()).data, { structured: 0, methods: 0, handbooks: 0, entries: 0 });
  // The fixture's own cleanup closes the pool, so the second account is removed here, while it is open.
  await app.store.database.query("DELETE FROM evimed_control.users WHERE id=$1", [other.id]);
});

test("the page's new reads answer through the real app: handbooks to read and stop, what was learned when, a method's sources, the notes the researcher forgot", options, async (t) => {
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

  const learned = await read("/api/memory/learned?timeZone=Asia/Shanghai");
  assert.deepEqual(learned.days.flatMap((entry) => entry.items.map((item) => [item.kind, item.what, item.title])), [["learned", "method", "引用标记对齐"]],
    "the stopped handbook is not in the story, and no memory was written so the capsule has not begun");
  assert.deepEqual((await read(`/api/methods/${encodeURIComponent(method.id)}/sources`)).items, []);
  const mine = await read("/api/capsules/mine");
  assert.deepEqual([mine.entries.length, mine.forgotten.map((entry) => entry.payload.content)], [0, ["旧偏好"]]);
});

test("deleting a project deletes its memory and leaves personal memory alone", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const projectId = "project-memory-delete";
  assert.equal((await fetch(`${base}/api/projects`, {
    method: "POST", headers, body: JSON.stringify({ id: projectId, name: "Project memory deletion" }),
  })).status, 200);

  await app.researchMemory.upsertRecord(user.id, {
    scope: "project", scopeId: projectId, kind: "run_summary", key: "run.project-delete",
    value: "project run", summary: "project run", origin: "system", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });

  assert.equal((await fetch(`${base}/api/projects/${projectId}`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: projectId }),
  })).status, 200);

  const exported = await app.researchMemory.exportUserMemory(user.id);
  assert.deepEqual(exported.records.map((record) => record.key), ["tone"],
    "the project's memory went with it and the account's did not");
});

test("deleting an account takes every memory with it, counted for the audit", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "tables over prose", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });

  const deleted = await fetch(`${base}/api/account`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: user.id, password: "test-only-memory-password" }),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  const rows = await app.store.database.query(
    `SELECT (SELECT count(*)::integer FROM evimed_memory.records WHERE user_id=$1) AS records,
            (SELECT count(*)::integer FROM evimed_memory.record_usage WHERE user_id=$1) AS usage,
            (SELECT count(*)::integer FROM evimed_memory.sessions WHERE user_id=$1) AS sessions`, [user.id]);
  assert.deepEqual(rows.rows[0], { records: 0, usage: 0, sessions: 0 });
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

test("deleting a project never waits on the index: the rows go, the withdrawal is owed and lands when the index answers", options, async (t) => {
  const index = slowIndex();
  const { app, base, headers, user } = await fixture(t, { memoryIndexProvider: "openviking", openVikingClient: index, operatorMetricsToken: "metrics-secret" });
  const projectId = "project-index-slow";
  assert.equal((await fetch(`${base}/api/projects`, {
    method: "POST", headers, body: JSON.stringify({ id: projectId, name: "Index slow" }),
  })).status, 200);
  const written = await app.researchMemory.upsertRecord(user.id, {
    scope: "project", scopeId: projectId, kind: "run_summary", key: "run.index-slow",
    value: "project run", summary: "project run", origin: "system", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });

  const deleted = await fetch(`${base}/api/projects/${projectId}`, {
    method: "DELETE", headers, body: JSON.stringify({ confirm: projectId }),
  });
  assert.equal(deleted.status, 200, "a timing-out index is not a reason to refuse a deletion");

  assert.deepEqual((await app.researchMemory.exportUserMemory(user.id)).records, [], "the authoritative rows are gone");
  assert.equal((await (await fetch(`${base}/api/projects`, { headers })).json()).data
    .filter((/** @type {any} */ project) => project.id === projectId).length, 0, "and so is the project");

  // Nothing is recallable in between: a recall hit is re-read from PostgreSQL, and the row is gone.
  const db = app.store.database;
  const owed = await db.query("SELECT uri, attempts FROM evimed_memory.index_withdrawals WHERE user_id=$1", [user.id]);
  assert.equal(owed.rowCount, 1, "the withdrawal of the subtree is owed");
  assert.match(owed.rows[0].uri, /\/memories\/evimed\/project\//);
  await assert.rejects(() => app.researchMemory.getRecord(user.id, written.id), (error) => error.code === "memory_not_found");

  // The operator sees what the index still owes and for how long.
  const metrics = await (await fetch(`${base}/api/ops/metrics`, { headers: { authorization: "Bearer metrics-secret" } })).text();
  assert.match(metrics, /^open_science_memory_index_withdrawals_pending [1-9]\d*$/m);
  assert.match(metrics, /^open_science_memory_index_withdrawals_oldest_seconds \d+$/m);
  assert.match(metrics, /^open_science_memory_index_withdrawals_most_attempts \d+$/m);

  // The index recovers; the worker's pass tells it, and the debt is gone.
  index.down = false;
  await db.query("UPDATE evimed_memory.index_withdrawals SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [user.id]);
  await app.memoryIndexWorker.drainWithdrawals();
  assert.equal((await db.query("SELECT 1 FROM evimed_memory.index_withdrawals WHERE user_id=$1", [user.id])).rowCount, 0);
  assert.ok(index.asked.some((call) => call.uri === owed.rows[0].uri && call.recursive));
});

test("resetting memory never waits on the index either, and the three research subtrees are owed to it", options, async (t) => {
  const index = slowIndex();
  const { app, base, headers, user } = await fixture(t, { memoryIndexProvider: "openviking", openVikingClient: index });
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  const reset = await fetch(`${base}/api/memory/reset`, { method: "POST", headers, body: JSON.stringify({ confirm: "reset" }) });
  assert.equal(reset.status, 200, await reset.text());
  assert.deepEqual((await app.researchMemory.exportUserMemory(user.id)).records, []);
  const owed = await app.store.database.query("SELECT uri FROM evimed_memory.index_withdrawals WHERE user_id=$1 ORDER BY uri", [user.id]);
  assert.deepEqual(owed.rows.map((row) => row.uri.split("/memories/evimed/")[1]), ["project", "session", "user"]);
});

test("erasing an account never waits on the index: the account goes and its copies are owed, past the account's own end", options, async (t) => {
  const index = slowIndex();
  const { app, base, headers, user } = await fixture(t, { memoryIndexProvider: "openviking", openVikingClient: index });
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
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

// The composition root is where the outbox is handed over, and a store built
// without the queue enqueues nothing and says nothing. Asserting it through the
// real app is the only place that proves the wire exists: every unit test here
// builds the store itself and would keep passing over a server that never
// passed the queue at all.
test("the app on the index provider hands its store the outbox, and a write uses it", options, async (t) => {
  const { app, user } = await fixture(t, {
    memoryIndexProvider: "openviking",
    openVikingClient: {
      configured: true,
      async status() { return { configured: true, connected: true, code: null }; },
      async find() { return []; },
      async write() { return { ok: true }; },
      async list() { return []; },
      async listAll() { return []; },
      async remove() { return true; },
    },
  });
  // Through the app's own store instance, which is the object under test: a
  // record is written by the product, not posted by the researcher.
  const written = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });

  const jobs = await app.store.database.query(`SELECT payload FROM evimed_product.jobs
    WHERE user_id=$1 AND kind='memory-record-index'`, [user.id]);
  assert.equal(jobs.rowCount, 1, "a memory written through the app must reach the index's queue");
  assert.equal(jobs.rows[0].payload.recordId, written.id);
});

test("a deployment on the term matcher writes the same memory and queues nothing", options, async (t) => {
  const { app, user } = await fixture(t);
  await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "tone",
    value: "Tables, not prose.", summary: "", origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false,
  });
  const jobs = await app.store.database.query(`SELECT 1 FROM evimed_product.jobs
    WHERE user_id=$1 AND kind='memory-record-index'`, [user.id]);
  assert.equal(jobs.rowCount, 0, "a queue nothing claims must not be filled");
});

test("one click undoes an automatic write: an edit goes back, a creation goes away and stays away from inference", options, async (t) => {
  // Owner ruling 2026-09-19: memory changes by itself and asks nobody first,
  // so every change has to be reversible in one step, and an undone memory
  // must not be written straight back by the next run's inference.
  const { app, base, headers, user } = await fixture(t);
  const evidence = (quote) => ({ sourceType: "conversation_message", sourceRef: "sessions/s-undo/messages/m1", quote, observedAt: new Date().toISOString(), weight: 1 });
  const created = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "preference", key: "preference.table_first",
    value: "证据先用表格呈现", summary: "表格优先", origin: "inferred", status: "active", confidence: 0.6, importance: 0.7, sensitive: false,
  }, evidence("先用表格"), { reason: "conversation evidence created the memory", by: "extraction", runId: "run_a" });
  const changed = await app.researchMemory.upsertRecord(user.id, { ...created, value: "证据先用文字叙述", summary: "叙述优先" },
    evidence("先用文字"), { expectedVersion: created.version, reason: "conversation evidence updated the current memory", by: "extraction", runId: "run_b" });
  assert.deepEqual([changed.revisions.at(-1).by, changed.revisions.at(-1).runId], ["extraction", "run_b"], "a revision says who changed it, in which run");

  // The write prompt lists it, for this conversation and since a moment.
  const since = new Date(Date.parse(created.createdAt) - 1_000).toISOString();
  const changes = (await (await fetch(`${base}/api/memory/changes?since=${encodeURIComponent(since)}&sessionId=s-undo`, { headers })).json()).data;
  assert.deepEqual(changes.map((item) => [item.id, item.change, item.version]), [[created.id, "updated", changed.version]]);
  assert.deepEqual((await (await fetch(`${base}/api/memory/changes?since=${encodeURIComponent(since)}&sessionId=elsewhere`, { headers })).json()).data, []);

  const undone = await fetch(`${base}/api/memory/records/${created.id}/undo`, {
    method: "POST", headers, body: JSON.stringify({ expectedVersion: changed.version }),
  });
  assert.equal(undone.status, 200);
  const restored = (await undone.json()).data;
  assert.equal(restored.undone, "restored");
  assert.equal(restored.record.value, "证据先用表格呈现");
  assert.match(restored.record.revisions.at(-1).reason, /^undone: conversation evidence updated/);
  assert.equal(restored.record.revisions.at(-1).by, "user");
  const stale = await fetch(`${base}/api/memory/records/${created.id}/undo`, {
    method: "POST", headers, body: JSON.stringify({ expectedVersion: changed.version }),
  });
  assert.equal(stale.status, 409, "an undo of a version already moved on is refused");

  // A memory whose only history is its creation: undoing it removes it, and
  // the removal is the researcher rejecting it.
  const fresh = await app.researchMemory.upsertRecord(user.id, {
    scope: "user", scopeId: "", kind: "behavior", key: "behavior.late_night",
    value: "常在深夜工作", summary: "深夜工作", origin: "inferred", status: "active", confidence: 0.6, importance: 0.3, sensitive: false,
  }, evidence("又是深夜"), { reason: "conversation evidence created the memory", by: "extraction" });
  const removed = (await (await fetch(`${base}/api/memory/records/${fresh.id}/undo`, {
    method: "POST", headers, body: JSON.stringify({ expectedVersion: fresh.version }),
  })).json()).data;
  assert.equal(removed.undone, "removed");
  await assert.rejects(app.researchMemory.getRecord(user.id, fresh.id), { code: "memory_not_found" });
  const rejections = await app.feedbackEvents.list(user.id, { trigger: "memory-rejected" });
  assert.deepEqual(rejections.items.map((item) => [item.detail.key, item.detail.reason]), [["behavior.late_night", "undone"]],
    "the extractor reads this ledger and will not infer it back");
});

test("undoing a replacement puts the fact it replaced back in force", options, async (t) => {
  const { app, base, headers, user } = await fixture(t);
  const project = (await app.store.listProjects(user))[0];
  const fact = (key, value) => ({
    scope: "project", scopeId: project.id, kind: "project_fact", key, value, summary: value,
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false,
  });
  const old = await app.researchMemory.upsertRecord(user.id, fact("project.dose.old", "利伐沙班 20 mg"));
  const { record } = await app.researchMemory.supersede(user.id, old.id, fact("project.dose.new", "利伐沙班 15 mg"), null,
    { reason: "conversation evidence replaced an earlier fact", by: "extraction" });
  const undone = (await (await fetch(`${base}/api/memory/records/${record.id}/undo`, {
    method: "POST", headers, body: JSON.stringify({ expectedVersion: record.version }),
  })).json()).data;
  assert.equal(undone.undone, "removed");
  assert.deepEqual(undone.restored.map((item) => [item.id, item.status, item.supersededBy, item.invalidSince]),
    [[old.id, "active", null, null]]);
  assert.match(undone.restored[0].revisions.at(-1).reason, /^back in force: project\.dose\.new/);
});
