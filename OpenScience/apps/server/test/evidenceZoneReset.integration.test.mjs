import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { EVIDENCE_ZONE_SQL, migrateEvidenceZones } from "../src/evidenceZonePersistence.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

// The one-time reset of 2026-10-29 deletes the zones that were not topics and must move the content version in the same breath: the
// public card feed and the public pages key their ETags to it, and a version that did not move answered 304 with the deleted cards.
test("the reset deletes the old zones once, sets its marker and moves the content version together", options, async () => {
  const isolated = await createGeoTestDatabase(databaseUrl, "reset");
  const database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 2, databaseConnectionTimeoutMs: 2_000 });
  const version = async () => Number((await database.query("SELECT version FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0].version);
  const marker = async () => (await database.query("SELECT topics_reset_at FROM evimed_frontier.evidence_zone_meta WHERE singleton")).rows[0].topics_reset_at;
  const zones = async () => (await database.query("SELECT id FROM evimed_frontier.evidence_zones ORDER BY id")).rows.map((row) => row.id);
  try {
    await migrateEvidenceZones(database);
    // A fresh database has nothing to delete: the marker is set and the version stays where it was.
    assert.ok(await marker(), "a fresh database is marked");
    assert.equal(await version(), 0, "nothing was deleted, so nothing changed");

    // A database from before the topic zones: a card zone and its card, a reader's old zone, a topic zone, a product zone; no marker yet.
    await database.query(`INSERT INTO evimed_control.users(id,name,auth_type) VALUES ('alice','Alice','development');
      INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle) VALUES
        ('old-official','alice','official','Whole disease','none'), ('old-user','alice','user','Cards','none'),
        ('product-zone','alice','product','Product','none');
      INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle,definition) VALUES ('topic-zone','alice','user','A topic','active','{"type":"drug-indication"}');
      INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype) VALUES ('old-card','old-user','alice','Card','knowledge');
      UPDATE evimed_frontier.evidence_zone_meta SET topics_reset_at = NULL WHERE singleton;`);
    const before = await version();
    await database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_SQL));

    assert.deepEqual(await zones(), ["product-zone", "topic-zone"], "the old official and user zones go; a topic zone and a product zone stay");
    assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_cards")).rows[0].n, 0, "the cards go with their zone");
    assert.ok(await marker(), "the marker is set");
    assert.equal(await version(), before + 1, "the content version moved with the marker");
    assert.deepEqual((await database.query("SELECT zone_id FROM evimed_frontier.zone_changes WHERE kind='reset' ORDER BY zone_id")).rows.map((row) => row.zone_id), ["old-official", "old-user"]);

    // Once: a zone made later, whatever it is, is never touched and the version does not move again.
    await database.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,kind,title,lifecycle) VALUES ('later','alice','user','Later','none')");
    const after = await version();
    await database.transaction((/** @type {any} */ client) => client.query(EVIDENCE_ZONE_SQL));
    assert.deepEqual(await zones(), ["later", "product-zone", "topic-zone"]);
    assert.equal(await version(), after);
  } finally {
    await database.close().catch(() => {});
    await isolated.drop();
  }
});
