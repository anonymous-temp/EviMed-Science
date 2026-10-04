// A source change reaching memories, methods and result versions against the real stores (N15).
//
// What the unit tests cannot say: the dependents of a calculation and the versions that read a document are jsonb
// containment lookups on the real result ledger; the memory links are rows moved by one conditional statement; a method's
// label is a telemetry write that leaves its history, status and body as they were. These run the real
// `ProductDocuments`, `ResearchMemoryStore` and `LearningService` under the real impact service.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { METHOD_SKILL_SCHEMA, parseSkillFrontmatter } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { AutopilotService } from "../src/autopilotService.mjs";
import { KnowledgeChangeService, producingAgenda } from "../src/knowledgeChange.mjs";
import { LearningService } from "../src/learningService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { ResultImpactService } from "../src/resultImpact.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const hex = (character, length = 64) => character.repeat(length);
const rv = (n) => `rv_${String(n).padStart(64, "0")}`;
const SRC_OLD = `src_${hex("a", 32)}`;
const SRC_NEW = `src_${hex("b", 32)}`;
const BYTES_OLD = hex("c");
const DOI = "10.9999/knowledge.change";
/** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let memory; /** @type {any} */ let learning;
const owners = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateProductStore(database);
  documents = new ProductDocuments(database);
  memory = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
  learning = new LearningService({ documents, resolveBaselineDigest: async () => `sha256:${hex("c")}` });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [owners]);
  await database.close();
});

const skill = [
  "---", 'name: "recount-pooled-studies"', 'description: "Recount the studies behind a pooled estimate against the evidence matrix before printing it."',
  'whenToUse: "When a report prints a pooled effect estimate from several studies."', "metadata:", '  role: "functional"',
  '  applies_when: "A pooled estimate is printed."', '  not_when: "The estimate is a single trial\'s own result."', '  derived_from: "run:run-1"', `  evimed_schema: "${METHOD_SKILL_SCHEMA}"`, "---", "",
  ["## Purpose", "Keep the pool in step.", "", "## When to Use", "When a pool is printed.", "", "## Inputs", "The matrix.", "", "## Workflow", "1. Count the studies.", "",
    "## Verification", "- Counted.", "", "## Constraints", "- Never print a pool of one study.", "", "## Output", "The report."].join("\n"), "",
].join("\n");

const source = (id, extra = {}) => ({ kind: "source", id, digest: hex("1"), versionId: null, availability: "captured", ...extra });
const binding = (calculationId, key, printed) => ({ basis: "matched", printed, calculation: { versionId: calculationId, key, value: 1, unit: null } });

/** A project's result ledger as the real documents hold it: one calculation, the report bound to it, a report that read a
 * knowledge-base document by its bytes, and two versions that rest on nothing the tests change. */
