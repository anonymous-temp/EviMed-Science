// The topic zones' write side against a real PostgreSQL, a stub model and a recording data plane: a reader's zone made, replayed, edited,
// published and deleted; the thirty-zone limit; who may see and change what; a reader's word on an item; the typed follows that became
// zones.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidenceZoneDraft } from "../src/evidenceZoneDraft.mjs";
import { TYPED_FOLLOWS_MARKER, createEvidenceZoneWrites, definitionFromTypedFollow, zoneIdFor } from "../src/evidenceZoneWrites.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const alice = { id: "alice" };
const bob = { id: "bob" };

let isolated, db, zones, plane, editor, draft, writes;

/** The recording data plane: it resolves every keyword to a tag id and remembers what it was told. */
function recordingPlane() {
  const told = { afterSave: [], feedback: [], resolved: 0 };
  return {
    told,
    async resolveKeywords(definition) {
      told.resolved += 1;
      return { ...definition, keywords: definition.keywords.map((keyword, index) => ({ ...keyword, tagIds: [500 + index], entityKeys: [] })) };
    },
    async preview() { return { count30: 8, perWeek: 2, band: "narrow", recentRowIds: [], borderlineRowIds: [] }; },
    async afterSave(zoneId) { told.afterSave.push(zoneId); },
    async feedback(zoneId, itemRowId, kind, actor) { told.feedback.push({ zoneId, itemRowId, kind, actor }); },
  };
}

const definitionBody = (extra = {}) => ({
  type: "drug-indication",
  keywords: [{ label: "GLP-1 受体激动剂", terms: ["司美格鲁肽"] }, { label: "减重", terms: ["肥胖"] }],
  perspective: null,
  scope: "成人减重的疗效与安全性",
  include: "讲减重的研究",
  exclude: "只讲降糖的研究",
  excludeTerms: [],
  specialties: ["endocrinology"],
  group: "肥胖",
  ...extra,
});
let requests = 0;
const body = (extra = {}) => ({ title: "GLP-1 受体激动剂减重", definition: definitionBody(), seeds: { positive: [], negative: [] }, published: false, requestId: `request-${(requests += 1)}-abcdefgh`, ...extra });
const rowOf = async (id) => (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id = $1", [id])).rows[0];
const changesOf = async (id) => (await db.query("SELECT kind, actor, detail FROM evimed_frontier.zone_changes WHERE zone_id = $1 ORDER BY id", [id])).rows;

function compose(config = {}) {
  plane = recordingPlane();
  editor = { available: false };
  draft = createEvidenceZoneDraft({ editor, membership: plane, database: db });
  writes = createEvidenceZoneWrites({ database: db, zones, membership: plane, draft, config: { evidenceUserZonesMax: 30, ...config } });
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "zwrites");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development')");
  zones = new EvidenceZoneService({ database: db });
});
after(async () => {
  await db?.close();
  await isolated?.drop();
});
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.evidence_zones, evimed_frontier.items, evimed_frontier.user_follows, evimed_frontier.user_prefs, evimed_frontier.zone_changes CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await db.query("DELETE FROM evimed_frontier.meta WHERE key = $1", [TYPED_FOLLOWS_MARKER]);
  await insertSource(db, "nejm");
  compose();
});

