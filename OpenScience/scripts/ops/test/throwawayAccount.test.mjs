import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  ACCOUNT_ROUTE, LOGIN_ROUTE, REGISTER_ROUTE, ThrowawayAccountError, contextTransport, fetchTransport, openThrowawayAccount, throwawayId, throwawayPassword,
} from "../throwaway-account.mjs";

const BASE = "https://evimed.example.org";
const FIXED = new Date("2026-10-25T09:07:42Z");
const bytes = (size) => Buffer.alloc(size, 0xab);

/** A transport that answers from a script and remembers what it was asked. */
function scripted(answers) {
  const asked = [];
  const send = async (request) => {
    asked.push(request);
    const next = answers[request.method + " " + request.route];
    const answer = typeof next === "function" ? next(request, asked) : next;
    if (answer instanceof Error) throw answer;
    return answer ?? { status: 404, body: null, cookies: [] };
  };
  return { send, asked };
}
const registered = { status: 201, body: { data: { user: { id: "x" }, csrfToken: "csrf-1" } }, cookies: ["evimed_session=s1; Path=/; HttpOnly"] };
const deleted = { status: 200, body: { data: true }, cookies: [] };

test("an id says which script made the account and when, and fits what the product accepts", () => {
  assert.equal(throwawayId("walk", FIXED, bytes), "walk-202610250907-ababab");
  assert.match(throwawayId("acc"), /^acc-\d{12}-[0-9a-f]{6}$/);
  assert.match(throwawayId("walk", FIXED, bytes), /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
  assert.throws(() => throwawayId("Walk Fixture"), /short lowercase word/);
  assert.ok(throwawayPassword().length >= 24);
  assert.notEqual(throwawayPassword(), throwawayPassword());
});

test("an account is registered by the product's own route, named, signed in, and deleted with its id, password and CSRF token", async () => {
  const lines = [];
  const { send, asked } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: deleted });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "walk", say: (line) => lines.push(line), now: () => FIXED, random: bytes, signals: false });
  assert.equal(account.id, "walk-202610250907-ababab");
  assert.deepEqual(lines, ["account created: walk-202610250907-ababab"]);
  const [register] = asked;
  assert.equal(register.body.username, account.id);
  assert.equal(register.body.name, account.id);
  assert.ok(register.body.password.length >= 24, "the password floor is six characters; this one is made long");
  assert.equal(register.headers.origin, BASE);
  assert.deepEqual(account.headers, { cookie: "evimed_session=s1", "x-open-science-csrf": "csrf-1" });
  assert.deepEqual(await account.close(), { deleted: true, reason: null });
  const remove = asked[1];
  assert.deepEqual([remove.method, remove.route], ["DELETE", ACCOUNT_ROUTE]);
  assert.deepEqual(remove.body, { confirm: account.id, password: register.body.password });
  assert.equal(remove.headers["x-open-science-csrf"], "csrf-1");
  assert.equal(remove.headers.origin, BASE);
  assert.deepEqual(lines.slice(1), ["account deleted: walk-202610250907-ababab"]);
  assert.equal(lines.some((line) => line.includes(register.body.password)), false, "the password is never printed");
});

test("closing twice asks for one deletion: a finally and a signal may both close", async () => {
  const { send, asked } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: deleted });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: () => {}, signals: false });
  const [first, second] = await Promise.all([account.close(), account.close()]);
  assert.deepEqual([first, second], [{ deleted: true, reason: null }, { deleted: true, reason: null }]);
  assert.equal(asked.filter((request) => request.method === "DELETE").length, 1);
});

test("what the script started is stopped first, and a busy account is asked again after a wait", async () => {
  const order = [];
  const sleeps = [];
  let busy = 2;
  const { send, asked } = scripted({
    [`POST ${REGISTER_ROUTE}`]: registered,
    [`DELETE ${ACCOUNT_ROUTE}`]: () => { order.push("delete"); return busy-- > 0 ? { status: 409, body: { code: "account_busy" }, cookies: [] } : deleted; },
  });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: () => {}, signals: false, waitMs: 7,
    sleep: async (ms) => { sleeps.push(ms); }, stop: async (self) => { order.push(`stop ${self.id.slice(0, 3)}`); } });
  assert.deepEqual(await account.close(), { deleted: true, reason: null });
  assert.deepEqual(order, ["stop acc", "delete", "delete", "delete"]);
  assert.deepEqual(sleeps, [7, 7]);
  assert.equal(asked.filter((request) => request.method === "DELETE").length, 3);
});

