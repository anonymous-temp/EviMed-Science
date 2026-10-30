import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIDENCE_ZONE_RESET_SQL, EVIDENCE_ZONE_SQL, migrateEvidenceZones, resetPreTopicZones } from "../src/evidenceZonePersistence.mjs";
import { EvidenceZoneMembership } from "../src/evidenceZoneMembership.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** A database with the schema and a store the assertions read through. */
async function openDatabase(label) {
  const isolated = await createGeoTestDatabase(databaseUrl, label);
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  return {
    database,
    close: async () => { await database.close().catch(() => {}); await isolated.drop(); },
    version: async () => Number((await database.query("SELECT version FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0].version),
    marker: async () => (await database.query("SELECT topics_reset_at FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0].topics_reset_at,
    zones: async () => (await database.query("SELECT id FROM evimed_frontier.evidence_zones ORDER BY id")).rows.map((row) => row.id),
    /** A database from before the topic zones: a card zone and its card, a reader's old zone, a topic zone, a product zone; no marker yet. */
    seedOldZones: () => database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development');
      INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle) VALUES
        ('old-official','alice','official','Whole disease','none'), ('old-user','alice','user','Cards','none'),
        ('product-zone','alice','product','Product','none');
      INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle,definition) VALUES ('topic-zone','alice','user','A topic','active','{"type":"drug-indication"}');
      INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype) VALUES ('old-card','old-user','alice','Card','knowledge');
      UPDATE evimed_frontier.evidence_zone_meta SET topics_reset_at = NULL WHERE singleton;`),
  };
}

// The one-time reset of 2026-10-29 deletes the zones that were not topics and must move the content version in the same breath: the
// public card feed and the public pages key their ETags to it, and a version that did not move answered 304 with the deleted cards.
test("the reset deletes the old zones once, sets its marker and moves the content version together", options, async () => {
  const db = await openDatabase("reset");
  const { database } = db;
  try {
    await migrateEvidenceZones(database);
    // A fresh database has nothing to delete: the marker is set at once and the version stays where it was.
    assert.ok(await db.marker(), "a fresh database is marked");
    assert.equal(await db.version(), 0, "nothing was deleted, so nothing changed");

    await db.seedOldZones();
    const before = await db.version();
    await database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_RESET_SQL));

    assert.deepEqual(await db.zones(), ["product-zone", "topic-zone"], "the old official and user zones go; a topic zone and a product zone stay");
    assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0, "the cards go with their zone");
    assert.ok(await db.marker(), "the marker is set");
    assert.equal(await db.version(), before + 1, "the content version moved with the marker");
    assert.deepEqual((await database.query("SELECT zone_id FROM evimed_frontier.zone_changes WHERE kind='reset' ORDER BY zone_id")).rows.map((row) => row.zone_id), ["old-official", "old-user"]);

    // Once: a zone made later, whatever it is, is never touched and the version does not move again.
    await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle) VALUES ('later','alice','user','Later','none')");
    const after = await db.version();
    await database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_RESET_SQL));
    await database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_SQL));
    assert.deepEqual(await db.zones(), ["later", "product-zone", "topic-zone"]);
    assert.equal(await db.version(), after);
  } finally {
    await db.close();
  }
});

test("the schema step alone deletes nothing: a database with old zones keeps them, unmarked, until the topic zones are on", options, async () => {
  const db = await openDatabase("resetoff");
  try {
    await migrateEvidenceZones(db.database);
    await db.seedOldZones();
    await db.database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_SQL));
    assert.deepEqual(await db.zones(), ["old-official", "old-user", "product-zone", "topic-zone"], "every zone is still there");
    assert.equal(await db.marker(), null, "the reset is still to come");
  } finally {
    await db.close();
  }
});

test("the membership module resets where the topic zones are on, and leaves a deployment with them off its zones", options, async () => {
  const off = await openDatabase("resetmoff");
  const on = await openDatabase("resetmon");
  const membership = (/** @type {any} */ database, /** @type {Record<string, unknown>} */ config = {}) =>
    new EvidenceZoneMembership({ database, editor: null, embedder: null, tags: null, entities: null, config: { kbEmbeddingDimension: 1024, ...config } });
  try {
    for (const entry of [off, on]) {
      await migrateEvidenceZones(entry.database);
      await entry.seedOldZones();
    }
    const switchedOff = membership(off.database, { evidenceZoneTopicsEnabled: false });
    assert.equal(switchedOff.enabled, false);
    await switchedOff.ready();
    assert.deepEqual(await off.zones(), ["old-official", "old-user", "product-zone", "topic-zone"], "switched off: the old zones stay");
    assert.equal(await off.marker(), null);

    await membership(on.database).ready();
    assert.deepEqual(await on.zones(), ["product-zone", "topic-zone"], "switched on: the old zones go");
    assert.ok(await on.marker());
    const moved = await on.version();
    await membership(on.database).ready();
    await resetPreTopicZones(on.database);
    assert.equal(await on.version(), moved, "once");

    // Switching it on later does what was held back.
    await membership(off.database).ready();
    assert.deepEqual(await off.zones(), ["product-zone", "topic-zone"]);
    assert.ok(await off.marker());
  } finally {
    await off.close();
    await on.close();
  }
});
