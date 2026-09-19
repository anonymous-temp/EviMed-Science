// Tier 3: AgentBay's cloud browser driven over CDP, tested against a fake
// SDK and a fake Playwright — the live bring-up needs the AgentBay key.
import assert from "node:assert/strict";
import test from "node:test";

import { createWebRenderer, WEB_RENDER_IMAGE_ID } from "../src/agentbay/browser.mjs";

const SECRET_ENDPOINT = "wss://cdp.agentbay.example/session/s-1?token=cdp-token-must-not-leak";

/**
 * A Playwright page double: `contents` is the page's HTML, look by look.
 * `evaluate` runs the renderer's own in-page function against a stand-in
 * document holding the next of them, so the bound it applies is the real one.
 */
function fakePage({ contents, url, status = 200, gotoError = null, visible = 5_000 }) {
  const listeners = {};
  let reads = 0;
  const mainFrame = {};
  return {
    on(event, handler) { listeners[event] = handler; },
    mainFrame: () => mainFrame,
    async goto() {
      if (gotoError) throw gotoError;
      listeners.response?.({ request: () => ({ isNavigationRequest: () => true }), frame: () => mainFrame, status: () => status });
      return { status: () => status };
    },
    async waitForLoadState() {},
    async evaluate(pageFunction, argument) {
      const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
      globalThis.document = {
        doctype: null,
        documentElement: { outerHTML: contents[Math.min(reads++, contents.length - 1)] },
        body: { innerText: "x".repeat(visible) },
      };
      try {
        return pageFunction(argument);
      } finally {
        if (saved) Object.defineProperty(globalThis, "document", saved);
        else delete globalThis.document;
      }
    },
    url: () => url,
  };
}

function fakeBrowserStack({ pages }) {
  const log = { sessions: [], deleted: [], contexts: 0, closedContexts: 0, initialize: [], connects: [], routes: [], webSocketRoutes: [] };
  let connected = true;
  let pageIndex = 0;
  const browser = {
    isConnected: () => connected,
    on() {},
    async close() { connected = false; },
    async newContext(options) {
      log.contexts += 1;
      log.lastContextOptions = options;
      return {
        async route(_pattern, handler) { log.routes.push(handler); },
        async routeWebSocket(matcher, handler) { log.webSocketRoutes.push({ matcher, handler }); },
        async newPage() { return pages[Math.min(pageIndex++, pages.length - 1)]; },
        async close() { log.closedContexts += 1; },
      };
    },
  };
  const client = {
    async createSession(params) {
      log.sessions.push(params);
      return {
        sessionId: `s-${log.sessions.length}`,
        session: {
          browser: {
            async initializeAsync(option) { log.initialize.push(option); return true; },
            async getEndpointUrl() { return SECRET_ENDPOINT; },
          },
        },
      };
    },
    async deleteSession(sessionId, options) { log.deleted.push({ sessionId, options }); },
  };
  const playwright = { chromium: { async connectOverCDP(endpoint) { log.connects.push(endpoint); connected = true; return browser; } } };
  return { log, client, playwright, disconnect: () => { connected = false; } };
}

const enabledConfig = { webRenderEnabled: true, agentbayApiKeyFile: "/run/secrets/agentbay-api-key", webRenderConcurrency: 2, webRenderTimeoutMs: 30_000, webRenderIdleReleaseMs: 300_000 };
const documentHtml = `<html><body><main>${"<p>Rendered notice text.</p>".repeat(40)}</main></body></html>`;

test("rendering is off without the switch or without a key, and says so by name", async () => {
  for (const config of [{ webRenderEnabled: false, agentbayApiKeyFile: "/k" }, { webRenderEnabled: true, agentbayApiKeyFile: "" }]) {
    const renderer = createWebRenderer(config, { createClient: () => { throw new Error("must not be called"); } });
    assert.equal(renderer.enabled, false);
    await assert.rejects(renderer.render({ url: new URL("https://www.nmpa.gov.cn/") }), (error) => error.code === "web_render_disabled");
  }
});

