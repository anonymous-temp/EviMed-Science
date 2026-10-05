// The 灵豆 wallet against a real PostgreSQL: lots, holds, the atomic take-up-to and
// expiry — and, above all, the properties that are the storage's. Every race here
// must end with the wallet adding up to the last 1e-8: each lot is exactly its grant
// less its draws, the balance is the sum of the lots and never negative, and
// grants + top-ups − taken − expired is the balance (`auditWallet`).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { SIMULATED_TOPUP_PACKAGES, researchMoneyUnits } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SimulatedWallet, eraseSimulatedWallets, migrateSimulatedWallet } from "../src/evimedCreditsSimulator.mjs";
import { auditWallet, clock, databaseOptions as options, databaseUrl, freshPayer, removeWallet } from "./helpers/creditWalletFixture.mjs";

/** 11:00 on 5 October 2026 in Shanghai. */
const T0 = "2026-10-05T03:00:00.000Z";
const DAY = 86_400_000;
/** @type {any} */
let database;
/** @type {string[]} */
const payers = [];

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
});

after(async () => {
  if (!databaseUrl) return;
  for (const payer of payers) await removeWallet(database, payer);
  await database.close?.();
});

/**
 * A wallet on its own clock and a payer that belongs to this test. With no
 * sign-up gift (`startCredits: 0`, the default here) its lots are exactly the ones
 * the test makes.
 * @param {{ startCredits?: number, signupGiftDays?: number, monthlyGift?: string | number, start?: string }} [settings]
 */
function setup({ startCredits = 0, signupGiftDays = 30, monthlyGift = 0, start = T0 } = {}) {
  const time = clock(start);
  const wallet = new SimulatedWallet({ database, startCredits, signupGiftDays, monthlyGift, now: time.now });
  const payer = freshPayer();
  payers.push(payer);
  return { wallet, time, payer };
}

const units = (/** @type {string} */ value) => researchMoneyUnits(value);
const request = () => `request_${randomUUID().slice(0, 12)}`;
const run = () => `run_${randomUUID()}`;
/** @param {any} draws */
const split = (draws) => draws.map((/** @type {any} */ draw) => [draw.kind, draw.source, draw.amount]);

test("the first sight of an account grants the sign-up gift once — a gifted lot that ends 30 days on — even when six reads race", options, async () => {
  const { wallet, payer } = setup({ startCredits: 200 });
  const reads = await Promise.all(Array.from({ length: 6 }, () => wallet.snapshot(payer)));
  for (const read of reads) assert.deepEqual([read.available, read.gifted, read.purchased, read.frozen], ["200.00000000", "200.00000000", "0.00000000", "0.00000000"]);
  const { lots, entries } = await auditWallet(database, payer);
  assert.equal(lots.length, 1);
  assert.deepEqual([lots[0].kind, lots[0].source], ["gifted", "signup"]);
  // 11:00 on 5 October in Shanghai: valid through 4 November, to its 24:00.
  assert.equal(new Date(lots[0].expires_at).toISOString(), "2026-11-04T16:00:00.000Z");
  assert.deepEqual(entries.map((entry) => entry.kind), ["grant"]);
  assert.deepEqual(reads[0].nextExpiry, { amount: "200.00000000", at: "2026-11-04T16:00:00.000Z" });
});

test("gifted 灵豆 are spent first, the soonest expiry first, a tie to the older lot, purchased last — and a charge says which lots it drew on", options, async () => {
  const { wallet, time, payer } = setup();
  await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "2", days: 10 });
  time.advance(1_000);
  await wallet.grant({ payer, requestId: request(), source: "compensation", amount: "3", days: 10 });
  time.advance(1_000);
  await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "4", days: 5 });
  await wallet.credit({ payer, amount: "100", requestId: request(), packageId: "topup-100" });
  const before = await wallet.snapshot(payer);
  assert.deepEqual([before.balance, before.gifted, before.purchased], ["109.00000000", "9.00000000", "100.00000000"]);
  assert.deepEqual(before.nextExpiry, { amount: "4.00000000", at: "2026-10-10T16:00:00.000Z" });
  // The soonest (4), then the older of the two that end the same day (2), then the younger (0.5 of 3).
  const first = await wallet.settle({ payer, requestId: run(), amount: "6.5" });
  assert.equal(first.taken, "6.50000000");
  assert.deepEqual(split(first.lots), [["gifted", "campaign", "4.00000000"], ["gifted", "campaign", "2.00000000"], ["gifted", "compensation", "0.50000000"]]);
  // What is left of the gifts, and only then what was bought.
  const second = await wallet.settle({ payer, requestId: run(), amount: "5" });
  assert.deepEqual(split(second.lots), [["gifted", "compensation", "2.50000000"], ["purchased", "topup", "2.50000000"]]);
  const after = await wallet.snapshot(payer);
  assert.deepEqual([after.gifted, after.purchased, after.balance], ["0.00000000", "97.50000000", "97.50000000"]);
  await auditWallet(database, payer);
});

