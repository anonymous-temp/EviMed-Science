// The one-number simulated wallet exactly as the release before the lots shipped
// it (`git show 155f49ce6:OpenScience/apps/server/src/evimedCreditsSimulator.mjs`),
// kept verbatim as a fixture: it is what an old web process, or a rollback,
// writes onto the migrated schema. The tests that use it prove the new wallet
// brings the lots into agreement with whatever this code wrote — nothing else
// imports it, and it is never to be "fixed".
/**
 * The simulated wallet: a stand-in for EviMed's credits service that lives in
 * the control plane and moves no money (2026-10-04).
 *
 * The owner asked to see research-allowance billing working before a real wallet
 * exists: a balance, an estimate, a charge per finished task, statements, a low
 * balance, recharge and orders. So the one thing that is replaced is the wallet.
 * Charges still come from what a task really cost (the usage ledger and the
 * research-allowance policy); only the money is simulated.
 *
 * Hidden knowledge:
 *
 * - **It speaks the wire the real client expects, behind the same client.**
 *   `createSimulatedWalletFetch` is a `fetch` for `createEvimedCreditsClient`: the
 *   client builds the same POST, reads the same `{code, msg, data}` envelope and
 *   classifies failures the same way, so swapping in the real wallet is a
 *   configuration change and nothing else — there is no second code path to keep
 *   in step. A refusal is an envelope with a code other than 200 (final); an
 *   unexpected failure is an HTTP 503 (an outcome nobody knows yet, retried on the
 *   run id); a deduction is idempotent on `requestId`, answering the original
 *   receipt the second time.
 * - **It is impossible to mistake for the real wallet, in both directions.** Its
 *   payers are `sim:v1:<account>:<incarnation>` and nothing else is accepted, so
 *   a real EviMed user id is refused here; the real client refuses a `sim:` payer
 *   (`evimedCreditsClient.mjs`), so a simulated row can never be sent to the real
 *   wallet. Its tables (`simulated_wallets`, `simulated_entries`) are its own, and
 *   the rows the platform keeps about charges carry `wallet = 'simulated'`.
 * - **The payer carries the account's incarnation.** An account deleted and
 *   registered again under the same name is a new person; the old wallet is not
 *   theirs, exactly as an old statement is not (`owner_created_at`).
 * - **A wallet exists from its first sight.** The first read, deduction or top-up
 *   of an account grants the starting allowance, once, in the same transaction
 *   that creates the wallet, so two concurrent first sights grant it once — and a
 *   task finished by an account that never opened the page is still charged.
 * - **Whole credits only, never negative.** A deduction larger than the balance
 *   is refused (nothing is taken); a top-up is one of the closed packages in
 *   `@evimed/domain`, idempotent on the caller's request id.
 *
 * Build to delete: this is scaffolding for the owner's evaluation. It goes when a
 * real wallet answers the same two calls.
 *
 * @module evimedCreditsSimulator
 */

import { createHash } from "node:crypto";
import { SIMULATED_START_CREDITS, SIMULATED_TOPUP_PACKAGES } from "@evimed/domain";

/** Virtual endpoints. `.invalid` can never resolve (RFC 2606), so a request that escaped the in-process adapter could not reach anything. */
export const SIMULATED_WALLET_DEDUCT_URL = "https://simulated-wallet.invalid/credits/deduct";
export const SIMULATED_WALLET_BALANCE_URL = "https://simulated-wallet.invalid/credits/balance";
/** The bearer value the adapter expects. Not a secret, and it never leaves the process. */
export const SIMULATED_WALLET_KEY = "simulated-wallet";

/** The most credits one deduction or balance may carry: a larger number is a defect upstream of here. */
const MAX_CREDITS = 10_000_000;
const MAX_BALANCE = 1_000_000_000;
const MAX_REQUEST_ID_CHARS = 200;
const TOPUP_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
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

