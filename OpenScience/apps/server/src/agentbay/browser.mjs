/**
 * Tier 3 of web reading, AgentBay's provider: open a page in AgentBay's cloud
 * browser, let it draw, take its HTML back. Extraction happens in the gateway,
 * as for every page. What a render is — a fresh context, the request rules,
 * the settle loop, the size cap — lives in webRenderPage.mjs, shared with the
 * deployment's own headless Chromium (localBrowser.mjs).
 *
 * Why a remote browser (ruling 2026-09-19): an unknown page's script runs in
 * AgentBay's VM, not inside this network, so "the page's own JavaScript
 * probes internal addresses" is not a risk we manage — it is one we do not
 * have; and AgentBay's stealth fingerprint is made for the JavaScript
 * challenges NMPA, CDE and NHC answer a plain client with. No captcha is
 * solved (`solveCaptchas: false` — solving one is an interaction).
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

import { createAgentBayClient } from "./client.mjs";
import { ConcurrencyGate } from "../webReadLimits.mjs";
import { webReadError } from "../webReadNetwork.mjs";
import { pageHostResolver, renderInFreshContext } from "../webRenderPage.mjs";

/** AgentBay's browser image (ruling 2026-09-19); Browser Use images cannot be customised. */
export const WEB_RENDER_IMAGE_ID = "browser_latest";
/** Labels the render session carries, so an operator can tell it from a project runtime. */
export const WEB_RENDER_SESSION_LABELS = Object.freeze({ purpose: "evimed-web-render" });

/**
 * Whether this deployment could render through AgentBay: the render switch is
 * on and an AgentBay key file is named.
 * @param {any} config
 */
export function agentbayRenderConfigured(config) {
  return config?.webRenderEnabled === true && Boolean(String(config?.agentbayApiKeyFile ?? "").trim());
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
  const enabled = agentbayRenderConfigured(config);
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
      try {
        let session;
        try {
          session = await ensureWarm();
        } catch (error) {
          counts.renders += 1;
          counts.failures += 1;
          throw error;
        }
        return await renderInFreshContext({
          browser: session.browser, url, signal, deadline, now, resolveImpl, counts, browserName: "cloud browser",
          // A session that died under us is dropped, so the next render
          // starts a fresh one instead of failing against a dead endpoint
          // forever.
          onFailure: () => {
            if (warm && warm.browser.isConnected?.() === false) warm = null;
            return null;
          },
        });
      } finally {
        inFlight -= 1;
        if (inFlight === 0) scheduleRelease();
      }
    }, { signal });
  }

  return {
    enabled,
    provider: "agentbay",
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
