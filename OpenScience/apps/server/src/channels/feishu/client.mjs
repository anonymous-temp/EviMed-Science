/*
 * Portions adapted from xmanrui/dsh-im (src/channels/feishu/feishu-channel.mjs
 * and feishu-app.mjs), MIT License, Copyright (c) 2026 xmanrui: the provider
 * error table, the error-code walk, the 230049 same-uuid resend, the CardKit
 * streaming calls and the bot verification requests.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: the above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND.
 */

/**
 * One Feishu app's OpenAPI, as the channel uses it.
 *
 * Every call returns an id or throws a `FeishuApiError` that names what went
 * wrong in our vocabulary and says whether trying again can help. The raw
 * SDK error never leaves this file: it can hold the request that failed, and
 * one of those requests carries the App Secret (see `redact.mjs`).
 *
 * @module channels/feishu/client
 */

import { createHash } from "node:crypto";
import { SecretScrubber, describeError, sdkLogger } from "./redact.mjs";

/** Feishu refuses a file larger than this (im/v1/files: "文件大小不得超过 30 MB"). */
export const FEISHU_MAX_FILE_BYTES = 30 * 1024 * 1024;

/** How long one OpenAPI call may take. A card update that has not answered
 *  in 15 s is better retried on the next tick than waited for. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Uploads are the exception: 30 MB over a shared uplink takes longer. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * What a provider code means for us. From dsh-im's delivery table plus the
 * credential and frequency codes the channel meets outside file delivery.
 */
const PROVIDER_CODES = new Map([
  [99991672, { code: "feishu_permission_missing", retryable: false }],
  [99991663, { code: "feishu_credentials_invalid", retryable: false }],
  [99991664, { code: "feishu_credentials_invalid", retryable: false }],
  [99991661, { code: "feishu_credentials_invalid", retryable: false }],
  [10003, { code: "feishu_credentials_invalid", retryable: false }],
  [10014, { code: "feishu_credentials_invalid", retryable: false }],
  [99991400, { code: "feishu_rate_limited", retryable: true }],
  [230020, { code: "feishu_rate_limited", retryable: true }],
  [234006, { code: "feishu_file_too_large", retryable: false }],
  [234010, { code: "feishu_file_empty", retryable: false }],
  [230017, { code: "feishu_file_rejected", retryable: false }],
  [230055, { code: "feishu_file_rejected", retryable: false }],
  // "The send result is uncertain": resend once with the same uuid and let the
  // platform deduplicate (dsh-im feishu-channel.mjs).
  [230049, { code: "feishu_delivery_uncertain", retryable: true, uncertain: true }],
  [230002, { code: "feishu_chat_unavailable", retryable: false }],
  [230013, { code: "feishu_user_unavailable", retryable: false }],
]);

export class FeishuApiError extends Error {
  /**
   * @param {string} code our code
   * @param {string} message one line, already scrubbed
   * @param {{ providerCode?: number | null, status?: number | null, retryable?: boolean, uncertain?: boolean }} [detail]
   */
  constructor(code, message, { providerCode = null, status = null, retryable = false, uncertain = false } = {}) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
    this.providerCode = providerCode;
    this.status = status;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

/** The first non-zero provider code anywhere in an error or a response body
 *  (dsh-im's walk: the SDK nests it differently per call). @param {any} cause */
export function providerErrorCode(cause) {
  const pending = [cause];
  const seen = new Set();
  let fallback = null;
  while (pending.length > 0) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const code = Number(value.code);
    if (Number.isFinite(code) && code !== 0) {
      if (PROVIDER_CODES.has(code)) return code;
      fallback ??= code;
    }
    pending.push(value.response?.data, value.data, value.error, value.cause);
  }
  return fallback;
}

/**
 * @param {string} stage what we were doing, for the message
 * @param {any} cause @param {SecretScrubber} scrubber
 * @param {{ sent?: boolean }} [options] whether the request may have reached Feishu
 * @returns {FeishuApiError}
 */
export function feishuError(stage, cause, scrubber, { sent = false } = {}) {
  if (cause instanceof FeishuApiError) return cause;
  const providerCode = providerErrorCode(cause);
  const status = Number(cause?.response?.status ?? cause?.status);
  const known = providerCode == null ? null : PROVIDER_CODES.get(providerCode);
  const line = `Feishu ${stage} failed: ${describeError(cause, scrubber)}`;
  if (known) return new FeishuApiError(known.code, line, { providerCode, status, retryable: known.retryable, uncertain: known.uncertain === true });
  if (Number.isFinite(status) && status === 429) return new FeishuApiError("feishu_rate_limited", line, { providerCode, status, retryable: true });
  if (Number.isFinite(status) && status >= 500) return new FeishuApiError("feishu_unavailable", line, { providerCode, status, retryable: true });
  if (!Number.isFinite(status) && providerCode == null) {
    // No answer at all: a timeout or a dropped connection. For a send it may
    // have landed, which is what the per-message uuid is for.
    return new FeishuApiError("feishu_unreachable", line, { retryable: true, uncertain: sent });
  }
  return new FeishuApiError("feishu_api_failed", line, { providerCode, status, retryable: false });
}

