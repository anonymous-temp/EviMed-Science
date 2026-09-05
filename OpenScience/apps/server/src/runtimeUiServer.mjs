/** The native browser application on an isolated origin, with immutable per-frame project bindings. */
import { createServer } from "node:http";

import { isDeniedRuntimeUiMethod, runtimeUiMethodFromPath } from "@evimed/domain";
import { assertSpendWithinLimits } from "./usageMetering.mjs";

import { HttpError } from "./security.mjs";
import { parseRuntimeUiFramePath, runtimeUiCookie, runtimeUiOrigins, validateRuntimeUiFrame } from "./runtimeUiFrames.mjs";
import { runtimeUiBootstrapSource } from "./runtimeUiDocument.mjs";

/**
 * The methods that make the deployment spend money.
 *
 * Only prompting does: everything else the application calls reads state,
 * navigates or renders. Refusing those on a spend cap would lock someone out
 * of work they have already paid for.
 */
export const RUNTIME_UI_SPENDING_METHODS = new Set(["session/prompt"]);

/** Browser cookies are accepted only from these explicit deployment origins.
 * Origin-less automation must use the control plane's authenticated API; this
 * browser surface deliberately has no implicit internal-client exception.
 * @param {any} req @param {Record<string, any>} config
 */
function assertBrowserOrigin(req, config) {
  const origin = req.headers.origin;
  const allowed = [config.runtimeUiPublicOrigin, config.publicUrl].some((value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.origin === origin;
    } catch { return false; }
  });
  if (typeof origin !== "string" || !allowed) {
    throw new HttpError(403, "runtime_ui_origin_denied", "The runtime UI requires an allowed browser Origin.");
  }
}

/** @param {Record<string, any>} config @param {any} project @param {string} method */
async function authorizeMethod(config, project, method) {
  if (isDeniedRuntimeUiMethod(method)) {
    throw new HttpError(403, "runtime_ui_method_denied", `${method} is not available in the hosted surface.`);
  }
  if (RUNTIME_UI_SPENDING_METHODS.has(method)) await assertSpendWithinLimits(config, project.userId);
}

/**
 * A page, not JSON, because everything served here is loaded by a browser as a
 * frame or a navigation: JSON would render as text the person cannot act on.
 *
 * @param {any} res @param {number} status @param {string} title @param {string} detail
 */
function sendNotice(res, status, title, detail) {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;`
    + `display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#3f3a36">`
    + `<div style="text-align:center"><p style="font-weight:600;margin:0 0 8px">${title}</p>`
    + `<p style="margin:0;color:#8a8178;font-size:14px">${detail}</p></div></body>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/** @param {any} socket @param {number} status @param {string} code */
function destroyUpgrade(socket, status, code) {
  try {
    socket.write(`HTTP/1.1 ${status} ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* the peer may already be gone */ }
  socket.destroy();
}

/**
 * @param {{ config: Record<string, any>, store: any, runtimeManager: any }} deps
 * @returns {{ server: import('node:http').Server, listen: (port?: number, host?: string) => Promise<any>, address: () => any, close: () => Promise<void> }}
 */
