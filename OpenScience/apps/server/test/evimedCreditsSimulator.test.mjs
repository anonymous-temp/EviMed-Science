// The simulated wallet without a database: its contract against the in-memory
// double, the wire it speaks to the real client (including the outcome nobody
// knows), the configuration it refuses, and the two directions in which a
// simulated payer and a real wallet must never meet. The same contract runs
// against PostgreSQL in `evimedCreditsSimulator.integration.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import { EvimedCreditsError, createEvimedCreditsClient } from "../src/evimedCreditsClient.mjs";
import {
  SIMULATED_WALLET_BALANCE_URL, SIMULATED_WALLET_DEDUCT_URL, SIMULATED_WALLET_KEY, SimulatedWalletRefusal,
  createSimulatedWalletFetch, evimedCreditsRefusal, parseSimulatedPayer, simulatedPayerId,
} from "../src/evimedCreditsSimulator.mjs";
import { MemorySimulatedWallet, freshPayer, simulatedWalletContract } from "./helpers/simulatedWalletContract.mjs";

const START = 200;

for (const [name, run] of simulatedWalletContract) {
  test(`in memory: ${name}`, async () => { await run({ wallet: new MemorySimulatedWallet({ startCredits: START }), start: START }); });
}

test("the contract walks every property it names", () => {
  assert.ok(simulatedWalletContract.length >= 8, `${simulatedWalletContract.length} properties; the walk is wrong, not the wallet`);
  assert.equal(new Set(simulatedWalletContract.map(([name]) => name)).size, simulatedWalletContract.length);
});

test("a payer names the account and its incarnation, and nothing else parses as one", () => {
  const payer = simulatedPayerId("alice_01", "2026-10-03T00:00:00.123456Z");
  assert.equal(payer, "sim:v1:alice_01:2026-10-03T00:00:00.123456Z");
  assert.deepEqual(parseSimulatedPayer(payer), { userId: "alice_01", ownerCreatedAt: "2026-10-03T00:00:00.123456Z" });
  // The same name registered again is a new incarnation, so a new wallet.
  assert.notEqual(simulatedPayerId("alice_01", "2026-10-04T00:00:00.000001Z"), payer);
  for (const bad of ["98211", "evimed_abc", "sim:alice", `${payer}x`, ` ${payer}`, undefined, 12]) assert.equal(parseSimulatedPayer(bad), null, String(bad));
  assert.throws(() => simulatedPayerId("not valid", "2026-10-03T00:00:00.123456Z"), SimulatedWalletRefusal);
  assert.throws(() => simulatedPayerId("alice", "2026-10-03T00:00:00Z"), SimulatedWalletRefusal);
});

/** The real client, talking to the simulator over the real wire. */
function client(wallet, faults, extra = {}) {
  return createEvimedCreditsClient({
    deductUrl: SIMULATED_WALLET_DEDUCT_URL, balanceUrl: SIMULATED_WALLET_BALANCE_URL, apiKey: SIMULATED_WALLET_KEY, simulated: true,
    fetchImpl: createSimulatedWalletFetch(wallet, faults), ...extra,
  });
}

test("the real client reads a balance and takes credits over the simulated wire, and a retry of the same run id charges once", async () => {
  const wallet = new MemorySimulatedWallet({ startCredits: START });
  const credits = client(wallet);
  assert.equal(credits.configured, true);
  const payer = freshPayer();
  assert.deepEqual(await credits.balance(payer), { balance: START, frozen: 0 });
  const request = { requestId: "run_wire_1", userId: payer, credits: 12, memo: "深度研究 · 模拟", occurredAt: "2026-10-04T01:02:03.000Z" };
  const first = await credits.deduct(request);
  assert.deepEqual(first, { receiptId: first.receiptId, balance: START - 12 });
  assert.match(first.receiptId, /^sim_rcpt_/);
  assert.deepEqual(await credits.deduct(request), first, "the second answer is the first");
  assert.equal((await credits.balance(payer)).balance, START - 12);
  assert.equal(credits.status().simulated, true);
  assert.equal(credits.status().counters.deductions, 2);
});

