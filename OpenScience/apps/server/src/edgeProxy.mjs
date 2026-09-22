// The Tokyo node as an egress for the upstreams Beijing cannot reach.
//
// Measured on 2026-09-22 from the production host, with the platform's own
// crawler identity: of the 79 hosts the gateways talk to, 72 answer from Beijing
// directly and should keep doing so — through the node every new connection
// pays two extra TLS handshakes, 1–2 s. Three do not answer from Beijing and do
// through the node: GTEx (one request in three stalled past 20 s), OMIM
// (refused by Cloudflare) and Materials Project (refuses the Tencent ASN; 403
// direct, 200 through the node with the same key). The open web is the larger
// gap: Beijing's SearXNG answered 1 of 20 medical queries, the node's 20 of 20,
// and pages refused from Beijing (NICE, Fierce, BBC) read from Tokyo.
//
// The node runs a TLS forward proxy (squid on 443 with a short-lived IP
// certificate, basic credentials, the Beijing host's address as its only
// client, private destinations refused except the node's own SearXNG). This
// module talks to it with node:tls alone: an HTTPS target goes through a CONNECT
// tunnel, so TLS runs end to end and the proxy sees a host name and nothing
// else; a plain-HTTP target — only the node's SearXNG — goes in absolute form
// inside the TLS leg to the proxy. A proxy URL with `http:` is accepted for
// tests; production names `https:`.
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";

const MAX_CONNECT_HEADER_BYTES = 16 * 1024;

/** A retryable failure of the node itself, never of the upstream behind it. */
export class EdgeProxyError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status) {
    super(message);
    this.name = "EdgeProxyError";
    this.code = code;
    this.status = status ?? null;
  }
}

/**
 * The node this deployment is configured with, or null when it has none.
 * Credentials are `user:password`, read from a secret file by config.mjs.
 * @param {Record<string, any>} config
 * @returns {{ url: URL, authorization: string, hosts: Set<string>, connectTimeoutMs: number } | null}
 */
export function edgeProxyFromConfig(config) {
  const raw = String(config?.edgeProxyUrl ?? "").trim();
  const credentials = String(config?.edgeProxyCredentials ?? "").trim();
  if (!raw || !credentials) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.pathname !== "/" || url.search) return null;
  if (!/^[^:\s]+:\S+$/.test(credentials)) return null;
  const hosts = new Set(String(config?.edgeProxyHosts ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
  return Object.freeze({
    url,
    authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
    hosts,
    connectTimeoutMs: Math.max(1_000, Number(config?.edgeProxyConnectTimeoutMs) || 10_000),
  });
}

/** @param {ReturnType<typeof edgeProxyFromConfig>} edge @param {string} hostname */
export function routesThroughEdge(edge, hostname) {
  return Boolean(edge) && edge.hosts.has(String(hostname ?? "").toLowerCase());
}

/**
 * The socket to the proxy: TLS for an `https:` proxy, plain TCP for `http:`.
 * @param {NonNullable<ReturnType<typeof edgeProxyFromConfig>>} edge
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<net.Socket>}
 */
function connectToProxy(edge, signal) {
  return new Promise((resolve, reject) => {
    const host = edge.url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(edge.url.port) || (edge.url.protocol === "https:" ? 443 : 80);
    /** @type {net.Socket} */
    let socket;
    let settled = false;
    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
      reject(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new EdgeProxyError("edge_proxy_aborted", "The request was abandoned."));
    const timer = setTimeout(() => fail(new EdgeProxyError("edge_proxy_connect_timeout", "The edge node did not accept a connection in time.")), edge.connectTimeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket = edge.url.protocol === "https:"
      ? tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), ALPNProtocols: ["http/1.1"] }, ready)
      : net.connect({ host, port }, ready);
    socket.once("error", (error) => fail(new EdgeProxyError("edge_proxy_unreachable", `The edge node could not be reached (${/** @type {any} */ (error).code ?? error.message}).`)));
  });
}

/**
 * A byte stream to `targetHost:targetPort` through the proxy's CONNECT method.
 * @param {NonNullable<ReturnType<typeof edgeProxyFromConfig>>} edge
 * @param {string} targetHost @param {number} targetPort @param {AbortSignal} [signal]
 * @returns {Promise<net.Socket>}
 */
export async function openEdgeTunnel(edge, targetHost, targetPort, signal) {
  const socket = await connectToProxy(edge, signal);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    /** @param {Error} error */
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new EdgeProxyError("edge_proxy_aborted", "The request was abandoned."));
    const onError = () => fail(new EdgeProxyError("edge_proxy_unreachable", "The edge node dropped the connection."));
    const onClose = () => fail(new EdgeProxyError("edge_proxy_unreachable", "The edge node closed the connection before answering."));
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > MAX_CONNECT_HEADER_BYTES) fail(new EdgeProxyError("edge_proxy_protocol", "The edge node answered with an oversized header."));
        return;
      }
      const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (status !== 200) {
        fail(new EdgeProxyError("edge_proxy_refused", `The edge node refused the tunnel (HTTP ${status || "?"}).`, status));
        return;
      }
      settled = true;
      cleanup();
      const rest = buffer.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    const authority = `${targetHost.includes(":") ? `[${targetHost}]` : targetHost}:${targetPort}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${edge.authorization}\r\n\r\n`);
  });
}

