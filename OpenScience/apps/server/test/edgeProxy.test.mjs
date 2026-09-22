// The Tokyo node carries only what Beijing is refused, and a node outage costs
// the routed hosts their workaround, never the platform its reads. These tests
// run a real CONNECT proxy on loopback (plain TCP: an `http:` proxy URL is the
// test form of the production `https:` one) so the tunnel, the credentials and
// the fallbacks are exercised on the wire rather than asserted about stubs.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  EdgeProxyError,
  edgeFetch,
  edgeMetricFamilies,
  edgeProxyFromConfig,
  edgeStats,
  fetchWithEdge,
  openEdgeTunnel,
  routesThroughEdge,
} from "../src/edgeProxy.mjs";
import { webReadError, webTransportWithEdgeFallback } from "../src/webReadNetwork.mjs";

const CREDENTIALS = "evimed-beijing:not-a-real-secret";
const AUTHORIZATION = `Basic ${Buffer.from(CREDENTIALS).toString("base64")}`;

/** A loopback forward proxy: CONNECT tunnels and absolute-form HTTP, basic credentials required. */
async function startProxy() {
  const seen = [];
  const server = track(http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers["proxy-authorization"] });
    if (req.headers["proxy-authorization"] !== AUTHORIZATION) {
      res.writeHead(407, { "proxy-authenticate": "Basic realm=test" });
      res.end();
      return;
    }
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = http.request({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, agent: false, headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  }));
  server.on("connect", (req, socket, head) => {
    sockets.add(socket);
    seen.push({ method: "CONNECT", url: req.url, authorization: req.headers["proxy-authorization"] });
    if (req.headers["proxy-authorization"] !== AUTHORIZATION) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port), host, () => {
      sockets.add(upstream);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function startOrigin(handler) {
  const server = track(http.createServer(handler));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Tunnelled sockets outlive the HTTP server's own bookkeeping, so they are
// tracked and destroyed; keep-alive connections are closed with the server.
const sockets = new Set();
function track(server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
}
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  for (const socket of sockets) socket.destroy();
  server.close(() => resolve());
});

test("the node is configured only by a URL and user:password credentials, and routes only the hosts it names", () => {
  assert.equal(edgeProxyFromConfig({}), null);
  assert.equal(edgeProxyFromConfig({ edgeProxyUrl: "https://45.32.58.204" }), null, "no credentials, no node");
  assert.equal(edgeProxyFromConfig({ edgeProxyUrl: "https://45.32.58.204", edgeProxyCredentials: "no-colon" }), null);
  const withUserInfo = new URL("https://45.32.58.204");
  withUserInfo.username = "someone";
  withUserInfo.password = "something";
  assert.equal(edgeProxyFromConfig({ edgeProxyUrl: withUserInfo.href, edgeProxyCredentials: CREDENTIALS }), null, "credentials never ride in the URL");
  assert.equal(edgeProxyFromConfig({ edgeProxyUrl: "ftp://45.32.58.204", edgeProxyCredentials: CREDENTIALS }), null);
  const edge = edgeProxyFromConfig({ edgeProxyUrl: "https://45.32.58.204:443", edgeProxyCredentials: CREDENTIALS, edgeProxyHosts: " GTExPortal.org , api.omim.org,," });
  assert.equal(edge.authorization, AUTHORIZATION);
  assert.deepEqual([...edge.hosts], ["gtexportal.org", "api.omim.org"]);
  assert.equal(routesThroughEdge(edge, "gtexportal.org"), true);
  assert.equal(routesThroughEdge(edge, "eutils.ncbi.nlm.nih.gov"), false, "hosts that answer from Beijing stay direct");
  assert.equal(routesThroughEdge(null, "gtexportal.org"), false);
});

test("a CONNECT tunnel carries the request end to end and sends the credentials only to the proxy", async () => {
  const proxy = await startProxy();
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-proxy-auth-seen": String(Boolean(req.headers["proxy-authorization"])) });
    res.end("through the tunnel");
  });
  try {
    const edge = edgeProxyFromConfig({ edgeProxyUrl: proxy.url, edgeProxyCredentials: CREDENTIALS });
    const port = Number(new URL(origin.url).port);
    const socket = await openEdgeTunnel(edge, "127.0.0.1", port);
    const answer = await new Promise((resolve) => {
      let text = "";
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("end", () => {
        socket.destroy();
        resolve(text);
      });
      socket.write(`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    assert.match(answer, /^HTTP\/1\.1 200/);
    assert.match(answer, /through the tunnel/);
    assert.match(answer, /x-proxy-auth-seen: false/i, "the origin never sees the proxy credentials");
    assert.deepEqual(proxy.seen.at(-1), { method: "CONNECT", url: `127.0.0.1:${port}`, authorization: AUTHORIZATION });
  } finally {
    await close(proxy.server);
    await close(origin.server);
  }
});

test("a plain-HTTP target goes in absolute form and comes back as a WHATWG Response", async () => {
  const proxy = await startProxy();
  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, results: [{ url: "https://example.org/a" }] }));
  });
  try {
    const edge = edgeProxyFromConfig({ edgeProxyUrl: proxy.url, edgeProxyCredentials: CREDENTIALS });
    const response = await edgeFetch(edge, new URL(`${origin.url}/search?q=semaglutide&format=json`), { headers: { accept: "application/json" } });
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = JSON.parse(await response.text());
    assert.equal(body.path, "/search?q=semaglutide&format=json");
    assert.equal(proxy.seen.at(-1).url, `${origin.url}/search?q=semaglutide&format=json`);
  } finally {
    await close(proxy.server);
    await close(origin.server);
  }
});

test("wrong credentials are a refusal of the node, named as such", async () => {
  const proxy = await startProxy();
  const origin = await startOrigin((req, res) => res.end("never"));
  try {
    const edge = edgeProxyFromConfig({ edgeProxyUrl: proxy.url, edgeProxyCredentials: "evimed-beijing:wrong" });
    await assert.rejects(
      openEdgeTunnel(edge, "127.0.0.1", Number(new URL(origin.url).port)),
      (error) => error instanceof EdgeProxyError && error.code === "edge_proxy_refused" && error.status === 407,
    );
    await assert.rejects(
      edgeFetch(edge, new URL(`${origin.url}/search`)),
      (error) => error instanceof EdgeProxyError && error.status === 407,
    );
  } finally {
    await close(proxy.server);
    await close(origin.server);
  }
});

test("a routed host goes through the node; a node that cannot be reached sends it direct once", async () => {
  const before = { ...edgeStats };
  const direct = [];
  const directFetch = async (input) => {
    direct.push(String(input));
    return new Response("direct", { status: 200 });
  };
  // Nothing listens on this port: the node is down.
  const dead = net.createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = dead.address().port;
  await close(dead);
  const edge = edgeProxyFromConfig({ edgeProxyUrl: `http://127.0.0.1:${deadPort}`, edgeProxyCredentials: CREDENTIALS, edgeProxyHosts: "gtexportal.org" });
  const fetcher = fetchWithEdge(edge, directFetch);
  const other = await fetcher(new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi"));
  assert.equal(await other.text(), "direct");
  const routed = await fetcher(new URL("https://gtexportal.org/api/v2/dataset/tissueSiteDetail"));
  assert.equal(await routed.text(), "direct", "the node being down costs the workaround, not the read");
  assert.deepEqual(direct, ["https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi", "https://gtexportal.org/api/v2/dataset/tissueSiteDetail"]);
  assert.equal(edgeStats.requests - before.requests, 1, "only the routed host counts as a node request");
  assert.equal(edgeStats.failures - before.failures, 1);
  assert.equal(edgeStats.directFallbacks - before.directFallbacks, 1);
  const [family] = edgeMetricFamilies(edge);
  assert.equal(family.name, "open_science_edge_proxy_total");
  assert.deepEqual(edgeMetricFamilies(null), [], "no node, no metric");
});

test("an upstream's own refusal through the node is its answer, not a reason to go direct", async () => {
  const proxy = await startProxy();
  const origin = await startOrigin((req, res) => {
    res.writeHead(403);
    res.end("refused by the upstream");
  });
  try {
    const host = new URL(origin.url).hostname;
    const edge = edgeProxyFromConfig({ edgeProxyUrl: proxy.url, edgeProxyCredentials: CREDENTIALS, edgeProxyHosts: host });
    let directCalls = 0;
    const fetcher = fetchWithEdge(edge, async () => {
      directCalls += 1;
      return new Response("direct", { status: 200 });
    });
    const response = await fetcher(new URL(`${origin.url}/thing`));
    assert.equal(response.status, 403);
    assert.equal(directCalls, 0);
  } finally {
    await close(proxy.server);
    await close(origin.server);
  }
});

test("a web read refused from Beijing is read once more through the node; anything else is not", async () => {
  const ok = (status, text) => async () => ({ status, headers: {}, body: Buffer.from(text) });
  let edgeCalls = 0;
  const edge = async () => {
    edgeCalls += 1;
    return { status: 200, headers: {}, body: Buffer.from("from Tokyo") };
  };
  const request = { url: new URL("https://www.nice.org.uk/news"), headers: {}, maxBytes: 1024 };

  let transport = webTransportWithEdgeFallback(ok(403, "refused in Beijing"), edge);
  assert.equal(String((await transport(request)).body), "from Tokyo", "403 is the answer a regional block gives");

  transport = webTransportWithEdgeFallback(ok(200, "read in Beijing"), edge);
  edgeCalls = 0;
  assert.equal(String((await transport(request)).body), "read in Beijing");
  assert.equal(edgeCalls, 0, "a page Beijing reads never touches the node");

  transport = webTransportWithEdgeFallback(ok(404, "not found"), edge);
  assert.equal((await transport(request)).status, 404, "a 404 is the page's answer everywhere");

  transport = webTransportWithEdgeFallback(async () => {
    throw webReadError(502, "web_read_upstream_unavailable", "no connection", { retryable: true });
  }, edge);
  assert.equal(String((await transport(request)).body), "from Tokyo", "no connection from Beijing is what the node is for");

  transport = webTransportWithEdgeFallback(async () => {
    throw webReadError(502, "web_read_response_too_large", "too large");
  }, edge);
  await assert.rejects(transport(request), /too large/, "a page too large in Beijing is too large in Tokyo");

  transport = webTransportWithEdgeFallback(ok(403, "refused in Beijing"), async () => {
    throw webReadError(502, "web_read_upstream_unavailable", "node down", { retryable: true });
  });
  assert.equal((await transport(request)).status, 403, "when the node fails too, Beijing's own answer stands");
});

test("an unroutable host spends only the direct attempt's own deadline before the node is tried", async () => {
  const hang = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(webReadError(504, "web_read_timeout", "no answer", { retryable: true })), { once: true });
  });
  const transport = webTransportWithEdgeFallback(hang, async () => ({ status: 200, headers: {}, body: Buffer.from("from Tokyo") }), { directTimeoutMs: 1_000 });
  const started = Date.now();
  const result = await transport({ url: new URL("https://www.bbc.co.uk/news/health"), headers: {}, maxBytes: 1024 });
  assert.equal(String(result.body), "from Tokyo");
  assert.ok(Date.now() - started < 4_000, "the direct attempt gave up at its own deadline");

  const caller = new AbortController();
  const aborting = webTransportWithEdgeFallback(hang, async () => {
    throw new Error("the node must not be tried after the caller gave up");
  }, { directTimeoutMs: 5_000 });
  const pending = aborting({ url: new URL("https://www.bbc.co.uk/"), headers: {}, maxBytes: 1024, signal: caller.signal });
  caller.abort(new DOMException("gone", "AbortError"));
  await assert.rejects(pending, /no answer/);
});