async function setup({ runId = null } = {}) {
  const owner = `knowledge_change_${randomUUID()}`; owners.push(owner);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Knowledge change test','development')", [owner]);
  const project = `prj_${randomUUID().slice(0, 8)}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Knowledge change',1048576)", [owner, project]);
  const put = (versionId, payload) => documents.put(owner, "result-version", versionId, { recordType: "result-version", versionId, projectId: project, digest: hex("9"),
    machineValues: [], bindings: { items: [] }, findings: [], inputs: [], bindingSources: [], capturedAt: "2026-10-04T00:00:00Z", ...payload },
  { expectedRevision: 0, projectId: project });
  const producer = runId ? { producer: { kind: "tool", runId } } : {};
  await put(rv(1), { ...producer, path: "results/pool.json", inputs: [source(DOI)], machineValues: [{ key: "pooled", value: 0.71 }], hasMachineValues: true });
  const items = [binding(rv(1), "pooled", "0.71"), binding(rv(1), "ci.low", "0.5")];
  await put(rv(2), { ...producer, path: "report.md", bindings: { items }, bindingSources: [rv(1)] });
  await put(rv(3), { path: "kb-report.md", inputs: [{ kind: "data", id: "knowledge-base/trial.xlsx", path: "knowledge-base/trial.xlsx", digest: BYTES_OLD, versionId: null, availability: "captured" }] });
  await put(rv(4), { path: "results/other.json", inputs: [source("10.9999/other")], machineValues: [{ key: "x", value: 2 }], hasMachineValues: true });
  await put(rv(5), { path: "other-report.md", bindings: { items: [binding(rv(4), "x", "2")] }, bindingSources: [rv(4)] });
  // The projection the impact service reads, as `ResultProvenanceService` serves it: every row of this project, by the same filters.
  const results = {
    async scope(userId, projectId) { assert.equal(userId, owner); assert.equal(projectId, project); return { userId: owner, id: project }; },
    async list(_user, { projectId, limit = 50, cursor = null }) {
      const page = await documents.list(owner, "result-version", { projectId, limit, cursor, filter: { recordType: "result-version" } });
      return { items: page.items.map(row => row.payload), nextCursor: page.nextCursor };
    },
    async query(_user, projectId, filter, { limit = 50, cursor = null } = {}) {
      const page = await documents.list(owner, "result-version", { projectId, limit, cursor, filter: { recordType: "result-version", ...filter } });
      return { items: page.items.map(row => row.payload), nextCursor: page.nextCursor };
    },
    async get(_user, projectId, versionId) {
      const row = await documents.get(owner, "result-version", versionId);
      if (!row || row.projectId !== projectId) throw Object.assign(new Error("Unavailable"), { status: 404, code: "result_version_unavailable" });
      return row.payload;
    },
  };
  const parsed = parseSkillFrontmatter(skill);
  const method = await learning.createCandidate(owner, { frontmatter: parsed.frontmatter, body: parsed.body,
    provenance: { origin: "inferred", runId: "run-1", results: [{ role: "original", versionId: rv(1), digest: hex("9") }, { role: "successor", versionId: rv(9), digest: hex("8") }] } });
  const notices = [];
  const knowledge = new KnowledgeChangeService({ memory, methods: learning });
  const impacts = new ResultImpactService({ documents, results, knowledge, now: () => new Date("2026-10-04T12:00:00Z"),
    notifications: { async create(_user, input) { notices.push(input); } } });
  const fact = (key, links) => memory.upsertRecord(owner, { scope: "project", scopeId: project, kind: "project_fact", key, value: `${key} finding`, summary: key,
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false }, null, { sourceLinks: links });
  return { owner, project, impacts, notices, method, fact, documents };
}
const correction = (kind = "correction") => ({ state: "changed", checkedAt: "2026-10-04T00:00:00Z", updates: [{ kind, noticeDoi: "10.9999/notice", date: "2026-10-01", source: "publisher" }] });
const linkStates = async (f, recordId) => (await memory.sourceLinks(f.owner, recordId)).map(link => [link.type, link.state, link.stateReason]);

test("Postgres: a correction labels the memory and the method, finds the report through its calculation and nothing else, and moves no version", options, async () => {
  const f = await setup();
  const resting = await f.fact("project.pooled", [{ type: "doi", id: DOI }]);
  const independent = await f.fact("project.independent", [{ type: "doi", id: "10.9999/unrelated" }]);
  const historyBefore = (await f.documents.history(f.owner, "method", f.method.id, { limit: 20 })).length;
  const before = await learning.getMethod(f.owner, f.method.id);

  const reply = await f.impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction() });
  assert.deepEqual(reply.items.map(item => item.payload.versionId).sort(), [rv(1), rv(2)], "the calculation and the report bound to it; not the others");
  const report = reply.items.find(item => item.payload.versionId === rv(2)).payload;
  assert.equal(report.affected.via, "calculation");
  assert.deepEqual(report.affected.calculations.items.map(item => [item.versionId, item.boundValues]), [[rv(1), 2]]);
  assert.deepEqual(reply.items.find(item => item.payload.versionId === rv(1)).payload.affected.dependents.items.map(item => item.versionId), [rv(2)]);

  assert.deepEqual(await linkStates(f, resting.id), [["doi", "changed", "correction"]]);
  assert.deepEqual(await linkStates(f, independent.id), [["doi", "current", ""]], "a memory that rests on another source is not touched");
  assert.deepEqual(report.affected.memories.items.map(item => [item.recordId, item.state]), [[resting.id, "changed"]]);

  const after = await learning.getMethod(f.owner, f.method.id);
  assert.equal(after.payload.sourceChanges.length, 1, "the method learnt from the calculation carries one label, and so does the report's lookup of it");
  assert.deepEqual([after.payload.sourceChanges[0].state, after.payload.sourceChanges[0].relation, after.payload.sourceChanges[0].versionId], ["changed", "learnt_from", rv(1)]);
  assert.equal(after.payload.contentDigest, before.payload.contentDigest);
  assert.equal(after.payload.status, before.payload.status);
  assert.equal((await f.documents.history(f.owner, "method", f.method.id, { limit: 20 })).length, historyBefore, "a label is not a revision of the method");
  assert.equal(JSON.stringify(after.payload.scientific ?? null), JSON.stringify(before.payload.scientific ?? null), "and it is not scientific evidence against it");

  // The same change again is the same impacts and the same label.
  const again = await f.impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction() });
  assert.deepEqual(again.items.map(item => item.id).sort(), reply.items.map(item => item.id).sort());
  assert.equal((await learning.getMethod(f.owner, f.method.id)).payload.sourceChanges.length, 1);
});

test("Postgres: a retraction outranks a correction, an unanswered check lowers neither, and a clean answer clears only an unknown", options, async () => {
  const f = await setup();
  const resting = await f.fact("project.pooled", [{ type: "doi", id: DOI }]);
  const status = (state, extra = {}) => ({ state, checkedAt: "2026-10-04T00:00:00Z", updates: [], ...extra });
  const check = status_ => f.impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: status_ });
  await check(status("unavailable", { reason: "timeout" }));
  assert.deepEqual(await linkStates(f, resting.id), [["doi", "unknown", "check_timeout"]], "a check that could not answer is recorded as unknown");
  await check(status("no_update"));
  assert.deepEqual(await linkStates(f, resting.id), [["doi", "current", "no_update"]], "a clean answer sets right the unknown");
  await check(correction());
  assert.equal((await linkStates(f, resting.id))[0][1], "changed");
  await check(status("unavailable", { reason: "timeout" }));
  await check(status("no_update"));
  assert.equal((await linkStates(f, resting.id))[0][1], "changed", "neither an outage nor a clean answer undoes a correction");
  await check(correction("retraction"));
  assert.deepEqual(await linkStates(f, resting.id), [["doi", "retracted", "retraction"]]);
  await check(correction());
  assert.equal((await linkStates(f, resting.id))[0][1], "retracted", "a later correction notice does not lower a retraction");
  const methodLabels = (await learning.getMethod(f.owner, f.method.id)).payload.sourceChanges;
  assert.deepEqual(methodLabels.map(label => label.state).sort(), ["changed", "retracted"], "one label per state the source was found in");
});

test("Postgres: a replaced knowledge-base file finds what read its bytes and the memories that name its id, and a different file nothing", options, async () => {
  const f = await setup();
  const memoryRow = await f.fact("project.kb", [{ type: "knowledge_source", id: SRC_OLD, version: `sha256:${BYTES_OLD}` }]);
  const reply = await f.impacts.reconcileReplacement(f.owner, { projectId: f.project, replaced: { sourceId: SRC_OLD, sha256: BYTES_OLD }, by: { sourceId: SRC_NEW, at: "2026-10-04T10:00:00Z" } });
  assert.deepEqual(reply.items.map(item => item.payload.versionId), [rv(3)], "the version that recorded the file's digest as its input");
  assert.equal(reply.items[0].payload.source.replacedBy, SRC_NEW);
  assert.equal(reply.items[0].payload.sourceStatus.updates[0].kind, "replaced");
  assert.deepEqual(await linkStates(f, memoryRow.id), [["knowledge_source", "changed", "replaced"]]);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].body, /资料库里这份文件有了新版本/);
  const other = await f.impacts.reconcileReplacement(f.owner, { projectId: f.project, replaced: { sourceId: `src_${hex("e", 32)}`, sha256: hex("e") } });
  assert.deepEqual(other.items, []);
  assert.equal((await learning.getMethod(f.owner, f.method.id)).payload.sourceChanges, undefined, "no method is linked to the version that read the file");
});

test("Postgres: the memory lookup is one account's, and a failed one is unknown while the impacts are still recorded", options, async () => {
  const f = await setup();
  const other = `knowledge_change_${randomUUID()}`; owners.push(other);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Other account','development')", [other]);
  await memory.upsertRecord(other, { scope: "user", scopeId: null, kind: "preference", key: "preference.other", value: "someone else's", summary: "someone else's", origin: "explicit",
    status: "active", confidence: 1, importance: 0.5, sensitive: false }, null, { sourceLinks: [{ type: "doi", id: DOI }] });
  const reply = await f.impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction() });
  assert.equal(reply.items[0].payload.affected.memories.status, "none", "another account's link is not this account's dependent");
  assert.equal((await memory.dependentsOfSource(other, { type: "doi", id: DOI }))[0].state, "current", "and it was not labelled");
  const broken = new ResultImpactService({ documents: f.documents, results: f.impacts.results, now: () => new Date("2026-10-04T12:00:00Z"),
    knowledge: new KnowledgeChangeService({ memory: { configured: true, async dependentsOfSource() { throw new Error("memory store down"); } }, methods: learning }) });
  const degraded = await broken.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction("retraction") });
  assert.equal(degraded.items.length, 2);
  assert.equal(degraded.items[0].payload.affected.memories.status, "unknown");
});

test("Postgres: the running agenda whose episode produced a result rechecks only what rests on the source; a paused or not started one starts nothing", options, async () => {
  const f = await setup({ runId: "run-origin" });
  const jobs = new ProductJobs(database);
  let impacts;
  const autopilot = new AutopilotService({ documents, jobs, authorizeContinuation: (...args) => impacts.assertContinuation(...args) });
  const created = await autopilot.create(f.owner, { projectId: f.project, title: "Pooled effect upkeep", topics: ["pooled effect"], taskTypes: ["evidence-update"],
    dailyBudgetCny: 20, weeklyBudgetCny: 80, maxEpisodeCny: 8, timeZone: "UTC", scheduleHour: 1 });
  const origin = async () => {
    const started = await autopilot.start(f.owner, created.id, { expectedRevision: (await autopilot.get(f.owner, created.id)).revision });
    const { episode } = await autopilot.schedule(f.owner, started.id, { trigger: "manual", requestId: `origin-${randomUUID()}` });
    await autopilot.markEpisodeDispatched(f.owner, episode.id, { runId: "run-origin", sessionId: "session-origin" });
    return started;
  };
  const results = f.impacts.results;
  impacts = new ResultImpactService({ documents, results, autopilot, knowledge: new KnowledgeChangeService({ memory, methods: learning }),
    authorizeContinuation: producingAgenda({ results, autopilot }), now: () => new Date("2026-10-04T12:00:00Z") });

  // Not started: the agenda exists and has produced nothing yet, so no standing authorization exists.
  const notStarted = await impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction() });
  assert.equal(notStarted.items.length, 2);
  assert.ok(notStarted.items.every(item => item.payload.continuation.status === "awaiting_user"));
  const queued = async () => (await documents.list(f.owner, "episode", { projectId: f.project })).items.filter(row => row.payload.continuationBinding);
  assert.equal((await queued()).length, 0);

  // Running: the agenda whose episode produced the result is the authorization, and nothing asks again.
  const running = await origin();
  await impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction() });
  const scheduled = (await impacts.list(f.owner, { projectId: f.project })).items;
  assert.ok(scheduled.every(item => item.payload.continuation.status === "scheduled" && item.payload.continuation.agendaId === running.id), "both affected versions continue in the agenda that produced them");
  const episodes = await queued();
  assert.equal(episodes.length, 2);
  for (const episode of episodes) {
    const note = episode.payload.followUpNote;
    assert.match(note, new RegExp(rv(1)), "the calculation that rests on the source is named");
    assert.doesNotMatch(note, new RegExp(`${rv(3)}|${rv(4)}|${rv(5)}`), "no unaffected version is named");
    assert.match(note, /does not by itself show the result's conclusion is wrong/);
    assert.match(note, /leave every other result, calculation, memory and method as it is/);
  }
  // The versions nothing rests on were not touched.
  assert.equal((await documents.list(f.owner, "result-impact", { projectId: f.project })).items.length, 2);

  // Paused afterwards: a later change of the same kind starts nothing, and the researcher's own choice is still open.
  const current = await autopilot.get(f.owner, running.id);
  const paused = await documents.put(f.owner, "agenda", running.id, { ...current.payload, enabled: false, status: "paused", pauseReason: "Paused by the researcher." },
    { expectedRevision: current.revision, projectId: f.project });
  assert.equal(paused.payload.status, "paused");
  const before = (await queued()).length;
  const later = await impacts.reconcileSourceUpdate(f.owner, { projectId: f.project, source: { id: DOI, doi: DOI }, status: correction("retraction") });
  assert.equal(later.items.length, 2);
  assert.ok(later.items.every(item => item.payload.continuation.status === "awaiting_user"));
  assert.equal((await queued()).length, before);
});