test("one warm session serves every render; each render gets a fresh incognito context", async () => {
  const url = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  const pages = [fakePage({ contents: [documentHtml], url }), fakePage({ contents: [documentHtml], url })];
  const stack = fakeBrowserStack({ pages });
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });

  const first = await renderer.render({ url: new URL(url) });
  const second = await renderer.render({ url: new URL(url) });
  assert.equal(first.html, documentHtml);
  assert.equal(first.finalUrl, url);
  assert.equal(first.status, 200);
  assert.equal(second.html, documentHtml);
  assert.deepEqual(stack.log.sessions, [{ imageId: WEB_RENDER_IMAGE_ID, labels: { purpose: "evimed-web-render" }, enableBrowserReplay: false }]);
  assert.deepEqual(stack.log.initialize, [{ useStealth: true, solveCaptchas: false, viewport: { width: 1366, height: 900 } }]);
  assert.deepEqual(stack.log.connects, [SECRET_ENDPOINT]);
  assert.equal(stack.log.contexts, 2);
  assert.equal(stack.log.closedContexts, 2, "no context — and so no cookie — outlives its render");
  assert.equal(stack.log.lastContextOptions.acceptDownloads, false);
  assert.equal(stack.log.lastContextOptions.serviceWorkers, "block");
  await renderer.close();
  assert.deepEqual(stack.log.deleted, [{ sessionId: "s-1", options: { syncContext: false } }]);
  assert.equal(renderer.stats().sessionsReleased, 1);
});

/** The context's route handler as a function of one request: "continue" or "abort". */
function routeDecider(handler) {
  return async (requestUrl, resourceType = "document") => {
    let decision = null;
    await handler({
      request: () => ({ url: () => requestUrl, resourceType: () => resourceType }),
      abort: async () => { decision = "abort"; },
      continue: async () => { decision = "continue"; },
    });
    return decision;
  };
}

test("inside the page, a request reaches only public addresses on default ports, and no WebSocket opens", async () => {
  const url = "https://www.cde.org.cn/main/news/listpage/x";
  const stack = fakeBrowserStack({ pages: [fakePage({ contents: [documentHtml], url })] });
  const addresses = {
    "www.cde.org.cn": "59.110.190.10",
    "cdn.example.org": "93.184.216.34",
    "metadata.example.org": "100.100.100.200",
    "rebound.example.org": "10.0.0.8",
    "v6.example.org": "fd00::1",
  };
  const lookups = [];
  const resolveImpl = async (hostname) => {
    lookups.push(hostname);
    if (!addresses[hostname]) throw new Error("NXDOMAIN");
    return [{ address: addresses[hostname], family: addresses[hostname].includes(":") ? 6 : 4 }];
  };
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright, resolveImpl });
  await renderer.render({ url: new URL(url) });
  assert.equal(stack.log.routes.length, 1, "the rules are the context's, so a window the page opens is held to them");
  const decide = routeDecider(stack.log.routes[0]);
  assert.equal(await decide("https://www.cde.org.cn/api/list"), "continue");
  assert.equal(await decide("https://cdn.example.org/app.js", "script"), "continue");
  assert.equal(await decide("https://www.cde.org.cn/logo.png", "image"), "abort");
  assert.equal(await decide("https://fonts.example.org/x.woff2", "font"), "abort");
  // The security review of the 2026-09-20 release: the check read the name
  // alone, so any name resolving to the metadata service passed.
  assert.equal(await decide("http://100.100.100.200/latest/meta-data/"), "abort", "the VM's own metadata service");
  assert.equal(await decide("http://metadata.example.org/latest/meta-data/"), "abort", "a name that resolves to it");
  assert.equal(await decide("https://rebound.example.org/"), "abort");
  assert.equal(await decide("https://v6.example.org/"), "abort");
  assert.equal(await decide("https://unresolvable.example.org/"), "abort");
  assert.equal(await decide("https://www.cde.org.cn:8443/admin"), "abort", "a non-default port");
  assert.equal(await decide("https://user:test-only-password@www.cde.org.cn/"), "abort");
  assert.equal(await decide("http://127.0.0.1:9222/json"), "abort");
  assert.equal(await decide("http://localhost/"), "abort");
  assert.equal(await decide("file:///etc/passwd"), "abort");
  assert.equal(await decide("data:text/plain,x"), "continue");
  assert.equal(lookups.filter((name) => name === "www.cde.org.cn").length, 1, "a host is looked up once per render");

  assert.equal(stack.log.webSocketRoutes.length, 1);
  const { matcher, handler } = stack.log.webSocketRoutes[0];
  assert.equal(matcher(new URL("wss://www.cde.org.cn/socket")), true, "every WebSocket, whatever its address");
  const socket = { closedWith: null, connected: false, async close(options) { this.closedWith = options; }, connectToServer() { this.connected = true; } };
  await handler(socket);
  assert.equal(socket.closedWith?.code, 1008);
  assert.equal(socket.connected, false, "closed before it ever reaches a server");
  assert.equal(renderer.stats().requestsRefused, 11);
  await renderer.close();
});

