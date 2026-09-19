/**
 * Tier 3 of web reading: open a page in AgentBay's cloud browser, let it draw,
 * take its HTML back. Extraction happens in the gateway, as for every page.
 *
 * Why a remote browser and not one on this host (ruling 2026-09-19): an
 * unknown page's script runs in AgentBay's VM, not inside this network, so
 * "the page's own JavaScript probes internal addresses" is not a risk we
 * manage — it is one we do not have; the shared host carries no Chromium; and
 * AgentBay's stealth fingerprint is what gets past the JavaScript challenges
 * NMPA, CDE and NHC answer a plain client with.
 *
 * What a render is, and all it is: open, wait, return the HTML. No clicks, no
 * logins, no forms, no captcha solving (`solveCaptchas: false` — solving one
 * is an interaction). Every request gets a fresh browser context, which is
 * Chromium's incognito unit: no cookie, storage or cache outlives it. Images,
 * media and fonts are not loaded (the text is the product), and every other
 * request the page makes is held to the rules a direct read is: http(s), a
 * default port, a name that resolves only to public addresses. The security
 * review of the 2026-09-20 release found the check reading the name alone, so
 * a hostile page could reach its VM's metadata service through any name that
 * resolves to it. WebSockets are not opened, and the HTML that comes back is
 * capped before it crosses the wire.
 *
 * One warm session serves all renders while there is traffic and is released
 * after `webRenderIdleReleaseMs` of quiet; AgentBay's own idle release (five
 * minutes by default) is the safety net if this process dies holding it.
 *
 * Nothing AgentBay or Playwright throws is repeated: their errors can carry
 * the API key and the CDP endpoint (which embeds a session token), so every
 * failure leaves as a named code and a fixed sentence.
 *
 * @module agentbay/browser
 */

import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

import { createAgentBayClient } from "./client.mjs";
import { HTML_MAX_BYTES } from "../webRead.mjs";
import { challengeVendor, SHELL_VISIBLE_CHARS } from "../webReadExtract.mjs";
import { ConcurrencyGate } from "../webReadLimits.mjs";
import { assertPublicWebHost, validatedWebUrl, webReadError, WebReadError } from "../webReadNetwork.mjs";

/** AgentBay's browser image (ruling 2026-09-19); Browser Use images cannot be customised. */
export const WEB_RENDER_IMAGE_ID = "browser_latest";
/** Labels the render session carries, so an operator can tell it from a project runtime. */
export const WEB_RENDER_SESSION_LABELS = Object.freeze({ purpose: "evimed-web-render" });
/** Resource types never loaded: the text is what is read. */
const SKIPPED_RESOURCES = new Set(["image", "media", "font"]);
/** How long one quiet-network wait may take before the page is looked at again. */
const SETTLE_STEP_MS = 8_000;
/** Distinct hosts one render may reach. A document page draws on a handful —
 *  its own site, a CDN, a script host — and each new one is a DNS lookup here,
 *  a number a hostile page would otherwise choose. Counted, with every other
 *  request refused inside a page, in
 *  open_science_web_render_events_total{event="request_refused"}. */
const MAX_HOSTS_PER_RENDER = 16;

/**
 * How a host a page asks for is resolved here: c-ares with a short timeout,
 * not getaddrinfo. The page picks how many names are looked up and how slowly
 * its own nameserver answers, and getaddrinfo holds one of libuv's four
 * threadpool threads — shared with this server's file reads and hashing — for
 * as long as that takes. It is this server's resolver, not the VM's: a name
 * that answers the two differently is beyond a route handler, whose request
 * the browser still resolves itself.
 * @returns {(hostname: string) => Promise<Array<{ address: string, family: number }>>}
 */
function pageHostResolver() {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  return async (hostname) => {
    const literal = isIP(hostname);
    if (literal) return [{ address: hostname, family: literal }];
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
  };
}

/**
 * The page's HTML, the way `page.content()` serialises it, and how much text
 * it shows — measured in the page and sent back only when the HTML is within
 * `max` characters. `content()` carries a DOM of any size over the wire into
 * this process, and the page's own script decides that size. A primitive
 * string's length is the one thing a page cannot redefine, so the bound holds
 * even against a page that rewrote its prototypes; what such a page could
 * return instead is only its own content.
 * @param {any} page @param {number} max
 * @returns {Promise<{ html: string | null, visible: number }>}
 */
