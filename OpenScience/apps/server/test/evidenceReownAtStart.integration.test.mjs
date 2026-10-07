// A database that comes from release 6 holds the three imported official zones as operator-owned `kind='user'` rows, and until something
// moves them their AI upkeep is booked to an operator's wallet (evidence-flywheel review fix 10, 2026-10-06). The composed app moves
// them itself when the frontier is composed and the app starts: once, the count on stderr, no manual step. Rows shaped like release 6.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { createWebApiApp } from "../src/server.mjs";
import { memoryPlugin, pluginSource } from "./helpers/frontierFixtures.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const suffix = randomUUID().slice(0, 8);
const operator = `operator${suffix}`;
/** @type {any} */ let isolated, dataDir;
before(async () => { if (!databaseUrl) return; isolated = await createGeoTestDatabase(databaseUrl, "reownstart"); dataDir = await mkdtemp(path.join(tmpdir(), "evimed-reown-start-")); });
after(async () => { await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

test("the app moves an operator's imported official zones to the publisher when it starts, once, and says how many", options, async () => {
  const tokenFile = path.join(dataDir, "knowledge-plugin.token");
  await writeFile(tokenFile, "test-only-app-token\n", { mode: 0o600 });
  const plugin = memoryPlugin({ sources: [pluginSource("nejm")], entries: [] });
  const app = createWebApiApp({
    dataDir, port: 0, runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "", stateStore: "postgres", requireSharedStateStore: true,
    databaseUrl: isolated.url, operatorUsers: [operator], frontierEnabled: true, frontierAudience: "operators", frontierPreviewUsers: [operator],
    knowledgePluginUrl: "http://plugin.test:8080", knowledgePluginTokenFile: tokenFile, knowledgePluginFetch: plugin.fetchImpl,
    frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
  });
  const said = /** @type {string[]} */ ([]);
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = /** @type {any} */ ((chunk) => { said.push(String(chunk)); return true; });
  try {
    await app.store.createUser(operator, "test-only-operator-password", "Operator");
    const db = app.store.database;
    await app.frontier.evidenceZones.ready();
    // Release 6's rows: an operator-owned user zone and its card, reviewed by the import (`editorial.reviewOrigin`).
    await db.query("INSERT INTO evimed_frontier.evidence_zones(id,user_id,title,state,kind) VALUES('ez_release6zone',$1,'房颤抗凝','published','user')", [operator]);
    await db.query(`INSERT INTO evimed_frontier.evidence_cards(id,zone_id,user_id,title,subtype,summary,body,sources,state,editorial)
      VALUES('ec_release6card','ez_release6zone',$1,'T','academic','s','b','[]','published','{"author":{"kind":"ai","name":"Editor AI","model":"m"},"status":"ai-reviewed","reviewOrigin":"import"}'::jsonb)`, [operator]);
    await app.listen(0, "127.0.0.1");
    for (let waited = 0; waited < 50; waited += 1) {
      if ((await db.query("SELECT user_id FROM evimed_frontier.evidence_zones WHERE id='ez_release6zone'")).rows[0].user_id === PLATFORM_PUBLISHER_USER_ID) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const zone = (await db.query("SELECT user_id,kind FROM evimed_frontier.evidence_zones WHERE id='ez_release6zone'")).rows[0];
    assert.deepEqual(zone, { user_id: PLATFORM_PUBLISHER_USER_ID, kind: "official" });
    assert.equal((await db.query("SELECT user_id FROM evimed_frontier.evidence_cards WHERE id='ec_release6card'")).rows[0].user_id, PLATFORM_PUBLISHER_USER_ID);
    assert.ok(said.some((line) => /evidence re-own: 1 official zone\(s\) and 1 card\(s\) moved/.test(line)), `said on stderr: ${said.join("|")}`);
  } finally {
    process.stderr.write = write;
    await app.frontierWorker?.close();
    await app.close();
  }
});
