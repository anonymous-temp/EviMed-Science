/**
 * The runtime gateways' public entry: `https://<domain>/runtime-gateway/…`
 * (plan §3.1 #5).
 *
 * A Docker runtime reaches the model, public-source, search, capsule,
 * revision, connector-credential, GEO-probe, knowledge-base and frontier
 * gateways by the control plane's container name, and the specialist engines
 * by theirs. A runtime in an AgentBay session is on the internet: it reaches
 * all of them through this one
 * prefix on port 443, which the host's nginx forwards here, and nothing about
 * what a gateway checks changes — every request still carries the runtime's
 * own signed, timestamped token and every gateway still verifies it. What this
 * adds is the mapping and a per-runtime rate limit, because an address on the
 * internet can be called by anything that learns it:
 *
 *   /runtime-gateway/<model|sources|search|capsules|revisions|geo-probe|kb|frontier|review>/…
 *       → the same request at /internal/<name>/…, handled by the same gateway
 *   /runtime-gateway/specialist/<adapter>[/…]
 *       → relayed to that specialist adapter's configured URL, token included
 *
 * A caller whose token is not an active runtime's is refused here, before a
 * gateway or an adapter sees the request.
 *
 * @module runtimeGatewayEntry
 */

import http from "node:http";
import https from "node:https";
import {
  capsuleGatewayProviderUrl,
  publicSourceGatewayProviderUrl,
  revisionGatewayProviderUrl,
  webSearchGatewayProviderUrl,
} from "./runtimeManager.mjs";
import { HttpError, sendError } from "./security.mjs";
import { kbSearchGatewayProviderUrl } from "./kbSearchGateway.mjs";
import { frontierGatewayProviderUrl } from "./frontierGateway.mjs";

export const RUNTIME_GATEWAY_PREFIX = "/runtime-gateway/";

/** The gateways reachable through the prefix; each name is its internal
 *  path's own (`/internal/<name>/…`), so the mapping is the name. */
/*
 * `connectors` is deliberately absent: the connector-credential gateway serves
 * a specialist adapter inside this host (connectorCredentials.mjs), never a
 * runtime, and a credential endpoint reachable from the internet with a token
 * the run can print is what the 2026-09-20 security review found here.
 */
export const RUNTIME_GATEWAY_NAMES = Object.freeze(["model", "sources", "search", "capsules", "revisions", "geo-probe", "kb", "frontier", "review"]);

export const RUNTIME_GATEWAY_SPECIALIST = "specialist";

/** How long one specialist relay may stay open: the MCP's own deadline for an
 *  adapter call is shorter, so this only ever ends a connection it abandoned. */
const SPECIALIST_RELAY_TIMEOUT_MS = 15 * 60_000;

/**
 * The gateway addresses a runtime outside this host is given, or null when the
 * deployment has no public prefix. Each is offered only when its internal
 * counterpart is, so a remote runtime is offered exactly what a local one is.
 * @param {Record<string, any>} config
 */
export function publicRuntimeGatewayUrls(config) {
  const base = String(config.runtimeGatewayPublicUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  /** @type {Record<string, string>} */
  const adapters = {};
  for (const [key, value] of Object.entries(config.evimedAdapterUrls ?? {})) {
    if (String(value ?? "").trim()) adapters[key] = `${base}/${RUNTIME_GATEWAY_SPECIALIST}/${encodeURIComponent(key)}`;
  }
  return {
    model: `${base}/model/v1`,
    publicSource: publicSourceGatewayProviderUrl(config) ? `${base}/sources/v1/fetch` : "",
    webSearch: webSearchGatewayProviderUrl(config) ? `${base}/search/v1/query` : "",
    capsule: capsuleGatewayProviderUrl(config) ? `${base}/capsules/v1` : "",
    revision: revisionGatewayProviderUrl(config) ? `${base}/revisions/v1/authorize` : "",
    geoProbe: String(config.geoProbeUrl ?? "").trim() ? `${base}/geo-probe/v1` : "",
    kbSearch: kbSearchGatewayProviderUrl(config) ? `${base}/kb/v1/search` : "",
    frontier: frontierGatewayProviderUrl(config) ? `${base}/frontier/v1/search` : "",
    // The review gateway has no address of its own in a runtime's environment:
    // the socket derives it from the revision gateway's (`../socket/src/review.mjs`).
    review: config.reviewEnabled && revisionGatewayProviderUrl(config) ? `${base}/review/v1` : "",
    adapters,
  };
}

/**
 * Where a public gateway path goes: an internal path, a specialist adapter, or
 * nowhere.
 * @param {string} rawUrl the request's path and query
 * @returns {{ kind: 'internal', url: string } | { kind: 'specialist', adapter: string, suffix: string } | null}
 */
export function resolveRuntimeGatewayPath(rawUrl) {
  const url = String(rawUrl ?? "");
  if (!url.startsWith(RUNTIME_GATEWAY_PREFIX)) return null;
  // The server's own router decodes percent-escapes and backslashes before it
  // resolves a path, so `%2e%2e`, `.%2e` and `\` escaped the literal `..` check
  // below and reached other /internal/ handlers and /api/ routes (security
  // review, 2026-09-20). A gateway path is plain: any escape of a dot, a slash
  // or a backslash, a raw backslash, or a dot segment is refused outright.
  const pathPart = url.split("?")[0];
  if (/%(?:2e|2f|5c)/i.test(pathPart) || pathPart.includes("\\")) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathPart); } catch { return null; }
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const rest = url.slice(RUNTIME_GATEWAY_PREFIX.length);
  const cut = rest.search(/[/?]/);
  const name = cut < 0 ? rest : rest.slice(0, cut);
  const tail = cut < 0 ? "" : rest.slice(cut);
  if (tail.startsWith("/..") || /\/\.\.?(?:\/|$|\?)/.test(tail.split("?")[0])) return null;
  if (RUNTIME_GATEWAY_NAMES.includes(name)) return { kind: "internal", url: `/internal/${name}${tail}` };
  if (name === RUNTIME_GATEWAY_SPECIALIST) {
    const match = /^\/([A-Za-z][A-Za-z0-9]*)(.*)$/.exec(tail);
    if (match) return { kind: "specialist", adapter: match[1], suffix: match[2] };
  }
  return null;
}

