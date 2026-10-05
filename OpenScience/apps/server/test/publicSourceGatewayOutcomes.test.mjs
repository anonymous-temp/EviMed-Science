import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http, { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recoverableEvidenceSourceErrorCodes } from "@evimed/domain";
import { createPublicSourceGatewayHandler, PUBLIC_SOURCE_DOWNLOAD_KINDS, retryAfterSecondsOf } from "../src/publicSourceGateway.mjs";

// How the gateway tells a runtime that a source refused, stalled, rate limited
// it or was down (plan section 5.7), and the two modes that read what a run
// preserves and what a source builds slowly: the named download and the hand-off
// to source intake. The upstream shapes were recorded from the live wire on
// 2026-10-04: the NCBI ID converter answers 429 as HTML with no Retry-After,
// Europe PMC streams a supplementary zip 33 s to the first byte, and
// Europe PMC answers "not open access" and "no supplementary files" as small XML
// with status 200.

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  server.close();
  await once(server, "close");
}

const runtimeManager = {
  assertActiveModelGatewayToken(token) {
    if (token !== "runtime-token") throw new Error("invalid token");
    return { userId: "alice", projectId: "paper-1" };
  },
};

const gatewayRequest = (base, body) => fetch(`${base}/internal/sources/v1/fetch`, {
  method: "POST",
  headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const idconv = { url: "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=1&format=json", accept: ["application/json"] };

async function serve(t, config, options) {
  const failures = [];
  const handler = createPublicSourceGatewayHandler(config, runtimeManager, options);
  // A request to any other path is not this test's: the workspace's port scanner probes
  // ephemeral listeners with a GET, which the gateway answers `not_found`.
  const server = createServer((req, res) => handler(req, res, (failure) => { if (failure.code !== "not_found") failures.push(failure); }));
  const base = await listen(server);
  t.after(() => close(server));
  return { base, failures };
}

test("a source's Retry-After reaches the runtime as a header and as a number it can act on", async (t) => {
  const { base, failures } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async () => new Response("<html>429</html>", { status: 429, headers: { "content-type": "text/html", "retry-after": "7" } }),
  });
  const response = await gatewayRequest(base, idconv);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  const { error } = await response.json();
  assert.deepEqual(
    [error.code, error.retryAfterSeconds, error.upstreamStatus],
    ["public_source_gateway_rate_limited", 7, 429],
  );
  assert.deepEqual(failures.map((failure) => failure.upstream), [{ host: "pmc.ncbi.nlm.nih.gov", status: 429 }]);
});

test("a 429 with no Retry-After says nothing about a wait (the live ID converter sent none)", async (t) => {
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async () => new Response("<html>429</html>", { status: 429, headers: { "content-type": "text/html" } }),
  });
  const response = await gatewayRequest(base, idconv);
  assert.equal(response.headers.get("retry-after"), null);
  const { error } = await response.json();
  assert.equal("retryAfterSeconds" in error, false, "an absent hint is absent, never a guess");
});

test("a server error that names a wait passes it on, and an HTTP date becomes seconds", async (t) => {
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async () => new Response("busy", { status: 503, headers: { "content-type": "text/plain", "retry-after": "30" } }),
  });
  const response = await gatewayRequest(base, idconv);
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.deepEqual([error.code, error.retryAfterSeconds], ["public_source_gateway_upstream_error", 30]);
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.equal(retryAfterSecondsOf("Sun, 04 Oct 2026 12:00:45 GMT", now), 45);
  assert.equal(retryAfterSecondsOf("Sun, 04 Oct 2026 11:00:00 GMT", now), 0);
  assert.equal(retryAfterSecondsOf("999999"), 3600);
  assert.equal(retryAfterSecondsOf("soon"), null);
  assert.equal(retryAfterSecondsOf(null), null);
});

test("a source that refuses is named apart from one that is down", async (t) => {
  for (const status of [401, 403]) {
    const { base, failures } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
      fetchImpl: async () => new Response("no", { status, headers: { "content-type": "text/plain" } }),
    });
    const response = await gatewayRequest(base, idconv);
    // The HTTP status is the one the runtime has always seen for a refused request;
    // the code is what says it was the source that refused.
    assert.equal(response.status, 400, `HTTP ${status}`);
    const { error } = await response.json();
    assert.deepEqual([error.code, error.upstreamStatus], ["public_source_gateway_upstream_denied", status]);
    assert.equal(failures[0].code, "public_source_gateway_upstream_denied");
  }
});