test("the wallet's own refusals reach the client as the envelope's final refusal, never as an outage", async () => {
  const wallet = new MemorySimulatedWallet({ startCredits: 10 });
  const credits = client(wallet);
  const payer = freshPayer();
  await credits.balance(payer);
  await assert.rejects(credits.deduct({ requestId: "run_poor", userId: payer, credits: 11, memo: "m" }),
    (error) => error instanceof EvimedCreditsError && error.code === "evimed_credits_refused" && error.final === true && error.status === 402);
  assert.equal((await credits.balance(payer)).balance, 10, "a refused deduction takes nothing");
  // An account nobody has read has a wallet from its first deduction, so finished work is never refused for want of one.
  assert.equal((await credits.deduct({ requestId: "run_new", userId: freshPayer(), credits: 1, memo: "m" })).balance, 9);
  // The key, the address and the body are the wire's; a wrong one is not served.
  const wrongKey = createEvimedCreditsClient({ deductUrl: SIMULATED_WALLET_DEDUCT_URL, balanceUrl: SIMULATED_WALLET_BALANCE_URL, apiKey: "someone-elses-key",
    simulated: true, fetchImpl: createSimulatedWalletFetch(wallet) });
  await assert.rejects(wrongKey.balance(payer), (error) => error.code === "evimed_credits_unauthorized" && error.final === true);
  const elsewhere = createEvimedCreditsClient({ deductUrl: "https://wallet.evimed.com/deduct", balanceUrl: "https://wallet.evimed.com/balance",
    apiKey: SIMULATED_WALLET_KEY, simulated: true, fetchImpl: createSimulatedWalletFetch(wallet) });
  await assert.rejects(elsewhere.balance(payer), (error) => error.code === "evimed_credits_http_error" && error.final === true && error.status === 404);
});

test("an outcome nobody knows is reproducible: the answer is lost after the debit, and the retry on the run id charges once", async () => {
  const wallet = new MemorySimulatedWallet({ startCredits: START });
  let lose = true;
  const credits = client(wallet, {
    after: (operation) => {
      if (operation === "deduct" && lose) throw Object.assign(new Error("the answer never arrived"), { name: "TimeoutError" });
    },
  });
  const payer = freshPayer();
  await credits.balance(payer);
  const request = { requestId: "run_unknown", userId: payer, credits: 40, memo: "m" };
  await assert.rejects(credits.deduct(request), (error) => error.code === "evimed_credits_timeout" && error.final === false,
    "an answer that did not arrive is retryable, not a refusal");
  // The wallet did take it — which is why the retry must be on the same key.
  assert.equal((await new MemorySimulatedWalletView(wallet).balance(payer)), START - 40);
  lose = false;
  const settled = await credits.deduct(request);
  assert.equal(settled.balance, START - 40, "the retry answered the original deduction");
  assert.equal((await new MemorySimulatedWalletView(wallet).balance(payer)), START - 40, "one run, one charge");
});

test("every shape of an unknown result is retryable and takes nothing it was not asked to", async () => {
  const wallet = new MemorySimulatedWallet({ startCredits: START });
  const payer = freshPayer();
  await wallet.balance(payer);
  for (const [fault, code] of /** @type {Array<[any, string]>} */ ([
    [{ before: () => { throw Object.assign(new Error("down"), { name: "TypeError" }); } }, "evimed_credits_unreachable"],
    [{ before: () => new Response("", { status: 503 }) }, "evimed_credits_http_error"],
    [{ before: () => new Response("", { status: 429 }) }, "evimed_credits_rate_limited"],
    [{ after: () => new Response("not json", { status: 200 }) }, "evimed_credits_response_invalid"],
    [{ after: () => { throw Object.assign(new Error("late"), { name: "TimeoutError" }); } }, "evimed_credits_timeout"],
  ])) {
    const credits = client(wallet, fault);
    await assert.rejects(credits.deduct({ requestId: `run_${code}`, userId: payer, credits: 1, memo: "m" }),
      (error) => error.code === code && error.final === false, code);
  }
  // A wallet that fails for a reason of its own is an outage too, never a verdict, and its text stays inside.
  const broken = { balance: async () => { throw new Error("password=hunter2 relation does not exist"); }, deduct: async () => { throw new Error("secret"); } };
  const credits = client(broken);
  await assert.rejects(credits.balance(payer), (error) => error.code === "evimed_credits_http_error" && error.final === false && !/hunter2|secret/.test(error.message));
});

