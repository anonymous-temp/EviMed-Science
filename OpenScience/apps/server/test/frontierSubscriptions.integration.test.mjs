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
  assert.equal(second.follow.key, "semaglutide");
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

test("event follows resolve old aliases and legacy drug names are updated without duplicates", options, async () => {
  const item = await insertItem(db, { title: "A trial milestone" });
  const result = await db.query("INSERT INTO evimed_frontier.events(public_id,title_zh,lane,first_at,last_at) VALUES('eventnew12345','Trial','evidence',now(),now()) RETURNING id");
  await db.query("INSERT INTO evimed_frontier.event_aliases(public_id,event_id) VALUES('eventold12345',$1)", [result.rows[0].id]);
  await db.query("UPDATE evimed_frontier.items SET event_id=$1 WHERE id=$2", [result.rows[0].id, item.id]);
  const follow = (await service.createFollow(alice, { kind: "event", key: "eventold12345" })).follow;
  assert.deepEqual((await list(alice, { follow: follow.id })).body.items.map((row) => row.id), [item.publicId]);
  await db.query("INSERT INTO evimed_frontier.user_follows(user_id,kind,key,label) VALUES('alice','drug','司美格鲁肽','Legacy Chinese')");
  const drug = await service.createFollow(alice, { kind: "drug", key: "semaglutide" });
  assert.equal(drug.follow.key, "semaglutide");
  assert.equal((await service.listFollows(alice)).follows.filter((row) => row.kind === "drug").length, 1);
});

test("an event mute leaves unrelated unclustered items visible", options, async () => {
  const eventItem = await insertItem(db, { title: "Muted trial" });
  const otherItem = await insertItem(db, { title: "Unclustered independent report" });
  const event = await db.query("INSERT INTO evimed_frontier.events(public_id,title_zh,lane,first_at,last_at) VALUES('eventmute1234','Trial','evidence',now(),now()) RETURNING id");
  await db.query("UPDATE evimed_frontier.items SET event_id=$1 WHERE id=$2", [event.rows[0].id, eventItem.id]);
  await service.createFollow(alice, { kind: "event", key: "eventmute1234", muted: true });
  assert.deepEqual((await list(alice, {})).body.items.map((row) => row.id), [otherItem.publicId]);
});

for (const kind of ["drug", "topic", "event"]) test(`a ${kind} mute applies to cached and reranked recommendations`, options, async () => {
  const { FrontierProfiles } = await import("../src/frontierProfiles.mjs");
  const wanted = await insertItem(db, { title: "Semaglutide unmuted observation" });
  const muted = await insertItem(db, { title: "Semaglutide pilot signal" });
  await db.query("UPDATE evimed_frontier.items SET entity_keys='{drug:semaglutide}' WHERE id=$1", [muted.id]);
  const ev = await db.query("INSERT INTO evimed_frontier.events(public_id,title_zh,lane,first_at,last_at) VALUES($1,'Trial','evidence',now(),now()) RETURNING id", [`evt${kind}123456`]);
  await db.query("UPDATE evimed_frontier.items SET event_id=$1 WHERE id=$2", [ev.rows[0].id, muted.id]);
  const now = new Date("2026-09-22T04:00:00Z");
  const phrases = [{ text: "Semaglutide", source: "question", kind: "question", memoryId: "" }];
  const frozen = { state: "available", basis: "tags", items: [wanted, muted].map((item) => ({ itemId: item.publicId, text: "Semaglutide", source: "question", kind: "question", memoryId: "" })) };
  await db.query(`INSERT INTO evimed_frontier.user_profiles(user_id,phrases,for_you,computed_at,for_you_at)
    VALUES('alice',$1::jsonb,$2::jsonb,$3,$3) ON CONFLICT(user_id) DO UPDATE SET phrases=EXCLUDED.phrases,for_you=EXCLUDED.for_you,for_you_at=EXCLUDED.for_you_at`, [JSON.stringify(phrases),JSON.stringify(frozen),now]);
  const key = kind === "drug" ? "semaglutide" : kind === "topic" ? "pilot" : `evt${kind}123456`;
  await service.createFollow(alice, { kind, key, muted: true });
  // A stale concurrent cache writer must not undo the user's current mute.
  await db.query("UPDATE evimed_frontier.user_profiles SET for_you=$1::jsonb,for_you_at=$2 WHERE user_id='alice'", [JSON.stringify(frozen),now]);
  const profiles = new FrontierProfiles({ database: db, researchMemory: { configured: true, settings: async () => ({ recallPaused: false, pausedProjects: [] }) },
    config: { deepseekProviderEnabled: true, deepseekApiKey: "test-only-key" }, embedder: { configured: false }, now: () => now });
  const hydrate = async (_user, ids) => new Map(ids.map((id) => [id, { id, state: { hidden: false } }]));
  assert.deepEqual((await profiles.forYou(alice, hydrate)).items.map((entry) => entry.item.id), [wanted.publicId]);
  const ranked = await profiles.rank(alice.id);
  assert.equal(ranked.items.some((entry) => entry.itemId === muted.publicId), false);
  assert.equal(ranked.items.some((entry) => entry.itemId === wanted.publicId), true);
});
