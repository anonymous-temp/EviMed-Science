// Flywheel F26 (2026-10-06): a knowledge pack the study lead curated becomes the platform's own immutable version after the code has
// re-checked it, attributed to its author, readable by every account beside the shipped packs, and withdrawable by the author. The pack
// that fails the re-check stays the account's with the failing entries named; a source that changes afterwards labels the platform pack
// and rewrites nothing; with the switch off nothing of this is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";

import { ProductDocuments } from "../src/productStore.mjs";
import { createSourceChanges } from "../src/sourceChanges.mjs";
import { VcrKnowledge } from "../src/vcrKnowledge.mjs";
import { deleteVcrUserRows } from "../src/vcrStoreBase.mjs";
import { skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */ let sourceChanges;
/** @type {any} */ let knowledge;
const LEAD = "u-pack-lead";
const OTHER = "u-pack-other";
let counter = 0;

/** A pack that meets the draft floor and cites one source a DOI names. */
const draftOf = (key, doi) => ({
  disease: { key, nameZh: `${key} 病`, aliases: [key.toUpperCase()] },
  sources: [{ id: "paper", title: "A review", url: `https://doi.org/${doi}`, accessed: "2026-10-04", licence: "link-only" },
    { id: "guide", title: "A guideline page", url: "https://example.org/guideline", accessed: "2026-10-04", licence: "link-only" }],
  terms: [{ id: "t1", labelZh: `${key} 病`, kind: "disease", sources: ["paper"] }],
  endpoints: [{ id: "e1", labelZh: "症状评分变化", type: "continuous", definitionZh: "治疗后评分相对基线的变化。", standard: { name: "the scale the review names" }, sources: ["paper"] }],
  criteria: [{ id: "c1", kind: "inclusion", criterionType: "demographic", requirement: { op: "compare", variable: "age", comparator: "gte", value: 18, unit: "years" },
    textZh: "年龄不小于 18 岁。", sources: ["guide"] }],
});

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrpack", withFrontier: true, users: [LEAD, OTHER], config: { vcrPlatformPacksEnabled: true } });
  await fixture.database.query("UPDATE evimed_control.users SET name = '张主任' WHERE id = $1", [LEAD]);
  sourceChanges = createSourceChanges({ documents: new ProductDocuments(fixture.database), ownerUserId: PLATFORM_PUBLISHER_USER_ID });
  knowledge = platformKnowledge({ enabled: true });
});
after(async () => { await fixture?.close(); });

/** The knowledge package over the fixture's stores, with the neighbours' interfaces as doubles. */
function platformKnowledge({ enabled }) {
  return new VcrKnowledge({ store: fixture.vcr.knowledgeStore, studyStore: fixture.vcr.store,
    platform: { enabled, publisherId: PLATFORM_PUBLISHER_USER_ID, sourceChanges,
      entityVocabulary: { tag: async () => ["disease:rare_thing", "drug:somedrug"] }, officialZoneForKeys: async () => "zone_rare",
      people: (ids) => fixture.vcr.store.personNames(ids) } });
}

async function studyOf(userId) {
  counter += 1;
  return fixture.vcr.store.createStudy({ userId, projectId: `prj-pk${counter}`, name: `研究 ${counter}`, question: "q", dataTier: "T0" });
}

/** A study of the account whose lead has curated its own draft of `key`. */
async function curatedStudy(userId, key, doi) {
  const study = await studyOf(userId);
  const written = await knowledge.draftPack(study, draftOf(key, doi), "run");
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  await knowledge.promotePack(study, userId);
  return { study, packId: written.id };
}

const hashOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("a curated pack that passes the re-check becomes the platform's immutable version, attributed to its author, and every account reads it", skipWithoutDatabase, async () => {
  const { study, packId } = await curatedStudy(LEAD, "rare_thing", "10.1000/pack.clean");
  const result = await knowledge.requestPlatformPromotion(study, LEAD);
  assert.equal(result.state, "passed");
  assert.equal(result.existing, false);
  assert.deepEqual([result.checked.entries, result.checked.sources, result.checked.lookedUp, result.checked.unreadable, result.checked.quotes], [3, 2, 1, 1, 0],
    "the DOI-named source was looked up in the ledger, the guideline page could not be and is counted as such");
  const platform = result.platformPack;
  assert.equal(platform.platform.author.name, "张主任", "the author by the name the account carries");
  assert.equal(platform.platform.author.sourceVersion, 1, "and the version the copy came from");
  assert.equal(platform.platform.zoneId, "zone_rare", "the official zone of the same disease");
  assert.equal(JSON.stringify(platform).includes(LEAD), false, "the account id never leaves");
  const copy = await fixture.vcr.store.one("SELECT user_id, status, version, body FROM evimed_vcr.knowledge_packs WHERE id = $1", [platform.id]);
  assert.deepEqual([copy.user_id, copy.status, copy.version], [PLATFORM_PUBLISHER_USER_ID, "curated", 1], "owned by the platform publisher, platform version 1");
  assert.equal(copy.body.disease.key, "rare_thing");

  // Immutable: not edited, not deleted, by anyone going through the database.
  await assert.rejects(fixture.vcr.store.query("UPDATE evimed_vcr.knowledge_packs SET status = 'ai-draft' WHERE id = $1", [platform.id]), /immutable/);
  await assert.rejects(fixture.vcr.store.query("DELETE FROM evimed_vcr.knowledge_packs WHERE id = $1", [platform.id]), /immutable/);

  // The same pack version asked for again is the copy that exists.
  const again = await knowledge.requestPlatformPromotion(study, LEAD);
  assert.deepEqual([again.state, again.existing, again.platformPack.id], ["passed", true, platform.id]);
  const copies = Number((await fixture.vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.platform_packs WHERE source_pack_id = $1", [packId])).n);
  assert.equal(copies, 1);

  // Every account reads it next to the shipped ones, and one that has none of its own binds and reads it whole.
  const catalogue = (await knowledge.listPacks(OTHER)).packs;
  assert.equal(catalogue.some((pack) => pack.origin === "shipped"), true);
  const listed = catalogue.find((pack) => pack.id === platform.id);
  assert.equal(listed.platform.author.name, "张主任");
  const read = await knowledge.getPack(OTHER, platform.id);
  assert.equal(read.sections.criteria.length, 1);
  const theirs = await studyOf(OTHER);
  const bound = await knowledge.bindPack(theirs, platform.id, "run");
  assert.equal(bound.binding.packId, platform.id);

  // The zone page asks by keys.
  const linked = await knowledge.packsForEntityKeys(["disease:rare_thing"]);
  assert.deepEqual(linked.map((pack) => pack.id), [platform.id]);
  assert.equal((await knowledge.packsForEntityKeys(["disease:unrelated"])).length, 0);
});

test("an account's own pack of the same disease wins for that account", skipWithoutDatabase, async () => {
  const mine = await curatedStudy(OTHER, "rare_thing", "10.1000/pack.own");
  const ids = (await knowledge.listPacks(OTHER)).packs.filter((pack) => pack.diseaseKey === "rare_thing").map((pack) => pack.id);
  assert.deepEqual(ids, [mine.packId], "the platform's pack of the disease is not offered to an account that has its own");
  assert.equal((await knowledge.listPacks(LEAD)).packs.filter((pack) => pack.diseaseKey === "rare_thing").length >= 1, true);
});

test("a pack with a source the ledger says was retracted stays the account's, and the failing entries are named", skipWithoutDatabase, async () => {
  await sourceChanges.record("doi:10.1000/pack.retracted", { kind: "retraction", date: "2026-09-30" }, { assertedBy: "crossref" });
  const { study, packId } = await curatedStudy(LEAD, "second_thing", "10.1000/pack.retracted");
  const result = await knowledge.requestPlatformPromotion(study, LEAD);
  assert.equal(result.state, "failed");
  assert.equal(result.platformPack, null);
  assert.deepEqual(result.failing.map((entry) => [entry.section, entry.id, entry.code]).sort(), [["endpoints", "e1", "source_changed"], ["terms", "t1", "source_changed"]],
    "the entries that cite the retracted source, and only those: the criterion cites the guideline page");
  assert.match(result.failing[0].detail, /retraction/);
  assert.equal(Number((await fixture.vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.platform_packs WHERE source_pack_id = $1", [packId])).n), 0);
  const stored = await fixture.vcr.store.one("SELECT user_id FROM evimed_vcr.knowledge_packs WHERE id = $1", [packId]);
  assert.equal(stored.user_id, LEAD, "the pack is the account's still");
  const view = await knowledge.studyKnowledge(study, { canPromote: true });
  assert.equal(view.pack.platformRequest.recheck.state, "failed");
  assert.equal(view.pack.platformRequest.canRequest, true, "it can be asked for again once the source is dealt with");
});

test("only a pack the lead has marked curated can be asked for", skipWithoutDatabase, async () => {
  const study = await studyOf(LEAD);
  await knowledge.draftPack(study, draftOf("third_thing", "10.1000/pack.draft"), "run");
  await assert.rejects(knowledge.requestPlatformPromotion(study, LEAD), { status: 409, code: "vcr_pack_not_curated" });
  const none = await studyOf(LEAD);
  await assert.rejects(knowledge.requestPlatformPromotion(none, LEAD), { status: 404, code: "vcr_pack_not_found" });
  const shipped = await studyOf(LEAD);
  await knowledge.bindPack(shipped, "nsclc", "run");
  await assert.rejects(knowledge.requestPlatformPromotion(shipped, LEAD), { status: 404, code: "vcr_pack_not_found" }, "a shipped pack is the platform's already");
});

test("a source that changes after promotion labels the platform pack and rewrites nothing", skipWithoutDatabase, async () => {
  const { study } = await curatedStudy(LEAD, "fourth_thing", "10.1000/pack.later");
  const { platformPack } = await knowledge.requestPlatformPromotion(study, LEAD);
  const bodyBefore = hashOf((await fixture.vcr.store.one("SELECT body FROM evimed_vcr.knowledge_packs WHERE id = $1", [platformPack.id])).body);
  await sourceChanges.record("doi:10.1000/pack.later", { kind: "correction", date: "2026-10-02" }, { assertedBy: "crossref" });
  const watched = await knowledge.watchPlatformPackSources({ limit: 50 });
  assert.ok(watched.checked >= 1 && watched.changed >= 1);
  const labelled = (await knowledge.listPacks(OTHER)).packs.find((pack) => pack.id === platformPack.id);
  assert.equal(Boolean(labelled.platform.sourceChanged), true, "来源有变更");
  assert.equal(labelled.platform.sourceChanged.sources[0].kind, "correction");
  const bodyAfter = hashOf((await fixture.vcr.store.one("SELECT body FROM evimed_vcr.knowledge_packs WHERE id = $1", [platformPack.id])).body);
  assert.equal(bodyAfter, bodyBefore, "no automatic rewrite");
});

test("the author takes their name off: retired for new studies, kept for the studies that pinned it; no one else may", skipWithoutDatabase, async () => {
  const { study } = await curatedStudy(LEAD, "fifth_thing", "10.1000/pack.withdraw");
  const { platformPack } = await knowledge.requestPlatformPromotion(study, LEAD);
  const pinned = await studyOf(OTHER);
  await knowledge.bindPack(pinned, platformPack.id, "run");
  await assert.rejects(knowledge.withdrawPlatformPack(OTHER, platformPack.id), { status: 404, code: "vcr_pack_not_found" }, "only the author's account");
  const withdrawn = await knowledge.withdrawPlatformPack(LEAD, platformPack.id);
  assert.equal(withdrawn.state, "retired");
  assert.equal((await knowledge.listPacks(OTHER)).packs.some((pack) => pack.id === platformPack.id), false, "not offered to new studies");
  assert.equal((await knowledge.packsForEntityKeys(["disease:rare_thing"])).some((pack) => pack.id === platformPack.id), false);
  const fresh = await studyOf(OTHER);
  await assert.rejects(knowledge.bindPack(fresh, platformPack.id, "run"), { status: 404, code: "vcr_pack_not_found" });
  const still = await knowledge.studyPack(pinned);
  assert.equal(still.pack.disease.key, "fifth_thing", "the study that pinned the version keeps reading it");
  assert.equal(still.row.platform.author.name, "", "and it carries no name any more");
  await assert.rejects(knowledge.withdrawPlatformPack(LEAD, platformPack.id), { status: 404 }, "retired once");
});

test("deleting the author's account retires their platform packs and keeps the versions others pinned", skipWithoutDatabase, async () => {
  const author = "u-pack-leaver";
  await fixture.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'离开的人','development')", [author]);
  const { study } = await curatedStudy(author, "sixth_thing", "10.1000/pack.leave");
  const { platformPack } = await knowledge.requestPlatformPromotion(study, author);
  await fixture.vcr.store.query(`INSERT INTO evimed_vcr.precedent_candidates (id, user_id, frontier_item_id, event, title) VALUES ('pcn_leaver', $1, '77', 'registration', 't')`, [author]);
  await fixture.vcr.store.transaction((client) => deleteVcrUserRows(client, author));
  for (const table of ["precedent_candidates", "pack_promotions"]) {
    assert.equal(Number((await fixture.vcr.store.one(`SELECT count(*)::int AS n FROM evimed_vcr.${table} WHERE user_id = $1`, [author])).n), 0, `${table} went with the account`);
  }
  const row = await fixture.vcr.store.one("SELECT state, author_name, retired_reason FROM evimed_vcr.platform_packs WHERE pack_id = $1", [platformPack.id]);
  assert.deepEqual([row.state, row.author_name, row.retired_reason], ["retired", "", "author_removed"]);
  assert.equal(Number((await fixture.vcr.store.one("SELECT count(*)::int AS n FROM evimed_vcr.knowledge_packs WHERE id = $1", [platformPack.id])).n), 1, "the platform's row stays");
});

test("switched off, nothing of this exists: the request is a named 404, no platform row is read or listed, no source is watched", skipWithoutDatabase, async () => {
  const off = platformKnowledge({ enabled: false });
  const { study } = await curatedStudy(LEAD, "seventh_thing", "10.1000/pack.off");
  await assert.rejects(off.requestPlatformPromotion(study, LEAD), { status: 404, code: "vcr_platform_packs_not_enabled" });
  await assert.rejects(off.withdrawPlatformPack(LEAD, "pkg_x"), { status: 404, code: "vcr_platform_packs_not_enabled" });
  const live = await fixture.vcr.store.one("SELECT pack_id FROM evimed_vcr.platform_packs WHERE state = 'live' LIMIT 1");
  assert.ok(live, "there is a live platform pack in the table");
  assert.equal((await off.listPacks(OTHER)).packs.some((pack) => pack.id === live.pack_id), false, "and an account that has the feature off does not see it");
  await assert.rejects(off.getPack(OTHER, String(live.pack_id)), { status: 404, code: "vcr_pack_not_found" });
  assert.deepEqual(await off.packsForEntityKeys(["disease:rare_thing"]), []);
  assert.deepEqual(await off.watchPlatformPackSources(), { checked: 0, changed: 0 });
});