test("a simulated payer is never sent to a real wallet, and a real user id is never accepted by the simulated one", async () => {
  /** @type {any[]} */
  const sent = [];
  const real = createEvimedCreditsClient({
    deductUrl: "https://www.evimed.com/api-evimed/credits/deduct", balanceUrl: "https://www.evimed.com/api-evimed/credits/balance", apiKey: "ev-secret",
    fetchImpl: async (url, init) => { sent.push([String(url), init]); return Response.json({ code: 200, data: { receiptId: "r", balance: 1 } }); },
  });
  const payer = freshPayer();
  await assert.rejects(real.deduct({ requestId: "run_x", userId: payer, credits: 1, memo: "m" }), (error) => error.code === "evimed_credits_request_invalid" && error.final === true);
  await assert.rejects(real.balance(payer), (error) => error.code === "evimed_credits_request_invalid" && error.final === true);
  assert.equal(sent.length, 0, "nothing left the process");
  assert.equal(real.status().simulated, false);
  await real.deduct({ requestId: "run_y", userId: "98211", credits: 1, memo: "m" });
  assert.equal(sent.length, 1, "a real EviMed id is still charged as before");
  // And the other way: the simulator will not serve an id that names someone at EviMed.
  const simulated = client(new MemorySimulatedWallet({ startCredits: START }));
  await assert.rejects(simulated.balance("98211"), (error) => error.code === "evimed_credits_refused" && error.status === 400);
  await assert.rejects(simulated.deduct({ requestId: "run_z", userId: "98211", credits: 1, memo: "m" }), (error) => error.code === "evimed_credits_refused" && error.final === true);
});

test("a simulated wallet beside a real wallet's address, or with a bad starting allowance, is refused by a named code", () => {
  assert.equal(evimedCreditsRefusal({}), null, "not simulated: nothing to refuse");
  assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: false, evimedCreditsUrl: "https://wallet.evimed.com/deduct" }), null);
  assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: true }), null);
  assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: true, evimedCreditsSimulatedStartCredits: 200 }), null);
  for (const address of [{ evimedCreditsUrl: "https://wallet.evimed.com/deduct" }, { evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance" },
    { evimedCreditsUrl: "https://wallet.evimed.com/deduct", evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance" }]) {
    assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: true, ...address }), "evimed_credits_simulated_conflict");
  }
  for (const start of [0, -5, 1.5, Number.NaN, 10_000_001, "abc"]) {
    assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: true, evimedCreditsSimulatedStartCredits: start }), "evimed_credits_simulated_start_invalid", String(start));
  }
  // The conflict is judged first: it is the one that could charge a real wallet.
  assert.equal(evimedCreditsRefusal({ evimedCreditsSimulated: true, evimedCreditsUrl: "https://w.evimed.com/d", evimedCreditsSimulatedStartCredits: 0 }), "evimed_credits_simulated_conflict");
});

/** A read-only view of the in-memory wallet that cannot provision, so a test can look without touching. */
class MemorySimulatedWalletView {
  constructor(wallet) { this.wallet = wallet; }
  async balance(payer) { return this.wallet.wallets.get(payer).balance; }
}
