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
  GEO_PROBE_GATEWAY_PATH,
} from "../src/geoProbeGateway.mjs";

const runtimeManager = { assertActiveModelGatewayToken() {} };
const rejectingRuntimeManager = {
  assertActiveModelGatewayToken() {
    throw new Error("no such token");
  },
};

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
  const handler = createGeoProbeGatewayHandler(config, options?.runtimeManager ?? runtimeManager, { fetchImpl });
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
  const res = await run({ geoProbeUrl: "http://43.248.117.249:9999" }, async () => jsonResponse({}), { op: "providers" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "geo_probe_plaintext_forbidden");

  const accepted = await run(
    { geoProbeUrl: "http://43.248.117.249:9999", geoProbeAllowPlaintext: true },
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
    { geoProbeUrl: "http://43.248.117.249:9999", geoProbeAllowPlaintext: true },
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
  for (const host of ["43.248.117.249", "8.8.8.8", "172.32.0.1", "172.15.0.1", "example.com", "probe.evimed.com"]) {
    assert.equal(isPrivateHost(host), false, `${host} is public`);
  }
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
