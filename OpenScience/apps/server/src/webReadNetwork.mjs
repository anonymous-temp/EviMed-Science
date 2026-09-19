/**
 * The network edge of web reading: which addresses the gateway may ever
 * connect to, and a GET that cannot be talked into connecting anywhere else.
 *
 * Hidden knowledge: until web reading the gateway only fetched hosts on a
 * fixed allowlist, plus publisher PDFs Unpaywall vouched for, so "is this
 * address public" was checked once by resolving the name and then fetching it.
 * That leaves a window: the name can answer differently between the check and
 * the connection (DNS rebinding), and a name that answers "public" to the check
 * and "127.0.0.1" to the socket is the ordinary shape of the attack. That
 * window was worth naming while the runtime could not choose the destination;
 * `web_read` hands the choice to the runtime — and so to whatever a page it
 * read told it — so the window is closed here instead: the socket connects to
 * the very addresses that were checked, through `lookup`, on every hop.
 *
 * An IP literal never reaches `lookup` (the socket skips resolution), which is
 * why every hop's hostname is also checked as a string first.
 *
 * @module webReadNetwork
 */

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { lookup as dnsLookup } from "node:dns/promises";

/** True when a literal IPv4 address is one this server must never be sent to. */
export function privateIpv4Address(host) {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? ""));
  if (!ipv4) return false;
  const octets = ipv4.slice(1, 5).map(Number);
  return octets.some((part) => !Number.isInteger(part) || part > 255)
    || octets[0] === 0 || octets[0] === 10 || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    || octets[0] >= 224;
}

/** The same question for IPv6, including the forms that smuggle IPv4 through. */
export function privateIpv6Address(host) {
  const address = String(host ?? "").replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  if (mapped) return privateIpv4Address(mapped[1]);
  if (address === "::" || address === "::1") return true;
  const head = address.split(":", 1)[0];
  if (!head) return false;
  const group = Number.parseInt(head.padStart(4, "0"), 16);
  if (!Number.isInteger(group)) return true;
  return (group & 0xfe00) === 0xfc00        // fc00::/7  unique local
    || (group & 0xffc0) === 0xfe80          // fe80::/10 link local
    || (group & 0xff00) === 0xff00;         // ff00::/8  multicast
}

/** One resolved address, either family. */
export function privateAddress(address) {
  const value = String(address ?? "").trim();
  return value.includes(":") ? privateIpv6Address(value) : privateIpv4Address(value);
}

/**
 * A hostname that names no public website, read as a string. IPv6 literals are
 * refused outright rather than classified: no public site the platform reads is
 * addressed that way, and the classifier is the part an attacker probes.
 */
export function privateHostname(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "");
  return !host
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".arpa")
    || !host.includes(".")
    || host.includes(":")
    || host.startsWith("[")
    || privateIpv4Address(host);
}