/**
 * Why the billing module must not come up, as a named code, or null. Both are
 * facts of the configuration, so the platform boots and the module says no
 * (principle 14: a failed billing module never stops research).
 *
 * - A simulated wallet beside a real wallet's address is a deployment that could
 *   charge neither or both: refused rather than guessed at.
 * - A starting allowance that is not a whole number of credits is a typo.
 * @param {Record<string, any>} config
 * @returns {string | null}
 */
export function evimedCreditsRefusal(config) {
  if (config?.evimedCreditsSimulated !== true) return null;
  if (String(config.evimedCreditsUrl ?? "").trim() || String(config.evimedCreditsBalanceUrl ?? "").trim()) {
    return "evimed_credits_simulated_conflict";
  }
  const start = Number(config.evimedCreditsSimulatedStartCredits ?? SIMULATED_START_CREDITS);
  if (!Number.isSafeInteger(start) || start < 1 || start > MAX_CREDITS) return "evimed_credits_simulated_start_invalid";
  return null;
}

const migrations = new WeakMap();

const sql = `
CREATE SCHEMA IF NOT EXISTS evimed_credits;
-- The simulated wallet's own tables. Nothing here is money, and nothing here is
-- ever mixed into the settlement ledger's rows: they are told apart by table.
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

/**
 * Create the simulator's tables. Idempotent, serialized by an advisory lock and
 * cached per database, like every schema this control plane owns. Only a
 * deployment that switches the simulation on ever runs it.
 * @param {any} database a `ControlPlaneDatabase`
 * @returns {Promise<void>}
 */
export async function migrateSimulatedWallet(database) {
  const cached = migrations.get(database);
  if (cached) return cached;
  const attempt = database.transaction(async (/** @type {any} */ client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-credits-simulated-v1'))");
    await client.query(sql);
  });
  migrations.set(database, attempt);
  try {
    await attempt;
  } catch (error) {
    migrations.delete(database);
    throw error;
  }
}

/** @param {any} row @returns {{ id: string, packageId: string, title: string, amount: number, at: string, status: "paid" }} */
function order(row) {
  return {
    id: String(row.receipt_id), packageId: String(row.package_id), title: "模拟充值",
    amount: Number(row.credits), at: new Date(row.created_at).toISOString(), status: "paid",
  };
}

/** @param {any} payer @returns {{ userId: string, ownerCreatedAt: string }} */
function payerOf(payer) {
  const parsed = parseSimulatedPayer(payer);
  if (!parsed) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
  return parsed;
}

export class SimulatedWallet {
  /** @param {{ database: any, startCredits?: number }} dependencies */
  constructor({ database, startCredits = SIMULATED_START_CREDITS }) {
    this.database = database;
    this.startCredits = startCredits;
  }

  /** The tables exist and can be written. @returns {Promise<void>} */
  ready() { return migrateSimulatedWallet(this.database); }

  /**
   * The wallet row for one payer, created with its starting allowance on first
   * sight. Race-safe: the loser of two concurrent creations inserts nothing and
   * grants nothing.
   * @param {any} client @param {string} payer
   */
  async #provision(client, payer) {
    const { userId, ownerCreatedAt } = payerOf(payer);
    const created = await client.query(
      `INSERT INTO evimed_credits.simulated_wallets(payer,user_id,owner_created_at,balance)
       VALUES($1,$2,$3::timestamptz,$4) ON CONFLICT (payer) DO NOTHING RETURNING payer`,
      [payer, userId, ownerCreatedAt, this.startCredits]);
    if (created.rowCount === 1) {
      await client.query(
        `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id)
         VALUES($1,'grant',$2,$3,$3,$4)`,
        [payer, `grant:${digest(payer).slice(0, 40)}`, this.startCredits, `sim_grant_${digest(payer).slice(0, 20)}`]);
    }
  }

  /**
   * One payer's balance. The first read creates the wallet and grants the
   * starting allowance.
   * @param {string} payer
   * @returns {Promise<{ balance: number, frozen: number }>}
   */
  async balance(payer) {
    payerOf(payer);
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await this.#provision(client, payer);
      const row = (await client.query("SELECT balance FROM evimed_credits.simulated_wallets WHERE payer=$1", [payer])).rows[0];
      return { balance: Number(row.balance), frozen: 0 };
    });
  }

  /**
   * Take whole credits, once per `requestId`: a repeat of the same request
   * answers the original receipt and takes nothing more.
   * @param {{ payer: string, requestId: string, credits: number, occurredAt?: string | null }} request
   * @returns {Promise<{ receiptId: string, balance: number, replay: boolean }>}
   */
  async deduct({ payer, requestId, credits, occurredAt = null }) {
    payerOf(payer);
    if (typeof requestId !== "string" || !requestId || requestId.length > MAX_REQUEST_ID_CHARS
      || !Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_CREDITS) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    const at = typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null;
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      // A wallet exists from its first sight, a deduction's included: work that
      // was done is charged, and an account that never opened the page has the
      // allowance it would have been granted when it did.
      await this.#provision(client, payer);
      const wallet = (await client.query("SELECT balance FROM evimed_credits.simulated_wallets WHERE payer=$1 FOR UPDATE", [payer])).rows[0];
      const prior = (await client.query(
        "SELECT payer,kind,credits,balance_after,receipt_id FROM evimed_credits.simulated_entries WHERE request_id=$1", [requestId])).rows[0];
      if (prior) {
        // The same request is the same deduction; anything else under its key is a defect, not a retry.
        if (prior.payer !== payer || prior.kind !== "deduct" || Number(prior.credits) !== credits) {
          throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        }
        return { receiptId: String(prior.receipt_id), balance: Number(prior.balance_after), replay: true };
      }
      const balance = Number(wallet.balance);
      if (balance < credits) throw new SimulatedWalletRefusal("simulated_wallet_insufficient", 402);
      const next = balance - credits;
      const receiptId = `sim_rcpt_${digest(requestId).slice(0, 24)}`;
      await client.query("UPDATE evimed_credits.simulated_wallets SET balance=$2 WHERE payer=$1", [payer, next]);
      await client.query(
        `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,credits,balance_after,receipt_id,occurred_at)
         VALUES($1,'deduct',$2,$3,$4,$5,$6::timestamptz)`,
        [payer, requestId, credits, next, receiptId, at]);
      return { receiptId, balance: next, replay: false };
    });
  }

  /**
   * Add one package of simulated credits, once per `requestId`.
   * @param {{ payer: string, packageId: string, requestId: string }} request
   * @returns {Promise<{ order: ReturnType<typeof order>, balance: number, duplicate: boolean }>}
   */
  async topUp({ payer, packageId, requestId }) {
    payerOf(payer);
    const pack = SIMULATED_TOPUP_PACKAGES.find((entry) => entry.id === packageId);
    if (!pack || typeof requestId !== "string" || !TOPUP_REQUEST_ID.test(requestId)) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    // Scoped to the payer: one account's request id can never replay another's.
    const key = `topup:${digest(`${payer}\0${requestId}`).slice(0, 40)}`;
    await this.ready();
    return this.database.transaction(async (/** @type {any} */ client) => {
      await this.#provision(client, payer);
      const wallet = (await client.query("SELECT balance FROM evimed_credits.simulated_wallets WHERE payer=$1 FOR UPDATE", [payer])).rows[0];
      const prior = (await client.query(
        "SELECT payer,kind,package_id,credits,receipt_id,created_at FROM evimed_credits.simulated_entries WHERE request_id=$1", [key])).rows[0];
      if (prior) {
        if (prior.payer !== payer || prior.kind !== "topup" || prior.package_id !== pack.id) {
          throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
        }
        return { order: order(prior), balance: Number(wallet.balance), duplicate: true };
      }
      const next = Number(wallet.balance) + pack.credits;
      if (next > MAX_BALANCE) throw new SimulatedWalletRefusal("simulated_wallet_balance_cap", 409);
      const receiptId = `sim_order_${digest(key).slice(0, 20)}`;
      await client.query("UPDATE evimed_credits.simulated_wallets SET balance=$2 WHERE payer=$1", [payer, next]);
      const entry = (await client.query(
        `INSERT INTO evimed_credits.simulated_entries(payer,kind,request_id,package_id,credits,balance_after,receipt_id)
         VALUES($1,'topup',$2,$3,$4,$5,$6) RETURNING package_id,credits,receipt_id,created_at`,
        [payer, key, pack.id, pack.credits, next, receiptId])).rows[0];
      return { order: order(entry), balance: next, duplicate: false };
    });
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
      `SELECT entry_id,package_id,credits,receipt_id,created_at FROM evimed_credits.simulated_entries
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
 * Remove an account's simulated wallet with the account. It holds no money and
 * no research subject, and nothing reconciles against it, so unlike a settlement
 * it is not retained. Called inside the account-deletion transaction.
 * @param {any} client @param {string} userId
 */
