/**
 * Feishu, as a channel: the port's three calls, plus the conversation
 * operations only a chat channel has — a progress card updated in place, an
 * answer, a file.
 *
 * What it deliberately does not have, and why (plan §3.6, dsh-im review):
 * no in-chat command switches the workspace path, the model, the preset or the
 * permission mode. Those are control-plane decisions, and `/permission` in
 * particular bypasses the runtime method deny list. No approval cards either:
 * the hosted approval policy is `never`, so there is nothing to approve. The
 * only thing a message can change besides starting work is which project the
 * chat talks to, and that is understood by a model, not parsed as a command.
 *
 * @module channels/feishu/adapter
 */

import { HttpError } from "../../security.mjs";
import { channelCredentialConnector } from "../../connectorCredentials.mjs";
import { assertChannelAdapter, deliveryOutcome } from "../port.mjs";
import { FeishuApiError, FeishuClient, messageUuid } from "./client.mjs";
import { PROGRESS_ELEMENT, STATUS_ELEMENT, answerCards, escapeCardText, finishedCard, noticeCard, progressCard } from "./cards.mjs";
import { normalizeInboundMessage } from "./messages.mjs";
import { SecretScrubber } from "./redact.mjs";

/** The connector id a Feishu App Secret is held under in the credential store. */
export const FEISHU_CREDENTIAL = channelCredentialConnector("feishu");

/**
 * What the scan asks Feishu to grant: read what people send the bot one to
 * one and what they mention it with in a group, send as the bot, upload the
 * report files, and write CardKit cards. Nothing else — `addons.preset: false`
 * drops the platform's default template so the confirmation page lists
 * exactly these (dsh-im asks for the same core set).
 */
export const FEISHU_TENANT_SCOPES = Object.freeze([
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
  "im:resource",
  "cardkit:card:write",
]);
export const FEISHU_EVENTS = Object.freeze(["im.message.receive_v1"]);

/** Streaming mode closes itself ten minutes after it was last opened; it is
 *  reopened a minute early so a long run's card never falls back to a full
 *  replace mid-task. */
const STREAMING_REOPEN_MS = 9 * 60_000;

/** `activate_status` values that mean "created, waiting to be enabled" —
 *  in an enterprise tenant, an administrator's approval (bot/v3/info). */
export const FEISHU_PENDING_ACTIVATION = Object.freeze([0, 3, 4]);
/** Values that mean the tenant has switched the app off or lapsed. */
export const FEISHU_DISABLED_ACTIVATION = Object.freeze([1, 5, 6]);

/**
 * @param {{ loadSdk: () => Promise<any>, store: any, credentials: any, scrubber?: SecretScrubber,
 *   inbound?: { accept: (input: { binding: any, message: any }) => Promise<void> } | null, now?: () => number }} input
 */
