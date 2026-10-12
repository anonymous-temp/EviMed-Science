// What rests on a knowledge-base document, read against the real stores (knowledge base P0, 「相关记忆与做法」).
//
// What the unit tests cannot say: the memories are found by their `record_sources` row, the results by jsonb containment on
// the result ledger, the methods by the version their record names — all under the account that holds the document and in
// its project, and a sentence from another account or another project never appears.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { METHOD_SKILL_SCHEMA, parseSkillFrontmatter } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { KnowledgeChangeService } from "../src/knowledgeChange.mjs";
import { LearningService } from "../src/learningService.mjs";
import { migrateProductStore } from "../src/productPersistence.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";
import { createSourceDependents } from "../src/sourceDependents.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const hex = (character, length = 64) => character.repeat(length);
const rv = (n) => `rv_${String(n).padStart(64, "0")}`;
const SOURCE = `src_${hex("a", 32)}`;
const BYTES = hex("c");
/** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let memory; /** @type {any} */ let learning;
const owners = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 6, databaseConnectionTimeoutMs: 5_000 });
  await migrateProductStore(database);
  documents = new ProductDocuments(database);
  memory = new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database });
  learning = new LearningService({ documents });
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

async function account() {
  const id = `source_dependents_${randomUUID()}`; owners.push(id);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Source dependents test','development')", [id]);
  const project = async (name) => {
    const projectId = `prj_${randomUUID().slice(0, 8)}`;
    await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,$3,1048576)", [id, projectId, name]);
    return projectId;
  };
  return { id, project };
}

