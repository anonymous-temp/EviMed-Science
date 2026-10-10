// A source a finding rests on being retracted or corrected reaches the project's value profile (G10e), on a real PostgreSQL with the real
// source-change record and the real frontier items: the platform's record of what was published about a work, and the flags the frontier
// feed gives the items that name it, each add one `needs_review` entry in the shape the replaced-file entry has, once, and nothing else.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { createEntityVocabulary } from "../src/entityVocabulary.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { GeoService } from "../src/geoService.mjs";
import { GeoStore } from "../src/geoStore.mjs";
import { geoValueSourceReplaced } from "../src/geoValueStore.mjs";
import { createGeoValueUpkeep } from "../src/geoValueUpkeep.mjs";
import { geoRuntimeWrite } from "../src/geoWrites.mjs";
import { ProductDocuments } from "../src/productStore.mjs";
import { createSourceChanges } from "../src/sourceChanges.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
/** @type {any} */ let isolated, database, store, sourceChanges, vocabulary;
const PLATFORM = "source_watch_platform";

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "watch");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Source watch platform','development'),('alice','Alice','development')", [PLATFORM]);
  store = new GeoStore({ database });
  await store.ready();
  sourceChanges = createSourceChanges({ documents: new ProductDocuments(database), ownerUserId: PLATFORM });
  vocabulary = createEntityVocabulary({ database, enabled: true });
  await insertSource(database, "nejm");
});
after(async () => { await database?.close(); await isolated?.drop(); });

const fresh = () => store.createProject({ userId: "alice", projectId: randomUUID(), engines: ["deepseek"], coverageDays: 90 });
const upkeep = (/** @type {Record<string, any>} */ over = {}) => createGeoValueUpkeep({ store, sourceChanges, entityVocabulary: vocabulary, config: { geoSourceWatchProjectsPerTick: 50 }, ...over });
/** The profile's `sourceChanges` entries by id. @param {string} id */
const entries = async (id) => Object.fromEntries(((await store.latestValue(id)).data.sourceChanges ?? []).map((/** @type {any} */ entry) => [entry.id, entry]));
const retraction = (notice = "10.1000/notice.one") => ({ kind: "retraction", noticeIdentifier: notice, date: "2026-10-01" });
/** A project of its own, so the other tests' turns and counts do not move this one's; the watch looks at every project with a profile. */
async function alone() {
  await database.query("DELETE FROM evimed_geo.schedule_marks WHERE key = 'watch:sources'");
  return fresh();
}

