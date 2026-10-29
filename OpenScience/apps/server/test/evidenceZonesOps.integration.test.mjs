// The operators' script for the topic zones against a real PostgreSQL: the list and the history, an action of the planner taken back,
// a definition set from a file, a zone taken offline, an item pinned and excluded, a zone deleted - dry runs change nothing, applied
// writes are recorded under the operator's name.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EvidenceZoneService } from "../src/evidenceZoneService.mjs";
import { createEvidenceZonePlanner } from "../src/evidenceZonePlanner.mjs";
import { insertTopicZone } from "../src/evidenceZoneWrites.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { parseArguments, runCommand } from "../../../scripts/ops/evidence-zones.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
const MONDAY = new Date("2026-10-25T19:30:00Z");
const DAY = 24 * 3_600_000;
let isolated, db, zones;

const run = (...argv) => runCommand(db, parseArguments(argv));
const zoneRow = async (id) => (await db.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id = $1", [id])).rows[0];
const changes = async (id) => (await db.query("SELECT id::text AS id, kind, actor, detail FROM evimed_frontier.zone_changes WHERE zone_id = $1 ORDER BY zone_changes.id", [id])).rows;
const definition = (title, labels = [title, "治疗"]) => ({ version: 1, type: "drug-indication", keywords: labels.map((label) => ({ label, terms: [label], tagIds: [], entityKeys: [] })),
  perspective: null, scope: `${title}的范围`, include: "", exclude: "", excludeTerms: [], specialties: ["endocrinology"], group: "测试", seeds: { positive: [], negative: [] } });

async function platformZone(slug, title, { lifecycle = "active", state = "published", userId = PLATFORM_PUBLISHER_USER_ID, kind = "official" } = {}) {
  const id = `ez_${slug}`;
  await db.transaction((client) => insertTopicZone(client, { id, userId, kind, state, visibility: kind === "official" ? "internet" : "platform", title, definition: definition(title), slug }));
  await db.query("UPDATE evimed_frontier.evidence_zones SET lifecycle = $2, created_at = $3 WHERE id = $1", [id, lifecycle, new Date(MONDAY.getTime() - 400 * DAY).toISOString()]);
  return id;
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "zops");
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
  await db.query("TRUNCATE evimed_frontier.evidence_zones, evimed_frontier.items, evimed_frontier.zone_changes CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await db.query("DELETE FROM evimed_frontier.meta WHERE key IN ('zone_planner_seed', 'zone_planner_weekly')");
  await insertSource(db, "nejm");
});

test("the command line is checked: a command, its arguments, and an operator for any applied write", () => {
  assert.throws(() => parseArguments([]), /Unknown command/);
  assert.throws(() => parseArguments(["explode"]), /Unknown command/);
  assert.throws(() => parseArguments(["delete"]), /takes 1 argument/);
  assert.throws(() => parseArguments(["delete", "ez_x", "--apply"]), /--operator/);
  assert.throws(() => parseArguments(["pin", "ez_x"]), /takes 2 arguments/);
  assert.throws(() => parseArguments(["undo", "abc"]), /change id/);
  assert.throws(() => parseArguments(["list", "--kind", "nope"]), /--kind/);
  assert.throws(() => parseArguments(["list", "--wat"]), /Unknown argument/);
  assert.throws(() => parseArguments(["set-definition", "ez_x"]), /--file/);
  assert.throws(() => parseArguments(["delete", "bad id!"]), /id or slug/);
  assert.equal(parseArguments(["delete", "ez_x", "--apply", "--operator", "ops.one"]).apply, true);
});

test("the list shows each zone with its life, its followers and its items by state, filtered by kind and lifecycle", options, async () => {
  const platform = await platformZone("alpha", "甲专区");
  const quiet = await platformZone("beta", "乙专区", { lifecycle: "quiet" });
  const mine = await platformZone("mine", "读者的专区", { kind: "user", userId: "alice", state: "draft" });
  await db.query("INSERT INTO evimed_frontier.evidence_zones(id, user_id, title) VALUES ('ez_container', 'alice', '卡片容器')");
  const item = await insertItem(db, { title: "An item" });
  await db.query("INSERT INTO evimed_frontier.zone_items(zone_id, item_id, state, via, role) VALUES ($1, $2, 'in', 'tag', 'research')", [platform, item.id]);
  await db.query("INSERT INTO evimed_frontier.evidence_zone_follows(user_id, zone_id) VALUES ('bob', $1)", [platform]);
  const all = (await run("list")).zones;
  assert.deepEqual(all.map((zone) => zone.id).sort(), [platform, quiet, mine].sort(), "a container of cards is not a topic zone");
  const first = all.find((zone) => zone.id === platform);
  assert.deepEqual([first.follows, first.items, first.lifecycle, first.published], [1, { in: 1 }, "active", true]);
  assert.deepEqual((await run("list", "--kind", "user")).zones.map((zone) => zone.id), [mine]);
  assert.deepEqual((await run("list", "--lifecycle", "quiet")).zones.map((zone) => zone.id), [quiet]);
});

