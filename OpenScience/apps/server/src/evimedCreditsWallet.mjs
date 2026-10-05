/**
 * The platform's own 灵豆 wallet: lots, holds, an atomic take-up-to, expiry
 * (2026-10-05). It replaces the one-number simulated wallet and speaks to nobody
 * over a wire: the billing service calls it inside its own database
 * transaction, so a charge and the settlement row that records it are one commit.
 *
 * Hidden knowledge — what makes this safe to run on money:
 *
 * - **A balance is a set of lots, never a number.** A lot is `purchased`
 *   (充值: never expires, never reset, never taken back) or `gifted` (赠送: its
 *   source and its expiry fixed and shown the moment it is granted). The wallet
 *   row's `balance` is only the sum of its lots' `remaining`, kept in step in the
 *   same statement-pair that changes a lot and CHECKed `>= 0` by the table; every
 *   lot is CHECKed `0 <= remaining <= granted`. For every lot,
 *   `remaining = granted − Σ draws` (`simulated_draws`), and for every wallet
 *   `balance = Σ remaining`: nothing moves 灵豆 except an entry that says so.
 * - **Exact, in the database's own arithmetic.** Amounts are `numeric(20,8)`
 *   and travel as decimal strings; the only arithmetic done in JS is `bigint` of
 *   1e-8 units (`RESEARCH_MONEY_SCALE`). No money passes through a JS float.
 * - **One lock per wallet, taken first.** Every operation begins by locking the
 *   wallet row (`FOR UPDATE`), so two settlements, a settlement and an expiry
 *   sweep, a hold and a top-up, are strictly ordered and each sees the other's
 *   committed result. This is also what makes "take up to what is available" one
 *   atomic operation: the read of what is available and the deduction are one
 *   critical section, never a read followed by a deduct.
 * - **Spending order.** Gifted before purchased; among gifted, the soonest
 *   expiry first, a tie to the older lot; purchased last, oldest first. One charge
 *   may draw on several lots and the record (`simulated_draws`) says which.
 *   Gifted 灵豆 pay for anything purchased ones do.
 * - **A hold is part of the balance and is not available.** `frozen` is the sum
 *   of the open holds; `available = balance − frozen`. A hold is keyed by the
 *   run it belongs to (so it is placed once), cannot outlive its run (released
 *   when the run's charge is taken, and swept after its own deadline if the process
 *   died) and never moves 灵豆 between lots: it only makes them unavailable.
 * - **A gifted lot that was valid when a run's hold was placed pays for that
 *   run**, even if its date passes while the run works: a lot is not expired while
 *   an open hold was placed before its date, and a run's charge draws on the lots
 *   that were valid at the instant its hold was placed.
 * - **Expiry is its own statement line.** It is written by the sweep
 *   (`sweepExpiry`, from the credits worker) and, because a balance that is stale
 *   until the next tick is a wrong balance, also by every operation that touches
 *   the wallet — the same code under the same lock.
 * - **Gifts are idempotent by a key that names what they are for**: the sign-up
 *   gift by the wallet, the monthly gift by wallet and cycle, an operator's by
 *   the operator's own request id. A replay changes nothing; a different request
 *   under the same key is a conflict, not a retry.
 *
 * The wallet is the platform's own, which is why the sign-up gift, the lots and
 * the take-up-to exist here and not behind `evimedCreditsClient.mjs`: the
 * external wallet's wire is integer-only and out of this repository's hands
 * (see `evimedCreditsService.mjs` for what it would have to support).
 *
 * @module evimedCreditsWallet
 */

import { createHash } from "node:crypto";
import {
  CREDIT_GIFT_MAX_DAYS, CREDIT_OPERATOR_GRANT_DEFAULT_DAYS, CREDIT_OPERATOR_GRANT_SOURCES, RESEARCH_MONEY_SCALE,
  SIMULATED_START_CREDITS, expiryInstantAfterDays, expiryInstantOfDate, monthlyCycleAt, researchMoneyDecimal, researchMoneyUnits,
} from "@evimed/domain";

