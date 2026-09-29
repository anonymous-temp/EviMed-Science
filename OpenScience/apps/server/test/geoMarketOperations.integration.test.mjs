import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { GeoMarketStore } from "../src/geoMarketStore.mjs";
import { GeoMarketOperations } from "../src/geoMarketOperations.mjs";
import { createGeoTestDatabase } from "./helpers/geoTestDatabase.mjs";

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const options = { skip: !url && "local PostgreSQL required" };
let db, isolated, reads;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, "geoops");
  db = new ControlPlaneDatabase({ databaseUrl: isolated.url });
  const store = new GeoMarketStore(db);
  await store.ready();
  reads = new GeoMarketOperations({ database: db, ready: () => store.ready(), timeZone: "Asia/Shanghai" });
});
after(async () => { await db?.close(); await isolated?.drop(); });

async function ledger(rows) {
  await db.query("TRUNCATE evimed_geo.ledger");
  for (const [id, kind, amount, at] of rows) await db.query(
    "INSERT INTO evimed_geo.ledger(id,kind,amount_cny,created_at) VALUES($1,$2,$3,$4)", [id,kind,amount,at]);
}

test("monthly statement separates settlement, refunds, funding and budget targets", options, async () => {
  await ledger([
    ["old", "reserve", 110, "2026-08-31T15:59:59Z"],
    ["s", "settle", 100, "2026-08-31T16:00:00Z"],
    ["r", "release", 10, "2026-09-01T01:00:00Z"],
    ["b1", "budget_set", 1000, "2026-09-02T01:00:00Z"],
    ["b2", "budget_set", 2000, "2026-09-03T01:00:00Z"],
    ["t", "topup_confirmed", 500, "2026-09-04T01:00:00Z"],
    ["a", "adjustment", -25, "2026-09-05T01:00:00Z"],
    ["refund", "refund", 100, "2026-09-30T16:00:00Z"],
  ]);
  const september = await reads.settlement({ month: "2026-09", limit: "2" });
  assert.equal(september.summary.netSettledCny, 100);
  assert.equal(september.summary.budgetChangeCount, 2);
  assert.equal(september.summary.topupConfirmedCny, 500);
  assert.equal(september.summary.adjustmentCny, -25);
  assert.equal(september.summary.reservedDuringPeriodCny, 0);
  assert.equal(september.summary.releasedDuringPeriodCny, 10);
  assert.equal(september.summary.entryCount, 6);
  assert.equal(september.entries.length, 2);
  assert.equal(september.period.startAt, "2026-08-31T16:00:00.000Z");
  const october = await reads.settlement({ month: "2026-10" });
  assert.equal(october.summary.netSettledCny, -100);
});

test("keyset pages preserve microseconds and keep full-month totals on every page", options, async () => {
  await ledger([1,2,3,4].map((n) => [`e${n}`, "settle", n, `2026-09-02T01:00:00.00000${n}Z`]));
  const first = await reads.settlement({ month: "2026-09", limit: "2" });
  const second = await reads.settlement({ month: "2026-09", limit: "2", cursor: first.nextCursor });
  assert.deepEqual([...first.entries, ...second.entries].map((row) => row.id), ["e4","e3","e2","e1"]);
  assert.equal(first.summary.netSettledCny, 10);
  assert.equal(second.summary.netSettledCny, 10);
  assert.equal(second.nextCursor, null);
  await assert.rejects(reads.settlement({ month: "2026-10", cursor: first.nextCursor }), { code: "geo_payload_invalid" });
});

test("calendar boundaries follow the configured timezone across DST and year rollover", options, async () => {
  const ny = new GeoMarketOperations({ database: db, ready: async () => {}, timeZone: "America/New_York" });
  const march = await ny.settlement({ month: "2026-03" });
  assert.equal(march.period.startAt, "2026-03-01T05:00:00.000Z");
  assert.equal(march.period.endAt, "2026-04-01T04:00:00.000Z");
  assert.equal((await reads.settlement({ month: "2024-02" })).period.endAt, "2024-02-29T16:00:00.000Z");
  assert.equal((await reads.settlement({ month: "2026-12" })).period.endAt, "2026-12-31T16:00:00.000Z");
});

test("operations pages retain missing metadata and distinguish unknown from vendor problems", options, async () => {
  await db.query("TRUNCATE evimed_geo.orders CASCADE");
  await db.query(`INSERT INTO evimed_geo.orders(id,user_id,geo_project_id,state,vendor_order_nid,created_at)
    VALUES('u','u','removed','unknown',NULL,'2026-09-01'),('p','u','removed','problem','000123','2026-09-02'),
    ('r','u','removed','rejected','000124','2026-09-03'),('n','u','removed','cancelled',NULL,'2026-09-04')`);
  const unknown = await reads.orders({ view: "unknown" });
  assert.equal(unknown.total, 1);
  assert.equal(unknown.items[0].canResolve, true);
  assert.equal(unknown.items[0].canMarkLost, false);
  const problems = await reads.orders({ view: "problems", limit: "1" });
  assert.equal(problems.total, 2);
  assert.equal(problems.items[0].vendorOrderNid, "000124");
  assert.equal(problems.items[0].canMarkLost, true);
  const rest = await reads.orders({ view: "problems", limit: "1", cursor: problems.nextCursor });
  assert.equal(rest.items[0].id, "p");
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(await reads.counts(), { unknownOrders: 1, problemOrders: 2, requestedTopups: 0 });
});

test("old requested top-ups remain paged and confirmations count only from the ledger", options, async () => {
  await db.query("TRUNCATE evimed_geo.topups");
  for (let n = 1; n <= 12; n++) await db.query(
    "INSERT INTO evimed_geo.topups(id,amount_cny,status,requested_at) VALUES($1,500,$2,$3)",
    [`t${n}`, n === 1 ? "requested" : "confirmed", `2026-09-${String(n).padStart(2,"0")}T00:00:00Z`]);
  const page = await reads.topups({ status: "requested", limit: "1" });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, "t1");
  assert.equal((await reads.counts()).requestedTopups, 1);
});

test("invalid filters fail before touching the database", async () => {
  const guarded = new GeoMarketOperations({ database: { query: () => assert.fail("invalid read reached SQL") }, ready: async () => {}, timeZone: "Asia/Shanghai" });
  for (const month of ["2026-13", "2026-00", "0000-01", "2026-1", "2026-09;DROP TABLE x"]) {
    await assert.rejects(guarded.settlement({ month }), { code: "geo_payload_invalid" });
  }
  await assert.rejects(guarded.orders({ view: "all" }), { code: "geo_payload_invalid" });
  await assert.rejects(guarded.topups({ limit: "201" }), { code: "geo_payload_invalid" });
  await assert.rejects(guarded.orders({ cursor: "broken" }), { code: "geo_payload_invalid" });
});