test("a retraction or correction on record flags the findings that rest on the source, in the shape a replaced file's entry has, once", options, async () => {
  const project = await fresh();
  await store.writeValue("alice", project.id, { findings: [
    { id: "f1", statement: "Benefit shown in adults", sources: [{ doi: "10.1000/work.one", title: "Trial" }] },
    { id: "f2", statement: "Gastrointestinal events are common", sourceRef: "PMID:40421736" },
    { id: "f3", statement: "Cost is unknown", sources: ["https://doi.org/10.1000/never.noticed"] },
    { id: "f4", statement: "Label wording", sourceRefs: ["src_a1b2c3"], sources: [{ sourceId: "src_a1b2c3" }] },
    { id: "f5", statement: "Retired but cites it", status: "retired", sourceRef: "10.1000/work.one" },
    { id: "f6", statement: "Registered trial", sources: [{ registryId: "NCT01234567" }] },
  ] });
  await sourceChanges.record("10.1000/work.one", retraction(), { assertedBy: "crossref" });
  await sourceChanges.record("pmid:40421736", { kind: "correction", noticeIdentifier: "pmid:99", date: "2026-09-20" }, { assertedBy: "pubmed" });
  await sourceChanges.record("NCT01234567", { kind: "concern", noticeIdentifier: null, date: null }, { assertedBy: "registry" });
  await sourceChanges.record("10.1000/never.noticed", { kind: "new_version", noticeIdentifier: "10.1000/v2", date: "2026-10-02" }, { assertedBy: "crossref" });
  const versionBefore = (await store.latestValue(project.id)).version;

  const watch = upkeep();
  const first = await watch.tick();
  assert.deepEqual([first.watchProjects >= 1, first.changesFlagged], [true, 3], "three changes added: a new version of a work is not a warning");
  const found = await entries(project.id);
  assert.deepEqual(Object.keys(found).sort(), ["change:doi:10.1000/work.one:retraction", "change:pmid:40421736:correction", "change:reg:NCT01234567:concern"]);
  const retracted = found["change:doi:10.1000/work.one:retraction"];
  assert.deepEqual([retracted.findingIds, retracted.status, retracted.reason, retracted.kind, retracted.sourceRef, retracted.noticeIdentifier],
    [["f1"], "needs_review", "source_retracted", "retraction", "doi:10.1000/work.one", "10.1000/notice.one"], "the retired finding is not linked");
  assert.equal(retracted.summary, "DOI 10.1000/work.one 已被撤稿，可检查引用它的结论与内容。");
  assert.equal(found["change:pmid:40421736:correction"].summary, "PMID 40421736 有更正，可检查引用它的结论与内容。");
  assert.deepEqual(found["change:pmid:40421736:correction"].findingIds, ["f2"]);
  assert.equal(found["change:reg:NCT01234567:concern"].summary, "注册号 NCT01234567 被编辑部发出关注声明，可检查引用它的结论与内容。");
  assert.equal((await store.latestValue(project.id)).version, versionBefore + 1, "one version for all the changes of one pass");
  // The same shape as the replaced-file entry: an id, a time, a sentence, needs_review and a reason; the page's impacts reach the findings by it.
  for (const entry of Object.values(found)) assert.ok(entry.id && entry.at && entry.summary && entry.status === "needs_review" && entry.reason);
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf(project);
  assert.deepEqual(value.impacts.map((/** @type {any} */ impact) => [impact.change.id, impact.findingIds]).sort(),
    [["change:doi:10.1000/work.one:retraction", ["f1"]], ["change:pmid:40421736:correction", ["f2"]], ["change:reg:NCT01234567:concern", ["f6"]]],
    "the changed-source count and the impact list reach them as they reach a replaced file");

  // Once: the same pass again writes nothing, whatever the project's turn.
  const again = await watch.tick();
  assert.equal(again.changesFlagged, 0);
  assert.equal((await store.latestValue(project.id)).version, versionBefore + 1, "no new version");
  assert.equal(watch.metrics().changesFlagged, 3);
  assert.equal(watch.metrics().projectsFlagged >= 1, true);
});

test("a published frontier item that names the source and is flagged retracted, corrected or under concern flags the findings, with no record", options, async () => {
  const project = await alone();
  await store.writeValue("alice", project.id, { findings: [
    { id: "g1", statement: "Primary endpoint", sources: [{ doi: "10.1000/Frontier.One" }] },
    { id: "g2", statement: "Safety signal", sourceRef: "pmid:2468013" },
    { id: "g3", statement: "Unflagged item", sources: [{ doi: "10.1000/frontier.plain" }] },
  ] });
  await insertItem(database, { doi: "10.1000/frontier.one", flags: ["retracted"], sourceId: "nejm", title: "A retracted trial", timelineAt: "2026-10-03T08:00:00Z" });
  const concerned = await insertItem(database, { pmid: "2468013", flags: ["expression-of-concern"], sourceId: "nejm", title: "A trial under concern", timelineAt: "2026-10-04T08:00:00Z" });
  await database.query("INSERT INTO evimed_frontier.item_keys (key, item_id) VALUES ('pmid:2468013', $1)", [concerned.id]);
  await insertItem(database, { doi: "10.1000/frontier.plain", flags: ["china"], sourceId: "nejm", title: "Not a notice" });

  const watch = upkeep({ sourceChanges: null });
  assert.equal((await watch.tick()).changesFlagged, 2);
  const found = await entries(project.id);
  assert.deepEqual(Object.keys(found).sort(), ["change:doi:10.1000/frontier.one:retraction", "change:pmid:2468013:concern"]);
  assert.deepEqual([found["change:doi:10.1000/frontier.one:retraction"].findingIds, found["change:doi:10.1000/frontier.one:retraction"].detectedBy], [["g1"], "frontier"]);
  assert.equal(found["change:doi:10.1000/frontier.one:retraction"].at, "2026-10-03T08:00:00.000Z", "dated by the item");
  assert.deepEqual(found["change:pmid:2468013:concern"].findingIds, ["g2"]);

  // The record and the feed that name one retraction make one entry.
  await sourceChanges.record("10.1000/frontier.one", retraction("10.1000/notice.two"), { assertedBy: "retraction-watch" });
  assert.equal((await upkeep().tick()).changesFlagged, 0, "already in the profile: written once, whoever saw it");
});

