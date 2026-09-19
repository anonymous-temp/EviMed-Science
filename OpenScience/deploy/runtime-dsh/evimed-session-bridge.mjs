#!/usr/bin/env node
/**
 * The session bridge: the one listener a remote runtime session exposes
 * (plan §3.1 #3), and the AgentBay counterpart of the socat bridge the Docker
 * container runs.
 *
 * Why it exists. DSH's web host refuses `--host 0.0.0.0`, fences `/api` by the
 * `Host` header (loopback or a declared `--trusted-host`) and derives its
 * browser-session cookie's name from that header. So the kernel keeps its
 * loopback listener and today's flags, and this bridge sits in front of it on
 * the port AgentBay's session link reaches (30100–30199): it checks a
 * per-session secret, rewrites `Host` to the authority the kernel trusts, and
 * forwards HTTP and WebSocket upgrades byte for byte. It knows nothing about
 * DSH's protocol — a request is a method, a path, headers and a body.
 *
 * The secret arrives one of two ways, because AgentBay does not document
 * whether its link proxy forwards custom headers:
 *
 *   header  `x-evimed-bridge-secret: <secret>`, with the kernel path in
 *           `x-evimed-bridge-target` (a WebSocket link has one fixed path, so
 *           the path the kernel should see cannot ride in the URL)
 *   path    `/__evimed_bridge/<secret>/<kernel path>`, found anywhere in the
 *           request path, for a proxy that strips headers but keeps a suffix
 *
 * Both are accepted on every request; the control plane uses the one its
 * `OPEN_SCIENCE_AGENTBAY_BRIDGE_SECRET_MODE` names, and the first live
 * bring-up decides which one survives the proxy. Anything else is refused
 * before a byte reaches the kernel.
 *
 * Dependency-free on purpose: it runs from the image's read-only root as the
 * runtime user, and is the only code between the public link and the kernel.
 *
 * @module evimed-session-bridge
 */

import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const BRIDGE_MARKER = "/__evimed_bridge/";
export const BRIDGE_SECRET_HEADER = "x-evimed-bridge-secret";
export const BRIDGE_TARGET_HEADER = "x-evimed-bridge-target";
/** The bridge's own liveness answer, reached like any other target. */
export const BRIDGE_HEALTH_PATH = "/__evimed_bridge/healthz";

/** Headers that describe one hop and never cross it. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", BRIDGE_SECRET_HEADER, BRIDGE_TARGET_HEADER,
]);

/** Constant-time over equal-length digests, so neither the secret's length
 *  nor its content leaks through timing. */
function sameSecret(presented, secret) {
  const a = createHash("sha256").update(String(presented)).digest();
  const b = createHash("sha256").update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

/** A path the kernel may be asked for: absolute, one leading slash, no
 *  control characters. Not a DSH route check — a well-formedness one. */
function acceptablePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 8192
    && value.startsWith("/") && !value.startsWith("//") && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Where a request is going, or why it is refused.
 * @param {import("node:http").IncomingMessage} req @param {string} secret
 * @returns {{ path: string } | { status: number, reason: string }}
 */
export function resolveBridgeRequest(req, secret) {
  const raw = String(req.url ?? "/");
  const presented = req.headers[BRIDGE_SECRET_HEADER];
  if (typeof presented === "string" && presented) {
    if (!sameSecret(presented, secret)) return { status: 401, reason: "bridge_secret_invalid" };
    const target = req.headers[BRIDGE_TARGET_HEADER];
    const path = typeof target === "string" && target ? target : raw;
    return acceptablePath(path) ? { path } : { status: 400, reason: "bridge_target_invalid" };
  }
  const at = raw.indexOf(BRIDGE_MARKER);
  if (at < 0) return { status: 401, reason: "bridge_secret_missing" };
  const rest = raw.slice(at + BRIDGE_MARKER.length);
  const slash = rest.indexOf("/");
  let token = slash < 0 ? rest : rest.slice(0, slash);
  try { token = decodeURIComponent(token); } catch { return { status: 401, reason: "bridge_secret_invalid" }; }
  if (!token || !sameSecret(token, secret)) return { status: 401, reason: "bridge_secret_invalid" };
  const path = slash < 0 ? "/" : rest.slice(slash);
  return acceptablePath(path) ? { path } : { status: 400, reason: "bridge_target_invalid" };
}

/** The request's headers for the kernel: this hop's removed, `Host` the one
 *  the kernel trusts. @param {import("node:http").IncomingHttpHeaders} headers @param {string} authority */
function upstreamHeaders(headers, authority) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = authority;
  return out;
}

