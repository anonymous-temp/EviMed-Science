import { reservedChannel } from "./port.mjs";

/**
 * WeCom (企业微信) smart bot — a reservation.
 *
 * The constraint that will shape the adapter: a smart bot allows one live long
 * connection per bot and either the long connection or an HTTP callback, not
 * both — so, unlike Feishu's cluster mode, two control-plane replicas cannot
 * both hold it. Reports not-configured until it is built.
 */
export function createWecomChannel() {
  return reservedChannel({
    id: "wecom",
    notes: "One long connection per bot; long connection XOR callback.",
  });
}