test("one render reaches at most sixteen hosts, each looked up once", async () => {
  const url = "https://www.nmpa.gov.cn/xxgk/ggtg/index.html";
  const stack = fakeBrowserStack({ pages: [fakePage({ contents: [documentHtml], url })] });
  let lookups = 0;
  const resolveImpl = async () => {
    lookups += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright, resolveImpl });
  await renderer.render({ url: new URL(url) });
  const decide = routeDecider(stack.log.routes[0]);
  for (let index = 0; index < 16; index += 1) assert.equal(await decide(`https://host-${index}.example.org/x.js`, "script"), "continue");
  assert.equal(await decide("https://host-16.example.org/x.js", "script"), "abort");
  assert.equal(await decide("https://host-3.example.org/again.js", "script"), "continue", "a host already reached costs nothing more");
  assert.equal(lookups, 16);
  await renderer.close();
});

test("a page drawn past the size cap is refused as it stands, not waited out", async () => {
  const url = "https://huge.example.org/";
  const page = fakePage({ contents: [`<html><body>${"x".repeat(5 * 1024 * 1024)}</body></html>`], url });
  let looks = 0;
  page.waitForLoadState = async () => { looks += 1; };
  const stack = fakeBrowserStack({ pages: [page] });
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });
  await assert.rejects(renderer.render({ url: new URL(url) }), (error) => error.code === "web_read_response_too_large" && error.status === 502);
  assert.equal(looks, 1, "the settle loop stopped at its first look");
  assert.equal(stack.log.closedContexts, 1);
  await renderer.close();
});

test("a challenge page is waited out until the document it guards has drawn", async () => {
  const url = "https://www.nhc.gov.cn/wjw/gfxwj/list.shtml";
  const challenge = "<html><head><script>$_ts=window['$_ts'];</script></head><body></body></html>";
  const page = fakePage({ contents: [challenge, challenge, documentHtml], url, status: 200 });
  const stack = fakeBrowserStack({ pages: [page] });
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });
  const result = await renderer.render({ url: new URL(url) });
  assert.equal(result.html, documentHtml);
  await renderer.close();
});

test("the key and the CDP endpoint never leave in an error", async () => {
  const leaky = new Error(`InvalidParameter.Authorization: invalid apiKey or token: sk-ws-leaky.key.123 at ${SECRET_ENDPOINT}`);
  const failingClient = { async createSession() { throw leaky; }, async deleteSession() {} };
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => failingClient, loadPlaywright: async () => ({ chromium: {} }) });
  await assert.rejects(renderer.render({ url: new URL("https://www.nmpa.gov.cn/") }), (error) => {
    assert.equal(error.code, "web_render_unavailable");
    assert.ok(!JSON.stringify({ message: error.message, stack: error.stack, cause: error.cause ?? null }).includes("sk-ws-leaky"));
    return true;
  });

  const url = "https://www.nmpa.gov.cn/";
  const page = fakePage({ contents: [documentHtml], url, gotoError: new Error(`net::ERR_TIMED_OUT via ${SECRET_ENDPOINT}`) });
  const stack = fakeBrowserStack({ pages: [page] });
  const broken = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });
  await assert.rejects(broken.render({ url: new URL(url) }), (error) => {
    assert.equal(error.code, "web_render_failed");
    assert.ok(!error.message.includes("cdp-token"));
    return true;
  });
  assert.equal(stack.log.closedContexts, 1, "a failed render still closes its context");
  await broken.close();
});

test("a session that died is replaced on the next render, and idle time releases the warm one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = "https://clinicaltrials.gov/study/NCT03036124";
  const stack = fakeBrowserStack({ pages: [fakePage({ contents: [documentHtml], url })] });
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });
  await renderer.render({ url: new URL(url) });
  stack.disconnect();
  await renderer.render({ url: new URL(url) });
  assert.equal(stack.log.sessions.length, 2, "a dead endpoint is not retried forever");
  assert.equal(stack.log.deleted.length, 0);
  t.mock.timers.tick(299_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stack.log.deleted.length, 0, "not released while it may still be used");
  t.mock.timers.tick(2_000);
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stack.log.deleted.map((entry) => entry.sessionId), ["s-2"]);
  assert.equal(renderer.stats().warmSessions, 0);
});