/**
 * One request through the node. HTTPS targets ride a CONNECT tunnel with TLS to
 * the target; HTTP targets are sent in absolute form to the proxy itself.
 * Resolves with the raw node response; the caller reads (and bounds) the body.
 * @param {NonNullable<ReturnType<typeof edgeProxyFromConfig>>} edge
 * @param {URL} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | Buffer, signal?: AbortSignal, targetTls?: tls.ConnectionOptions }} [options]
 * @returns {Promise<http.IncomingMessage>}
 */
export async function edgeRequest(edge, url, { method = "GET", headers = {}, body, signal, targetTls = {} } = {}) {
  const secureTarget = url.protocol === "https:";
  if (!secureTarget && url.protocol !== "http:") throw new EdgeProxyError("edge_proxy_protocol", "Only http and https targets go through the edge node.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (secureTarget ? 443 : 80);
  const socket = secureTarget ? await openEdgeTunnel(edge, host, port, signal) : await connectToProxy(edge, signal);
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers, host: url.host };
    if (!secureTarget) requestHeaders["proxy-authorization"] = edge.authorization;
    const request = http.request({
      method,
      // A tunnelled request names its path; a proxied one names the whole URL.
      path: secureTarget ? `${url.pathname}${url.search}` : url.href,
      headers: requestHeaders,
      signal,
      createConnection: () => (secureTarget
        ? tls.connect({ socket, ...(net.isIP(host) ? {} : { servername: host }), ALPNProtocols: ["http/1.1"], ...targetTls })
        : socket),
    }, (response) => {
      if (!secureTarget && response.statusCode === 407) {
        response.resume();
        reject(new EdgeProxyError("edge_proxy_refused", "The edge node refused the credentials (HTTP 407).", 407));
        return;
      }
      resolve(response);
    });
    request.once("error", (error) => {
      socket.destroy();
      reject(signal?.aborted
        ? (signal.reason instanceof Error ? signal.reason : error)
        : new EdgeProxyError("edge_proxy_upstream_unreachable", `The upstream could not be reached through the edge node (${/** @type {any} */ (error).code ?? error.message}).`));
    });
    if (body != null) request.write(body);
    request.end();
  });
}

/**
 * A `fetch`-shaped call through the node, for the gateways that consume a WHATWG
 * `Response`. No redirect is followed (the gateways ask for `redirect: "error"`
 * and read a 3xx as a refusal), and the body is not decompressed, so it asks the
 * upstream for none.
 * @param {NonNullable<ReturnType<typeof edgeProxyFromConfig>>} edge
 * @param {URL | string} input
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }} [init]
 * @returns {Promise<Response>}
 */
export async function edgeFetch(edge, input, init = {}) {
  const url = input instanceof URL ? input : new URL(String(input));
  const headers = { ...(init.headers ?? {}), "accept-encoding": "identity" };
  if (init.body != null) headers["content-length"] = String(Buffer.byteLength(init.body));
  const response = await edgeRequest(edge, url, { method: init.method ?? "GET", headers, body: init.body, signal: init.signal });
  const status = Number(response.statusCode) || 502;
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) if (item != null) responseHeaders.append(name, String(item));
  }
  const nullBody = status === 204 || status === 304 || init.method === "HEAD";
  if (nullBody) response.resume();
  return new Response(nullBody ? null : /** @type {any} */ (Readable.toWeb(response)), { status, headers: responseHeaders });
}

/** Counters for `/api/ops/metrics`: how often the node carried a request, and how often it failed. */
export const edgeStats = { requests: 0, failures: 0, directFallbacks: 0, webReadFallbacks: 0 };

/**
 * Try the node first for the hosts routed through it; if the node itself fails
 * (not the upstream behind it), go direct once — a node outage then costs the
 * routed hosts their workaround, not the platform its reads.
 * @param {ReturnType<typeof edgeProxyFromConfig>} edge
 * @param {typeof fetch} directFetch
 * @returns {typeof fetch}
 */
export function fetchWithEdge(edge, directFetch) {
  return /** @type {typeof fetch} */ (async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (!routesThroughEdge(edge, url.hostname)) return directFetch(input, init);
    edgeStats.requests += 1;
    try {
      return await edgeFetch(/** @type {any} */ (edge), url, /** @type {any} */ (init));
    } catch (error) {
      edgeStats.failures += 1;
      if (!(error instanceof EdgeProxyError) || init?.signal?.aborted) throw error;
      edgeStats.directFallbacks += 1;
      return directFetch(input, init);
    }
  });
}

/** `/api/ops/metrics` families for the node, or none when this deployment has no node. */
export function edgeMetricFamilies(edge) {
  if (!edge) return [];
  return [{
    name: "open_science_edge_proxy_total",
    help: "Requests the Tokyo node carried, node failures, requests that went direct after one, and web reads retried through it.",
    type: "counter",
    series: [
      { value: edgeStats.requests, labels: { event: "request" } },
      { value: edgeStats.failures, labels: { event: "failure" } },
      { value: edgeStats.directFallbacks, labels: { event: "direct_fallback" } },
      { value: edgeStats.webReadFallbacks, labels: { event: "web_read_fallback" } },
    ],
  }];
}