const MAX_REQUEST_ID_CHARS = 200;
/** The most one account may hold: a larger number is a defect upstream of here. */
const MAX_BALANCE_UNITS = 1_000_000_000n * RESEARCH_MONEY_SCALE;
/** The most one operator grant may carry: a typo in an amount is not a gift. */
const MAX_GRANT_UNITS = 100_000n * RESEARCH_MONEY_SCALE;
const MAX_NOTE_CHARS = 200;
const GRANT_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** `sim:v1:<account id as `safeId` spells one>:<account creation instant, UTC microseconds>`. */
const PAYER = /^sim:v1:([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)$/;

/** SQL that spells an account's creation instant the way a payer id does, whatever the session's time zone. */
export const SIMULATED_INCARNATION_SQL = `to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** @param {string} text */
const digest = (text) => createHash("sha256").update(text).digest("hex");

/** A refusal the wallet itself makes: final, and the answer to the same request every time. */
export class SimulatedWalletRefusal extends Error {
  /** @param {string} code @param {number} status the envelope code the wire carries */
  constructor(code, status) {
    super(code);
    this.name = "SimulatedWalletRefusal";
    /** @type {string} */
    this.code = code;
    /** @type {number} */
    this.status = status;
  }
}

/**
 * The payer id of one account incarnation.
 * @param {string} userId @param {string} incarnation UTC microseconds, `YYYY-MM-DDTHH:MM:SS.ffffffZ`
 */
export function simulatedPayerId(userId, incarnation) {
  const payer = `sim:v1:${userId}:${incarnation}`;
  if (!PAYER.test(payer)) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
  return payer;
}

/** @param {unknown} value @returns {{ userId: string, ownerCreatedAt: string } | null} */
export function parseSimulatedPayer(value) {
  const match = typeof value === "string" ? PAYER.exec(value) : null;
  return match ? { userId: match[1], ownerCreatedAt: match[2] } : null;
}

/** @param {any} payer @returns {{ userId: string, ownerCreatedAt: string }} */
function payerOf(payer) {
  const parsed = parseSimulatedPayer(payer);
  if (!parsed) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
  return parsed;
}

/**
 * An amount a caller names, as exact units: a decimal string or an integer, at
 * most 8 decimals, above zero unless `allowZero`. Anything else is refused whole.
 * @param {unknown} value @param {{ allowZero?: boolean }} [options]
 * @returns {bigint}
 */
function amountUnits(value, { allowZero = false } = {}) {
  let units;
  try {
    // A number is read through its shortest decimal form, so an amount that is not exactly
    // representable in 8 decimals (0.1 + 0.2) is refused rather than rounded.
    units = researchMoneyUnits(typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "x");
  } catch { throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400); }
  if (units === 0n && !allowZero) throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
  return units;
}

/** @param {unknown} value @returns {bigint} a database `numeric(20,8)`, which arrives as a string */
const unitsOf = (value) => researchMoneyUnits(String(value ?? "0"));

const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_credits;
CREATE TABLE IF NOT EXISTS evimed_credits.schema_migrations (
  version text PRIMARY KEY
);
-- The wallet's own tables. Nothing here is mixed into the settlement ledger's
-- rows: they are told apart by table. The prefix is historical — the wallet began
-- as a stand-in for an external one and is now the platform's own.
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_wallets (
  payer text PRIMARY KEY,
  user_id text NOT NULL,
  owner_created_at timestamptz NOT NULL,
  balance numeric(20,8) NOT NULL CHECK (balance >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
-- A lot: one grant, one top-up. 'purchased' never expires and is always from a
-- top-up; 'gifted' always has a source and an expiry. There is no third kind.
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_lots (
  lot_id bigserial PRIMARY KEY,
  payer text NOT NULL REFERENCES evimed_credits.simulated_wallets(payer) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('purchased','gifted')),
  source text NOT NULL CHECK (source IN ('topup','signup','monthly','compensation','campaign')),
  granted numeric(20,8) NOT NULL CHECK (granted > 0),
  remaining numeric(20,8) NOT NULL CHECK (remaining >= 0),
  expires_at timestamptz(3),
  request_id text NOT NULL UNIQUE,
  note text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK (remaining <= granted),
  CHECK ((kind = 'purchased') = (expires_at IS NULL)),
  CHECK ((kind = 'purchased') = (source = 'topup'))
);
CREATE INDEX IF NOT EXISTS simulated_lots_spend_idx
  ON evimed_credits.simulated_lots(payer, kind, expires_at, created_at, lot_id) WHERE remaining > 0;
CREATE INDEX IF NOT EXISTS simulated_lots_expiry_idx
  ON evimed_credits.simulated_lots(expires_at, lot_id) WHERE remaining > 0 AND kind = 'gifted';
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_entries (
  entry_id bigserial PRIMARY KEY,
  payer text NOT NULL REFERENCES evimed_credits.simulated_wallets(payer) ON DELETE CASCADE,
  kind text NOT NULL,
  request_id text NOT NULL UNIQUE,
  package_id text,
  credits numeric(20,8) NOT NULL CHECK (credits > 0),
  balance_after numeric(20,8) NOT NULL CHECK (balance_after >= 0),
  receipt_id text NOT NULL,
  occurred_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS evimed_simulated_entries_payer_idx
  ON evimed_credits.simulated_entries(payer, created_at DESC, entry_id DESC);
-- The lot a grant or a top-up line created, so a statement can say its source and expiry.
ALTER TABLE evimed_credits.simulated_entries ADD COLUMN IF NOT EXISTS lot_id bigint REFERENCES evimed_credits.simulated_lots(lot_id) ON DELETE SET NULL;
-- Which lots one charge or one expiry took from, and how much of each.
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_draws (
  entry_id bigint NOT NULL REFERENCES evimed_credits.simulated_entries(entry_id) ON DELETE CASCADE,
  lot_id bigint NOT NULL REFERENCES evimed_credits.simulated_lots(lot_id) ON DELETE CASCADE,
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (entry_id, lot_id)
);
-- A hold: 灵豆 frozen for one run. Part of the balance, not available. One per run.
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_holds (
  hold_id bigserial PRIMARY KEY,
  payer text NOT NULL REFERENCES evimed_credits.simulated_wallets(payer) ON DELETE CASCADE,
  run_id text NOT NULL UNIQUE,
  amount numeric(20,8) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('open','released')),
  placed_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  released_at timestamptz(3),
  release_reason text CHECK (release_reason IN ('settled','swept')),
  CHECK ((status = 'open') = (released_at IS NULL))
);
CREATE INDEX IF NOT EXISTS simulated_holds_open_idx ON evimed_credits.simulated_holds(payer) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS simulated_holds_sweep_idx ON evimed_credits.simulated_holds(expires_at) WHERE status = 'open';

-- Which entries of a wallet its lots already reflect (review F1). The one-number
-- code, still serving after the migration or back after a rollback, moves a wallet's
-- balance and appends entries without touching a lot; every entry above this mark was
-- written by somebody who did not keep the lots, and the new code applies it to them
-- (the reconcile step) under the wallet lock, then moves the mark. A database that has
-- already migrated is trusted as it stands when the column first appears.
DO $reconcile$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'evimed_credits'
      AND table_name = 'simulated_wallets' AND column_name = 'reconciled_through') THEN
    ALTER TABLE evimed_credits.simulated_wallets ADD COLUMN reconciled_through bigint NOT NULL DEFAULT 0;
    IF EXISTS (SELECT 1 FROM evimed_credits.schema_migrations WHERE version = 'exact-wallet-lots-v1') THEN
      UPDATE evimed_credits.simulated_wallets w SET reconciled_through =
        coalesce((SELECT max(e.entry_id) FROM evimed_credits.simulated_entries e WHERE e.payer = w.payer), 0);
    END IF;
  END IF;
END $reconcile$;
-- A reminder that has been written, once per lot and day count, so the sweep reads only
-- what still needs one and never re-submits what it has already sent.
CREATE TABLE IF NOT EXISTS evimed_credits.simulated_reminders (
  lot_id bigint NOT NULL REFERENCES evimed_credits.simulated_lots(lot_id) ON DELETE CASCADE,
  days integer NOT NULL CHECK (days > 0),
  sent_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (lot_id, days)
);

-- A wallet that was made by the one-number version holds whole credits in bigint
-- columns and has no lots: bring its columns to exact amounts, and let its entry
-- kinds name the new lines (expire, adjust). The lots themselves are written by
-- the migration step, once, in code.
DO $exact$
DECLARE stale record;
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'evimed_credits'
      AND table_name = 'simulated_wallets' AND column_name = 'balance') = 'bigint' THEN
    ALTER TABLE evimed_credits.simulated_wallets ALTER COLUMN balance TYPE numeric(20,8);
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'evimed_credits'
      AND table_name = 'simulated_entries' AND column_name = 'credits') = 'bigint' THEN
    ALTER TABLE evimed_credits.simulated_entries ALTER COLUMN credits TYPE numeric(20,8);
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'evimed_credits'
      AND table_name = 'simulated_entries' AND column_name = 'balance_after') = 'bigint' THEN
    ALTER TABLE evimed_credits.simulated_entries ALTER COLUMN balance_after TYPE numeric(20,8);
  END IF;
  FOR stale IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'evimed_credits.simulated_entries'::regclass AND contype = 'c'
      AND conname <> 'simulated_entries_kind_v2'
      AND pg_get_constraintdef(oid) LIKE '%''deduct''%' AND pg_get_constraintdef(oid) LIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE evimed_credits.simulated_entries DROP CONSTRAINT %I', stale.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'evimed_credits.simulated_entries'::regclass
      AND conname = 'simulated_entries_kind_v2') THEN
    ALTER TABLE evimed_credits.simulated_entries ADD CONSTRAINT simulated_entries_kind_v2
      CHECK (kind IN ('grant','topup','deduct','expire','adjust'));
  END IF;
END $exact$;
`;

/** The marker of the one-time move of existing wallets onto lots. */
const LOTS_MIGRATION = "exact-wallet-lots-v1";
/** How long the gifted lot a migration makes for an existing wallet lasts, in days. */
export const MIGRATED_GIFT_DAYS = 30;

/**
 * Move every existing wallet onto lots, once, without anyone losing anything.
 *
 * For a wallet with balance B, grants G, top-ups T and deductions D (B = G + T − D)
 * the gifted 灵豆 left are `max(0, G − D)` — spending is taken from the gift first,
 * as the new order does, so a history of spending is read as gift-first — held as
 * one lot of source `signup` that expires `MIGRATED_GIFT_DAYS` after the migration,
 * and the purchased ones are `B − that`, in one lot that never expires. Entries
 * keep their history; the old grant line points at the gifted lot and the old
 * top-ups at the purchased one. The balance is read as it stands (B is the fact; G
 * and D only decide the split), so a wallet is never changed in total.
 *
 * Idempotent by its marker; the caller holds the module's advisory lock.
 * @param {any} client @param {Date} now
 */
async function migrateWalletsToLots(client, now) {
  const done = await client.query("SELECT 1 FROM evimed_credits.schema_migrations WHERE version=$1", [LOTS_MIGRATION]);
  if (done.rowCount) return;
  const wallets = (await client.query(`SELECT w.payer, w.balance::text AS balance,
      coalesce(sum(e.credits) FILTER (WHERE e.kind='grant'),0)::text AS grants,
      coalesce(sum(e.credits) FILTER (WHERE e.kind='deduct'),0)::text AS deductions
    FROM evimed_credits.simulated_wallets w LEFT JOIN evimed_credits.simulated_entries e ON e.payer=w.payer
    WHERE NOT EXISTS (SELECT 1 FROM evimed_credits.simulated_lots l WHERE l.payer=w.payer)
    GROUP BY w.payer, w.balance ORDER BY w.payer`)).rows;
  const expiresAt = expiryInstantAfterDays(now, MIGRATED_GIFT_DAYS).toISOString();
  for (const wallet of wallets) {
    const balance = unitsOf(wallet.balance);
    const giftLeft = unitsOf(wallet.grants) - unitsOf(wallet.deductions);
    const gifted = giftLeft > 0n ? (giftLeft < balance ? giftLeft : balance) : 0n;
    const purchased = balance - gifted;
    const key = digest(wallet.payer).slice(0, 40);
    const migrated = JSON.stringify({ grants: wallet.grants, deductions: wallet.deductions, balance: wallet.balance });
    if (gifted > 0n) {
      const created = (await client.query(`INSERT INTO evimed_credits.simulated_lots(payer,kind,source,granted,remaining,expires_at,request_id,note)
        VALUES($1,'gifted','signup',$2,$2,$3::timestamptz,$4,$5) RETURNING lot_id`,
      [wallet.payer, researchMoneyDecimal(gifted), expiresAt, `migrated:gifted:${key}`, `migrated ${migrated}`])).rows[0];
      await client.query("UPDATE evimed_credits.simulated_entries SET lot_id=$2 WHERE payer=$1 AND kind='grant'", [wallet.payer, created.lot_id]);
    }
    if (purchased > 0n) {
      const created = (await client.query(`INSERT INTO evimed_credits.simulated_lots(payer,kind,source,granted,remaining,request_id,note)
        VALUES($1,'purchased','topup',$2,$2,$3,$4) RETURNING lot_id`,
      [wallet.payer, researchMoneyDecimal(purchased), `migrated:purchased:${key}`, `migrated ${migrated}`])).rows[0];
      await client.query("UPDATE evimed_credits.simulated_entries SET lot_id=$2 WHERE payer=$1 AND kind='topup'", [wallet.payer, created.lot_id]);
    }
  }
  // Everything written so far is what the lots above were made from: the mark says so, and only what the old
  // code writes from here on is reconciled.
  await client.query(`UPDATE evimed_credits.simulated_wallets w SET reconciled_through =
    coalesce((SELECT max(e.entry_id) FROM evimed_credits.simulated_entries e WHERE e.payer = w.payer), 0)`);
  await client.query("INSERT INTO evimed_credits.schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [LOTS_MIGRATION]);
}

/**
 * Create the wallet's tables and move existing wallets onto lots. Idempotent,
 * serialized by an advisory lock and cached per database, like every schema this
 * control plane owns. Only a deployment that switches the wallet on ever runs it.
 * @param {any} database a `ControlPlaneDatabase`
 * @param {{ now?: () => Date }} [options] the clock the migration's gifted lot is dated by
 * @returns {Promise<void>}
 */
export async function migrateSimulatedWallet(database, { now = () => new Date() } = {}) {
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-credits-simulated-v1'))");
    await client.query(sql);
    await migrateWalletsToLots(client, now());
  });
  migrations.set(database, attempt);
  try {
    await attempt;
  } catch (error) {
    migrations.delete(database);
    throw error;
  }
}

