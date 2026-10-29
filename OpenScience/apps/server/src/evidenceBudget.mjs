import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { EVIDENCE_PROJECT_ID } from "./internalProjects.mjs";
import { frontierBudgetState, frontierDayWindow } from "./frontierPipeline.mjs";

/**
 * The readers' challenges' own daily ceiling (evidence-flywheel plan §5.1 B7 and the 2026-10-06 review; since 2026-10-29 only this part).
 *
 * Judging a reader's challenge on a card of the platform's publisher account is a model call on the platform's money, booked under the
 * usage purpose `evidence` to the publisher's internal `evimed-evidence` project with a run scope `evch_<challenge>_<attempt>`. The
 * platform's evidence programme that once shared the purpose (a daily topic budget and one work slot) was deleted when the platform
 * stopped writing cards, so the budget, the slot and the programme's switch are gone with it.
 *
 * Hidden knowledge:
 *
 * - **The ledger is the budget.** Nothing here keeps a running total: today's spend is the sum of the publisher's `evidence` rows with
 *   the `evch_` run scope in the usage ledger for the time zone's day (`UsageLedger.purposeSpend`: settled cost plus what is still reserved
 *   or lost, at the bound the account caps use). A restart, a second control plane or a crash loses nothing.
 * - **A reservation is a question, not a hold.** `reserveChallenge(estimate)` says whether the day can still afford one judgement
 *   estimated at `estimate`; the real reservation happens, per model call, in the usage ledger. A caller that is refused does not spend.
 * - **Its own purpose, never anyone's cap.** `evidence` is in `UNCAPPED_USAGE_PURPOSES`: the judging is held by this ceiling
 *   (`OPEN_SCIENCE_EVIDENCE_CHALLENGE_DAILY_BUDGET_CNY`, 5 by default), not by an operator's personal limits.
 * - **An unreadable budget admits nothing.** A ceiling that cannot be read has no way to know it stayed inside its bound, so it
 *   refuses (`unmeasured`) rather than guess.
 *
 * @module evidenceBudget
 */

/**
 * What a judgement of a reader's challenge is booked under: its run scope (`evch_<challenge>_<attempt>`), under the purpose
 * `evidence` and the publisher's account. The prefix is how the challenges' day is told in the ledger.
 */
export const EVIDENCE_CHALLENGE_RUN_PREFIX = "evch_";
/** The reasons `reserveChallenge()` refuses: the ledger could not be read, the day is spent, or one judgement would not fit. */
export const EVIDENCE_CHALLENGE_BUDGET_REFUSALS = Object.freeze(["unmeasured", "exhausted", "estimate_exceeds_remaining"]);

/**
 * @param {{ usageLedger?: any, config: Record<string, any>, now?: () => Date,
 *   owner?: { userId: string, projectId: string } }} options
 *   `owner` defaults to the publisher account's `evimed-evidence` project, where the judgements' rows are booked.
 */