/**
 * A stable Feishu message uuid for one logical message. Feishu delivers at most
 * one message per uuid within an hour, which is what makes a resend after an
 * uncertain answer safe instead of a duplicate.
 * @param {string} key
 */
export function messageUuid(key) {
  return `evm_${createHash("sha256").update(String(key)).digest("hex").slice(0, 40)}`;
}

/** @param {any} httpInstance @param {number} timeoutMs */
function withTimeout(httpInstance, timeoutMs) {
  if (!httpInstance || typeof httpInstance.request !== "function") return undefined;
  const merged = (/** @type {any} */ options) => ({ ...(options ?? {}), timeout: options?.timeout ?? timeoutMs });
  return {
    request: (/** @type {any} */ options) => httpInstance.request(merged(options)),
    get: (/** @type {string} */ url, /** @type {any} */ options) => httpInstance.get(url, merged(options)),
    delete: (/** @type {string} */ url, /** @type {any} */ options) => httpInstance.delete(url, merged(options)),
    head: (/** @type {string} */ url, /** @type {any} */ options) => httpInstance.head(url, merged(options)),
    options: (/** @type {string} */ url, /** @type {any} */ options) => httpInstance.options(url, merged(options)),
    post: (/** @type {string} */ url, /** @type {any} */ data, /** @type {any} */ options) => httpInstance.post(url, data, merged(options)),
    put: (/** @type {string} */ url, /** @type {any} */ data, /** @type {any} */ options) => httpInstance.put(url, data, merged(options)),
    patch: (/** @type {string} */ url, /** @type {any} */ data, /** @type {any} */ options) => httpInstance.patch(url, data, merged(options)),
  };
}

/** A response body that says it failed. @param {any} body */
function failedBody(body) {
  return body && typeof body === "object" && Number.isFinite(Number(body.code)) && Number(body.code) !== 0;
}

export class FeishuClient {
  /**
   * @param {{ sdk: any, appId: string, appSecret: string, domain?: 'feishu' | 'lark', scrubber?: SecretScrubber }} input
   */
  constructor({ sdk, appId, appSecret, domain = "feishu", scrubber = new SecretScrubber() }) {
    if (!sdk?.Client) throw new TypeError("FeishuClient needs the Feishu SDK.");
    if (typeof appId !== "string" || !appId || typeof appSecret !== "string" || !appSecret) {
      throw new TypeError("FeishuClient needs an App ID and an App Secret.");
    }
    this.appId = appId;
    this.domain = domain;
    this.scrubber = scrubber;
    scrubber.add(appSecret);
    const base = {
      appId,
      appSecret,
      domain: domain === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu,
      loggerLevel: sdk.LoggerLevel?.warn,
      logger: sdkLogger(scrubber),
    };
    const http = withTimeout(sdk.defaultHttpInstance, REQUEST_TIMEOUT_MS);
    this.client = new sdk.Client(http ? { ...base, httpInstance: http } : base);
    const uploadHttp = withTimeout(sdk.defaultHttpInstance, UPLOAD_TIMEOUT_MS);
    this.uploadClient = uploadHttp ? new sdk.Client({ ...base, httpInstance: uploadHttp }) : this.client;
  }

  /**
   * The bot behind this app, and whether its tenant has enabled it
   * (`activate_status` 2). 0/3/4 are "installed, waiting to be enabled" —
   * in an enterprise tenant that is an administrator's approval.
   * @returns {Promise<{ name: string | null, openId: string | null, activateStatus: number | null }>}
   */
  async botInfo() {
    let body;
    try {
      body = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
    } catch (error) {
      throw feishuError("bot verification", error, this.scrubber);
    }
    if (failedBody(body)) throw feishuError("bot verification", body, this.scrubber);
    const bot = body?.bot ?? body?.data?.bot ?? {};
    const status = Number(bot.activate_status);
    return {
      name: typeof bot.app_name === "string" ? bot.app_name : null,
      openId: typeof bot.open_id === "string" ? bot.open_id : null,
      activateStatus: Number.isFinite(status) ? status : null,
    };
  }

