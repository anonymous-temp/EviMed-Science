// How 循证进化 reads the medical frontier feed, against the feed's real schema: it starts at the feed's present, reads
// only what was published, never goes back further than a bounded look-back, and a paper becomes a scouting run only
// inside a daily count and behind the work the module has already admitted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { migrateFrontier } from "../src/frontierPersistence.mjs";
import { ProductDocuments, ProductJobs } from "../src/productStore.mjs";
import { EvolutionService } from "../src/evolutionService.mjs";
import { EvolutionFrontierSignals, EvolutionIntegration, EVOLUTION_FRONTIER_LOOKBACK_MS } from "../src/evolutionIntegration.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";
import { insertItem, insertSource } from "./helpers/frontierFixtures.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
const options = { skip: !databaseUrl && "Local test Postgres is not configured" };
const owner = `frontier_signals_${randomUUID()}`;
let isolated, database, documents, jobs, service, integration, signals, clock;
const NOW = new Date("2026-10-05T08:00:00Z");

before(async () => {
  if (!databaseUrl) return;
  isolated = await createGeoTestDatabase(databaseUrl, "evofeed");
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  await migrateFrontier(database, { dimension: 1024 });
  await database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES ($1,'Evolution operator','development')", [owner]);
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES ($1,'evimed-evolution','Evolution',1048576)", [owner]);
  await insertSource(database, "nejm");
  documents = new ProductDocuments(database); jobs = new ProductJobs(database);
  clock = NOW;
  service = new EvolutionService({ documents, jobs, ownerId: owner, now: () => clock, config: { evolutionMaxPaperScoutsPerDay: 2 } });
  integration = new EvolutionIntegration({ service, autopilot: {} });
  signals = new EvolutionFrontierSignals({ database, service, integration });
});
after(async () => {
  if (!database) return;
  await database.query("DELETE FROM evimed_control.users WHERE id=$1", [owner]);
  await database.close();
  await isolated.drop();
});

/** A published item and the change rows the pipeline leaves for it. */
async function published(title, { at = NOW, reasons = ["published"], op = "upsert" } = {}) {
  const item = await insertItem(database, { title, abstract: `Abstract of ${title}` });
  for (const reason of reasons) await database.query("INSERT INTO evimed_frontier.item_changes(item_id,op,reason,changed_at) VALUES ($1,$2,$3,$4)", [item.id, op, reason, at]);
  return item;
}
const events = async () => (await service.list("event")).map((row) => row.payload).filter((event) => event.type === "frontier-publication");

test("the first look at a feed that already holds items starts at its present and publishes none of them", options, async () => {
  for (let index = 0; index < 30; index++) await published(`Before the module ${index}`, { at: new Date(NOW.getTime() - 3600_000) });
  const first = await signals.tick();
  assert.equal(first.count, 0);
  assert.equal((await events()).length, 0, "the feed's history is not news");
  const head = Number((await database.query("SELECT max(seq) AS head FROM evimed_frontier.item_changes")).rows[0].head);
  assert.equal((await service.get("evolution-frontier-cursor")).payload.sequence, head);
  const fresh = await published("After the module");
  await signals.tick();
  assert.deepEqual((await events()).map((event) => event.paper.title), ["After the module"]);
  assert.equal((await events())[0].paper.id, fresh.id);
});

test("only a paper's publication is an event: a rescore or selection of the same item is not another paper", options, async () => {
  await published("Rescored again", { reasons: ["published", "rescored", "selected"] });
  await published("Withdrawn", { reasons: ["withdrawn"], op: "remove" });
  await signals.tick();
  const titles = (await events()).map((event) => event.paper.title);
  assert.equal(titles.filter((title) => title === "Rescored again").length, 1);
  assert.ok(!titles.includes("Withdrawn"));
});

test("a cursor older than the look-back skips what is older than the look-back", options, async () => {
  const stale = await service.get("evolution-frontier-cursor");
  await published("Months ago", { at: new Date(NOW.getTime() - EVOLUTION_FRONTIER_LOOKBACK_MS - 86_400_000) });
  await published("Yesterday", { at: new Date(NOW.getTime() - 86_400_000) });
  clock = new Date(NOW.getTime() + 60_000);
  await signals.tick();
  const titles = (await events()).map((event) => event.paper.title);
  assert.ok(titles.includes("Yesterday"));
  assert.ok(!titles.includes("Months ago"));
  assert.ok(Number((await service.get("evolution-frontier-cursor")).payload.sequence) > Number(stale.payload.sequence));
});

test("papers become scouting runs only inside the daily count, once per paper, and behind admitted builds", options, async () => {
  await database.query("DELETE FROM evimed_product.jobs WHERE user_id=$1", [owner]);
  const build = await service.enqueue("build", { dossierId: "admitted" }, "build:admitted", new Date(NOW.getTime() + 600_000));
  const paper = (n) => ({ id: `paper-${n}`, identity: `doi:10.1000/${n}`, title: `Paper ${n}` });
  const scouts = async () => (await database.query("SELECT payload,run_after FROM evimed_product.jobs WHERE user_id=$1 AND kind='evolution-scout' AND payload->'paper' IS NOT NULL ORDER BY created_at", [owner])).rows;
  await integration.consume({ id: "frontier:1", type: "frontier-publication", paper: paper(1) });
  await integration.consume({ id: "frontier:2", type: "frontier-publication", paper: paper(1) });
  assert.equal((await scouts()).length, 1, "a second change of the same paper is not a second run");
  assert.ok(new Date((await scouts())[0].run_after) >= new Date(build.runAfter ?? build.run_after ?? NOW.getTime() + 600_000), "behind the work already admitted");
  await integration.consume({ id: "frontier:3", type: "frontier-publication", paper: paper(2) });
  const refused = await integration.consume({ id: "frontier:4", type: "frontier-publication", paper: paper(3) });
  assert.equal((await scouts()).length, 2, "the third paper in the day is not scouted");
  assert.equal(refused?.scouted, false);
  assert.equal(refused?.reason, "daily-cap");
});
