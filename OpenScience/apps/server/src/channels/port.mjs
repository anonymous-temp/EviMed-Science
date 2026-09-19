/**
 * The channel port: every way the control plane reaches a researcher outside
 * the page goes through the same three calls.
 *
 * Hidden knowledge: the owner configures channels one at a time, later (plan
 * §3.6, 2026-09-19 ruling). Feishu is the only one built; WeChat service
 * account, WeChat ClawBot, email, the own app, DingTalk and WeCom are reserved
 * ids behind default-off switches. So a channel is exactly an adapter file and
 * a switch — nothing else in the control plane may name one. The inbox, the IM
 * service and the routes ask the registry (`registry.mjs`), never an adapter
 * module, and adding WeCom later is one file, one config key and one registry
 * row, with no other file touched.
 *
 *  - `bind(userId, grant)` → `{ channel, externalId, credentialRef }`: the
 *    durable link between an account and one identity on the channel. What
 *    grants it is the channel's own business (Feishu: a completed
 *    scan-to-create); the binding's shape is not.
 *  - `deliver(binding, message)` → `{ delivered, messageId? }`. No message id
 *    means not delivered: a provider that answered without naming the message
 *    it created has shown nobody anything we can point at, and Feishu's 230049
 *    ("the send result is uncertain") answers exactly that way.
 *  - `onInbound(event)` → attribute one inbound message to an account's
 *    project and turn it into an ordinary run request.
 *
 * A channel is a way out and a way in; it is never a new place where
 * research happens. Inbound work goes through the same dispatch the web uses.
 *
 * @module channels/port
 */

import { HttpError } from "../security.mjs";

/** Every channel id this control plane knows. Closed: a preference, a binding
 *  row and a switch name are all drawn from it. */
export const CHANNEL_IDS = Object.freeze(["feishu", "wechat-service", "wechat-clawbot", "email", "app", "dingtalk", "wecom"]);

/** The ids that exist only as reservations: an adapter that reports
 *  `not-configured`, and a switch that defaults off. */
export const RESERVED_CHANNEL_IDS = Object.freeze(CHANNEL_IDS.filter((id) => id !== "feishu"));

/** The inbox itself. Always a delivery channel, never a registry entry. */
export const IN_APP_CHANNEL = "in-app";

/** The reader's names, for the settings page and error text. */
export const CHANNEL_TITLES = Object.freeze({
  feishu: "飞书",
  "wechat-service": "微信服务号",
  "wechat-clawbot": "微信 ClawBot",
  email: "邮件",
  app: "EviMed App",
  dingtalk: "钉钉",
  wecom: "企业微信",
});

/** The states a channel reports. `not-configured` is a reservation, or a
 *  built channel whose deployment has not supplied what it needs. */
export const CHANNEL_STATES = Object.freeze(["ready", "not-configured", "disabled"]);

/** The kinds of message a channel is handed. */
export const CHANNEL_MESSAGE_KINDS = Object.freeze(["notification", "text"]);

const SEVERITIES = Object.freeze(["safety", "attention", "info"]);

/**
 * The environment variable that switches one channel on.
 * @param {string} id @returns {string}
 */
export function channelSwitchName(id) {
  return `OPEN_SCIENCE_CHANNEL_${String(id).toUpperCase().replaceAll("-", "_")}_ENABLED`;
}

/** @param {unknown} id @returns {id is string} */
export function isChannelId(id) {
  return typeof id === "string" && CHANNEL_IDS.includes(id);
}

/**
 * The one message shape every adapter receives, validated once here so no
 * adapter has to guess what a caller meant.
 * @param {Record<string, any>} input
 * @returns {{ kind: string, title: string, body: string, link: string | null, linkLabel: string | null,
 *   severity: string, idempotencyKey: string | null }}
 */
export function channelMessage(input) {
  const kind = String(input?.kind ?? "notification");
  if (!CHANNEL_MESSAGE_KINDS.includes(kind)) throw new TypeError(`Unknown channel message kind: ${kind}`);
  const title = oneLine(input?.title, 150);
  const body = String(input?.body ?? "").trim().slice(0, 8_000);
  if (!title && !body) throw new TypeError("A channel message needs a title or a body.");
  const link = input?.link == null || input.link === "" ? null : String(input.link);
  if (link !== null) {
    let parsed;
    try { parsed = new URL(link); } catch { throw new TypeError("A channel message link must be an absolute URL."); }
    if (!["https:", "http:"].includes(parsed.protocol)) throw new TypeError("A channel message link must be http(s).");
  }
  const severity = SEVERITIES.includes(input?.severity) ? input.severity : "info";
  const idempotencyKey = input?.idempotencyKey == null ? null : String(input.idempotencyKey).slice(0, 200);
  return {
    kind, title, body, link, linkLabel: link ? oneLine(input?.linkLabel, 20) || "在网页中查看" : null,
    severity, idempotencyKey,
  };
}

/** @param {unknown} value @param {number} max */
function oneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
}

/**
 * What a delivery amounted to, whatever the adapter answered.
 *
 * The rule is the port's, applied here so that no adapter can report a
 * delivery it cannot point at: without a message id it did not happen.
 * @param {unknown} result
 * @returns {{ delivered: boolean, messageId: string | null, reason: string | null }}
 */
export function deliveryOutcome(result) {
  const value = /** @type {Record<string, any>} */ (result && typeof result === "object" ? result : {});
  const messageId = typeof value.messageId === "string" && value.messageId.trim() ? value.messageId.trim() : null;
  const delivered = value.delivered === true && messageId !== null;
  const reason = delivered ? null
    : typeof value.reason === "string" && value.reason ? value.reason.slice(0, 120)
      : value.delivered === true ? "message_id_missing" : "not_delivered";
  return { delivered, messageId: delivered ? messageId : null, reason };
}

/**
 * Refuse an adapter that does not have the port's shape, at composition time
 * rather than on the first message it is asked to carry.
 * @param {any} adapter
 */
export function assertChannelAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("A channel adapter must be an object.");
  if (!isChannelId(adapter.id)) throw new TypeError(`A channel adapter names an unknown channel: ${adapter.id}`);
  for (const method of ["status", "bind", "deliver", "onInbound"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`Channel adapter ${adapter.id} has no ${method}().`);
  }
  return adapter;
}

/**
 * A reserved channel: the port's shape and nothing behind it.
 *
 * Deliberately inert rather than absent. The switch can be turned on, a
 * preference can name it and the inbox can route to it, and each of those
 * meets an answer that says `not-configured` by name instead of an error from
 * a code path nobody wrote.
 * @param {{ id: string, notes?: string }} spec
 */
export function reservedChannel({ id, notes = "" }) {
  if (!RESERVED_CHANNEL_IDS.includes(id)) throw new TypeError(`${id} is not a reserved channel id.`);
  const title = CHANNEL_TITLES[/** @type {keyof typeof CHANNEL_TITLES} */ (id)];
  return assertChannelAdapter({
    id,
    title,
    reserved: true,
    notes,
    status: () => ({ state: "not-configured", reason: `${title}渠道尚未配置。` }),
    bind: async () => {
      throw new HttpError(409, "channel_not_configured", `${title}渠道尚未配置，暂时不能绑定。`);
    },
    deliver: async () => ({ delivered: false, reason: "not-configured" }),
    onInbound: async () => ({ accepted: false, reason: "not-configured" }),
  });
}