export function createEvidenceBudget({ usageLedger = null, config, now = () => new Date(), owner = { userId: PLATFORM_PUBLISHER_USER_ID, projectId: EVIDENCE_PROJECT_ID } }) {
  const timeZone = String(config?.frontierTimeZone || config?.frontierTimezone || "Asia/Shanghai");
  const challengeBudgetCny = Number.isFinite(Number(config?.evidenceChallengeDailyBudgetCny)) && Number(config.evidenceChallengeDailyBudgetCny) >= 0
    ? Number(config.evidenceChallengeDailyBudgetCny) : 5;
  const challenge = {
    reads: 0, readFailures: 0, granted: 0,
    refused: Object.fromEntries(EVIDENCE_CHALLENGE_BUDGET_REFUSALS.map((reason) => [reason, 0])),
  };

  /**
   * Today's spend on judging readers' challenges against its own ceiling. A reading is taken whenever someone asks, and the ceiling 0 is
   * no ceiling (nothing is read).
   * @param {Date} [at] @returns {Promise<{ spentCny: number, budgetCny: number, remainingCny: number | null, state: "ok" | "throttled" | "exhausted" | "unavailable", measured: boolean }>}
   */
  async function challengeBudget(at = now()) {
    if (!(challengeBudgetCny > 0)) return { spentCny: 0, budgetCny: challengeBudgetCny, remainingCny: null, state: "ok", measured: true };
    let spentCny = 0;
    let measured = false;
    if (usageLedger && typeof usageLedger.purposeSpend === "function") {
      try {
        const window = frontierDayWindow(at, timeZone);
        spentCny = await usageLedger.purposeSpend({ ...owner, purpose: "evidence", runIdPrefix: EVIDENCE_CHALLENGE_RUN_PREFIX, since: window.start, until: window.end });
        measured = true;
        challenge.reads += 1;
      } catch {
        challenge.readFailures += 1;
      }
    }
    return {
      spentCny, budgetCny: challengeBudgetCny, remainingCny: Math.max(0, Math.round((challengeBudgetCny - spentCny) * 10_000) / 10_000),
      state: measured ? frontierBudgetState(spentCny, challengeBudgetCny) : "unavailable", measured,
    };
  }

  /**
   * Whether the day can still afford one judgement of a challenge, estimated at `estimateCny`. A question: nothing is held, and no slot
   * is taken — judging is one call at a time by the upkeep loop's own tick.
   * @param {number} estimateCny @param {Date} [at]
   * @returns {Promise<{ granted: boolean, reason: "ok" | (typeof EVIDENCE_CHALLENGE_BUDGET_REFUSALS)[number], remainingCny: number | null }>}
   */
  async function reserveChallenge(estimateCny, at = now()) {
    const reading = await challengeBudget(at);
    /** @param {(typeof EVIDENCE_CHALLENGE_BUDGET_REFUSALS)[number]} reason */
    const refuse = (reason) => { challenge.refused[reason] += 1; return { granted: false, reason, remainingCny: reading.remainingCny }; };
    if (!reading.measured) return refuse("unmeasured");
    if (reading.state === "exhausted") return refuse("exhausted");
    const estimate = Number(estimateCny);
    if (Number.isFinite(estimate) && estimate > 0 && reading.remainingCny !== null && estimate > reading.remainingCny) return refuse("estimate_exceeds_remaining");
    challenge.granted += 1;
    return { granted: true, reason: "ok", remainingCny: reading.remainingCny };
  }

  return {
    owner, challengeBudget, reserveChallenge, challengeBudgetCny,
    status: () => ({ challenge: structuredClone(challenge) }),
  };
}

/**
 * The module's metric families for `/api/ops/metrics`: the two public-web switches, and the readers' challenges' day against its ceiling.
 * @param {Record<string, any>} config @param {ReturnType<typeof createEvidenceBudget> | null} budget
 * @param {{ spentCny: number, budgetCny: number } | null} [challengeReading] today's spend on judging challenges, taken by the scrape;
 *   null where the upkeep is off, and then none of its series is exported
 * @returns {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function evidenceBudgetMetricFamilies(config, budget, challengeReading = null) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [
    { name: "open_science_evidence_public_web_enabled", type: "gauge", help: "Whether the public evidence pages are switched on (OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED).", series: [{ value: config?.evidencePublicWebEnabled === true ? 1 : 0 }] },
    { name: "open_science_evidence_public_indexable", type: "gauge", help: "Whether the public evidence pages may be indexed (OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE): 0 means noindex and no sitemap.", series: [{ value: config?.evidencePublicIndexable === true ? 1 : 0 }] },
  ];
  if (budget && challengeReading) {
    const refused = budget.status().challenge.refused;
    families.push({
      name: "open_science_evidence_challenge_budget_spent_cny", type: "gauge",
      help: "Today's spend on judging readers' challenges, across every reader (the ceiling below counts the same ledger rows).", series: [{ value: Number(challengeReading.spentCny) || 0 }],
    }, {
      name: "open_science_evidence_challenge_budget_limit_cny", type: "gauge",
      help: "The day's ceiling on judging readers' challenges (OPEN_SCIENCE_EVIDENCE_CHALLENGE_DAILY_BUDGET_CNY; 0 = none).", series: [{ value: Number(challengeReading.budgetCny) || 0 }],
    }, {
      name: "open_science_evidence_challenge_budget_refusals_total", type: "counter",
      help: "Judgements of a challenge the day's ceiling refused, by reason: the ledger could not be read, the day is spent, or one judgement would not fit.",
      series: EVIDENCE_CHALLENGE_BUDGET_REFUSALS.map((reason) => ({ labels: { reason }, value: refused[reason] ?? 0 })),
    });
  }
  return families;
}
