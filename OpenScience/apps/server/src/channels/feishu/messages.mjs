/*
 * Portions adapted from xmanrui/dsh-im (src/channels/feishu/message-utils.mjs),
 * MIT License, Copyright (c) 2026 xmanrui. The text / post / mention handling
 * below is theirs in substance; the normalized event shape is ours.
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
 * One Feishu `im.message.receive_v1` event, reduced to what the IM service
 * reads: who sent it, in which chat, and the words.
 *
 * Only words are carried. A file, an image or a voice note gets an honest
 * "text only for now" reply rather than a run that cannot see it; the event's
 * other fields (tenant keys, raw content, mention ids) never leave this
 * function, so the durable inbound row holds no more than it has to.
 *
 * @module channels/feishu/messages
 */

/** Longest message text carried into a run. Feishu itself caps a text message
 *  at 150 KB; a research question longer than this is a document and belongs
 *  in the knowledge base. */
export const MAX_INBOUND_TEXT = 8_000;

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {any} event */
function parsedContent(event) {
  const value = event?.message?.content;
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A mention arrives in the text as a placeholder (`@_user_1`) with the real
 * name in `mentions`; the placeholder means nothing to a model.
 * @param {unknown} text @param {any} event
 */
function withoutMentions(text, event) {
  let result = typeof text === "string" ? text : "";
  for (const mention of event?.message?.mentions ?? []) {
    if (typeof mention?.key === "string" && mention.key) result = result.replaceAll(mention.key, "");
  }
  return result.trim();
}

/** @param {any} event @param {any} parsed */
function postText(event, parsed) {
  const lines = [];
  const title = nonEmpty(withoutMentions(parsed?.title, event));
  if (title) lines.push(title);
  for (const paragraph of Array.isArray(parsed?.content) ? parsed.content : []) {
    if (!Array.isArray(paragraph)) continue;
    let visible = "";
    for (const element of paragraph) {
      const tag = String(element?.tag ?? "").toLowerCase();
      if ((tag === "text" || tag === "a" || tag === "link") && typeof element?.text === "string") visible += element.text;
    }
    const line = nonEmpty(withoutMentions(visible, event));
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Whether a group message is addressed to this bot. In a group Feishu
 * delivers only messages that mention the bot unless the app holds the
 * all-messages scope, which is not requested; the check stays so a later
 * scope change cannot turn every group message into a run.
 * @param {any} event @param {string | null} botOpenId
 */
function mentionsBot(event, botOpenId) {
  const mentions = Array.isArray(event?.message?.mentions) ? event.message.mentions : [];
  if (!botOpenId) return mentions.length > 0;
  return mentions.some((mention) => mention?.id?.open_id === botOpenId);
}

/**
 * @typedef {object} FeishuInbound
 * @property {string} eventId
 * @property {string} messageId
 * @property {string} chatId
 * @property {'p2p' | 'group'} chatType
 * @property {string} senderOpenId
 * @property {string} messageType
 * @property {string} text          empty when the message carries no words
 * @property {boolean} supported    false: a file, image, voice note, sticker…
 * @property {boolean} addressed    in a group: whether the bot was mentioned
 * @property {string | null} createdAt
 */

/**
 * @param {any} payload the dispatcher's flattened v2 event
 * @param {{ botOpenId?: string | null }} [options]
 * @returns {FeishuInbound | null} null when it is not a message a person sent
 */
export function normalizeInboundMessage(payload, { botOpenId = null } = {}) {
  const message = payload?.message;
  const eventId = nonEmpty(payload?.event_id) ?? nonEmpty(payload?.header?.event_id);
  const messageId = nonEmpty(message?.message_id);
  const chatId = nonEmpty(message?.chat_id);
  const senderOpenId = nonEmpty(payload?.sender?.sender_id?.open_id);
  // Another bot's message (including our own echo) is never a request.
  if (payload?.sender?.sender_type && payload.sender.sender_type !== "user") return null;
  if (!eventId || !messageId || !chatId || !senderOpenId) return null;
  const chatType = message?.chat_type === "p2p" ? "p2p" : "group";
  const messageType = String(message?.message_type ?? "");
  const parsed = parsedContent(payload);
  let text = "";
  if (messageType === "text") text = withoutMentions(parsed?.text, payload);
  else if (messageType === "post") text = postText(payload, parsed);
  const supported = messageType === "text" || messageType === "post";
  const created = Number(message?.create_time);
  return {
    eventId,
    messageId,
    chatId,
    chatType,
    senderOpenId,
    messageType,
    text: [...text].slice(0, MAX_INBOUND_TEXT).join(""),
    supported,
    addressed: chatType === "p2p" || mentionsBot(payload, botOpenId),
    createdAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null,
  };
}