/**
 * @param {{ config: Record<string, any>, runtimeManager: any }} deps
 */
export function createRuntimeGatewayEntry({ config, runtimeManager }) {
  /** Requests per runtime in the current minute. */
  const windows = new Map();
  // Only a deployment whose runtimes live outside this host has a use for a
  // public way in, and only once it has said where that is. A Docker
  // deployment — production until the AgentBay switch — keeps these gateways
  // on the internal network alone, as before the entry existed.
  const enabled = String(config.runtimeProvider ?? "docker") === "agentbay" && Boolean(publicRuntimeGatewayUrls(config));

  /** The active runtime a request's token belongs to, or a refusal. */
  async function identify(req) {
    const token = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!token) throw new HttpError(401, "runtime_gateway_unauthenticated", "A runtime token is required.");
    try {
      const payload = runtimeManager.assertActiveModelGatewayToken(token);
      return `${payload.userId}:${payload.projectId}`;
    } catch {
      // Not a model-gateway token; the workload token is the other one a
      // runtime holds.
    }
    try {
      const payload = await runtimeManager.assertActiveEviMedWorkloadToken(token);
      return `${payload.userId}:${payload.projectId}`;
    } catch {
      throw new HttpError(401, "runtime_gateway_unauthenticated", "The token is not an active runtime's.");
    }
  }

  function admit(key) {
    const limit = Number(config.runtimeGatewayRateLimitPerMinute);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const now = Date.now();
    const current = windows.get(key);
    const window = !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    window.count += 1;
    windows.set(key, window);
    if (windows.size > 10_000) for (const [name, entry] of windows) if (entry.resetAt <= now) windows.delete(name);
    if (window.count > limit) {
      throw new HttpError(429, "runtime_gateway_rate_limited", `A runtime may make ${limit} gateway requests a minute.`, {
        retryAfterSeconds: Math.ceil((window.resetAt - now) / 1000),
      });
    }
  }

  function relaySpecialist(req, res, adapter, suffix) {
    const configured = String(config.evimedAdapterUrls?.[adapter] ?? "").trim();
    if (!configured) throw new HttpError(404, "runtime_gateway_adapter_unconfigured", "That specialist adapter is not configured.");
    const target = new URL(configured);
    const cut = suffix.indexOf("?");
    const extraPath = cut < 0 ? suffix : suffix.slice(0, cut);
    const query = cut < 0 ? "" : suffix.slice(cut);
    if (extraPath) target.pathname = `${target.pathname.replace(/\/+$/, "")}${extraPath}`;
    const url = `${target.origin}${target.pathname}${target.search || query}`;
    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value == null || ["host", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authorization", "cookie"].includes(lower)) continue;
      headers[name] = value;
    }
    const transport = target.protocol === "https:" ? https : http;
    return new Promise((resolve) => {
      const upstream = transport.request(url, { method: req.method, headers, timeout: SPECIALIST_RELAY_TIMEOUT_MS }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
        response.once("end", () => resolve(undefined));
        response.once("error", () => { res.destroy(); resolve(undefined); });
      });
      upstream.once("timeout", () => upstream.destroy(new Error("specialist relay timed out")));
      upstream.once("error", () => {
        if (!res.headersSent) sendError(res, new HttpError(502, "runtime_gateway_adapter_unavailable", "The specialist adapter did not answer."));
        else res.destroy();
        resolve(undefined);
      });
      req.pipe(upstream);
    });
  }

  return {
    /** @param {any} req */
    matches(req) {
      return String(req.url ?? "").startsWith(RUNTIME_GATEWAY_PREFIX);
    },

    /**
     * Answers or rewrites a public gateway request. Returns true when the
     * request was answered here (a refusal, a specialist relay), false when it
     * was rewritten to its internal path for the gateway dispatch that follows.
     * @param {any} req @param {any} res @returns {Promise<boolean>}
     */
    async handle(req, res) {
      try {
        if (!enabled) throw new HttpError(404, "runtime_gateway_not_found", "No runtime gateway at that address.");
        const resolved = resolveRuntimeGatewayPath(req.url);
        if (!resolved) throw new HttpError(404, "runtime_gateway_not_found", "No runtime gateway at that address.");
        admit(await identify(req));
        if (resolved.kind === "internal") {
          req.url = resolved.url;
          return false;
        }
        await relaySpecialist(req, res, resolved.adapter, resolved.suffix);
        return true;
      } catch (error) {
        if (!res.headersSent) sendError(res, error instanceof HttpError ? error : new HttpError(502, "runtime_gateway_failed", "The runtime gateway failed."));
        return true;
      }
    },
  };
}
