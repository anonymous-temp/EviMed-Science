// The migrations of memory sharing run on a database that already holds release-5 data, and twice in a row (flywheel F17-F19).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateCapsuleShare } from "../src/capsuleShareLinks.mjs";
import { migrateResearchMemory } from "../src/researchMemoryPersistence.mjs";
import { ResearchMemoryStore } from "../src/researchMemory.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) { const parsed = new URL(url); assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)); assert.match(parsed.pathname, /evimed_test/); }
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const owner = `msk_${randomUUID().slice(0, 8)}`;
const opened = [];
/** A fresh pool each time: a migration is remembered per database object, so this is a new process starting. */
const connect = () => { const database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 3, databaseConnectionTimeoutMs: 5_000 }); opened.push(database); return database; };
after(async () => {
  if (!url) return;
  const database = connect();
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  for (const item of opened) await item.close();
});
before(async () => {
  if (!url) return;
  const database = connect();
  await migrateResearchMemory(database);
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Migration owner','development')", [owner]);
});

test("a record_sources table created before the two new kinds takes them after one migration, and a second changes nothing", options, async () => {
  const database = connect();
  const store = (db) => new ResearchMemoryStore({ memoryContextLimit: 8, memoryContextMaxChars: 20_000 }, { database: db });
  const link = { type: "evidence_card", id: `ec_${"d4".repeat(16)}` };
  const write = (db, key, links = []) => store(db).upsertRecord(owner, { scope: "user", scopeId: null, kind: "preference", key, value: `${key} 内容`, summary: key, origin: "explicit", status: "active",
    confidence: 1, importance: 0.5, sensitive: false }, null, { sourceLinks: links });
  const record = await write(database, "preference.base");
  // The release-5 shape: the CHECK the table was created with.
  await database.query(`ALTER TABLE evimed_memory.record_sources DROP CONSTRAINT IF EXISTS record_sources_source_type_check;
    ALTER TABLE evimed_memory.record_sources ADD CONSTRAINT record_sources_source_type_check CHECK (source_type IN ('knowledge_source','doi'))`);
  const insert = (db) => db.query("INSERT INTO evimed_memory.record_sources(user_id,record_id,source_type,source_id) VALUES($1,$2,'evidence_card',$3)", [owner, record.id, link.id]);
  await assert.rejects(insert(database), /source_type_check/, "the old table refuses the new kinds");
  const after = connect();
  await migrateResearchMemory(after);
  await insert(after);
  const again = connect();
  await migrateResearchMemory(again);
  const written = await write(again, "preference.after", [link, { type: "frontier_item", id: "m3k7q9w2x5ta" }]);
  assert.deepEqual((await store(again).sourceLinks(owner, written.id)).map((item) => item.type).sort(), ["evidence_card", "frontier_item"]);
  const constraints = (await again.query(`SELECT count(*)::integer AS n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='evimed_memory' AND t.relname='record_sources' AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%source_type%'`)).rows[0].n;
  assert.equal(constraints, 1, "one constraint on the kind, however often the migration ran");
});

test("the sharing schema is created once and again without complaint, and its rows leave with their account", options, async () => {
  const first = connect();
  await migrateCapsuleShare(first);
  await migrateCapsuleShare(connect());
  const peer = `msk_peer_${randomUUID().slice(0, 8)}`;
  await first.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Peer','development')", [peer]);
  await first.query(`INSERT INTO evimed_share.deliveries(id,snapshot_id,owner_id,recipient_id,capsule_id,manifest_sha256,archive_sha256) VALUES('dlv_x','s',$1,$2,'c',$3,$3)`, [owner, peer, "a".repeat(64)]);
  await first.query("DELETE FROM evimed_control.users WHERE id=$1", [peer]);
  assert.equal((await first.query("SELECT count(*)::integer AS n FROM evimed_share.deliveries WHERE id='dlv_x'")).rows[0].n, 0, "deleting an account takes its deliveries with it");
});
