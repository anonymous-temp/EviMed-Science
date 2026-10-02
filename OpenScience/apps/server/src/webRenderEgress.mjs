/**
 * The only way out for a browser on this host: a forward proxy the control
 * plane opens for one render and closes when it ends.
 *
 * A browser that runs on the deployment's own network (localBrowser.mjs) is
 * the one thing web reading hands a page's script that could reach inside
 * that network. The page's requests are already refused by name when they
 * aim at a private address (webRenderPage.mjs), but two paths are beyond that
 * check: a name that answers the control plane's resolver with a public
 * address and the browser's with a private one (DNS rebinding — the browser
 * resolves after the check), and a dedicated worker's WebSocket, whose
 * handshake no route sees. Both close here, because the render's browser
 * context is given this proxy and so resolves nothing itself: every
 * connection it makes — page, frame, worker, WebSocket — arrives as a CONNECT
 * (or, for plain http, an absolute-form request) naming a host, and this
 * process resolves the name, refuses it when any address is private, and
 * connects to the very address it checked (webReadNetwork.pinnedPublicLookup).
 *
 * The proxy's own bounds, all per render:
 *
 * - it listens on the one address the browser reaches this process at, on a
 *   port the OS picks, and accepts connections from the browser's address
 *   alone; it is closed, with every tunnel it opened, when the render ends;
 * - ports 443 and 80 only — a public website is served on those, and a
 *   non-default port is the classic shape of reaching something that was
 *   never meant to be one;
 * - at most `maxHosts` distinct hosts and `maxConnections` connections at once;
 * - at most `maxBytes` downloaded, counted over every tunnel; past it every
 *   tunnel is cut and the render is refused as too large.
 *
 * TLS is end to end between the browser and the site (a CONNECT tunnel is
 * bytes), so what a challenge like 瑞数 inspects is the browser's own.
 *
 * @module webRenderEgress
 */

import http from "node:http";
import net from "node:net";

import { pinnedPublicLookup, privateHostname } from "./webReadNetwork.mjs";

