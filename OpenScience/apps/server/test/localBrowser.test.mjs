// Tier 3 on the deployment's own browser: the per-render egress proxy against
// real sockets (a local server stands in for every site, reached only through
// the address the proxy checked), and the renderer against a fake Playwright.
// The live check against NMPA's 瑞数 challenge is the integration audit's
// `source.web-read-render` item, which renders through production's browser.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { createLocalWebRenderer } from "../src/localBrowser.mjs";
import { openRenderEgress } from "../src/webRenderEgress.mjs";

const PUBLIC = "93.184.216.34";

/** A resolver where `*.example.org` is public, `inward.example.org` private. */
function resolver(calls = []) {
  return async (hostname) => {
    calls.push(hostname);
    if (hostname === "inward.example.org") return [{ address: "10.0.0.8", family: 4 }];
    if (hostname === "mixed.example.org") return [{ address: PUBLIC, family: 4 }, { address: "169.254.169.254", family: 4 }];
    if (hostname.endsWith(".example.org")) return [{ address: PUBLIC, family: 4 }];
    throw new Error("NXDOMAIN");
  };
}

/** Upstream sockets go to `port` on loopback, and record which checked address they were for. */
function upstreamTo(port, dialed) {
  return ({ host, port: wanted }) => {
    dialed.push(`${host}:${wanted}`);
    return net.connect({ host: "127.0.0.1", port });
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

/** Send a CONNECT and return the status line plus the socket, tunnel open. */
function connectThrough(proxyUrl, authority) {
  const { hostname, port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    let buffered = "";
    socket.once("error", reject);
    socket.on("close", () => resolve({ status: buffered.split("\r\n", 1)[0] || "closed", socket }));
    socket.on("data", function onData(chunk) {
      buffered += chunk.toString("latin1");
      if (buffered.includes("\r\n\r\n")) {
        socket.off("data", onData);
        socket.removeAllListeners("close");
        resolve({ status: buffered.split("\r\n", 1)[0], socket });
      }
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

test("a render's egress tunnels only to checked public addresses, on 443 and 80, and resolves each host once", async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  t.after(() => echo.close());
  const lookups = [];
  const dialed = [];
  const counts = { requestsRefused: 0, byteCaps: 0 };
  const egress = await openRenderEgress({
    bindAddress: "127.0.0.1", peerAddress: "127.0.0.1", resolveImpl: resolver(lookups),
    maxBytes: 1024 * 1024, maxHosts: 16, counts, connectImpl: upstreamTo(echoPort, dialed),
  });
  t.after(() => egress.close());

  const open = await connectThrough(egress.proxyUrl, "www.nmpa.example.org:443");
  assert.equal(open.status, "HTTP/1.1 200 Connection Established");
  const echoed = await new Promise((resolve) => {
    open.socket.once("data", (chunk) => resolve(chunk.toString()));
    open.socket.write("client hello");
  });
  assert.equal(echoed, "client hello", "a tunnel carries bytes both ways");
  open.socket.destroy();

  const again = await connectThrough(egress.proxyUrl, "www.nmpa.example.org:443");
  assert.equal(again.status, "HTTP/1.1 200 Connection Established");
  again.socket.destroy();
  assert.equal(lookups.filter((name) => name === "www.nmpa.example.org").length, 1, "a name is resolved once per render, so it cannot answer differently the second time");
  assert.deepEqual(dialed, [`${PUBLIC}:443`, `${PUBLIC}:443`], "the socket goes to the address that was checked, never to a name");

  for (const authority of ["inward.example.org:443", "mixed.example.org:443", "127.0.0.1:443", "10.0.0.8:443", "localhost:443", "metadata:80", "[::1]:443", "www.nmpa.example.org:8443", "www.nmpa.example.org:22"]) {
    const refused = await connectThrough(egress.proxyUrl, authority);
    assert.equal(refused.status, "HTTP/1.1 403 Forbidden", authority);
    refused.socket.destroy();
  }
  assert.equal(dialed.length, 2, "nothing refused was ever dialled");
  assert.equal(counts.requestsRefused, 9);
});

test("plain http is forwarded as an origin-form request to the checked address, with the site's Host", async (t) => {
  const seen = [];
  const site = http.createServer((request, response) => {
    seen.push({ url: request.url, host: request.headers.host, proxyAuth: request.headers["proxy-authorization"] ?? null });
    response.writeHead(200, { "content-type": "text/html" }).end("<p>notice</p>");
  });
  const sitePort = await listen(site);
  t.after(() => site.close());
  const dialed = [];
  const counts = { requestsRefused: 0, byteCaps: 0 };
  const egress = await openRenderEgress({
    bindAddress: "127.0.0.1", peerAddress: "127.0.0.1", resolveImpl: resolver(),
    maxBytes: 1024 * 1024, maxHosts: 16, counts, connectImpl: upstreamTo(sitePort, dialed),
  });
  t.after(() => egress.close());
  const proxy = new URL(egress.proxyUrl);
  const get = (target) => new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: "GET", path: target, headers: { host: new URL(target).host, "proxy-authorization": "Basic eDp5" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
  const answer = await get("http://www.nhc.example.org/wjw/list.shtml?page=2");
  assert.equal(answer.status, 200);
  assert.equal(answer.body, "<p>notice</p>");
  assert.deepEqual(seen, [{ url: "/wjw/list.shtml?page=2", host: "www.nhc.example.org", proxyAuth: null }]);
  assert.deepEqual(dialed, [`${PUBLIC}:80`]);
  assert.equal((await get("http://inward.example.org/")).status, 403);
  assert.equal((await get("http://www.nhc.example.org:8080/")).status, 403);
  assert.equal(seen.length, 1);
});

test("past the byte cap every tunnel is cut and the render knows why; close ends the rest", async (t) => {
  const firehose = net.createServer((socket) => {
    socket.on("error", () => {});
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const pump = () => { while (!socket.destroyed && socket.write(chunk)); };
    socket.on("drain", pump);
    pump();
  });
  const port = await listen(firehose);
  t.after(() => firehose.close());
  const counts = { requestsRefused: 0, byteCaps: 0 };
  const egress = await openRenderEgress({
    bindAddress: "127.0.0.1", peerAddress: "127.0.0.1", resolveImpl: resolver(),
    maxBytes: 256 * 1024, maxHosts: 16, counts, connectImpl: upstreamTo(port, []),
  });
  const open = await connectThrough(egress.proxyUrl, "big.example.org:443");
  assert.equal(open.status, "HTTP/1.1 200 Connection Established");
  let received = 0;
  await new Promise((resolve) => {
    open.socket.on("data", (chunk) => { received += chunk.length; });
    open.socket.on("close", resolve);
  });
  assert.ok(received <= 256 * 1024 + 64 * 1024, `the browser got ${received} bytes past a 256 KiB cap`);
  assert.equal(egress.capped(), true);
  assert.equal(counts.byteCaps, 1);
  const late = await connectThrough(egress.proxyUrl, "other.example.org:443");
  assert.equal(late.status, "closed", "a capped render opens nothing more");
  await egress.close();
  await assert.rejects(connectThrough(egress.proxyUrl, "other.example.org:443"), "a closed egress listens no more");
});

test("only the browser's own address may use a render's egress", async (t) => {
  const counts = { requestsRefused: 0, byteCaps: 0 };
  const dialed = [];
  const egress = await openRenderEgress({
    bindAddress: "127.0.0.1", peerAddress: "172.31.0.9", resolveImpl: resolver(),
    maxBytes: 1024 * 1024, maxHosts: 16, counts, connectImpl: upstreamTo(1, dialed),
  });
  t.after(() => egress.close());
  const attempt = await connectThrough(egress.proxyUrl, "www.nmpa.example.org:443");
  assert.equal(attempt.status, "closed");
  assert.equal(counts.requestsRefused, 1);
  assert.deepEqual(dialed, []);
});

// --- the renderer, against a fake Playwright -------------------------------

const documentHtml = `<html><body><main>${"<p>药品注册公告正文。</p>".repeat(40)}</main></body></html>`;

function fakePlaywright({ html = documentHtml, gotoError = null } = {}) {
  const log = { connects: [], contexts: [], closedContexts: 0, disconnected: 0 };
  let connected = true;
  const page = {
    on() {},
    mainFrame: () => ({}),
    async goto() {
      if (gotoError) throw gotoError;
      return { status: () => 200 };
    },
    async waitForLoadState() {},
    async evaluate() { return { html, visible: 5_000 }; },
    url: () => "https://www.nmpa.gov.cn/xxgk/ggtg/index.html",
  };
  const browser = {
    version: () => "150.0.7871.114",
    isConnected: () => connected,
    on() {},
    async close() { connected = false; log.disconnected += 1; },
    async newContext(options) {
      log.contexts.push(options);
      return {
        async route() {},
        async routeWebSocket() {},
        async newPage() { return page; },
        async close() { log.closedContexts += 1; },
      };
    },
  };
  return { log, playwright: { chromium: { async connectOverCDP(endpoint) { log.connects.push(endpoint); return browser; } } } };
}

function fakeEgress(log, { capped = false } = {}) {
  return async (options) => {
    log.push({ opened: options });
    return {
      proxyUrl: `http://${options.bindAddress}:41000`,
      capped: () => capped,
      downloaded: () => 0,
      async close() { log.push("closed"); },
    };
  };
}

const localConfig = { webRenderEnabled: true, webRenderCdpUrl: "http://frontier-browser:9222", webRenderConcurrency: 2, webRenderTimeoutMs: 30_000, webRenderMaxBytes: 33_554_432, publicUrl: "https://evimed.example.org" };

test("the local renderer connects by address, gives each context its own egress and an honest identity, and closes both", async () => {
  const stack = fakePlaywright();
  const egressLog = [];
  const renderer = createLocalWebRenderer(localConfig, {
    loadPlaywright: async () => stack.playwright,
    resolveBrowserHost: async (name) => (name === "frontier-browser" ? "172.30.0.3" : "0.0.0.0"),
    addressToward: async (host) => (host === "172.30.0.3" ? "172.30.0.2" : "0.0.0.0"),
    openEgress: fakeEgress(egressLog),
  });
  assert.equal(renderer.enabled, true);
  assert.equal(renderer.provider, "local");
  const first = await renderer.render({ url: new URL("https://www.nmpa.gov.cn/xxgk/ggtg/index.html") });
  await renderer.render({ url: new URL("https://www.nmpa.gov.cn/xxgk/ggtg/index.html") });
  assert.equal(first.html, documentHtml);
  assert.equal(first.status, 200);
  assert.deepEqual(stack.log.connects, ["http://172.30.0.3:9222"], "DevTools answers an IP Host only; one connection serves every render");
  assert.equal(stack.log.contexts.length, 2);
  for (const options of stack.log.contexts) {
    assert.deepEqual(options.proxy, { server: "http://172.30.0.2:41000" }, "the context resolves nothing itself");
    assert.equal(options.serviceWorkers, "block");
    assert.equal(options.acceptDownloads, false);
    assert.match(options.userAgent, /Chrome\/150\.0\.0\.0 Safari\/537\.36 EviMedBot\/1\.0 \(\+https:\/\/evimed\.example\.org;/);
    assert.doesNotMatch(options.userAgent, /Headless/);
  }
  const opened = egressLog.filter((entry) => entry !== "closed").map((entry) => entry.opened);
  assert.equal(opened.length, 2, "one egress per render");
  assert.equal(opened[0].bindAddress, "172.30.0.2");
  assert.equal(opened[0].peerAddress, "172.30.0.3", "only the browser may use it");
  assert.equal(opened[0].maxBytes, 33_554_432);
  assert.equal(opened[0].maxHosts, 16);
  assert.equal(egressLog.filter((entry) => entry === "closed").length, 2, "every egress closes with its render");
  assert.equal(stack.log.closedContexts, 2);
  assert.equal(renderer.stats().renders, 2);
  await renderer.close();
  assert.equal(stack.log.disconnected, 1);
});

test("a render cut at the byte cap is refused as too large; an unreachable browser is unavailable, by name", async () => {
  const stack = fakePlaywright({ gotoError: new Error("net::ERR_TUNNEL_CONNECTION_FAILED at ws://172.30.0.3:9222/devtools/browser/secret-id") });
  const capped = createLocalWebRenderer(localConfig, {
    loadPlaywright: async () => stack.playwright,
    resolveBrowserHost: async () => "172.30.0.3",
    addressToward: async () => "172.30.0.2",
    openEgress: fakeEgress([], { capped: true }),
  });
  await assert.rejects(capped.render({ url: new URL("https://www.cde.org.cn/") }), (error) => error.code === "web_read_response_too_large" && error.status === 502);
  assert.equal(stack.log.closedContexts, 1);

  const plain = createLocalWebRenderer(localConfig, {
    loadPlaywright: async () => stack.playwright,
    resolveBrowserHost: async () => "172.30.0.3",
    addressToward: async () => "172.30.0.2",
    openEgress: fakeEgress([]),
  });
  await assert.rejects(plain.render({ url: new URL("https://www.cde.org.cn/") }), (error) => {
    assert.equal(error.code, "web_render_failed");
    assert.ok(!error.message.includes("secret-id"), "nothing the driver said is repeated");
    return true;
  });

  const unreachable = createLocalWebRenderer(localConfig, {
    loadPlaywright: async () => ({ chromium: { async connectOverCDP() { throw new Error("connect ECONNREFUSED 172.30.0.3:9222"); } } }),
    resolveBrowserHost: async () => "172.30.0.3",
    addressToward: async () => "172.30.0.2",
    openEgress: fakeEgress([]),
  });
  await assert.rejects(unreachable.render({ url: new URL("https://www.cde.org.cn/") }), (error) => {
    assert.equal(error.code, "web_render_unavailable");
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes("172.30.0.3"));
    return true;
  });
  assert.equal(unreachable.stats().sessionFailures, 1);

  const off = createLocalWebRenderer({ ...localConfig, webRenderEnabled: false });
  await assert.rejects(off.render({ url: new URL("https://www.cde.org.cn/") }), (error) => error.code === "web_render_disabled");
});
