// Research-allowance billing on a simulated wallet, without a database: the
// service's gate, its boot and recovery when billing cannot come up, the module
// that refuses a configuration, the simulated wallet's own routes, the commerce
// that is the platform's own pages, the release check, and the config keys.
// The estimate → charge → statement path over PostgreSQL is
// `researchBillingSimulated.integration.test.mjs`.
import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { SIMULATED_LOW_CREDITS, SIMULATED_START_CREDITS, SIMULATED_TOPUP_PACKAGES, SIMULATED_WALLET_PAGES, errorCodeMessage, errorCodeOutcome } from "@evimed/domain";
import { checkResearchBillingReadiness, parseResearchBillingReadinessArgs, researchBillingReadinessConfig } from "../../../scripts/ops/check-research-billing.mjs";
import { loadConfig } from "../src/config.mjs";
import { createEvimedCreditsClient } from "../src/evimedCreditsClient.mjs";
import { EvimedCreditsService, creditsReadiness } from "../src/evimedCreditsService.mjs";
import {
  SIMULATED_WALLET_BALANCE_URL, SIMULATED_WALLET_DEDUCT_URL, SIMULATED_WALLET_KEY, createSimulatedWalletFetch, evimedCreditsRefusal, simulatedPayerId,
} from "../src/evimedCreditsSimulator.mjs";
import { createResearchAllowanceRoutes } from "../src/researchAllowanceRoutes.mjs";
import { checkResearchCommerceConformance, createResearchCommerce } from "../src/researchCommerce.mjs";
import { createSimulatedWalletRoutes, simulatedWalletRoutePattern } from "../src/simulatedWalletRoutes.mjs";
import { MemorySimulatedWallet } from "./helpers/simulatedWalletContract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const INCARNATION = "2026-10-03T00:00:00.123456Z";
const config = { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, researchBillingEnabled: true };

