import assert from "node:assert/strict";
import test from "node:test";
import { createResearchAllowanceRoutes, researchAllowanceRoutePattern } from "../src/researchAllowanceRoutes.mjs";
import { researchBillingSettings } from "../src/researchBillingConfig.mjs";
import { createResearchCommerce } from "../src/researchCommerce.mjs";
import { HttpError } from "../src/security.mjs";

function response() {
  return { status: 0, headers: {}, data: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.data = JSON.parse(body).data; },
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const service = {
    async allowanceSummary(id, options) {
      calls.push(["summary", id, options]);
      return { status: "ok", balanceCny: 120.364, spentCny: 4, pendingCny: 2 };
    },
    async statements(id, options) {
      calls.push(["statements", id, options]);
      return { items: [{ id: "task", status: "pending", amount: null }], nextCursor: null };
    },
    async estimate(capability) {
      calls.push(["estimate", capability]);
      return { creditsPerCny: 100, low: 30, high: 70, basis: "history", samples: 8 };
    },
  };
  const routes = createResearchAllowanceRoutes({
    store: {
      async ensureSessionUser() { calls.push(["session"]); return { user: { id: "owner" } }; },
      async assertCsrf() { calls.push(["csrf"]); },
    },
    service, config: { evimedCreditsEnabled: true }, commerce: createResearchCommerce(),
    now: () => new Date("2026-10-03T09:00:00Z"), ...overrides,
  });
  return { calls, routes, service };
}

test("allowance reads only the session owner and never invents a balance source or hold", async () => {
  const { calls, routes } = fixture();
  const res = response();
  assert.equal(await routes({ method: "GET", url: "/api/account/allowance?userId=someone-else" }, res), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(calls[2][1], "owner");
  assert.equal(calls[2][2].since.toISOString(), "2026-09-30T16:00:00.000Z", "1 October begins at 00:00 Asia/Shanghai");
  assert.equal(res.data.available, 120.364);
  assert.equal(res.data.held, null);
  assert.equal(res.data.balances, null);
  assert.equal(res.data.membership, null);
  assert.deepEqual(res.data.month, { since: "2026-09-30T16:00:00.000Z", paid: 4, pending: 2 });
  assert.equal(res.data.simulated, false, "a deployment whose wallet is real says so");
  assert.equal(res.data.lowThreshold, null);
});

test("the month a person reads is the Asia/Shanghai month, so a clock at 16:30Z on 31 October is already November", async () => {
  // The month total, the statement window and a gift's expiry (24:00 Asia/Shanghai) must agree on which day it is.
  const { calls, routes } = fixture({ now: () => new Date("2026-10-31T16:30:00Z") });
  const res = response();
  await routes({ method: "GET", url: "/api/account/allowance" }, res);
  assert.equal(calls.find((call) => call[0] === "summary")[2].since.toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(res.data.month.since, "2026-10-31T16:00:00.000Z");
  // One minute earlier it is still October in Shanghai.
  const before = fixture({ now: () => new Date("2026-10-31T15:59:00Z") });
  const earlier = response();
  await before.routes({ method: "GET", url: "/api/account/allowance" }, earlier);
  assert.equal(earlier.data.month.since, "2026-09-30T16:00:00.000Z");
});

test("unavailable wallets remain unknown while confirmed task charges stay readable", async () => {
  const f = fixture();
  f.service.allowanceSummary = async () => ({ status: "evimed_credits_unreachable", balanceCny: null, spentCny: 4, pendingCny: 2 });
  const res = response();
  await f.routes({ url: "/api/account/allowance" }, res);
  assert.equal(res.data.status, "unavailable");
  assert.equal(res.data.available, null);
  assert.equal(res.data.month.paid, 4);
});

test("disabled billing authenticates but never queries a wallet or manufactures zero balance", async () => {
  const f = fixture({ config: { evimedCreditsEnabled: false } });
  const res = response();
  await f.routes({ url: "/api/account/allowance" }, res);
  assert.equal(res.data.enabled, false);
  assert.equal(res.data.status, "disabled");
  assert.equal(res.data.available, null);
  assert.deepEqual(f.calls, [["session"], ["csrf"]]);
});

test("pagination is bounded and a cursor cannot override the authenticated payer", async () => {
  const f = fixture();
  const res = response();
  await f.routes({ url: "/api/account/allowance/statements?limit=2&cursor=position&userId=other" }, res);
  assert.deepEqual(f.calls[2], ["statements", "owner", { limit: 2, cursor: "position" }]);
  assert.equal(res.data.items[0].amount, null);
  for (const query of ["limit=0", "limit=51", "limit=NaN", "limit=1&limit=2", "cursor=", `cursor=${"x".repeat(513)}`]) {
    await assert.rejects(f.routes({ url: `/api/account/allowance/statements?${query}` }, response()), { status: 400 });
  }
});

test("a failed statement query becomes unavailable instead of an empty paid ledger", async () => {
  const f = fixture();
  f.service.statements = async () => { throw new Error("database implementation details"); };
  await assert.rejects(f.routes({ url: "/api/account/allowance/statements" }, response()), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "evimed_credits_unreachable");
    assert.doesNotMatch(error.message, /implementation details/);
    return true;
  });
});