export class WebReadError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {{ retryable?: boolean }} [options] */
  constructor(status, code, message, { retryable = false } = {}) {
    super(message);
    this.name = "WebReadError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** @param {number} status @param {string} code @param {string} message @param {{ retryable?: boolean }} [options] */
export function webReadError(status, code, message, options) {
  return new WebReadError(status, code, message, options);
}

/**
 * A `lookup` for `http.request` that resolves every address a name has and
 * refuses the connection when any of them is private — not just the first:
 * a name answering one public and one private address is the usual shape of
 * the attack, and which one the socket picks is not ours to choose.
 *
 * The addresses it hands back are the ones it checked, so the socket connects
 * to nothing else.
 *
 * @param {(hostname: string, options: { all: true }) => Promise<Array<{ address: string, family: number }> | { address: string, family: number }>} [resolveImpl]
 * @returns {(hostname: string, options: any, callback: (...args: any[]) => void) => void}
 */
export function pinnedPublicLookup(resolveImpl = dnsLookup) {
  return function lookup(hostname, options, callback) {
    const done = typeof options === "function" ? options : callback;
    const wanted = typeof options === "object" && options ? options : {};
    Promise.resolve()
      .then(() => resolveImpl(hostname, { all: true }))
      .then((records) => {
        const addresses = (Array.isArray(records) ? records : [records])
          .map((record) => ({ address: String(record?.address ?? "").trim(), family: Number(record?.family) || (String(record?.address ?? "").includes(":") ? 6 : 4) }))
          .filter((record) => record.address);
        if (addresses.length === 0) {
          throw webReadError(502, "web_read_host_unresolved", "The web page's host did not resolve.", { retryable: true });
        }
        if (addresses.some((record) => privateAddress(record.address))) {
          throw webReadError(403, "web_read_host_forbidden", "The web page's host resolves inside this network.");
        }
        const family = Number(wanted.family) || 0;
        const usable = family ? addresses.filter((record) => record.family === family) : addresses;
        if (usable.length === 0) {
          throw webReadError(502, "web_read_host_unresolved", "The web page's host has no address of the requested family.", { retryable: true });
        }
        if (wanted.all) done(null, usable);
        else done(null, usable[0].address, usable[0].family);
      })
      .catch((error) => {
        done(error instanceof WebReadError
          ? error
          : webReadError(502, "web_read_host_unresolved", "The web page's host did not resolve.", { retryable: true }));
      });
  };
}

/** The longest URL a read accepts. Longer ones are tracking or payloads, not pages. */
export const WEB_READ_MAX_URL_LENGTH = 2048;

/**
 * One hop's URL, or a named refusal. The fragment is dropped rather than
 * refused: `#section-3` is how a citation points at a passage, and the server
 * never sees it anyway.
 *
 * Only the default ports: a public website is served on 80 and 443, and a
 * non-default port is the classic shape of reaching a service that was never
 * meant to be a website.
 *
 * @param {string | URL} value
 * @returns {URL}
 */
export function validatedWebUrl(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > WEB_READ_MAX_URL_LENGTH || /[\s\0]/.test(text)) {
    throw webReadError(400, "web_read_url_invalid", "The web page URL is invalid.");
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw webReadError(400, "web_read_url_invalid", "The web page URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw webReadError(400, "web_read_url_invalid", "Only http and https web pages can be read.");
  }
  if (url.username || url.password || url.port) {
    throw webReadError(403, "web_read_url_forbidden", "The web page URL carries credentials or a non-default port.");
  }
  if (privateHostname(url.hostname)) {
    throw webReadError(403, "web_read_host_forbidden", "The web page's host is not publicly routable.");
  }
  url.hash = "";
  return url;
}

/**
 * Every resolved address of a name is public. The transport enforces the same
 * rule at connect time; this is for addresses the gateway did not connect to
 * itself — the page a remote browser ended up on.
 *
 * @param {string} hostname
 * @param {(hostname: string, options: { all: true }) => Promise<any>} [resolveImpl]
 */
export async function assertPublicWebHost(hostname, resolveImpl = dnsLookup) {
  if (privateHostname(hostname)) {
    throw webReadError(403, "web_read_host_forbidden", "The web page's host is not publicly routable.");
  }
  await new Promise((resolve, reject) => {
    pinnedPublicLookup(resolveImpl)(hostname, { all: true }, (error) => (error ? reject(error) : resolve(undefined)));
  });
}

/** @param {Buffer} body @param {string} encoding @param {number} maxBytes */
function decodedBody(body, encoding, maxBytes) {
  const value = String(encoding ?? "").trim().toLowerCase();
  const options = { maxOutputLength: maxBytes };
  try {
    if (!value || value === "identity") return body;
    if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(body, options);
    if (value === "br") return zlib.brotliDecompressSync(body, options);
    if (value === "deflate") {
      try {
        return zlib.inflateSync(body, options);
      } catch (error) {
        // Some servers send raw deflate under the zlib name.
        if (error?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw error;
        return zlib.inflateRawSync(body, options);
      }
    }
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
      throw webReadError(502, "web_read_response_too_large", "The web page exceeded the gateway's size limit.");
    }
    throw webReadError(502, "web_read_response_invalid", "The web page's compressed body could not be decoded.");
  }
  throw webReadError(502, "web_read_response_invalid", "The web page used a content encoding the gateway does not read.");
}

/**
 * @typedef {object} TransportResponse
 * @property {number} status
 * @property {Record<string, string | string[] | undefined>} headers lower-case names
 * @property {Buffer} body decoded (decompressed) bytes
 */

/**
 * @typedef {(request: { url: URL, headers: Record<string, string>, signal?: AbortSignal, maxBytes: number }) => Promise<TransportResponse>} WebTransport
 */

/**
 * One GET, never following a redirect (the caller validates every hop), with
 * the socket pinned to checked addresses, the body bounded before and after
 * decompression, and no connection reuse across requests.
 *
 * @param {{ resolveImpl?: (hostname: string, options: { all: true }) => Promise<any> }} [options]
 * @returns {WebTransport}
 */
export function nodeWebTransport({ resolveImpl = dnsLookup } = {}) {
  const lookup = pinnedPublicLookup(resolveImpl);
  return function transport({ url, headers, signal, maxBytes }) {
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      let settled = false;
      /** @param {any} error */
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (error instanceof WebReadError) {
          reject(error);
        } else if (signal?.aborted) {
          reject(signal.reason?.name === "TimeoutError"
            ? webReadError(504, "web_read_timeout", "The web page did not answer in time.", { retryable: true })
            : webReadError(499, "web_read_aborted", "The web read was abandoned."));
        } else {
          reject(webReadError(502, "web_read_upstream_unavailable", "The web page could not be reached.", { retryable: true }));
        }
      };
      const request = client.request(url, {
        method: "GET",
        headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
        lookup,
        agent: false,
        signal,
      }, (response) => {
        const declared = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          fail(webReadError(502, "web_read_response_too_large", "The web page exceeded the gateway's size limit."));
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            fail(webReadError(502, "web_read_response_too_large", "The web page exceeded the gateway's size limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          try {
            const body = decodedBody(Buffer.concat(chunks, total), String(response.headers["content-encoding"] ?? ""), maxBytes);
            settled = true;
            resolve({ status: Number(response.statusCode) || 0, headers: response.headers, body });
          } catch (error) {
            fail(error);
          }
        });
      });
      request.on("error", fail);
      request.end();
    });
  };
}

/** @param {Record<string, any>} headers @param {string} name @returns {string} */
export function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value == null ? "" : String(value);
}

/**
 * A transport over a `fetch`, for the evaluation corpus's replay and record
 * modes only (recordedGateway.mjs): there every upstream answer — pages and
 * robots.txt included — must come from the same fixture set the rest of the
 * gateway replays, or an arm is partly live and nobody can tell which part.
 * Hop validation still runs in the reader; address pinning does not apply to
 * answers that never touch the network.
 *
 * @param {typeof fetch} fetchImpl
 * @returns {WebTransport}
 */
export function fetchWebTransport(fetchImpl) {
  return async ({ url, headers, signal, maxBytes }) => {
    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal });
    } catch {
      throw webReadError(502, "web_read_upstream_unavailable", "The web page could not be reached.", { retryable: true });
    }
    const chunks = [];
    let total = 0;
    const reader = response.body?.getReader();
    for (let chunk = reader ? await reader.read() : { done: true, value: undefined }; !chunk.done; chunk = await reader.read()) {
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw webReadError(502, "web_read_response_too_large", "The web page exceeded the gateway's size limit.");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks, total) };
  };
}