test("a finding written later that rests on the same source is linked to an entry that still asks for a look; one the researcher dealt with is left alone", options, async () => {
  const project = await alone();
  await store.writeValue("alice", project.id, { findings: [{ id: "h1", statement: "First", sources: [{ doi: "10.1000/later.one" }] }] });
  await sourceChanges.record("10.1000/later.one", retraction(), { assertedBy: "crossref" });
  const watch = upkeep();
  await watch.tick();
  const id = "change:doi:10.1000/later.one:retraction";
  assert.deepEqual((await entries(project.id))[id].findingIds, ["h1"]);
  await store.writeValue("alice", project.id, { findings: [{ id: "h2", statement: "Second", sourceRef: "https://doi.org/10.1000/LATER.one" }] });
  const extended = await watch.tick();
  assert.equal(extended.changesFlagged, 0);
  assert.equal(watch.metrics().changesExtended, 1);
  assert.deepEqual((await entries(project.id))[id].findingIds, ["h1", "h2"]);
  // The researcher has dealt with it: a finding written after is theirs to judge, and the entry keeps the status they gave it.
  await store.writeValue("alice", project.id, { sourceChanges: [{ id, status: "retired" }], findings: [{ id: "h3", statement: "Third", sourceRef: "10.1000/later.one" }] });
  await watch.tick();
  const left = (await entries(project.id))[id];
  assert.deepEqual([left.status, left.findingIds], ["retired", ["h1", "h2"]]);
  assert.equal(watch.metrics().changesExtended, 1);
});

test("a claim a finding links rests the finding on the claim's source", options, async () => {
  const project = await alone();
  const written = await geoRuntimeWrite({ store, project, what: "claims", body: { items: [{ claimKey: "weight", statement: "第 48 周体重下降 14.1%。",
    quote: "lost 14.1% of body weight at week 48", sourceRef: "10.1056/NEJMoa0000000", sourceKind: "trial" }] } });
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  await store.writeValue("alice", project.id, { findings: [{ id: "k1", statement: "Weight loss", claimIds: written.ids, certainty: "moderate" }] });
  await sourceChanges.record("10.1056/NEJMoa0000000", { kind: "correction", noticeIdentifier: "10.1056/erratum", date: "2026-10-05" }, { assertedBy: "crossref" });
  assert.equal((await upkeep().tick()).changesFlagged, 1);
  assert.deepEqual(Object.values(await entries(project.id)).map((entry) => [entry.id, entry.findingIds]), [["change:doi:10.1056/nejmoa0000000:correction", ["k1"]]]);
});

test("the watch reads a bounded number of projects a tick, the one looked at longest ago first, and a source that cannot be asked about is counted and invents nothing", options, async () => {
  await database.query("DELETE FROM evimed_geo.schedule_marks WHERE key = 'watch:sources'");
  const projects = [await fresh(), await fresh(), await fresh()];
  for (const [index, project] of projects.entries()) {
    await store.writeValue("alice", project.id, { findings: [{ id: `t${index}`, statement: "A finding", sources: [{ doi: `10.1000/turn.${index}` }] }] });
  }
  const seen = [];
  const spy = { getMany: async (/** @type {string[]} */ identifiers) => { seen.push(...identifiers); return new Map(); } };
  const reported = [];
  const watch = createGeoValueUpkeep({ store, sourceChanges: spy, entityVocabulary: null, config: { geoSourceWatchProjectsPerTick: 2 }, report: (code) => reported.push(code) });
  // Every project with a profile is in the turn, the earlier tests' too, and the ones with no turn yet come first: two new projects a tick.
  const all = Number((await store.query("SELECT count(*) AS n FROM evimed_geo.projects p WHERE EXISTS (SELECT 1 FROM evimed_geo.value_profiles v WHERE v.geo_project_id = p.id)")).rows[0].n);
  const turns = async () => Number((await store.query("SELECT count(*) AS n FROM evimed_geo.schedule_marks WHERE key = 'watch:sources'")).rows[0].n);
  for (let tick = 1; tick <= Math.ceil(all / 2); tick += 1) {
    assert.ok((await watch.tick()).watchProjects <= 2, "at most the bound");
    assert.equal(await turns(), Math.min(all, tick * 2), "each tick gives two projects that had no turn theirs, so none is passed over");
  }
  for (let index = 0; index < 3; index += 1) assert.ok(seen.includes(`doi:10.1000/turn.${index}`), `project ${index} was reached`);
  assert.deepEqual(reported, []);

  const failing = createGeoValueUpkeep({ store, sourceChanges: { getMany: async () => { throw Object.assign(new Error("down"), { code: "source_change_unavailable" }); } },
    entityVocabulary: null, config: { geoSourceWatchProjectsPerTick: 50 }, report: (code) => reported.push(code) });
  const result = await failing.tick();
  assert.equal(result.changesFlagged, 0, "nothing is written for a source that could not be asked about");
  assert.ok(failing.metrics().failures >= 1 && reported.every((code) => code === "watch:source_changes:source_change_unavailable"));
  assert.ok(result.watchProjects >= 1, "the projects had their turn all the same");
});

