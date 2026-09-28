/**
 * Which browser draws a page for web reading. Two providers, one switch
 * (`OPEN_SCIENCE_WEB_RENDER_ENABLED`):
 *
 * - the deployment's own headless Chromium when its DevTools address is
 *   configured (`OPEN_SCIENCE_WEB_RENDER_CDP_URL`; the knowledge overlay points
 *   it at `frontier-browser`) — localBrowser.mjs;
 * - otherwise AgentBay's cloud browser when an AgentBay key file is named —
 *   agentbay/browser.mjs.
 *
 * With neither, or with the switch off, a page that needs a browser is the
 * named error `web_read_needs_browser` and the run uses another source.
 *
 * @module webRender
 */

import { agentbayRenderConfigured, createWebRenderer as createAgentBayWebRenderer } from "./agentbay/browser.mjs";
import { createLocalWebRenderer, localRenderConfigured } from "./localBrowser.mjs";
import { webReadError } from "./webReadNetwork.mjs";

/**
 * The provider this configuration renders with, or null.
 * @param {any} config
 * @returns {"local" | "agentbay" | null}
 */
export function webRenderProvider(config) {
  if (localRenderConfigured(config)) return "local";
  if (agentbayRenderConfigured(config)) return "agentbay";
  return null;
}

/**
 * @param {any} config
 * @param {{ local?: Parameters<typeof createLocalWebRenderer>[1], agentbay?: Parameters<typeof createAgentBayWebRenderer>[1] }} [dependencies]
 * @returns {import("./webRead.mjs").WebRenderer}
 */
export function createConfiguredWebRenderer(config, { local, agentbay } = {}) {
  const provider = webRenderProvider(config);
  if (provider === "local") return createLocalWebRenderer(config, local);
  if (provider === "agentbay") return createAgentBayWebRenderer(config, agentbay);
  return {
    enabled: false,
    provider: null,
    async render() {
      throw webReadError(503, "web_render_disabled", "Page rendering is switched off in this deployment.");
    },
    stats: () => null,
  };
}
