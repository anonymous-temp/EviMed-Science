import { createHash } from "node:crypto";
import { HttpError } from "../security.mjs";
import { channelCredentialConnector } from "../connectorCredentials.mjs";
import { assertChannelAdapter, deliveryOutcome } from "./port.mjs";

/**
 * The own app's push channel — a reservation with its intake built.
 *
 * Two pieces exist so the app can be built later without touching the control
 * plane (plan §3.6): devices register their push tokens here today
 * (`bind`), and a vendor push provider plugs into `pushProvider` when one is
 * chosen — APNs for iOS, a vendor channel or FCM for Android, HarmonyOS Push.
 * With no provider it reports not-configured and delivers nothing; the tokens
 * wait. The app's own requests use the run API and the event stream the web
 * uses, authenticated by a device token (`channels/deviceTokens.mjs`),
 * never a second API.
 *
 * A push token is held like a secret — in the per-user credential store,
 * under `channel.app.<device>` — because a token plus the vendor's credentials
 * is a way to put text on someone's lock screen.
 */

/** The platforms a push token can come from. */
export const APP_PUSH_PLATFORMS = Object.freeze(["ios", "android", "harmony"]);

/**
 * @param {{ store?: any, credentials?: any,
 *   pushProvider?: { send: (input: { platform: string, token: string, message: any }) => Promise<any> } | null }} [dependencies]
 */
export function createAppChannel({ store = null, credentials = null, pushProvider = null } = {}) {
  return assertChannelAdapter({
    id: "app",
    title: "EviMed App",
    reserved: true,
    status: () => (pushProvider
      ? { state: "ready", reason: null }
      : { state: "not-configured", reason: "尚未接入手机厂商推送服务；设备可以先登记推送令牌。" }),

    /**
     * Register one device's push token for an account. Idempotent per token;
     * a token already registered to another account moves to this one.
     * @param {string} userId
     * @param {{ platform?: unknown, token?: unknown, deviceName?: unknown }} grant
     */
    async bind(userId, grant) {
      if (!store || !credentials) throw new HttpError(503, "channel_store_unavailable", "Channel storage is unavailable.");
      const platform = String(grant?.platform ?? "");
      if (!APP_PUSH_PLATFORMS.includes(platform)) {
        throw new HttpError(400, "push_token_invalid", `platform must be one of ${APP_PUSH_PLATFORMS.join(", ")}.`);
      }
      const token = typeof grant?.token === "string" ? grant.token.trim() : "";
      if (!token || token.length > 4096 || /\s/.test(token) || [...token].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new HttpError(400, "push_token_invalid", "token must be a non-empty push token without whitespace.");
      }
      const deviceName = grant?.deviceName == null ? null : String(grant.deviceName).replace(/\s+/g, " ").trim().slice(0, 80) || null;
      const externalId = createHash("sha256").update(`${platform}\u0000${token}`).digest("hex").slice(0, 32);
      const credentialRef = channelCredentialConnector("app", externalId);
      await credentials.setChannelSecret(userId, credentialRef, token);
      const { binding, taken } = await store.claimBinding(userId, "app", {
        externalId, credentialRef, metadata: { platform, deviceName },
      });
      for (const previous of taken) {
        if (previous.credentialRef) await credentials.removeChannelSecret(previous.userId, previous.credentialRef).catch(() => false);
      }
      return binding;
    },

    /** @param {any} binding @param {any} message */
    async deliver(binding, message) {
      if (!pushProvider) return { delivered: false, reason: "not-configured" };
      const token = await credentials?.resolveChannelSecret(binding.userId, binding.credentialRef);
      if (!token) return { delivered: false, reason: "push_token_missing" };
      return deliveryOutcome(await pushProvider.send({ platform: binding.metadata?.platform, token, message }));
    },

    // The app talks to the control plane through the run API; nothing arrives
    // through a push channel.
    onInbound: async () => ({ accepted: false, reason: "not-supported" }),
  });
}
