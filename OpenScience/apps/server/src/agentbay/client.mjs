/**
 * The AgentBay client: the one module that imports `wuying-agentbay-sdk`
 * (contract X3). The runtime provider and the web-reading stream's cloud
 * browser both build on `createAgentBayClient`; nothing else in the control
 * plane names the SDK, so an upgrade or a replacement is this file.
 *
 * Three things the SDK does that a control plane cannot let it do, each
 * found by reading 0.22.0's own source rather than its documentation:
 *
 * 1. **It reads `.env` files into `process.env`.** Once when the module is
 *    first imported and again in every `new AgentBay()`, it walks upward from
 *    the working directory to the first `.env` it finds and copies every key
 *    the process does not already have. A server that imports it would take
 *    whatever configuration a stray file above its working directory says.
 *    The import below restores the environment it found, and the constructor
 *    is handed `/dev/null` as its env file, which it reads, finds empty, and
 *    stops at.
 * 2. **Its logger writes to stdout and stderr on its own**, including every
 *    API call and the session links it resolved (a link carries the session's
 *    access token in its path), and it printed a rejected API key verbatim on
 *    2026-09-19. Console logging is switched off before first use.
 * 3. **Its errors carry what it was given.** Every failure leaving this module
 *    is rebuilt from a message scrubbed of the exact key and of link tokens,
 *    never passed through, and never given the original as a `cause`.
 *
 * The key is read from `OPEN_SCIENCE_AGENTBAY_API_KEY_FILE` here, on first
 * use, under the rules config.mjs holds every secret file to; it is kept in
 * this closure and nowhere else — not on the config object, not in a runtime.
 *
 * @module agentbay/client
 */

import fs from "node:fs";
import { HttpError } from "../security.mjs";

export const AGENTBAY_SDK_PACKAGE = "wuying-agentbay-sdk";

/** What replaces a secret wherever one would have been printed. */
export const REDACTED = "[redacted]";

/**
 * A key file, read under the rules config.mjs applies to every secret file: a
 * regular file reached without following a link, readable by its owner only,
 * at most 8 KiB after one line terminator.
 * @param {string} file
 * @returns {{ value: string, error: string | null }}
 */
