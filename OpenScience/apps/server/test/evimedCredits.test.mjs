// 灵豆 settlement without a database: the memo a person reads on their own
// statement, the rate that has no default, the wire this platform speaks to
// EviMed, and the two read-only routes — including the property the whole module
// is judged by, that with the toggle off nothing exists.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ALL_ERROR_CODES, EVIMED_CREDITS_ROUTE_ERROR_CODES, errorCodeMessage, errorCodeOutcome } from "@evimed/domain";
import { createEvimedCreditsClient, evimedKeyFileUsable, readEvimedApiKey, upstreamAmount } from "../src/evimedCreditsClient.mjs";
import {
  EVIMED_CREDITS_BACKOFF_MS,
  EVIMED_CREDITS_MAX_ATTEMPTS,
  EvimedCreditsService,
  creditsForCost,
  evimedCreditsRate,
  settlementMemo,
} from "../src/evimedCreditsService.mjs";
import { EvimedCreditsWorker } from "../src/evimedCreditsWorker.mjs";
import { createEvimedCreditsRoutes, evimedCreditsRoutePattern } from "../src/evimedCreditsRoutes.mjs";
import { loadConfig } from "../src/config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/** @param {string} method @param {string} url */
function request(method, url) {
  return Object.assign(Readable.from([]), { method, url, headers: { "content-type": "application/json" } });
}

function response() {
  return {
    status: 0, body: "", headers: /** @type {Record<string, string>} */ ({}),
    writeHead(/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}) {
      this.status = status; Object.assign(this.headers, headers); return this;
    },
    end(/** @type {string} */ chunk = "") { this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

/** @param {Record<string, any>} [overrides] */
function routesFixture(overrides = {}) {
  const calls = /** @type {any[]} */ ([]);
  const store = {
    async ensureSessionUser() { calls.push(["session"]); return { user: { id: "u_1" } }; },
    async assertCsrf(/** @type {any} */ _req, /** @type {string} */ pathname) { calls.push(["csrf", pathname]); },
  };
  const service = {
    async balanceFor(/** @type {string} */ userId) { calls.push(["balance", userId]); return { balance: 320, frozen: 0, unit: "灵豆", status: "ok" }; },
    async estimate(/** @type {string} */ capability) { calls.push(["estimate", capability]); return { capabilityId: capability, unit: "灵豆", low: 80, high: 160, basis: "history", samples: 9, creditsPerCny: 100 }; },
  };
  return { calls, routes: createEvimedCreditsRoutes({ store, service, config: { evimedCreditsEnabled: true }, ...overrides }) };
}

/** A service whose storage and upstream are doubles, for the arithmetic only. */
function service(config = {}) {
  return new EvimedCreditsService({
    config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100, ...config },
    database: null, client: { configured: true, status: () => ({ configured: true }) },
  });
}

test("the memo names the work in Chinese and carries nothing technical", () => {
  // The plan's own example (§9.6). A statement line is not a trace: a run id, a
  // session id or a model name in one is a support ticket waiting to happen.
  assert.equal(settlementMemo({ capabilityId: "clinical-evidence-synthesis", subject: "司美格鲁肽减重 Meta 分析" }),
    "临床证据深度分析 · 司美格鲁肽减重 Meta 分析");
  // No capability: the deep-research line pays for it under its own name.
  assert.equal(settlementMemo({ subject: "利伐沙班在房颤患者的剂量" }), "深度研究 · 利伐沙班在房颤患者的剂量");
  assert.equal(settlementMemo({}), "深度研究");
  // A subject that is only an identifier is dropped rather than printed.
  assert.equal(settlementMemo({ subject: "run_01J8XABCDEF" }), "深度研究");
  assert.equal(settlementMemo({ subject: " 多  空白\n和\u0007控制符 " }), "深度研究 · 多 空白 和 控制符");
  const long = settlementMemo({ subject: "阿" .repeat(120) });
  // The line, a separator and at most 40 characters of the subject.
  assert.ok([...long].length <= 55, long);
  assert.equal([...long.slice(long.indexOf(" · ") + 3)].length, 40);
  assert.ok(long.endsWith("…"));
  for (const memo of [settlementMemo({ capabilityId: "adr-analysis", subject: "奥希替尼 心脏 信号" }), long]) {
    assert.equal(/run_|session|deepseek|_tool|evimed_/.test(memo), false, memo);
  }
});

test("the 灵豆 rate has no default, and rounding never invents a charge", () => {
  // A guessed rate would charge every user wrongly and look exactly like a
  // working deployment, so 0 means "not configured" and settles nothing.
  assert.equal(evimedCreditsRate({}), 0);
  assert.equal(evimedCreditsRate({ evimedCreditsPerCny: 0 }), 0);
  assert.equal(evimedCreditsRate({ evimedCreditsPerCny: -5 }), 0);
  assert.equal(evimedCreditsRate({ evimedCreditsPerCny: 100 }), 100);
  assert.equal(creditsForCost(1.234, 100), 123);
  assert.equal(creditsForCost(1.236, 100), 124);
  // Rounded down to nothing on purpose: a sub-bean run is a charge the platform
  // waives, which is the side of the rounding a customer cannot be wronged by.
  assert.equal(creditsForCost(0.004, 100), 0);
  assert.equal(creditsForCost(0, 100), 0);
  assert.equal(creditsForCost(5, 0), 0);
  assert.equal(creditsForCost(Number.NaN, 100), 0);
  // The module is off until every part of it is present: the toggle, a database,
  // a reachable upstream and a rate.
  assert.equal(service().enabled, false, "no database means off");
  assert.equal(new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 0 }, database: {}, client: { configured: true } }).enabled, false);
  assert.equal(new EvimedCreditsService({ config: { evimedCreditsEnabled: false, evimedCreditsPerCny: 100 }, database: {}, client: { configured: true } }).enabled, false);
  assert.equal(new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {}, client: { configured: false } }).enabled, false);
  assert.equal(new EvimedCreditsService({ config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {}, client: { configured: true } }).enabled, true);
});

