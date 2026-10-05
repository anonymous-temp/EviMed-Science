// What every PostgreSQL-backed 灵豆 test shares: the guarded connection, a payer
// nobody else is using, a clock a test can move, and the audit that proves the
// wallet adds up to the last 1e-8. A store double for the wallet would not
// enforce its CHECK constraints or its locks, which is what these tests are
// for, so there is none.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { researchMoneyUnits } from "@evimed/domain";
import { simulatedPayerId } from "../../src/evimedCreditsWallet.mjs";

export const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
export const databaseOptions = { skip: !databaseUrl && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

/** The incarnation every test account is minted with: the payer parses, and the wallet never looks the account up. */
export const INCARNATION = "2026-10-03T00:00:00.123456Z";

/** @param {string} [label] */
export function freshPayer(label = "wallet") {
  return simulatedPayerId(`${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`, INCARNATION);
}

/**
 * A clock a test moves. With `tick` it also moves itself: every reading is `tick` milliseconds after the
 * last, the way a real clock is between two statements — which is what makes an instant read before a lock
 * differ from one read after it.
 * @param {string} start @param {number} [tick]
 */
export function clock(start, tick = 0) {
  const state = { at: new Date(start) };
  return {
    now: () => { const value = new Date(state.at); state.at = new Date(state.at.getTime() + tick); return value; },
    set(/** @type {string} */ value) { state.at = new Date(value); },
    advance(/** @type {number} */ ms) { state.at = new Date(state.at.getTime() + ms); },
  };
}

/** @param {unknown} value */
const units = (value) => researchMoneyUnits(String(value));

/**
 * The properties that must hold for every wallet after every operation, to the
 * last 1e-8: each lot is `0 <= remaining <= granted` and is exactly what its
 * draws left of it; the wallet's balance is the sum of its lots and never
 * negative; the sum of what was granted and bought, less what was taken and what
 * expired, is the balance; and each entry records the balance it left.
 * @param {any} database @param {string} payer
 * @returns {Promise<{ balance: bigint, lots: any[], entries: any[] }>}
 */
export async function auditWallet(database, payer) {
  const wallet = (await database.query("SELECT balance::text AS balance FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rows[0];
  assert.ok(wallet, "the wallet exists");
  const balance = units(wallet.balance);
  assert.ok(balance >= 0n, "the balance is never negative");
  const lots = (await database.query(`SELECT l.lot_id, l.kind, l.source, l.expires_at, l.granted::text AS granted, l.remaining::text AS remaining,
      coalesce((SELECT sum(d.amount) FROM evimed_credits.simulated_draws d WHERE d.lot_id=l.lot_id),0)::text AS drawn
    FROM evimed_credits.simulated_lots l WHERE l.payer=$1 ORDER BY l.lot_id`, [payer])).rows;
  let remaining = 0n;
  for (const lot of lots) {
    const [granted, left, drawn] = [units(lot.granted), units(lot.remaining), units(lot.drawn)];
    assert.ok(left >= 0n && left <= granted, `lot ${lot.lot_id} stays within 0..granted`);
    assert.equal(left, granted - drawn, `lot ${lot.lot_id} is its grant less its draws`);
    remaining += left;
  }
  assert.equal(balance, remaining, "the balance is the sum of the lots");
  const entries = (await database.query(
    "SELECT entry_id, kind, credits::text AS credits, balance_after::text AS balance_after FROM evimed_credits.simulated_entries WHERE payer=$1 ORDER BY entry_id", [payer])).rows;
  let running = 0n;
  for (const entry of entries) {
    running += ["grant", "topup"].includes(entry.kind) ? units(entry.credits) : -units(entry.credits);
    assert.ok(running >= 0n, "no entry takes the balance below zero");
    assert.equal(units(entry.balance_after), running, `entry ${entry.entry_id} records the balance it left`);
  }
  assert.equal(running, balance, "grants + top-ups − taken − expired is the balance");
  return { balance, lots, entries };
}

/** @param {any} database @param {string} payer */
export async function removeWallet(database, payer) {
  await database.query("DELETE FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer]).catch(() => {});
}
