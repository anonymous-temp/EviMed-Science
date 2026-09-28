/**
 * One render, whichever browser draws it: open the vetted URL in a fresh
 * context, hold every request the page makes to the rules a direct read is
 * held to, wait until the page has drawn, and hand back its HTML. The two
 * providers — AgentBay's cloud browser (agentbay/browser.mjs) and the
 * deployment's own headless Chromium (localBrowser.mjs) — differ in how they
 * get a browser and in what stands between it and the network; what a render
 * is, and all it is, lives here once.
 *
 * What a render is: open, wait, return the HTML. No clicks, no logins, no
 * forms, no captcha solving. Every request gets a fresh browser context,
 * which is Chromium's incognito unit: no cookie, storage or cache outlives it.
 * Images, media and fonts are not loaded (the text is the product), and every
 * other request the page makes is held to the rules a direct read is: http(s),
 * a default port, a name that resolves only to public addresses. The security
 * review of the 2026-09-20 release found the check reading the name alone, so
 * a hostile page could reach its VM's metadata service through any name that
 * resolves to it. WebSockets are closed unless the provider's own egress holds
 * them (see `closeWebSockets`), and the HTML that comes back is capped before
 * it crosses the wire.
 *
 * Nothing a browser or Playwright throws is repeated: their errors can carry
 * an endpoint that embeds a session token, so every failure leaves as a named
 * code and a fixed sentence.
 *
 * @module webRenderPage
 */

import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

import { HTML_MAX_BYTES } from "./webRead.mjs";
import { challengeVendor, SHELL_VISIBLE_CHARS } from "./webReadExtract.mjs";
import { assertPublicWebHost, validatedWebUrl, webReadError, WebReadError } from "./webReadNetwork.mjs";

/** Resource types never loaded: the text is what is read. */
const SKIPPED_RESOURCES = new Set(["image", "media", "font"]);
/** How long one quiet-network wait may take before the page is looked at again. */
const SETTLE_STEP_MS = 8_000;
/** Distinct hosts one render may reach. A document page draws on a handful —
 *  its own site, a CDN, a script host — and each new one is a DNS lookup here,
 *  a number a hostile page would otherwise choose. Counted, with every other
 *  request refused inside a page, in
 *  open_science_web_render_events_total{event="request_refused"}. */
export const MAX_HOSTS_PER_RENDER = 16;

/**
 * How a host a page asks for is resolved here: c-ares with a short timeout,
 * not getaddrinfo. The page picks how many names are looked up and how slowly
 * its own nameserver answers, and getaddrinfo holds one of libuv's four
 * threadpool threads — shared with this server's file reads and hashing — for
 * as long as that takes.
 * @returns {(hostname: string) => Promise<Array<{ address: string, family: number }>>}
 */
export function pageHostResolver() {
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
 * Wait until the page has drawn: the network goes quiet, and the document is
 * neither a vendor challenge nor an empty shell — a challenge page solves
 * itself and navigates, which takes a second quiet period to see. A look that
 * lands mid-navigation (the challenge reloading itself destroys the context
 * `evaluate` ran in) is simply another round.
 * @param {any} page @param {number} deadline @param {() => number} now
 */
async function settle(page, deadline, now) {
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
 * The page's final HTML. A challenge that reloads the page as the look is
 * taken leaves no context to evaluate in ("execution context was destroyed",
 * seen on NMPA by the knowledge plugin, 2026-09-22); the look is taken again,
 * three times at most, on the document that replaced it.
 * @param {any} page @param {number} deadline @param {() => number} now
 */
async function finalDrawing(page, deadline, now) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await drawnPage(page, HTML_MAX_BYTES);
    } catch (error) {
      if (attempt >= 3 || deadline - now() <= 0) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(2_000, deadline - now())) }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * @typedef {object} RenderCounts
 * @property {number} renders
 * @property {number} failures
 * @property {number} requestsRefused
 */

