// The simulated wallet against a real PostgreSQL: the same contract the
// in-memory double passes, and the properties that are the storage's — the
// starting allowance granted once by two racing first reads, a deduction applied
// once by five racing retries, a balance the check constraint will not let go
// negative, a wallet that goes with its account, and tables that are the
// simulator's alone.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";
import { SimulatedWallet, eraseSimulatedWallets, migrateSimulatedWallet } from "../src/evimedCreditsSimulator.mjs";
import { freshPayer, simulatedWalletContract } from "./helpers/simulatedWalletContract.mjs";

const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };
const START = 200;
/** @type {any} */
let database;
/** @type {SimulatedWallet} */
let wallet;

before(async () => {
  if (!databaseUrl) return;
  database = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 8, databaseConnectionTimeoutMs: 3_000 });
  await database.migrate();
  wallet = new SimulatedWallet({ database, startCredits: START });
  await wallet.ready();
});

after(async () => {
  if (!databaseUrl) return;
  await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id LIKE 'alice\\_%' OR user_id LIKE 'bob\\_%' OR user_id LIKE 'account\\_%' OR user_id LIKE 'erase\\_%'").catch(() => {});
  await database.close?.();
});

for (const [name, run] of simulatedWalletContract) {
  test(`in PostgreSQL: ${name}`, options, async () => { await run({ wallet, start: START }); });
}

test("the simulator's tables are its own, and migrating them again changes nothing", options, async () => {
  await migrateSimulatedWallet(database);
  const tables = await database.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='evimed_credits' AND table_name LIKE 'simulated\\_%' ORDER BY table_name`);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["simulated_entries", "simulated_wallets"]);
  // Idempotent: a second migration, and a second database handle's, change nothing.
  await migrateSimulatedWallet(database);
  const second = new ControlPlaneDatabase({ databaseUrl, databasePoolMax: 2, databaseConnectionTimeoutMs: 3_000 });
  try { await migrateSimulatedWallet(second); } finally { await second.close(); }
});

test("the balance cannot go negative even past the code: the table refuses it", options, async () => {
  const payer = freshPayer();
  await wallet.balance(payer);
  await assert.rejects(database.query("UPDATE evimed_credits.simulated_wallets SET balance=-1 WHERE payer=$1", [payer]),
    (/** @type {any} */ error) => error?.code === "23514");
  await assert.rejects(database.query(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id)
    VALUES($1,'deduct',$2,0,0,'r')`, [payer, `run_${randomUUID()}`]), (/** @type {any} */ error) => error?.code === "23514");
  // An entry is one of the three kinds the wallet writes, and a request id is used once.
  await assert.rejects(database.query(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id)
    VALUES($1,'refund',$2,1,1,'r')`, [payer, `run_${randomUUID()}`]), (/** @type {any} */ error) => error?.code === "23514");
  const requestId = `run_${randomUUID()}`;
  await wallet.deduct({ payer, requestId, credits: 1 });
  await assert.rejects(database.query(`INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id)
    VALUES($1,'deduct',$2,1,1,'r')`, [payer, requestId]), (/** @type {any} */ error) => error?.code === "23505");
});

test("the ledger adds up: every balance is the grant plus top-ups minus deductions, and each entry records the balance it left", options, async () => {
  const payer = freshPayer();
  await wallet.balance(payer);
  await wallet.topUp({ payer, packageId: "topup-100", requestId: `request_${randomUUID().slice(0, 12)}` });
  await wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: 37 });
  await wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: 8 });
  const entries = (await database.query("SELECT kind,credits,balance_after FROM evimed_credits.simulated_entries WHERE payer=$1 ORDER BY entry_id", [payer])).rows;
  let running = 0;
  for (const entry of entries) {
    running += entry.kind === "deduct" ? -Number(entry.credits) : Number(entry.credits);
    assert.equal(Number(entry.balance_after), running, `${entry.kind} left ${running}`);
  }
  assert.deepEqual(entries.map((entry) => entry.kind), ["grant", "topup", "deduct", "deduct"]);
  assert.equal((await wallet.balance(payer)).balance, running);
  assert.equal(running, START + 100 - 37 - 8);
});

test("a wallet goes with its account: erasure removes the wallet and its entries, and only that account's", options, async () => {
  const doomed = simulatedErase("erase");
  const kept = simulatedErase("erase");
  for (const payer of [doomed.payer, kept.payer]) {
    await wallet.balance(payer);
    await wallet.topUp({ payer, packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 12)}` });
  }
  await database.transaction((/** @type {any} */ client) => eraseSimulatedWallets(client, doomed.userId));
  assert.equal((await database.query("SELECT 1 FROM evimed_credits.simulated_wallets WHERE payer=$1", [doomed.payer])).rowCount, 0);
  assert.equal((await database.query("SELECT 1 FROM evimed_credits.simulated_entries WHERE payer=$1", [doomed.payer])).rowCount, 0);
  assert.equal((await database.query("SELECT 1 FROM evimed_credits.simulated_entries WHERE payer=$1", [kept.payer])).rowCount, 2);
  // A wallet that is gone is made again from the starting allowance on its next read.
  assert.equal((await wallet.balance(doomed.payer)).balance, START);
});

/** @param {string} label */
function simulatedErase(label) {
  const payer = freshPayer(label);
  return { payer, userId: payer.split(":")[2] };
}
