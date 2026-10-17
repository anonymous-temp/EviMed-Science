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
 * @param {{ config: any, usageLedger: any, caller: any, attributeRun?: any, runPurpose?: any, runScope?: any,
 *   model: string, estimatedCost: number, fingerprint: unknown, at?: Date }} input
 *   `model` is what the row names — a model id, or a tool such as `deepseek-search`; `fingerprint` is hashed into the
 *   row's request fingerprint
 * @returns {Promise<{ id: string } | null>}
 * @throws {GatewaySpendRefusal}
 */
export async function reserveGatewaySpend({ config, usageLedger, caller, attributeRun = null, runPurpose = null, runScope = null, model, estimatedCost, fingerprint, at = new Date() }) {
  if (!usageLedger) {
    if (config.requireDurableUsageLedger === true) throw new GatewaySpendRefusal("unrecordable", "its spend cannot be recorded right now.");
    return null;
  }
  const attributed = caller.runId == null && attributeRun
    ? await attributeRun({ userId: caller.userId, projectId: caller.projectId, sessionId: null }).catch(() => null)
    : null;
  let runId = caller.runId ?? attributed ?? null;
  let runLimit = caller.runId != null ? Number(caller.runLimit) || 0 : (attributed ? Number(config.userRunSpendLimit) || 0 : 0);
  // A scheduled execution in the researcher's own runtime is booked under its episode and held to its limit, as its model calls are
  // (`autopilotEpisodeScope.mjs`). A scope that cannot be read makes the call unavailable rather than uncapped.
  if (caller.runId == null && attributed && runScope) {
    const scope = await runScope({ userId: caller.userId, projectId: caller.projectId, runId: attributed }).catch(() => {
      throw new GatewaySpendRefusal("scope_unreadable", "the spending limit of this run cannot be read.");
    });
    if (scope) { runId = scope.usageRunId; runLimit = Number(scope.runLimit) || 0; }
  }
  // Asking can fail (the run ledger is a file): the model gateway books `kernel` then rather
  // than costing the call, and so does this one — a call is never lost for a column it writes.
  const purpose = runPurpose && await runPurpose({ userId: caller.userId, projectId: caller.projectId, runId }).catch(() => "kernel") === "evolution" ? "evolution" : "web-search";
  try {
    return await usageLedger.reserveModel({
      id: randomUUID(), userId: caller.userId, projectId: caller.projectId, runId, purpose, model,
      priceVersion: REFERENCE_PRICE_LIST.version, currency: "CNY",
      requestFingerprint: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      estimatedCost,
      dailyLimit: purpose === "evolution" ? Number(config.evolutionDailyBudgetCny) || 0 : minimumPositive(caller.dailyLimit, config.userDailySpendLimit),
      weeklyLimit: purpose === "evolution" ? 0 : minimumPositive(caller.weeklyLimit, config.userWeeklySpendLimit),
      runLimit: purpose === "evolution" ? 0 : runLimit,
      now: at,
    });
  } catch (error) {
    throw error?.code === "usage_budget_exceeded"
      ? new GatewaySpendRefusal("budget", "this account's spending limit is reached.")
      : new GatewaySpendRefusal("unrecordable", "its spend cannot be recorded right now.");
  }
}