test("a run costing 0.0431 moves the balance by exactly 0.0431, and nothing is rounded", options, async () => {
  const { wallet, payer } = setup({ startCredits: 200 });
  const charge = await wallet.settle({ payer, requestId: run(), amount: "0.04310000" });
  assert.deepEqual([charge.taken, charge.shortfall, charge.balance], ["0.04310000", "0.00000000", "199.95690000"]);
  assert.equal((await auditWallet(database, payer)).balance, units("199.95690000"));
  const tiny = await wallet.settle({ payer, requestId: run(), amount: "0.00000001" });
  assert.equal(tiny.balance, "199.95689999");
  await auditWallet(database, payer);
});

test("a ¥7.30 run on 5 gifted (ending in 2 days) and 1 purchased takes 5 + 1, reports 1.30 as the shortfall, leaves nothing, and nothing is then available", options, async () => {
  const { wallet, payer } = setup();
  await wallet.grant({ payer, requestId: request(), source: "compensation", amount: "5", days: 2 });
  await wallet.credit({ payer, amount: "1", requestId: request(), packageId: null });
  const charge = await wallet.settle({ payer, requestId: run(), amount: "7.30" });
  assert.equal(charge.taken, "6.00000000");
  assert.equal(charge.shortfall, "1.30000000");
  assert.deepEqual(split(charge.lots), [["gifted", "compensation", "5.00000000"], ["purchased", "topup", "1.00000000"]]);
  assert.equal(charge.balance, "0.00000000");
  const read = await wallet.snapshot(payer);
  assert.deepEqual([read.available, read.balance, read.nextExpiry], ["0.00000000", "0.00000000", null]);
  await auditWallet(database, payer);
});

test("the same request id is one charge however many times it is made, and five racing replays take once", options, async () => {
  const { wallet, payer } = setup({ startCredits: 200 });
  const requestId = run();
  const results = await Promise.all(Array.from({ length: 5 }, () => wallet.settle({ payer, requestId, amount: "12.5" })));
  assert.equal(results.filter((result) => !result.replay).length, 1);
  for (const result of results) assert.equal(result.taken, "12.50000000");
  const { balance, entries } = await auditWallet(database, payer);
  assert.equal(balance, units("187.5"));
  assert.equal(entries.filter((entry) => entry.kind === "deduct").length, 1);
  // The key belongs to one payer: another account cannot replay it.
  const other = setup({ startCredits: 5 });
  await assert.rejects(other.wallet.settle({ payer: other.payer, requestId, amount: "1" }), { code: "simulated_wallet_request_conflict" });
});

test("two settlements racing on one account never overdraw it: eight racing charges of 3 on a balance of 10 take exactly 10", options, async () => {
  const { wallet, payer } = setup({ startCredits: 10 });
  await wallet.snapshot(payer);
  const results = await Promise.all(Array.from({ length: 8 }, () => wallet.settle({ payer, requestId: run(), amount: "3" })));
  const taken = results.reduce((sum, result) => sum + units(result.taken), 0n);
  const short = results.reduce((sum, result) => sum + units(result.shortfall), 0n);
  assert.equal(taken, units("10"), "everything there was, and not a unit more");
  assert.equal(short, units("14"), "the rest is the platform's and is reported, not owed");
  assert.deepEqual(results.map((result) => result.taken).sort(),
    ["0.00000000", "0.00000000", "0.00000000", "0.00000000", "1.00000000", "3.00000000", "3.00000000", "3.00000000"]);
  assert.equal((await auditWallet(database, payer)).balance, 0n);
});

