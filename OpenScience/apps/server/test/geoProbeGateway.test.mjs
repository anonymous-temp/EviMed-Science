// The GEO probe is the only channel whose product is a number rather than a
// document, which changes what its failures cost. A source fetch that fails is
// a missing citation somebody notices. A probe that fails and gets recorded is
// a visibility figure that is simply wrong, and it looks exactly like a
// correct one — so most of what is asserted here is that the gateway keeps
// "did not measure" and "measured nothing" apart on every path.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  createGeoProbeGatewayHandler,
  verifyProbeSignature,
  isPrivateHost,
  GEO_PROBE_CALLS_PER_MINUTE,
  GEO_PROBE_GATEWAY_PATH,
} from "../src/geoProbeGateway.mjs";
import { geoAudienceAllows } from "../src/geoService.mjs";

// The token names the account and the project, as the real model gateway's does.
const TOKENS = {
  "runtime-token": { userId: "alice", projectId: "p-geo" },
  "token-other-project": { userId: "alice", projectId: "p-other" },
  "token-bob": { userId: "bob", projectId: "p-bob" },
};
const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    const identity = TOKENS[token];
    if (!identity) throw new Error("no such token");
    return identity;
  },
};
const rejectingRuntimeManager = {
  assertActiveModelGatewayToken() {
    throw new Error("no such token");
  },
};

/** The GEO module as the gateway needs it: only whether this account may use it, decided as the real service does. */
const geoDouble = (config) => ({ service: { allows: (user) => geoAudienceAllows(config, user) } });
/** A deployment whose module is on and open to every account, under whatever the test is about. */
const moduleOn = { geoEnabled: true, geoAudience: "all", operatorUsers: [], geoPreviewUsers: [] };

function request(body, { method = "POST", path = GEO_PROBE_GATEWAY_PATH, token = "runtime-token" } = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const stream = (async function* () {
    if (payload) yield Buffer.from(payload, "utf8");
  })();
  return {
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  };
}

function response() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) chunks.push(chunk);
      this.body = Buffer.concat(chunks).toString("utf8");
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
    text: async () => body,
    body: { cancel: async () => {} },
  };
}

function binaryResponse(bytes, { status = 200, contentType = "image/png" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.length) }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    body: { cancel: async () => {} },
  };
}

async function run(config, fetchImpl, body, options) {
  const effective = { ...moduleOn, ...config };
  const geo = options && "geo" in options ? options.geo : geoDouble(effective);
  const handler = createGeoProbeGatewayHandler(effective, options?.runtimeManager ?? runtimeManager, { fetchImpl, geo });
  const res = response();
  await handler(request(body, options), res, options?.onFailure);
  return res;
}

const configured = { geoProbeUrl: "http://geo-probe.internal:9999/", geoProbeTimeoutMs: 5_000 };

const answered = {
  status: "ok",
  answer: "速效救心丸不建议长期连续服用[1]。",
  search_results: [{ title: "说明书", url: "https://example.org/label" }],
  screenshot_url: "http://geo-probe.internal:9999/screenshots/run-1.png",
  latency_ms: 14_700,
};

// ---------------------------------------------------------------- happy path

test("an answered probe returns the answer, its surface, and a digest of what arrived", async () => {
  let requested = null;
  let init = null;
  const res = await run(configured, async (url, options) => {
    requested = url;
    init = options;
    return jsonResponse({ results: [{ provider: "deepseek", ...answered }] });
  }, { op: "ask", question: "速效救心丸可以长期服用吗？", providers: ["deepseek"], deep: 1 });

  assert.equal(res.statusCode, 200);
  const { data, measurement, integrity } = res.json();
  assert.equal(measurement, "ok");
  assert.equal(requested.pathname, "/ask");
  assert.deepEqual(JSON.parse(init.body), {
    question: "速效救心丸可以长期服用吗？",
    providers: ["deepseek"],
    deep: 1,
    new_chat: 1,
  });
  assert.deepEqual(data.surface, { mode: "deep", session: "new_chat" });
  assert.deepEqual(data.inDenominator, ["deepseek"]);
  assert.equal(data.results[0].answerDigest.length, 64);
  assert.equal(integrity.responseDigest.length, 64);
});