test("a stop that fails is said and the deletion is still asked", async () => {
  const lines = [];
  const { send } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: deleted });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: (line) => lines.push(line), signals: false,
    stop: async () => { throw new Error("the run would not cancel"); } });
  assert.equal((await account.close()).deleted, true);
  assert.ok(lines.some((line) => /^INFO account acc-.*could not be stopped first \(the run would not cancel\)/.test(line)), lines.join("\n"));
});

test("a session that ended is signed in again with the password the account was made with, and the deletion is asked once more", async () => {
  let removals = 0;
  const { send, asked } = scripted({
    [`POST ${REGISTER_ROUTE}`]: registered,
    [`POST ${LOGIN_ROUTE}`]: { status: 200, body: { data: { csrfToken: "csrf-2" } }, cookies: [] },
    [`DELETE ${ACCOUNT_ROUTE}`]: () => (removals++ === 0 ? { status: 401, body: { code: "unauthorized" }, cookies: [] } : deleted),
  });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "walk", say: () => {}, signals: false });
  assert.equal((await account.close()).deleted, true);
  const login = asked.find((request) => request.route === LOGIN_ROUTE);
  assert.deepEqual(login.body, { username: account.id, password: asked[0].body.password });
  assert.equal(asked.filter((request) => request.method === "DELETE").at(-1).headers["x-open-science-csrf"], "csrf-2");
});

test("a deletion that cannot be done is a FAIL line naming the account, with the product's reason and never the password", async () => {
  const lines = [];
  const sleeps = [];
  const { send, asked } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: { status: 409, body: { code: "account_busy" }, cookies: [] } });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "walk", say: (line) => lines.push(line), now: () => FIXED, random: bytes, signals: false,
    attempts: 3, sleep: async (ms) => { sleeps.push(ms); } });
  const outcome = await account.close();
  assert.deepEqual(outcome, { deleted: false, reason: "409 account_busy" });
  assert.equal(asked.filter((request) => request.method === "DELETE").length, 3);
  assert.equal(sleeps.length, 2, "no wait after the last try");
  const fail = lines.find((line) => line.startsWith("FAIL "));
  assert.match(fail, /^FAIL account walk-202610250907-ababab was NOT deleted \(409 account_busy\)/);
  assert.equal(lines.some((line) => line.startsWith("account deleted")), false);
  assert.equal(lines.some((line) => line.includes(asked[0].body.password)), false);
});

test("a refusal that is the product's answer to the request is not waited on", async () => {
  const sleeps = [];
  const { send, asked } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: { status: 403, body: { code: "invalid_password" }, cookies: [] } });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: () => {}, signals: false, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await account.close(), { deleted: false, reason: "403 invalid_password" });
  assert.equal(asked.filter((request) => request.method === "DELETE").length, 1);
  assert.deepEqual(sleeps, []);
});

test("a deletion whose request does not complete is asked again and reports what it saw", async () => {
  let tries = 0;
  const { send } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: () => (tries++ === 0 ? new Error("socket hang up") : deleted) });
  const account = await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: () => {}, signals: false, sleep: async () => {} });
  assert.equal((await account.close()).deleted, true);
  assert.equal(tries, 2);
});

test("a registration the product refuses makes no account, and says why in words an operator can act on", async () => {
  const closed = scripted({ [`POST ${REGISTER_ROUTE}`]: { status: 403, body: { code: "self_registration_disabled" }, cookies: [] } });
  await assert.rejects(openThrowawayAccount({ base: BASE, send: closed.send, prefix: "walk", say: () => {}, signals: false }),
    (error) => error instanceof ThrowawayAccountError && error.account === null && /self_registration_disabled.*does not take new accounts/.test(error.message));
  const weak = scripted({ [`POST ${REGISTER_ROUTE}`]: { status: 400, body: { code: "weak_password" }, cookies: [] } });
  await assert.rejects(openThrowawayAccount({ base: BASE, send: weak.send, prefix: "walk", say: () => {}, signals: false }), /400 weak_password/);
});