test("a settlement with the module off changes nothing and says which part is missing", async () => {
  for (const [config, reason] of [
    [{ evimedCreditsEnabled: false }, "not_enabled"],
    [{ evimedCreditsEnabled: true, evimedCreditsPerCny: 0 }, "rate_unset"],
  ]) {
    const off = new EvimedCreditsService({
      config, database: null,
      client: { configured: true, async deduct() { throw new Error("must not be called"); } },
    });
    assert.deepEqual(await off.settleRun({ userId: "u_1", runId: "run_1" }), { status: "skipped", reason });
  }
  // An unreachable upstream is the third: the rate and the toggle are there.
  const unconfigured = new EvimedCreditsService({
    config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {},
    client: { configured: false, async deduct() { throw new Error("must not be called"); } },
  });
  assert.deepEqual(await unconfigured.settleRun({ userId: "u_1", runId: "run_1" }), { status: "skipped", reason: "not_configured" });
  // And nothing is refused before a start either — a module that is off must not
  // be able to stop a question.
  assert.deepEqual(await unconfigured.assertBalanceForStart("u_1", "adr-analysis"), { allowed: true, reason: "not_enabled" });
});

test("a balance that cannot be read admits the start instead of blocking it", async () => {
  // Principles 14 and 19: our own accounting being unreachable is the one
  // outcome a user cannot act on, so it is a status and the work goes ahead.
  const credits = new EvimedCreditsService({
    config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {},
    client: {
      configured: true,
      async balance() { throw Object.assign(new Error("down"), { code: "evimed_credits_unreachable" }); },
    },
  });
  const balance = await credits.balanceFor("u_1");
  assert.deepEqual(balance, { balance: null, frozen: null, unit: "灵豆", status: "evimed_credits_unreachable" });
  assert.deepEqual(await credits.assertBalanceForStart("u_1", "adr-analysis"), { allowed: true, reason: "evimed_credits_unreachable" });
  assert.equal(credits.status().counters.balanceUnavailable, 2);
});