/** A database that answers only what the service asks of it without storage, and can be told to fail. */
function database({ incarnations = { u_1: INCARNATION, u_2: INCARNATION }, failure = null } = {}) {
  const db = {
    failure,
    async transaction(operation) { if (db.failure) throw db.failure; return operation(db); },
    async query(sql, values = []) {
      if (db.failure && /evimed_credits/.test(sql)) throw db.failure;
      if (/AS incarnation FROM evimed_control\.users u WHERE u\.id=\$1/.test(sql)) {
        const incarnation = incarnations[values[0]];
        return { rows: incarnation ? [{ incarnation }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

/** The service as the server composes it for a simulated deployment. */
function simulatedService({ db = database(), wallet = new MemorySimulatedWallet({ startCredits: 200 }), extra = {}, reported = [] } = {}) {
  const client = createEvimedCreditsClient({
    deductUrl: SIMULATED_WALLET_DEDUCT_URL, balanceUrl: SIMULATED_WALLET_BALANCE_URL, apiKey: SIMULATED_WALLET_KEY, simulated: true,
    fetchImpl: createSimulatedWalletFetch(wallet),
  });
  const service = new EvimedCreditsService({ config, database: db, client, simulator: wallet, report: (code) => reported.push(code), ...extra });
  return { service, wallet, db, client, reported, payer: (userId = "u_1") => simulatedPayerId(userId, INCARNATION) };
}

test("the first read of any account is the starting allowance, marked simulated, whatever kind of account it is", async () => {
  const { service, wallet, payer } = simulatedService();
  assert.equal(service.simulated, true);
  assert.deepEqual(await service.balanceFor("u_1"), { balance: 200, frozen: 0, unit: "灵豆", status: "ok", simulated: true });
  assert.deepEqual(await service.balanceFor("u_2"), { balance: 200, frozen: 0, unit: "灵豆", status: "ok", simulated: true });
  // Isolated per account: one account's spend is not the other's.
  await wallet.deduct({ payer: payer("u_1"), requestId: "run_iso_1", credits: 60 });
  assert.equal((await service.balanceFor("u_1")).balance, 140);
  assert.equal((await service.balanceFor("u_2")).balance, 200);
  // An account that does not exist has no wallet, and says so rather than inventing one.
  assert.deepEqual(await service.balanceFor("nobody"), { balance: null, frozen: null, unit: "灵豆", status: "evimed_credits_account_unlinked", simulated: true });
  assert.equal(SIMULATED_START_CREDITS, 200);
});

test("the balance gate: told before a task starts, never mid-run, and the refusal says 模拟 and offers the simulated top-up", async () => {
  const { service, wallet, payer } = simulatedService();
  // Plenty: the start is admitted and carries the estimate.
  const admitted = await service.assertBalanceForStart("u_1", "adr-analysis");
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.balance, 200);
  assert.equal(admitted.estimate.simulated, true);
  assert.equal(admitted.estimate.basis, "manifest");
  assert.ok(admitted.estimate.low > 0 && admitted.estimate.high >= admitted.estimate.low);
  // Below the tool's own estimate: refused at the start, before a run exists.
  await wallet.deduct({ payer: payer(), requestId: "run_drain_1", credits: 200 - (admitted.estimate.low - 1) });
  await assert.rejects(service.assertBalanceForStart("u_1", "adr-analysis"), (/** @type {any} */ error) => {
    assert.equal(error.status, 402);
    assert.equal(error.code, "simulated_credits_exhausted");
    assert.equal(errorCodeOutcome(error.code), "capped", "a ceiling, like the real one");
    assert.match(errorCodeMessage(error.code), /模拟/);
    assert.match(errorCodeMessage(error.code), /模拟充值/, "it offers the simulated top-up");
    return true;
  });
  // The same balance still admits a free conversation (no estimate to be short of) …
  assert.equal((await service.assertBalanceForStart("u_1", "")).allowed, true);
  // … and a top-up releases the tool.
  await service.simulatedTopUp("u_1", { packageId: "topup-50", requestId: "request-release-1" });
  assert.equal((await service.assertBalanceForStart("u_1", "adr-analysis")).allowed, true);
  // Empty is refused for everything.
  await wallet.deduct({ payer: payer(), requestId: "run_drain_2", credits: (await service.balanceFor("u_1")).balance });
  await assert.rejects(service.assertBalanceForStart("u_1", ""), { status: 402, code: "simulated_credits_exhausted" });
  assert.equal(service.status().counters.refusedStarts, 2);
  // The real wallet's refusal keeps its own code and sentence.
  const real = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {},
    client: { configured: true, async balance() { return { balance: 0, frozen: 0 }; } }, evimedUserIdOf: async () => "98211" });
  await assert.rejects(real.assertBalanceForStart("u_1", "adr-analysis"), { status: 402, code: "credits_exhausted" });
});

test("a simulated top-up goes through the service once per request, as a closed package, for a simulated deployment only", async () => {
  const { service } = simulatedService();
  const first = await service.simulatedTopUp("u_1", { packageId: "topup-100", requestId: "request-0001" });
  assert.deepEqual([first.duplicate, first.balance, first.order.amount, first.order.title], [false, 300, 100, "模拟充值"]);
  const again = await service.simulatedTopUp("u_1", { packageId: "topup-100", requestId: "request-0001" });
  assert.deepEqual([again.duplicate, again.balance], [true, 300]);
  assert.equal((await service.balanceFor("u_1")).balance, 300);
  assert.deepEqual((await service.simulatedOrders("u_1")).items.map((order) => order.amount), [100]);
  assert.deepEqual((await service.simulatedOrders("u_2")).items, [], "another account has no orders of this one's");
  for (const bad of [{ packageId: "topup-7", requestId: "request-0002" }, { packageId: "topup-100", requestId: "x" }, { packageId: "topup-50", requestId: "request-0001" }, {}]) {
    await assert.rejects(service.simulatedTopUp("u_1", bad), { status: 400, code: "simulated_wallet_request_invalid" });
  }
  await assert.rejects(service.simulatedOrders("u_1", { cursor: "nonsense" }), { status: 400, code: "simulated_wallet_request_invalid" });
  const live = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database: {}, client: { configured: true } });
  await assert.rejects(live.simulatedTopUp("u_1", { packageId: "topup-50", requestId: "request-0003" }), { status: 404, code: "simulated_wallet_not_enabled" });
  await assert.rejects(live.simulatedOrders("u_1"), { status: 404, code: "simulated_wallet_not_enabled" });
  assert.equal(SIMULATED_TOPUP_PACKAGES.some((entry) => entry.credits === 100), true);
});

test("billing that cannot come up never stops research: the module goes quiet, admits every start, charges nothing, and says why", async () => {
  const outage = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const reported = [];
  const { service, db, wallet } = simulatedService({ db: database({ failure: outage }), reported });
  assert.equal(await service.ensureReady(), "42P01", "named by the code of what failed");
  assert.equal(service.failure, "42P01");
  assert.equal(service.enabled, false);
  assert.equal(service.status().failure, "42P01");
  assert.deepEqual(reported, ["42P01"]);
  await service.ensureReady();
  assert.deepEqual(reported, ["42P01"], "a failure is reported when it begins, not every minute it lasts");
  // Nothing is charged …
  assert.deepEqual(await service.settleRun({ userId: "u_1", runId: "run_quiet", capabilityId: "adr-analysis" }), { status: "skipped", reason: "billing_unavailable" });
  // … no start is refused, and the policy is not asked for again at the start's expense …
  assert.deepEqual(await service.assertBalanceForStart("u_1", "adr-analysis"), { allowed: true, reason: "billing_unavailable" });
  assert.equal(service.status().counters.refusedStarts, 0);
  // … the balance is unknown, never zero …
  assert.deepEqual(await service.balanceFor("u_1"), { balance: null, frozen: null, unit: "灵豆", status: "billing_unavailable", simulated: true });
  const summary = await service.allowanceSummary("u_1", { since: new Date("2026-10-01T00:00:00Z") });
  assert.equal(summary.status, "billing_unavailable");
  assert.equal(summary.balanceCny, null);
  assert.equal(summary.ledgerReadable, false);
  assert.deepEqual([summary.simulated, summary.lowThreshold], [true, SIMULATED_LOW_CREDITS]);
  // … the estimate, which needs no storage, still answers, and nothing reached the wallet.
  assert.equal((await service.estimate("adr-analysis")).basis, "manifest");
  assert.equal(wallet.wallets.size, 0, "the wallet was never asked about anyone");
  // The simulated wallet's own surface says unavailable rather than answering from a broken ledger.
  await assert.rejects(service.simulatedTopUp("u_1", { packageId: "topup-50", requestId: "request-0004" }), { status: 503 });
  // A readiness probe names it, and a sweep that finds the cause gone brings the module back.
  await assert.rejects(creditsReadiness({ config, credits: { service }, database: db }), (/** @type {any} */ error) => error.code === "42P01" && error.details.simulated === true);
  db.failure = null;
  assert.equal(await service.retryDue(), 0);
  assert.equal(service.failure, null);
  assert.equal(service.enabled, true);
  assert.equal((await service.balanceFor("u_1")).balance, 200);
  assert.deepEqual(await creditsReadiness({ config, credits: { service }, database: db }), { required: true, enabled: true, simulated: true, policy: true });
});

test("a configuration the module refuses boots the module refusing, for good, with the code that says why", async () => {
  const refusal = evimedCreditsRefusal({ ...config, evimedCreditsUrl: "https://wallet.evimed.com/deduct" });
  assert.equal(refusal, "evimed_credits_simulated_conflict");
  const db = database();
  const service = new EvimedCreditsService({ config: { ...config, evimedCreditsUrl: "https://wallet.evimed.com/deduct" }, database: db, client: null, simulator: null, refusal });
  assert.equal(service.failure, refusal);
  assert.equal(service.enabled, false);
  await assert.rejects(service.ready(), (/** @type {any} */ error) => error.status === 503 && error.code === refusal);
  assert.equal(await service.ensureReady(), refusal, "the database being fine does not lift a refusal");
  assert.equal(await service.retryDue(), 0);
  assert.equal(service.failure, refusal);
  assert.deepEqual(await service.assertBalanceForStart("u_1", "adr-analysis"), { allowed: true, reason: "billing_unavailable" });
  assert.deepEqual(await service.settleRun({ userId: "u_1", runId: "run_refused" }), { status: "skipped", reason: "billing_unavailable" });
  assert.equal((await service.allowanceSummary("u_1")).status, "billing_unavailable");
  await assert.rejects(creditsReadiness({ config, credits: { service }, database: db }), (/** @type {any} */ error) => error.code === refusal);
  // A module that is off, or not composed, is told apart in readiness.
  assert.deepEqual(await creditsReadiness({ config: { evimedCreditsEnabled: false }, credits: null, database: null }), { required: false, enabled: false });
  await assert.rejects(creditsReadiness({ config, credits: null, database: db }), (/** @type {any} */ error) => error.code === "evimed_credits_unavailable" && error.details.reason === "not_composed");
  await assert.rejects(creditsReadiness({ config, credits: null, database: null }), (/** @type {any} */ error) => error.details.reason === "no_product_database");
});

test("a wallet that is not wired is a warning on a green check, never a red one", async () => {
  const service = new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 1 }, database: database(), client: { configured: false } });
  assert.deepEqual(await creditsReadiness({ config: { evimedCreditsEnabled: true }, credits: { service }, database: database() }),
    { required: true, enabled: true, simulated: false, policy: false, warning: "evimed_credits_wallet_not_wired" });
});

