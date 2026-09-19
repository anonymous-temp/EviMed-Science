/**
 * The control plane's end of the `wss` runtime transport (plan §3.1 #3).
 *
 * Every piece of code that talks to a kernel — the unary calls
 * (`requestRuntime`), the event mux (`dshMux.mjs`) and the kernel's own
 * application proxied to the browser (`runtimeUiMuxProxy.mjs`) — dials a unix
 * socket with `Host: dsh.runtime`, because that is the Docker transport. This
 * tunnel is that socket for a runtime that lives in an AgentBay session: it
 * listens on a private unix socket beside the Docker ones and relays each
 * request to the session's link — HTTP to the `https` link, WebSocket upgrades
 * to the `wss` link — adding the per-session bridge secret on the way. So the
 * kernel receives exactly what it receives today (the session bridge restores
 * `Host`), none of those three callers changes, and the recorded golden frames
 * stay what they are: transport is not part of them.
 *
 * The browser never sees an AgentBay address: everything it loads still comes
 * from the control plane, which reaches the session only through here.
 *
 * @module agentbay/linkTunnel
 */

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

// The session bridge's own names (deploy/runtime-dsh/evimed-session-bridge.mjs).
// Written out here because the web image does not carry the runtime image's
// files; `agentbayTransport.test.mjs` holds the two copies equal.
export const BRIDGE_MARKER = "/__evimed_bridge/";
export const BRIDGE_SECRET_HEADER = "x-evimed-bridge-secret";
export const BRIDGE_TARGET_HEADER = "x-evimed-bridge-target";
export const BRIDGE_HEALTH_PATH = "/__evimed_bridge/healthz";

/** Headers of one hop, never relayed. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host",
]);

/** @param {URL} url */
function transportFor(url) {
  return url.protocol === "https:" || url.protocol === "wss:" ? https : http;
}

/**
 * The link URL a kernel path is reached at.
 *
 * The `https` link ends in its own path (`…/request_ai/<token>/path/`) and
 * what follows it is what the session's service receives; the `wss` link is a
 * single endpoint (`…/websocket_ai/<token>`), so a WebSocket's kernel path can
 * only travel in the target header — or, in path mode, as a suffix the proxy
 * may or may not forward, which is what the first live bring-up checks.
 *
 * @param {string} link @param {string} kernelPath path and query the kernel should see
 * @param {{ secret: string, mode: 'header'|'path', websocket: boolean }} options
 * @returns {URL}
 */
export function linkTarget(link, kernelPath, { secret, mode, websocket }) {
  const base = new URL(link);
  const protocol = base.protocol === "wss:" ? "https:" : base.protocol === "ws:" ? "http:" : base.protocol;
  // Raw, never re-encoded: the kernel's own bundle addresses carry a combo
  // query (`/plugins/??a,b&rev=…`) that a query parser would rewrite into a
  // different request.
  const cut = kernelPath.indexOf("?");
  const rawPath = cut < 0 ? kernelPath : kernelPath.slice(0, cut);
  const rawQuery = cut < 0 ? "" : kernelPath.slice(cut);
  if (!rawPath.startsWith("/")) throw new Error("A kernel path is absolute.");
  if (mode === "header" && websocket) return new URL(`${protocol}//${base.host}${base.pathname}${base.search}`);
  const prefix = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const pathname = mode === "path"
    ? `${prefix}${BRIDGE_MARKER}${encodeURIComponent(secret)}${rawPath}`
    : `${prefix}${rawPath}`;
  const query = base.search ? (rawQuery ? `${base.search}&${rawQuery.slice(1)}` : base.search) : rawQuery;
  return new URL(`${protocol}//${base.host}${pathname}${query}`);
}

/**
 * @param {{ socketPath: string, secret: string, mode?: 'header'|'path', links: { http: string, ws: string } }} options
 */