test("a write that fails counts nothing as flagged, is reported, and the next tick writes the entry", options, async () => {
  const project = await alone();
  await store.writeValue("alice", project.id, { findings: [{ id: "w1", statement: "A finding", sources: [{ doi: "10.1000/write.fails" }] }] });
  await sourceChanges.record("10.1000/write.fails", retraction(), { assertedBy: "crossref" });
  let failing = true;
  const flaky = new Proxy(store, { get(target, key) {
    if (key !== "writeValue") return Reflect.get(target, key, target);
    return async (/** @type {any[]} */ ...args) => { if (failing) throw Object.assign(new Error("down"), { code: "57P01" }); return target.writeValue(...args); };
  } });
  const reported = [];
  const watch = createGeoValueUpkeep({ store: flaky, sourceChanges, entityVocabulary: null, config: { geoSourceWatchProjectsPerTick: 50 }, report: (code) => reported.push(code) });
  await watch.tick();
  assert.deepEqual([watch.metrics().changesFlagged, watch.metrics().projectsFlagged, watch.metrics().failures >= 1], [0, 0, true], "nothing was added, and nothing is claimed");
  assert.ok(reported.includes("watch:57P01"));
  assert.deepEqual(await entries(project.id), {}, "the profile has no entry");
  failing = false;
  await watch.tick();
  assert.equal(watch.metrics().changesFlagged, 1);
  assert.deepEqual(Object.keys(await entries(project.id)), ["change:doi:10.1000/write.fails:retraction"]);
});

test("a deployment whose frontier tables are not there reads the record alone, and without both stores the watch does not run", options, async () => {
  const project = await alone();
  await store.writeValue("alice", project.id, { findings: [{ id: "m1", statement: "A finding", sources: [{ doi: "10.1000/no.frontier" }] }] });
  await sourceChanges.record("10.1000/no.frontier", retraction(), { assertedBy: "crossref" });
  let asked = 0;
  const noTables = new Proxy(store, { get(target, key) {
    if (key !== "query") return Reflect.get(target, key, target);
    return async (/** @type {string} */ sql, /** @type {unknown[]} */ values) => (sql.includes("to_regclass('evimed_frontier.item_keys')") ? { rows: [{ present: false }] } : target.query(sql, values));
  } });
  const watch = createGeoValueUpkeep({ store: noTables, sourceChanges, entityVocabulary: { frontierItemsMatching: async () => { asked += 1; return []; } }, config: { geoSourceWatchProjectsPerTick: 50 } });
  assert.equal((await watch.tick()).changesFlagged, 1, "the record is read");
  assert.equal(asked, 0, "the frontier is not asked");
  const off = createGeoValueUpkeep({ store, config: { geoSourceWatchProjectsPerTick: 50 } });
  assert.deepEqual(await off.tick(), { projectsChecked: 0, versionsPruned: 0, projectsPruned: 0, watchProjects: 0, changesFlagged: 0 });
});

test("the replaced-file entry and a changed-source entry sit in one list, and an entry of either reaches only the findings it names", options, async () => {
  const project = await alone();
  await store.writeValue("alice", project.id, { findings: [
    { id: "r1", statement: "A", sources: [{ sourceId: "src_replaced" }, { doi: "10.1000/both.one" }] }, { id: "r2", statement: "B", sources: [{ doi: "10.1000/both.two" }] },
  ] });
  await sourceChanges.record("10.1000/both.one", retraction(), { assertedBy: "crossref" });
  await upkeep().tick();
  await geoValueSourceReplaced(store, { userId: "alice", projectId: project.projectId, replaced: { sourceId: "src_replaced" }, by: { sourceId: "src_new", at: "2026-10-06T00:00:00Z" } });
  const service = new GeoService({ store, config: { geoEnabled: true, geoAudience: "all" } });
  const value = await service.valueOf(project);
  assert.deepEqual(value.impacts.map((/** @type {any} */ impact) => [impact.change.id.split(":")[0], impact.findingIds]).sort(), [["change", ["r1"]], ["replacement", ["r1"]]]);
  assert.equal(value.impactsTotal, 2);
});
