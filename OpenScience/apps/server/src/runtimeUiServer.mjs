/**
 * The kernel's browser application, served on an origin of its own.
 *
 * Why a second listener instead of a path under the control plane: the
 * application resolves everything it fetches against `location.origin`. Its
 * plugin bundles are `/plugins/??<packages>&rev=<hash>` and its method calls
 * are `/api/<namespace>/<name>`, both absolute, most of them built at run time
 * rather than written into the document. Served under `/api/runtime-ui/<id>/`
 * those requests arrive at the control plane, which answers them with its own
 * single-page document — so every request reads 200 and the application dies
 * at boot saying its bootstrap facade is missing. Rewriting `<base href>`, or
 * even every absolute path in the HTML, cannot reach the ones it constructs.
 *
 * The port is the only thing that differs from the control plane's origin, and
 * that is exactly the right amount: a different port is a different *origin*,
 * so the embedding page cannot read into the frame and the frame cannot read
 * out; but it is the same *site* — ports are not part of a site — so the
 * session cookie is sent with every request and the person in the frame is the
 * person who logged in.
 *
 * Which project the frame shows is this origin's own state, carried in a
 * cookie it sets from `?project=<id>` on the document request and validated
 * against that user's projects every time it is read. The application cannot
 * carry it any other way: a query parameter does not survive to the absolute
 * paths, and a header cannot be set by a navigation or by a WebSocket.
 *
 * @module apps/server/runtimeUiServer
 */

import { createServer } from "node:http";

import { isDeniedRuntimeUiMethod, runtimeUiMethodFromPath } from "@evimed/domain";
import { assertSpendWithinLimits } from "./usageMetering.mjs";

import { HttpError } from "./security.mjs";

/** The cookie naming the project this origin is showing. */
export /**
 * The methods that make the deployment spend money.
 *
 * Only prompting does: everything else the application calls reads state,
 * navigates or renders. Refusing those on a spend cap would lock someone out
 * of work they have already paid for.
 */
const RUNTIME_UI_SPENDING_METHODS = new Set(["session/prompt"]);

const RUNTIME_UI_PROJECT_COOKIE = "evimed_ui_project";

/** @param {any} req @param {string} name @returns {string} */
function cookieValue(req, name) {
  const header = String(req.headers?.cookie ?? "");
  for (const pair of header.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return "";
}

/** @param {any} req @param {Record<string, any>} config */
function hasSessionCookie(req, config) {
  return Boolean(cookieValue(req, String(config.sessionCookieName ?? "")));
}

/**
 * The project the frame should show, and whether the request asked to change
 * it. A request that names a project the caller does not own is refused by
 * `requireProject` rather than silently falling back — a frame quietly showing
 * a different project than the shell asked for is worse than an error.
 *
 * @param {any} req
 * @returns {{ requested: string, remembered: string }}
 */
function projectSelection(req) {
  const url = new URL(req.url ?? "/", "http://evimed-runtime-ui.local");
  return {
    requested: String(url.searchParams.get("project") ?? "").trim(),
    remembered: cookieValue(req, RUNTIME_UI_PROJECT_COOKIE).trim(),
  };
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
  /**
   * @param {any} req @param {any} res
   * @returns {Promise<Record<string, any>>} the project this request addresses
   */
  async function resolveProject(req, res) {
    const user = await store.ensureUser(req, res);
    const { requested, remembered } = projectSelection(req);
    if (requested) return { user, project: await store.requireProject(user, requested), pinned: true };
    if (remembered) return { user, project: await store.requireProject(user, remembered), pinned: false };
    return { user, project: await store.requireProject(user, "default"), pinned: false };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://evimed-runtime-ui.local");
    const pathname = url.pathname;

    if (!config.runtimeUiProxyEnabled) {
      sendNotice(res, 404, "未启用", "此部署没有开启内核界面。");
      return;
    }
    // An unauthenticated frame must not be handed a session: the cookie it
    // would receive is this deployment's, and minting one here would make a
    // frame a way in. It is told to log in, in the surface it is displayed in.
    if (!hasSessionCookie(req, config)) {
      sendNotice(res, 401, "请先登录", "请在 EviMed 中登录后重新打开。");
      return;
    }

    const method = runtimeUiMethodFromPath(pathname);
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

    const { project, pinned } = await resolveProject(req, res);

    // Where a turn begins on this surface. A run started inside the kernel's
    // application never passes through `/api/agent-runs/dispatch`, so a spend
    // cap that only guarded dispatch would be one the primary surface walks
    // around. It is this method and not the runtime's start, because starting
    // a runtime is what reading a transcript also does, and reading your own
    // finished work is not spending.
    if (RUNTIME_UI_SPENDING_METHODS.has(method)) {
      await assertSpendWithinLimits(config, project.userId);
    }
    // Pinning is a redirect rather than a rewrite so the application never
    // sees the query parameter: it would carry it into its own history and
    // into the URLs it builds, and a stale `?project=` in a bookmark would
    // silently repoint somebody's frame.
    if (pinned) {
      const target = new URL(url);
      target.searchParams.delete("project");
      res.writeHead(302, {
        Location: `${target.pathname}${target.search}${target.hash}`,
        "Set-Cookie": `${RUNTIME_UI_PROJECT_COOKIE}=${encodeURIComponent(project.id)}; Path=/; HttpOnly; SameSite=Lax${
          config.production ? "; Secure" : ""
        }`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    await runtimeManager.proxy(req, res, project, `${pathname}${url.search}`, {
      surface: "ui",
      uiBasePath: "/",
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
    void (async () => {
      try {
        if (!config.runtimeUiProxyEnabled) return destroyUpgrade(socket, 404, "not_found");
        if (!hasSessionCookie(req, config)) return destroyUpgrade(socket, 401, "unauthorized");
        const url = new URL(req.url ?? "/", "http://evimed-runtime-ui.local");
        const { project } = await resolveProject(req, null);
        await runtimeManager.proxyUpgrade(req, socket, head, project, `${url.pathname}${url.search}`);
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
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