  /**
   * Send one message: to a user or a chat, or as a reply to a message. A
   * reply whose target has gone is sent as a plain message instead; a
   * 230049 is resent once under the same uuid.
   * @param {{ to?: { type: 'open_id' | 'chat_id', id: string } | null, replyTo?: string | null,
   *   msgType: 'text' | 'interactive' | 'file', content: Record<string, any>, uuid: string }} input
   * @returns {Promise<string>} the message id
   */
  async send({ to = null, replyTo = null, msgType, content, uuid }) {
    const payload = JSON.stringify(content);
    const create = () => {
      if (!to) throw new FeishuApiError("feishu_target_missing", "Feishu send has no target.");
      return this.client.im.v1.message.create({
        params: { receive_id_type: to.type },
        data: { receive_id: to.id, msg_type: msgType, content: payload, uuid },
      });
    };
    const reply = () => this.client.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: msgType, content: payload, uuid },
    });
    const attempt = async (/** @type {() => Promise<any>} */ call) => {
      let body;
      try {
        body = await call();
      } catch (error) {
        throw feishuError("message send", error, this.scrubber, { sent: true });
      }
      if (failedBody(body)) throw feishuError("message send", body, this.scrubber, { sent: true });
      const messageId = body?.data?.message_id ?? body?.message_id;
      if (typeof messageId !== "string" || !messageId) {
        throw new FeishuApiError("feishu_delivery_uncertain", "Feishu accepted the send but named no message.", { retryable: true, uncertain: true });
      }
      return messageId;
    };
    const once = async (/** @type {() => Promise<any>} */ call) => {
      try {
        return await attempt(call);
      } catch (error) {
        if (error instanceof FeishuApiError && error.providerCode === 230049) return attempt(call);
        throw error;
      }
    };
    if (!replyTo) return once(create);
    try {
      return await once(reply);
    } catch (error) {
      // The message being replied to was recalled (230011) or is gone (404):
      // say it in the chat instead of not at all.
      if (to && error instanceof FeishuApiError && (Number(error.providerCode) === 230011 || error.status === 404)) {
        return once(create);
      }
      throw error;
    }
  }

  /** A CardKit card entity, to be sent by reference and updated in place.
   *  @param {Record<string, any>} card @returns {Promise<string>} */
  async createCard(card) {
    let body;
    try {
      body = await this.client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } });
    } catch (error) {
      throw feishuError("card create", error, this.scrubber);
    }
    if (failedBody(body)) throw feishuError("card create", body, this.scrubber);
    const cardId = body?.data?.card_id;
    if (typeof cardId !== "string" || !cardId) throw new FeishuApiError("feishu_api_failed", "Feishu created no card id.");
    return cardId;
  }

  /**
   * Replace one text element of a streaming card; Feishu animates the
   * difference when the new text extends the old.
   * @param {{ cardId: string, elementId: string, content: string, sequence: number }} input
   */
  async streamText({ cardId, elementId, content, sequence }) {
    await this.#card("card stream", () => this.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence, uuid: `c_${cardId}_${sequence}` },
    }));
  }

  /** @param {{ cardId: string, config: Record<string, any>, sequence: number }} input */
  async cardSettings({ cardId, config, sequence }) {
    await this.#card("card settings", () => this.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings: JSON.stringify({ config }), sequence, uuid: `s_${cardId}_${sequence}` },
    }));
  }

  /** Replace the whole card. @param {{ cardId: string, card: Record<string, any>, sequence: number }} input */
  async updateCard({ cardId, card, sequence }) {
    await this.#card("card update", () => this.client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: `u_${cardId}_${sequence}` },
    }));
  }

  /** @param {string} stage @param {() => Promise<any>} call */
  async #card(stage, call) {
    let body;
    try {
      body = await call();
    } catch (error) {
      throw feishuError(stage, error, this.scrubber);
    }
    if (failedBody(body)) throw feishuError(stage, body, this.scrubber);
  }

  /**
   * Upload a file for a file message. Feishu refuses empty files and anything
   * over 30 MB; both are refused here first, by name.
   * @param {{ fileName: string, bytes: Buffer }} input @returns {Promise<string>} the file key
   */
  async uploadFile({ fileName, bytes }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new FeishuApiError("feishu_file_empty", "Feishu does not accept empty files.");
    if (bytes.length > FEISHU_MAX_FILE_BYTES) throw new FeishuApiError("feishu_file_too_large", "The file exceeds Feishu's 30 MB limit.");
    let body;
    try {
      body = await this.uploadClient.im.v1.file.create({ data: { file_type: "stream", file_name: fileName, file: bytes } });
    } catch (error) {
      throw feishuError("file upload", error, this.scrubber);
    }
    if (failedBody(body)) throw feishuError("file upload", body, this.scrubber);
    // The SDK answers this call with the inner data object, not the envelope.
    const fileKey = body?.file_key ?? body?.data?.file_key;
    if (typeof fileKey !== "string" || !fileKey) throw new FeishuApiError("feishu_api_failed", "Feishu returned no file key.");
    return fileKey;
  }
}