export async function eraseSimulatedWallets(client, userId) {
  const exists = await client.query("SELECT to_regclass('evimed_credits.simulated_wallets') AS table_name");
  if (!exists.rows[0]?.table_name) return;
  await client.query("DELETE FROM evimed_credits.simulated_wallets WHERE user_id=$1", [userId]);
}

/**
 * The simulated wallet as a `fetch` for `createEvimedCreditsClient`.
 *
 * `faults` exist for tests that need an outcome nobody knows yet: `before`
 * runs ahead of the operation (throw to lose the request), `after` runs once the
 * wallet has acted (throw to lose the answer — the debit stands and the caller
 * cannot tell, which is the case a retry on the run id exists for; return a
 * `Response` to answer something else). Neither is reachable from configuration.
 *
 * @param {{ balance: (payer: string) => Promise<any>, deduct: (request: any) => Promise<any> }} wallet
 * @param {{ before?: (operation: "balance" | "deduct", body: any) => any, after?: (operation: "balance" | "deduct", body: any, data: any) => any }} [faults]
 * @returns {typeof fetch}
 */
export function createSimulatedWalletFetch(wallet, { before, after } = {}) {
  /** @param {number} code @param {unknown} data */
  const envelope = (code, data) => Response.json(code === 200
    ? { code, msg: "success", data }
    : { code, msg: String(data) });
  return /** @type {typeof fetch} */ (async (url, init = {}) => {
    const target = String(url);
    const operation = target === SIMULATED_WALLET_DEDUCT_URL ? "deduct" : target === SIMULATED_WALLET_BALANCE_URL ? "balance" : null;
    if (!operation) return new Response("", { status: 404 });
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    if (new Headers(init.headers).get("authorization") !== `Bearer ${SIMULATED_WALLET_KEY}`) return new Response("", { status: 401 });
    /** @type {any} */
    let body = null;
    try { body = JSON.parse(String(init.body ?? "")); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return envelope(400, "simulated_wallet_request_invalid");
    const early = await before?.(operation, body);
    if (early instanceof Response) return early;
    let data;
    try {
      data = operation === "balance"
        ? await wallet.balance(body.userId)
        : await wallet.deduct({ payer: body.userId, requestId: body.requestId, credits: body.credits, occurredAt: body.occurredAt ?? null });
    } catch (error) {
      if (error instanceof SimulatedWalletRefusal) return envelope(error.status, error.code);
      // Not the wallet's refusal: an outcome nobody knows. The error text stays here.
      return new Response("", { status: 503 });
    }
    const late = await after?.(operation, body, data);
    if (late instanceof Response) return late;
    return envelope(200, operation === "balance"
      ? { balance: data.balance, frozen: data.frozen }
      : { receiptId: data.receiptId, balance: data.balance });
  });
}