// ---- the routes --------------------------------------------------------------------------

/** @param {string} method @param {string} url @param {unknown} [body] */
function request(method, url, body) {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { "content-type": "application/json" } });
}
function response() {
  return {
    status: 0, body: "", headers: /** @type {Record<string, string>} */ ({}),
    writeHead(/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body).data; },
  };
}

function allowanceFixture(routeConfig = { evimedCreditsEnabled: true, evimedCreditsSimulated: true }, summary = {}) {
  const calls = /** @type {any[]} */ ([]);
  const service = {
    async allowanceSummary(/** @type {string} */ id) { calls.push(["summary", id]); return { status: "ok", balanceCny: 188, spentCny: 12, pendingCny: 0, ledgerReadable: true, simulated: true, lowThreshold: 20, ...summary }; },
    async statements() { return { items: [{ id: "task", kind: "charge", simulated: true, amount: 12 }, { id: "grant", kind: "grant", simulated: true, amount: 200 }], nextCursor: null }; },
    async estimate(/** @type {string} */ id) { calls.push(["estimate", id]); return id === "unknown-tool" ? { basis: "none", creditsPerCny: 1, low: 0, high: 0, samples: 0 } : { basis: "manifest", creditsPerCny: 1, low: 4, high: 8, samples: 0, simulated: true }; },
  };
  const routes = createResearchAllowanceRoutes({
    store: { async ensureSessionUser() { return { user: { id: "u_1" } }; }, async assertCsrf() {} },
    service, config: routeConfig, commerce: createResearchCommerce(routeConfig), now: () => new Date("2026-10-04T09:00:00Z"),
  });
  return { routes, calls, service };
}