async function drawnPage(page, max) {
  const state = await page.evaluate((/** @type {number} */ limit) => {
    // Runs in the page, where `document` exists; this file is type-checked
    // against Node, where it does not.
    const scope = /** @type {any} */ (globalThis);
    const document = scope.document;
    let html = "";
    let visible = 0;
    try {
      if (document?.doctype) html = new scope.XMLSerializer().serializeToString(document.doctype);
      if (document?.documentElement) html += document.documentElement.outerHTML;
    } catch {
      html = "";
    }
    try {
      visible = String(document?.body?.innerText ?? "").replace(/\s+/g, "").length;
    } catch {
      visible = 0;
    }
    return { html: typeof html === "string" && html.length <= limit ? html : null, visible: typeof visible === "number" ? visible : 0 };
  }, max);
  return {
    html: typeof state?.html === "string" && state.html.length <= max ? state.html : null,
    visible: Number.isFinite(state?.visible) ? Number(state.visible) : 0,
  };
}

/**
 * @param {any} config
 * @param {{
 *   createClient?: (config: any) => Promise<any> | any,
 *   loadPlaywright?: () => Promise<{ chromium: { connectOverCDP: (endpoint: string, options?: any) => Promise<any> } }>,
 *   now?: () => number,
 *   resolveImpl?: (hostname: string, options: { all: true }) => Promise<any>,
 * }} [dependencies]
 * @returns {import("../webRead.mjs").WebRenderer}
 */