test("the history of a zone is read by slug, newest first", options, async () => {
  const id = await platformZone("alpha", "甲专区");
  await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, 'created', 'planner', '{}'), ($1, 'quiet', 'planner', '{\"fromLifecycle\":\"active\"}')", [id]);
  const result = await run("changes", "alpha", "--limit", "1");
  assert.deepEqual(result.zone, { id, title: "甲专区" });
  assert.deepEqual(result.changes.map((change) => change.kind), ["quiet"]);
});

test("a planner action is undone from what it wrote: a dry run changes nothing, an applied one is the operator's and is recorded", options, async () => {
  const id = await platformZone("alpha", "甲专区", { lifecycle: "quiet" });
  await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, 'quiet', 'planner', '{\"fromLifecycle\":\"active\"}')", [id]);
  const change = (await changes(id)).at(-1);
  const dry = await run("undo", change.id);
  assert.deepEqual([dry.ok, dry.applied, dry.plan.length], [true, false, 1]);
  assert.equal((await zoneRow(id)).lifecycle, "quiet");
  const applied = await run("undo", change.id, "--apply", "--operator", "ops.one");
  assert.equal(applied.applied, true);
  assert.equal((await zoneRow(id)).lifecycle, "active");
  const last = (await changes(id)).at(-1);
  assert.deepEqual([last.kind, last.actor, last.detail.undoes], ["active", "operator:ops.one", change.id]);
  assert.equal((await run("undo", "999999")).ok, false);
  const redefinition = await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, 'definition', 'planner', '{}') RETURNING id::text AS id", [id]);
  assert.match((await run("undo", redefinition.rows[0].id)).reason, /cannot be undone/);
});

test("the planner's own split and merge are taken back with what they made and moved", options, async () => {
  await db.query("INSERT INTO evimed_frontier.meta(key, value) VALUES ('zone_planner_seed', '{}'::jsonb)");
  const wide = await platformZone("wide", "太宽的");
  for (let week = 1; week <= 4; week += 1) {
    const made = [];
    for (let count = 0; count < 61; count += 1) {
      const at = new Date(MONDAY.getTime() - week * 7 * DAY + 2 * DAY + count * 1000).toISOString();
      made.push(await insertItem(db, { title: `w${week} #${count}`, visibleAt: at, timelineAt: at, publishedAt: at }));
    }
    await db.query("INSERT INTO evimed_frontier.zone_items(zone_id, item_id, state, via, role) SELECT $1, x, 'in', 'tag', 'research' FROM unnest($2::bigint[]) x", [wide, made.map((item) => item.id)]);
  }
  const draft = (title) => ({ title, type: "drug-indication", keywords: [{ label: title, terms: [] }, { label: "治疗", terms: [] }], scope: `${title}的范围`, specialties: ["endocrinology"] });
  const editor = { available: true, async callJson() { return { actions: [{ action: "split", zone: wide, perWeek: 61, into: [{ slug: "n1", draft: draft("窄一") }, { slug: "n2", draft: draft("窄二") }], reason: "拆开" }] }; } };
  const planner = createEvidenceZonePlanner({ database: db, editor, zones, now: () => MONDAY, publisherUserId: PLATFORM_PUBLISHER_USER_ID, config: { evidenceZonePlannerEnabled: true } });
  const result = await planner.weeklyIfDue(MONDAY);
  assert.equal(result.applied, 1);
  assert.equal((await zoneRow(wide)).lifecycle, "archived");
  const split = (await changes(wide)).at(-1);
  assert.equal(split.kind, "split");
  const made = split.detail.into;
  assert.equal(made.length, 2);
  const undone = await run("undo", split.id, "--apply", "--operator", "ops");
  assert.equal(undone.plan.length, 3);
  assert.equal((await zoneRow(wide)).lifecycle, "active");
  for (const zoneId of made) assert.equal(await zoneRow(zoneId), undefined, "what the split made is gone");
  assert.deepEqual((await changes(made[0])).map((change) => [change.kind, change.actor]), [["created", "planner"], ["deleted", "operator:ops"]]);
  // A merge: the partner is archived and its followers moved; undone, the partner returns and is followed again.
  const keep = await platformZone("keep", "保留的");
  const gone = await platformZone("gone", "并入的", { lifecycle: "archived" });
  await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, 'merged', 'planner', $2::jsonb)", [gone, JSON.stringify({ into: keep, fromLifecycle: "active", movedFollowers: ["alice", "bob"] })]);
  const merged = (await changes(gone)).at(-1);
  await run("undo", merged.id, "--apply", "--operator", "ops");
  assert.equal((await zoneRow(gone)).lifecycle, "active");
  assert.deepEqual((await db.query("SELECT user_id FROM evimed_frontier.evidence_zone_follows WHERE zone_id = $1 ORDER BY user_id", [gone])).rows.map((row) => row.user_id), ["alice", "bob"]);
});