test("a settlement racing expiry sweeps: a lapsed lot expires once with its own line, the charge comes from what is still valid, and the wallet adds up", options, async () => {
  for (let round = 0; round < 12; round += 1) {
    const { wallet, time, payer } = setup({ startCredits: 1 });
    await wallet.snapshot(payer);
    await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "5", days: 2 });
    await wallet.credit({ payer, amount: "10", requestId: request(), packageId: null });
    time.advance(40 * DAY);
    const [charge] = await Promise.all([wallet.settle({ payer, requestId: run(), amount: "7" }), wallet.sweepExpiry({ payer }), wallet.sweepExpiry({ payer }), wallet.snapshot(payer)]);
    assert.deepEqual(split(charge.lots), [["purchased", "topup", "7.00000000"]], `round ${round}: both gifts are past their date`);
    const { entries, balance } = await auditWallet(database, payer);
    assert.equal(balance, units("3"), `round ${round}`);
    assert.deepEqual(entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits).sort(), ["1.00000000", "5.00000000"], `round ${round}: each expiry is its own line, once`);
  }
});

test("a lot a hold was placed before is not expired while that hold is open, and pays for that run after its date; a run without a hold cannot draw it", options, async () => {
  const { wallet, time, payer } = setup();
  await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "8", days: 2 });
  await wallet.credit({ payer, amount: "10", requestId: request(), packageId: null });
  assert.equal((await wallet.hold({ payer, runId: "run_long", amount: "6", ttlMs: 10 * DAY })).held, "6.00000000");
  // Three days on: the gift's date has passed and the long run is still working.
  time.advance(3 * DAY);
  await wallet.sweepExpiry({ payer });
  const kept = await auditWallet(database, payer);
  assert.deepEqual(kept.entries.filter((entry) => entry.kind === "expire"), [], "the hold was placed before the date, so the lot stays");
  const read = await wallet.snapshot(payer);
  assert.deepEqual([read.balance, read.gifted, read.frozen, read.available], ["18.00000000", "8.00000000", "6.00000000", "12.00000000"]);
  // Another run, with no hold, cannot spend a gift that is past its date.
  const plain = await wallet.settle({ payer, requestId: run(), amount: "3" });
  assert.deepEqual(split(plain.lots), [["purchased", "topup", "3.00000000"]]);
  // The long run's charge is paid from the gift that was valid when its hold was placed; what is left of it then lapses.
  const long = await wallet.settle({ payer, requestId: run(), amount: "7", holdRunId: "run_long" });
  assert.deepEqual(split(long.lots), [["gifted", "campaign", "7.00000000"]]);
  const after = await auditWallet(database, payer);
  assert.deepEqual(after.entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits), ["1.00000000"], "the unused 1 expires, as its own line, once the hold is gone");
  assert.equal(after.balance, units("7"));
});

test("holds: the smaller of the ask and what is available, once per run, unavailable to others, released by the run's charge", options, async () => {
  const { wallet, payer } = setup({ startCredits: 10 });
  assert.equal((await wallet.hold({ payer, runId: "run_a", amount: "6", ttlMs: DAY })).held, "6.00000000");
  assert.deepEqual(await wallet.hold({ payer, runId: "run_a", amount: "6", ttlMs: DAY }), { held: "6.00000000", replay: true });
  assert.equal((await wallet.hold({ payer, runId: "run_b", amount: "6", ttlMs: DAY })).held, "4.00000000", "only what is left");
  assert.equal((await wallet.hold({ payer, runId: "run_c", amount: "6", ttlMs: DAY })).held, "0.00000000", "nothing is available, so nothing is frozen");
  const frozen = await wallet.snapshot(payer);
  assert.deepEqual([frozen.balance, frozen.frozen, frozen.available], ["10.00000000", "10.00000000", "0.00000000"], "frozen is part of the balance and not available");
  // A run with no hold cannot spend what is frozen.
  const plain = await wallet.settle({ payer, requestId: run(), amount: "5" });
  assert.deepEqual([plain.taken, plain.shortfall], ["0.00000000", "5.00000000"]);
  // A's charge releases A's hold and takes up to what the other holds leave.
  const a = await wallet.settle({ payer, requestId: run(), amount: "7", holdRunId: "run_a" });
  assert.deepEqual([a.taken, a.shortfall, a.balance], ["6.00000000", "1.00000000", "4.00000000"]);
  const b = await wallet.settle({ payer, requestId: run(), amount: "3", holdRunId: "run_b" });
  assert.deepEqual([b.taken, b.shortfall, b.balance], ["3.00000000", "0.00000000", "1.00000000"]);
  const end = await wallet.snapshot(payer);
  assert.deepEqual([end.frozen, end.available], ["0.00000000", "1.00000000"]);
  // A run that has ended never gets a hold again.
  assert.deepEqual(await wallet.hold({ payer, runId: "run_a", amount: "1", ttlMs: DAY }), { held: "0.00000000", replay: true });
  await auditWallet(database, payer);
});

