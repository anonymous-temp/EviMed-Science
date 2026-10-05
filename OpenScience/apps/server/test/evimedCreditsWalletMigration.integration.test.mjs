// Existing wallets move onto lots without anyone losing anything, against the
// schema that actually shipped: whole credits in bigint columns, one number per
// account, no lots. The legacy tables are built from the one-number version's
// own DDL in a database of their own (the module's schema name is fixed, so it
// cannot share one with the other wallet tests), filled with wallets of every
// shape, and migrated.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { researchMoneyUnits } from "@evimed/domain";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SimulatedWallet, migrateSimulatedWallet } from "../src/evimedCreditsSimulator.mjs";
import { auditWallet, databaseOptions as options, databaseUrl, freshPayer } from "./helpers/creditWalletFixture.mjs";

/** The one-number wallet's DDL as it shipped on 2026-10-04, verbatim. */
const LEGACY_DDL = `
CREATE SCHEMA IF NOT EXISTS evimed_credits;
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_wallets (
  payer text PRIMARY KEY,
  user_id text NOT NULL,
  owner_created_at timestamptz NOT NULL,
  balance bigint NOT NULL CHECK (balance >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_entries (
  entry_id bigserial PRIMARY KEY,
  payer text NOT NULL REFERENCES evimed_credits.simulated_wallets(payer) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('grant','topup','deduct')),
  request_id text NOT NULL UNIQUE,
  package_id text,
  credits bigint NOT NULL CHECK (credits > 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  receipt_id text NOT NULL,
  occurred_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evimed_simulated_entries_payer_idx
  ON evimed_credits.simulated_entries(payer, created_at DESC, entry_id DESC);
`;