test("every allowance answer on a simulated deployment says so, and the four commerce links are the platform's own pages", async () => {
  const { routes } = allowanceFixture();
  const root = response();
  await routes(request("GET", "/api/account/allowance"), root);
  const data = root.json();
  assert.equal(data.enabled, true);
  assert.equal(data.simulated, true);
  assert.equal(data.status, "ready");
  assert.equal(data.available, 188);
  assert.equal(data.lowThreshold, SIMULATED_LOW_CREDITS);
  assert.deepEqual(data.month, { since: "2026-10-01T00:00:00.000Z", paid: 12, pending: 0 });
  assert.deepEqual(data.commerce, { rechargeUrl: SIMULATED_WALLET_PAGES.recharge, membershipUrl: SIMULATED_WALLET_PAGES.membership,
    ordersUrl: SIMULATED_WALLET_PAGES.orders, refundsUrl: SIMULATED_WALLET_PAGES.refunds });
  const statements = response();
  await routes(request("GET", "/api/account/allowance/statements"), statements);
  assert.equal(statements.json().simulated, true);
  assert.deepEqual(statements.json().items.map((item) => [item.kind, item.simulated]), [["charge", true], ["grant", true]]);
  const estimate = response();
  await routes(request("GET", "/api/account/allowance/estimate?capability=adr-analysis"), estimate);
  assert.deepEqual(estimate.json(), { currency: "CNY", capabilityId: "adr-analysis", basis: "manifest", low: 4, high: 8, samples: 0, binding: false, simulated: true });
});

