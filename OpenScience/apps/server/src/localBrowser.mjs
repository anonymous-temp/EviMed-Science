/**
 * Tier 3 of web reading, the deployment's own provider: a headless Chromium
 * on this host reached over the DevTools protocol — in production the
 * knowledge plugin's `frontier-browser`, the runtime image's Chromium, which
 * measurably gets through the 瑞数 challenges NMPA, CDE and NHC answer a
 * plain client with (the plugin reads their lists through it every day since
 * 2026-09-22). AgentBay's cloud browser (agentbay/browser.mjs) stays the
 * other provider; webRender.mjs picks one.
 *
 * A browser on this host runs an unknown page's script inside this network,
 * which AgentBay's never did, so the render is fenced three ways:
 *
 * - it navigates only the URL the reader already vetted (validated, robots.txt
 *   read, paced) and every request the page makes is held to the direct-read
 *   rules by name (webRenderPage.mjs);
 * - its context resolves nothing itself: it is given a proxy this process
 *   opens for that render alone (webRenderEgress.mjs), which resolves each
 *   host, refuses any private address, connects to the address it checked, and
 *   caps what the render may download — so neither a rebinding name nor a
 *   worker's WebSocket reaches an internal address;
 * - its time is the render budget, and the proxy with every tunnel is closed
 *   when the render ends.
 *
 * It identifies itself as a Chrome carrying the same product token a direct
 * read sends, so a site's log says who read it and how to reach us.
 *
 * Nothing Playwright throws is repeated: every failure leaves as a named code
 * and a fixed sentence.
 *
 * @module localBrowser
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { webReadUserAgent } from "./webRead.mjs";
import { ConcurrencyGate } from "./webReadLimits.mjs";
import { webReadError } from "./webReadNetwork.mjs";
import { localAddressToward, openRenderEgress } from "./webRenderEgress.mjs";
import { MAX_HOSTS_PER_RENDER, pageHostResolver, renderInFreshContext } from "./webRenderPage.mjs";

/**
 * The browser's DevTools address from configuration, or null.
 * @param {unknown} value
 * @returns {URL | null}
 */
