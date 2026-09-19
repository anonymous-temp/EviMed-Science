/**
 * The one module that talks to the AgentBay SDK (contract X3).
 *
 * STAND-IN. The runtime-provider stream owns this file and ships the real one
 * (pinned `wuying-agentbay-sdk`, the runtime provider's own needs). This copy
 * exists so the web stream's browser tier (`browser.mjs`) builds and is tested
 * against the same export; at merge the provider stream's file replaces it.
 * It implements exactly the minimal surface the contract names and nothing
 * the runtime provider needs beyond it.
 *
 * Hidden knowledge that survives the swap: vendor SDKs repeat a rejected key
 * in their own error text and log it themselves (AgentBay's did on
 * 2026-09-19, with a Bailian key shaped `sk-ws-…` that no pattern mask
 * caught). So nothing the SDK throws is passed on — only a named code and a
 * fixed sentence — its console logger is switched off, and the key is read
 * from its file here and nowhere else.
 *
 * @module agentbay/client
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

export class AgentBayError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "AgentBayError";
    this.code = code;
  }
}

/** @param {string} file */
async function readKey(file) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024) throw new Error("invalid key file");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("key file permissions are too broad");
    const value = (await handle.readFile("utf8")).trim();
    if (!value || /\s/.test(value)) throw new Error("invalid key");
    return value;
  } catch {
    throw new AgentBayError("agentbay_key_unavailable", "The AgentBay API key file is missing, unreadable or unsafe.");
  } finally {
    await handle?.close();
  }
}

/**
 * @param {{ agentbayApiKeyFile?: string, agentbayRegion?: string, agentbayEndpoint?: string }} config
 * @param {{ sdk?: any }} [options] the SDK module, injectable for tests
 */
export async function createAgentBayClient(config, { sdk = null } = {}) {
  const keyFile = String(config?.agentbayApiKeyFile ?? "").trim();
  if (!keyFile) throw new AgentBayError("agentbay_unconfigured", "AgentBay is not configured for this deployment.");
  const apiKey = await readKey(keyFile);
  let module = sdk;
  if (!module) {
    try {
      // A variable specifier: the SDK is pinned by the runtime-provider
      // stream, and a literal would make the type check resolve a package
      // this branch does not install.
      const specifier = "wuying-agentbay-sdk";
      module = await import(specifier);
    } catch {
      throw new AgentBayError("agentbay_sdk_unavailable", "The AgentBay SDK is not installed in this build.");
    }
  }
  try {
    module.setupLogger?.({ level: "ERROR", enableConsole: false });
  } catch { /* a logger that cannot be configured is still silenced by never seeing our errors */ }
  const region = String(config?.agentbayRegion ?? "").trim() || "cn-hangzhou";
  const endpoint = String(config?.agentbayEndpoint ?? "").trim();
  let agentBay;
  try {
    agentBay = new module.AgentBay({ apiKey, config: { region_id: region, ...(endpoint ? { endpoint } : {}) } });
  } catch {
    throw new AgentBayError("agentbay_client_invalid", "The AgentBay client could not be created.");
  }
  /** @type {Map<string, any>} */
  const sessions = new Map();

  /**
   * @template T
   * @param {string} code @param {string} message @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  const call = async (code, message, work) => {
    try {
      return await work();
    } catch {
      throw new AgentBayError(code, message);
    }
  };

  const client = {
    /**
     * @param {{ imageId: string, labels?: Record<string, string>, contextSync?: any[], policyId?: string } & Record<string, any>} params
     * @returns {Promise<{ sessionId: string, session: any }>}
     */
    async createSession({ imageId, labels = {}, contextSync, policyId, ...extra }) {
      const result = await call("agentbay_session_create_failed", "AgentBay did not create a session.", () => agentBay.create({
        imageId, labels, ...(contextSync ? { contextSync } : {}), ...(policyId ? { policyId } : {}), ...extra,
      }));
      const session = result?.success ? result.session : null;
      if (!session?.sessionId) throw new AgentBayError("agentbay_session_create_failed", "AgentBay did not create a session.");
      sessions.set(session.sessionId, session);
      return { sessionId: String(session.sessionId), session };
    },
    /** @param {string} sessionId */
    async getSession(sessionId) {
      const known = sessions.get(sessionId);
      if (known) return { sessionId, session: known };
      const result = await call("agentbay_session_unavailable", "AgentBay could not find the session.", () => agentBay.get(sessionId));
      if (!result?.success || !result.session) throw new AgentBayError("agentbay_session_unavailable", "AgentBay could not find the session.");
      sessions.set(sessionId, result.session);
      return { sessionId, session: result.session };
    },
    /** @param {string} sessionId @param {{ syncContext?: boolean }} [options] */
    async deleteSession(sessionId, { syncContext = false } = {}) {
      const { session } = await client.getSession(sessionId);
      const result = await call("agentbay_session_delete_failed", "AgentBay did not release the session.", () => agentBay.delete(session, syncContext));
      sessions.delete(sessionId);
      if (result && result.success === false) throw new AgentBayError("agentbay_session_delete_failed", "AgentBay did not release the session.");
    },
    /** @param {{ labels?: Record<string, string> }} [options] */
    async listSessions({ labels = {} } = {}) {
      const result = await call("agentbay_session_list_failed", "AgentBay did not list sessions.", () => agentBay.list(labels));
      return Array.isArray(result?.sessionIds) ? result.sessionIds : [];
    },
  };
  return client;
}