test("a deployment whose wallet is real says it is not simulated, and a ledger that cannot be read is unknown, never zero", async () => {
  const live = allowanceFixture({ evimedCreditsEnabled: true }, { simulated: false, lowThreshold: null });
  const root = response();
  await live.routes(request("GET", "/api/account/allowance"), root);
  assert.equal(root.json().simulated, false);
  assert.equal(root.json().lowThreshold, null);
  const down = allowanceFixture(undefined, { status: "billing_unavailable", balanceCny: null, ledgerReadable: false, spentCny: 0, pendingCny: 0 });
  const unreadable = response();
  await down.routes(request("GET", "/api/account/allowance"), unreadable);
  const data = unreadable.json();
  assert.equal(data.enabled, true, "billing is configured on: the page says it is unavailable, not that it is off");
  assert.equal(data.status, "unavailable");
  assert.equal(data.available, null);
  assert.equal(data.month, null, "no month is claimed that could not be read");
  assert.deepEqual(data.commerce, { rechargeUrl: null, membershipUrl: null, ordersUrl: null, refundsUrl: null });
});

test("every tool's estimate in one read, bounded, and a tool with no basis has no price", async () => {
  const { routes, calls } = allowanceFixture();
  const bulk = response();
  await routes(request("GET", "/api/account/allowance/estimates?capabilities=adr-analysis,unknown-tool,meta-analysis"), bulk);
  assert.deepEqual(bulk.json(), { currency: "CNY", simulated: true, items: [
    { capabilityId: "adr-analysis", basis: "manifest", low: 4, high: 8, samples: 0, binding: false },
    { capabilityId: "unknown-tool", basis: "none", low: null, high: null, samples: 0, binding: false },
    { capabilityId: "meta-analysis", basis: "manifest", low: 4, high: 8, samples: 0, binding: false },
  ] });
  assert.deepEqual(calls.filter(([kind]) => kind === "estimate").map(([, id]) => id), ["adr-analysis", "unknown-tool", "meta-analysis"]);
  const many = Array.from({ length: 41 }, (_, at) => `tool-${at}`).join(",");
  for (const query of ["", "capabilities=", `capabilities=${many}`, "capabilities=a,a", "capabilities=../x", "capabilities=a&capabilities=b", "capabilities=A", "other=1"]) {
    await assert.rejects(routes(request("GET", `/api/account/allowance/estimates?${query}`), response()), { status: 400, code: "evimed_credits_request_invalid" }, query);
  }
  const off = allowanceFixture({ evimedCreditsEnabled: false });
  const none = response();
  await off.routes(request("GET", "/api/account/allowance/estimates?capabilities=adr-analysis"), none);
  assert.deepEqual(none.json().items, [{ capabilityId: "adr-analysis", basis: "none", low: null, high: null, samples: 0, binding: false }]);
  assert.equal(none.json().simulated, false);
  assert.equal(off.calls.length, 0, "a deployment without billing prices nothing");
});