test("new_chat defaults to 1, because a warm chat measures the conversation and not the question", async () => {
  let init = null;
  await run(configured, async (_url, options) => {
    init = options;
    return jsonResponse({ results: [{ provider: "kimi", ...answered }] });
  }, { op: "ask", question: "长期服用安全吗", providers: ["kimi"] });
  assert.equal(JSON.parse(init.body).new_chat, 1);
});

// ------------------------------------------- a failure is not a measurement

test("a vendor that did not answer is excluded from the denominator and named as a failure", async () => {
  const res = await run(configured, async () => jsonResponse({
    results: [
      { provider: "deepseek", ...answered },
      { provider: "kimi", status: "error", answer: "", error: "会话失效" },
    ],
  }), { op: "ask", question: "长期服用安全吗", providers: ["deepseek", "kimi"] });

  const { data, warnings } = res.json();
  assert.deepEqual(data.inDenominator, ["deepseek"]);
  const kimi = data.results.find((row) => row.provider === "kimi");
  assert.equal(kimi.inDenominator, false);
  assert.equal(kimi.measurement, "failed");
  assert.match(kimi.error, /会话失效/);
  assert.ok(warnings.some((line) => /must not enter the denominator or be cached/.test(line)));
});

test("an empty answer with status ok is a measurement; an empty answer with an error is not", async () => {
  // These two are byte-identical in `answer`. If the gateway keyed on the text
  // rather than the status, a vendor outage would be recorded as a vendor that
  // has nothing to say about the brand — which is the finding, inverted.
  const measured = await run(configured, async () => jsonResponse({
    results: [{ provider: "doubao", status: "ok", answer: "" }],
  }), { op: "ask", question: "q", providers: ["doubao"] });
  const failed = await run(configured, async () => jsonResponse({
    results: [{ provider: "doubao", status: "busy", answer: "", error: "服务繁忙" }],
  }), { op: "ask", question: "q", providers: ["doubao"] });

  assert.equal(measured.json().data.results[0].inDenominator, true);
  assert.equal(failed.json().data.results[0].inDenominator, false);
});

test("a busy probe is a retryable failure, not a vendor that declined to answer", async () => {
  // The upstream serves one request at a time and answers 409. Caching that as
  // a result makes a resumed batch replay the failure forever while the
  // progress bar advances.
  const res = await run(configured, async () => jsonResponse({ error: "busy" }, { status: 409 }),
    { op: "ask", question: "q", providers: ["deepseek"] });
  assert.equal(res.statusCode, 429);
  const body = res.json();
  assert.equal(body.code, "geo_probe_busy");
  assert.equal(body.measurement, "failed");
  assert.match(body.error, /retry, do not record it/i);
});

test("an unreachable probe reports a measurement failure rather than an empty result", async () => {
  const res = await run(configured, async () => {
    throw new Error("ECONNREFUSED");
  }, { op: "ask", question: "q", providers: ["deepseek"] });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, "geo_probe_unavailable");
  assert.equal(res.json().measurement, "failed");
});

test("a vendor that is not logged in is reported as not ready, not as silent", async () => {
  const res = await run(configured, async () => jsonResponse({
    providers: { deepseek: "tab_found", kimi: "no_tab" },
  }), { op: "providers" });
  const { data, warnings } = res.json();
  assert.deepEqual(data.ready, ["deepseek"]);
  assert.equal(data.providers.find((row) => row.provider === "kimi").ready, false);
  assert.ok(warnings.some((line) => /never asked/.test(line)));
});

test("the providers payload is accepted as a list as well as a map", async () => {
  const res = await run(configured, async () => jsonResponse([
    { name: "qianwen", status: "tab_found" },
    { name: "unknown-vendor", status: "tab_found" },
  ]), { op: "providers" });
  assert.deepEqual(res.json().data.ready, ["qianwen"]);
});