test("a created zone's creation is undone by deleting it", options, async () => {
  const id = await platformZone("alpha", "甲专区");
  await db.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, 'created', 'planner', '{}')", [id]);
  const created = (await changes(id)).find((change) => change.actor === "planner");
  await run("undo", created.id, "--apply", "--operator", "ops");
  assert.equal(await zoneRow(id), undefined);
  assert.equal((await changes(id)).at(-1).kind, "deleted");
});

test("a definition is set from a file: checked, the names resolved to the tree's tags, versioned, the seeds kept; a dry run changes nothing", options, async () => {
  const id = await platformZone("alpha", "甲专区");
  await db.query("UPDATE evimed_frontier.evidence_zones SET definition = jsonb_set(definition, '{seeds,positive}', '[\"abc\"]'::jsonb) WHERE id = $1", [id]);
  await db.query("INSERT INTO evimed_frontier.tags(slug, name, name_en, kind, specialties, state, origin) VALUES ('ezt-term-alpha', '试验专用词条甲', 'ez test term alpha', 'disease', '{endocrinology}', 'active', 'seed')");
  const tagId = (await db.query("SELECT id FROM evimed_frontier.tags WHERE slug = 'ezt-term-alpha'")).rows[0].id;
  const file = new URL(`file://${(await import("node:os")).tmpdir()}/evidence-zone-definition-${process.pid}.json`);
  const fs = await import("node:fs");
  fs.writeFileSync(file, JSON.stringify({ type: "disease-strategy", keywords: [{ label: "试验专用词条甲", terms: ["ez test term alpha"] }, { label: "无此词条", terms: [] }], scope: "新的范围", include: "i", exclude: "e", excludeTerms: [], specialties: ["endocrinology"], group: "肥胖" }));
  try {
    const dry = await run("set-definition", id, "--file", file.pathname);
    assert.deepEqual([dry.applied, dry.from, dry.to, dry.keywords], [false, 1, 2, [["试验专用词条甲", 1], ["无此词条", 0]]]);
    assert.equal((await zoneRow(id)).definition_version, 1);
    await run("set-definition", id, "--file", file.pathname, "--title", "肥胖手术", "--apply", "--operator", "ops");
    const row = await zoneRow(id);
    assert.deepEqual([row.definition_version, row.title, row.zone_type, row.scope_zh], [2, "肥胖手术", "disease-strategy", "新的范围"]);
    assert.deepEqual(row.definition.keywords[0].tagIds, [Number(tagId)], "the name resolves through the tree");
    assert.deepEqual(row.definition.seeds.positive, ["abc"]);
    assert.deepEqual((await changes(id)).at(-1).actor, "operator:ops");
    fs.writeFileSync(file, JSON.stringify({ type: "disease-strategy", keywords: [] }));
    const bad = await run("set-definition", id, "--file", file.pathname, "--apply", "--operator", "ops");
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /keywords/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a published reader's zone goes offline, an item is pinned and excluded, and a zone is deleted with its history left", options, async () => {
  const mine = await platformZone("mine", "读者的专区", { kind: "user", userId: "alice" });
  const dry = await run("offline", mine);
  assert.equal(dry.applied, false);
  assert.equal((await zoneRow(mine)).state, "published");
  await run("offline", mine, "--apply", "--operator", "ops");
  assert.equal((await zoneRow(mine)).state, "draft");
  assert.deepEqual((await changes(mine)).at(-1), { id: (await changes(mine)).at(-1).id, kind: "unpublished", actor: "operator:ops", detail: { reason: "taken offline" } });
  const item = await insertItem(db, { title: "An item", genre: undefined });
  await db.query("UPDATE evimed_frontier.items SET genre = 'guideline' WHERE id = $1", [item.id]);
  await run("pin", mine, item.publicId, "--apply", "--operator", "ops");
  let pair = (await db.query("SELECT state, relevance, role, via, decided_by FROM evimed_frontier.zone_items WHERE zone_id = $1", [mine])).rows[0];
  assert.deepEqual(pair, { state: "pinned", relevance: "core", role: "guideline", via: "editor", decided_by: "operator:ops" });
  await run("exclude", mine, item.publicId, "--apply", "--operator", "ops");
  pair = (await db.query("SELECT state, relevance FROM evimed_frontier.zone_items WHERE zone_id = $1", [mine])).rows[0];
  assert.deepEqual(pair, { state: "excluded", relevance: null });
  assert.equal((await run("pin", mine, "nonexistent0000", "--apply", "--operator", "ops")).ok, false);
  const before = Number((await db.query("SELECT version FROM evimed_frontier.evidence_zone_meta")).rows[0].version);
  await run("delete", mine);
  assert.ok(await zoneRow(mine), "a dry run deletes nothing");
  await run("delete", mine, "--apply", "--operator", "ops");
  assert.equal(await zoneRow(mine), undefined);
  assert.equal((await changes(mine)).at(-1).kind, "deleted");
  assert.ok(Number((await db.query("SELECT version FROM evimed_frontier.evidence_zone_meta")).rows[0].version) > before, "readers' lists reload");
  await assert.rejects(run("delete", "ez_missing", "--apply", "--operator", "ops"), { code: "zone_not_found" });
});