test("a hold cannot outlive its run: released without a charge, and swept after its own deadline", options, async () => {
  const { wallet, time, payer } = setup({ startCredits: 10 });
  await wallet.hold({ payer, runId: "run_x", amount: "4", ttlMs: 60_000 });
  await wallet.hold({ payer, runId: "run_y", amount: "3", ttlMs: 3_600_000 });
  assert.equal(await wallet.release({ runId: "run_x" }), true);
  assert.equal(await wallet.release({ runId: "run_x" }), false, "a second release changes nothing");
  assert.equal((await wallet.snapshot(payer)).frozen, "3.00000000");
  time.advance(30 * 60_000);
  assert.equal(await wallet.sweepHolds({ payer }), 0, "not yet");
  time.advance(60 * 60_000);
  assert.equal(await wallet.sweepHolds({ payer }), 1, "the process that placed it died");
  assert.deepEqual([(await wallet.snapshot(payer)).frozen, (await wallet.snapshot(payer)).available], ["0.00000000", "10.00000000"]);
  await auditWallet(database, payer);
});

test("a hold racing a top-up: either order is valid, and neither overfreezes nor goes negative", options, async () => {
  for (let round = 0; round < 10; round += 1) {
    const { wallet, payer } = setup();
    await wallet.credit({ payer, amount: "10", requestId: request(), packageId: null });
    const [held] = await Promise.all([
      wallet.hold({ payer, runId: run(), amount: "25", ttlMs: DAY }),
      wallet.credit({ payer, amount: "20", requestId: request(), packageId: null }),
    ]);
    const read = await wallet.snapshot(payer);
    assert.equal(read.balance, "30.00000000");
    assert.ok(["10.00000000", "25.00000000"].includes(held.held), `round ${round}: ${held.held}`);
    assert.equal(read.frozen, held.held);
    assert.equal(units(read.available), 30n * 100_000_000n - units(held.held));
    await auditWallet(database, payer);
  }
});

test("a gifted lot's expiry is its own statement line, written once, and a reminder list shows what is about to end", options, async () => {
  const { wallet, time, payer } = setup();
  await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "5", days: 10 });
  /** The sweep is the deployment's: this test reads its own wallet's lots out of it. */
  const mine = async () => (await wallet.lotsEndingWithin(7)).filter((lot) => lot.payer === payer);
  assert.deepEqual(await mine(), [], "ends in more than a week");
  time.advance(4 * DAY);
  const ending = await mine();
  assert.deepEqual(ending.map((lot) => [lot.userId === payer.split(":")[2], lot.remaining, lot.expiresAt]), [[true, "5.00000000", "2026-10-15T16:00:00.000Z"]]);
  time.set("2026-10-15T15:59:59.000Z");
  assert.equal((await wallet.sweepExpiry({ payer })).wallets, 0, "still valid in the last second");
  time.set("2026-10-15T16:00:00.000Z");
  assert.equal((await wallet.sweepExpiry({ payer })).wallets, 1);
  assert.equal((await wallet.sweepExpiry({ payer })).wallets, 0, "once");
  const { entries, balance } = await auditWallet(database, payer);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.credits]), [["grant", "5.00000000"], ["expire", "5.00000000"]]);
  assert.equal(balance, 0n);
  assert.deepEqual(await mine(), []);
});