// -------------------------------------------------------- the closed surface

test("the runtime cannot ask for an operation this deployment does not do", async () => {
  for (const op of ["fetch", "screenshots", "", "ASK; DROP"]) {
    const res = await run(configured, async () => jsonResponse({}), { op });
    assert.equal(res.statusCode, 400, `op ${JSON.stringify(op)} should be refused`);
    assert.equal(res.json().code, "geo_probe_op_invalid");
  }
});

test("the runtime cannot name a vendor outside the closed set", async () => {
  const res = await run(configured, async () => jsonResponse({}), {
    op: "ask", question: "q", providers: ["deepseek", "chatgpt"],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, "geo_probe_provider_invalid");
});

test("a screenshot name cannot walk out of the screenshots directory", async () => {
  // Matched against a whole pattern rather than scanned for "..": a denylist
  // here is a traversal waiting for an encoding nobody thought of.
  for (const name of ["../../etc/passwd", "a/b.png", "%2e%2e%2fx.png", "run-1.png\n", "run-1.svg", ""]) {
    const res = await run(configured, async () => binaryResponse(Buffer.from("x")), { op: "screenshot", name });
    assert.equal(res.statusCode, 400, `name ${JSON.stringify(name)} should be refused`);
    assert.equal(res.json().code, "geo_probe_screenshot_name_invalid");
  }
});

test("a screenshot comes back with its digest and byte count, and the host never crosses back", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const res = await run(configured, async (url) => {
    assert.equal(url.pathname, "/screenshots/run-1.png");
    return binaryResponse(png);
  }, { op: "screenshot", name: "run-1.png" });
  const { data } = res.json();
  assert.equal(data.bytes, png.length);
  assert.equal(data.sha256.length, 64);
  assert.equal(Buffer.from(data.dataBase64, "base64").toString("hex"), png.toString("hex"));
});

test("an answer's screenshot crosses back as a name, never as a reachable URL", async () => {
  const res = await run(configured, async () => jsonResponse({ results: [{ provider: "deepseek", ...answered }] }),
    { op: "ask", question: "q", providers: ["deepseek"] });
  const row = res.json().data.results[0];
  assert.equal(row.screenshotName, "run-1.png");
  assert.equal(res.body.includes("geo-probe.internal"), false);
});

test("the gateway refuses anything but POST to its own path", async () => {
  const res = await run(configured, async () => jsonResponse({}), { op: "providers" }, { method: "GET" });
  assert.equal(res.statusCode, 404);
});

