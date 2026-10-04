// The simulated wallet's contract, written once and run against both of its
// implementations: the PostgreSQL one (`SimulatedWallet`, CI) and the in-memory
// double below (everywhere, including a machine with no database). A double that
// is only compared with itself proves nothing, so every property here is stated
// against the wallet's own public methods, and the two must agree on all of them.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { SIMULATED_TOPUP_PACKAGES } from "@evimed/domain";
import { SimulatedWalletRefusal, parseSimulatedPayer, simulatedPayerId } from "../../src/evimedCreditsSimulator.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");

/** A payer for a fresh account incarnation. */
export function freshPayer(label = "account") {
  return simulatedPayerId(`${label}_${randomUUID().replaceAll("-", "").slice(0, 20)}`, "2026-10-03T00:00:00.123456Z");
}

/**
 * `SimulatedWallet` in memory, with the same refusals. Every operation is
 * synchronous between its check and its write, which is the atomicity the
 * database gives the real one with a row lock.
 */
export class MemorySimulatedWallet {
  constructor({ startCredits = 200, now = () => new Date() } = {}) {
    this.startCredits = startCredits;
    this.now = now;
    this.wallets = new Map();
    this.entries = [];
    this.byRequest = new Map();
    this.sequence = 0;
  }

  async ready() {}

  #wallet(payer) {
    const parsed = parseSimulatedPayer(payer);
    if (!parsed) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
    if (!this.wallets.has(payer)) {
      this.wallets.set(payer, { balance: this.startCredits, ...parsed });
      this.#entry({ payer, kind: "grant", requestId: `grant:${digest(payer).slice(0, 40)}`, credits: this.startCredits, balanceAfter: this.startCredits, receiptId: `sim_grant_${digest(payer).slice(0, 20)}` });
    }
    return this.wallets.get(payer);
  }

  #entry({ payer, kind, requestId, credits, balanceAfter, receiptId, packageId = null }) {
    const entry = { entryId: String(++this.sequence), payer, kind, requestId, credits, balanceAfter, receiptId, packageId, createdAt: this.now() };
    this.entries.push(entry);
    this.byRequest.set(requestId, entry);
    return entry;
  }

  async balance(payer) {
    return { balance: this.#wallet(payer).balance, frozen: 0 };
  }

  async deduct({ payer, requestId, credits }) {
    if (!parseSimulatedPayer(payer)) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
    if (typeof requestId !== "string" || !requestId || requestId.length > 200 || !Number.isSafeInteger(credits) || credits <= 0 || credits > 10_000_000) {
      throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    }
    const wallet = this.#wallet(payer);
    const prior = this.byRequest.get(requestId);
    if (prior) {
      if (prior.payer !== payer || prior.kind !== "deduct" || prior.credits !== credits) throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
      return { receiptId: prior.receiptId, balance: prior.balanceAfter, replay: true };
    }
    if (wallet.balance < credits) throw new SimulatedWalletRefusal("simulated_wallet_insufficient", 402);
    wallet.balance -= credits;
    const receiptId = `sim_rcpt_${digest(requestId).slice(0, 24)}`;
    this.#entry({ payer, kind: "deduct", requestId, credits, balanceAfter: wallet.balance, receiptId });
    return { receiptId, balance: wallet.balance, replay: false };
  }

  async topUp({ payer, packageId, requestId }) {
    if (!parseSimulatedPayer(payer)) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
    const pack = SIMULATED_TOPUP_PACKAGES.find((entry) => entry.id === packageId);
    if (!pack || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400);
    const key = `topup:${digest(`${payer}\0${requestId}`).slice(0, 40)}`;
    const wallet = this.#wallet(payer);
    const prior = this.byRequest.get(key);
    if (prior) {
      if (prior.payer !== payer || prior.kind !== "topup" || prior.packageId !== pack.id) throw new SimulatedWalletRefusal("simulated_wallet_request_conflict", 409);
      return { order: this.#order(prior), balance: wallet.balance, duplicate: true };
    }
    if (wallet.balance + pack.credits > 1_000_000_000) throw new SimulatedWalletRefusal("simulated_wallet_balance_cap", 409);
    wallet.balance += pack.credits;
    const entry = this.#entry({ payer, kind: "topup", requestId: key, credits: pack.credits, balanceAfter: wallet.balance, receiptId: `sim_order_${digest(key).slice(0, 20)}`, packageId: pack.id });
    return { order: this.#order(entry), balance: wallet.balance, duplicate: false };
  }

  #order(entry) {
    return { id: entry.receiptId, packageId: entry.packageId, title: "模拟充值", amount: entry.credits, at: entry.createdAt.toISOString(), status: "paid" };
  }

  async orders(payer, { limit = 20, cursor = null } = {}) {
    if (!parseSimulatedPayer(payer)) throw new SimulatedWalletRefusal("simulated_wallet_payer_invalid", 400);
    let position = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("shape");
        position = { at: Date.parse(decoded[0]), id: BigInt(decoded[1]) };
        if (!Number.isFinite(position.at)) throw new Error("shape");
      } catch { throw new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400); }
    }
    const bound = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const mine = this.entries.filter((entry) => entry.payer === payer && entry.kind === "topup")
      .sort((a, b) => b.createdAt - a.createdAt || Number(BigInt(b.entryId) - BigInt(a.entryId)))
      .filter((entry) => !position || entry.createdAt.getTime() < position.at || (entry.createdAt.getTime() === position.at && BigInt(entry.entryId) < position.id));
    const page = mine.slice(0, bound);
    const last = page.at(-1);
    const nextCursor = mine.length > bound && last ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.entryId])).toString("base64url") : null;
    return { items: page.map((entry) => this.#order(entry)), nextCursor };
  }
}