test("Postgres: a document's page lists the memories, results and methods that name it, in its project and under its account", options, async () => {
  const owner = await account();
  const project = await owner.project("Dependents");
  const elsewhere = await owner.project("Another project");
  const stranger = await account();
  const strangerProject = await stranger.project("Stranger's");

  const result = (id, projectId, payload) => documents.put(owner.id, "result-version", id, { recordType: "result-version", versionId: id, projectId, digest: hex("9"), machineValues: [],
    bindings: { items: [] }, findings: [], inputs: [], bindingSources: [], capturedAt: "2026-10-04T00:00:00Z", ...payload }, { expectedRevision: 0, projectId });
  const read = { kind: "data", id: "knowledge-base/trial.pdf", path: "knowledge-base/trial.pdf", digest: BYTES, versionId: null, availability: "captured" };
  // Read by its bytes, newest of two versions of one file in one run; read by its id; no run produced it; its run was deleted;
  // another project of the same account read the same bytes; and a report that read something else.
  await result(rv(1), project, { path: "deliverables/a/report.md", producer: { kind: "tool", runId: "run-1" }, inputs: [read], capturedAt: "2026-10-01T00:00:00Z" });
  await result(rv(2), project, { path: "deliverables/a/report.md", producer: { kind: "tool", runId: "run-1" }, inputs: [read], capturedAt: "2026-10-02T00:00:00Z" });
  await result(rv(3), project, { path: "deliverables/b/summary.md", producer: { kind: "tool", runId: "run-2" }, inputs: [{ kind: "source", id: SOURCE, digest: hex("1"), versionId: null, availability: "captured" }], capturedAt: "2026-10-03T00:00:00Z" });
  await result(rv(4), project, { path: "notes.md", inputs: [read] });
  await result(rv(5), project, { path: "deliverables/c/gone.md", producer: { kind: "tool", runId: "run-gone" }, inputs: [read] });
  await result(rv(6), elsewhere, { path: "deliverables/d/other-project.md", producer: { kind: "tool", runId: "run-9" }, inputs: [read] });
  await result(rv(7), project, { path: "deliverables/e/unrelated.md", producer: { kind: "tool", runId: "run-3" }, inputs: [{ kind: "data", id: "knowledge-base/else.pdf", digest: hex("d"), availability: "captured" }] });

  const fact = (userId, scope, scopeId, key, links, extra = {}) => memory.upsertRecord(userId, { scope, scopeId, kind: scope === "user" ? "preference" : "project_fact", key, value: `${key} 说明`, summary: `${key} 说明`,
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false, ...extra }, null, { sourceLinks: links });
  const link = [{ type: "knowledge_source", id: SOURCE }];
  const here = await fact(owner.id, "project", project, "project.population", link);
  const mine = await fact(owner.id, "user", "", "user.reading", link);
  await fact(owner.id, "project", elsewhere, "project.other", link);
  await fact(owner.id, "project", project, "project.sensitive", link, { sensitive: true });
  await fact(owner.id, "project", project, "project.unrelated", [{ type: "knowledge_source", id: `src_${hex("e", 32)}` }]);
  await fact(stranger.id, "project", strangerProject, "project.strangers", link);

  const parsed = parseSkillFrontmatter(skill);
  const method = await learning.createCandidate(owner.id, { frontmatter: parsed.frontmatter, body: parsed.body,
    provenance: { origin: "inferred", runId: "run-1", results: [{ role: "original", versionId: rv(2), digest: hex("9") }] } });

  // The fixture holds four memories of this account that name the document, so the three filters below are tested against rows.
  assert.equal((await memory.dependentsOfSource(owner.id, link[0])).length, 4);

  const reported = [];
  const dependents = createSourceDependents({
    knowledge: new KnowledgeChangeService({ memory, methods: learning }), documents, memory,
    runs: async (_project, runIds) => new Map(runIds.map((id) => [id, id === "run-gone" ? { title: null, deleted: true } : { title: id === "run-1" ? "房颤抗凝综述" : null, deleted: false }])),
    report: (code) => reported.push(code),
  });
  const source = { id: SOURCE, projectId: project, payload: { fingerprint: { sha256: BYTES } } };
  const listed = await dependents({ user: { id: owner.id }, project: { id: project }, source });

  assert.deepEqual(listed.memories.map((item) => [item.recordId, item.scope]).sort(), [[here.id, "project"], [mine.id, "user"]].sort(),
    "this project's memory and the account's own; not another project's, not a sensitive one, not another account's");
  assert.ok(listed.memories.every((item) => item.text.includes("说明")));
  assert.deepEqual(listed.results.map((item) => [item.versionId, item.runId, item.path, item.title]), [
    [rv(3), "run-2", "deliverables/b/summary.md", null],
    [rv(2), "run-1", "deliverables/a/report.md", "房颤抗凝综述"],
  ], "newest first, one line for the two versions of one file, none without a run, none of a deleted run, none of another project");
  assert.deepEqual(listed.methods.map((item) => item.id), [method.id], "the method linked to the version that rests on the document");
  assert.deepEqual(reported, []);

  // Another account asking for the same document finds nothing of the first's.
  const asked = await dependents({ user: { id: stranger.id }, project: { id: strangerProject }, source });
  assert.deepEqual(asked.results, []);
  assert.deepEqual(asked.methods, []);
  assert.deepEqual(asked.memories.map((item) => item.scope), ["project"], "only the stranger's own memory");
  assert.notEqual(asked.memories[0].recordId, here.id);
});

test("Postgres: a store that cannot be read costs its class and nothing else", options, async () => {
  const owner = await account();
  const project = await owner.project("Partial");
  await documents.put(owner.id, "result-version", rv(1), { recordType: "result-version", versionId: rv(1), projectId: project, digest: hex("9"), path: "deliverables/a/report.md",
    producer: { kind: "tool", runId: "run-1" }, inputs: [{ kind: "data", id: "knowledge-base/trial.pdf", digest: BYTES, availability: "captured" }], machineValues: [], findings: [],
    bindingSources: [], capturedAt: "2026-10-04T00:00:00Z" }, { expectedRevision: 0, projectId: project });
  const reported = [];
  const dependents = createSourceDependents({
    knowledge: new KnowledgeChangeService({ memory: { configured: true, async dependentsOfSource() { throw new Error("memory store down"); } }, methods: learning,
      report: (code) => reported.push(code) }),
    documents, memory, runs: async () => { throw new Error("ledger unreadable"); }, report: (code) => reported.push(code),
  });
  const listed = await dependents({ user: { id: owner.id }, project: { id: project }, source: { id: SOURCE, payload: { fingerprint: { sha256: BYTES } } } });
  assert.deepEqual(listed.memories, []);
  assert.deepEqual(listed.results.map((item) => item.path), ["deliverables/a/report.md"], "a result is listed untitled when the ledger cannot name its run");
  assert.equal(reported.length, 2);
});