test("a request without a valid workload token never reaches the probe", async () => {
  let called = false;
  const res = await run(configured, async () => {
    called = true;
    return jsonResponse({});
  }, { op: "providers" }, { runtimeManager: rejectingRuntimeManager });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

// ----------------------------------------------------------------- transport

test("plaintext to a public address is refused unless the operator accepted it", async () => {
  const res = await run({ geoProbeUrl: "http://203.0.113.30:9999" }, async () => jsonResponse({}), { op: "providers" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "geo_probe_plaintext_forbidden");

  const accepted = await run(
    { geoProbeUrl: "http://203.0.113.30:9999", geoProbeAllowPlaintext: true },
    async () => jsonResponse({ providers: { deepseek: "tab_found" } }),
    { op: "providers" },
  );
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.json().integrity.transport, "plaintext");
});

test("plaintext to a private address is ordinary, because it never leaves the deployment", async () => {
  for (const url of ["http://127.0.0.1:9999", "http://10.1.2.3:9999", "http://geo-probe:9999", "http://192.168.1.9:9999"]) {
    const res = await run({ geoProbeUrl: url }, async () => jsonResponse({ providers: {} }), { op: "providers" });
    assert.equal(res.statusCode, 200, `${url} should be allowed`);
  }
});

test("an unauthenticated plaintext measurement says so in the answer", async () => {
  // Silence here would be the whole defect: a number that crossed an
  // unprotected hop reads identically to one that did not.
  const res = await run(
    { geoProbeUrl: "http://203.0.113.30:9999", geoProbeAllowPlaintext: true },
    async () => jsonResponse({ results: [{ provider: "deepseek", ...answered }] }),
    { op: "ask", question: "q", providers: ["deepseek"] },
  );
  const { warnings, integrity } = res.json();
  assert.equal(integrity.signed, false);
  assert.ok(warnings.some((line) => /unauthenticated plaintext hop/.test(line)));
});

test("a configured secret signs the outbound call and the signature verifies", async () => {
  let headers = null;
  let body = null;
  const secret = "probe-signing-secret";
  await run(
    { ...configured, geoProbeSigningSecret: secret },
    async (_url, options) => {
      headers = options.headers;
      body = options.body;
      return jsonResponse({ results: [{ provider: "deepseek", ...answered }] });
    },
    { op: "ask", question: "q", providers: ["deepseek"] },
  );
  assert.ok(headers["x-evimed-signature"]);
  assert.equal(
    verifyProbeSignature(secret, {
      method: "POST",
      path: "/ask",
      body,
      timestamp: headers["x-evimed-timestamp"],
      signature: headers["x-evimed-signature"],
    }),
    true,
  );
});

test("a signature does not verify against a different secret, a changed body, or a stale clock", async () => {
  // Without these three the signing is decoration: it would pass its own happy
  // path while accepting anything.
  let headers = null;
  let body = null;
  const secret = "probe-signing-secret";
  await run(
    { ...configured, geoProbeSigningSecret: secret },
    async (_url, options) => {
      headers = options.headers;
      body = options.body;
      return jsonResponse({ results: [{ provider: "deepseek", ...answered }] });
    },
    { op: "ask", question: "q", providers: ["deepseek"] },
  );
  const base = { method: "POST", path: "/ask", body, timestamp: headers["x-evimed-timestamp"], signature: headers["x-evimed-signature"] };
  assert.equal(verifyProbeSignature("another-secret", base), false);
  assert.equal(verifyProbeSignature(secret, { ...base, body: `${body} ` }), false);
  assert.equal(verifyProbeSignature(secret, { ...base, path: "/providers" }), false);
  assert.equal(verifyProbeSignature("", base), false);
});

test("a correctly signed request from ten minutes ago is still refused", () => {
  // Moving the timestamp on an existing signature proves nothing: it changes
  // the signature too, so the call fails for the wrong reason and the age
  // check can be deleted with this test still green — which is exactly what a
  // mutation run showed. A replay has to be signed properly *for the old
  // time*, which is what an attacker holding a captured request has.
  const secret = "probe-signing-secret";
  const body = JSON.stringify({ question: "q", providers: ["deepseek"], deep: 0, new_chat: 1 });
  const sign = (timestamp) => createHmac("sha256", secret)
    .update(`${timestamp}\nPOST\n/ask\n${createHash("sha256").update(body).digest("hex")}`)
    .digest("hex");

  const now = String(Date.now());
  assert.equal(verifyProbeSignature(secret, { method: "POST", path: "/ask", body, timestamp: now, signature: sign(now) }), true);

  const stale = String(Date.now() - 600_000);
  assert.equal(
    verifyProbeSignature(secret, { method: "POST", path: "/ask", body, timestamp: stale, signature: sign(stale) }),
    false,
    "a valid signature from outside the window must not be replayable",
  );
});

test("an unconfigured deployment says the channel is absent instead of returning nothing", async () => {
  const res = await run({}, async () => jsonResponse({}), { op: "providers" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "geo_probe_unconfigured");
  assert.equal(res.json().measurement, "failed");
});

test("isPrivateHost knows the ranges that make plaintext acceptable", () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "169.254.1.1", "localhost", "geo-probe", "db.internal", "::1"]) {
    assert.equal(isPrivateHost(host), true, `${host} is private`);
  }
  for (const host of ["203.0.113.30", "8.8.8.8", "172.32.0.1", "172.15.0.1", "example.com", "probe.evimed.com"]) {
    assert.equal(isPrivateHost(host), false, `${host} is public`);
  }
});

