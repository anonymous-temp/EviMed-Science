import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { FrontierService, frontierVocabularyView } from "../src/frontierService.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { TEST_VOCABULARY, insertItem, insertSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
let db, isolated, service;
const alice = { id: "alice" }, bob = { id: "bob" };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "follows");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(db, { dimension: 1024 });
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development'),('bob','Bob','development')");
  await db.query("INSERT INTO evimed_frontier.glossary(kind,term_en,term_zh,origin) VALUES('drug','semaglutide','司美格鲁肽','test')");
});
after(async () => { await db?.close(); await isolated?.drop(); });
beforeEach(async () => {
  if (!db) return;
  await db.query("TRUNCATE evimed_frontier.items, evimed_frontier.user_follows, evimed_frontier.user_prefs CASCADE");
  await db.query("DELETE FROM evimed_frontier.sources");
  await insertSource(db, "nejm"); await insertSource(db, "fda", { source_type: "regulator" });
  service = new FrontierService({ database: db, vocabulary: frontierVocabularyView(TEST_VOCABULARY),
    config: { frontierEnabled: true, frontierAudience: "all" }, profiles: null });
});
const list = (user, query) => service.listItems(user, new URLSearchParams({ view: "all", ...query }));

test("owned topic follows scope the existing search without a memory profile", options, async () => {
  const wanted = await insertItem(db, { title: "Semaglutide obesity trial" });
  await insertItem(db, { title: "Unrelated heart failure trial" });
  const { follow } = await service.createFollow(alice, { kind: "topic", key: "Semaglutide" });
  const page = await list(alice, { follow: follow.id });
  assert.deepEqual(page.body.items.map((item) => item.id), [wanted.publicId]);
  await assert.rejects(list(bob, { follow: follow.id }), { code: "frontier_follow_not_found" });
});

test("drug follows share bilingual canonical identity, and every mute outranks a positive follow", options, async () => {
  const wanted = await insertItem(db, { title: "Semaglutide study", specialties: ["cardiology"] });
  const unrelated = await insertItem(db, { title: "Dapagliflozin study" });
  await db.query("UPDATE evimed_frontier.items SET entity_keys=$1 WHERE id=$2", [["drug:semaglutide"], wanted.id]);
  await db.query("UPDATE evimed_frontier.items SET entity_keys=$1 WHERE id=$2", [["drug:dapagliflozin"], unrelated.id]);
  const first = await service.createFollow(alice, { kind: "drug", key: "司美格鲁肽" });
  const second = await service.createFollow(alice, { kind: "drug", key: "semaglutide" });
  assert.equal(first.follow.id, second.follow.id);
  assert.equal(second.follow.key, "drug:semaglutide");
  assert.deepEqual((await list(alice, { follow: first.follow.id })).body.items.map((item) => item.id), [wanted.publicId]);
  await service.createFollow(alice, { kind: "specialty", key: "cardiology", muted: true });
  assert.deepEqual((await list(alice, { follow: first.follow.id })).body.items, []);
  assert.equal((await list(bob, {})).body.items.length, 2);
});

test("muted topics filter lists and follow changes invalidate only that reader's cursor", options, async () => {
  for (let n = 0; n < 3; n++) await insertItem(db, { title: `Semaglutide result ${n}`, timelineAt: `2026-09-22T0${n}:00:00Z` });
  const { follow } = await service.createFollow(alice, { kind: "source", key: "nejm" });
  const first = await list(alice, { follow: follow.id, limit: "1" });
  assert.ok(first.body.nextCursor);
  await service.createFollow(bob, { kind: "topic", key: "unrelated" });
  assert.equal((await list(alice, { follow: follow.id, limit: "1", cursor: first.body.nextCursor })).body.items.length, 1);
  await service.createFollow(alice, { kind: "topic", key: "semaglutide", muted: true });
  await assert.rejects(list(alice, { follow: follow.id, limit: "1", cursor: first.body.nextCursor }), { code: "invalid_cursor" });
  assert.deepEqual((await list(alice, {})).body.items, []);
  assert.equal((await list(bob, {})).body.items.length, 3);
});