/**
 * Open `url` in a fresh context of `browser` and return what it drew.
 *
 * `contextOptions` are added to the context's own (a proxy, a user agent);
 * `browserName` is how the failure sentences name the browser. Errors leave
 * as WebReadErrors with fixed messages.
 *
 * `closeWebSockets`: stand in for every frame's WebSocket and close it before
 * it connects. It is how a browser with no egress of ours is kept from opening
 * one, and it is visible to the page: Playwright replaces `WebSocket` with a
 * script, and 瑞数 answers the reload of a page that has it with HTTP 400
 * (NMPA, measured 2026-09-28 against Chrome 150: 412→200 without it, 412→400
 * with it, nothing else changed). A browser whose every connection goes
 * through our egress (localBrowser.mjs) has no need of it.
 *
 * @param {{
 *   browser: any,
 *   url: URL,
 *   signal?: AbortSignal,
 *   deadline: number,
 *   now: () => number,
 *   resolveImpl: (hostname: string, options: { all: true }) => Promise<any>,
 *   counts: RenderCounts,
 *   contextOptions?: Record<string, any>,
 *   closeWebSockets?: boolean,
 *   browserName: string,
 *   onFailure?: () => WebReadError | null,
 * }} request `onFailure`: a provider's own reason the render failed (its
 *   egress hit a cap), consulted before the generic mapping
 * @returns {Promise<{ html: string, finalUrl: string, status: number }>}
 */
export async function renderInFreshContext({ browser, url, signal, deadline, now, resolveImpl, counts, contextOptions = {}, closeWebSockets = true, browserName, onFailure = () => null }) {
  /** @type {any} */
  let context = null;
  const onAbort = () => { void context?.close?.().catch?.(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true,
      locale: "zh-CN",
      viewport: { width: 1366, height: 900 },
      ...contextOptions,
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
    // On the context, not the page: a window the page opens is held to the
    // same rules, as are its workers' requests (measured).
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
    // A WebSocket's handshake is a request the route above never sees, and no
    // document needs one to draw its text: without an egress of ours, every
    // one is closed before it connects. Playwright does this by standing in
    // for the WebSocket of every frame; a dedicated worker's own WebSocket is
    // beyond it — its handshake still leaves, though the worker reads an
    // answer only from a WebSocket server — and CDP's URL blocking stopped no
    // WebSocket at all (both measured against Chromium 145 over CDP,
    // 2026-09-19). Where the browser runs on this host, its egress holds every
    // WebSocket, a worker's included, to public addresses instead.
    if (closeWebSockets) {
      await context.routeWebSocket(() => true, (/** @type {any} */ socket) => {
        counts.requestsRefused += 1;
        void Promise.resolve(socket.close({ code: 1008, reason: "Web reading opens no WebSockets." })).catch(() => {});
      });
    }
    const page = await context.newPage();
    let status = 0;
    page.on?.("response", (/** @type {any} */ response) => {
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
      } catch { /* a response we cannot classify is not the document's */ }
    });
    const first = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, deadline - now()) });
    if (!status) status = Number(first?.status?.()) || 0;
    await settle(page, deadline, now);
    const drawn = await finalDrawing(page, deadline, now);
    if (drawn.html === null) {
      throw webReadError(502, "web_read_response_too_large", "The rendered page exceeded the gateway's size limit.");
    }
    return { html: drawn.html, finalUrl: page.url(), status: status || 200 };
  } catch (error) {
    counts.failures += 1;
    const own = onFailure();
    if (own) throw own;
    if (error instanceof WebReadError) throw error;
    if (signal?.aborted) throw webReadError(499, "web_read_aborted", "The web read was abandoned.");
    if (error?.name === "TimeoutError" || now() >= deadline) {
      throw webReadError(504, "web_render_timeout", `The page did not finish drawing in the ${browserName} in time.`, { retryable: true });
    }
    throw webReadError(502, "web_render_failed", `The ${browserName} could not open this page.`, { retryable: true });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context?.close?.().catch?.(() => {});
    counts.renders += 1;
  }
}