test("a source that answers and then stalls is a timeout, not an unavailable source", async (t) => {
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async (_url, { signal }) => {
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"partial"')); },
        pull() { return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const started = Date.now();
  const response = await gatewayRequest(base, idconv);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "public_source_gateway_timeout");
  assert.ok(Date.now() - started < 4_000, "the one deadline ended it");
});

test("every code the gateway now emits for a refusal, a stall or a rate limit is classified recoverable", () => {
  for (const code of [
    "public_source_gateway_upstream_denied", "public_source_gateway_timeout",
    "public_source_gateway_rate_limited", "public_source_gateway_upstream_error",
  ]) assert.ok(recoverableEvidenceSourceErrorCodes.has(code), code);
});

// ---------------------------------------------------------------- named downloads

const pmcid = "PMC6454835";
const supplementsUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/supplementaryFiles`;

function rawPost(base, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/internal/sources/v1/fetch`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-token", "content-type": "application/json" },
    }, (response) => {
      const chunks = [];
      let aborted = false;
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("aborted", () => { aborted = true; });
      response.on("error", () => { aborted = true; });
      response.on("close", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), complete: response.complete && !aborted }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

const stream = (pieces, { stall = false } = {}) => (_url, { signal } = {}) => {
  let index = 0;
  return Promise.resolve(new Response(new ReadableStream({
    pull(controller) {
      if (index < pieces.length) { controller.enqueue(pieces[index++]); return undefined; }
      if (!stall) { controller.close(); return undefined; }
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  }), { status: 200, headers: { "content-type": "application/zip" } }));
};

test("a download is relayed as it arrives, and the runtime names a kind and its identifiers, never an address", async (t) => {
  const seen = [];
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000 }, {
    fetchImpl: async (url, options) => { seen.push({ url: String(url), accept: options.headers.accept, redirect: options.redirect }); return stream([Buffer.from("PK\u0003\u0004one"), Buffer.from("two")])(url, options); },
  });
  const result = await rawPost(base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/zip");
  assert.equal(result.headers["x-evimed-download-kind"], "epmc-supplements");
  assert.equal(result.body.toString("latin1"), "PK\u0003\u0004onetwo");
  assert.equal(result.complete, true);
  assert.deepEqual(seen, [{ url: supplementsUrl, accept: "application/zip, application/xml", redirect: "error" }]);
  assert.equal(seen.length, 1);

  const spl = await rawPost(base, { download: { kind: "dailymed-spl-zip", setid: "5E81B4A7-B971-45E1-9C31-29CEA8C87CE7", version: 36 } });
  assert.equal(spl.status, 200);
  assert.equal(seen[1].url, "https://dailymed.nlm.nih.gov/dailymed/getFile.cfm?setid=5e81b4a7-b971-45e1-9c31-29cea8c87ce7&type=zip&version=36");
});

test("a download request that names anything but a known kind and exactly its identifiers is refused before any fetch", async (t) => {
  let fetches = 0;
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => { fetches += 1; return new Response("x"); } });
  for (const download of [
    { kind: "epmc-supplements", pmcid: "PMC1", url: "https://evil.example/" },
    { kind: "epmc-supplements", pmcid: "6454835" },
    { kind: "epmc-supplements", pmcid: "PMC6454835/../../x" },
    { kind: "epmc-supplements" },
    { kind: "dailymed-spl-zip", setid: "not-a-uuid", version: 3 },
    { kind: "dailymed-spl-zip", setid: "5e81b4a7-b971-45e1-9c31-29cea8c87ce7", version: 0 },
    { kind: "dailymed-spl-zip", setid: "5e81b4a7-b971-45e1-9c31-29cea8c87ce7", version: "36" },
    { kind: "arbitrary", url: "https://dailymed.nlm.nih.gov/" },
  ]) {
    const response = await gatewayRequest(base, { download });
    assert.equal(response.status, 400, JSON.stringify(download));
    assert.equal((await response.json()).error.code, "public_source_gateway_field_invalid");
  }
  assert.equal((await gatewayRequest(base, { download: { kind: "epmc-supplements", pmcid }, url: "https://www.ebi.ac.uk/" })).status, 400);
  assert.equal(fetches, 0);
});