/** Ports a page's connections may use: https and http (a ws:// handshake is tunnelled on 80). */
const EGRESS_PORTS = new Set([443, 80]);
/** How long a connection may sit silent before it is closed. */
const EGRESS_IDLE_TIMEOUT_MS = 30_000;
/** Request headers that are the proxy's business, not the site's. */
const HOP_HEADERS = new Set(["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]);

/** @param {string | undefined | null} address */
function plainAddress(address) {
  return String(address ?? "").replace(/^::ffff:/i, "");
}

/**
 * The address this process is reached at from `host`: the local end of a
 * connection to it, which is the interface the kernel routes that way.
 * @param {string} host @param {number} port @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export function localAddressToward(host, port, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      const address = plainAddress(socket.localAddress);
      socket.destroy();
      resolve(address);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * @typedef {object} EgressCounts
 * @property {number} requestsRefused connections or requests the proxy refused
 * @property {number} byteCaps renders cut at the byte cap
 */

/**
 * Open one render's egress.
 *
 * @param {{
 *   bindAddress: string,
 *   peerAddress: string,
 *   resolveImpl: (hostname: string, options: { all: true }) => Promise<any>,
 *   maxBytes: number,
 *   maxHosts: number,
 *   maxConnections?: number,
 *   counts: EgressCounts,
 *   connectImpl?: (options: { host: string, port: number }, signal?: AbortSignal) => net.Socket | Promise<net.Socket>,
 * }} options `maxConnections`: the browser's connections to the proxy at
 *   once (Chromium itself opens at most 32 to one proxy); `connectImpl` opens
 *   the upstream socket to an address that has already been checked (tests
 *   stand a local server in for the site)
 * @returns {Promise<{ proxyUrl: string, capped: () => boolean, downloaded: () => number, close: () => Promise<void> }>}
 */
export async function openRenderEgress({
  bindAddress,
  peerAddress,
  resolveImpl,
  maxBytes,
  maxHosts,
  maxConnections = 48,
  counts,
  connectImpl = (options) => net.connect(options),
}) {
  const lookup = pinnedPublicLookup(resolveImpl);
  const peer = plainAddress(peerAddress);
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  /** @type {Map<string, Promise<string>>} each host's checked address, resolved once */
  const hosts = new Map();
  let downloaded = 0;
  let capped = false;
  let closed = false;
  const connecting = new Set();
  const shutdown = new AbortController();
  let closing = null;

  function cutEverything() {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }

  /** @param {net.Socket} socket */
  function track(socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(EGRESS_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
  }

  /** @param {number} length */
  function received(length) {
    downloaded += length;
    if (downloaded > maxBytes && !capped) {
      capped = true;
      counts.byteCaps += 1;
      cutEverything();
    }
    return !capped;
  }

  /**
   * The checked address a host may be reached at, or a rejection.
   * @param {string} hostname
   * @returns {Promise<string>}
   */
  function checkedAddress(hostname) {
    const key = hostname.toLowerCase();
    let pending = hosts.get(key);
    if (!pending) {
      if (privateHostname(key)) return Promise.reject(new Error("private host"));
      if (hosts.size >= maxHosts) return Promise.reject(new Error("too many hosts"));
      pending = new Promise((resolve, reject) => {
        lookup(key, { all: true }, (error, records) => {
          if (error) {
            reject(error);
            return;
          }
          // Every address was checked; IPv4 first, as for every other
          // connection this process makes (webReadNetwork.preferIpv4Egress).
          const list = /** @type {Array<{ address: string, family: number }>} */ (records);
          resolve(String((list.find((record) => record.family === 4) ?? list[0]).address));
        });
      });
      pending.catch(() => {});
      hosts.set(key, pending);
    }
    return pending;
  }

  /**
   * An upstream socket to a checked address.
   * @param {string} hostname @param {number} port
   */
  async function upstream(hostname, port) {
    if (!EGRESS_PORTS.has(port)) throw new Error("port");
    const address = await checkedAddress(hostname);
    if (closed || capped) throw new Error("closed");
    const pending = Promise.resolve(connectImpl({ host: address, port }, AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)])));
    connecting.add(pending);
    try {
      const socket = await pending;
      if (closed || capped) { socket.destroy(); throw new Error("closed"); }
      track(socket);
      return socket;
    } finally { connecting.delete(pending); }
  }

  let clients = 0;
  const server = http.createServer();
  server.on("connection", (socket) => {
    if (plainAddress(socket.remoteAddress) !== peer || clients >= maxConnections || closed || capped) {
      counts.requestsRefused += 1;
      socket.destroy();
      return;
    }
    clients += 1;
    socket.once("close", () => { clients -= 1; });
    track(socket);
  });

  // https, and every WebSocket: a tunnel to host:port.
  server.on("connect", (request, client, head) => {
    const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(String(request.url ?? ""));
    const refuse = () => {
      counts.requestsRefused += 1;
      if (!client.destroyed) client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    };
    if (!match) {
      refuse();
      return;
    }
    const hostname = match[1];
    const port = Number(match[2]);
    upstream(hostname, port).then((remote) => {
      const wire = () => {
        if (client.destroyed || closed || capped) {
          remote.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) remote.write(head);
        remote.on("data", (chunk) => {
          if (received(chunk.length)) client.write(chunk);
        });
        client.on("data", (chunk) => remote.write(chunk));
        remote.once("end", () => client.end());
        client.once("end", () => remote.end());
        remote.once("close", () => client.destroy());
        client.once("close", () => remote.destroy());
      };
      if (remote.connecting) remote.once("connect", wire);
      else wire();
      remote.once("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      });
    }, refuse);
  });

  // Plain http: an absolute-form request, forwarded to the checked address.
  server.on("request", (request, response) => {
    const refuse = (/** @type {number} */ status) => {
      counts.requestsRefused += 1;
      response.writeHead(status, { "content-length": "0", connection: "close" }).end();
    };
    let target;
    try {
      target = new URL(String(request.url ?? ""));
    } catch {
      refuse(400);
      return;
    }
    if (target.protocol !== "http:" || target.username || target.password || (target.port && target.port !== "80")) {
      refuse(403);
      return;
    }
    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    headers.host = target.host;
    headers.connection = "close";
    upstream(target.hostname, 80).then((remote) => {
      const forwarded = http.request({
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
        createConnection: () => remote,
      }, (answer) => {
        const answerHeaders = { ...answer.headers };
        delete answerHeaders.connection;
        delete answerHeaders["keep-alive"];
        response.writeHead(answer.statusCode ?? 502, answerHeaders);
        answer.on("data", (chunk) => {
          if (received(chunk.length)) response.write(chunk);
        });
        answer.once("end", () => response.end());
        answer.once("error", () => response.destroy());
      });
      forwarded.once("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-length": "0", connection: "close" }).end();
        else response.destroy();
      });
      request.pipe(forwarded);
    }, () => refuse(403));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: bindAddress, port: 0 }, () => resolve(undefined));
  });
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;

  return {
    proxyUrl: `http://${host}:${port}`,
    capped: () => capped,
    downloaded: () => downloaded,
    async close() {
      closing ??= (async () => {
        closed = true;
        shutdown.abort();
        cutEverything();
        await Promise.allSettled([...connecting]);
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      })();
      await closing;
    },
  };
}