test("the monthly gift: one lot per cycle on the account's own date, ending where the next begins, never backfilled", options, async () => {
  const { wallet, time, payer } = setup({ monthlyGift: "5", start: "2026-01-31T10:00:00Z" });
  await wallet.snapshot(payer);
  time.set("2026-02-27T15:59:00Z");
  assert.equal((await wallet.snapshot(payer)).gifted, "0.00000000", "the first monthly date is 28 February in Shanghai");
  time.set("2026-02-28T00:00:00Z");
  const reads = await Promise.all(Array.from({ length: 4 }, () => wallet.snapshot(payer)));
  for (const read of reads) assert.deepEqual([read.gifted, read.nextExpiry], ["5.00000000", { amount: "5.00000000", at: "2026-03-30T16:00:00.000Z" }]);
  // The next date: the first lot ends at that very instant and the new one begins.
  time.set("2026-03-31T00:00:00Z");
  const march = await wallet.snapshot(payer);
  assert.deepEqual([march.gifted, march.nextExpiry?.at], ["5.00000000", "2026-04-29T16:00:00.000Z"]);
  // Months nobody looked at are not granted late: one lot for now.
  time.set("2026-07-02T00:00:00Z");
  const july = await wallet.snapshot(payer);
  assert.equal(july.gifted, "5.00000000");
  const { entries, lots } = await auditWallet(database, payer);
  assert.deepEqual(entries.map((entry) => entry.kind), ["grant", "expire", "grant", "expire", "grant"]);
  assert.equal(lots.filter((lot) => lot.source === "monthly").length, 3);
});

test("an operator's grant: a gifted lot with a source, an amount, a fixed expiry and a note — once per request id, and only as an operator's source", options, async () => {
  const { wallet, payer } = setup();
  const requestId = request();
  const first = await wallet.grant({ payer, requestId, source: "compensation", amount: "12.5", note: "the 4 October outage" });
  assert.deepEqual([first.duplicate, first.balance, first.lot.kind, first.lot.source, first.lot.note], [false, "12.50000000", "gifted", "compensation", "the 4 October outage"]);
  // The default is 90 days: through 3 January 2027.
  assert.equal(first.lot.expiresAt, "2027-01-03T16:00:00.000Z");
  const again = await wallet.grant({ payer, requestId, source: "compensation", amount: "12.5" });
  assert.deepEqual([again.duplicate, again.lot.lotId, again.balance], [true, first.lot.lotId, "12.50000000"]);
  await assert.rejects(wallet.grant({ payer, requestId, source: "compensation", amount: "13" }), { code: "simulated_wallet_request_conflict" });
  await assert.rejects(wallet.grant({ payer, requestId, source: "campaign", amount: "12.5" }), { code: "simulated_wallet_request_conflict" });
  // Five racing copies of one request are one lot.
  const racing = request();
  const copies = await Promise.all(Array.from({ length: 5 }, () => wallet.grant({ payer, requestId: racing, source: "campaign", amount: "1", days: 7 })));
  assert.equal(new Set(copies.map((copy) => copy.lot.lotId)).size, 1);
  assert.equal(copies.filter((copy) => !copy.duplicate).length, 1);
  // A date, or a number of days; the date is shown as it will end.
  const dated = await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "1", expiresOn: "2026-12-31" });
  assert.equal(dated.lot.expiresAt, "2026-12-31T16:00:00.000Z");
  assert.equal((await wallet.grant({ payer, requestId: request(), source: "campaign", amount: "1", expiresOn: "2026-10-05" })).lot.expiresAt, "2026-10-05T16:00:00.000Z", "today's date is still ahead");
  for (const bad of [
    { source: "signup" }, { source: "monthly" }, { source: "topup" }, { source: "check-in" }, { amount: "0" }, { amount: "-1" }, { amount: "1.123456789" }, { amount: "100000.00000001" },
    { amount: 0.1 + 0.2 }, { expiresOn: "2026-10-04" }, { expiresOn: "2026-02-30" }, { expiresOn: "2026-12-31", days: 5 }, { days: 0 }, { days: 1.5 }, { days: 5000 },
    { note: "x".repeat(201) }, { requestId: "short" }, { requestId: "has space in it" },
  ]) {
    await assert.rejects(wallet.grant({ payer, requestId: request(), source: "campaign", amount: "1", ...bad }), { code: "simulated_wallet_request_invalid" }, JSON.stringify(bad));
  }
  await auditWallet(database, payer);
});