export function readAgentBayKeyFile(file) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return { value: "", error: "agentbay_api_key_file_not_regular" };
    if (stat.size > 8 * 1024 + 2) return { value: "", error: "agentbay_api_key_file_too_large" };
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return { value: "", error: "agentbay_api_key_file_permissions" };
    const value = fs.readFileSync(handle, "utf8").replace(/\r?\n$/, "");
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) return { value: "", error: "agentbay_api_key_file_invalid" };
    return { value, error: null };
  } catch (error) {
    return { value: "", error: error?.code === "ELOOP" ? "agentbay_api_key_file_symlink" : "agentbay_api_key_file_unavailable" };
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

/**
 * A text with every secret it could carry removed: the exact values given, and
 * the access token in any session link (`/websocket_ai/<token>`,
 * `/request_ai/<token>`) — a link is a credential to the session's ports.
 * Exact values, not key shapes: a shape regex missed the Bailian key in
 * 2026-09-19's leak because it had a form the pattern had not seen.
 * @param {unknown} text @param {readonly string[]} secrets
 * @returns {string}
 */
export function scrubAgentBayText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  return out.replace(/\b(websocket_ai|request_ai)\/[^/?#\s"'`]+/g, `$1/${REDACTED}`);
}

/**
 * The SDK module, imported without letting its `.env` loader change this
 * process's environment: every variable it added is removed again. Its loader
 * only adds keys the process lacks, so removing exactly those restores the
 * environment it found.
 */
async function importSdk() {
  const before = new Set(Object.keys(process.env));
  try {
    return await import(AGENTBAY_SDK_PACKAGE);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
  }
}

/**
 * @typedef {object} AgentBayClient
 * @property {boolean} configured whether a key file is named at all
 * @property {string} region
 * @property {(input: { imageId?: string, labels?: Record<string, string>, contextSync?: { contextId: string, path: string, policy?: Record<string, any> }[], policyId?: string, lifecycle?: { idleMinutes?: number, maxRuntimeMinutes?: number }, enableBrowserReplay?: boolean }) => Promise<{ sessionId: string, session: any }>} createSession
 *   `contextSync` entries are plain descriptors; the SDK's own objects are built here
 * @property {(sessionId: string) => Promise<{ sessionId: string, session: any } | null>} getSession
 * @property {(sessionId: string, options?: { syncContext?: boolean }) => Promise<{ deleted: boolean, missing: boolean }>} deleteSession
 * @property {(input?: { labels?: Record<string, string>, status?: string }) => Promise<{ sessionId: string, status: string }[]>} listSessions
 * @property {{ get: (name: string, options?: { create?: boolean }) => Promise<{ id: string, name: string } | null>,
 *   uploadUrl: (contextId: string, path: string) => Promise<string>,
 *   downloadUrl: (contextId: string, path: string) => Promise<string>,
 *   listFiles: (contextId: string, folder: string, options?: { nextToken?: string, maxResults?: number }) => Promise<{ entries: { path: string, type: string, size: number | null, modified: string | null }[], nextToken: string | null }>,
 *   deleteFile: (contextId: string, path: string) => Promise<boolean> }} contexts
 * @property {<T>(label: string, operation: () => Promise<T>) => Promise<T>} guard
 *   runs a call on a session object (`session.command`, `session.fileSystem`,
 *   `session.getLink`, …) with this client's scrubbing, so a caller holding a
 *   session never meets a raw SDK error
 * @property {() => Promise<string>} sdkVersion
 */

/**
 * @param {Record<string, any>} config the control plane's config: `agentbayApiKeyFile`, `agentbayRegion`, `agentbayEndpoint`
 * @param {{ sdk?: any, readKey?: (file: string) => { value: string, error: string | null } }} [options]
 *   `sdk` replaces the imported module (tests hand in a fake with the same surface)
 * @returns {AgentBayClient}
 */
export function createAgentBayClient(config, { sdk = null, readKey = readAgentBayKeyFile } = {}) {
  const keyFile = String(config?.agentbayApiKeyFile ?? "").trim();
  const region = String(config?.agentbayRegion ?? "cn-hangzhou").trim() || "cn-hangzhou";
  const endpoint = String(config?.agentbayEndpoint ?? "").trim();
  /** @type {Promise<{ module: any, agentBay: any, key: string }> | null} */
  let loading = null;
  /** The exact secrets to scrub, known once the key has been read. */
  const secrets = [];

  const fail = (status, code, message) => new HttpError(status, code, scrubAgentBayText(message, secrets));

  function load() {
    loading ??= (async () => {
      if (!keyFile) throw fail(503, "agentbay_unconfigured", "AgentBay is not configured: OPEN_SCIENCE_AGENTBAY_API_KEY_FILE is empty.");
      const { value: key, error } = readKey(keyFile);
      if (error) throw fail(503, error, "The AgentBay API key file could not be read.");
      secrets.push(key);
      const module = sdk ?? await importSdk();
      // Before the first call: the logger is module state, and a call made
      // with it still on prints the request line and the resolved links.
      module.setupLogger?.({ enableConsole: false, logFile: "", level: "ERROR" });
      const agentBay = new module.AgentBay({
        apiKey: key,
        // An explicit endpoint is the operator's choice; otherwise the SDK
        // derives the region's own. Passing both makes it warn and drop one.
        config: endpoint ? { endpoint } : { region_id: region },
        envFile: "/dev/null",
      });
      return { module, agentBay, key };
    })();
    // A failed load is not cached: fixing the key file must not need a restart.
    loading.catch(() => { loading = null; });
    return loading;
  }

  /**
   * One SDK call, with its failure rebuilt: a thrown error or an unsuccessful
   * result becomes an HttpError whose message has been scrubbed.
   * @template T @param {string} label @param {(loaded: { module: any, agentBay: any }) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async function call(label, operation) {
    const loaded = await load();
    let result;
    try {
      result = await operation(loaded);
    } catch (error) {
      if (error instanceof HttpError) throw fail(error.status, error.code, error.message);
      throw fail(502, "agentbay_request_failed", `AgentBay ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  /** An SDK result object that reports failure, as a thrown error. */
  function refused(label, result, code = "agentbay_request_failed") {
    return fail(502, code, `AgentBay ${label} failed: ${result?.errorMessage ?? "no reason given"}`);
  }

  return {
    configured: Boolean(keyFile),
    region,

    async createSession({ imageId, labels = {}, contextSync = [], policyId, lifecycle, enableBrowserReplay } = {}) {
      return call("session create", async ({ module, agentBay }) => {
        const params = {
          ...(imageId ? { imageId } : {}),
          labels: { ...labels },
          ...(contextSync.length
            ? { contextSync: contextSync.map((entry) => new module.ContextSync(String(entry.contextId), String(entry.path), entry.policy)) }
            : {}),
          ...(policyId ? { policyId } : {}),
          // The render tier (browser.mjs) turns the SDK's browser recording off:
          // what a run reads is nobody else's record.
          ...(typeof enableBrowserReplay === "boolean" ? { enableBrowserReplay } : {}),
          ...(lifecycle ? {
            lifecyclePolicy: new module.LifecyclePolicy({
              idleReleaseTimeout: Math.max(3, Math.floor(Number(lifecycle.idleMinutes) || 30)),
              maxRuntime: Math.max(1, Math.floor(Number(lifecycle.maxRuntimeMinutes) || 240)),
            }),
          } : {}),
        };
        const result = await agentBay.create(params);
        if (!result?.success || !result.session) throw refused("session create", result, "agentbay_session_create_failed");
        return { sessionId: String(result.session.sessionId), session: result.session };
      });
    },

    async getSession(sessionId) {
      return call("session lookup", async ({ agentBay }) => {
        const result = await agentBay.get(String(sessionId));
        if (!result?.success || !result.session) return null;
        return { sessionId: String(result.session.sessionId ?? sessionId), session: result.session };
      });
    },

    async deleteSession(sessionId, { syncContext = false } = {}) {
      return call("session delete", async ({ agentBay }) => {
        const found = await agentBay.get(String(sessionId));
        if (!found?.success || !found.session) return { deleted: false, missing: true };
        const result = await agentBay.delete(found.session, Boolean(syncContext));
        if (!result?.success) throw refused("session delete", result, "agentbay_session_delete_failed");
        return { deleted: true, missing: false };
      });
    },

    async listSessions({ labels = {}, status = "RUNNING" } = {}) {
      return call("session list", async ({ agentBay }) => {
        /** @type {{ sessionId: string, status: string }[]} */
        const found = [];
        // Bounded: a label set names one project, so more than a page of live
        // sessions for it is itself the anomaly to report, not to walk.
        for (let page = 1; page <= 10; page += 1) {
          const result = await agentBay.list({ ...labels }, page, 50, status || undefined);
          if (result?.success === false) throw refused("session list", result);
          const rows = Array.isArray(result?.sessionIds) ? result.sessionIds : [];
          for (const row of rows) {
            if (row?.sessionId) found.push({ sessionId: String(row.sessionId), status: String(row.sessionStatus ?? "") });
          }
          if (rows.length < 50) break;
        }
        return found;
      });
    },

    contexts: {
      async get(name, { create = false } = {}) {
        return call("context lookup", async ({ agentBay }) => {
          const result = await agentBay.context.get(String(name), Boolean(create));
          if (!result?.success || !result.context) {
            if (!create) return null;
            throw refused("context lookup", result, "agentbay_context_failed");
          }
          return { id: String(result.context.id ?? result.contextId), name: String(result.context.name ?? name) };
        });
      },
      async uploadUrl(contextId, filePath) {
        return call("context upload url", async ({ agentBay }) => {
          const result = await agentBay.context.getFileUploadUrl(String(contextId), String(filePath));
          if (!result?.success || !result.url) throw refused("context upload url", result, "agentbay_context_failed");
          return String(result.url);
        });
      },
      async downloadUrl(contextId, filePath) {
        return call("context download url", async ({ agentBay }) => {
          const result = await agentBay.context.getFileDownloadUrl(String(contextId), String(filePath));
          if (!result?.success || !result.url) throw refused("context download url", result, "agentbay_context_failed");
          return String(result.url);
        });
      },
      async listFiles(contextId, folder, { nextToken, maxResults = 200 } = {}) {
        return call("context file list", async ({ agentBay }) => {
          const result = await agentBay.context.listFiles(String(contextId), String(folder), 1, 50, maxResults, nextToken);
          if (!result?.success) throw refused("context file list", result, "agentbay_context_failed");
          return {
            entries: (Array.isArray(result.entries) ? result.entries : []).map((entry) => ({
              path: String(entry.filePath ?? ""),
              type: String(entry.fileType ?? ""),
              size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
              modified: typeof entry.gmtModified === "string" ? entry.gmtModified : null,
            })),
            nextToken: typeof result.nextToken === "string" && result.nextToken ? result.nextToken : null,
          };
        });
      },
      async deleteFile(contextId, filePath) {
        return call("context file delete", async ({ agentBay }) => {
          const result = await agentBay.context.deleteFile(String(contextId), String(filePath));
          return result?.success !== false;
        });
      },
    },

    guard(label, operation) {
      return call(label, () => operation());
    },

    async sdkVersion() {
      return call("version", async ({ module }) => String(module.VERSION ?? ""));
    },
  };

}