test("a registration that may have created the account names it, so the caller can report the leftover", async () => {
  const dropped = scripted({ [`POST ${REGISTER_ROUTE}`]: new Error("fetch failed") });
  await assert.rejects(openThrowawayAccount({ base: BASE, send: dropped.send, prefix: "walk", say: () => {}, now: () => FIXED, random: bytes, signals: false }),
    (error) => error.account === "walk-202610250907-ababab" && /may exist/.test(error.message));
  const noSession = scripted({ [`POST ${REGISTER_ROUTE}`]: { status: 201, body: { data: {} }, cookies: [] } });
  await assert.rejects(openThrowawayAccount({ base: BASE, send: noSession.send, prefix: "walk", say: () => {}, signals: false }),
    (error) => typeof error.account === "string" && /left no session/.test(error.message));
});

test("over fetch the session the registration sets is the one the deletion is sent with", async (t) => {
  const seen = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    seen.push({ method: request.method, url: request.url, cookie: request.headers.cookie ?? null, csrf: request.headers["x-open-science-csrf"] ?? null, body: raw ? JSON.parse(raw) : null });
    if (request.url === REGISTER_ROUTE) response.setHeader("set-cookie", ["evimed_session=abc123; Path=/; HttpOnly", "other=1; Path=/"]);
    response.writeHead(request.url === REGISTER_ROUTE ? 201 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: request.url === REGISTER_ROUTE ? { csrfToken: "tok" } : true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const account = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: "acc", say: () => {}, signals: false });
  assert.equal(account.cookie, "evimed_session=abc123; other=1");
  assert.deepEqual(await account.close(), { deleted: true, reason: null });
  const remove = seen.find((entry) => entry.method === "DELETE");
  assert.equal(remove.url, ACCOUNT_ROUTE);
  assert.equal(remove.cookie, "evimed_session=abc123; other=1");
  assert.equal(remove.csrf, "tok");
  assert.equal(remove.body.confirm, account.id);
});

test("through a browser context the context's own cookie jar carries the session", async () => {
  const calls = [];
  const response = (status, body, headers = []) => ({ status: () => status, json: async () => body, headersArray: () => headers });
  const context = { request: {
    post: async (url, options) => { calls.push(["post", url, options]); return response(201, { data: { csrfToken: "c" } }, [{ name: "Set-Cookie", value: "evimed_session=q; Path=/" }, { name: "Content-Type", value: "application/json" }]); },
    delete: async (url, options) => { calls.push(["delete", url, options]); return response(200, { data: true }); },
  } };
  const account = await openThrowawayAccount({ base: BASE, send: contextTransport(context, BASE), prefix: "walk", say: () => {}, signals: false });
  assert.equal(account.cookie, "evimed_session=q");
  assert.equal((await account.close()).deleted, true);
  assert.deepEqual(calls.map(([method, url]) => [method, url]), [["post", `${BASE}${REGISTER_ROUTE}`], ["delete", `${BASE}${ACCOUNT_ROUTE}`]]);
  assert.equal(calls[1][2].data.confirm, account.id);
  assert.equal("cookie" in calls[1][2].headers, false, "the context sends its own cookie");
});

test("an interrupted script deletes its account before it exits, then closes what it still holds", async () => {
  const { send, asked } = scripted({ [`POST ${REGISTER_ROUTE}`]: registered, [`DELETE ${ACCOUNT_ROUTE}`]: deleted });
  const order = [];
  const exit = process.exit;
  const listeners = process.listenerCount("SIGTERM");
  /** @type {() => void} */ let exited = () => {};
  const done = new Promise((resolve) => { exited = resolve; });
  // @ts-expect-error the test stands in for the exit
  process.exit = (code) => { order.push(`exit ${code}`); exited(); };
  try {
    await openThrowawayAccount({ base: BASE, send, prefix: "acc", say: () => order.push("said"), onSignal: async () => { order.push("closed"); } });
    process.emit("SIGTERM");
    await done;
  } finally { process.exit = exit; }
  assert.equal(asked.filter((request) => request.method === "DELETE").length, 1);
  assert.deepEqual(order, ["said", "said", "closed", "exit 143"]);
  assert.equal(process.listenerCount("SIGTERM"), listeners, "its handlers are gone once it has closed");
});