export function createFeishuChannel({ loadSdk, store, credentials, scrubber = new SecretScrubber(), inbound = null, now = Date.now }) {
  /** @type {Map<string, { secret: string, client: FeishuClient }>} */
  const clients = new Map();

  /** @param {any} binding @returns {Promise<FeishuClient>} */
  async function clientFor(binding) {
    if (!credentials) throw new HttpError(503, "channel_credentials_unavailable", "Channel credentials are unavailable.");
    const secret = await credentials.resolveChannelSecret(binding.userId, binding.credentialRef ?? FEISHU_CREDENTIAL);
    if (!secret) throw new FeishuApiError("feishu_secret_missing", "The bot's App Secret is no longer held.");
    const cached = clients.get(binding.id);
    if (cached && cached.secret === secret) return cached.client;
    const client = new FeishuClient({
      sdk: await loadSdk(), appId: binding.metadata.appId, appSecret: secret,
      domain: binding.metadata.tenantBrand === "lark" ? "lark" : "feishu", scrubber,
    });
    clients.set(binding.id, { secret, client });
    return client;
  }

  /** @param {any} binding @param {string} chatId */
  const chatTarget = (binding, chatId) => (chatId ? { type: /** @type {const} */ ("chat_id"), id: chatId }
    : { type: /** @type {const} */ ("open_id"), id: binding.externalId });

  /**
   * Stream one element, reopening streaming mode a minute before Feishu
   * closes it on its own. Escaped like every other card text: a deliverable
   * title in the progress lines is model output.
   * @param {FeishuClient} client @param {any} card @param {string} elementId @param {string} content
   */
  async function streamElement(client, card, elementId, content) {
    if (now() - Number(card.streamingOpenedAt ?? 0) > STREAMING_REOPEN_MS) {
      await client.cardSettings({ cardId: card.cardId, config: { streaming_mode: true }, sequence: ++card.sequence });
      card.streamingOpenedAt = now();
    }
    await client.streamText({ cardId: card.cardId, elementId, content: escapeCardText(content), sequence: ++card.sequence });
  }

  const conversation = {
    /**
     * The task's card: created as an entity, sent as a reply to the message
     * that asked. Returns the state the task row keeps.
     * @param {{ binding: any, chatId: string, replyTo?: string | null, question: string, status: string, progress?: string,
     *   link?: string | null, key: string }} input
     */
    async openCard({ binding, chatId, replyTo = null, question, status, progress = "", link = null, key }) {
      const client = await clientFor(binding);
      const cardId = await client.createCard(progressCard({ question, status, progress, link }));
      const messageId = await client.send({
        to: chatTarget(binding, chatId), replyTo, msgType: "interactive",
        content: { type: "card", data: { card_id: cardId } }, uuid: messageUuid(`card:${key}`),
      });
      return { cardId, messageId, sequence: 0, streamingOpenedAt: now(), question, link, status, progress };
    },

    /**
     * Update the card in place: the status line and the progress text, each
     * only when it changed. A streaming call Feishu refuses outright — the
     * stream closed while the process was down, a code this file does not
     * know — falls back to one full replace of the same card, so the reader
     * still sees the current state. Mutates and returns the card state.
     * @param {{ binding: any, card: any, status: string, progress: string }} input
     */
    async updateCard({ binding, card, status, progress }) {
      const client = await clientFor(binding);
      try {
        if (status !== card.status) {
          await streamElement(client, card, STATUS_ELEMENT, status);
          card.status = status;
        }
        if (progress !== card.progress) {
          await streamElement(client, card, PROGRESS_ELEMENT, progress || " ");
          card.progress = progress;
        }
      } catch (error) {
        if (!(error instanceof FeishuApiError) || error.retryable) throw error;
        await client.updateCard({
          cardId: card.cardId, sequence: ++card.sequence,
          card: progressCard({ question: card.question ?? "", status, progress, link: card.link ?? null }),
        });
        card.status = status;
        card.progress = progress;
        card.streamingOpenedAt = now();
      }
      return card;
    },

    /**
     * The card's last state: streaming off, coloured by outcome, one replace.
     * @param {{ binding: any, card: any, question: string, outcome: 'delivered' | 'qualified' | 'failed' | 'stopped',
     *   status: string, lines?: string[], link?: string | null }} input
     */
    async closeCard({ binding, card, question, outcome, status, lines = [], link = null }) {
      const client = await clientFor(binding);
      await client.updateCard({
        cardId: card.cardId, card: finishedCard({ question, outcome, status, lines, link }), sequence: ++card.sequence,
      });
      card.status = status;
      card.closed = true;
      return card;
    },

    /** @param {{ binding: any, chatId: string, replyTo?: string | null, text: string, link?: string | null, key: string }} input
     *  @returns {Promise<string[]>} the message ids, one per card */
    async sendAnswer({ binding, chatId, replyTo = null, text, link = null, key }) {
      const client = await clientFor(binding);
      const ids = [];
      for (const [index, card] of answerCards({ text, link }).entries()) {
        ids.push(await client.send({
          to: chatTarget(binding, chatId), replyTo: index === 0 ? replyTo : null, msgType: "interactive",
          content: card, uuid: messageUuid(`answer:${key}:${index}`),
        }));
      }
      return ids;
    },

    /** @param {{ binding: any, chatId: string, replyTo?: string | null, text: string, key: string }} input */
    async sendText({ binding, chatId, replyTo = null, text, key }) {
      const client = await clientFor(binding);
      return client.send({
        to: chatTarget(binding, chatId), replyTo, msgType: "text",
        content: { text: String(text).slice(0, 4_000) }, uuid: messageUuid(`text:${key}`),
      });
    },

    /** @param {{ binding: any, chatId: string, replyTo?: string | null, fileName: string, bytes: Buffer, key: string }} input */
    async sendFile({ binding, chatId, replyTo = null, fileName, bytes, key }) {
      const client = await clientFor(binding);
      const fileKey = await client.uploadFile({ fileName, bytes });
      return client.send({
        to: chatTarget(binding, chatId), replyTo, msgType: "file", content: { file_key: fileKey },
        uuid: messageUuid(`file:${key}`),
      });
    },
  };

  return assertChannelAdapter({
    id: "feishu",
    title: "飞书",
    reserved: false,
    conversation,
    status: () => ({ state: "ready", reason: null }),

    /**
     * Turn a completed scan into the account's binding. The credentials are
     * checked against Feishu before anything is stored: a secret that cannot
     * fetch the bot's own identity is not worth keeping.
     * @param {string} userId
     * @param {{ appId: string, appSecret: string, ownerOpenId: string, tenantBrand?: 'feishu' | 'lark' }} grant
     */
    async bind(userId, grant) {
      if (!store || !credentials) throw new HttpError(503, "channel_store_unavailable", "Channel storage is unavailable.");
      const appId = String(grant?.appId ?? "");
      const appSecret = String(grant?.appSecret ?? "");
      const ownerOpenId = String(grant?.ownerOpenId ?? "");
      if (!/^cli_[0-9a-zA-Z]{8,32}$/.test(appId) || !appSecret || !ownerOpenId) {
        throw new HttpError(400, "feishu_grant_invalid", "The Feishu grant is incomplete.");
      }
      const tenantBrand = grant.tenantBrand === "lark" ? "lark" : "feishu";
      scrubber.add(appSecret);
      const probe = new FeishuClient({ sdk: await loadSdk(), appId, appSecret, domain: tenantBrand, scrubber });
      const bot = await probe.botInfo();
      await credentials.setChannelSecret(userId, FEISHU_CREDENTIAL, appSecret);
      const { binding, replaced } = await store.replaceBinding(userId, "feishu", {
        externalId: ownerOpenId,
        credentialRef: FEISHU_CREDENTIAL,
        metadata: {
          appId, tenantBrand, botName: bot.name, botOpenId: bot.openId,
          activateStatus: bot.activateStatus, boundAt: new Date(now()).toISOString(),
        },
      });
      for (const previous of replaced) clients.delete(previous.id);
      return { ...binding, replaced };
    },

    /**
     * Push one inbox item to the account owner's chat with their bot.
     * @param {any} binding @param {ReturnType<typeof import("../port.mjs").channelMessage>} message
     */
    async deliver(binding, message) {
      const client = await clientFor(binding);
      const messageId = await client.send({
        to: { type: "open_id", id: binding.externalId }, msgType: "interactive",
        content: noticeCard({ title: message.title, body: message.body, link: message.link,
          linkLabel: message.linkLabel, severity: message.severity }),
        uuid: messageUuid(`deliver:${binding.id}:${message.idempotencyKey ?? `${message.title}\u0000${message.body}`}`),
      });
      return deliveryOutcome({ delivered: true, messageId });
    },

    /**
     * One event off a long connection. Only the account owner's messages
     * start work: the bot acts for the person who created it, and a group
     * member who is not that person has no account here to spend.
     * @param {{ binding: any, payload: any }} event
     */
    async onInbound({ binding, payload }) {
      const message = normalizeInboundMessage(payload, { botOpenId: binding.metadata?.botOpenId ?? null });
      if (!message) return { accepted: false, reason: "not-a-message" };
      if (message.senderOpenId !== binding.externalId) return { accepted: false, reason: "not-owner" };
      if (!message.addressed) return { accepted: false, reason: "not-addressed" };
      if (!inbound) return { accepted: false, reason: "no-inbound-handler" };
      await inbound.accept({ binding, message });
      return { accepted: true, reason: null };
    },

    /** Read the bot's identity and activation again (an administrator may
     *  have enabled it since the scan). @param {any} binding */
    async refresh(binding) {
      return (await clientFor(binding)).botInfo();
    },

    /** Drop a cached client, after an unbind or a re-scan. @param {string} bindingId */
    forget(bindingId) {
      clients.delete(bindingId);
    },
  });
}