function refuse(res, status, reason) {
  const body = JSON.stringify({ error: reason });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

/** Whether the kernel's port accepts a connection right now. */
function kernelReachable(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * @param {{ secret: string, upstreamPort: number, upstreamHost?: string, authority?: string }} options
 * @returns {import("node:http").Server}
 */
export function createSessionBridge({ secret, upstreamPort, upstreamHost = "127.0.0.1", authority = "dsh.runtime" }) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("The session bridge needs a secret of at least 32 bytes.");
  const server = http.createServer((req, res) => {
    const resolved = resolveBridgeRequest(req, secret);
    if ("status" in resolved) {
      req.resume();
      refuse(res, resolved.status, resolved.reason);
      return;
    }
    if (resolved.path === BRIDGE_HEALTH_PATH) {
      req.resume();
      void kernelReachable(upstreamHost, upstreamPort).then((upstream) => {
        const body = JSON.stringify({ ok: true, upstream });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
        res.end(body);
      });
      return;
    }
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: resolved.path,
      headers: upstreamHeaders(req.headers, authority),
    }, (kernel) => {
      // The link proxy buffers a response by default, which holds a stream
      // until it ends; this header is how AgentBay's documentation says to
      // turn that off, and it is harmless on anything that is not a stream.
      const headers = { ...kernel.headers, "x-accel-buffering": "no" };
      res.writeHead(kernel.statusCode ?? 502, headers);
      kernel.pipe(res);
    });
    upstream.once("error", () => {
      if (res.headersSent) res.destroy();
      else refuse(res, 502, "bridge_upstream_unavailable");
    });
    req.pipe(upstream);
    res.once("close", () => upstream.destroy());
  });

  server.on("upgrade", (req, socket, head) => {
    const resolved = resolveBridgeRequest(req, secret);
    if ("status" in resolved) {
      socket.end(`HTTP/1.1 ${resolved.status} ${resolved.status === 400 ? "Bad Request" : "Unauthorized"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const kernel = net.connect({ host: upstreamHost, port: upstreamPort }, () => {
      // The upgrade's own headers go through; only this hop's are replaced.
      const lines = [`${req.method} ${resolved.path} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (value == null || lower === "host" || lower === BRIDGE_SECRET_HEADER || lower === BRIDGE_TARGET_HEADER) continue;
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
      }
      lines.push(`Host: ${authority}`);
      kernel.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) kernel.write(head);
      kernel.pipe(socket);
      socket.pipe(kernel);
    });
    const close = () => { kernel.destroy(); socket.destroy(); };
    kernel.once("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      close();
    });
    socket.once("error", close);
    socket.once("close", close);
    kernel.once("close", () => socket.destroy());
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  // A WebSocket through the link stays open for a whole run.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;
  return server;
}

/** The image entrypoint: every value from the environment the launcher sets. */
async function main() {
  const port = Number(process.env.OPEN_SCIENCE_SESSION_BRIDGE_PORT ?? 30100);
  const upstreamPort = Number(process.env.OPEN_SCIENCE_RUNTIME_PORT ?? 4096);
  const authority = String(process.env.OPEN_SCIENCE_RUNTIME_AUTHORITY ?? "dsh.runtime");
  const secretFile = String(process.env.OPEN_SCIENCE_SESSION_BRIDGE_SECRET_FILE ?? "");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPEN_SCIENCE_SESSION_BRIDGE_PORT is invalid.");
  if (!secretFile) throw new Error("OPEN_SCIENCE_SESSION_BRIDGE_SECRET_FILE is not set.");
  const secret = fs.readFileSync(secretFile, "utf8").trim();
  const server = createSessionBridge({ secret, upstreamPort, authority });
  // Every interface: the link proxy reaches the session from outside its
  // loopback. The session has no public address, and the secret is what
  // stands between a link holder and the kernel.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(undefined));
  });
  process.stderr.write(`evimed-session-bridge: listening on ${port}, kernel on 127.0.0.1:${upstreamPort}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`evimed-session-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
