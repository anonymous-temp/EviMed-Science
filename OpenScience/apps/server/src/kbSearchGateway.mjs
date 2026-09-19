// Knowledge-base search, for the runtime's `kb_search` tool.
//
// The same shape as every internal gateway (layer 3): one path, one handler,
// one allowlist of fields, and the runtime's own gateway token as the only
// credential. The token — not anything the runtime says — names the account
// and the project, so a run can only ever search the knowledge base of the
// project it runs in and its owner's personal library.
//
// Switched off, it answers `kb_search_disabled` and nothing else changes: the
// documents are still in the workspace for the run to read and grep, which is
// what a run did before this tool existed.

const gatewayPath = "/internal/kb/v1/search";
const allowedFields = new Set(["query", "limit", "sourceIds"]);
const maxQueryLength = 512;
const maxLimit = 20;
const defaultLimit = 8;
const maxSourceIds = 50;
/** Searches one project may make per minute. A run searches a handful of
 *  times; this is the ceiling of a loop, not of a researcher. */
const windowLimit = 120;

class KbSearchGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new KbSearchGatewayError(status, code, message);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw gatewayError(413, "kb_search_request_too_large", "The knowledge-base search request was too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw gatewayError(400, "kb_search_request_invalid", "The knowledge-base search request was not a JSON object.");
  }
}

/** @param {Record<string, unknown>} body */
function validatedRequest(body) {
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    throw gatewayError(400, "kb_search_request_invalid", "The knowledge-base search request has unsupported fields.");
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > maxQueryLength || /[\0]/.test(query)) {
    throw gatewayError(400, "kb_search_query_invalid", `A non-empty query of at most ${maxQueryLength} characters is required.`);
  }
  const limit = body.limit == null ? defaultLimit : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw gatewayError(400, "kb_search_limit_invalid", `limit must be an integer between 1 and ${maxLimit}.`);
  }
  let sourceIds = null;
  if (body.sourceIds != null) {
    if (!Array.isArray(body.sourceIds) || body.sourceIds.length > maxSourceIds
      || body.sourceIds.some((id) => typeof id !== "string" || !/^src_[a-f0-9]{32}$/.test(id))) {
      throw gatewayError(400, "kb_search_source_ids_invalid", `sourceIds must be at most ${maxSourceIds} source ids (src_…).`);
    }
    sourceIds = [...new Set(body.sourceIds)];
  }
  return { query, limit, sourceIds };
}

/**
 * The gateway's URL as the runtime may know it: empty when the switch is off,
 * so the tool answers "disabled" without a request, exactly as when the
 * gateway itself refuses.
 * @param {any} config @returns {string}
 */
export function kbSearchGatewayProviderUrl(config) {
  if (!config.kbSearchEnabled) return "";
  const value = String(config.kbSearchGatewayInternalUrl ?? "").trim();
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
  return url.href;
}

/**
 * @param {any} config
 * @param {any} runtimeManager
 * @param {{ index: any }} dependencies the knowledge-base index, or null when switched off
 */
export function createKbSearchGatewayHandler(config, runtimeManager, { index }) {
  const windows = new Map();
  return async function kbSearchGatewayHandler(req, res, onFailure) {
    try {
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
        throw gatewayError(404, "not_found", "Not found.");
      }
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw gatewayError(401, "kb_search_gateway_token_missing", "Knowledge-base search authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw gatewayError(401, "kb_search_gateway_token_invalid", "Knowledge-base search authentication failed.");
      }
      if (!config.kbSearchEnabled || !index) {
        throw gatewayError(503, "kb_search_disabled", "Knowledge-base search is switched off for this deployment; read and grep the knowledge-base files instead.");
      }
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}`;
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > windowLimit) throw gatewayError(429, "kb_search_rate_limited", "Too many knowledge-base searches in a minute.");
      const request = validatedRequest(await readJsonBody(req, 16 * 1024));
      const timeoutMs = Math.max(1_000, Number(config.kbSearchTimeoutMs) || 20_000);
      let timer;
      const result = await Promise.race([
        index.search({ userId: identity.userId, projectId: identity.projectId, ...request }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gatewayError(504, "kb_search_timeout", "Knowledge-base search timed out.")), timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      sendJson(res, 200, { data: result });
    } catch (error) {
      const known = error instanceof KbSearchGatewayError;
      const status = known ? error.status : 503;
      const code = known ? error.code : "kb_search_unavailable";
      onFailure?.({ code, status });
      sendJson(res, status, { error: known ? error.message : "Knowledge-base search is unavailable; read and grep the knowledge-base files instead.", code });
    }
  };
}

export const KB_SEARCH_GATEWAY_PATH = gatewayPath;
export const KB_SEARCH_MAX_LIMIT = maxLimit;
