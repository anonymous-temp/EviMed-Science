import { reservedChannel } from "./port.mjs";

/**
 * WeChat service account (微信服务号) template messages — a reservation.
 *
 * What configuring it takes, so whoever does it starts from facts rather than
 * a search: a verified service account (企业认证), one approved template per
 * notice kind, and each researcher's openid under that account, bound by
 * scanning a parametric QR code that follows the account. The account's
 * AppSecret goes into the per-user credential store's channel slot like
 * Feishu's does. Until then it reports not-configured and delivers nothing
 * (plan §3.6, 2026-09-19 ruling: every channel but Feishu waits).
 */
export function createWechatServiceChannel() {
  return reservedChannel({
    id: "wechat-service",
    notes: "Template messages from a verified service account; binding = the user's openid via a parametric QR code.",
  });
}
