import { reservedChannel } from "./port.mjs";

/**
 * DingTalk — a reservation.
 *
 * When it is built it looks like Feishu here: Stream mode is an outbound
 * connection (fits a host that opens only 80/443), available to internal apps,
 * with an ISV push configuration for store apps. The per-user app key and
 * secret would go into the credential store's channel slot. Reports
 * not-configured until then.
 */
export function createDingtalkChannel() {
  return reservedChannel({
    id: "dingtalk",
    notes: "Stream mode (outbound), internal apps; ISV push for store apps.",
  });
}