test("isPrivateHost reads the IPv6 ranges as addresses, not a host name that starts with fd (Q-14)", () => {
  // `host.startsWith("fd")` was meant for the unique-local range fd00::/8 and also took every name beginning with those letters,
  // so a plaintext hop to a public host such as fda.gov passed the rule that exists to refuse one.
  for (const host of ["fda.gov", "fdic.gov", "fd.example.com", "fdroid.org", "fe80.example.com", "fc.example.com", "fdnet"]) {
    assert.equal(isPrivateHost(host), host === "fdnet", `${host} is ${host === "fdnet" ? "a bare internal name" : "public"}`);
  }
  // The URL parser hands an IPv6 literal over in brackets; both forms are the same address.
  for (const host of ["::1", "[::1]", "fd00::1", "[fd12:3456:789a::1]", "fc00::1", "[fe80::1]", "[febf::1]"]) {
    assert.equal(isPrivateHost(host), true, `${host} is loopback, unique-local or link-local`);
  }
  for (const host of ["[2001:db8::1]", "2001:db8::1", "[fec0::1]", "[2a00:1450::1]"]) {
    assert.equal(isPrivateHost(host), false, `${host} is a routable address`);
  }
  // And it is what the origin check sees: http to a public name starting with fd is refused, to a unique-local literal is not.
  assert.equal(new URL("http://[fd00::1]:9999").hostname, "[fd00::1]");
});

test("plaintext to a public host whose name starts with fd is refused, to a unique-local address is ordinary (Q-14)", async () => {
  const refused = await run({ geoProbeUrl: "http://fda.gov:9999" }, async () => jsonResponse({}), { op: "providers" });
  assert.deepEqual([refused.statusCode, refused.json().code], [503, "geo_probe_plaintext_forbidden"]);
  const ordinary = await run({ geoProbeUrl: "http://[fd00::1]:9999" }, async () => jsonResponse({ providers: {} }), { op: "providers" });
  assert.equal(ordinary.statusCode, 200);
});

test("every failure path carries measurement:failed, so no caller can read one as an empty result", async () => {
  const cases = [
    [{ op: "nope" }, configured, async () => jsonResponse({})],
    [{ op: "ask", question: "", providers: ["deepseek"] }, configured, async () => jsonResponse({})],
    [{ op: "screenshot", name: "../x.png" }, configured, async () => jsonResponse({})],
    [{ op: "providers" }, {}, async () => jsonResponse({})],
    [{ op: "providers" }, configured, async () => jsonResponse({}, { status: 500 })],
    [{ op: "providers" }, configured, async () => jsonResponse("not-an-object", { status: 200 })],
  ];
  for (const [body, config, fetchImpl] of cases) {
    const res = await run(config, fetchImpl, body);
    assert.equal(res.json().measurement, "failed", `${JSON.stringify(body)} must be marked as a failure`);
  }
});

test("gateway failures reach the operator ledger with a geo_probe code", async () => {
  const failures = [];
  await run(configured, async () => jsonResponse({}, { status: 409 }), { op: "ask", question: "q", providers: ["deepseek"] }, {
    onFailure: (failure) => failures.push(failure),
  });
  assert.deepEqual(failures.map((row) => row.code), ["geo_probe_busy"]);
});

// ------------------------------------------- who may use the probe (Q-8)
//
// The gateway used to accept any active runtime token and forward it to the
// probe host, which serves one request at a time for up to six minutes and
// drives the platform's logged-in consumer-AI accounts. The same token that
// opens the GEO gateway now has to belong to an account the module is open to.