test("a top-up is a purchased lot that never expires, once per request id, from a closed list of packages", options, async () => {
  const { wallet, time, payer } = setup();
  const requestId = request();
  const first = await wallet.topUp({ payer, packageId: "topup-100", requestId });
  assert.deepEqual([first.duplicate, first.balance, first.order.amount, first.order.title], [false, "100.00000000", 100, "模拟充值"]);
  assert.deepEqual([(await wallet.topUp({ payer, packageId: "topup-100", requestId })).duplicate, (await wallet.snapshot(payer)).balance], [true, "100.00000000"]);
  await assert.rejects(wallet.topUp({ payer, packageId: "topup-50", requestId }), { code: "simulated_wallet_request_conflict" });
  for (const bad of [{ packageId: "topup-7", requestId: request() }, { packageId: "topup-100", requestId: "x" }, { requestId: request() }]) {
    await assert.rejects(wallet.topUp({ payer, ...bad }), { code: "simulated_wallet_request_invalid" });
  }
  const racing = request();
  const copies = await Promise.all(Array.from({ length: 5 }, () => wallet.topUp({ payer, packageId: "topup-50", requestId: racing })));
  assert.equal(copies.filter((copy) => !copy.duplicate).length, 1);
  assert.equal((await wallet.snapshot(payer)).balance, "150.00000000");
  // Ten years later it is all still there, and nothing has expired.
  time.advance(3650 * DAY);
  assert.deepEqual(await wallet.sweepExpiry({ payer }), { wallets: 0 });
  const later = await wallet.snapshot(payer);
  assert.deepEqual([later.purchased, later.gifted, later.nextExpiry], ["150.00000000", "0.00000000", null]);
  const { lots } = await auditWallet(database, payer);
  assert.deepEqual(lots.map((lot) => [lot.kind, lot.source, lot.expires_at]), [["purchased", "topup", null], ["purchased", "topup", null]]);
  assert.deepEqual((await wallet.orders(payer)).items.map((order) => order.amount), [50, 100]);
  assert.ok(SIMULATED_TOPUP_PACKAGES.length > 1);
});

test("a balance past the cap is refused whole, and a payer this wallet did not mint is refused on every operation", options, async () => {
  const { wallet, payer } = setup();
  await assert.rejects(wallet.credit({ payer, amount: "1000000000.00000001", requestId: request() }), { code: "simulated_wallet_balance_cap" });
  assert.equal((await wallet.snapshot(payer)).balance, "0.00000000");
  for (const bad of ["98211", "evimed_abc", "sim:alice", undefined]) {
    await assert.rejects(wallet.snapshot(/** @type {any} */ (bad)), { code: "simulated_wallet_payer_invalid" }, String(bad));
    await assert.rejects(wallet.settle({ payer: /** @type {any} */ (bad), requestId: run(), amount: "1" }), { code: "simulated_wallet_payer_invalid" });
    await assert.rejects(wallet.hold({ payer: /** @type {any} */ (bad), runId: run(), amount: "1", ttlMs: 1000 }), { code: "simulated_wallet_payer_invalid" });
  }
  for (const amount of ["", "abc", "1.123456789", -1, "-1", Number.NaN, 0.1 + 0.2]) {
    await assert.rejects(wallet.settle({ payer, requestId: run(), amount: /** @type {any} */ (amount) }), { code: "simulated_wallet_request_invalid" }, String(amount));
  }
});