function walletFixture(routeConfig = { evimedCreditsEnabled: true, evimedCreditsSimulated: true }) {
  const opened = /** @type {string[]} */ ([]);
  const { service } = simulatedService();
  const routes = createSimulatedWalletRoutes({
    store: { async ensureSessionUser() { opened.push("session"); return { user: { id: "u_1" } }; }, async assertCsrf(/** @type {any} */ _req, /** @type {string} */ pathname) { opened.push(`csrf ${pathname}`); } },
    service, config: routeConfig,
  });
  return { routes, opened, service };
}

test("the simulated wallet's routes: a top-up once per request id, the orders it made, and nothing without a simulated wallet", async () => {
  const { routes, opened } = walletFixture();
  const topup = response();
  assert.equal(await routes(request("POST", "/api/simulated-wallet/topups", { packageId: "topup-200", requestId: "page-attempt-1" }), topup), true);
  assert.equal(topup.status, 201);
  assert.equal(topup.headers["Cache-Control"], "private, no-store");
  assert.deepEqual(topup.json(), { simulated: true, order: topup.json().order, available: 400, duplicate: false });
  assert.deepEqual([topup.json().order.amount, topup.json().order.status, topup.json().order.title], [200, "paid", "模拟充值"]);
  const retry = response();
  await routes(request("POST", "/api/simulated-wallet/topups", { packageId: "topup-200", requestId: "page-attempt-1" }), retry);
  assert.equal(retry.status, 200, "an already-applied request is answered, not applied again");
  assert.deepEqual([retry.json().duplicate, retry.json().available, retry.json().order.id], [true, 400, topup.json().order.id]);
  const orders = response();
  await routes(request("GET", "/api/simulated-wallet/orders?limit=5"), orders);
  assert.deepEqual([orders.json().simulated, orders.json().currency, orders.json().items.length, orders.json().nextCursor], [true, "CNY", 1, null]);
  assert.deepEqual(opened.filter((entry) => entry === "session").length, 3);
  assert.ok(opened.includes("csrf /api/simulated-wallet/topups"));
  // Bad requests are the page's mistake, and nothing is added.
  for (const body of [{}, { packageId: "topup-200" }, { packageId: 200, requestId: "page-attempt-2" }, { packageId: "topup-9", requestId: "page-attempt-2" },
    { packageId: "topup-200", requestId: "page-attempt-2", credits: 1000000 }, { packageId: "topup-200", requestId: "short" }]) {
    await assert.rejects(routes(request("POST", "/api/simulated-wallet/topups", body), response()), { status: 400, code: "simulated_wallet_request_invalid" }, JSON.stringify(body));
  }
  for (const query of ["limit=0", "limit=51", "limit=x", "limit=1&limit=2", "cursor="]) {
    await assert.rejects(routes(request("GET", `/api/simulated-wallet/orders?${query}`), response()), { status: 400, code: "simulated_wallet_request_invalid" }, query);
  }
  await assert.rejects(routes(request("GET", "/api/simulated-wallet/topups"), response()), { status: 405, code: "method_not_allowed" });
  await assert.rejects(routes(request("POST", "/api/simulated-wallet/orders", {}), response()), { status: 405, code: "method_not_allowed" });
  await assert.rejects(routes(request("GET", "/api/simulated-wallet/refunds"), response()), { status: 404, code: "not_found" });
  assert.equal(await routes(request("GET", "/api/account/allowance"), response()), false, "another module's path is not this one's");
  assert.equal(simulatedWalletRoutePattern("/api/simulated-wallet/orders"), "/api/simulated-wallet/orders");
  assert.equal(simulatedWalletRoutePattern("/api/simulated-wallet/anything-at-all"), "/api/simulated-wallet/:route");
});