test("a download's own length is passed on, so the runtime can tell a whole body from one cut short", async (t) => {
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000 }, {
    fetchImpl: async () => new Response(Buffer.from("PKabcdef"), { status: 200, headers: { "content-type": "application/zip", "content-length": "8" } }),
  });
  const result = await rawPost(base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(result.headers["content-length"], "8");
});

test("a download past the byte bound ends on the wire and is counted, never relayed as a whole file", async (t) => {
  const { base, failures } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 2_000, publicSourceGatewayMaxResponseBytes: 4096 }, {
    fetchImpl: stream([Buffer.alloc(3000, 1), Buffer.alloc(3000, 2), Buffer.alloc(3000, 3)]),
  });
  const result = await rawPost(base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(result.complete, false, "the response ended without its terminator");
  assert.ok(result.body.length <= 4096 + 3000, "no more than the bound plus the chunk that crossed it left the gateway");
  assert.deepEqual(failures.map((failure) => [failure.code, failure.truncated]), [["public_source_gateway_response_too_large", true]]);
});

test("a download that declares more than the bound is refused before a byte is relayed", async (t) => {
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceGatewayMaxResponseBytes: 4096 }, {
    fetchImpl: async () => new Response("x", { status: 200, headers: { "content-type": "application/zip", "content-length": "99999" } }),
  });
  const response = await gatewayRequest(base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "public_source_gateway_response_too_large");
});

test("a download that stalls past the deadline is cut short on the wire, and one that never answers is a 504", async (t) => {
  const { base, failures } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 300 }, {
    fetchImpl: stream([Buffer.from("PK-first-entry")], { stall: true }),
  });
  const stalled = await rawPost(base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(stalled.complete, false);
  assert.ok(stalled.body.toString().startsWith("PK-first-entry"), "what arrived before the deadline reached the runtime");
  assert.deepEqual(failures.map((failure) => [failure.code, failure.truncated]), [["public_source_gateway_timeout", true]]);

  const silent = await serve(t, { publicSourceGatewayTimeoutMs: 1_000, publicSourceDownloadTimeoutMs: 300 }, {
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  const response = await gatewayRequest(silent.base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "public_source_gateway_timeout");
});

test("Europe PMC's small XML answers (not open access, no supplementary files) are relayed for the runtime to read", async (t) => {
  const errorBean = '<?xml version="1.0"?><ns4:errorBean><errCode>0</errCode><errMsg>Article with id PMC6533834 is not open access one</errMsg></ns4:errorBean>';
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async () => new Response(errorBean, { status: 200, headers: { "content-type": "application/xml" } }),
  });
  const result = await rawPost(base, { download: { kind: "epmc-supplements", pmcid: "PMC6533834" } });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/xml");
  assert.equal(result.body.toString(), errorBean);
  // DailyMed has no small answer: a page is not a label.
  const html = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    fetchImpl: async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  const refused = await gatewayRequest(html.base, { download: { kind: "dailymed-spl-zip", setid: "5e81b4a7-b971-45e1-9c31-29cea8c87ce7", version: 2 } });
  assert.equal(refused.status, 502);
  assert.equal((await refused.json()).error.code, "public_source_gateway_response_invalid");
});

test("a download the source refuses is told as a refusal, a missing one as a 404", async (t) => {
  const denied = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => new Response("no", { status: 403 }) });
  const refused = await gatewayRequest(denied.base, { download: { kind: "epmc-supplements", pmcid } });
  assert.equal((await refused.json()).error.code, "public_source_gateway_upstream_denied");
  const missing = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal((await gatewayRequest(missing.base, { download: { kind: "epmc-supplements", pmcid } })).status, 404);
});

