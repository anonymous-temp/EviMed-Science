// The one cheap question asked when a credential is saved (2026-10-04): does
// the source accept it? What these pin: every probe stays inside what the
// public-source gateway already approves and authenticates the way the gateway
// does, the answer is one of four states and nothing the source said, a source
// that is down or slow is "unreachable" and never an error, and a source with no
// trivial authenticated endpoint is "unchecked" rather than guessed.
import assert from "node:assert/strict";
import test from "node:test";

import { CONNECTOR_CREDENTIALS } from "@evimed/domain";

import { CHECKABLE_CONNECTORS, CREDENTIAL_CHECK_TIMEOUT_MS, checkConnectorCredential, connectorProbeRequest } from "../src/connectorCredentialCheck.mjs";
import { PUBLIC_SOURCE_ALLOWED_HOSTS, PUBLIC_SOURCE_CREDENTIAL_PROFILES } from "../src/publicSourceGateway.mjs";

const KEY = "probe-credential-7f3a91";

/** A fetch that records each request and answers with `answer`. */
function answering(answer) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return typeof answer === "function" ? answer(new URL(url), options) : answer;
  };
  return { calls, fetchImpl };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status) => new Response(null, { status });

test("every probe stays inside the gateway's approved surface and authenticates as the gateway does", () => {
  assert.ok(CHECKABLE_CONNECTORS.length >= 10, `walked ${CHECKABLE_CONNECTORS.length} probes`);
  for (const connector of CHECKABLE_CONNECTORS) {
    const request = connectorProbeRequest(connector, KEY);
    assert.ok(request, connector);
    assert.equal(request.url.protocol, "https:");
    assert.ok(PUBLIC_SOURCE_ALLOWED_HOSTS.has(request.url.hostname), `${connector}: ${request.url.hostname} is not an approved host`);
    const profile = PUBLIC_SOURCE_CREDENTIAL_PROFILES.get(connector);
    if (profile) {
      // The probe is the request a run would make for this profile: its host,
      // under its path, with the credential in the place the gateway puts it.
      assert.equal(request.url.hostname, profile.host, connector);
      assert.ok(request.url.pathname.startsWith(profile.path), `${connector}: ${request.url.pathname} is outside ${profile.path}`);
      if (profile.header) assert.equal(request.headers[profile.header], profile.scheme ? `${profile.scheme} ${KEY}` : KEY, connector);
      else assert.equal(request.url.searchParams.get(profile.query), KEY, connector);
    } else {
      // The two rate-ceiling keys: `api_key` on a host that serves without one.
      assert.ok(["ncbi", "openfda"].includes(connector), `${connector} has no gateway profile`);
      assert.equal(request.url.searchParams.get("api_key"), KEY, connector);
    }
    // The credential is placed once, in a header or the query, and never in a body.
    const placed = [request.url.href, JSON.stringify(request.headers), request.body ?? ""].join("\n").split(KEY).length - 1;
    assert.equal(placed, 1, `${connector} placed the credential ${placed} times`);
    assert.ok(!(request.body ?? "").includes(KEY), connector);
  }
  // A connector with no probe is not guessed at.
  assert.equal(connectorProbeRequest("biogrid"), null);
  assert.equal(connectorProbeRequest("nope"), null);
});

test("every connector is either asked about or said to be unchecked, and the unchecked say so without a request", async () => {
  const { calls, fetchImpl } = answering(json({}));
  for (const spec of CONNECTOR_CREDENTIALS) {
    const state = await checkConnectorCredential(spec.id, KEY, { fetchImpl });
    assert.ok(["verified", "rejected", "unreachable", "unchecked"].includes(state), spec.id);
    if (!CHECKABLE_CONNECTORS.includes(spec.id)) assert.equal(state, "unchecked", spec.id);
  }
  assert.equal(await checkConnectorCredential("biogrid", KEY, { fetchImpl }), "unchecked");
  assert.equal(await checkConnectorCredential("not-a-connector", KEY, { fetchImpl }), "unchecked");
  assert.equal(calls.some((call) => call.url.hostname === "webservice.thebiogrid.org"), false, "an unchecked source is never asked");
  assert.equal(await checkConnectorCredential("umls", KEY, { fetchImpl: null }), "unchecked", "no way to ask is no verdict");
});

test("a 2xx is verified, a refusal of the credential is rejected, and anything else says nothing about it", async () => {
  for (const connector of CHECKABLE_CONNECTORS.filter((id) => !["evimed-evidence", "ncbi", "unpaywall"].includes(id))) {
    for (const [status, expected] of [[200, "verified"], [401, "rejected"], [403, "rejected"], [404, "unreachable"], [429, "unreachable"], [500, "unreachable"], [503, "unreachable"]]) {
      const { fetchImpl } = answering(status === 200 ? json({ results: [] }) : empty(status));
      assert.equal(await checkConnectorCredential(connector, KEY, { fetchImpl }), expected, `${connector} ${status}`);
    }
  }
  // Unpaywall has no key: a contact address it will not accept is a 422.
  assert.equal(await checkConnectorCredential("unpaywall", "someone@lab.example", { fetchImpl: answering(json({ doi: "10.1038/nature12373" })).fetchImpl }), "verified");
  assert.equal(await checkConnectorCredential("unpaywall", "someone@example.com", { fetchImpl: answering(empty(422)).fetchImpl }), "rejected");
  assert.equal(await checkConnectorCredential("unpaywall", "someone@lab.example", { fetchImpl: answering(empty(500)).fetchImpl }), "unreachable");
});