test("without a simulated wallet the routes are a named 404 before a session is even opened", async () => {
  for (const routeConfig of [{ evimedCreditsEnabled: true }, { evimedCreditsEnabled: false, evimedCreditsSimulated: true }, { evimedCreditsSimulated: true }]) {
    const { routes, opened } = walletFixture(routeConfig);
    for (const [method, pathname] of [["GET", "/api/simulated-wallet/orders"], ["POST", "/api/simulated-wallet/topups"]]) {
      await assert.rejects(routes(request(method, pathname, {}), response()), { status: 404, code: "simulated_wallet_not_enabled" });
    }
    assert.deepEqual(opened, []);
  }
  assert.match(errorCodeMessage("simulated_wallet_not_enabled"), /模拟/);
});

// ---- the commerce and the release check ------------------------------------------------

test("a simulated deployment's commerce is the platform's own pages, ignores every configured checkout, and is never a real handoff", () => {
  const hosted = { researchCommerceEnabled: true, researchCommerceTrustedOrigins: ["https://account.evimed.com"], researchCommerceRechargeUrl: "https://account.evimed.com/recharge" };
  const commerce = createResearchCommerce({ ...hosted, ...config });
  assert.deepEqual(commerce.links(), { rechargeUrl: "/app/account/simulated/recharge", membershipUrl: "/app/account/simulated/membership",
    ordersUrl: "/app/account/simulated/orders", refundsUrl: "/app/account/simulated/refunds" });
  const status = commerce.status();
  assert.deepEqual([status.mode, status.simulated, status.walletAuthority], ["simulated", true, "simulated"]);
  for (const feature of Object.values(status.features)) assert.deepEqual(feature, { status: "simulated", method: "simulated", verified: false });
  assert.ok(Object.values(status.upstreamContracts).every((value) => value === "simulated"));
  assert.ok(Object.isFrozen(commerce.links()));
  status.features.recharge.status = "configured";
  assert.equal(commerce.status().features.recharge.status, "simulated", "the status is a copy");
  // A release check that requires a real handoff is not satisfied by a page that moves no money.
  assert.equal(checkResearchCommerceConformance({ ...hosted, ...config }, { requiredHandoffs: ["recharge"] }).ok, false);
  assert.equal(checkResearchCommerceConformance({ ...hosted, ...config }, { requireAutomaticCommerce: true }).ok, false);
  // Without the simulated wallet, nothing changed: no links until a trusted origin is configured.
  assert.deepEqual(Object.values(createResearchCommerce({ evimedCreditsEnabled: true }).links()), [null, null, null, null]);
  assert.deepEqual(Object.values(createResearchCommerce({ evimedCreditsSimulated: true }).links()), [null, null, null, null], "simulated without the module on is not a simulated deployment");
});

