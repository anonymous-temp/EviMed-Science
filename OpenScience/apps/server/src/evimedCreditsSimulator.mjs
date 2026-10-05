/**
 * The simulated wallet: the platform's own wallet (`evimedCreditsWallet.mjs`)
 * with the one thing that is simulated about it — a top-up that moves no money
 * (2026-10-04, reshaped 2026-10-05).
 *
 * The owner asked to see research-allowance billing working before a real wallet
 * exists: a balance, an estimate, a charge per finished task, statements, a low
 * balance, recharge and orders. So the one thing that is replaced is the payment.
 * Charges still come from what a task really cost (the usage ledger and the
 * research-allowance policy); a top-up is one of a closed list of packages and
 * becomes a purchased lot with nothing paid for it.
 *
 * Hidden knowledge:
 *
 * - **It is impossible to mistake for the real wallet, in both directions.** Its
 *   payers are `sim:v1:<account>:<incarnation>` and nothing else is accepted, so
 *   a real EviMed user id is refused here; the real client refuses a `sim:` payer
 *   (`evimedCreditsClient.mjs`), so a simulated row can never be sent to the real
 *   wallet. Its tables (`simulated_*`) are its own, and the rows the platform
 *   keeps about charges carry `wallet = 'simulated'`.
 * - **The payer carries the account's incarnation.** An account deleted and
 *   registered again under the same name is a new person; the old wallet is not
 *   theirs, exactly as an old statement is not (`owner_created_at`).
 * - **A wallet exists from its first sight.** The first read, charge or top-up
 *   of an account grants the sign-up gift, once, in the same transaction that
 *   creates the wallet, so two concurrent first sights grant it once — and a task
 *   finished by an account that never opened the page is still charged.
 * - **There is no wire any more.** Until 2026-10-05 this module also spoke the
 *   external wallet's integer wire to the real client, so that swapping the real
 *   wallet in was a configuration change. The platform's wallet holds decimals, lots and
 *   holds, which that wire cannot carry, and a charge and its settlement row are
 *   now one database commit; the emulation had no consumer left and was deleted.
 *
 * Build to delete: the top-up is scaffolding for the owner's evaluation. It goes
 * when a payment provider credits the same wallet through `CreditWallet.credit`.
 *
 * @module evimedCreditsSimulator
 */

import { SIMULATED_START_CREDITS, SIMULATED_TOPUP_PACKAGES, researchMoneyUnits } from "@evimed/domain";
import {
  CreditWallet, SIMULATED_INCARNATION_SQL, SimulatedWalletRefusal, eraseSimulatedWallets, migrateSimulatedWallet,
  parseSimulatedPayer, simulatedPayerId,
} from "./evimedCreditsWallet.mjs";

export { SIMULATED_INCARNATION_SQL, SimulatedWalletRefusal, eraseSimulatedWallets, migrateSimulatedWallet, parseSimulatedPayer, simulatedPayerId };

/** The most whole credits a sign-up gift may carry: a larger number is a defect upstream of here. */
const MAX_START_CREDITS = 10_000_000;
/** The most days a sign-up gift may last. */
const MAX_GIFT_DAYS = 3660;

/**
 * Why the billing module must not come up, as a named code, or null. Each is a
 * fact of the configuration, so the platform boots and the module says no
 * (principle 14: a failed billing module never stops research).
 *
 * - A simulated wallet beside a real wallet's address is a deployment that could
 *   charge neither or both: refused rather than guessed at.
 * - A starting allowance that is not a whole number of credits is a typo.
 * - A gift that lasts no days, or longer than ten years, and a monthly gift that
 *   is not an exact amount, are typos: a mistyped number must not make a gift
 *   permanent or silently nothing.
 * @param {Record<string, any>} config
 * @returns {string | null}
 */
export function evimedCreditsRefusal(config) {
  if (config?.evimedCreditsSimulated !== true) return null;
  if (String(config.evimedCreditsUrl ?? "").trim() || String(config.evimedCreditsBalanceUrl ?? "").trim()) {
    return "evimed_credits_simulated_conflict";
  }
  const start = Number(config.evimedCreditsSimulatedStartCredits ?? SIMULATED_START_CREDITS);
  if (!Number.isSafeInteger(start) || start < 1 || start > MAX_START_CREDITS) return "evimed_credits_simulated_start_invalid";
  const days = Number(config.evimedCreditsSignupGiftDays ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_GIFT_DAYS) return "evimed_credits_gift_invalid";
  try {
    const monthly = researchMoneyUnits(String(config.evimedCreditsMonthlyGift ?? 0));
    if (monthly > BigInt(MAX_START_CREDITS) * 100_000_000n) return "evimed_credits_gift_invalid";
  } catch { return "evimed_credits_gift_invalid"; }
  return null;
}

export class SimulatedWallet extends CreditWallet {
  /**
   * Add one package of simulated credits, once per `requestId`. A closed list:
   * the request names a package, never an amount.
   * @param {{ payer: string, packageId: string, requestId: string }} request
   */
  topUp({ payer, packageId, requestId }) {
    const pack = SIMULATED_TOPUP_PACKAGES.find((entry) => entry.id === packageId);
    if (!pack) return Promise.reject(new SimulatedWalletRefusal("simulated_wallet_request_invalid", 400));
    return this.credit({ payer, amount: pack.credits, requestId, packageId: pack.id });
  }
}