test("a source that is down, slow or refusing connections is unreachable, never an error", async () => {
  for (const failure of [new TypeError("fetch failed"), Object.assign(new Error("aborted"), { name: "TimeoutError" }), new Error("redirect mode is set to error")]) {
    const fetchImpl = async () => { throw failure; };
    assert.equal(await checkConnectorCredential("umls", KEY, { fetchImpl }), "unreachable", failure.message);
  }
  // A source that never answers is cut off at the bound, and says so by name.
  const calls = [];
  const hang = (_url, options) => new Promise((_resolve, reject) => {
    calls.push(options);
    options.signal.addEventListener("abort", () => reject(options.signal.reason));
  });
  const started = Date.now();
  // AbortSignal.timeout's timer is unref'd; with nothing else pending, Node 22
  // ends the test's event loop before it fires (CI pins 22). A ref'd stand-in
  // keeps the loop alive for exactly as long as the bound is being measured.
  const keepAlive = setInterval(() => {}, 100);
  const answer = await checkConnectorCredential("core", KEY, { fetchImpl: hang, timeoutMs: 600 }).finally(() => clearInterval(keepAlive));
  assert.equal(answer, "unreachable");
  assert.ok(Date.now() - started < 3_000, "the bound held");
  assert.ok(CREDENTIAL_CHECK_TIMEOUT_MS <= 5_000, "a save is never held for long");
  assert.equal(calls[0].redirect, "error", "a redirect is not followed with a credential on the request");
});

test("EviMed answers in its own envelope, so its body decides", async () => {
  const ask = (response) => checkConnectorCredential("evimed-evidence", KEY, { fetchImpl: answering(response).fetchImpl });
  assert.equal(await ask(json({ code: 200, msg: "success", data: { list: [] } })), "verified");
  // A refused key can ride a 200: the envelope's own code says so.
  assert.equal(await ask(json({ code: 401, msg: "invalid key" })), "rejected");
  assert.equal(await ask(json({ code: 403, msg: "account unavailable" })), "rejected");
  assert.equal(await ask(json({ code: 401, msg: "invalid key" }, 401)), "rejected");
  assert.equal(await ask(empty(401)), "rejected");
  assert.equal(await ask(json({ code: 500, msg: "boom" })), "unreachable");
  // A 200 that is not their envelope is not a verification (a CDN's error page).
  assert.equal(await ask(new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } })), "unreachable");
  const { calls, fetchImpl } = answering(json({ code: 200, data: {} }));
  await checkConnectorCredential("evimed-evidence", KEY, { fetchImpl });
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: "aspirin", count: 1 });
  assert.equal(calls[0].options.headers.authorization, `Bearer ${KEY}`);
});

test("NCBI refuses a bad key with a 400 or an error field, and what it says is never read past that", async () => {
  const ask = (response) => checkConnectorCredential("ncbi", KEY, { fetchImpl: answering(response).fetchImpl });
  assert.equal(await ask(json({ header: { type: "einfo" }, einforesult: { dblist: ["pubmed"] } })), "verified");
  assert.equal(await ask(json({ error: "API key invalid", "api-key": KEY })), "rejected");
  assert.equal(await ask(json({ error: "API key invalid", "api-key": KEY }, 400)), "rejected");
  assert.equal(await ask(empty(403)), "rejected");
  assert.equal(await ask(empty(429)), "unreachable");
  assert.equal(await ask(empty(502)), "unreachable");
  // A body that is not JSON decides nothing.
  assert.equal(await ask(new Response("not json", { status: 200 })), "unreachable");
});

test("the answer is a state and nothing the source said, even when the source echoes the key", async () => {
  for (const connector of CHECKABLE_CONNECTORS) {
    const echo = json({ error: `Invalid key ${KEY}`, "api-key": KEY, code: 401 }, 401);
    const state = await checkConnectorCredential(connector, KEY, { fetchImpl: answering(echo).fetchImpl });
    assert.ok(["verified", "rejected", "unreachable"].includes(state), connector);
    assert.ok(!String(state).includes(KEY), connector);
  }
  // A huge body is not read to the end.
  const huge = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32 * 1024)); } }), { status: 200 });
  assert.equal(await checkConnectorCredential("evimed-evidence", KEY, { fetchImpl: answering(huge).fetchImpl }), "unreachable");
});