test("a module that is off, or not open to the account, never reaches the probe", async () => {
  let reached = 0;
  const upstream = async () => {
    reached += 1;
    return jsonResponse({ providers: { deepseek: "tab_found" } });
  };
  const refused = async (config, options) => {
    const res = await run(config, upstream, { op: "providers" }, options);
    assert.deepEqual([res.statusCode, res.json().code, res.json().measurement], [503, "geo_probe_disabled", "failed"], JSON.stringify([config, Object.keys(options ?? {})]));
  };
  await refused({ ...configured, geoEnabled: false });
  await refused(configured, { geo: null });
  await refused({ ...configured, geoAudience: "operators" });
  await refused({ ...configured, geoAudience: "operators", operatorUsers: ["bob"] });
  assert.equal(reached, 0, "a refused account never put a question to a vendor");

  // The ones the module is open to are served: an operator, a preview user, everyone when it is open to all.
  for (const config of [
    { ...configured, geoAudience: "operators", operatorUsers: ["alice"] },
    { ...configured, geoAudience: "operators", geoPreviewUsers: ["alice"] },
    configured,
  ]) assert.equal((await run(config, upstream, { op: "providers" })).statusCode, 200);
  assert.equal(reached, 3);
});

test("the admission is checked after the token and before the request is read", async () => {
  // A forged token is a 401 whatever the module says, and a closed account is refused without its body being looked at:
  // a malformed request from an account the module is not open to reads "disabled", not "invalid".
  const closed = { ...configured, geoEnabled: false };
  const forged = await run(closed, async () => jsonResponse({}), { op: "providers" }, { runtimeManager: rejectingRuntimeManager });
  assert.equal(forged.statusCode, 401);
  const malformed = await run(closed, async () => jsonResponse({}), { op: "fetch" });
  assert.deepEqual([malformed.statusCode, malformed.json().code], [503, "geo_probe_disabled"]);
  // Open, the same body is the run's own mistake.
  assert.equal((await run(configured, async () => jsonResponse({}), { op: "fetch" })).json().code, "geo_probe_op_invalid");
});

test("a project's runtime is held to a window of calls a minute, and each project has its own", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const config = { ...moduleOn, ...configured, geoProbeCallsPerMinute: 3 };
  let reached = 0;
  const failures = [];
  const handler = createGeoProbeGatewayHandler(config, runtimeManager, {
    fetchImpl: async () => {
      reached += 1;
      return jsonResponse({ providers: { deepseek: "tab_found" } });
    },
    geo: geoDouble(config),
  });
  const call = async (token, body = { op: "providers" }) => {
    const res = response();
    await handler(request(body, { token }), res, (failure) => failures.push(failure));
    return res;
  };
  for (let index = 0; index < 3; index += 1) assert.equal((await call("runtime-token")).statusCode, 200, `call ${index + 1}`);
  const over = await call("runtime-token", { op: "ask", question: "q", providers: ["deepseek"] });
  assert.deepEqual([over.statusCode, over.json().code, over.json().measurement], [429, "geo_probe_gateway_rate_limited", "failed"]);
  assert.equal(reached, 3, "the call over the window never reached the probe host");
  assert.deepEqual(failures.map((failure) => failure.code), ["geo_probe_gateway_rate_limited"], "the refusal reaches the operator's ledger by its code");

  // Another conversation of the same account, and another account, are not held by it.
  assert.equal((await call("token-other-project")).statusCode, 200);
  assert.equal((await call("token-bob")).statusCode, 200);

  // The window is a minute.
  t.mock.timers.tick(60_001);
  assert.equal((await call("runtime-token")).statusCode, 200);
  assert.equal(reached, 6);
});

test("without a configured window the default holds, and the default is the config's", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const config = { ...moduleOn, ...configured };
  const handler = createGeoProbeGatewayHandler(config, runtimeManager, { fetchImpl: async () => jsonResponse({ providers: {} }), geo: geoDouble(config) });
  let served = 0;
  for (let index = 0; index < 40; index += 1) {
    const res = response();
    await handler(request({ op: "providers" }), res);
    if (res.statusCode === 200) served += 1;
  }
  assert.equal(served, GEO_PROBE_CALLS_PER_MINUTE);
});