test("estimates convert a legacy rate to CNY without promising a reservation", async () => {
  const f = fixture();
  const res = response();
  await f.routes({ url: "/api/account/allowance/estimate?capability=meta-analysis" }, res);
  assert.deepEqual(res.data, { currency: "CNY", capabilityId: "meta-analysis", basis: "history", low: 0.3, high: 0.7, samples: 8, binding: false, simulated: false });
  await assert.rejects(f.routes({ url: "/api/account/allowance/estimate?capability=../secret" }, response()), { status: 400 });
});

test("allowance routes cannot mutate payments and keep metric labels bounded", async () => {
  const f = fixture();
  assert.equal(await f.routes({ url: "/api/account/usage" }, response()), false);
  await assert.rejects(f.routes({ method: "POST", url: "/api/account/allowance" }, response()), { status: 405 });
  await assert.rejects(f.routes({ url: "/api/account/allowance/unknown" }, response()), { status: 404 });
  assert.equal(researchAllowanceRoutePattern("/api/account/allowance/statements"), "/api/account/allowance/statements");
  assert.equal(researchAllowanceRoutePattern("/api/account/allowance/arbitrary-user-id"), "/api/account/allowance/:route");
  const unauthorized = fixture({ store: { ensureSessionUser() { throw new HttpError(401, "authentication_required", "Sign in."); } } });
  await assert.rejects(unauthorized.routes({ url: "/api/account/allowance" }, response()), { status: 401 });
});

test("new charging requires an explicit switch and one CNY per EviMed credit", () => {
  const credits = { evimedCreditsEnabled: true, evimedCreditsPerCny: 1 };
  assert.equal(researchBillingSettings({}, credits, {}).researchBillingEnabled, false);
  assert.equal(researchBillingSettings({ researchBillingEnabled: true }, credits, {}).researchBillingEnabled, true);
  assert.throws(() => researchBillingSettings({ researchBillingEnabled: true }, { ...credits, evimedCreditsPerCny: 100 }, {}), /one credit/);
  assert.throws(() => researchBillingSettings({ researchBillingEnabled: true }, { ...credits, evimedCreditsEnabled: false }, {}), /wallet/);
  assert.throws(() => researchBillingSettings({}, credits, { OPEN_SCIENCE_RESEARCH_BILLING_ENABLED: "typo" }), /true or false/);
  const configured = researchBillingSettings({}, credits, {
    OPEN_SCIENCE_RESEARCH_COMMERCE_ENABLED: "true",
    OPEN_SCIENCE_RESEARCH_COMMERCE_TRUSTED_ORIGINS: "https://www.evimed.com",
    OPEN_SCIENCE_RESEARCH_COMMERCE_RECHARGE_URL: "https://www.evimed.com/account/recharge",
  });
  assert.equal(createResearchCommerce(configured).links().rechargeUrl, "https://www.evimed.com/account/recharge");
});