export function createWebRenderer(config, {
  createClient = createAgentBayClient,
  loadPlaywright = () => import("playwright-core"),
  now = Date.now,
  resolveImpl = pageHostResolver(),
} = {}) {
  const enabled = config?.webRenderEnabled === true && Boolean(String(config?.agentbayApiKeyFile ?? "").trim());
  const timeoutMs = Math.max(5_000, Number(config?.webRenderTimeoutMs) || 30_000);
  const idleReleaseMs = Math.max(10_000, Number(config?.webRenderIdleReleaseMs) || 300_000);
  const gate = new ConcurrencyGate({ limit: Number(config?.webRenderConcurrency ?? 2), maxQueue: 16, busyCode: "web_render_busy" });
  const counts = { renders: 0, failures: 0, sessionsCreated: 0, sessionsReleased: 0, sessionFailures: 0, requestsRefused: 0 };

  /** @type {Promise<any> | null} */
  let clientPromise = null;
  /** @type {{ sessionId: string, browser: any } | null} */
  let warm = null;
  /** @type {Promise<{ sessionId: string, browser: any }> | null} */
  let starting = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
  let inFlight = 0;

  async function client() {
    clientPromise ??= Promise.resolve().then(() => createClient(config));
    try {
      return await clientPromise;
    } catch {
      clientPromise = null;
      throw webReadError(503, "web_render_unavailable", "The cloud browser is not available in this deployment.");
    }
  }

  async function startSession() {
    const agentBay = await client();
    let created;
    try {
      created = await agentBay.createSession({
        imageId: WEB_RENDER_IMAGE_ID,
        labels: { ...WEB_RENDER_SESSION_LABELS },
        // What we read is nobody's business but the run's: no recording.
        enableBrowserReplay: false,
      });
    } catch {
      counts.sessionFailures += 1;
      throw webReadError(503, "web_render_unavailable", "The cloud browser could not be started; try again shortly.", { retryable: true });
    }
    counts.sessionsCreated += 1;
    try {
      const initialized = await created.session.browser.initializeAsync({
        useStealth: true,
        solveCaptchas: false,
        viewport: { width: 1366, height: 900 },
      });
      if (!initialized) throw new Error("browser not initialized");
      const endpoint = await created.session.browser.getEndpointUrl();
      const { chromium } = await loadPlaywright();
      const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
      browser.on?.("disconnected", () => {
        if (warm?.browser === browser) warm = null;
      });
      return { sessionId: created.sessionId, browser };
    } catch {
      counts.sessionFailures += 1;
      await agentBay.deleteSession(created.sessionId, { syncContext: false }).catch(() => {});
      throw webReadError(503, "web_render_unavailable", "The cloud browser could not be started; try again shortly.", { retryable: true });
    }
  }

  async function ensureWarm() {
    if (warm && warm.browser.isConnected?.() !== false) return warm;
    warm = null;
    starting ??= startSession().finally(() => { starting = null; });
    const session = await starting;
    warm = session;
    return session;
  }

  async function release() {
    const current = warm;
    warm = null;
    if (!current) return;
    await current.browser.close?.().catch?.(() => {});
    try {
      await (await client()).deleteSession(current.sessionId, { syncContext: false });
      counts.sessionsReleased += 1;
    } catch {
      counts.sessionFailures += 1;
    }
  }

  function scheduleRelease() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight === 0) void release();
    }, idleReleaseMs);
    idleTimer.unref?.();
  }

  /**
   * Wait until the page has drawn: the network goes quiet, and the document is
   * neither a vendor challenge nor an empty shell — a challenge page solves
   * itself and navigates, which takes a second quiet period to see.
   * @param {any} page @param {number} deadline
   */
  async function settle(page, deadline) {
    for (let round = 0; round < 4; round += 1) {
      const left = deadline - now();
      if (left <= 0) return;
      await page.waitForLoadState("networkidle", { timeout: Math.min(left, SETTLE_STEP_MS) }).catch(() => {});
      const drawn = await drawnPage(page, HTML_MAX_BYTES).catch(() => null);
      // A page past the cap is not waited for: it is refused as it stands.
      if (drawn && (drawn.html === null || (!challengeVendor(drawn.html) && drawn.visible >= SHELL_VISIBLE_CHARS))) return;
      const pause = Math.min(1_000, deadline - now());
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  /**
   * @param {{ url: URL, signal?: AbortSignal }} request
   * @returns {Promise<{ html: string, finalUrl: string, status: number }>}
   */
  async function render({ url, signal }) {
    if (!enabled) throw webReadError(503, "web_render_disabled", "Page rendering is switched off in this deployment.");
    return gate.run(async () => {
      inFlight += 1;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const deadline = now() + timeoutMs;
      /** @type {any} */
      let context = null;
      const onAbort = () => { void context?.close?.().catch?.(() => {}); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const session = await ensureWarm();
        context = await session.browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
          javaScriptEnabled: true,
          locale: "zh-CN",
          viewport: { width: 1366, height: 900 },
        });
        /** @type {Map<string, Promise<void>>} each host's verdict, looked up once */
        const hosts = new Map();
        /** @param {string} hostname */
        const publicHost = (hostname) => {
          let verdict = hosts.get(hostname);
          if (!verdict) {
            if (hosts.size >= MAX_HOSTS_PER_RENDER) return Promise.reject(new Error("too many hosts"));
            verdict = assertPublicWebHost(hostname, resolveImpl);
            verdict.catch(() => {});
            hosts.set(hostname, verdict);
          }
          return verdict;
        };
        // On the context, not the page: a window the page opens is held to
        // the same rules, as are its workers' requests (measured).
        await context.route("**/*", async (/** @type {any} */ route) => {
          const request = route.request();
          let allowed = false;
          try {
            if (!SKIPPED_RESOURCES.has(request.resourceType())) {
              const target = String(request.url());
              if (/^(?:data|blob):/i.test(target)) allowed = true;
              else {
                await publicHost(validatedWebUrl(target).hostname);
                allowed = true;
              }
            }
          } catch {
            counts.requestsRefused += 1;
          }
          await (allowed ? route.continue() : route.abort()).catch(() => { /* the page is gone */ });
        });
        // A WebSocket's handshake is a request the route above never sees,
        // and no document needs one to draw its text: every one is closed
        // before it connects. Playwright does this by standing in for the
        // WebSocket of every frame; a dedicated worker's own WebSocket is
        // beyond it — its handshake still leaves, though the worker reads an
        // answer only from a WebSocket server — and CDP's URL blocking stopped
        // no WebSocket at all (both measured against Chromium 145 over CDP,
        // 2026-09-19).
        await context.routeWebSocket(() => true, (/** @type {any} */ socket) => {
          counts.requestsRefused += 1;
          void Promise.resolve(socket.close({ code: 1008, reason: "Web reading opens no WebSockets." })).catch(() => {});
        });
        const page = await context.newPage();
        let status = 0;
        page.on?.("response", (/** @type {any} */ response) => {
          try {
            if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
          } catch { /* a response we cannot classify is not the document's */ }
        });
        const first = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, deadline - now()) });
        if (!status) status = Number(first?.status?.()) || 0;
        await settle(page, deadline);
        const drawn = await drawnPage(page, HTML_MAX_BYTES);
        if (drawn.html === null) {
          throw webReadError(502, "web_read_response_too_large", "The rendered page exceeded the gateway's size limit.");
        }
        return { html: drawn.html, finalUrl: page.url(), status: status || 200 };
      } catch (error) {
        counts.failures += 1;
        if (error instanceof WebReadError) throw error;
        // A session that died under us is dropped, so the next render starts
        // a fresh one instead of failing against a dead endpoint forever.
        if (warm && warm.browser.isConnected?.() === false) warm = null;
        if (signal?.aborted) throw webReadError(499, "web_read_aborted", "The web read was abandoned.");
        if (error?.name === "TimeoutError" || now() >= deadline) {
          throw webReadError(504, "web_render_timeout", "The page did not finish drawing in the cloud browser in time.", { retryable: true });
        }
        throw webReadError(502, "web_render_failed", "The cloud browser could not open this page.", { retryable: true });
      } finally {
        signal?.removeEventListener("abort", onAbort);
        await context?.close?.().catch?.(() => {});
        counts.renders += 1;
        inFlight -= 1;
        if (inFlight === 0) scheduleRelease();
      }
    }, { signal });
  }

  return {
    enabled,
    render,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (starting) await starting.catch(() => {});
      await release();
    },
    stats() {
      return { ...counts, warmSessions: warm ? 1 : 0, inFlight, queued: gate.queue.length };
    },
  };
}
