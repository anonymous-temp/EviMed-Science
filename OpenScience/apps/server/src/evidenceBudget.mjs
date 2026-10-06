import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { EVIDENCE_PROJECT_ID } from "./internalProjects.mjs";
import { frontierBudgetState, frontierDayWindow } from "./frontierPipeline.mjs";

/**
 * The evidence programme's own daily budget and concurrency (evidence-flywheel plan §5.1, B7, 2026-10-05).
 *
 * The programme is the platform researching on its own account: the publisher account's agendas, run in
 * its internal `evimed-evidence` project, billed under the usage purpose `evidence`. This is the helper
 * every later piece of the programme asks before it spends, shaped like the frontier pipeline's
 * `budget()` — the same ledger sum, the same state words, the same "a budget of 0 is no budget" — so an
 * operator reads one kind of number for both.
 *
 * Hidden knowledge:
 *
 * - **The ledger is the budget.** Nothing here keeps a running total: today's spend is the sum of the
 *   publisher's `evidence` rows in the usage ledger for the time zone's day (`UsageLedger.purposeSpend`:
 *   settled cost plus what is still reserved or lost, at the bound the account caps use). A restart, a
 *   second control plane or a crash loses nothing, because there was nothing to lose.
 * - **A reservation is a question, not a hold.** `reserve(estimate)` says whether the day can still afford
 *   a piece of work that is estimated at `estimate`; the real reservation happens, per model call, in the
 *   usage ledger when the call is made under purpose `evidence`. A caller that is refused does not
 *   spend; a caller that is admitted still meets the ledger. That the two can disagree by one call is
 *   the cost of not keeping a second ledger.
 * - **Its own purpose, never anyone's cap.** `evidence` is in `UNCAPPED_USAGE_PURPOSES`: the programme
 *   is held by this budget (`OPEN_SCIENCE_EVIDENCE_PROGRAMME_DAILY_BUDGET_CNY`, 30 by default) and by
 *   one slot at a time (`OPEN_SCIENCE_EVIDENCE_PROGRAMME_MAX_CONCURRENCY`, 1), not by an operator's
 *   personal limits. An account's own zone upkeep is the other purpose, `evidence-upkeep`, and is not
 *   here at all.
 * - **Off means nothing.** With the programme's switch off no table is read and every question answers
 *   `off`: a deployment that has not turned the programme on pays for no query.
 * - **An unreadable budget admits nothing.** The frontier pipeline can wave work through when its
 *   reading failed because the feed's editor cannot call a model without an owner anyway; a
 *   programme that cannot read what it has spent has no way to know it stayed inside 30 yuan, so it
 *   refuses (`unmeasured`) rather than guess.
 *
 * - **The challenges have a day of their own** (2026-10-06 review). Judging a reader's challenge on a platform card is a model call on
 *   the platform's money, and with no bound but each reader's ten a day it had none in aggregate; it also needed the programme's concurrency
 *   slot and its switch, so with the programme off every such challenge waited forever. `reserveChallenge` asks for neither: it asks
 *   whether the deployment-wide ceiling on judging (`OPEN_SCIENCE_EVIDENCE_CHALLENGE_DAILY_BUDGET_CNY`, 5) still has room — counted from the
 *   ledger's `evch_` run scopes, which is all the judges book — and, only when the programme is on, whether its own day does too.
 *
 * The honest cost of a deep synthesis is about 7 yuan (measured 2026-10-04), so the default day buys
 * about four. Build to delete: this is scaffolding for a programme the platform runs on an account of
 * its own; it goes when the account caps and the research allowance can carry an internal account's
 * spend as they carry a researcher's.
 *
 * @module evidenceBudget
 */

/** The reasons `reserve()` refuses, closed so the counter's label set is. */
export const EVIDENCE_BUDGET_REFUSALS = Object.freeze(["off", "unmeasured", "exhausted", "estimate_exceeds_remaining"]);

/**
 * What a judgement of a reader's challenge is booked under: its run scope (`evch_<challenge>_<attempt>`), under the same purpose
 * `evidence` and the same account as the programme. The prefix is how the challenges' day is told from the programme's own in the ledger.
 */