export function createLinkTunnel({ socketPath, secret, mode = "header", links }) {
  if (!["header", "path"].includes(mode)) throw new Error(`Unknown bridge secret mode ${mode}.`);
  let current = { ...links };
  const agents = {
    https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
    http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  };
  /** Relayed WebSocket pairs, dropped together when the link is replaced. */
  const upgraded = new Set();
  const clients = new Set();

  /** Headers for the link: this hop's removed, the secret added in header mode. */
  function outboundHeaders(headers, kernelPath) {
    /** @type {Record<string, string | string[]>} */
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value == null || HOP_BY_HOP.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    if (mode === "header") {
      out[BRIDGE_SECRET_HEADER] = secret;
      out[BRIDGE_TARGET_HEADER] = kernelPath;
    }
    return out;
  }

  const server = http.createServer((req, res) => {
    const kernelPath = String(req.url ?? "/");
    let url;
    try {
      url = linkTarget(current.http, kernelPath, { secret, mode, websocket: false });
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "runtime_link_invalid" }));
      return;
    }
    const transport = transportFor(url);
    const upstream = transport.request(url, {
      method: req.method,
      headers: outboundHeaders(req.headers, kernelPath),
      agent: transport === https ? agents.https : agents.http,
    }, (response) => {
      /** @type {Record<string, string | string[]>} */
      const headers = {};
      for (const [name, value] of Object.entries(response.headers)) {
        const lower = name.toLowerCase();
        // The bridge asks the link proxy not to buffer; the header is for the
        // proxy, not for the kernel's caller.
        if (value == null || lower === "x-accel-buffering" || (HOP_BY_HOP.has(lower) && lower !== "host")) continue;
        headers[name] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
    });
    upstream.once("error", () => {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "runtime_link_unavailable" }));
      }
    });
    req.pipe(upstream);
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
  });

  server.on("upgrade", (req, socket, head) => {
    const kernelPath = String(req.url ?? "/");
    let url;
    try {
      url = linkTarget(current.ws, kernelPath, { secret, mode, websocket: true });
    } catch {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const transport = transportFor(url);
    /** @type {Record<string, string | string[]>} */
    const headers = outboundHeaders(req.headers, kernelPath);
    // The upgrade itself is end to end: the kernel answers the client's key.
    headers.connection = "Upgrade";
    headers.upgrade = String(req.headers.upgrade ?? "websocket");
    const upstream = transport.request(url, { method: "GET", headers, agent: false });
    upstream.once("upgrade", (response, remote, remoteHead) => {
      const lines = [`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index].toLowerCase() === "x-accel-buffering") continue;
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (remoteHead?.length) socket.write(remoteHead);
      if (head?.length) remote.write(head);
      const pair = { socket, remote };
      upgraded.add(pair);
      const close = () => { upgraded.delete(pair); remote.destroy(); socket.destroy(); };
      remote.once("close", close);
      socket.once("close", close);
      remote.once("error", close);
      socket.once("error", close);
      remote.pipe(socket);
      socket.pipe(remote);
    });
    upstream.once("response", (response) => {
      // A refused upgrade: say so to the caller in HTTP, which is what a
      // WebSocket client reads a failed handshake as.
      const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}`, "Connection: close"];
      socket.write(`${lines.join("\r\n")}\r\nContent-Length: 0\r\n\r\n`);
      response.resume();
      socket.end();
    });
    upstream.once("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    socket.once("error", () => upstream.destroy());
    upstream.end();
  });
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    socketPath,

    async listen() {
      await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(socketPath), 0o700);
      await fs.rm(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.removeListener("error", reject); resolve(undefined); });
      });
      await fs.chmod(socketPath, 0o600);
    },

    /** New links for the same session: an expired link token, a refreshed
     *  session. Relayed WebSockets on the old link are cut so their owners —
     *  the event pump, the browser's mux — reconnect on the new one. */
    replaceLinks(next) {
      current = { ...next };
      this.dropUpgraded();
    },

    dropUpgraded() {
      for (const pair of [...upgraded]) {
        pair.remote.destroy();
        pair.socket.destroy();
      }
      upgraded.clear();
    },

    /**
     * The bridge's own answer, through the link: whether the link reaches the
     * session and whether the kernel behind it accepts connections.
     * @param {number} [timeoutMs]
     * @returns {Promise<{ ok: boolean, upstream: boolean, status: number | null }>}
     */
    probe(timeoutMs = 5_000) {
      return new Promise((resolve) => {
        let url;
        try {
          url = linkTarget(current.http, BRIDGE_HEALTH_PATH, { secret, mode, websocket: false });
        } catch {
          resolve({ ok: false, upstream: false, status: null });
          return;
        }
        const transport = transportFor(url);
        const request = transport.request(url, {
          method: "GET",
          headers: outboundHeaders({}, BRIDGE_HEALTH_PATH),
          agent: transport === https ? agents.https : agents.http,
          timeout: timeoutMs,
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => { if (chunks.length < 64) chunks.push(chunk); });
          response.once("end", () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
            resolve({ ok: response.statusCode === 200 && body?.ok === true, upstream: body?.upstream === true, status: response.statusCode ?? null });
          });
          response.once("error", () => resolve({ ok: false, upstream: false, status: response.statusCode ?? null }));
        });
        request.once("timeout", () => request.destroy(new Error("probe timed out")));
        request.once("error", () => resolve({ ok: false, upstream: false, status: null }));
        request.end();
      });
    },

    async close() {
      this.dropUpgraded();
      for (const socket of [...clients]) socket.destroy();
      agents.https.destroy();
      agents.http.destroy();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve(undefined)));
      await fs.rm(socketPath, { force: true }).catch(() => {});
    },
  };
}