test("the download kinds the gateway serves are the ones the runtime's transport names", () => {
  const source = fs.readFileSync(path.resolve(
    fileURLToPath(new URL(".", import.meta.url)), "../../../runtime/mcp/evimed-research/source_transport.py",
  ), "utf8");
  const named = [...source.matchAll(/^\s+"([a-z0-9-]+)": \{"direct":/gm)].map((match) => match[1]).sort();
  assert.deepEqual(named, [...PUBLIC_SOURCE_DOWNLOAD_KINDS].sort());
});

test("every request the gateway refuses itself is one the runtime's transport words as the deployment's, never the source's", () => {
  // 2026-10-05: a gateway refusal and a source's 4xx both reached the runtime as HTTP 400 and were worded
  // "the source rejected the request as invalid", which sent a model to blame a source that never saw the request.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const python = fs.readFileSync(path.resolve(here, "../../../runtime/mcp/evimed-research/source_transport.py"), "utf8");
  const listed = (name) => {
    const block = python.match(new RegExp(`^${name} = frozenset\\(\\{([^}]*)\\}\\)`, "m"));
    assert.ok(block, `${name} is declared in source_transport.py`);
    return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  };
  const named = [...listed("GATEWAY_INVALID_REQUEST_CODES"), ...listed("GATEWAY_FORBIDDEN_REQUEST_CODES")].sort();
  const gateway = fs.readFileSync(path.resolve(here, "../src/publicSourceGateway.mjs"), "utf8");
  // The 4xx codes the gateway raises about the request it was handed. The web-read mode's own codes belong to that
  // mode, a credential nobody configured is read through `_not_configured_from_failure`, and 404 is an answer.
  const raised = [...new Set([...gateway.matchAll(/gatewayError\(\s*(4\d\d),\s*"([a-z_0-9]+)"/g)]
    .filter((match) => match[1] !== "404" && !match[2].startsWith("web_read_"))
    .map((match) => match[2]))].sort();
  assert.deepEqual(raised.filter((code) => !named.includes(code)), [], "a gateway refusal the transport would word as the source's");
  assert.deepEqual(named.filter((code) => !raised.includes(code)), [], "a code the transport lists that the gateway no longer raises");
});

// ---------------------------------------------------------------- the hand-off to source intake

test("a hand-off to source intake is taken for the project the runtime's token names, whatever the request says", async (t) => {
  const calls = [];
  const { base } = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    sourceIntake: async (request) => { calls.push(request); return { results: [{ path: request.files[0], registered: true }] }; },
  });
  const response = await gatewayRequest(base, { sourceIntake: { group: "PMC6454835", files: [".evimed-sources/PMC6454835/supplements/" + "a".repeat(64) + "/Data_Sheet_1.PDF"] } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map((entry) => entry.registered), [true]);
  assert.deepEqual(calls[0].identity, { userId: "alice", projectId: "paper-1" });
  assert.equal(calls[0].group, "PMC6454835");

  for (const body of [
    { sourceIntake: { group: "g", files: ["x"], projectId: "someone-elses" } },
    { sourceIntake: { files: ["x"] } },
    { sourceIntake: { group: "g" } },
    { sourceIntake: { group: "g", files: ["x"] }, url: "https://api.crossref.org/works" },
  ]) {
    const refused = await gatewayRequest(base, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 1);
});

test("a hand-off's own refusal is worded as a malformed request, and a deployment without intake says so", async (t) => {
  const refusing = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {
    sourceIntake: async () => { throw Object.assign(new Error("Hand over between 1 and 40 preserved files."), { status: 400, code: "source_intake_files_invalid" }); },
  });
  const refused = await gatewayRequest(refusing.base, { sourceIntake: { group: "g", files: [] } });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "public_source_gateway_field_invalid");
  const broken = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, { sourceIntake: async () => { throw new Error("database down"); } });
  const unavailable = await gatewayRequest(broken.base, { sourceIntake: { group: "g", files: ["x"] } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "public_source_gateway_unavailable");
  const none = await serve(t, { publicSourceGatewayTimeoutMs: 1_000 }, {});
  const absent = await gatewayRequest(none.base, { sourceIntake: { group: "g", files: ["x"] } });
  assert.equal(absent.status, 503);
});