test("the tables refuse what the code would never write: a negative balance, a lot that holds more than was granted, a lot of an invented kind, an entry that takes nothing", options, async () => {
  const { wallet, payer } = setup({ startCredits: 5 });
  await wallet.snapshot(payer);
  const refused = (/** @type {string} */ text, /** @type {any[]} */ values, /** @type {string} */ code) =>
    assert.rejects(database.query(text, values), (/** @type {any} */ error) => error?.code === code, text);
  await refused("UPDATE evimed_credits.simulated_wallets SET balance=-0.00000001 WHERE payer=$1", [payer], "23514");
  await refused("UPDATE evimed_credits.simulated_lots SET remaining=granted+0.00000001 WHERE payer=$1", [payer], "23514");
  await refused("UPDATE evimed_credits.simulated_lots SET remaining=-1 WHERE payer=$1", [payer], "23514");
  const lot = (/** @type {string} */ kind, /** @type {string} */ source, /** @type {string | null} */ expires, /** @type {string} */ key) => refused(
    "INSERT INTO evimed_credits.simulated_lots(payer,kind,source,granted,remaining,expires_at,request_id) VALUES($1,$2,$3,1,1,$4,$5)", [payer, kind, source, expires, key], "23514");
  await lot("purchased", "topup", "2027-01-01T00:00:00Z", "k1");
  await lot("gifted", "signup", null, "k2");
  await lot("gifted", "topup", "2027-01-01T00:00:00Z", "k3");
  await lot("purchased", "signup", null, "k4");
  await lot("loyalty", "signup", "2027-01-01T00:00:00Z", "k5");
  await lot("gifted", "check-in", "2027-01-01T00:00:00Z", "k6");
  await refused(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id) VALUES($1,'deduct',$2,0,0,'r')`, [payer, run()], "23514");
  await refused(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id) VALUES($1,'refund',$2,1,1,'r')`, [payer, run()], "23514");
  await refused(`INSERT INTO evimed_credits.simulated_holds(payer,run_id,amount,status,placed_at,expires_at) VALUES($1,$2,0,'open',now(),now())`, [payer, run()], "23514");
  const requestId = run();
  await wallet.settle({ payer, requestId, amount: "1" });
  await refused(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id) VALUES($1,'deduct',$2,1,1,'r')`, [payer, requestId], "23505");
  await auditWallet(database, payer);
});

test("a wallet goes with its account: erasure removes the wallet, its lots, entries, draws and holds, and only that account's", options, async () => {
  const doomed = setup({ startCredits: 10 });
  const kept = setup({ startCredits: 10 });
  for (const { wallet, payer } of [doomed, kept]) {
    await wallet.topUp({ payer, packageId: "topup-50", requestId: request() });
    await wallet.hold({ payer, runId: run(), amount: "5", ttlMs: DAY });
    await wallet.settle({ payer, requestId: run(), amount: "2" });
  }
  await database.transaction((/** @type {any} */ client) => eraseSimulatedWallets(client, doomed.payer.split(":")[2]));
  for (const table of ["simulated_wallets", "simulated_lots", "simulated_entries", "simulated_holds"]) {
    assert.equal((await database.query(`SELECT 1 FROM evimed_credits.${table} WHERE payer=$1`, [doomed.payer])).rowCount, 0, table);
    assert.ok((await database.query(`SELECT 1 FROM evimed_credits.${table} WHERE payer=$1`, [kept.payer])).rowCount > 0, `${table} kept`);
  }
  assert.equal((await database.query("SELECT 1 FROM evimed_credits.simulated_draws d JOIN evimed_credits.simulated_lots l ON l.lot_id=d.lot_id WHERE l.payer=$1", [doomed.payer])).rowCount, 0);
  // A wallet that is gone is made again from the sign-up gift on its next read.
  assert.equal((await doomed.wallet.snapshot(doomed.payer)).balance, "10.00000000");
});

test("the wallet's tables are its own, and migrating them again changes nothing", options, async () => {
  await migrateSimulatedWallet(database);
  const tables = await database.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='evimed_credits' AND table_name LIKE 'simulated\\_%' ORDER BY table_name`);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["simulated_draws", "simulated_entries", "simulated_holds", "simulated_lots", "simulated_wallets"]);
  const second = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 3_000 });
  try { await migrateSimulatedWallet(second); } finally { await second.close(); }
  const types = await database.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='evimed_credits'
    AND ((table_name='simulated_wallets' AND column_name='balance') OR (table_name='simulated_entries' AND column_name IN ('credits','balance_after'))
      OR (table_name='simulated_lots' AND column_name IN ('granted','remaining')) OR (table_name='simulated_holds' AND column_name='amount') OR (table_name='simulated_draws' AND column_name='amount'))`);
  assert.equal(types.rowCount, 7);
  for (const row of types.rows) assert.equal(row.data_type, "numeric", `${row.table_name}.${row.column_name} is an exact amount`);
});