const name = `evimed_test_r5_billing_legacy_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
/** @type {any} */
let database;
/** @type {pg.Client | null} */
let admin = null;

before(async () => {
  if (!databaseUrl) return;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const legacyUrl = new URL(databaseUrl);
  legacyUrl.pathname = `/${name}`;
  database = new ControlPlaneDatabase({ databaseUrl: legacyUrl.toString(), databasePoolMax: 4, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
});

after(async () => {
  if (!databaseUrl) return;
  await database?.close?.();
  await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  await admin?.end().catch(() => {});
});

const units = (/** @type {string} */ value) => researchMoneyUnits(value);

/**
 * A wallet as the one-number version left it: a grant, top-ups and deductions, each
 * entry recording the balance it left, and the balance the sum of them.
 * @param {{ grant?: number, topups?: number[], deductions?: number[] }} history
 */
async function legacyWallet({ grant = 0, topups = [], deductions = [] }) {
  const payer = freshPayer("legacy");
  const userId = payer.split(":")[2];
  let balance = 0;
  const entries = [];
  if (grant) entries.push(["grant", grant]);
  for (const credits of topups) entries.push(["topup", credits]);
  for (const credits of deductions) entries.push(["deduct", credits]);
  const final = entries.reduce((sum, [kind, credits]) => sum + (kind === "deduct" ? -Number(credits) : Number(credits)), 0);
  await database.query("INSERT INTO evimed_credits.simulated_wallets(payer,user_id,owner_created_at,balance) VALUES($1,$2,'2026-10-03T00:00:00.123456Z',$3)", [payer, userId, final]);
  for (const [kind, credits] of entries) {
    balance += kind === "deduct" ? -Number(credits) : Number(credits);
    await database.query(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,package_id,credits,balance_after,receipt_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [payer, kind, `${kind}:${randomUUID()}`, kind === "topup" ? `topup-${credits}` : null, credits, balance, `r_${randomUUID().slice(0, 8)}`]);
  }
  return { payer, balance: final };
}

test("existing wallets migrate onto lots without anyone losing anything: the gift left is max(0, G − D), the rest is purchased, and the history is kept", options, async () => {
  // The schema as it shipped, with wallets of every shape in it.
  await database.query(LEGACY_DDL);
  const shapes = {
    // G 200, T 100, D 50: B 250 → gifted 150, purchased 100.
    spentSome: await legacyWallet({ grant: 200, topups: [50, 50], deductions: [30, 20] }),
    // G 200, T 100, D 260: B 40 → the gift is gone, 40 is purchased.
    spentTheGift: await legacyWallet({ grant: 200, topups: [100], deductions: [150, 110] }),
    // Untouched: all gifted.
    untouched: await legacyWallet({ grant: 200 }),
    // Spent to nothing.
    empty: await legacyWallet({ grant: 200, deductions: [200] }),
    // A balance with no history to read a split from: the balance is the fact.
    historyless: await legacyWallet({ topups: [7] }),
  };
  const types = (await database.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='evimed_credits' AND table_name='simulated_wallets' AND column_name='balance'`)).rows[0];
  assert.equal(types.data_type, "bigint", "the fixture really is the shipped schema");
  const before = new Map();
  for (const [shape, { payer }] of Object.entries(shapes)) {
    before.set(shape, (await database.query("SELECT kind,credits::text AS credits,balance_after::text AS balance_after,request_id,receipt_id FROM evimed_credits.simulated_entries WHERE payer=$1 ORDER BY entry_id", [payer])).rows);
  }

  // The migration runs at the first boot after the release, dated by its own clock.
  await migrateSimulatedWallet(database, { now: () => new Date("2026-10-06T03:00:00.000Z") });

  const lotsOf = async (/** @type {string} */ payer) => (await database.query(
    "SELECT kind,source,granted::text AS granted,remaining::text AS remaining,expires_at,note FROM evimed_credits.simulated_lots WHERE payer=$1 ORDER BY kind DESC", [payer])).rows;
  const expectations = {
    spentSome: ["150.00000000", "100.00000000"],
    spentTheGift: [null, "40.00000000"],
    untouched: ["200.00000000", null],
    empty: [null, null],
    historyless: [null, "7.00000000"],
  };
  for (const [shape, [gifted, purchased]] of Object.entries(expectations)) {
    const { payer, balance } = shapes[/** @type {keyof typeof shapes} */ (shape)];
    const lots = await lotsOf(payer);
    const gift = lots.find((lot) => lot.kind === "gifted");
    const bought = lots.find((lot) => lot.kind === "purchased");
    assert.equal(gift?.remaining ?? null, gifted, `${shape}: gifted`);
    assert.equal(bought?.remaining ?? null, purchased, `${shape}: purchased`);
    if (gift) {
      assert.equal(gift.source, "signup");
      // 30 days after the migration: 6 October in Shanghai, through 5 November, to its 24:00.
      assert.equal(new Date(gift.expires_at).toISOString(), "2026-11-05T16:00:00.000Z");
    }
    if (bought) assert.equal(bought.expires_at, null, "purchased never expires");
    // Nobody loses anything: the wallet holds what it held, and every property of a wallet holds.
    const audited = await auditWallet(database, payer);
    assert.equal(audited.balance, BigInt(balance) * 100_000_000n, `${shape}: the balance is unchanged`);
    const after = (await database.query("SELECT kind,credits::text AS credits,balance_after::text AS balance_after,request_id,receipt_id FROM evimed_credits.simulated_entries WHERE payer=$1 ORDER BY entry_id", [payer])).rows;
    assert.deepEqual(after.map((row) => [row.kind, units(row.credits), units(row.balance_after), row.request_id, row.receipt_id]),
      before.get(shape).map((/** @type {any} */ row) => [row.kind, units(row.credits), units(row.balance_after), row.request_id, row.receipt_id]), `${shape}: the history is kept`);
  }
  for (const column of ["balance"]) {
    const row = (await database.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='evimed_credits' AND table_name='simulated_wallets' AND column_name='${column}'`)).rows[0];
    assert.equal(row.data_type, "numeric");
  }
  // The old grant line points at the gift it became, so a statement can say when it ends.
  const grantLine = (await database.query(`SELECT l.source, l.expires_at FROM evimed_credits.simulated_entries e JOIN evimed_credits.simulated_lots l ON l.lot_id=e.lot_id
    WHERE e.payer=$1 AND e.kind='grant'`, [shapes.spentSome.payer])).rows[0];
  assert.equal(grantLine.source, "signup");

  // Idempotent: another process, another handle, another day changes nothing.
  const snapshot = async () => JSON.stringify((await database.query("SELECT payer,kind,granted::text,remaining::text,expires_at FROM evimed_credits.simulated_lots ORDER BY lot_id")).rows);
  const first = await snapshot();
  const second = new ControlPlaneDatabase({ databaseUrl: new URL(`/${name}`, databaseUrl).toString(), databasePoolMax: 2, databaseConnectionTimeoutMs: 3_000 });
  try { await migrateSimulatedWallet(second, { now: () => new Date("2026-12-01T00:00:00.000Z") }); } finally { await second.close(); }
  assert.equal(await snapshot(), first);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM evimed_credits.schema_migrations WHERE version='exact-wallet-lots-v1'")).rows[0].n, 1);

  // A migrated wallet is an ordinary one: the gift is spent first, then what was bought.
  const wallet = new SimulatedWallet({ database, startCredits: 200, now: () => new Date("2026-10-07T03:00:00.000Z") });
  const charge = await wallet.settle({ payer: shapes.spentSome.payer, requestId: `run_${randomUUID()}`, amount: "160.5" });
  assert.deepEqual(charge.lots.map((draw) => [draw.kind, draw.amount]), [["gifted", "150.00000000"], ["purchased", "10.50000000"]]);
  assert.equal(charge.balance, "89.50000000");
  await auditWallet(database, shapes.spentSome.payer);
  // A wallet made after the migration gets its own sign-up gift and is not touched by the marker.
  const fresh = freshPayer("after");
  assert.equal((await wallet.snapshot(fresh)).gifted, "200.00000000");
});