test("an empty balance refuses the start with the code the platform reserved for it", async () => {
  const credits = new EvimedCreditsService({
    config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: {},
    client: { configured: true, async balance() { return { balance: 0, frozen: 0 }; } },
  });
  await assert.rejects(credits.assertBalanceForStart("u_1", "adr-analysis"), (/** @type {any} */ error) => {
    // `usageMetering.mjs` kept `credits_exhausted` for 「a balance, which this
    // deployment does not have」. It does now, and the sentence it has carried
    // all along offers the top-up that finally exists.
    assert.equal(error.status, 402);
    assert.equal(error.code, "credits_exhausted");
    assert.equal(errorCodeOutcome("credits_exhausted"), "capped");
    assert.match(errorCodeMessage("credits_exhausted"), /充值/);
    return true;
  });
  assert.equal(credits.status().counters.refusedStarts, 1);
});

test("the estimate has no history to read without storage, and says so rather than guessing", async () => {
  // `basis` is the honesty: a surface can say 「首次运行」 instead of presenting
  // the manifest's minutes as a measurement.
  const credits = new EvimedCreditsService({
    config: { evimedCreditsEnabled: true, evimedCreditsPerCny: 100 }, database: null,
    client: { configured: true },
  });
  const unknown = await credits.estimate("adr-analysis");
  assert.equal(unknown.samples, 0);
  assert.equal(unknown.unit, "灵豆");
  // 20–40 minutes in the capability's own manifest, at the domain's reference
  // per-minute rate, converted at this deployment's rate.
  assert.equal(unknown.basis, "manifest");
  assert.ok(unknown.low > 0 && unknown.high > unknown.low, JSON.stringify(unknown));
  const none = await credits.estimate("");
  assert.deepEqual([none.basis, none.low, none.high], ["none", 0, 0]);
});

test("the backoff is bounded, so one outage cannot become a permanent retry loop", () => {
  assert.ok(EVIMED_CREDITS_BACKOFF_MS.length >= 4);
  for (let index = 1; index < EVIMED_CREDITS_BACKOFF_MS.length; index += 1) {
    assert.ok(EVIMED_CREDITS_BACKOFF_MS[index] > EVIMED_CREDITS_BACKOFF_MS[index - 1], "the waits must grow");
  }
  assert.equal(EVIMED_CREDITS_MAX_ATTEMPTS, EVIMED_CREDITS_BACKOFF_MS.length + 1);
  assert.ok(EVIMED_CREDITS_BACKOFF_MS.at(-1) >= 24 * 60 * 60_000 - 1, "the last wait should span an outage a person sleeps through");
});