test("a reader's zone is live when made: the row, the resolved definition, the change record, and the data plane is told", options, async () => {
  const { zone } = await writes.create(alice, body({ title: "  GLP-1 受体激动剂减重 " }));
  assert.equal(zone.title, "GLP-1 受体激动剂减重");
  assert.equal(zone.kind, "user");
  assert.equal(zone.published, false);
  assert.equal(zone.canEdit, true);
  assert.equal(zone.canDelete, true);
  assert.equal(zone.lifecycle, "active");
  assert.deepEqual(zone.keywords, ["GLP-1 受体激动剂", "减重"]);
  assert.deepEqual(zone.definition.keywords[0], { label: "GLP-1 受体激动剂", terms: ["GLP-1 受体激动剂", "司美格鲁肽"] }, "the owner reads the definition without the ids");
  const row = await rowOf(zone.id);
  assert.deepEqual([row.kind, row.state, row.visibility, row.lifecycle, row.definition_version, row.revision], ["user", "draft", "platform", "active", 1, 1]);
  assert.deepEqual([row.zone_type, row.specialties, row.group_label, row.scope_zh, row.slug], ["drug-indication", ["endocrinology"], "肥胖", "成人减重的疗效与安全性", null]);
  assert.deepEqual(row.definition.keywords.map((keyword) => keyword.tagIds), [[500], [501]], "stored resolved");
  assert.deepEqual(await changesOf(zone.id), [{ kind: "created", actor: "owner:alice", detail: { title: "GLP-1 受体激动剂减重", published: false } }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plane.told.afterSave, [zone.id]);
  assert.equal(await writes.isTopicZone(alice, zone.id), true);
  assert.equal(await writes.isTopicZone(bob, zone.id), false, "a private zone does not exist for another reader");
});

test("a zone's id from a request identity is the one the older writer derives, so a request is one zone whichever writer made it", options, async () => {
  const { zone } = await zones.save(alice, { title: "Old writer", requestId: "same-request-id-1" });
  assert.equal(zone.id, zoneIdFor("alice", "same-request-id-1"));
  assert.notEqual(zoneIdFor("bob", "same-request-id-1"), zone.id);
});

test("a zone made published is in the directory's reach and never on the internet", options, async () => {
  const { zone } = await writes.create(alice, body({ published: true }));
  const row = await rowOf(zone.id);
  assert.deepEqual([row.state, row.visibility], ["published", "platform"]);
  assert.equal(await writes.isTopicZone(bob, zone.id), true);
  assert.equal(zone.published, true);
});

test("the thirty-zone limit is the reader's own, a replay is not a new zone, and a request identity is not reusable for another zone", options, async () => {
  compose({ evidenceUserZonesMax: 3 });
  const third = [];
  for (let index = 0; index < 3; index += 1) third.push(await writes.create(alice, body({ title: `专区 ${index}`, requestId: `limit-request-${index}` })));
  await assert.rejects(writes.create(alice, body({ title: "第四个" })), { status: 409, code: "evidence_user_zone_limit" });
  assert.equal(writes.status().counters.limitRefused, 1);
  const replay = await writes.create(alice, body({ title: "专区 2", requestId: "limit-request-2" }));
  assert.equal(replay.zone.id, third[2].zone.id, "the same request at the limit is the same zone");
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_zones WHERE user_id = 'alice'")).rows[0].n), 3);
  await assert.rejects(writes.create(alice, body({ title: "别的专区", requestId: "limit-request-2" })), { status: 409, code: "evidence_request_conflict" });
  const theirs = await writes.create(bob, body({ title: "专区 2", requestId: "limit-request-2" }));
  assert.notEqual(theirs.zone.id, third[2].zone.id, "a request identity is one reader's own");
  assert.equal((await writes.create(bob, body({ title: "Bob 的专区" }))).zone.kind, "user", "another reader is not at alice's limit");
  // A container of research-result cards (no topic definition) is not one of the thirty.
  await db.query(`INSERT INTO evimed_frontier.evidence_zones(id, user_id, title) VALUES ('ez_container', 'bob', 'container')`);
  assert.equal((await writes.create(bob, body({ title: "Bob 的第二个" }))).zone.title, "Bob 的第二个");
  const afterDelete = await writes.remove(alice, third[0].zone.id);
  assert.deepEqual(afterDelete, { deleted: true });
  assert.equal((await writes.create(alice, body({ title: "补一个" }))).zone.title, "补一个", "deleting one makes room");
});

test("a body that is not a zone is refused by name, and nothing is saved", options, async () => {
  const before = Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_zones")).rows[0].n);
  await assert.rejects(writes.create(alice, body({ title: "  " })), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.create(alice, body({ definition: definitionBody({ keywords: [] }) })), { status: 400, code: "evidence_invalid", message: /keywords/ });
  await assert.rejects(writes.create(alice, body({ definition: definitionBody({ type: "nonsense" }) })), { status: 400, code: "evidence_invalid", message: /type/ });
  await assert.rejects(writes.create(alice, body({ definition: definitionBody({ scope: "" }) })), { status: 400, code: "evidence_invalid", message: /scope/ });
  await assert.rejects(writes.create(alice, { ...body(), surprise: 1 }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.create(alice, body({ requestId: "short" })), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.create(alice, body({ published: "yes" })), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.create(alice, null), { status: 400, code: "evidence_invalid" });
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_zones")).rows[0].n), before);
  // Width and words are never refused: a single keyword, four, a very wide zone.
  assert.ok((await writes.create(alice, body({ definition: definitionBody({ keywords: [{ label: "乳腺癌", terms: [] }] }), title: "乳腺癌" }))).zone.id);
});

test("seeds that name items the reader can read stay; the rest are dropped", options, async () => {
  const item = await insertItem(db, { title: "Semaglutide and weight loss" });
  const withheld = await insertItem(db, { title: "Withdrawn", state: "withdrawn" });
  const { zone } = await writes.create(alice, body({ seeds: { positive: [item.publicId, withheld.publicId, "nonexistent00000"], negative: ["BAD"] } }));
  assert.deepEqual((await rowOf(zone.id)).definition.seeds, { positive: [item.publicId], negative: [] });
});

test("only the owner changes a zone; a stale revision is a conflict; a definition edit versions the definition and tells the data plane once", options, async () => {
  const { zone } = await writes.create(alice, body({ published: true }));
  await assert.rejects(writes.update(bob, zone.id, { title: "劫持", expectedRevision: zone.revision }), { status: 403, code: "evidence_owner_required" });
  await assert.rejects(writes.update(alice, zone.id, { title: "旧", expectedRevision: zone.revision + 3 }), { status: 409, code: "evidence_revision_conflict" });
  await assert.rejects(writes.update(alice, zone.id, { title: "无修订" }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.update(alice, zone.id, { definition: definitionBody({ keywords: [] }), expectedRevision: 1 }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.update(alice, zone.id, { description: "old field", expectedRevision: 1 }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.update(alice, "ez_missing", { title: "x", expectedRevision: 1 }), { status: 404, code: "evidence_not_found" });
  plane.told.afterSave.length = 0;
  // Nothing changed: no revision, no record, no data-plane call.
  const same = await writes.update(alice, zone.id, { title: zone.title, definition: definitionBody(), published: true, expectedRevision: zone.revision });
  assert.equal(same.zone.revision, zone.revision);
  assert.equal((await changesOf(zone.id)).length, 1);
  // A title alone is a revision and no new definition.
  const renamed = await writes.update(alice, zone.id, { title: "减重药", expectedRevision: zone.revision });
  assert.equal(renamed.zone.title, "减重药");
  assert.equal(renamed.zone.revision, zone.revision + 1);
  assert.equal((await rowOf(zone.id)).definition_version, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plane.told.afterSave, []);
  // A new reading of the zone is a new definition version, and the data plane is told once.
  const edited = await writes.update(alice, zone.id, { definition: definitionBody({ keywords: [{ label: "GLP-1 受体激动剂", terms: ["替尔泊肽"] }, { label: "减重", terms: [] }, { label: "心血管结局", terms: ["MACE"] }], scope: "加上心血管结局" }), expectedRevision: renamed.zone.revision });
  const row = await rowOf(zone.id);
  assert.equal(row.definition_version, 2);
  assert.equal(row.scope_zh, "加上心血管结局");
  assert.equal(row.description, "加上心血管结局");
  assert.equal(edited.zone.keywords.length, 3);
  assert.equal(edited.zone.revision, zone.revision + 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(plane.told.afterSave, [zone.id]);
  const kinds = (await changesOf(zone.id)).map((change) => change.kind);
  assert.deepEqual(kinds, ["created", "definition", "definition"]);
});

test("a definition edit keeps the reader's seeds, and publishing and unpublishing flip the state and nothing else", options, async () => {
  const item = await insertItem(db, { title: "A seed" });
  const { zone } = await writes.create(alice, body({ seeds: { positive: [item.publicId], negative: [] } }));
  const edited = await writes.update(alice, zone.id, { definition: definitionBody({ scope: "改过的范围" }), expectedRevision: zone.revision });
  assert.deepEqual((await rowOf(zone.id)).definition.seeds.positive, [item.publicId]);
  const published = await writes.update(alice, zone.id, { published: true, expectedRevision: edited.zone.revision });
  assert.equal(published.zone.published, true);
  let row = await rowOf(zone.id);
  assert.deepEqual([row.state, row.visibility], ["published", "platform"]);
  const back = await writes.update(alice, zone.id, { published: false, expectedRevision: published.zone.revision });
  assert.equal(back.zone.published, false);
  row = await rowOf(zone.id);
  assert.deepEqual([row.state, row.visibility, row.definition_version], ["draft", "platform", 2]);
  assert.deepEqual((await changesOf(zone.id)).map((change) => change.kind), ["created", "definition", "published", "unpublished"]);
});

test("another reader cannot see, change, delete, preview from or give feedback on a private zone; a platform zone is not a reader's to change", options, async () => {
  const { zone } = await writes.create(alice, body());
  await assert.rejects(writes.update(bob, zone.id, { title: "x", expectedRevision: 1 }), { status: 404 });
  await assert.rejects(writes.remove(bob, zone.id), { status: 404 });
  await assert.rejects(writes.feedback(bob, zone.id, "x".repeat(12), { kind: "not-in" }), { status: 404 });
  await assert.rejects(writes.draft(bob, { text: "改一下", baseZoneId: zone.id }), { status: 404 });
  assert.ok(await rowOf(zone.id), "the zone is still there");
  await db.query(`INSERT INTO evimed_frontier.evidence_zones(id, user_id, kind, title, state, visibility, slug, zone_type, scope_zh, definition, definition_version, lifecycle)
    VALUES ('ez_platform', 'evimed-evidence-center', 'official', '平台专区', 'published', 'internet', 'platform-zone', 'drug-indication', '范围', $1::jsonb, 1, 'active')`,
  [JSON.stringify({ keywords: [{ label: "x", terms: [] }] })]);
  await assert.rejects(writes.update(alice, "ez_platform", { title: "改名", expectedRevision: 1 }), { status: 403, code: "evidence_owner_required" });
  await assert.rejects(writes.remove(alice, "platform-zone"), { status: 403, code: "evidence_owner_required" });
  assert.equal((await rowOf("ez_platform")).title, "平台专区");
  assert.equal(await writes.isTopicZone(bob, "platform-zone"), true, "a platform zone is read by its slug too");
});

test("the owner deletes a zone with its items and follows and its history stays", options, async () => {
  const item = await insertItem(db, { title: "An item" });
  const { zone } = await writes.create(alice, body({ published: true }));
  await db.query("INSERT INTO evimed_frontier.zone_items(zone_id, item_id, state, via, role) VALUES ($1, $2, 'in', 'tag', 'research')", [zone.id, item.id]);
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id) VALUES ('bob', $1)", [zone.id]);
  assert.deepEqual(await writes.remove(alice, zone.id), { deleted: true });
  assert.equal(await rowOf(zone.id), undefined);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.zone_items")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_zone_follows")).rows[0].n, 0);
  assert.deepEqual((await changesOf(zone.id)).map((change) => change.kind), ["created", "deleted"], "no foreign key: the history outlives the zone");
  assert.ok((await db.query("SELECT 1 FROM evimed_frontier.items WHERE id = $1", [item.id])).rowCount, "the feed's items are not the zone's");
  await assert.rejects(writes.remove(alice, zone.id), { status: 404 });
});

test("a reader's word on an item goes to the data plane with who they are to the zone; an item they cannot read is not found", options, async () => {
  const mine = (await writes.create(alice, body({ published: true }))).zone;
  const item = await insertItem(db, { title: "An item" });
  const hidden = await insertItem(db, { title: "Hidden", state: "scored" });
  assert.deepEqual(await writes.feedback(alice, mine.id, item.publicId, { kind: "not-in" }), { accepted: true });
  assert.deepEqual(await writes.feedback(bob, mine.id, item.publicId, { kind: "more-like" }), { accepted: true });
  assert.deepEqual(plane.told.feedback, [
    { zoneId: mine.id, itemRowId: item.id, kind: "not-in", actor: { userId: "alice", isOwner: true } },
    { zoneId: mine.id, itemRowId: item.id, kind: "more-like", actor: { userId: "bob", isOwner: false } },
  ]);
  await assert.rejects(writes.feedback(alice, mine.id, hidden.publicId, { kind: "not-in" }), { status: 404 });
  await assert.rejects(writes.feedback(alice, mine.id, item.publicId, { kind: "block" }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.feedback(alice, mine.id, item.publicId, { kind: "not-in", extra: 1 }), { status: 400 });
  const alone = createEvidenceZoneWrites({ database: db, zones, config: {} });
  await assert.rejects(alone.feedback(alice, mine.id, item.publicId, { kind: "not-in" }), { status: 503, code: "evidence_feedback_unavailable" });
});

test("drafting reads the zone and the item the reader started from, and the words are bounded", options, async () => {
  const seen = [];
  editor = { available: true, async callJson(messages) { seen.push(JSON.parse(messages[1].content)); return { draft: { title: "草稿", type: "drug-indication", keywords: [{ label: "减重", terms: ["肥胖"] }], scope: "范围", specialties: [] } }; } };
  draft = createEvidenceZoneDraft({ editor, membership: plane, database: db });
  writes = createEvidenceZoneWrites({ database: db, zones, membership: plane, draft, config: {} });
  const item = await insertItem(db, { title: "Semaglutide in obesity", entities: { drugs: ["semaglutide"], diseases: ["obesity"], orgs: ["Novo"] } });
  const { zone } = await writes.create(alice, body());
  const result = await writes.draft(alice, { text: "加上心血管结局", baseZoneId: zone.id, fromItemId: item.publicId });
  assert.equal(result.draft.title, "草稿");
  assert.equal(seen[0].baseZone.title, "GLP-1 受体激动剂减重");
  assert.equal(seen[0].fromItem.title, "Semaglutide in obesity");
  assert.deepEqual(seen[0].fromItem.entities.drugs, ["semaglutide"]);
  await assert.rejects(writes.draft(alice, { text: "x".repeat(201) }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.draft(alice, { text: "" }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.draft(alice, {}), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.draft(alice, { text: "y", fromItemId: "unknown000000" }), { status: 404 });
  await assert.rejects(writes.draft(alice, { text: 7 }), { status: 400 });
  await assert.rejects(writes.draft(alice, { text: "y", extra: true }), { status: 400 });
  assert.equal(seen.length, 1, "a refused request never reaches the model");
  const empty = await writes.draft(alice, { text: "", fromItemId: item.publicId });
  assert.ok(empty.draft.title, "an item alone is enough to start from");
});

test("drafting from a zone hands the model only what the reader may read of it: the full definition to its owner and an operator, the title, keywords and scope to anyone else", options, async () => {
  const seen = [];
  editor = { available: true, async callJson(messages) { seen.push(JSON.parse(messages[1].content)); return { draft: { title: "草稿", type: "drug-indication", keywords: [{ label: "减重", terms: ["肥胖"] }], scope: "范围", specialties: [] } }; } };
  draft = createEvidenceZoneDraft({ editor, membership: plane, database: db });
  const drafting = (config = {}) => createEvidenceZoneWrites({ database: db, zones, membership: plane, draft, config });
  const own = await drafting().create(alice, body({ definition: definitionBody({ include: "只要随机对照试验", exclude: "不要动物实验", excludeTerms: ["小鼠"] }) }));
  // The platform's zone, published to the internet: its criteria are served to nobody but an operator.
  await db.query(`INSERT INTO evimed_frontier.evidence_zones(id, user_id, kind, title, state, visibility, slug, zone_type, scope_zh, group_label, specialties, definition, definition_version, lifecycle)
    VALUES ('ez_platform', 'evimed-evidence-center', 'official', '平台专区', 'published', 'internet', 'platform-zone', 'drug-indication', '平台范围', '肥胖', '{endocrinology}', $1::jsonb, 1, 'active')`,
  [JSON.stringify({ type: "drug-indication", keywords: [{ label: "平台词", terms: ["隐藏的同义词"], tagIds: [7], entityKeys: [] }], perspective: null, scope: "平台范围", include: "隐藏的纳入标准", exclude: "隐藏的排除标准", excludeTerms: ["隐藏的排除词"], specialties: ["endocrinology"], group: "肥胖" })]);

  await drafting().draft(alice, { text: "", baseZoneId: "ez_platform" });
  const reader = seen.pop().baseZone;
  assert.equal(reader.title, "平台专区");
  assert.deepEqual(reader.definition.keywords, [{ label: "平台词", terms: [] }], "the keywords' labels, as the zone's detail shows them");
  assert.equal(reader.definition.scope, "平台范围");
  const asText = JSON.stringify(reader);
  for (const hidden of ["隐藏的纳入标准", "隐藏的排除标准", "隐藏的排除词", "隐藏的同义词"]) assert.equal(asText.includes(hidden), false, `${hidden} stays on the platform's side`);

  await drafting({ operatorUsers: ["bob"] }).draft(bob, { text: "", baseZoneId: "platform-zone" });
  assert.equal(JSON.stringify(seen.pop().baseZone).includes("隐藏的纳入标准"), true, "an operator reads the definition, so the draft may be built on it");

  await drafting().draft(alice, { text: "加上心血管结局", baseZoneId: own.zone.id });
  const mine = seen.pop().baseZone.definition;
  assert.equal(mine.include, "只要随机对照试验");
  assert.deepEqual(mine.excludeTerms, ["小鼠"], "the owner's own zone is handed over in full");

  // A published zone of another reader: its title and scope, never its criteria.
  await drafting().update(alice, own.zone.id, { published: true, expectedRevision: own.zone.revision });
  await drafting().draft(bob, { text: "", baseZoneId: own.zone.id });
  const theirs = seen.pop().baseZone;
  assert.equal(theirs.definition.include, "");
  assert.deepEqual(theirs.definition.excludeTerms, []);
  assert.equal(theirs.definition.scope, "成人减重的疗效与安全性");
});

test("preview takes a definition the reader edited by hand and answers the shape the page reads", options, async () => {
  const { preview } = await writes.preview(alice, { definition: definitionBody() });
  assert.deepEqual(Object.keys(preview).sort(), ["band", "borderline", "count30", "perWeek", "recent"]);
  assert.equal(preview.count30, 8);
  assert.equal(preview.band, "narrow");
  await assert.rejects(writes.preview(alice, { definition: definitionBody({ keywords: [] }) }), { status: 400, code: "evidence_invalid" });
  await assert.rejects(writes.preview(alice, { definition: definitionBody(), zone: 1 }), { status: 400 });
});

test("the typed follows that existed become unpublished zones once, and their matches and the follows go", options, async () => {
  await db.query(`INSERT INTO evimed_frontier.user_follows(user_id, kind, key, label, query) VALUES
    ('alice', 'query', '司美格鲁肽 和胰腺炎', '司美格鲁肽 和胰腺炎', $1::jsonb),
    ('bob', 'query', 'long covid', 'long covid', $2::jsonb),
    ('bob', 'query', 'nct01234567', 'NCT01234567', $3::jsonb),
    ('bob', 'drug', 'semaglutide', '司美格鲁肽', NULL)`, [
    JSON.stringify({ kind: "question", basis: "model", concepts: [
      { type: "drug", keys: ["drug:semaglutide"], terms_zh: ["司美格鲁肽"], terms_en: ["semaglutide"] },
      { type: "disease", keys: ["disease:pancreatitis"], terms_zh: ["胰腺炎"], terms_en: ["pancreatitis"] }] }),
    JSON.stringify({ kind: "topic", basis: "typed", concepts: [{ type: "topic", keys: [], terms_zh: [], terms_en: ["long covid"] }] }),
    JSON.stringify({ kind: "trial", basis: "typed", concepts: [{ type: "trial", keys: ["reg:NCT01234567"], terms_zh: [], terms_en: [] }] }),
  ]);
  const item = await insertItem(db, { title: "match" });
  await db.query("INSERT INTO evimed_frontier.follow_matches(follow_id, item_id, score) SELECT id, $1, 1 FROM evimed_frontier.user_follows WHERE kind = 'query'", [item.id]);
  await writes.ready();
  const made = (await db.query("SELECT * FROM evimed_frontier.evidence_zones ORDER BY title")).rows;
  assert.equal(made.length, 3);
  const pancreatitis = made.find((row) => row.title === "司美格鲁肽 和胰腺炎");
  assert.deepEqual([pancreatitis.user_id, pancreatitis.kind, pancreatitis.state, pancreatitis.zone_type, pancreatitis.lifecycle], ["alice", "user", "draft", "drug-indication", "active"]);
  assert.deepEqual(pancreatitis.definition.keywords.map((keyword) => [keyword.label, keyword.terms, keyword.entityKeys]), [
    ["司美格鲁肽", ["司美格鲁肽", "semaglutide"], ["drug:semaglutide"]], ["胰腺炎", ["胰腺炎", "pancreatitis"], ["disease:pancreatitis"]]]);
  assert.equal(pancreatitis.scope_zh, "司美格鲁肽 和胰腺炎");
  const trial = made.find((row) => row.title === "NCT01234567");
  assert.deepEqual(trial.definition.keywords.map((keyword) => [keyword.label, keyword.terms, keyword.entityKeys]), [["NCT01234567", ["NCT01234567"], []]], "a registry number is a name, not an entity key");
  assert.equal(made.find((row) => row.title === "long covid").zone_type, "disease-strategy");
  assert.deepEqual((await db.query("SELECT kind FROM evimed_frontier.user_follows")).rows, [{ kind: "drug" }], "typed follows are gone, the other kinds stay");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.follow_matches")).rows[0].n, 0);
  assert.ok((await db.query("SELECT state_version FROM evimed_frontier.user_prefs WHERE user_id = 'alice'")).rows[0].state_version >= 1, "the reader's lists move on");
  assert.ok((await changesOf(pancreatitis.id)).every((change) => change.actor === "migration"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plane.told.afterSave.length, 3, "the data plane collects each");
  // Once: a second composition finds the marker and changes nothing, even when a typed follow has appeared since.
  await db.query("INSERT INTO evimed_frontier.user_follows(user_id, kind, key, label, query) VALUES ('alice', 'query', 'late', 'late', '{}'::jsonb)");
  compose();
  await writes.ready();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.evidence_zones")).rows[0].n, 3);
  assert.ok((await db.query("SELECT 1 FROM evimed_frontier.meta WHERE key = $1", [TYPED_FOLLOWS_MARKER])).rowCount);
});

test("the definition of a typed follow is one keyword per concept; a follow with no concept is its words", options, async () => {
  const none = definitionFromTypedFollow("肠道菌群与抑郁", { concepts: [] });
  assert.deepEqual(none.keywords.map((keyword) => keyword.label), ["肠道菌群与抑郁"]);
  assert.equal(none.scope, "肠道菌群与抑郁");
  assert.equal(definitionFromTypedFollow("x", null).type, "disease-strategy");
});

test("following something typed makes a zone of the words: drafted, unpublished, the same words the same zone, the reader's limit applies", options, async () => {
  const asked = [];
  editor = { available: true, async callJson(messages) { asked.push(JSON.parse(messages[1].content).typed); return { draft: { title: "长新冠", type: "disease-strategy", keywords: [{ label: "长新冠", terms: ["long covid", "PASC"] }, { label: "康复", terms: ["康复"] }], scope: "长新冠的康复", specialties: ["infectious-disease"] } }; } };
  draft = createEvidenceZoneDraft({ editor, membership: plane, database: db });
  writes = createEvidenceZoneWrites({ database: db, zones, membership: plane, draft, config: { evidenceUserZonesMax: 2 } });
  const first = await writes.createFromWords(alice, "  长新冠   康复 ");
  assert.equal(first.zone.published, false);
  assert.equal(first.zone.title, "长新冠");
  assert.deepEqual(asked, ["长新冠 康复"]);
  const again = await writes.createFromWords(alice, "长新冠 康复");
  assert.equal(again.zone.id, first.zone.id);
  assert.equal(asked.length, 1, "the same words are not drafted again");
  const [one, two] = await Promise.all([writes.createFromWords(bob, "并发的话"), writes.createFromWords(bob, "并发的话")]);
  assert.equal(one.zone.id, two.zone.id, "two requests for the same words are one zone");
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM evimed_frontier.evidence_zones WHERE user_id = 'bob'")).rows[0].n), 1);
  await writes.createFromWords(alice, "第二个话题");
  await assert.rejects(writes.createFromWords(alice, "第三个话题"), { status: 409, code: "evidence_user_zone_limit" });
  await assert.rejects(writes.createFromWords(alice, "   "), { status: 400, code: "evidence_invalid" });
});

test("POST /follows kind query is a zone: the feed's service answers the zone and no follow, and refuses a muted one", options, async () => {
  const service = new FrontierService({ database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY), config: { frontierEnabled: true, frontierAudience: "all" }, profiles: null });
  await assert.rejects(service.createFollow(alice, { kind: "query", label: "长新冠" }), { status: 404, code: "frontier_zones_unavailable" });
  editor = { available: true, async callJson() { return { draft: { title: "长新冠", type: "disease-strategy", keywords: [{ label: "长新冠", terms: [] }], scope: "长新冠" } }; } };
  draft = createEvidenceZoneDraft({ editor, membership: plane, database: db });
  writes = createEvidenceZoneWrites({ database: db, zones, membership: plane, draft, config: {} });
  service.zoneFromWords = (user, words) => writes.createFromWords(user, words);
  const answer = await service.createFollow(alice, { kind: "query", label: "长新冠" });
  assert.equal(answer.follow, null);
  assert.equal(answer.zone.title, "长新冠");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM evimed_frontier.user_follows WHERE kind = 'query'")).rows[0].n, 0, "no follow row");
  await assert.rejects(service.createFollow(alice, { kind: "query", label: "x", muted: true }), { code: "frontier_follow_invalid" });
  const other = await service.createFollow(alice, { kind: "topic", key: "heart failure", label: "heart failure" });
  assert.equal(other.follow.kind, "topic", "the other kinds are follows as before");
});