/** @param {() => Promise<unknown>} action @param {string} code @param {number} status */
async function refused(action, code, status) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof SimulatedWalletRefusal, `expected a wallet refusal, got ${error?.name}: ${error?.message}`);
    assert.deepEqual([error.code, error.status], [code, status]);
    return true;
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The properties. Each takes `{ wallet, start }`: a wallet whose starting
 * allowance is `start`, shared by every case, which therefore uses payers of its own.
 * @type {ReadonlyArray<readonly [string, (context: { wallet: any, start: number }) => Promise<void>]>}
 */
export const simulatedWalletContract = Object.freeze([
  ["the first read of an account grants the starting allowance, once, and only to that account", async ({ wallet, start }) => {
    const [alice, bob] = [freshPayer("alice"), freshPayer("bob")];
    assert.deepEqual(await wallet.balance(alice), { balance: start, frozen: 0 });
    assert.deepEqual(await wallet.balance(alice), { balance: start, frozen: 0 });
    await wallet.deduct({ payer: alice, requestId: `run_${randomUUID()}`, credits: 5 });
    assert.equal((await wallet.balance(alice)).balance, start - 5, "a later read grants nothing more");
    assert.equal((await wallet.balance(bob)).balance, start, "another account has its own wallet");
  }],

  ["a payer this platform did not mint is refused on every operation, a real EviMed user id included", async ({ wallet }) => {
    for (const payer of ["98211", "", "sim:v2:alice:2026-10-03T00:00:00.123456Z", "sim:v1:alice:yesterday", "sim:v1::2026-10-03T00:00:00.123456Z", null, 7]) {
      await refused(() => wallet.balance(payer), "simulated_wallet_payer_invalid", 400);
      await refused(() => wallet.deduct({ payer, requestId: "run_x", credits: 1 }), "simulated_wallet_payer_invalid", 400);
      await refused(() => wallet.topUp({ payer, packageId: "topup-50", requestId: "request-0001" }), "simulated_wallet_payer_invalid", 400);
      await refused(() => wallet.orders(payer), "simulated_wallet_payer_invalid", 400);
    }
  }],

  ["a deduction takes whole credits once per request id and answers the original receipt the second time", async ({ wallet, start }) => {
    const payer = freshPayer();
    const requestId = `run_${randomUUID()}`;
    await wallet.balance(payer);
    const first = await wallet.deduct({ payer, requestId, credits: 30, occurredAt: "2026-10-04T01:00:00.000Z" });
    assert.equal(first.balance, start - 30);
    assert.equal(first.replay, false);
    assert.match(first.receiptId, /^sim_rcpt_[0-9a-f]{24}$/);
    for (let again = 0; again < 3; again += 1) {
      const replay = await wallet.deduct({ payer, requestId, credits: 30 });
      assert.deepEqual([replay.receiptId, replay.balance, replay.replay], [first.receiptId, start - 30, true]);
    }
    assert.equal((await wallet.balance(payer)).balance, start - 30, "a retry is not a second charge");
    // The same key for something else is a defect, not a retry.
    await refused(() => wallet.deduct({ payer, requestId, credits: 31 }), "simulated_wallet_request_conflict", 409);
    const other = freshPayer();
    await wallet.balance(other);
    await refused(() => wallet.deduct({ payer: other, requestId, credits: 30 }), "simulated_wallet_request_conflict", 409);
    assert.equal((await wallet.balance(other)).balance, start, "a refused deduction takes nothing");
  }],

  ["a deduction larger than the balance is refused, takes nothing, and the balance can be spent to exactly zero", async ({ wallet, start }) => {
    const payer = freshPayer();
    await wallet.balance(payer);
    await refused(() => wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: start + 1 }), "simulated_wallet_insufficient", 402);
    assert.equal((await wallet.balance(payer)).balance, start);
    const spent = await wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: start });
    assert.equal(spent.balance, 0);
    await refused(() => wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: 1 }), "simulated_wallet_insufficient", 402);
    assert.equal((await wallet.balance(payer)).balance, 0, "never negative");
  }],

  ["a deduction's own fields are checked, and a wallet exists from its first sight even when that is a deduction", async ({ wallet, start }) => {
    const payer = freshPayer();
    await wallet.balance(payer);
    for (const bad of [{ credits: 0 }, { credits: -1 }, { credits: 1.5 }, { credits: "3" }, { credits: Number.NaN }, { credits: 10_000_001 }, { requestId: "" }, { requestId: 7 }, { requestId: "x".repeat(201) }]) {
      await refused(() => wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: 1, ...bad }), "simulated_wallet_request_invalid", 400);
    }
    // Work that was done is charged: an account that never opened the page has the allowance it would have been granted.
    const unseen = freshPayer();
    assert.equal((await wallet.deduct({ payer: unseen, requestId: `run_${randomUUID()}`, credits: 4 })).balance, start - 4);
    assert.equal((await wallet.balance(unseen)).balance, start - 4, "granted once, however it began");
  }],

  ["a top-up adds one closed package once per request id, and one account's request id never replays another's", async ({ wallet, start }) => {
    const [alice, bob] = [freshPayer("alice"), freshPayer("bob")];
    const requestId = `topup_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const first = await wallet.topUp({ payer: alice, packageId: "topup-100", requestId });
    assert.equal(first.duplicate, false);
    assert.equal(first.balance, start + 100);
    assert.deepEqual([first.order.packageId, first.order.amount, first.order.title, first.order.status], ["topup-100", 100, "模拟充值", "paid"]);
    const again = await wallet.topUp({ payer: alice, packageId: "topup-100", requestId });
    assert.deepEqual([again.duplicate, again.balance, again.order.id], [true, start + 100, first.order.id]);
    assert.equal((await wallet.balance(alice)).balance, start + 100, "a retried top-up adds nothing");
    // The same text from another account is that account's own top-up.
    const mine = await wallet.topUp({ payer: bob, packageId: "topup-100", requestId });
    assert.deepEqual([mine.duplicate, mine.balance], [false, start + 100]);
    // The same request for another package is a defect, not a retry.
    await refused(() => wallet.topUp({ payer: alice, packageId: "topup-50", requestId }), "simulated_wallet_request_conflict", 409);
    for (const bad of [{ packageId: "topup-7" }, { packageId: "50" }, { packageId: undefined }, { requestId: "short" }, { requestId: "has space in it" }, { requestId: undefined }]) {
      await refused(() => wallet.topUp({ payer: alice, packageId: "topup-50", requestId: `request_${randomUUID().slice(0, 8)}`, ...bad }), "simulated_wallet_request_invalid", 400);
    }
    assert.equal((await wallet.balance(alice)).balance, start + 100);
  }],

  ["orders are an account's own top-ups, newest first, by keyset, and nothing else", async ({ wallet }) => {
    const [alice, bob] = [freshPayer("alice"), freshPayer("bob")];
    await wallet.balance(alice);
    await wallet.deduct({ payer: alice, requestId: `run_${randomUUID()}`, credits: 3 });
    await wallet.topUp({ payer: bob, packageId: "topup-500", requestId: `request_${randomUUID().slice(0, 12)}` });
    assert.deepEqual(await wallet.orders(alice), { items: [], nextCursor: null }, "neither the grant nor a deduction is an order");
    const ids = [];
    for (const packageId of ["topup-50", "topup-100", "topup-200", "topup-500", "topup-50"]) {
      ids.push((await wallet.topUp({ payer: alice, packageId, requestId: `request_${randomUUID().replaceAll("-", "").slice(0, 16)}` })).order.id);
      await sleep(3);
    }
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const answer = await wallet.orders(alice, { limit: 2, cursor });
      assert.ok(answer.items.length <= 2);
      seen.push(...answer.items.map((order) => order.id));
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, [...ids].reverse(), "newest first, every order once");
    assert.equal(cursor, null);
    assert.deepEqual((await wallet.orders(bob)).items.map((order) => order.amount), [500], "an account reads only its own");
    await refused(() => wallet.orders(alice, { cursor: "not-a-cursor" }), "simulated_wallet_request_invalid", 400);
    await refused(() => wallet.orders(alice, { cursor: Buffer.from(JSON.stringify(["yesterday", "x"])).toString("base64url") }), "simulated_wallet_request_invalid", 400);
  }],

  ["concurrent first reads grant once, and concurrent deductions never overdraw or double-apply", async ({ wallet, start }) => {
    const payer = freshPayer();
    const reads = await Promise.all(Array.from({ length: 6 }, () => wallet.balance(payer)));
    assert.ok(reads.every((read) => read.balance === start), "one grant however many first reads race");
    const same = `run_${randomUUID()}`;
    const duplicates = await Promise.all(Array.from({ length: 5 }, () => wallet.deduct({ payer, requestId: same, credits: 10 })));
    assert.equal(duplicates.filter((answer) => !answer.replay).length, 1, "one request id is one deduction");
    assert.equal((await wallet.balance(payer)).balance, start - 10);
    const each = Math.ceil(start / 4);
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => wallet.deduct({ payer, requestId: `run_${randomUUID()}`, credits: each })));
    const taken = outcomes.filter((outcome) => outcome.status === "fulfilled").length * each;
    assert.equal((await wallet.balance(payer)).balance, start - 10 - taken);
    assert.ok(taken <= start - 10, "never more than the balance");
    for (const outcome of outcomes.filter((entry) => entry.status === "rejected")) {
      assert.equal(outcome.reason.code, "simulated_wallet_insufficient");
    }
  }],
]);