export const EVIDENCE_CHALLENGE_RUN_PREFIX = "evch_";
/** The reasons `reserveChallenge()` refuses: the challenges' own ceiling, or the programme's day when the programme is on and has spent it. */
export const EVIDENCE_CHALLENGE_BUDGET_REFUSALS = Object.freeze(["unmeasured", "exhausted", "estimate_exceeds_remaining", "programme_day"]);

/** @typedef {{ enabled: boolean, spentCny: number, budgetCny: number, remainingCny: number | null, state: "off" | "ok" | "throttled" | "exhausted" | "unavailable", measured: boolean }} EvidenceBudgetReading */

/**
 * @param {{ usageLedger?: any, config: Record<string, any>, now?: () => Date,
 *   owner?: { userId: string, projectId: string } }} options
 *   `owner` defaults to the publisher account's `evimed-evidence` project, where the programme's rows are booked.
 */
export function createEvidenceBudget({ usageLedger = null, config, now = () => new Date(), owner = { userId: PLATFORM_PUBLISHER_USER_ID, projectId: EVIDENCE_PROJECT_ID } }) {
  const enabled = config?.evidenceProgrammeEnabled === true;
  const budgetCny = Number.isFinite(Number(config?.evidenceProgrammeDailyBudgetCny)) ? Number(config.evidenceProgrammeDailyBudgetCny) : 30;
  const maxConcurrency = Number.isSafeInteger(Number(config?.evidenceProgrammeMaxConcurrency)) && Number(config.evidenceProgrammeMaxConcurrency) > 0
    ? Number(config.evidenceProgrammeMaxConcurrency) : 1;
  const timeZone = String(config?.frontierTimeZone || config?.frontierTimezone || "Asia/Shanghai");
  /** Observable counters (principle 15). */
  const counters = {
    reads: 0, readFailures: 0, granted: 0,
    refused: Object.fromEntries(EVIDENCE_BUDGET_REFUSALS.map((reason) => [reason, 0])),
    slotsGranted: 0, slotsRefused: 0,
  };
  const challengeBudgetCny = Number.isFinite(Number(config?.evidenceChallengeDailyBudgetCny)) && Number(config.evidenceChallengeDailyBudgetCny) >= 0
    ? Number(config.evidenceChallengeDailyBudgetCny) : 5;
  const challenge = {
    reads: 0, readFailures: 0, granted: 0,
    refused: Object.fromEntries(EVIDENCE_CHALLENGE_BUDGET_REFUSALS.map((reason) => [reason, 0])),
  };
  let slotsInUse = 0;
  /** @type {(EvidenceBudgetReading & { measuredAt: string }) | null} */
  let last = null;

  /**
   * Today's `evidence` spend (the time zone's day) against the day's budget.
   * @param {Date} [at] @returns {Promise<EvidenceBudgetReading>}
   */
  async function budget(at = now()) {
    if (!enabled) return { enabled: false, spentCny: 0, budgetCny, remainingCny: null, state: "off", measured: false };
    let spentCny = 0;
    let measured = false;
    if (usageLedger && typeof usageLedger.purposeSpend === "function") {
      try {
        const window = frontierDayWindow(at, timeZone);
        spentCny = await usageLedger.purposeSpend({ ...owner, purpose: "evidence", since: window.start, until: window.end });
        measured = true;
        counters.reads += 1;
      } catch {
        counters.readFailures += 1;
      }
    }
    /** @type {EvidenceBudgetReading["state"]} */
    const state = measured ? frontierBudgetState(spentCny, budgetCny) : "unavailable";
    /** @type {EvidenceBudgetReading} */
    const reading = { enabled: true, spentCny, budgetCny, remainingCny: budgetCny > 0 ? Math.max(0, Math.round((budgetCny - spentCny) * 10_000) / 10_000) : null, state, measured };
    last = { ...reading, measuredAt: at.toISOString() };
    return reading;
  }

  /**
   * What is left of today's budget, in CNY: a number, or `null` when the budget is 0 (no budget) or the
   * programme is off. A spend that could not be read is 0 left: it is `unavailable`, never "plenty".
   * @param {Date} [at] @returns {Promise<number | null>}
   */
  async function remainingCny(at = now()) {
    const reading = await budget(at);
    if (!reading.enabled) return null;
    return reading.measured ? reading.remainingCny : 0;
  }

  /**
   * Whether the day can still afford work estimated at `estimateCny`. A question: nothing is held, and the
   * usage ledger's own reservation per call is what binds.
   * @param {number} estimateCny @param {Date} [at]
   * @returns {Promise<{ granted: boolean, reason: "ok" | (typeof EVIDENCE_BUDGET_REFUSALS)[number], remainingCny: number | null, state: string }>}
   */
  async function reserve(estimateCny, at = now()) {
    const reading = await budget(at);
    /** @param {(typeof EVIDENCE_BUDGET_REFUSALS)[number]} reason */
    const refuse = (reason) => { counters.refused[reason] += 1; return { granted: false, reason, remainingCny: reading.remainingCny, state: reading.state }; };
    if (!reading.enabled) return refuse("off");
    if (!reading.measured) return refuse("unmeasured");
    if (reading.state === "exhausted") return refuse("exhausted");
    const estimate = Number(estimateCny);
    if (Number.isFinite(estimate) && estimate > 0 && reading.remainingCny !== null && estimate > reading.remainingCny) return refuse("estimate_exceeds_remaining");
    counters.granted += 1;
    return { granted: true, reason: "ok", remainingCny: reading.remainingCny, state: reading.state };
  }

  /**
   * Today's spend on judging readers' challenges against its own ceiling. Independent of the programme's switch: a reading is taken
   * whenever someone asks, and the ceiling 0 is no ceiling (nothing is read).
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
   * Whether the day can still afford one judgement of a challenge, estimated at `estimateCny`: the challenges' own ceiling, and the
   * programme's day too when the programme is on (its spend and this one are the same purpose). A question, like `reserve`: nothing is
   * held, and no slot is taken — judging is one call at a time by the editor's own tick.
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
    if (enabled && !(await reserve(estimateCny, at)).granted) return refuse("programme_day");
    challenge.granted += 1;
    return { granted: true, reason: "ok", remainingCny: reading.remainingCny };
  }

  /**
   * One of the programme's concurrent work slots (default 1). A programme that is off has none.
   * @returns {{ release: () => void } | null} null when none is free
   */
  function tryAcquireSlot() {
    if (!enabled || slotsInUse >= maxConcurrency) { counters.slotsRefused += 1; return null; }
    slotsInUse += 1;
    counters.slotsGranted += 1;
    let released = false;
    return { release: () => { if (!released) { released = true; slotsInUse -= 1; } } };
  }

  return {
    enabled, owner, budgetCny, maxConcurrency, budget, remainingCny, reserve, tryAcquireSlot, challengeBudget, reserveChallenge, challengeBudgetCny,
    status: () => ({ enabled, budgetCny, maxConcurrency, slotsInUse, last: last ? { ...last } : null, counters: structuredClone(counters), challenge: structuredClone(challenge) }),
  };
}

