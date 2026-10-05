// A source change recorded by one detector reaching the modules that read it, against the real stores (plan 2026-10-05 B5):
// the frontier asserts a retraction, and a result that cites the DOI, a memory linked to it and the method learnt from that
// result are told and labelled — with no request to Crossref, because there is nobody to ask.
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
import { ResultImpactService } from "../src/resultImpact.mjs";
import { createSourceChanges, recordFrontierNotices } from "../src/sourceChanges.mjs";
import { createSourceUpdateLookup } from "../src/sourceUpdates.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const hex = (character, length = 64) => character.repeat(length);
const rv = (n) => `rv_${String(n).padStart(64, "0")}`;
const DOI = "10.9999/frontier.retracted";
/** @type {any} */ let database; /** @type {any} */ let documents; /** @type {any} */ let memory; /** @type {any} */ let learning;
const owners = [];

before(async () => {
  if (!url) return;
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 8, databaseConnectionTimeoutMs: 5_000 });
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
    "## Verification", "- Counted.", "", "## Constraints", "- Never print a pooled estimate of one study.", "", "## Output", "The report."].join("\n"), "",
].join("\n");

async function user(label) {
  const id = `${label}_${randomUUID()}`; owners.push(id);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,$2,'development')", [id, label]);
  return id;
}

/** One researcher's project: a result that cites the DOI, a memory that names it, and a method learnt from the result. */
async function researcher({ cites = true } = {}) {
  const owner = await user("source_change_reader");
  const project = `prj_${randomUUID().slice(0, 8)}`;
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Source change reader',1048576)", [owner, project]);
  await documents.put(owner, "result-version", rv(1), { recordType: "result-version", versionId: rv(1), projectId: project, digest: hex("9"), path: "report.md",
    machineValues: [], bindings: { items: [] }, findings: [], bindingSources: [], capturedAt: "2026-10-05T00:00:00Z",
    inputs: [{ kind: "source", id: cites ? DOI : "10.9999/another.work", digest: hex("1"), versionId: null, availability: "captured" }] },
  { expectedRevision: 0, projectId: project });
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
  const fact = await memory.upsertRecord(owner, { scope: "project", scopeId: project, kind: "project_fact", key: "project.pooled", value: "the pooled finding", summary: "pooled",
    origin: "explicit", status: "active", confidence: 1, importance: 0.7, sensitive: false }, null, { sourceLinks: [{ type: "doi", id: DOI }] });
  return { owner, project, results, method, fact };
}

/** The platform's record, and the services that read it, over a network that fails the test if anything is asked of it. */
async function platform(person, { withRecord = true } = {}) {
  const root = await user("source_change_platform");
  const sourceChanges = withRecord ? createSourceChanges({ documents, ownerUserId: root, now: () => new Date("2026-10-05T12:00:00Z") }) : null;
  const asked = [];
  const lookup = createSourceUpdateLookup({ userAgent: "test", changes: sourceChanges, now: () => Date.parse("2026-10-05T12:00:00Z"),
    fetchImpl: async (/** @type {URL} */ request) => { asked.push(String(request)); throw new Error("no network in this test"); } });
  sourceChanges?.useLookup(lookup);
  const notices = [];
  const knowledge = new KnowledgeChangeService({ memory, methods: learning, sourceChanges });
  const impacts = new ResultImpactService({ documents, results: person.results, knowledge, sourceChanges, now: () => new Date("2026-10-05T12:00:00Z"),
    notifications: { async create(_user, input) { notices.push(input); } } });
  return { sourceChanges, lookup, asked, notices, knowledge, impacts };
}

/** What the frontier pipeline writes when a retraction notice names the DOI. */
const frontierRetraction = (sourceChanges) => recordFrontierNotices(sourceChanges,
  [{ kind: "retraction", noticeDoi: "10.9999/retraction-notice", doi: DOI, date: "2026-10-01" }]);
const linkStates = async (person) => (await memory.sourceLinks(person.owner, person.fact.id)).map(link => [link.type, link.state, link.stateReason]);

test("Postgres: a retraction the frontier recorded reaches the result that cites it, the memory linked to it and the method learnt from it, with no request to Crossref", options, async () => {
  const person = await researcher();
  const p = await platform(person);
  await frontierRetraction(p.sourceChanges);

  // The route a researcher uses (check the result's sources): the lookup is answered from the record, nobody is asked.
  const statuses = await p.lookup.lookupStatuses([DOI]);
  assert.deepEqual(p.asked, [], "Crossref was not asked");
  assert.equal(statuses.get(DOI)?.state, "changed");
  assert.deepEqual(statuses.get(DOI)?.updates.map(update => [update.kind, update.noticeDoi, update.date]), [["retraction", "10.9999/retraction-notice", "2026-10-01"]]);
  const reply = await p.impacts.reconcileSourceUpdate(person.owner, { projectId: person.project, source: { id: DOI, doi: DOI }, status: statuses.get(DOI) });
  assert.deepEqual(reply.items.map(item => item.payload.versionId), [rv(1)]);
  assert.equal(reply.items[0].payload.effect, "potentially_affected");
  assert.equal(reply.items[0].payload.historicalResultPreserved, true);
  assert.equal(p.notices.length, 1);
  assert.match(p.notices[0].body, /来源发布了更正或撤回通知/);
  assert.deepEqual(await linkStates(person), [["doi", "retracted", "retraction"]], "the memory that names the DOI is labelled retracted");
  assert.deepEqual(reply.items[0].payload.affected.memories.items.map(item => [item.recordId, item.state]), [[person.fact.id, "retracted"]]);
  const labelled = await learning.getMethod(person.owner, person.method.id);
  assert.deepEqual(labelled.payload.sourceChanges.map(label => [label.state, label.relation]), [["retracted", "learnt_from"]], "and so is the method learnt from the result");
  assert.deepEqual(p.asked, []);
});

