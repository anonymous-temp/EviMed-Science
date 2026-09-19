import { reservedChannel } from "./port.mjs";

/**
 * Email (digests and completion notices) — a reservation.
 *
 * What configuring it takes: a sending provider or SMTP relay, a sender domain
 * with SPF and DKIM so the mail is not filed as spam, and the researcher's
 * address confirmed by a link. The inbox item is the message; this only
 * carries it. Reports not-configured until then.
 */
export function createEmailChannel() {
  return reservedChannel({
    id: "email",
    notes: "Needs a sending provider and a verified sender domain.",
  });
}