export function localBrowserEndpoint(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Whether this deployment could render in its own browser: the render switch
 * is on and a DevTools address is configured.
 * @param {any} config
 */
export function localRenderConfigured(config) {
  return config?.webRenderEnabled === true && Boolean(localBrowserEndpoint(config?.webRenderCdpUrl));
}

/**
 * @param {any} config
 * @param {{
 *   loadPlaywright?: () => Promise<{ chromium: { connectOverCDP: (endpoint: string, options?: any) => Promise<any> } }>,
 *   now?: () => number,
 *   resolveImpl?: (hostname: string, options: { all: true }) => Promise<any>,
 *   resolveBrowserHost?: (hostname: string) => Promise<string>,
 *   addressToward?: (host: string, port: number) => Promise<string>,
 *   openEgress?: typeof openRenderEgress,
 * }} [dependencies] `resolveBrowserHost`: the browser container's address
 *   (Chromium's DevTools endpoint answers an IP Host only, measured on Chrome
 *   145 by the knowledge plugin); `addressToward`: this process's address as
 *   the browser sees it, where the render's proxy listens
 * @returns {import("./webRead.mjs").WebRenderer}
 */
export function createLocalWebRenderer(config, {
  loadPlaywright = () => import("playwright-core"),
  now = Date.now,
  resolveImpl = pageHostResolver(),
  resolveBrowserHost = async (hostname) => (await dnsLookup(hostname, { family: 4 })).address,
  addressToward = (host, port) => localAddressToward(host, port),
  openEgress = openRenderEgress,
} = {}) {
  const endpoint = localBrowserEndpoint(config?.webRenderCdpUrl);
  const enabled = config?.webRenderEnabled === true && Boolean(endpoint);
  const timeoutMs = Math.max(5_000, Number(config?.webRenderTimeoutMs) || 30_000);
  const maxBytes = Math.max(1024 * 1024, Number(config?.webRenderMaxBytes) || 32 * 1024 * 1024);
  const gate = new ConcurrencyGate({ limit: Number(config?.webRenderConcurrency ?? 2), maxQueue: 16, busyCode: "web_render_busy" });
  // `sessionsCreated` / `sessionFailures` are connections to the browser, so
  // the operator's render metrics read the same for either provider.
  const counts = { renders: 0, failures: 0, sessionsCreated: 0, sessionsReleased: 0, sessionFailures: 0, requestsRefused: 0, byteCaps: 0 };

  /** @type {{ browser: any, address: string, localAddress: string, userAgent: string } | null} */
  let connection = null;
  /** @type {Promise<NonNullable<typeof connection>> | null} */
  let connecting = null;
  let inFlight = 0;

  async function open() {
    const target = /** @type {URL} */ (endpoint);
    try {
      const host = target.hostname.replace(/^\[|\]$/g, "");
      const address = isIP(host) ? host : await resolveBrowserHost(host);
      const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
      const localAddress = await addressToward(address, port);
      const { chromium } = await loadPlaywright();
      const authority = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
      const browser = await chromium.connectOverCDP(`${target.protocol}//${authority}`, { timeout: Math.min(timeoutMs, 15_000) });
      const major = String(browser.version?.() ?? "").split(".")[0] || "0";
      const opened = {
        browser,
        address,
        localAddress,
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 ${webReadUserAgent(config)}`,
      };
      browser.on?.("disconnected", () => {
        if (connection?.browser === browser) connection = null;
      });
      counts.sessionsCreated += 1;
      connection = opened;
      return opened;
    } catch {
      counts.sessionFailures += 1;
      throw webReadError(503, "web_render_unavailable", "The browser is not reachable in this deployment right now; try again shortly.", { retryable: true });
    }
  }

  async function connect() {
    if (connection && connection.browser.isConnected?.() !== false) return connection;
    connection = null;
    connecting ??= open().finally(() => { connecting = null; });
    return connecting;
  }

  /**
   * @param {{ url: URL, signal?: AbortSignal }} request
   * @returns {Promise<{ html: string, finalUrl: string, status: number }>}
   */
  async function render({ url, signal }) {
    if (!enabled) throw webReadError(503, "web_render_disabled", "Page rendering is switched off in this deployment.");
    return gate.run(async () => {
      inFlight += 1;
      const deadline = now() + timeoutMs;
      /** @type {Awaited<ReturnType<typeof openRenderEgress>> | null} */
      let egress = null;
      try {
        let current;
        try {
          current = await connect();
          egress = await openEgress({
            bindAddress: current.localAddress,
            peerAddress: current.address,
            resolveImpl,
            maxBytes,
            maxHosts: MAX_HOSTS_PER_RENDER,
            counts,
          });
        } catch {
          counts.renders += 1;
          counts.failures += 1;
          throw webReadError(503, "web_render_unavailable", "The browser is not reachable in this deployment right now; try again shortly.", { retryable: true });
        }
        const own = /** @type {NonNullable<typeof egress>} */ (egress);
        return await renderInFreshContext({
          browser: current.browser, url, signal, deadline, now, resolveImpl, counts, browserName: "browser",
          contextOptions: { proxy: { server: own.proxyUrl }, userAgent: current.userAgent },
          // The egress holds every WebSocket, a worker's too; Playwright's
          // in-page stand-in would only make 瑞数 refuse the page.
          closeWebSockets: false,
          onFailure: () => {
            if (connection && connection.browser.isConnected?.() === false) connection = null;
            return own.capped()
              ? webReadError(502, "web_read_response_too_large", "The page and what it loads exceeded the gateway's size limit.")
              : null;
          },
        });
      } finally {
        await egress?.close();
        inFlight -= 1;
      }
    }, { signal });
  }

  return {
    enabled,
    provider: "local",
    render,
    async close() {
      if (connecting) await connecting.catch(() => {});
      const current = connection;
      connection = null;
      // Over CDP this disconnects; the browser is not ours to stop.
      await current?.browser.close?.().catch?.(() => {});
    },
    stats() {
      return { ...counts, warmSessions: connection ? 1 : 0, inFlight, queued: gate.queue.length };
    },
  };
}