test("the key file is the one EviMed already issued, and its mode is checked", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evimed-credits-key-"));
  try {
    const file = path.join(dir, "evimed.api-key");
    writeFileSync(file, "ev-secret-123\n", { mode: 0o600 });
    assert.deepEqual(await readEvimedApiKey(file), { value: "ev-secret-123", error: null });
    assert.equal(evimedKeyFileUsable(file), true);
    // Group read is how the host shares this one key with the knowledge plugin
    // (root:10002 0440); refusing it turned every EviMed call into
    // `credential_missing` for three days in September.
    chmodSync(file, 0o440);
    assert.equal((await readEvimedApiKey(file)).value, "ev-secret-123");
    assert.equal(evimedKeyFileUsable(file), true);
    // Anything for others, or group write, is not.
    chmodSync(file, 0o644);
    assert.equal((await readEvimedApiKey(file)).error, "key_file_permissions");
    assert.equal(evimedKeyFileUsable(file), false);
    chmodSync(file, 0o660);
    assert.equal((await readEvimedApiKey(file)).error, "key_file_permissions");
    assert.deepEqual(await readEvimedApiKey(""), { value: "", error: "key_file_unconfigured" });
    assert.equal((await readEvimedApiKey(path.join(dir, "absent"))).error, "key_file_unavailable");
    assert.equal(evimedKeyFileUsable("/dev/null"), false, "compose binds /dev/null where a deployment has no key");
    const empty = path.join(dir, "empty");
    writeFileSync(empty, "", { mode: 0o600 });
    assert.equal((await readEvimedApiKey(empty)).error, "key_file_empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wire is EviMed's own envelope, and only its refusal is final", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evimed-credits-wire-"));
  try {
    const file = path.join(dir, "evimed.api-key");
    writeFileSync(file, "ev-secret-123\n", { mode: 0o600 });
    /** @type {any[]} */
    const sent = [];
    /** @param {any} answer */
    const clientWith = (answer) => createEvimedCreditsClient({
      deductUrl: "https://www.evimed.com/api-evimed/credits/deduct",
      balanceUrl: "https://www.evimed.com/api-evimed/credits/balance",
      apiKeyFile: file,
      fetchImpl: async (/** @type {any} */ url, /** @type {any} */ init) => {
        sent.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
        return answer();
      },
    });
    const ok = () => new Response(JSON.stringify({ code: 200, msg: "success", data: { receiptId: "rcpt_9", balance: 200 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    const client = clientWith(ok);
    assert.equal(client.configured, true);
    const receipt = await client.deduct({ requestId: "run_42", userId: "u_1", credits: 120, memo: "深度研究 · 司美格鲁肽" });
    assert.deepEqual(receipt, { receiptId: "rcpt_9", balance: 200 });
    // The run id is the upstream's idempotency key — that is what makes a retry
    // of an unknown outcome safe rather than a second charge.
    assert.equal(sent[0].body.requestId, "run_42");
    assert.equal(sent[0].body.credits, 120);
    assert.equal(sent[0].headers.authorization, "Bearer ev-secret-123");
    assert.equal(sent[0].headers["content-type"], "application/json");

    // The envelope's own refusal: EviMed read it and declined. Final.
    const refused = clientWith(() => new Response(JSON.stringify({ code: 400, msg: "参数错误" }), { status: 200 }));
    await assert.rejects(refused.deduct({ requestId: "run_43", userId: "u_1", credits: 1, memo: "m" }),
      (/** @type {any} */ error) => error.code === "evimed_credits_refused" && error.final === true);
    // An outage is not a refusal: it is an outcome nobody knows yet.
    for (const [answer, code] of /** @type {Array<[any, string]>} */ ([
      [() => new Response("", { status: 503 }), "evimed_credits_http_error"],
      [() => new Response("", { status: 429 }), "evimed_credits_rate_limited"],
      [() => new Response("not json", { status: 200 }), "evimed_credits_response_invalid"],
      [() => { throw Object.assign(new Error("boom"), { name: "TypeError" }); }, "evimed_credits_unreachable"],
      [() => { throw Object.assign(new Error("late"), { name: "TimeoutError" }); }, "evimed_credits_timeout"],
    ])) {
      const failing = clientWith(answer);
      await assert.rejects(failing.deduct({ requestId: "run_44", userId: "u_1", credits: 1, memo: "m" }),
        (/** @type {any} */ error) => {
          assert.equal(error.code, code);
          assert.equal(error.final, false, `${code} must be retryable: the run id keeps the charge idempotent`);
          return true;
        });
      assert.equal(failing.status().lastError, code);
    }
    // A key refused is this deployment's problem, not a transient one.
    const unauthorized = clientWith(() => new Response("", { status: 401 }));
    await assert.rejects(unauthorized.deduct({ requestId: "run_45", userId: "u_1", credits: 1, memo: "m" }),
      (/** @type {any} */ error) => error.code === "evimed_credits_unauthorized" && error.final === true);
    // Its own fields are checked before anything leaves.
    for (const bad of [{ credits: 0 }, { credits: 1.5 }, { credits: -2 }, { requestId: "" }, { userId: "" }]) {
      await assert.rejects(clientWith(ok).deduct({ requestId: "run_46", userId: "u_1", credits: 1, memo: "m", ...bad }),
        (/** @type {any} */ error) => error.code === "evimed_credits_request_invalid");
    }
    // A balance answer without a balance is not a zero balance.
    const empty = clientWith(() => new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 }));
    await assert.rejects(empty.balance("u_1"), (/** @type {any} */ error) => error.code === "evimed_credits_response_invalid");
    assert.deepEqual([upstreamAmount("12.5"), upstreamAmount(3), upstreamAmount(null), upstreamAmount("x"), upstreamAmount(-1)],
      [12.5, 3, null, null, null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a credits path's metric label folds every route, so a dashboard row is a route", () => {
  for (const [pathname, label] of [
    ["/api/credits/balance", "/api/credits/balance"],
    ["/api/credits/estimate", "/api/credits/estimate"],
    ["/api/credits", "/api/credits/:route"],
    ["/api/credits/whatever", "/api/credits/:route"],
  ]) assert.equal(evimedCreditsRoutePattern(pathname), label, pathname);
});

test("the two numbers the composer shows, authenticated and read-only", async () => {
  const { calls, routes } = routesFixture();
  const balance = response();
  assert.equal(await routes(request("GET", "/api/credits/balance"), balance), true);
  assert.deepEqual(balance.json(), { data: { balance: 320, frozen: 0, unit: "灵豆", status: "ok" } });
  assert.equal(balance.headers["Cache-Control"], "private, no-store");
  const estimate = response();
  assert.equal(await routes(request("GET", "/api/credits/estimate?capability=adr-analysis"), estimate), true);
  assert.deepEqual(estimate.json().data, { capabilityId: "adr-analysis", unit: "灵豆", low: 80, high: 160, basis: "history", samples: 9, creditsPerCny: 100 });
  // The session and the repeated CSRF check are the whole guard, and the account
  // is the session's: a balance is never a parameter.
  assert.deepEqual(calls, [["session"], ["csrf", "/api/credits/balance"], ["balance", "u_1"],
    ["session"], ["csrf", "/api/credits/estimate"], ["estimate", "adr-analysis"]]);
  // An estimate for no named capability is the deep-research line's own.
  const bare = routesFixture();
  assert.equal(await bare.routes(request("GET", "/api/credits/estimate"), response()), true);
  assert.deepEqual(bare.calls.at(-1), ["estimate", ""]);
  await assert.rejects(routes(request("GET", "/api/credits/estimate?capability=../etc/passwd"), response()),
    { status: 400, code: "evimed_credits_request_invalid" });
  await assert.rejects(routes(request("POST", "/api/credits/balance"), response()), { status: 405, code: "method_not_allowed" });
  await assert.rejects(routes(request("GET", "/api/credits/topup"), response()), { status: 404, code: "not_found" });
  assert.equal(await routes(request("GET", "/api/runs"), response()), false, "another module's path is not this one's");
});

test("with the module off the routes are gone and the shell stops asking", async () => {
  // Off is invisible, not a zero balance: a deployment that has not joined
  // EviMed's billing must render no balance at all.
  for (const off of [{ config: { evimedCreditsEnabled: false } }, { service: null }]) {
    const { calls, routes } = routesFixture(off);
    for (const pathname of ["/api/credits/balance", "/api/credits/estimate?capability=adr-analysis"]) {
      await assert.rejects(routes(request("GET", pathname), response()),
        { status: 404, code: "evimed_credits_not_enabled" });
    }
    assert.deepEqual(calls, [], "an off module must not even open a session");
  }
  // And the code it answers with is registered, with a Chinese sentence.
  assert.deepEqual(EVIMED_CREDITS_ROUTE_ERROR_CODES.filter((code) => !ALL_ERROR_CODES.includes(code)), []);
  for (const code of EVIMED_CREDITS_ROUTE_ERROR_CODES) {
    assert.match(errorCodeMessage(code), /[一-鿿]/, code);
    assert.notEqual(errorCodeOutcome(code), "unknown", code);
  }
  // Every code the routes and the service throw is one of those, or already
  // registered elsewhere. The scan must prove it scanned.
  const emitted = new Set();
  for (const file of ["../src/evimedCreditsRoutes.mjs", "../src/evimedCreditsService.mjs"]) {
    const text = await import("node:fs/promises").then((fs) => fs.readFile(new URL(file, import.meta.url), "utf8"));
    for (const [, code] of text.matchAll(/new HttpError\(\s*\d{3},\s*"([a-z0-9_]+)"/g)) emitted.add(code);
    for (const [, code] of text.matchAll(/HttpError\(\d{3}, permission\.code \?\? "([a-z0-9_]+)"/g)) emitted.add(code);
  }
  assert.ok(emitted.size >= 3, `only ${emitted.size} codes were found; the scan did not run`);
  assert.deepEqual([...emitted].filter((code) => !ALL_ERROR_CODES.includes(code) && code !== "method_not_allowed" && code !== "not_found").sort(), []);
});

test("the retry worker ticks once at a time and reports a failure instead of throwing", async () => {
  let inFlight = 0;
  let release = () => {};
  const worker = new EvimedCreditsWorker({
    service: {
      async retryDue(/** @type {number} */ limit) {
        inFlight += 1;
        assert.equal(inFlight, 1, "two ticks ran at once");
        await new Promise((resolve) => { release = () => resolve(null); });
        inFlight -= 1;
        return limit;
      },
    },
    pollMs: 3_600_000, batch: 7,
  });
  const first = worker.tick();
  assert.equal(worker.tick(), first, "a second tick joins the one in flight");
  release();
  assert.equal(await first, 7);
  assert.equal(worker.status().attempted, 7);
  assert.equal(worker.status().lastError, null);
  const reported = /** @type {string[]} */ ([]);
  const failing = new EvimedCreditsWorker({
    service: { async retryDue() { throw Object.assign(new Error("x"), { code: "evimed_credits_unreachable" }); } },
    pollMs: 3_600_000, report: (code) => reported.push(code),
  });
  assert.equal(await failing.tick(), 0);
  assert.deepEqual(reported, ["evimed_credits_unreachable"]);
  assert.equal(failing.status().failures, 1);
  await failing.close();
  await worker.close();
});

test("the config lever is off by default and every knob is checked at load", () => {
  const saved = process.env;
  try {
    process.env = { NODE_ENV: "production", OPEN_SCIENCE_AUTH_MODE: "local" };
    const off = loadConfig({ rootDir: repoRoot });
    assert.equal(off.evimedCreditsEnabled, false);
    assert.equal(off.evimedCreditsPerCny, 0, "a guessed rate would charge every user wrongly");
    assert.deepEqual([off.evimedCreditsUrl, off.evimedCreditsBalanceUrl], ["", ""]);
    assert.equal(off.evimedCreditsTimeoutMs, 10_000);
    assert.equal(off.evimedCreditsPollMs, 60_000);
    const on = loadConfig({
      rootDir: repoRoot,
      evimedCreditsEnabled: true,
      evimedCreditsUrl: "https://www.evimed.com/api-evimed/credits/deduct",
      evimedCreditsBalanceUrl: "https://www.evimed.com/api-evimed/credits/balance",
      evimedCreditsApiKeyFile: "/run/secrets/evimed-api-key",
      evimedCreditsPerCny: 100,
    });
    assert.equal(on.evimedCreditsEnabled, true);
    assert.equal(on.evimedCreditsApiKeyFile, "/run/secrets/evimed-api-key");
    // The key travels in an Authorization header on every call, so plaintext is
    // refused unless it is loopback.
    assert.throws(() => loadConfig({ rootDir: repoRoot, evimedCreditsUrl: "http://credits.example/deduct" }), /must be https/);
    loadConfig({ rootDir: repoRoot, evimedCreditsUrl: "http://127.0.0.1:9000/deduct" });
    assert.throws(() => loadConfig({ rootDir: repoRoot, evimedCreditsUrl: "https://user:example-placeholder@credits.example/deduct" }), /no credentials/);
    assert.throws(() => loadConfig({ rootDir: repoRoot, evimedCreditsPerCny: -1 }), /EVIMED_CREDITS_PER_CNY/);
    assert.throws(() => loadConfig({ rootDir: repoRoot, evimedCreditsTimeoutMs: 10 }), /EVIMED_CREDITS_TIMEOUT_MS/);
    // A relative key path is refused only when the module is on: `.env.example`
    // has carried one for docker's own `secrets:` mapping since long before this.
    loadConfig({ rootDir: repoRoot, evimedCreditsApiKeyFile: "./secrets/evimed-api-key.txt" });
    assert.throws(() => loadConfig({
      rootDir: repoRoot, evimedCreditsEnabled: true, evimedCreditsApiKeyFile: "./secrets/evimed-api-key.txt",
    }), /absolute path/);
  } finally {
    process.env = saved;
  }
});
