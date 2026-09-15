import { HttpError, assertObject, readJson, sendJson } from "./security.mjs";
import { AGENT_KEY_SCOPES } from "./agentApiKeys.mjs";

/**
 * Minting, listing and revoking an account's agent API keys.
 *
 * Separate from `agentMemoryRoutes` on purpose: these are account credentials
 * and they are managed from a browser session by the person who owns them,
 * while that file is what a key is then used to call. Folding them together
 * would put a route authenticated by a cookie and a route authenticated by the
 * credential that route mints behind one auth decision, which is the shape of
 * an escalation waiting to be found.
 *
 * The secret is in exactly one response, the one that creates it. Everything
 * after that is prefix, name and dates.
 *
 * @module agentKeyRoutes
 */

export const AGENT_KEY_PATH = "/api/agent-keys";

/**
 * @param {{ config: any, apiKeys: any, context: (req: any, res: any) => Promise<any>,
 *           audit: (ctx: any, action: string, status: string, details?: any) => Promise<void> }} dependencies
 * @returns {(req: any, res: any) => Promise<boolean>}
 */
export function createAgentKeyRoutes({ config, apiKeys, context, audit }) {
  return async function agentKeyRoutes(req, res) {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== AGENT_KEY_PATH && !url.pathname.startsWith(`${AGENT_KEY_PATH}/`)) return false;
    if (!apiKeys) throw new HttpError(503, "product_state_unavailable", "API key storage is unavailable.");
    const ctx = await context(req, res);
    const method = req.method ?? "GET";
    const rest = url.pathname.slice(AGENT_KEY_PATH.length).replace(/^\//, "");

    if (!rest && method === "GET") {
      sendJson(res, 200, { data: { keys: await apiKeys.list(ctx.user.id), scopes: AGENT_KEY_SCOPES } });
      return true;
    }
    if (!rest && method === "POST") {
      const body = assertObject(await readJson(req, config.maxJsonBytes), "API key request");
      const unknown = Object.keys(body).filter((field) => !["name", "scopes", "projectId", "expiresInDays"].includes(field));
      if (unknown.length) throw new HttpError(400, "agent_key_payload_invalid", `Unsupported field(s): ${unknown.sort().join(", ")}.`);
      const created = await apiKeys.create(ctx.user.id, body);
      // The key itself is never audited — an audit line is a log line, and a
      // credential in a log is the thing this store exists to avoid.
      await audit(ctx, "agent-key.create", "completed", { target: created.id, scopes: created.scopes.join(",") });
      sendJson(res, 201, { data: created });
      return true;
    }
    if (rest && !rest.includes("/") && method === "DELETE") {
      const revoked = await apiKeys.revoke(ctx.user.id, decodeURIComponent(rest));
      await audit(ctx, "agent-key.revoke", "completed", { target: revoked.id });
      sendJson(res, 200, { data: revoked });
      return true;
    }
    throw new HttpError(404, "not_found", "No such API key operation.");
  };
}