test("Postgres: the same change is taken by position, with no lookup at all, and each account is told only of what rests on the work", options, async () => {
  const citing = await researcher();
  const bystander = await researcher({ cites: false });
  // The bystander's memory names the DOI too; its result does not cite it.
  const p = await platform(citing);
  const q = await platform(bystander);
  await frontierRetraction(p.sourceChanges);
  await frontierRetraction(q.sourceChanges);

  const caught = await p.impacts.reconcileSince(citing.owner, { projectId: citing.project, since: 0 });
  assert.deepEqual(caught.items.map(item => item.payload.versionId), [rv(1)]);
  assert.deepEqual([caught.cursor, caught.hasMore, caught.scanned], [1, false, 1]);
  assert.equal(p.notices.length, 1);
  assert.deepEqual(await linkStates(citing), [["doi", "retracted", "retraction"]]);
  assert.equal((await learning.getMethod(citing.owner, citing.method.id)).payload.sourceChanges.length, 1);
  assert.deepEqual(p.asked, []);

  // Going on from the cursor finds nothing new, and a project whose results do not cite the work gets no impact (its memory is told).
  const next = await p.impacts.reconcileSince(citing.owner, { projectId: citing.project, since: caught.cursor });
  assert.deepEqual([next.items, next.cursor], [[], 1]);
  const other = await q.impacts.reconcileSince(bystander.owner, { projectId: bystander.project, since: 0 });
  assert.deepEqual(other.items, [], "no result of this project cites it");
  assert.equal((await documents.list(bystander.owner, "result-impact", { projectId: bystander.project })).items.length, 0);
  assert.deepEqual(await linkStates(bystander), [["doi", "retracted", "retraction"]], "but a memory of its own that names the work is labelled");
  assert.equal(q.notices.length, 1, "and the researcher is told once");
  assert.equal((await documents.list(citing.owner, "result-impact", { projectId: citing.project })).items.length, 1, "another account's impacts are not this one's");
});

test("Postgres: the memories alone can be labelled from the feed, without a result", options, async () => {
  const person = await researcher({ cites: false });
  const p = await platform(person);
  await frontierRetraction(p.sourceChanges);
  const labelled = await p.knowledge.labelSince(person.owner, person.project, { since: 0 });
  assert.deepEqual(labelled.items?.map(entry => [entry.identifier, entry.memories.map(item => item.recordId)]), [[`doi:${DOI}`, [person.fact.id]]]);
  assert.equal(labelled.cursor, 1);
  assert.deepEqual(await linkStates(person), [["doi", "retracted", "retraction"]]);
  assert.deepEqual((await p.knowledge.labelSince(person.owner, person.project, { since: labelled.cursor })).items, []);
  const noRecord = new KnowledgeChangeService({ memory, methods: learning });
  assert.deepEqual(await noRecord.labelSince(person.owner, person.project), { unknown: "unavailable" });
});

test("Postgres: a lookup that failed does not undo a retraction on record, and with no record a failed lookup is a gap exactly as before", options, async () => {
  const person = await researcher();
  const p = await platform(person);
  await frontierRetraction(p.sourceChanges);
  const unavailable = { state: "unavailable", checkedAt: "2026-10-05T12:00:00Z", reason: "timeout", updates: [] };
  const reply = await p.impacts.reconcileSourceUpdate(person.owner, { projectId: person.project, source: { id: DOI, doi: DOI }, status: unavailable });
  assert.equal(reply.items[0].payload.effect, "potentially_affected", "the retraction some other detector recorded stands");
  assert.deepEqual(reply.items[0].payload.sourceStatus.updates.map(update => update.kind), ["retraction"]);

  const second = await researcher();
  const bare = await platform(second, { withRecord: false });
  const gap = await bare.impacts.reconcileSourceUpdate(second.owner, { projectId: second.project, source: { id: DOI, doi: DOI }, status: unavailable });
  assert.equal(gap.items[0].payload.effect, "source_gap");
  assert.deepEqual(await bare.impacts.reconcileSince(second.owner, { projectId: second.project }), { items: [], cursor: 0, hasMore: false, scanned: 0, unavailable: true });
});

test("Postgres: a record that says nothing changes nothing, and a record that cannot be read leaves the check as the caller found it", options, async () => {
  const person = await researcher();
  const p = await platform(person);
  await p.sourceChanges.noteChecked([DOI]);
  const clean = await p.impacts.reconcileSourceUpdate(person.owner, { projectId: person.project, source: { id: DOI, doi: DOI },
    status: { state: "no_update", checkedAt: "2026-10-05T12:00:00Z", updates: [] } });
  assert.deepEqual(clean.items, []);
  assert.equal(p.notices.length, 0);
  assert.deepEqual(await linkStates(person), [["doi", "current", ""]], "a clean answer moves nothing that was not unknown");

  const failures = [];
  const broken = new ResultImpactService({ documents, results: person.results, report: code => failures.push(code), now: () => new Date("2026-10-05T12:00:00Z"),
    sourceChanges: { async get() { throw Object.assign(new Error("down"), { code: "source_change_unavailable" }); } } });
  const changed = { state: "changed", checkedAt: "2026-10-05T12:00:00Z", updates: [{ kind: "correction", noticeDoi: null, date: null, source: null }] };
  const reply = await broken.reconcileSourceUpdate(person.owner, { projectId: person.project, source: { id: DOI, doi: DOI }, status: changed });
  assert.equal(reply.items.length, 1, "the caller's own finding is still reconciled");
  assert.deepEqual(failures, ["source_change_unavailable"]);
});
