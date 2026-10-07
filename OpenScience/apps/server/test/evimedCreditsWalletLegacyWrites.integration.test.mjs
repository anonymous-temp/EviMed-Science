// What the one-number wallet writes onto the lots schema, and what the new wallet
// does about it (review F1). An old web process that still serves after the lots
// migration, or a rollback, moves a wallet's `balance` and appends entries
// without touching a lot. The new code reconciles — under the wallet lock, keyed
// by entry id, every time it prepares a wallet — so the lots always come into
// agreement with what the old code wrote, and `auditWallet` passes afterwards.
//
// The old code here is the pre-merge module, verbatim
// (`helpers/legacyOneNumberWallet.mjs`), running against the migrated schema.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { researchMoneyUnits } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SimulatedWallet } from "../src/evimedCreditsSimulator.mjs";
import { auditWallet, clock, databaseOptions as options, databaseUrl, freshPayer, removeWallet } from "./helpers/creditWalletFixture.mjs";
import { SimulatedWallet as LegacyWallet } from "./helpers/legacyOneNumberWallet.mjs";

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
  // The scenario is a schema the lots migration has already run on: the old code then writes onto it. In a database of its
  // own (how the product-state job runs this file) nothing has created those tables yet, so the test makes them.
  await new SimulatedWallet({ database, startCredits: 200 }).ready();
});

after(async () => {
  if (!databaseUrl) return;
  for (const payer of payers) await removeWallet(database, payer);
  await database.close?.();
});

const units = (/** @type {string} */ value) => researchMoneyUnits(value);

/** The new wallet on its own clock, the old one on the same tables, and a payer for this test. */
function setup({ startCredits = 200, signupGiftDays = 30 } = {}) {
  const time = clock(T0);
  const wallet = new SimulatedWallet({ database, startCredits, signupGiftDays, now: time.now });
  const legacy = new LegacyWallet({ database, startCredits });
  const payer = freshPayer("legacy");
  payers.push(payer);
  return { wallet, legacy, time, payer };
}
const request = () => `request_${randomUUID().slice(0, 12)}`;
const run = () => `run_${randomUUID()}`;

test("a sign-up on the old release after the migration gets its sign-up gift lot: the account is not refused every start", options, async () => {
  const { wallet, legacy, payer } = setup();
  assert.equal((await legacy.balance(payer)).balance, 200, "the old release's first sight: a row of 200, a grant entry, and no lot");
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_credits.simulated_lots WHERE payer=$1", [payer])).rows[0].n, 0);
  const read = await wallet.snapshot(payer);
  assert.deepEqual([read.available, read.gifted, read.purchased, read.balance], ["200.00000000", "200.00000000", "0.00000000", "200.00000000"]);
  const { lots, entries } = await auditWallet(database, payer);
  assert.deepEqual(lots.map((lot) => [lot.kind, lot.source]), [["gifted", "signup"]]);
  // The old release wrote the entry on the database's clock, not the test's, so the date is worked out from the entry
  // itself — and by hand, not by the wallet's own function: the Shanghai date the entry was made on, thirty days on, to
  // that date's 24:00 (16:00Z). Written as the literal date of the day the test was added, this failed from the first
  // midnight in Shanghai onward (2026-10-06 00:12, in the release battery).
  const made = (await database.query("SELECT created_at FROM evimed_credits.simulated_entries WHERE payer=$1 ORDER BY entry_id LIMIT 1", [payer])).rows[0].created_at;
  const entered = new Date(new Date(made).getTime() + 8 * 3_600_000);
  const through = new Date(Date.UTC(entered.getUTCFullYear(), entered.getUTCMonth(), entered.getUTCDate() + 30, 16));
  assert.equal(new Date(lots[0].expires_at).toISOString(), through.toISOString(), "a sign-up gift with the date the new release fixes: 30 days from the entry");
  assert.equal(entries.length, 1, "no entry was added: the old grant line is the gift's line");
  assert.equal((await database.query("SELECT lot_id FROM evimed_credits.simulated_entries WHERE payer=$1", [payer])).rows[0].lot_id, lots[0].lot_id, "and says when it ends");
});