export function createRuntimeUiServer({ config, store, runtimeManager }) {
  const upgradeSockets = new Set();
  /**
   * @param {any} req @param {any} res
   * @returns {Promise<Record<string, any>>} the project this request addresses
   */
  async function resolveFrame(req, res) {
    const frame = parseRuntimeUiFramePath(req.url ?? "/");
    const { user, session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    const claims = validateRuntimeUiFrame({ config, req, user, session, frameId: frame.frameId });
    const project = await store.requireProject(user, claims.projectId);
    return { user, session, project, claims, frame };
  }

  async function handle(req, res) {
    if (!config.runtimeUiProxyEnabled) {
      sendNotice(res, 404, "未启用", "此部署没有开启内核界面。");
      return;
    }
    // An unauthenticated frame must not be handed a session: the cookie it
    // would receive is this deployment's, and minting one here would make a
    // frame a way in. It is told to log in, in the surface it is displayed in.
    if (!runtimeUiCookie(req, config.sessionCookieName)) {
      sendNotice(res, 401, "请先登录", "请在 EviMed 中登录后重新打开。");
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(String(req.method).toUpperCase())) assertBrowserOrigin(req, config);
    const { project, frame } = await resolveFrame(req, res);
    const pathname = new URL(frame.suffix, "http://runtime.local").pathname;
    const method = runtimeUiMethodFromPath(pathname);
    // Only canonical native API method names enter the policy. Decode solely
    // to detect a disguised /api namespace, never to rewrite or forward it.
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); } catch { throw new HttpError(400, "runtime_ui_endpoint_invalid", "A canonical runtime path is required."); }
    if ((pathname.startsWith("/api/") || decodedPath.startsWith("/api/"))
      && (!method || pathname !== `/api/${method}` || pathname !== decodedPath)) {
      throw new HttpError(400, "runtime_ui_endpoint_invalid", "A canonical native API method is required.");
    }
    const snapshot = { url: req.url, headers: { cookie: req.headers.cookie } };
    const revalidate = async () => { await resolveFrame(snapshot, null); };
    if (pathname === "/__evimed_bootstrap.js" && ["GET", "HEAD"].includes(req.method)) {
      const { installRuntimeUiTransport } = await import("@evimed/harness-port/runtime-ui-transport");
      await revalidate();
      const source = runtimeUiBootstrapSource({ version: 1, frameId: frame.frameId, projectId: project.id, prefix: frame.prefix, shellOrigin: runtimeUiOrigins(config).shellOrigin }, installRuntimeUiTransport);
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(Buffer.byteLength(source)), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : source);
      return;
    }
    if (isDeniedRuntimeUiMethod(method)) {
      // Named in the body so the page's own error surface says which one, and
      // named in the audit row by the proxy's target — the panels that call
      // these are hidden, so a call arriving here is worth seeing.
      const payload = JSON.stringify({
        error: { code: "runtime_ui_method_denied", message: `${method} is not available in the hosted surface.` },
      });
      res.writeHead(403, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(payload)),
        "Cache-Control": "no-store",
      });
      res.end(payload);
      return;
    }

    // Where a turn begins on this surface. A run started inside the kernel's
    // application never passes through `/api/agent-runs/dispatch`, so a spend
    // cap that only guarded dispatch would be one the primary surface walks
    // around. It is this method and not the runtime's start, because starting
    // a runtime is what reading a transcript also does, and reading your own
    // finished work is not spending.
    await authorizeMethod(config, project, method);
    await runtimeManager.proxy(req, res, project, frame.suffix, {
      surface: "ui",
      uiBasePath: frame.prefix,
      revalidate,
    });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 502;
      const code = error?.code ?? "runtime_ui_failed";
      sendNotice(res, status, "内核界面暂时不可用", String(code));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    void (async () => {
      try {
        if (!config.runtimeUiProxyEnabled) return destroyUpgrade(socket, 404, "not_found");
        if (!runtimeUiCookie(req, config.sessionCookieName)) return destroyUpgrade(socket, 401, "unauthorized");
        assertBrowserOrigin(req, config);
        const { project, frame } = await resolveFrame(req, null);
        // Revalidation keeps the exact ticket and login snapshot from this handshake.
        const snapshot = { url: req.url, headers: { cookie: req.headers.cookie } };
        const revalidate = async () => { await resolveFrame(snapshot, null); };
        const authorize = async (endpoint) => {
          if (typeof endpoint !== "string" || (endpoint !== "$events" && runtimeUiMethodFromPath(`/api/${endpoint}`) !== endpoint)) {
            throw new HttpError(400, "runtime_ui_endpoint_invalid", "A valid mux endpoint is required.");
          }
          await authorizeMethod(config, project, endpoint);
        };
        await runtimeManager.proxyUpgrade(req, socket, head, project, frame.suffix, { revalidate, authorize });
      } catch (error) {
        destroyUpgrade(socket, error?.status ?? 502, error?.code ?? "runtime_ui_upgrade_failed");
      }
    })();
  });

  return {
    server,
    /**
     * Bound when the deployment serves this surface, and not otherwise. The
     * switch decides, not the port: a port of 0 means "any free one", which is
     * what a test wants and what a production deployment must never be left
     * with -- readiness refuses that pair rather than binding somewhere nobody
     * can reach.
     */
    async listen(port = config.runtimeUiPort, host = config.host) {
      if (!config.runtimeUiProxyEnabled) return null;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    address() {
      return server.listening ? server.address() : null;
    },
    async close() {
      for (const socket of upgradeSockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
