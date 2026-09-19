// Tier 3: AgentBay's cloud browser driven over CDP, tested against a fake
// SDK and a fake Playwright — the live bring-up needs the AgentBay key.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWebRenderer, WEB_RENDER_IMAGE_ID } from "../src/agentbay/browser.mjs";
import { createAgentBayClient } from "../src/agentbay/client.mjs";

const SECRET_ENDPOINT = "wss://cdp.agentbay.example/session/s-1?token=cdp-token-must-not-leak";

/** A Playwright page double: `contents` is what `content()` returns, call by call. */
function fakePage({ contents, url, status = 200, gotoError = null, visible = 5_000 }) {
  const routes = [];
  const listeners = {};
  let reads = 0;
  const mainFrame = {};
  return {
    routes,
    async route(_pattern, handler) { routes.push(handler); },
    on(event, handler) { listeners[event] = handler; },
    mainFrame: () => mainFrame,
    async goto() {
      if (gotoError) throw gotoError;
      listeners.response?.({ request: () => ({ isNavigationRequest: () => true }), frame: () => mainFrame, status: () => status });
      return { status: () => status };
    },
    async waitForLoadState() {},
    async content() { return contents[Math.min(reads++, contents.length - 1)]; },
    async evaluate() { return visible; },
    url: () => url,
  };
}

function fakeBrowserStack({ pages }) {
  const log = { sessions: [], deleted: [], contexts: 0, closedContexts: 0, initialize: [], connects: [] };
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

test("inside the page, images and private addresses are never requested", async () => {
  const url = "https://www.cde.org.cn/main/news/listpage/x";
  const page = fakePage({ contents: [documentHtml], url });
  const stack = fakeBrowserStack({ pages: [page] });
  const renderer = createWebRenderer(enabledConfig, { createClient: async () => stack.client, loadPlaywright: async () => stack.playwright });
  await renderer.render({ url: new URL(url) });
  const [handler] = page.routes;
  const decide = (requestUrl, resourceType = "document") => {
    let decision = null;
    handler({
      request: () => ({ url: () => requestUrl, resourceType: () => resourceType }),
      abort: () => { decision = "abort"; },
      continue: () => { decision = "continue"; },
    });
    return decision;
  };
  assert.equal(decide("https://www.cde.org.cn/api/list"), "continue");
  assert.equal(decide("https://www.cde.org.cn/logo.png", "image"), "abort");
  assert.equal(decide("https://fonts.example.org/x.woff2", "font"), "abort");
  assert.equal(decide("http://100.100.100.200/latest/meta-data/"), "abort", "the VM's own metadata service");
  assert.equal(decide("http://127.0.0.1:9222/json"), "abort");
  assert.equal(decide("http://localhost/"), "abort");
  assert.equal(decide("file:///etc/passwd"), "abort");
  assert.equal(decide("data:text/plain,x"), "continue");
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

test("the AgentBay client stand-in reads its key from a 0600 file and never repeats the SDK's words", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentbay-key-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "agentbay.key");
  await writeFile(keyFile, "ak-secret-value-001\n", { mode: 0o600 });
  const constructed = [];
  const logger = [];
  const sdk = {
    setupLogger: (options) => logger.push(options),
    AgentBay: class {
      constructor(options) { constructed.push(options); }
      async create() { throw new Error("invalid apiKey: ak-secret-value-001"); }
    },
  };
  const client = await createAgentBayClient({ agentbayApiKeyFile: keyFile, agentbayRegion: "cn-hangzhou" }, { sdk });
  assert.deepEqual(constructed, [{ apiKey: "ak-secret-value-001", config: { region_id: "cn-hangzhou" } }]);
  assert.deepEqual(logger, [{ level: "ERROR", enableConsole: false }]);
  await assert.rejects(client.createSession({ imageId: "browser_latest" }), (error) => {
    assert.equal(error.code, "agentbay_session_create_failed");
    assert.ok(!error.message.includes("ak-secret-value-001"));
    return true;
  });

  await assert.rejects(createAgentBayClient({ agentbayApiKeyFile: "" }, { sdk }), (error) => error.code === "agentbay_unconfigured");
  await chmod(keyFile, 0o644);
  await assert.rejects(createAgentBayClient({ agentbayApiKeyFile: keyFile }, { sdk }), (error) => error.code === "agentbay_key_unavailable");
});