/**
 * The module's metric families for `/api/ops/metrics`: the budget against its limit, the slots against theirs,
 * and the two public-web switches, so that every lever this work added has something an operator can read.
 * Exported with the programme off (`enabled 0`), the way the other modules are.
 * @param {Record<string, any>} config @param {ReturnType<typeof createEvidenceBudget> | null} budget
 * @param {EvidenceBudgetReading | null} [reading] today's reading, taken by the scrape
 * @param {Record<string, number> | null} [upkeep] the zone editor's counters (`EvidenceEditorial.status().counters`):
 *   who paid for the upkeep jobs it ran, and which it set aside
 * @param {{ spentCny: number, budgetCny: number } | null} [challengeReading] today's spend on judging challenges, taken by the scrape;
 *   null where the upkeep is off, and then none of its series is exported
 * @returns {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function evidenceBudgetMetricFamilies(config, budget, reading = null, upkeep = null, challengeReading = null) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [
    { name: "open_science_evidence_programme_enabled", type: "gauge", help: "Whether the platform's evidence programme is switched on (OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED).", series: [{ value: config?.evidenceProgrammeEnabled === true ? 1 : 0 }] },
    { name: "open_science_evidence_public_web_enabled", type: "gauge", help: "Whether the public evidence pages are switched on (OPEN_SCIENCE_EVIDENCE_PUBLIC_WEB_ENABLED).", series: [{ value: config?.evidencePublicWebEnabled === true ? 1 : 0 }] },
    { name: "open_science_evidence_public_indexable", type: "gauge", help: "Whether the public evidence pages may be indexed (OPEN_SCIENCE_EVIDENCE_PUBLIC_INDEXABLE): 0 means noindex and no sitemap.", series: [{ value: config?.evidencePublicIndexable === true ? 1 : 0 }] },
  ];
  if (upkeep) {
    families.push({
      name: "open_science_evidence_upkeep_jobs_total", type: "counter",
      help: "Evidence-zone upkeep jobs this process ran, by who paid: the platform's frontier budget (an official zone) or the zone owner's own account (purpose evidence-upkeep).",
      series: [{ labels: { payer: "platform" }, value: Number(upkeep.officialJobs) || 0 }, { labels: { payer: "owner" }, value: Number(upkeep.ownerJobs) || 0 }],
    }, {
      name: "open_science_evidence_upkeep_deferred_total", type: "counter",
      help: "Owner-billed upkeep jobs set aside rather than run, by why: the owner has no allowance (evidence_upkeep_no_allowance) or has reached their own cap (usage_budget_exceeded).",
      series: [{ labels: { reason: "no_allowance" }, value: Number(upkeep.deferredNoAllowance) || 0 }, { labels: { reason: "owner_cap" }, value: Number(upkeep.deferredCap) || 0 }],
    }, {
      name: "open_science_evidence_upkeep_settlements_total", type: "counter",
      help: "Research-allowance settlements of owner-billed upkeep, by outcome: charged to the owner, recorded and waived (the job delivered nothing), or failed (the scope's calls stay in the usage ledger, unsettled).",
      series: [{ labels: { outcome: "charged" }, value: Number(upkeep.charged) || 0 }, { labels: { outcome: "waived" }, value: Number(upkeep.waived) || 0 },
        { labels: { outcome: "failed" }, value: Number(upkeep.chargeFailed) || 0 }],
    });
  }
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
      help: "Judgements of a challenge the day's ceiling refused, by reason: the ledger could not be read, the day is spent, one judgement would not fit, or the programme's own day is spent.",
      series: EVIDENCE_CHALLENGE_BUDGET_REFUSALS.map((reason) => ({ labels: { reason }, value: refused[reason] ?? 0 })),
    });
  }
  if (!budget || !budget.enabled) return families;
  const status = budget.status();
  /** @param {string} name @param {string} help @param {"gauge" | "counter"} type @param {{ value: number, labels?: Record<string, string> }[]} series */
  const add = (name, help, type, series) => families.push({ name: `open_science_evidence_programme_${name}`, help, type, series });
  add("budget_spent_cny", "Today's evidence-programme model spend (settled and still reserved).", "gauge", [{ value: Number(reading?.spentCny ?? status.last?.spentCny ?? 0) }]);
  add("budget_limit_cny", "The day's evidence-programme budget (0 = none).", "gauge", [{ value: status.budgetCny }]);
  add("budget_state", "The programme budget's state (1 = current).", "gauge",
    ["ok", "throttled", "exhausted", "unavailable"].map((state) => ({ labels: { state }, value: (reading?.state ?? status.last?.state) === state ? 1 : 0 })));
  add("budget_refusals_total", "Admission questions the programme budget refused, by reason, since process start.", "counter",
    EVIDENCE_BUDGET_REFUSALS.map((reason) => ({ labels: { reason }, value: status.counters.refused[reason] })));
  add("budget_read_failures_total", "Reads of today's spend that failed since process start.", "counter", [{ value: status.counters.readFailures }]);
  add("concurrency_limit", "How many programme work slots may be held at once.", "gauge", [{ value: status.maxConcurrency }]);
  add("concurrency_in_use", "Programme work slots held now.", "gauge", [{ value: status.slotsInUse }]);
  add("slot_requests_total", "Programme slot requests since process start, by whether one was free.", "counter", [
    { labels: { outcome: "granted" }, value: status.counters.slotsGranted },
    { labels: { outcome: "refused" }, value: status.counters.slotsRefused },
  ]);
  return families;
}