test("a run charged on the old release after the migration is drawn from the lots in the normal order: the charge is not refunded, and the gift's expiry does not break the wallet", options, async () => {
  const { wallet, legacy, time, payer } = setup();
  await wallet.snapshot(payer);
  await wallet.credit({ payer, amount: "50", requestId: request(), packageId: null });
  // The old release charges 7 and then, with a row of 243, tops up and charges again.
  await legacy.deduct({ payer, requestId: run(), credits: 7 });
  const row = (await database.query("SELECT balance::text AS balance FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rows[0];
  assert.equal(row.balance, "243.00000000", "the old code moved the row and no lot");
  const read = await wallet.snapshot(payer);
  assert.deepEqual([read.balance, read.gifted, read.purchased], ["243.00000000", "193.00000000", "50.00000000"], "the charge stands, and came out of the gift first");
  const audited = await auditWallet(database, payer);
  assert.equal(audited.balance, units("243"));
  // The gift's date arrives: the expiry is a line of its own, and nothing throws.
  time.advance(31 * DAY);
  assert.deepEqual(await wallet.sweepExpiry({ payer }), { wallets: 1, failed: 0 });
  const after = await auditWallet(database, payer);
  assert.equal(after.balance, units("50"));
  assert.deepEqual(after.entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits), ["193.00000000"]);
  const charge = await wallet.settle({ payer, requestId: run(), amount: "20" });
  assert.deepEqual(charge.lots.map((draw) => [draw.kind, draw.amount]), [["purchased", "20.00000000"]]);
  await auditWallet(database, payer);
});

test("a top-up on the old release after the migration becomes a purchased lot", options, async () => {
  const { wallet, legacy, payer } = setup();
  await wallet.snapshot(payer);
  const requestId = request();
  await legacy.topUp({ payer, packageId: "topup-100", requestId });
  const read = await wallet.snapshot(payer);
  assert.deepEqual([read.purchased, read.gifted, read.available, read.balance], ["100.00000000", "200.00000000", "300.00000000", "300.00000000"], "the bought 100 exist for the new release");
  const { lots } = await auditWallet(database, payer);
  assert.deepEqual(lots.map((lot) => [lot.kind, lot.source, lot.expires_at]), [["gifted", "signup", lots[0].expires_at], ["purchased", "topup", null]]);
  // Never expires, and a repeat of the old release's own request id is still the same top-up.
  const again = await wallet.topUp({ payer, packageId: "topup-100", requestId });
  assert.equal(again.duplicate, true);
  assert.equal((await wallet.snapshot(payer)).purchased, "100.00000000");
  await auditWallet(database, payer);
});

test("a charge larger than the row the old release left but within the lots no longer throws: the wallet was reconciled first", options, async () => {
  const { wallet, legacy, payer } = setup();
  await wallet.snapshot(payer);
  // The old release takes 150 of 200: a row of 50 and lots of 200.
  await legacy.deduct({ payer, requestId: run(), credits: 150 });
  const charge = await wallet.settle({ payer, requestId: run(), amount: "60" });
  assert.deepEqual([charge.taken, charge.shortfall, charge.balance], ["50.00000000", "10.00000000", "0.00000000"], "what the account really holds is taken, and the rest is the platform's");
  await auditWallet(database, payer);
  // The old release refuses what its own row cannot cover, as it always did, and writes nothing.
  await assert.rejects(legacy.deduct({ payer, requestId: run(), credits: 1 }), { code: "simulated_wallet_insufficient" });
  await auditWallet(database, payer);
});

test("a reconcile is idempotent and keyed by entry: reading a wallet twice, or racing the old release, never draws an entry twice", options, async () => {
  const { wallet, legacy, payer } = setup();
  await wallet.snapshot(payer);
  await legacy.deduct({ payer, requestId: run(), credits: 12 });
  await legacy.topUp({ payer, packageId: "topup-50", requestId: request() });
  await Promise.all([wallet.snapshot(payer), wallet.snapshot(payer), wallet.settle({ payer, requestId: run(), amount: "1" }), legacy.deduct({ payer, requestId: run(), credits: 3 })]);
  const read = await wallet.snapshot(payer);
  assert.equal(read.balance, "234.00000000", "200 − 12 + 50 − 1 − 3");
  const { entries } = await auditWallet(database, payer);
  assert.deepEqual(entries.map((entry) => entry.kind).sort(), ["deduct", "deduct", "deduct", "grant", "topup"]);
  const draws = await database.query(`SELECT d.entry_id, count(*)::int AS n FROM evimed_credits.simulated_draws d
    JOIN evimed_credits.simulated_entries e ON e.entry_id=d.entry_id WHERE e.payer=$1 GROUP BY d.entry_id`, [payer]);
  assert.ok(draws.rows.every((row) => row.n >= 1) && draws.rowCount === 3, "each charge is drawn once");
  assert.equal((await wallet.snapshot(payer)).balance, "234.00000000", "and a third read changes nothing");
});

test("the expiry sweep and every read tolerate a wallet that is not reconciled yet: the old release's row below the lots never throws", options, async () => {
  const { wallet, legacy, time, payer } = setup();
  await wallet.snapshot(payer);
  // Row 188 against lots of 195 — the state that used to make the expiry sweep throw on `balance >= 0`.
  await legacy.deduct({ payer, requestId: run(), credits: 12 });
  time.advance(31 * DAY);
  const swept = await wallet.sweepExpiry({ payer });
  assert.equal(swept.wallets, 1);
  const after = await auditWallet(database, payer);
  assert.equal(after.balance, 0n);
  assert.deepEqual(after.entries.filter((entry) => entry.kind === "expire").map((entry) => entry.credits), ["188.00000000"], "what the account really held when its gift lapsed");
});

test("a database that already ran the lots migration is trusted as it stands when the reconcile first arrives: nothing written before is drawn again", options, async () => {
  const { wallet, payer } = setup();
  await wallet.snapshot(payer);
  await wallet.settle({ payer, requestId: run(), amount: "5" });
  // The state a wallet is in when it predates the reconcile's column: no high-water mark at all.
  await database.query("ALTER TABLE evimed_credits.simulated_wallets DROP COLUMN reconciled_through");
  const second = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 3_000 });
  try {
    const fresh = new SimulatedWallet({ database: second, startCredits: 200, now: clock(T0).now });
    await fresh.ready();
    const read = await fresh.snapshot(payer);
    assert.equal(read.balance, "195.00000000", "trusted as it stood: the settled charge is not drawn a second time");
    await auditWallet(second, payer);
  } finally { await second.close(); }
});