/**
 * @typedef {{ lotId: string, kind: 'purchased' | 'gifted', source: string, expiresAt: string | null, amount: string }} LotDraw
 * @typedef {{ available: string, balance: string, purchased: string, gifted: string, frozen: string,
 *   nextExpiry: { amount: string, at: string } | null }} WalletSnapshot
 */

/**
 * A lot row as the rest of the platform reads it.
 * @param {any} row
 */
function lot(row) {
  return {
    lotId: String(row.lot_id), kind: row.kind, source: row.source, granted: String(row.granted), remaining: String(row.remaining),
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(), note: row.note ?? null,
  };
}

/** @param {any} row @returns {{ id: string, packageId: string, title: string, amount: number, at: string, status: "paid" }} */
function order(row) {
  return {
    id: String(row.receipt_id), packageId: String(row.package_id), title: "模拟充值",
    amount: Number(row.credits), at: new Date(row.created_at).toISOString(), status: "paid",
  };
}

export class CreditWallet {
  /**
   * @param {{ database: any, startCredits?: number, signupGiftDays?: number, monthlyGift?: number | string,
   *   now?: () => Date }} dependencies
   *   `startCredits` is the sign-up gift in whole credits and `signupGiftDays` how long it lasts; `monthlyGift` is
   *   the monthly gift in 灵豆, 0 for none.
   */
  constructor({ database, startCredits = SIMULATED_START_CREDITS, signupGiftDays = 30, monthlyGift = 0, now = () => new Date() }) {
    this.database = database;
    this.startCredits = startCredits;
    this.signupGiftDays = signupGiftDays;
    this.monthlyGiftUnits = amountUnits(monthlyGift, { allowZero: true });
    this.now = now;
  }

  /** The tables exist, existing wallets are on lots, and the wallet can be written. @returns {Promise<void>} */
  ready() { return migrateSimulatedWallet(this.database, { now: this.now }); }

