import { HttpError, readJson, sendJson } from "./security.mjs";

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "notification_payload_invalid", "Inbox request contains unsupported fields.");
  }
  return value;
}

function booleanParam(url, name) {
  const value = url.searchParams.get(name);
  if (value == null) return false;
  if (!['true', 'false'].includes(value)) throw new HttpError(400, "notification_filter_invalid", `Invalid ${name} filter.`);
  return value === "true";
}

/** @param {{store:any,service:any,maxJsonBytes:number}} dependencies */
export function createNotificationRoutes({ store, service, maxJsonBytes }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== "/api/inbox" && !url.pathname.startsWith("/api/inbox/")) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    if (!service) throw new HttpError(503, "notification_unavailable", "Inbox storage is unavailable.");
    let parts;
    try { parts = url.pathname.slice("/api/inbox".length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "notification_path_invalid", "Invalid inbox path."); }
    const method = req.method ?? "GET";
    const reply = (data) => { sendJson(res, 200, { data }); return true; };

    if (parts.length === 0 && method === "GET") {
      return reply(await service.list(user.id, {
        noticeType: url.searchParams.get("noticeType"),
        unreadOnly: booleanParam(url, "unread"),
        unresolvedOnly: booleanParam(url, "unresolved"),
        limit: Number(url.searchParams.get("limit") ?? 50),
        cursor: url.searchParams.get("cursor"),
      }));
    }
    if (parts.length === 1 && parts[0] === "preferences") {
      if (method === "GET") return reply(await service.preferences(user.id));
      if (method === "PATCH") {
        const body = await bodyOf(req, maxJsonBytes, ["quietHours", "digestTime", "switches", "channels", "expectedRevision"]);
        const { expectedRevision, ...preferences } = body;
        return reply(await service.updatePreferences(user.id, preferences, expectedRevision));
      }
    }
    if (parts.length === 2 && parts[1] === "read" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["expectedRevision"]);
      return reply(await service.markRead(user.id, parts[0], body.expectedRevision));
    }
    if (parts.length === 2 && parts[1] === "resolve" && method === "POST") {
      const body = await bodyOf(req, maxJsonBytes, ["actionId", "expectedRevision"]);
      return reply(await service.resolve(user.id, parts[0], body));
    }
    throw new HttpError(404, "not_found", "Inbox route not found.");
  };
}
