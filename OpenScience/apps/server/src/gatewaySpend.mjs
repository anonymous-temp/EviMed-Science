// What a gateway's paid call is charged to, and the reservation it is held to before it leaves.
//
// The web-search gateway's Bailian search (2026-09-28) was the first call a gateway paid for on a run's behalf; DeepSeek's
// Search and Fetch (2026-10-17) are the second and third. All three are booked the way the model gateway books the kernel's
// calls: charged to the run the project is running (or the scheduled episode it belongs to), reserved against the
// researcher's caps before the request leaves, and closed by the caller once the provider has answered. One function, so
// the three cannot drift on who pays.
import { createHash, randomUUID } from "node:crypto";
import { REFERENCE_PRICE_LIST } from "@evimed/domain";

/** Why a reservation was not made; the caller words it for its own channel. */
export class GatewaySpendRefusal extends Error {
  /** @param {"scope_unreadable" | "budget" | "unrecordable"} reason @param {string} message */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** @param {...unknown} values the smallest positive limit, or 0 for none */
export function minimumPositive(...values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

/**
 * Reserve one paid gateway call. Without a ledger (a deployment with no PostgreSQL) there is nothing to reserve and the
 * answer is `null`, unless the ledger is required, when the call must not be made at all: a spend nobody records is the
 * defect metering exists for.
 *
 * @param {{ config: any, usageLedger: any, caller: any, attributeRun?: any,
 *   model: string, estimatedCost: number, fingerprint: unknown, at?: Date }} input
 *   `model` is what the row names — a model id, or a tool such as `deepseek-search`; `fingerprint` is hashed into the
 *   row's request fingerprint
 * @returns {Promise<{ id: string } | null>}
 * @throws {GatewaySpendRefusal}
 */
export async function reserveGatewaySpend({ config, usageLedger, caller, attributeRun = null, model, estimatedCost, fingerprint, at = new Date() }) {
  if (!usageLedger) {
    if (config.requireDurableUsageLedger === true) throw new GatewaySpendRefusal("unrecordable", "its spend cannot be recorded right now.");
    return null;
  }
  // A control-plane module's own search (ct-mix 2026-10-24: the frontier feed's lead triggers) is booked to its internal
  // project under the module's purpose, charged to no run, and held to the module's daily budget (`moduleLimit`) — never to
  // a researcher's caps, which it is not spending.
  if (caller.purpose === "frontier") {
    try {
      return await usageLedger.reserveModel({
        id: randomUUID(), userId: caller.userId, projectId: caller.projectId, runId: null, purpose: "frontier", model,
        priceVersion: REFERENCE_PRICE_LIST.version, currency: "CNY",
        requestFingerprint: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
        estimatedCost, dailyLimit: 0, weeklyLimit: 0, runLimit: 0, moduleLimit: Number(caller.moduleLimit) || 0, now: at,
      });
    } catch (error) {
      throw error?.code === "usage_budget_exceeded" || error?.code === "usage_module_budget_exceeded"
        ? new GatewaySpendRefusal("budget", "the module's daily budget is spent.")
        : new GatewaySpendRefusal("unrecordable", "its spend cannot be recorded right now.");
    }
  }
  const attributed = caller.runId == null && attributeRun
    ? await attributeRun({ userId: caller.userId, projectId: caller.projectId, sessionId: null }).catch(() => null)
    : null;
  const runId = caller.runId ?? attributed ?? null;
  const runLimit = caller.runId != null ? Number(caller.runLimit) || 0 : (attributed ? Number(config.userRunSpendLimit) || 0 : 0);
  try {
    return await usageLedger.reserveModel({
      id: randomUUID(), userId: caller.userId, projectId: caller.projectId, runId, purpose: "web-search", model,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: "CNY",
      requestFingerprint: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      estimatedCost,
      dailyLimit: minimumPositive(caller.dailyLimit, config.userDailySpendLimit),
      weeklyLimit: minimumPositive(caller.weeklyLimit, config.userWeeklySpendLimit),
      runLimit,
      now: at,
    });
  } catch (error) {
    throw error?.code === "usage_budget_exceeded"
      ? new GatewaySpendRefusal("budget", "this account's spending limit is reached.")
      : new GatewaySpendRefusal("unrecordable", "its spend cannot be recorded right now.");
  }
}
