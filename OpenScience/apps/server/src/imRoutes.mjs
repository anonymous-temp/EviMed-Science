import { HttpError, readJson, sendJson } from "./security.mjs";
import { DEVICE_REQUEST } from "./channels/deviceTokens.mjs";

/**
 * The IM module's routes, all under `/api/im`.
 *
 *   GET    /api/im/channels                  every channel, and this account's Feishu binding
 *   POST   /api/im/feishu/registration       start scan-to-create; answers the attempt's state
 *   GET    /api/im/feishu/registration       poll it (the page renders `qrCodeUrl` as a QR code)
 *   DELETE /api/im/feishu/registration       cancel it
 *   DELETE /api/im/feishu                    unbind the bot (the app stays in the person's Feishu)
 *   GET|POST /api/im/app/push-tokens         the own app's devices    (OPEN_SCIENCE_CHANNEL_APP_ENABLED)
 *   DELETE /api/im/app/push-tokens/:id
 *   GET|POST /api/im/app/device-tokens       non-browser sign-in      (OPEN_SCIENCE_APP_API_ENABLED)
 *   DELETE /api/im/app/device-tokens/:id
 *
 * Device tokens are minted and revoked here from a browser session only: a
 * device token presented on these routes is refused by the device-token step
 * before it arrives (they are not on its list), and the check below repeats
 * that, because a credential must never be able to mint its own successor.
 *
 * @module imRoutes
 */

export const IM_PATH = "/api/im";

/** @param {any} req @param {number} limit @param {string[]} allowed */
async function bodyOf(req, limit, allowed) {
  const value = await readJson(req, limit);
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "im_payload_invalid", "The request contains unsupported fields.");
  }
  return value;
}

/**
 * @param {{ config: any, store: any, service: any, deviceTokens: any, maxJsonBytes: number,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<void> }} dependencies
 */
export function createImRoutes({ config, store, service, deviceTokens, maxJsonBytes, audit = async () => {} }) {
  /** @param {any} req @param {any} res */
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://evimed.local");
    if (url.pathname !== IM_PATH && !url.pathname.startsWith(`${IM_PATH}/`)) return false;
    const { user } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
    await store.assertCsrf(req, url.pathname);
    let parts;
    try { parts = url.pathname.slice(IM_PATH.length).split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "im_path_invalid", "Invalid path."); }
    const method = req.method ?? "GET";
    const reply = (/** @type {unknown} */ data, status = 200) => { sendJson(res, status, { data }); return true; };
    const requireService = () => {
      if (!service) throw new HttpError(503, "im_unavailable", "Messaging channels require the shared product store.");
      return service;
    };

    if (parts.length === 1 && parts[0] === "channels" && method === "GET") {
      if (!service) return reply({ enabled: false, available: false, channels: [], feishu: null, registration: null,
        appApi: config.appApiEnabled === true });
      return reply({ ...(await service.status(user)), available: true, appApi: config.appApiEnabled === true });
    }

    if (parts[0] === "feishu") {
      const im = requireService();
      if (parts.length === 2 && parts[1] === "registration") {
        if (method === "POST") {
          await bodyOf(req, maxJsonBytes, []);
          const state = im.startRegistration(user);
          await audit("im.feishu.registration", "started", { userId: user.id });
          return reply(state);
        }
        if (method === "GET") return reply(im.registration(user));
        if (method === "DELETE") return reply(im.cancelRegistration(user));
      }
      if (parts.length === 1 && method === "DELETE") return reply(await im.unbind(user));
    }

    if (parts[0] === "app" && parts[1] === "push-tokens") {
      const im = requireService();
      if (parts.length === 2 && method === "GET") return reply(await im.listPushTokens(user));
      if (parts.length === 2 && method === "POST") {
        const body = await bodyOf(req, 16 * 1024, ["platform", "token", "deviceName"]);
        return reply(await im.registerPushToken(user, body), 201);
      }
      if (parts.length === 3 && method === "DELETE") return reply(await im.removePushToken(user, parts[2]));
    }

    if (parts[0] === "app" && parts[1] === "device-tokens") {
      if (config.appApiEnabled !== true) throw new HttpError(404, "app_api_disabled", "Device sign-in is not enabled on this deployment.");
      if (req[DEVICE_REQUEST]) throw new HttpError(403, "device_token_route_forbidden", "A device token cannot manage device tokens.");
      if (!deviceTokens) throw new HttpError(503, "device_tokens_unavailable", "Device tokens require the shared product store.");
      if (parts.length === 2 && method === "GET") return reply(await deviceTokens.list(user.id));
      if (parts.length === 2 && method === "POST") {
        const body = await bodyOf(req, 16 * 1024, ["name", "expiresInDays"]);
        const issued = await deviceTokens.issue(user.id, body);
        // The token itself is never audited: an audit line is a log line.
        await audit("app.device-token.issue", "completed", { userId: user.id, target: issued.id });
        return reply(issued, 201);
      }
      if (parts.length === 3 && method === "DELETE") {
        const revoked = await deviceTokens.revoke(user.id, parts[2]);
        await audit("app.device-token.revoke", "completed", { userId: user.id, target: revoked.id });
        return reply(revoked);
      }
    }

    throw new HttpError(404, "not_found", "Messaging route not found.");
  };
}