  /**
   * Run `work` in the caller's transaction, or in one of its own.
   * @template T @param {any} client @param {(client: any) => Promise<T>} work @returns {Promise<T>}
   */
  #within(client, work) {
    return client ? work(client) : this.database.transaction(work);
  }

  /**
   * Make the wallet exist, lock it, and bring it up to the present: the lots
   * brought into agreement with whatever the one-number code wrote since (review
   * F1), the sign-up gift on first sight, the lots that have expired, and this
   * cycle's monthly gift. Everything an operation reads afterwards is true at the
   * `at` it returns, which is read after the lock is held: entries are stamped in
   * the order they are written (review F9).
   * @param {any} client @param {string} payer
   * @returns {Promise<{ payer: string, userId: string, createdAt: Date, at: Date }>}
   */
  async #prepare(client, payer) {
    const { userId, ownerCreatedAt } = payerOf(payer);
    const created = await client.query(
      `INSERT INTO evimed_credits.simulated_wallets(payer,user_id,owner_created_at,balance,created_at)
       VALUES($1,$2,$3::timestamptz,0,$4::timestamptz) ON CONFLICT (payer) DO NOTHING RETURNING payer`,
      [payer, userId, ownerCreatedAt, this.now().toISOString()]);
    const wallet = (await client.query("SELECT payer,balance::text AS balance,created_at FROM evimed_credits.simulated_wallets WHERE payer=$1 FOR UPDATE", [payer])).rows[0];
    const at = this.now();
    if (created.rowCount === 1 && this.startCredits > 0) {
      // The loser of two concurrent first sights inserts nothing and grants nothing.
      await this.#addLot(client, {
        payer, kind: "gifted", source: "signup", amount: amountUnits(this.startCredits), requestId: `grant:${digest(payer).slice(0, 40)}`,
        expiresAt: expiryInstantAfterDays(at, this.signupGiftDays), at, entryKind: "grant", receiptPrefix: "sim_grant_",
      });
    }
    await this.#reconcile(client, payer, at);
    await this.#expireDue(client, payer, at);
    await this.#grantMonthly(client, payer, new Date(wallet.created_at), at);
    return { payer, userId, createdAt: new Date(wallet.created_at), at };
  }

  /**
   * Bring a wallet's lots into agreement with entries somebody else wrote (review
   * F1). Called under the wallet lock, so nothing can be writing it. The one-number
   * code moves `balance` and appends an entry and knows nothing of lots; this reads
   * each entry above the wallet's mark, in order, and does to the lots what the new
   * code would have done: a sign-up or any other grant becomes a gifted lot (a
   * sign-up gift ends as a new sign-up gift does), a top-up a purchased one, and a
   * charge is drawn from the lots in the normal order. It moves the mark entry by
   * entry, so it is idempotent and keyed by entry id, and it never writes a new
   * statement line: the old line is the line.
   *
   * It never throws on what it finds. A charge the lots cannot cover in full — they
   * lapsed, or the history was never what the row said — draws what there is, and
   * `#syncBalance` makes the row what the lots are.
   * @param {any} client @param {string} payer @param {Date} at
   * @returns {Promise<number>} how many entries were applied
   */
  async #reconcile(client, payer, at) {
    const mark = (await client.query("SELECT reconciled_through::text AS mark FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rows[0];
    const entries = (await client.query(
      `SELECT entry_id, kind, request_id, credits::text AS credits, created_at FROM evimed_credits.simulated_entries
        WHERE payer=$1 AND entry_id > $2::bigint ORDER BY entry_id`, [payer, mark.mark])).rows;
    for (const entry of entries) {
      const amount = unitsOf(entry.credits);
      const when = new Date(entry.created_at);
      if (entry.kind === "grant" || entry.kind === "topup") {
        const gifted = entry.kind === "grant";
        const lotRow = (await client.query(
          `INSERT INTO evimed_credits.simulated_lots(payer,kind,source,granted,remaining,expires_at,request_id,note,created_at)
           VALUES($1,$2,$3,$4,$4,$5::timestamptz,$6,$7,$8::timestamptz) ON CONFLICT (request_id) DO UPDATE SET request_id=excluded.request_id
           RETURNING lot_id`,
          [payer, gifted ? "gifted" : "purchased", gifted ? "signup" : "topup", researchMoneyDecimal(amount),
            gifted ? expiryInstantAfterDays(when, this.signupGiftDays).toISOString() : null, entry.request_id,
            "reconciled from the one-number wallet", when.toISOString()])).rows[0];
        await client.query("UPDATE evimed_credits.simulated_entries SET lot_id=$2 WHERE entry_id=$1", [entry.entry_id, lotRow.lot_id]);
      } else if (entry.kind === "deduct") {
        const already = await client.query("SELECT 1 FROM evimed_credits.simulated_draws WHERE entry_id=$1", [entry.entry_id]);
        if (!already.rowCount) {
          // The order a charge is drawn in, as of when it happened; a lot that had already lapsed is drawn last, and
          // only if nothing else is there, because the old code did not know it had.
          const lots = (await client.query(
            `SELECT lot_id, remaining::text AS remaining FROM evimed_credits.simulated_lots WHERE payer=$1 AND remaining>0
              ORDER BY (expires_at IS NOT NULL AND expires_at <= $2::timestamptz), (kind='purchased'), expires_at ASC NULLS LAST, created_at, lot_id FOR UPDATE`,
            [payer, when.toISOString()])).rows;
          let left = amount;
          for (const row of lots) {
            if (left === 0n) break;
            const have = unitsOf(row.remaining);
            const part = have < left ? have : left;
            await client.query("UPDATE evimed_credits.simulated_lots SET remaining=remaining-$2 WHERE lot_id=$1", [row.lot_id, researchMoneyDecimal(part)]);
            await client.query("INSERT INTO evimed_credits.simulated_draws(entry_id,lot_id,amount) VALUES($1,$2,$3)", [entry.entry_id, row.lot_id, researchMoneyDecimal(part)]);
            left -= part;
          }
        }
      }
      await client.query("UPDATE evimed_credits.simulated_wallets SET reconciled_through=$2::bigint WHERE payer=$1", [payer, entry.entry_id]);
    }
    if (entries.length) await this.#syncBalance(client, payer);
    return entries.length;
  }

  /**
   * Make the wallet's row what its lots are: the sum of what is left in them, and never
   * negative. The row is only a cache of that sum, so any operation that moves a lot ends
   * by saying so, and a row somebody else moved is corrected by the next one.
   * @param {any} client @param {string} payer @returns {Promise<bigint>}
   */
  async #syncBalance(client, payer) {
    const row = (await client.query(
      `UPDATE evimed_credits.simulated_wallets w SET balance = coalesce((SELECT sum(remaining) FROM evimed_credits.simulated_lots l WHERE l.payer = w.payer), 0)
        WHERE w.payer=$1 RETURNING balance::text AS balance`, [payer])).rows[0];
    return unitsOf(row.balance);
  }

  /**
   * One lot and the entry that created it, and the balance they move.
   * @param {any} client
   * @param {{ payer: string, kind: 'purchased' | 'gifted', source: string, amount: bigint, requestId: string,
   *   expiresAt?: Date | null, at: Date, entryKind: 'grant' | 'topup', receiptPrefix: string, packageId?: string | null, note?: string | null }} input
   * @returns {Promise<{ lot: any, entry: any, balance: bigint }>}
   */
  async #addLot(client, { payer, kind, source, amount, requestId, expiresAt = null, at, entryKind, receiptPrefix, packageId = null, note = null }) {
    const held = unitsOf((await client.query(
      "SELECT coalesce(sum(remaining),0)::text AS held FROM evimed_credits.simulated_lots WHERE payer=$1", [payer])).rows[0].held);
    if (held + amount > MAX_BALANCE_UNITS) throw new SimulatedWalletRefusal("simulated_wallet_balance_cap", 409);
    const created = (await client.query(
      `INSERT INTO evimed_credits.simulated_lots(payer,kind,source,granted,remaining,expires_at,request_id,note,created_at)
       VALUES($1,$2,$3,$4,$4,$5::timestamptz,$6,$7,$8::timestamptz) RETURNING *`,
      [payer, kind, source, researchMoneyDecimal(amount), expiresAt?.toISOString() ?? null, requestId, note, at.toISOString()])).rows[0];
    const next = await this.#syncBalance(client, payer);
    const entry = (await client.query(
      `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,package_id,credits,balance_after,receipt_id,lot_id,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz) RETURNING *`,
      [payer, entryKind, requestId, packageId, researchMoneyDecimal(amount), researchMoneyDecimal(next),
        `${receiptPrefix}${digest(requestId).slice(0, 20)}`, created.lot_id, at.toISOString()])).rows[0];
    await client.query("UPDATE evimed_credits.simulated_wallets SET reconciled_through=$2::bigint WHERE payer=$1", [payer, entry.entry_id]);
    return { lot: created, entry, balance: next };
  }

  /**
   * Expire every gifted lot whose date has passed, each as its own `expire`
   * entry — except a lot that an open hold, placed before its date, still needs.
   * Called under the wallet lock.
   * @param {any} client @param {string} payer @param {Date} at @returns {Promise<bigint>} what expired
   */
  async #expireDue(client, payer, at) {
    const due = (await client.query(
      `SELECT l.lot_id, l.remaining::text AS remaining FROM evimed_credits.simulated_lots l
        WHERE l.payer=$1 AND l.kind='gifted' AND l.remaining>0 AND l.expires_at <= $2::timestamptz
          AND NOT EXISTS (SELECT 1 FROM evimed_credits.simulated_holds h
            WHERE h.payer=l.payer AND h.status='open' AND h.placed_at < l.expires_at)
        ORDER BY l.expires_at, l.lot_id FOR UPDATE`, [payer, at.toISOString()])).rows;
    let expired = 0n;
    for (const row of due) {
      const amount = unitsOf(row.remaining);
      await client.query("UPDATE evimed_credits.simulated_lots SET remaining=0 WHERE lot_id=$1", [row.lot_id]);
      const balance = await this.#syncBalance(client, payer);
      const requestId = `expire:${row.lot_id}`;
      const entry = (await client.query(
        `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id,lot_id,created_at)
         VALUES($1,'expire',$2,$3,$4,$5,$6,$7::timestamptz) RETURNING entry_id`,
        [payer, requestId, researchMoneyDecimal(amount), researchMoneyDecimal(balance), `sim_expire_${digest(requestId).slice(0, 20)}`, row.lot_id, at.toISOString()])).rows[0];
      await client.query("INSERT INTO evimed_credits.simulated_draws(entry_id,lot_id,amount) VALUES($1,$2,$3)", [entry.entry_id, row.lot_id, researchMoneyDecimal(amount)]);
      await client.query("UPDATE evimed_credits.simulated_wallets SET reconciled_through=$2::bigint WHERE payer=$1", [payer, entry.entry_id]);
      expired += amount;
    }
    return expired;
  }

  /**
   * This cycle's monthly gift, once. The cycle is the account's own: its date is
   * the day of the month the wallet was created on, clamped to the month's length,
   * and the lot expires where the next cycle begins, so nothing carries over. Only
   * the current cycle is ever granted — a month nobody was looking at is not
   * granted late — and the key names wallet and cycle, so a second read of the
   * same cycle grants nothing. Off when the amount is 0.
   * @param {any} client @param {string} payer @param {Date} createdAt @param {Date} at
   */
  async #grantMonthly(client, payer, createdAt, at) {
    if (this.monthlyGiftUnits <= 0n) return;
    const cycle = monthlyCycleAt(createdAt, at);
    if (!cycle) return;
    const requestId = `monthly:${digest(payer).slice(0, 40)}:${cycle.index}`;
    const exists = await client.query("SELECT 1 FROM evimed_credits.simulated_lots WHERE request_id=$1", [requestId]);
    if (exists.rowCount) return;
    await this.#addLot(client, {
      payer, kind: "gifted", source: "monthly", amount: this.monthlyGiftUnits, requestId, expiresAt: cycle.endsAt, at,
      entryKind: "grant", receiptPrefix: "sim_monthly_",
    });
  }

  /**
   * What a start at `validAt` may use: the one definition every reader, hold and charge shares
   * (review F3). A lot is usable at `validAt` while its date is after it. A gifted lot past its
   * date that is still here is here only because an open hold, placed before the date, keeps it
   * alive: it can back such a hold and nothing else, so it is not counted in what any other
   * start may use. What the open holds freeze is taken from the usable lots only beyond what those
   * lapsed lots back, and a hold placed after a lapsed lot's date can never be backed by it:
   *
   *     usable = Σ lots valid at validAt − (frozen − backed)
   *
   * where `backed` is how much of the frozen the lapsed lots can carry — worked out hold by hold, the latest
   * placed first (what it can reach is a subset of what an earlier one can, so this is the best assignment).
   *
   * @param {any} client @param {string} payer @param {Date} validAt
   * @param {{ ignoreHoldOf?: string | null, lock?: boolean }} [options] `ignoreHoldOf` leaves one run's own hold out of
   *   what is frozen; `lock` takes the lots' row locks, for the charge that draws them
   * @returns {Promise<{ eligible: any[], purchased: bigint, gifted: bigint, lapsed: bigint, frozen: bigint, backed: bigint, usable: bigint }>}
   */
  async #usable(client, payer, validAt, { ignoreHoldOf = null, lock = false } = {}) {
    const lots = (await client.query(
      `SELECT lot_id, kind, source, expires_at, remaining::text AS remaining FROM evimed_credits.simulated_lots
        WHERE payer=$1 AND remaining>0 ORDER BY (kind='purchased'), expires_at ASC NULLS LAST, created_at ASC, lot_id ASC${lock ? " FOR UPDATE" : ""}`, [payer])).rows;
    const eligible = lots.filter((row) => row.expires_at == null || new Date(row.expires_at).getTime() > validAt.getTime());
    const sum = (/** @type {any[]} */ rows, /** @type {string | null} */ kind = null) => rows
      .filter((row) => kind === null || row.kind === kind).reduce((total, row) => total + unitsOf(row.remaining), 0n);
    const lapsedLots = lots.filter((row) => !eligible.includes(row));
    const holds = (await client.query(
      `SELECT amount::text AS amount, placed_at FROM evimed_credits.simulated_holds
        WHERE payer=$1 AND status='open' AND ($2::text IS NULL OR run_id <> $2) ORDER BY placed_at DESC, hold_id DESC`, [payer, ignoreHoldOf])).rows;
    const pool = lapsedLots.map((row) => ({ ends: new Date(row.expires_at).getTime(), left: unitsOf(row.remaining) }));
    let frozen = 0n;
    let backed = 0n;
    for (const hold of holds) {
      let need = unitsOf(hold.amount);
      frozen += need;
      for (const lapsedLot of pool) {
        if (need === 0n) break;
        if (lapsedLot.ends <= new Date(hold.placed_at).getTime() || lapsedLot.left === 0n) continue;
        const part = lapsedLot.left < need ? lapsedLot.left : need;
        lapsedLot.left -= part;
        need -= part;
        backed += part;
      }
    }
    const owed = frozen - backed;
    const valid = sum(eligible);
    return { eligible, purchased: sum(eligible, "purchased"), gifted: sum(eligible, "gifted"), lapsed: sum(lapsedLots), frozen, backed, usable: valid > owed ? valid - owed : 0n };
  }

  /**
   * What an account holds and what of it can be used, at `at`. The header the page draws is
   * true arithmetic: available = purchased + gifted − frozen, where gifted and purchased are what
   * a start may use now, and frozen is what the open holds take out of it. A gift past its date
   * that a running run still holds is that run's alone (`#usable`) and is in none of the three;
   * `balance` is everything in the lots.
   * @param {any} client @param {string} payer @param {Date} at @param {{ ignoreHoldOf?: string | null }} [options]
   * @returns {Promise<WalletSnapshot>}
   */
  async #read(client, payer, at, { ignoreHoldOf = null } = {}) {
    const state = await this.#usable(client, payer, at, { ignoreHoldOf });
    const next = (await client.query(
      `SELECT expires_at, sum(remaining)::text AS amount FROM evimed_credits.simulated_lots
        WHERE payer=$1 AND kind='gifted' AND remaining>0 AND expires_at > $2::timestamptz AND expires_at = (
          SELECT min(expires_at) FROM evimed_credits.simulated_lots WHERE payer=$1 AND kind='gifted' AND remaining>0 AND expires_at > $2::timestamptz)
        GROUP BY expires_at`, [payer, at.toISOString()])).rows[0];
    const shownFrozen = state.frozen - state.backed;
    return {
      available: researchMoneyDecimal(state.usable), balance: researchMoneyDecimal(state.purchased + state.gifted + state.lapsed),
      purchased: researchMoneyDecimal(state.purchased), gifted: researchMoneyDecimal(state.gifted), frozen: researchMoneyDecimal(shownFrozen),
      nextExpiry: next ? { amount: String(next.amount), at: new Date(next.expires_at).toISOString() } : null,
    };
  }

  /**
   * An account's balance: what is held, what of it is frozen, what is available,
   * and the next gift to expire. The first read creates the wallet and grants the
   * sign-up gift.
   * @param {string} payer @param {{ client?: any, ignoreHoldOf?: string | null }} [options] `ignoreHoldOf` leaves one run's
   *   own hold out of what is frozen: the question a run's own follow-up is asked, or a replay of its own start
   * @returns {Promise<WalletSnapshot>}
   */
  async snapshot(payer, { client = null, ignoreHoldOf = null } = {}) {
    payerOf(payer);
    await this.ready();
    return this.#within(client, async (/** @type {any} */ tx) => {
      const { at } = await this.#prepare(tx, payer);
      return this.#read(tx, payer, at, { ignoreHoldOf });
    });
  }

  /**
   * Freeze up to `amount` for one run, the smaller of that and what is
   * available. Once per run: a second call, and a call for a run whose hold has
   * been released, change nothing. Nothing is frozen when nothing is available.
   * @param {{ payer: string, runId: string, amount: string | number, ttlMs: number, client?: any }} request
   * @returns {Promise<{ held: string, replay: boolean }>}
   */
  async hold({ payer, runId, amount, ttlMs, client = null }) {
    payerOf(payer);
    const wanted = amountUnits(amount, { allowZero: true });
    if (typeof runId !== "string" || !runId || runId.length > MAX_REQUEST_ID_CHARS || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    await this.ready();
    return this.#within(client, async (/** @type {any} */ tx) => {
      const { at } = await this.#prepare(tx, payer);
      const prior = (await tx.query("SELECT payer, status, amount::text AS amount FROM evimed_credits.simulated_holds WHERE run_id=$1", [runId])).rows[0];
      if (prior) {
        if (prior.payer !== payer) throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        // What is frozen now: a hold that has been released, or swept, freezes nothing and is never placed again.
        return { held: prior.status === "open" ? String(prior.amount) : researchMoneyDecimal(0n), replay: true };
      }
      // What can be frozen is what a start may use now (`#usable`): a lot whose date has passed is not backing a
      // start that begins after it, and what another run's hold has frozen is not free.
      const free = (await this.#usable(tx, payer, at)).usable;
      const held = wanted < free ? wanted : free;
      if (held <= 0n) return { held: researchMoneyDecimal(0n), replay: false };
      await tx.query(
        `INSERT INTO evimed_credits.simulated_holds(payer,run_id,amount,status,placed_at,expires_at) VALUES($1,$2,$3,'open',$4::timestamptz,$5::timestamptz)`,
        [payer, runId, researchMoneyDecimal(held), at.toISOString(), new Date(at.getTime() + ttlMs).toISOString()]);
      return { held: researchMoneyDecimal(held), replay: false };
    });
  }

  /**
   * Let a run's hold go, without a charge: the run ended on a path that takes
   * none. Idempotent; a run with no hold, or one already released, is a no-op.
   * @param {{ runId: string, client?: any }} request
   * @returns {Promise<boolean>} whether a hold was open
   */
  async release({ runId, client = null }) {
    if (typeof runId !== "string" || !runId) return false;
    await this.ready();
    return this.#within(client, async (/** @type {any} */ tx) => {
      const result = await tx.query(
        `UPDATE evimed_credits.simulated_holds SET status='released', released_at=$2::timestamptz, release_reason='settled'
          WHERE run_id=$1 AND status='open'`, [runId, this.now().toISOString()]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Release every hold whose deadline has passed: the run it belonged to is over
   * or its process died, and a hold must never outlive its run.
   * @param {{ payer?: string | null }} [options] only this payer's holds (the sweep is otherwise the deployment's)
   * @returns {Promise<number>}
   */
  async sweepHolds({ payer = null } = {}) {
    await this.ready();
    const result = await this.database.query(
      `UPDATE evimed_credits.simulated_holds SET status='released', released_at=$1::timestamptz, release_reason='swept'
        WHERE status='open' AND expires_at <= $1::timestamptz AND ($2::text IS NULL OR payer=$2)`, [this.now().toISOString(), payer]);
    return result.rowCount ?? 0;
  }

  /**
   * Take up to `amount` for one finished run, release its hold, and say what was
   * taken and from where — one operation under the wallet's lock.
   *
   * Never more than a start may use (`#usable`): what the account holds minus what other runs
   * have frozen, counting only the lots that were valid when this run's hold was
   * placed (or now, for a run with none). The shortfall is returned, not owed:
   * the caller records it as absorbed by the platform. The balance never goes
   * below zero. Once per `requestId`: a replay answers what was recorded and takes
   * nothing more.
   *
   * @param {{ payer: string, requestId: string, amount: string | number, holdRunId?: string | null, occurredAt?: string | null, client?: any }} request
   * @returns {Promise<{ taken: string, shortfall: string, lots: LotDraw[], balance: string, receiptId: string | null, at: string, replay: boolean }>}
   *   `balance` is what the charge left, the balance its own entry records; `at` is when the wallet wrote it
   */
  async settle({ payer, requestId, amount, holdRunId = null, occurredAt = null, client = null }) {
    payerOf(payer);
    const requested = amountUnits(amount, { allowZero: true });
    if (typeof requestId !== "string" || !requestId || requestId.length > MAX_REQUEST_ID_CHARS) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    const stamp = typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null;
    await this.ready();
    return this.#within(client, async (/** @type {any} */ tx) => {
      // A wallet exists from its first sight, a charge's included: work that was
      // done is charged, and an account that never opened the page has the gift
      // it would have been granted when it did.
      const { at } = await this.#prepare(tx, payer);
      const prior = (await tx.query("SELECT entry_id,payer,kind,credits::text AS credits,balance_after::text AS balance_after,receipt_id,created_at FROM evimed_credits.simulated_entries WHERE request_id=$1", [requestId])).rows[0];
      if (prior) {
        if (prior.payer !== payer || prior.kind !== "deduct") throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        return { taken: String(prior.credits), shortfall: researchMoneyDecimal(0n), lots: await this.#draws(tx, prior.entry_id), balance: String(prior.balance_after),
          receiptId: String(prior.receipt_id), at: new Date(prior.created_at).toISOString(), replay: true };
      }
      /** @type {Date | null} */
      let asOf = null;
      if (holdRunId) {
        const hold = (await tx.query("SELECT placed_at, payer, status FROM evimed_credits.simulated_holds WHERE run_id=$1 FOR UPDATE", [holdRunId])).rows[0];
        if (hold && hold.payer !== payer) throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        if (hold) asOf = new Date(hold.placed_at);
        if (hold?.status === "open") {
          await tx.query(
            "UPDATE evimed_credits.simulated_holds SET status='released', released_at=$2::timestamptz, release_reason='settled' WHERE run_id=$1",
            [holdRunId, at.toISOString()]);
        }
      }
      const validAt = asOf && asOf < at ? asOf : at;
      const state = await this.#usable(tx, payer, validAt, { lock: true });
      const take = requested < state.usable ? requested : state.usable;
      /** @type {LotDraw[]} */
      const draws = [];
      let balance = await this.#syncBalance(tx, payer);
      let receiptId = null;
      if (take > 0n) {
        let left = take;
        /** @type {Array<{ row: any, amount: bigint }>} */
        const plan = [];
        for (const row of state.eligible) {
          if (left === 0n) break;
          const have = unitsOf(row.remaining);
          const part = have < left ? have : left;
          plan.push({ row, amount: part });
          left -= part;
        }
        for (const { row, amount: part } of plan) {
          await tx.query("UPDATE evimed_credits.simulated_lots SET remaining=remaining-$2 WHERE lot_id=$1", [row.lot_id, researchMoneyDecimal(part)]);
        }
        balance = await this.#syncBalance(tx, payer);
        receiptId = `sim_rcpt_${digest(requestId).slice(0, 24)}`;
        const entry = (await tx.query(
          `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id,occurred_at,created_at)
           VALUES($1,'deduct',$2,$3,$4,$5,$6::timestamptz,$7::timestamptz) RETURNING entry_id`,
          [payer, requestId, researchMoneyDecimal(take), researchMoneyDecimal(balance), receiptId, stamp, at.toISOString()])).rows[0];
        for (const { row, amount: part } of plan) {
          await tx.query("INSERT INTO evimed_credits.simulated_draws(entry_id,lot_id,amount) VALUES($1,$2,$3)", [entry.entry_id, row.lot_id, researchMoneyDecimal(part)]);
          draws.push({ lotId: String(row.lot_id), kind: row.kind, source: row.source, expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(), amount: researchMoneyDecimal(part) });
        }
        await tx.query("UPDATE evimed_credits.simulated_wallets SET reconciled_through=$2::bigint WHERE payer=$1", [payer, entry.entry_id]);
      }
      // The balance this charge left: what its entry records and its statement line shows. A gift a hold kept alive
      // past its date goes right after, as a line of its own that records its own balance.
      const afterCharge = balance;
      await this.#expireDue(tx, payer, at);
      return { taken: researchMoneyDecimal(take), shortfall: researchMoneyDecimal(requested - take), lots: draws, balance: researchMoneyDecimal(afterCharge),
        receiptId, at: at.toISOString(), replay: false };
    });
  }

  /** @param {any} client @param {string | number} entryId @returns {Promise<LotDraw[]>} */
  async #draws(client, entryId) {
    const rows = (await client.query(
      `SELECT l.lot_id, l.kind, l.source, l.expires_at, d.amount::text AS amount FROM evimed_credits.simulated_draws d
         JOIN evimed_credits.simulated_lots l ON l.lot_id=d.lot_id WHERE d.entry_id=$1 ORDER BY (l.kind='purchased'), l.expires_at ASC NULLS LAST, l.lot_id`, [entryId])).rows;
    return rows.map((/** @type {any} */ row) => ({ lotId: String(row.lot_id), kind: row.kind, source: row.source,
      expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(), amount: String(row.amount) }));
  }

  /**
   * Add 灵豆 the account bought, once per `requestId`: a purchased lot, which
   * never expires.
   * @param {{ payer: string, amount: string | number, requestId: string, packageId?: string | null }} request
   * @returns {Promise<{ order: ReturnType<typeof order>, balance: string, available: string, duplicate: boolean }>}
   *   `balance` is everything the wallet holds, `available` what of it a start may use now: the number a page shows after a top-up
   */
  async credit({ payer, amount, requestId, packageId = null }) {
    payerOf(payer);
    const units = amountUnits(amount);
    if (typeof requestId !== "string" || !GRANT_REQUEST_ID.test(requestId)) throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    // Scoped to the payer: one account's request id can never replay another's.
    const key = `topup:${digest(`${payer}\0${requestId}`).slice(0, 40)}`;
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const { at } = await this.#prepare(tx, payer);
      const prior = (await tx.query("SELECT payer,kind,package_id,credits::text AS credits,receipt_id,created_at FROM evimed_credits.simulated_entries WHERE request_id=$1", [key])).rows[0];
      if (prior) {
        if (prior.payer !== payer || prior.kind !== "topup" || prior.package_id !== packageId || unitsOf(prior.credits) !== units) {
          throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        }
        const read = await this.#read(tx, payer, at);
        return { order: order(prior), balance: read.balance, available: read.available, duplicate: true };
      }
      const added = await this.#addLot(tx, {
        payer, kind: "purchased", source: "topup", amount: units, requestId: key, at, entryKind: "topup", receiptPrefix: "sim_order_", packageId,
      });
      const read = await this.#read(tx, payer, at);
      return { order: order(added.entry), balance: read.balance, available: read.available, duplicate: false };
    });
  }

  /**
   * An operator's grant: one gifted lot with a source, an amount, an expiry date
   * fixed now and a note, once per `requestId`.
   * @param {{ payer: string, requestId: string, source: string, amount: string | number, expiresOn?: string | null,
   *   days?: number | null, note?: string | null }} request
   * @returns {Promise<{ lot: ReturnType<typeof lot>, balance: string, duplicate: boolean }>}
   */
  async grant({ payer, requestId, source, amount, expiresOn = null, days = null, note = null }) {
    payerOf(payer);
    const units = amountUnits(amount);
    if (units > MAX_GRANT_UNITS || typeof requestId !== "string" || !GRANT_REQUEST_ID.test(requestId)
      || !CREDIT_OPERATOR_GRANT_SOURCES.includes(source)
      || (note != null && (typeof note !== "string" || note.length > MAX_NOTE_CHARS))
      || (expiresOn != null && days != null)) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    await this.ready();
    const key = `grant:op:${digest(`${payer}\0${requestId}`).slice(0, 40)}`;
    return this.database.transaction(async (/** @type {any} */ tx) => {
      const { at } = await this.#prepare(tx, payer);
      const prior = (await tx.query("SELECT * FROM evimed_credits.simulated_lots WHERE request_id=$1", [key])).rows[0];
      if (prior) {
        if (prior.payer !== payer || prior.source !== source || unitsOf(prior.granted) !== units) throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        const wallet = (await tx.query("SELECT balance::text AS balance FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rows[0];
        return { lot: lot(prior), balance: String(wallet.balance), duplicate: true };
      }
      /** @type {Date} */
      let expiresAt;
      try {
        expiresAt = expiresOn != null ? expiryInstantOfDate(expiresOn)
          : expiryInstantAfterDays(at, days ?? CREDIT_OPERATOR_GRANT_DEFAULT_DAYS);
        if (expiresAt.getTime() <= at.getTime() || expiresAt.getTime() - at.getTime() > (CREDIT_GIFT_MAX_DAYS + 1) * 86_400_000) throw new RangeError("expiry out of range");
      } catch { throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400); }
      const added = await this.#addLot(tx, {
        payer, kind: "gifted", source, amount: units, requestId: key, expiresAt, at, entryKind: "grant", receiptPrefix: "sim_gift_", note,
      });
      return { lot: lot(added.lot), balance: researchMoneyDecimal(added.balance), duplicate: false };
    });
  }

  /**
   * Expire every lot in the deployment whose date has passed, a wallet at a
   * time, each as its own statement line. The credits worker's sweep; every
   * operation on a wallet does the same for that wallet, so this is what makes a
   * dormant account's expiry appear without anyone opening the page.
   *
   * A wallet that fails — whatever is wrong with it — is skipped and counted, and the rest of the batch
   * goes on: one bad wallet never starves the others every tick (review F10). Each wallet is
   * reconciled with what the one-number code wrote before its lots are expired.
   * @param {{ limit?: number, payer?: string | null }} [options] `payer` sweeps one wallet only
   * @returns {Promise<{ wallets: number, failed: number }>}
   */
  async sweepExpiry({ limit = 200, payer: only = null } = {}) {
    await this.ready();
    const bound = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 200)));
    const due = (await this.database.query(
      `SELECT DISTINCT payer FROM (SELECT l.payer FROM evimed_credits.simulated_lots l
         WHERE l.kind='gifted' AND l.remaining>0 AND l.expires_at <= $1::timestamptz AND ($3::text IS NULL OR l.payer=$3)
           AND NOT EXISTS (SELECT 1 FROM evimed_credits.simulated_holds h WHERE h.payer=l.payer AND h.status='open' AND h.placed_at < l.expires_at)
         ORDER BY l.expires_at LIMIT $2) due`,
      [this.now().toISOString(), bound, only])).rows;
    let failed = 0;
    for (const { payer } of due) {
      try {
        await this.database.transaction(async (/** @type {any} */ tx) => {
          // Lock first; then bring the lots up to what the old code wrote, then expire what is due under the lock.
          await tx.query("SELECT 1 FROM evimed_credits.simulated_wallets WHERE payer=$1 FOR UPDATE", [payer]);
          const at = this.now();
          await this.#reconcile(tx, payer, at);
          await this.#expireDue(tx, payer, at);
        });
      } catch {
        failed += 1;
      }
    }
    return { wallets: due.length - failed, failed };
  }

  /**
   * The gifted lots that are due a reminder now and have not had it: within 7 days of their end, or within 1,
   * old enough to have had that mark, with something left, and no reminder written yet for that day count.
   * The same rule as `expiryReminderDue`, decided in the database so the sweep reads only what needs work and
   * a thousand lots that all end at one instant are read a batch at a time and never again.
   * @param {{ limit?: number, skip?: readonly string[] }} [options] `skip` names lot ids to leave out (ones that failed lately)
   * @returns {Promise<Array<{ userId: string, payer: string, lotId: string, remaining: string, expiresAt: string, createdAt: string, source: string, days: 7 | 1 }>>}
   */
  async lotsDueForReminder({ limit = 200, skip = [] } = {}) {
    await this.ready();
    const at = this.now();
    const rows = (await this.database.query(
      `SELECT w.user_id, l.payer, l.lot_id, l.remaining::text AS remaining, l.expires_at, l.created_at, l.source, d.days
         FROM evimed_credits.simulated_lots l
         JOIN evimed_credits.simulated_wallets w ON w.payer=l.payer
         CROSS JOIN LATERAL (SELECT CASE
             WHEN $1::timestamptz >= l.expires_at - interval '1 day' AND l.created_at < l.expires_at - interval '1 day' THEN 1
             WHEN $1::timestamptz >= l.expires_at - interval '7 days' AND l.created_at < l.expires_at - interval '7 days' THEN 7 END AS days) d
        WHERE l.kind='gifted' AND l.remaining>0 AND l.expires_at > $1::timestamptz AND d.days IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM evimed_credits.simulated_reminders r WHERE r.lot_id=l.lot_id AND r.days=d.days)
          AND NOT (l.lot_id::text = ANY($3::text[]))
        ORDER BY l.expires_at, l.lot_id LIMIT $2`,
      [at.toISOString(), Math.max(1, Math.min(1_000, limit)), skip])).rows;
    return rows.map((/** @type {any} */ row) => ({ userId: row.user_id, payer: row.payer, lotId: String(row.lot_id), remaining: String(row.remaining),
      expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), source: row.source, days: /** @type {7 | 1} */ (Number(row.days)) }));
  }

  /**
   * Write down that a lot's reminder for a day count has been sent. Once: a second call is a no-op.
   * @param {string} lotId @param {number} days @returns {Promise<boolean>} whether this call wrote it
   */
  async markReminded(lotId, days) {
    await this.ready();
    const result = await this.database.query(
      "INSERT INTO evimed_credits.simulated_reminders(lot_id,days) VALUES($1,$2) ON CONFLICT DO NOTHING", [lotId, days]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * One payer's top-ups, newest first, by keyset.
   * @param {string} payer @param {{ limit?: number, cursor?: string | null }} [options]
   * @returns {Promise<{ items: ReturnType<typeof order>[], nextCursor: string | null }>}
   */
  async orders(payer, { limit = 20, cursor = null } = {}) {
    payerOf(payer);
    /** @type {[string, string] | null} */
    let position = null;
    if (cursor) {
      try {
        if (cursor.length > 512) throw new Error("long");
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isFinite(Date.parse(decoded[0])) || !/^\d{1,18}$/.test(String(decoded[1]))) throw new Error("shape");
        position = [new Date(decoded[0]).toISOString(), String(decoded[1])];
      } catch { throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400); }
    }
    const bound = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    await this.ready();
    const result = await this.database.query(
      `SELECT entry_id,package_id,credits::text AS credits,receipt_id,created_at FROM evimed_credits.simulated_entries
        WHERE payer=$1 AND kind='topup'
          AND ($2::timestamptz IS NULL OR (created_at,entry_id) < ($2::timestamptz,$3::bigint))
        ORDER BY created_at DESC, entry_id DESC LIMIT $4`,
      [payer, position?.[0] ?? null, position?.[1] ?? null, bound + 1]);
    const rows = result.rows.slice(0, bound);
    const last = rows.at(-1);
    const nextCursor = result.rows.length > bound && last
      ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(), String(last.entry_id)])).toString("base64url") : null;
    return { items: rows.map(order), nextCursor };
  }
}

/**
 * Remove an account's wallet with the account. It holds no money and no
 * research subject, and nothing reconciles against it, so unlike a settlement
 * it is not retained. Called inside the account-deletion transaction; its lots,
 * entries, draws and holds go with it.
 * @param {any} client @param {string} userId
 */
export async function eraseSimulatedWallets(client, userId) {
  const exists = await client.query("SELECT to_regclass('evimed_credits.simulated_wallets') AS table_name");
  if (!exists.rows[0]?.table_name) return;
  await client.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [userId]);
}
