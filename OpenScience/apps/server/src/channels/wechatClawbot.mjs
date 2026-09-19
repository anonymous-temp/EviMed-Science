import { reservedChannel } from "./port.mjs";

/**
 * Personal WeChat through ClawBot / iLink — a reservation.
 *
 * Deliberately not the phone channel, and the reason belongs here: a reply
 * token lives about two minutes after a turn starts (openclaw-weixin issue
 * #286), pushes are refused after roughly fifteen hours of silence (#309), and
 * a send can report success and never arrive (#305). A 10–40 minute run cannot
 * be answered through it, so at most it will carry short answers. Reports
 * not-configured until someone decides it is worth that.
 */
export function createWechatClawbotChannel() {
  return reservedChannel({
    id: "wechat-clawbot",
    notes: "HTTP long polling; reply token ~2 min, so short answers only.",
  });
}