test("the release check reports a simulated wallet as simulated, can never certify real billing, and has its own requirement", () => {
  const simulated = { ...config, evimedCreditsUrl: "", evimedCreditsBalanceUrl: "", evimedCreditsSimulatedStartCredits: 200 };
  const report = checkResearchBillingReadiness(simulated);
  assert.equal(report.ok, true);
  assert.equal(report.simulated, true);
  assert.equal(report.assessment, "simulated");
  assert.equal(report.endToEndVerified, false);
  assert.equal(report.billing.status, "simulated");
  assert.equal(report.billing.walletAuthority, "simulated");
  assert.ok(report.limitations.includes("simulated_wallet_not_real_money"));
  // It never satisfies a requirement for real billing …
  for (const options of [{ requireBilling: true }, { requiredHandoffs: ["recharge"] }]) {
    const required = checkResearchBillingReadiness(simulated, options);
    assert.equal(required.ok, false, JSON.stringify(options));
    assert.equal(required.endToEndVerified, false);
  }
  assert.ok(checkResearchBillingReadiness(simulated, { requireBilling: true }).issues.some((issue) => issue.code === "research_billing_wallet_simulated"));
  // … and --require-simulated is the check for the simulation itself.
  assert.equal(checkResearchBillingReadiness(simulated, { requireSimulated: true }).ok, true);
  const incomplete = checkResearchBillingReadiness({ ...simulated, researchBillingEnabled: false }, { requireSimulated: true });
  assert.ok(incomplete.issues.some((issue) => issue.code === "research_billing_policy_disabled"));
  assert.ok(checkResearchBillingReadiness({ evimedCreditsEnabled: true, researchBillingEnabled: true, evimedCreditsPerCny: 1 }, { requireSimulated: true })
    .issues.some((issue) => issue.code === "research_billing_simulated_disabled"));
  // The refusals the module makes are the check's issues too.
  const conflicted = checkResearchBillingReadiness({ ...simulated, evimedCreditsUrl: "https://wallet.evimed.com/deduct" });
  assert.equal(conflicted.ok, false);
  assert.ok(conflicted.issues.some((issue) => issue.code === "research_billing_simulated_with_real_wallet"));
  assert.equal(conflicted.billing.status, "invalid_configuration");
  assert.ok(checkResearchBillingReadiness({ ...simulated, evimedCreditsSimulatedStartCredits: 0 }).issues.some((issue) => issue.code === "research_billing_simulated_start_invalid"));
  // A real wallet is still reported as before.
  const real = checkResearchBillingReadiness({ evimedCreditsEnabled: true, researchBillingEnabled: true, evimedCreditsPerCny: 1,
    evimedCreditsUrl: "https://wallet.evimed.com/deduct", evimedCreditsBalanceUrl: "https://wallet.evimed.com/balance" }, { requireBilling: true });
  assert.deepEqual([real.ok, real.simulated, real.assessment, real.billing.status], [true, false, "configuration_only", "configured_compatibility"]);
  // The environment mapping and the argument parser know the new switch.
  const mapped = researchBillingReadinessConfig({ OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED: "true", OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED_START_CREDITS: "50" });
  assert.deepEqual([mapped.evimedCreditsSimulated, mapped.evimedCreditsSimulatedStartCredits], [true, 50]);
  assert.equal(researchBillingReadinessConfig({}).evimedCreditsSimulatedStartCredits, 200);
  assert.equal(parseResearchBillingReadinessArgs(["--require-simulated"]).requireSimulated, true);
  assert.throws(() => parseResearchBillingReadinessArgs(["--require-simulated", "--require-simulated"]), /arguments_invalid/);
});

test("the config keys are off by default, read from the environment, and a typo in one never stops the platform loading", () => {
  const saved = process.env;
  try {
    process.env = { NODE_ENV: "production", OPEN_SCIENCE_AUTH_MODE: "local" };
    const off = loadConfig({ rootDir: repoRoot });
    assert.deepEqual([off.evimedCreditsSimulated, off.evimedCreditsSimulatedStartCredits], [false, 200]);
    process.env = { ...process.env, OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED: "true", OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED_START_CREDITS: "25" };
    const on = loadConfig({ rootDir: repoRoot });
    assert.deepEqual([on.evimedCreditsSimulated, on.evimedCreditsSimulatedStartCredits], [true, 25]);
    // The module judges a bad allowance; the platform still boots.
    process.env.OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED_START_CREDITS = "many";
    const typo = loadConfig({ rootDir: repoRoot });
    assert.equal(Number.isNaN(typo.evimedCreditsSimulatedStartCredits), true);
    assert.equal(evimedCreditsRefusal(typo), "evimed_credits_simulated_start_invalid");
    // Beside a real wallet's address it loads too — and is refused by the module, not by the platform.
    process.env.OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED_START_CREDITS = "";
    const mixed = loadConfig({ rootDir: repoRoot, evimedCreditsUrl: "https://www.evimed.com/api-evimed/credits/deduct" });
    assert.equal(evimedCreditsRefusal(mixed), "evimed_credits_simulated_conflict");
    assert.equal(loadConfig({ rootDir: repoRoot, evimedCreditsSimulated: false }).evimedCreditsSimulated, false, "an override wins over the environment");
  } finally {
    process.env = saved;
  }
});
