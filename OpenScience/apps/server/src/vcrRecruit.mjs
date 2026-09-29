/**
 * 「虚拟临研」's recruitment side: the referral ledger, the site profile, the
 * accrual forecast and its backtest, and follow-up episodes (plan §7.2, §7.3).
 *
 * Hidden knowledge:
 *
 * - **Contacting a patient is the one thing this platform cannot take back.**
 *   It is the first of the three places a human must stop (plan §10.1), and the
 *   stop is per person, not per list: a coordinator confirms this patient, with
 *   their name on it, before the ledger may enter `contacted`, `interested` or
 *   `referred`. There is no batch approval and no approve-all; the refusal is
 *   named (`vcr_contact_not_approved`) so an interface can say which patient it
 *   was and why, rather than failing quietly (AC-18).
 * - **Screen failures are hung on a criterion, not on a sentence.** 「不符合入
 *   排」 cannot be counted, cannot be compared across sites, and cannot be acted
 *   on in the protocol. A screen failure that does not name the line it failed
 *   is refused, which is the whole of our difference from an SMO selling a
 *   site-selection model off its own historical totals (attachment B).
 * - **The forecast is a distribution and the risk appetite is a quantile.**
 *   「激进 / 平衡 / 保守」 does not change the model, the data or the estimate:
 *   it chooses which quantile of the same distribution the team commits to.
 *   Vendors sell 「80% 以上置信度」 with no denominator; what we report instead
 *   is the measured coverage of our own 80% prediction intervals on time-sliced
 *   history (AC-37).
 * - **The Poisson–Gamma update is arithmetic and belongs in code**; the fitting
 *   and the simulation belong to the engine (B). This module assembles the
 *   conjugate prior from the funnel a site actually ran — α gains the patients
 *   enrolled, β gains the months open — and reads the distribution back. The
 *   numbers never come from a model (principle 1).
 * - **An exit date is an exit date.** The partner cannot see treatment or
 *   outcome during the trial, so those fields are stored as visible-and-empty
 *   with the reason `restricted_in_trial` rather than absent. The exit date and
 *   reason are recorded exactly as given and are never re-labelled as a
 *   progression date or a last-dose date, and nothing in this module will
 *   reconstruct an arm from post-exit records (AC-22).
 *
 * @module vcrRecruit
 */

import {
  VCR_CONTACT_STATES, VCR_FOLLOWUP_KINDS, VCR_REFERRAL_STATES, roleAllows,
} from "@evimed/domain";

/** @typedef {{ enqueue: (job: any) => Promise<{ jobId: string, state?: string }> }} VcrJobsPort */
/** @typedef {{ can?: (input: { userId: string, studyId: string, ability: string }) => Promise<boolean> }} VcrAccessPort */

// ---------------------------------------------------------------------------
// The referral ledger (plan §7.2)
// ---------------------------------------------------------------------------

/**
 * Which state may follow which.
 *
 * `withdrawn` is reachable from everywhere because a patient may stop at any
 * point and the ledger has to be able to say so. `screen_failed` is terminal:
 * a second attempt on the same protocol is a new referral, so the funnel's
 * denominators stay countable.
 */
export const VCR_REFERRAL_TRANSITIONS = Object.freeze({
  candidate: Object.freeze(["needs_evidence", "contactable", "withdrawn"]),
  needs_evidence: Object.freeze(["candidate", "contactable", "withdrawn"]),
  contactable: Object.freeze(["contacted", "needs_evidence", "withdrawn"]),
  contacted: Object.freeze(["interested", "needs_evidence", "withdrawn"]),
  interested: Object.freeze(["referred", "withdrawn"]),
  referred: Object.freeze(["site_responded", "withdrawn"]),
  site_responded: Object.freeze(["screening", "withdrawn"]),
  screening: Object.freeze(["enrolled", "screen_failed", "withdrawn"]),
  enrolled: Object.freeze(["withdrawn"]),
  screen_failed: Object.freeze([]),
  withdrawn: Object.freeze([]),
});

/** Refusal codes this module raises. Each names one thing a reader can act on. */
export const VCR_RECRUIT_REFUSALS = Object.freeze([
  "vcr_referral_state_unknown",
  "vcr_referral_transition_invalid",
  "vcr_contact_not_approved",
  "vcr_contact_role_forbidden",
  "vcr_referral_role_forbidden",
  "vcr_screen_failure_needs_criterion",
  "vcr_enrollment_needs_date",
  "vcr_contact_approval_not_per_person",
  "vcr_exit_field_not_derivable",
]);

/**
 * A refusal is a return value carrying the specific thing to fix (principle 3).
 * @typedef {{ ok: false, code: string, message: string } & Record<string, any>} VcrRefusal
 */

/**
 * @param {string} code @param {string} message @param {Record<string, unknown>} [detail]
 * @returns {VcrRefusal}
 */
const refuse = (code, message, detail = {}) => ({ ok: /** @type {false} */ (false), code, message, ...detail });

/**
 * May this referral move to `to`, and what else does the move need?
 *
 * This is the whole policy, as a pure function, so the same decision can be
 * taken by a route, by a worker, and by a test without a database. The store
 * runs it again on the locked row.
 *
 * @param {{ referral: any, to: string, role: string, patch?: Record<string, any> }} input
 * @returns {{ ok: true, patch: Record<string, any>, notices: string[] } | VcrRefusal}
 */
export function decideReferralTransition({ referral, to, role, patch = {} }) {
  if (!VCR_REFERRAL_STATES.includes(to)) {
    return refuse("vcr_referral_state_unknown", `未知的转诊状态「${to}」。`);
  }
  if (!roleAllows(role, "write_referrals")) {
    return refuse("vcr_referral_role_forbidden", "当前角色不能改动转诊台账。");
  }
  const from = String(referral?.state ?? "candidate");
  const allowed = VCR_REFERRAL_TRANSITIONS[/** @type {keyof typeof VCR_REFERRAL_TRANSITIONS} */ (from)] ?? [];
  if (!allowed.includes(to)) {
    return refuse("vcr_referral_transition_invalid", `转诊不能从「${from}」直接到「${to}」。`);
  }

  // The first human stop. Both halves are required: the role has to be one that
  // may contact patients at all, and this named person has to have confirmed
  // this patient.
  if (VCR_CONTACT_STATES.includes(to)) {
    if (!roleAllows(role, "contact_patients")) {
      return refuse("vcr_contact_role_forbidden", "当前角色不能联系患者；需要协调员或研究负责人确认。");
    }
    const approvedBy = patch.contactApprovedBy ?? referral?.contactApprovedBy;
    if (!approvedBy) {
      return refuse("vcr_contact_not_approved",
        "联系患者前必须由协调员逐人确认；这条转诊还没有确认人。");
    }
  }
  if (to === "screen_failed" && !(patch.screenFailCriterionId ?? referral?.screenFailCriterionId)) {
    return refuse("vcr_screen_failure_needs_criterion", "筛选失败必须挂到具体的入排条件上。");
  }
  if (to === "enrolled" && !(patch.enrolledOn ?? referral?.enrolledOn)) {
    return refuse("vcr_enrollment_needs_date", "入组必须记录入组日期。");
  }

  /** @type {string[]} */
  const notices = [];
  if (to === "contactable" && referral?.eligibilitySummary === "insufficient_evidence") {
    // Advisory, not a gate (principle 4): a coordinator may well decide the
    // missing document is what the call is for.
    notices.push("该候选还有未知的入排条件，联系前请确认要补的证据。");
  }
  return { ok: true, patch, notices };
}

/**
 * Confirm contact for **one** patient.
 *
 * It takes a single referral id and refuses anything iterable. A batch
 * approval is not a stricter version of this check, it is the absence of it:
 * the point of the stop is that a person looked at this person.
 * @param {{ referralId: unknown, approvedBy: string, role: string }} input
 */
export function decideContactApproval({ referralId, approvedBy, role }) {
  if (Array.isArray(referralId)) {
    return refuse("vcr_contact_approval_not_per_person", "联系确认必须逐人进行，不接受批量确认。");
  }
  if (typeof referralId !== "string" || !referralId.trim()) {
    return refuse("vcr_referral_state_unknown", "缺少要确认的转诊记录。");
  }
  if (!roleAllows(role, "contact_patients")) {
    return refuse("vcr_contact_role_forbidden", "当前角色不能确认联系患者。");
  }
  if (typeof approvedBy !== "string" || !approvedBy.trim()) {
    return refuse("vcr_contact_not_approved", "确认人必须具名。");
  }
  return { ok: true, referralId, approvedBy: approvedBy.trim() };
}

/**
 * Turn assessments into candidate referrals.
 *
 * Candidates only. Nothing here may put a subject into a contact state — the
 * whole route from 「候选」 to 「已联系」 runs through a person.
 * @param {{ studyId: string, assessments: readonly any[], includeInsufficient?: boolean }} input
 */
export function candidateReferrals({ studyId, assessments, includeInsufficient = true }) {
  return (assessments ?? [])
    .filter((assessment) => assessment?.summary === "eligible"
      || assessment?.summary === "pending"
      || (includeInsufficient && assessment?.summary === "insufficient_evidence"))
    .map((assessment) => ({
      studyId,
      subjectKey: assessment.subjectKey,
      assessmentId: assessment.id ?? null,
      state: assessment.summary === "eligible" ? "candidate" : "needs_evidence",
      eligibilitySummary: assessment.summary,
    }));
}

/**
 * The funnel, with its denominators shown. Inato-style dashboards publish
 * 「已预筛 / 已入组」 with no denominator anywhere; every number here can be
 * divided by the one above it.
 * @param {readonly any[]} referrals
 */
export function referralFunnel(referrals) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const state of VCR_REFERRAL_STATES) counts[state] = 0;
  for (const referral of referrals ?? []) {
    const state = String(referral?.state ?? "");
    if (state in counts) counts[state] += 1;
  }
  const total = (referrals ?? []).length;
  const reached = counts.contacted + counts.interested + counts.referred + counts.site_responded
    + counts.screening + counts.enrolled + counts.screen_failed;
  const screened = counts.screening + counts.enrolled + counts.screen_failed;
  return {
    counts,
    total,
    contactRate: total ? reached / total : null,
    screenRate: reached ? screened / reached : null,
    enrollmentRate: screened ? counts.enrolled / screened : null,
    screenFailureRate: screened ? counts.screen_failed / screened : null,
  };
}

/**
 * Which criterion costs the most patients at screening.
 *
 * Counted on the referral ledger's own screen failures, so the answer is what
 * sites actually reported and not a model's opinion. The ranking is by count;
 * ties keep the protocol's own order, which is what a reader expects when two
 * lines fail equally often.
 * @param {readonly any[]} referrals @param {readonly any[]} criteria
 */
export function screenFailuresByCriterion(referrals, criteria) {
  const byId = new Map((criteria ?? []).map((criterion) => [criterion.id, criterion]));
  /** @type {Map<string, any>} */
  const rows = new Map();
  let unattributed = 0;
  for (const referral of referrals ?? []) {
    if (referral?.state !== "screen_failed") continue;
    const criterionId = referral?.screenFailCriterionId;
    if (!criterionId) { unattributed += 1; continue; }
    const criterion = byId.get(criterionId);
    const row = rows.get(criterionId) ?? {
      criterionId,
      ordinal: criterion?.ordinal ?? null,
      kind: criterion?.kind ?? null,
      criterionType: criterion?.criterionType ?? null,
      sourceText: criterion?.sourceText ?? "",
      failures: 0,
      subjectKeys: [],
    };
    row.failures += 1;
    row.subjectKeys.push(referral.subjectKey);
    rows.set(criterionId, row);
  }
  const ranked = [...rows.values()].sort((a, b) => b.failures - a.failures || (a.ordinal ?? 0) - (b.ordinal ?? 0));
  return { rows: ranked, unattributed };
}

// ---------------------------------------------------------------------------
// The site profile (plan §7.2)
// ---------------------------------------------------------------------------

/** After this many days a site profile is shown as stale rather than as fact. */
export const VCR_SITE_VERIFICATION_STALE_DAYS = 90;

/**
 * What a site card may claim today.
 *
 * The verification date is a first-class field because every field beside it
 * decays: capacity, competing studies and contacts are all true on the day
 * somebody checked and progressively less true afterwards. A card with no
 * verification date makes no capacity claim at all.
 * @param {any} site @param {number|string|Date} now
 */
export function siteProfileStatus(site, now = Date.now()) {
  const at = new Date(now).getTime();
  const verifiedAt = site?.verifiedAt ? new Date(site.verifiedAt).getTime() : null;
  const ageDays = verifiedAt === null ? null : (at - verifiedAt) / 86_400_000;
  const slots = Number(site?.capacity?.slots);
  const used = Number(site?.capacity?.used ?? 0);
  const available = Number.isFinite(slots) ? Math.max(0, slots - (Number.isFinite(used) ? used : 0)) : null;
  return {
    siteId: site?.id ?? null,
    name: site?.name ?? "",
    verifiedAt: site?.verifiedAt ?? null,
    verificationAgeDays: ageDays,
    stale: ageDays === null || ageDays > VCR_SITE_VERIFICATION_STALE_DAYS,
    slotsAvailable: available,
    // A capacity nobody has checked is not a capacity. The card shows the
    // number and the date together or it shows neither.
    capacityClaimable: available !== null && ageDays !== null && ageDays <= VCR_SITE_VERIFICATION_STALE_DAYS,
    competing: Array.isArray(site?.competing) ? site.competing.length : 0,
    unmetRequirements: Array.isArray(site?.capability?.unmet) ? site.capability.unmet : [],
  };
}

// ---------------------------------------------------------------------------
// Accrual forecasting (plan §7.2, AC-37)
// ---------------------------------------------------------------------------

/** 「激进 / 平衡 / 保守」 is which quantile of one distribution the team commits to. */
export const VCR_RISK_APPETITE_QUANTILES = Object.freeze({ aggressive: 0.2, balanced: 0.5, conservative: 0.8 });

/** A weakly informative Gamma prior on a site's monthly accrual rate, used when there is no history. */
export const VCR_ACCRUAL_PRIOR_DEFAULT = Object.freeze({ alpha: 1, beta: 1 });

/**
 * The conjugate Poisson–Gamma update, done here because it is arithmetic.
 *
 * A site that enrolled 7 patients over 9 open months updates `Gamma(α₀, β₀)` to
 * `Gamma(α₀ + 7, β₀ + 9)`; the posterior mean is the rate the forecast draws
 * from. Months **open**, not months elapsed since the study began — a site
 * activated late has a short denominator, and using the study clock would make
 * every late site look slow (Anisimov & Fedorov 2007).
 *
 * @param {{ enrolled?: number, monthsOpen?: number }} history
 * @param {{ alpha?: number, beta?: number }} [prior]
 */
export function accrualPosterior(history, prior = VCR_ACCRUAL_PRIOR_DEFAULT) {
  const alpha0 = Number(prior?.alpha ?? VCR_ACCRUAL_PRIOR_DEFAULT.alpha);
  const beta0 = Number(prior?.beta ?? VCR_ACCRUAL_PRIOR_DEFAULT.beta);
  const enrolled = Number(history?.enrolled ?? 0);
  const monthsOpen = Number(history?.monthsOpen ?? 0);
  const alpha = alpha0 + (Number.isFinite(enrolled) && enrolled > 0 ? enrolled : 0);
  const beta = beta0 + (Number.isFinite(monthsOpen) && monthsOpen > 0 ? monthsOpen : 0);
  return { alpha, beta, meanRatePerMonth: alpha / beta, source: monthsOpen > 0 ? "site_history" : "prior_only" };
}

/**
 * Assemble the inputs of an accrual forecast: the activation plan, one rate
 * prior per site, and the screening loss between a referral and an enrolment.
 *
 * Screen failure enters as a thinning of the Poisson process, which is why it
 * belongs in the inputs rather than being applied to the answer: a 30% screen
 * failure rate does not move the last-patient-in date by 30%.
 *
 * @param {{ studyId: string, sites: readonly any[], target: number, asOf: string|number|Date,
 *   screenFailureRate?: number, horizonMonths?: number, siteHistories?: Record<string, any> }} input
 */
export function accrualForecastScenario(input) {
  const asOf = new Date(input?.asOf ?? Date.now()).toISOString();
  const globalScreenFailure = Number.isFinite(Number(input?.screenFailureRate)) ? Number(input.screenFailureRate) : 0;
  const sites = (input?.sites ?? []).map((site) => {
    const history = (input?.siteHistories ?? {})[site?.id] ?? site?.accrualPrior?.history ?? null;
    const posterior = accrualPosterior(history ?? {}, site?.accrualPrior ?? VCR_ACCRUAL_PRIOR_DEFAULT);
    const screenFailureRate = Number.isFinite(Number(site?.accrualPrior?.screenFailureRate))
      ? Number(site.accrualPrior.screenFailureRate)
      : globalScreenFailure;
    return {
      siteId: String(site?.id ?? ""),
      name: String(site?.name ?? ""),
      // Planned until it actually opens; the two are different columns because
      // the gap between them is the single largest driver of a late trial.
      activationPlannedOn: site?.capacity?.activationPlannedOn ?? null,
      activatedOn: site?.activatedOn ?? null,
      alpha: posterior.alpha,
      beta: posterior.beta,
      meanRatePerMonth: posterior.meanRatePerMonth,
      ratePriorSource: posterior.source,
      screenFailureRate,
      capacity: Number.isFinite(Number(site?.capacity?.slots)) ? Number(site.capacity.slots) : null,
    };
  });
  return {
    kind: "accrual",
    asOf,
    target: Number(input?.target ?? 0),
    horizonMonths: Number(input?.horizonMonths ?? 36),
    screenFailureRate: globalScreenFailure,
    sites,
    quantiles: [0.05, 0.1, 0.2, 0.5, 0.8, 0.9, 0.95],
    intervalKind: "prediction",
    intervalLevel: 0.8,
  };
}

/**
 * Hand the assembled scenario to the deterministic engine through D's job port.
 *
 * Dependency-injected on purpose: this module never imports the orchestrator,
 * and a test runs the whole path against a stub.
 * @param {{ jobs: VcrJobsPort, studyId: string, scenario: any, requestedBy?: string, seed?: number,
 *   cpuSecondsLimit?: number, inputs?: readonly any[] }} input
 */
export async function requestAccrualForecast({ jobs, studyId, scenario, requestedBy = "", seed = 20260928, cpuSecondsLimit = 120, inputs = [] }) {
  if (!jobs || typeof jobs.enqueue !== "function") throw new TypeError("requestAccrualForecast needs the jobs port.");
  if (!scenario || scenario.kind !== "accrual") throw new TypeError("requestAccrualForecast needs an accrual scenario.");
  return jobs.enqueue({ kind: "accrual_forecast", studyId, scenario, seed, cpuSecondsLimit, requestedBy, inputs: [...inputs] });
}

/**
 * Read the engine's answer back.
 *
 * Every interval must name its kind: a forecast's spread is a **prediction**
 * interval, not a confidence interval, and writing 「区间」 alone is how a
 * vendor's 「80% 以上置信度」 gets born. An unnamed interval is dropped and
 * reported as such rather than relabelled.
 * @param {any} result an engine result (`validateEngineResult` shape)
 */
export function readAccrualForecast(result) {
  const measures = Array.isArray(result?.measures) ? result.measures : [];
  /** @type {string[]} */
  const dropped = [];
  const named = measures.filter((measure) => {
    const kind = measure?.interval?.kind;
    if (kind === "prediction" || kind === "monte_carlo") return true;
    dropped.push(String(measure?.name ?? ""));
    return false;
  });
  const by = (name) => named.find((measure) => String(measure?.name ?? "") === name) ?? null;
  return {
    status: String(result?.status ?? ""),
    lastPatientIn: by("last_patient_in_months"),
    targetEventsReached: by("target_events_months"),
    probabilityByDate: named.filter((measure) => String(measure?.name ?? "").startsWith("probability_by_")),
    quantiles: result?.diagnostics?.quantiles ?? null,
    droppedUnnamedIntervals: dropped,
    // The commitment is a choice of quantile, stated as such wherever it is shown.
    commitments: Object.fromEntries(Object.entries(VCR_RISK_APPETITE_QUANTILES).map(([appetite, quantile]) => [
      appetite, { quantile, note: "承诺的是这一分位数，不是预测更准" },
    ])),
  };
}

/**
 * Wilson score interval — a coverage of 4/5 is not 80%, and reporting it as a
 * bare point estimate is the mistake this whole backtest exists to avoid.
 * @param {number} successes @param {number} trials @param {number} [z]
 */
export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!Number.isFinite(trials) || trials <= 0) return { low: null, high: null };
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return { low: Math.max(0, (centre - spread) / denominator), high: Math.min(1, (centre + spread) / denominator) };
}

/**
 * Backtest the forecast on time slices (AC-37).
 *
 * Each slice is a forecast made with only what was known at its `asOf`, and the
 * enrolment that actually happened afterwards. What is reported is the share of
 * 80% prediction intervals that contained the truth — which is a statement
 * about the forecast's calibration and is the only honest answer to 「准不准」.
 * There is no pass mark: a coverage of 0.62 on 13 slices is a fact about the
 * data, and the Wilson interval beside it says how little 13 slices settle.
 *
 * @param {{ slices: readonly any[], level?: number }} input
 */
export function backtestAccrualCoverage({ slices, level = 0.8 }) {
  /** @type {any[]} */
  const rows = [];
  let covered = 0;
  let usable = 0;
  let unusable = 0;
  for (const slice of slices ?? []) {
    const low = Number(slice?.interval?.low);
    const high = Number(slice?.interval?.high);
    const actual = Number(slice?.actual);
    const kind = slice?.interval?.kind;
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(actual)
      || (kind && kind !== "prediction" && kind !== "monte_carlo")) {
      unusable += 1;
      rows.push({ asOf: slice?.asOf ?? null, usable: false, reason: kind && kind !== "prediction" ? "interval_not_prediction" : "incomplete" });
      continue;
    }
    usable += 1;
    const inside = actual >= low && actual <= high;
    if (inside) covered += 1;
    rows.push({ asOf: slice?.asOf ?? null, usable: true, low, high, actual, covered: inside });
  }
  const coverage = usable ? covered / usable : null;
  return {
    level,
    slices: (slices ?? []).length,
    usable,
    unusable,
    covered,
    coverage,
    coverageInterval: wilsonInterval(covered, usable),
    // Named so a reader knows which way it misses: below nominal means the
    // forecast is over-confident, above means it is wider than it needs to be.
    calibration: coverage === null ? null : coverage < level ? "over_confident" : coverage > level ? "conservative" : "nominal",
    note: "报告的是 80% 预测区间的实际覆盖率，不是「准确度」；没有通过门槛。",
  };
}

/**
 * Slice a study's own history into backtest inputs: for each cut-off, the
 * forecast that existed then and the enrolment that followed.
 * @param {{ forecasts: readonly any[], enrollments: readonly any[], horizonMonths?: number }} input
 */
export function accrualBacktestSlices({ forecasts, enrollments, horizonMonths = 6 }) {
  const events = (enrollments ?? [])
    .map((event) => ({ ...event, at: new Date(event?.enrolledOn ?? event?.at ?? 0).getTime() }))
    .filter((event) => Number.isFinite(event.at))
    .sort((a, b) => a.at - b.at);
  return (forecasts ?? []).map((forecast) => {
    const madeAt = new Date(forecast?.asOf ?? forecast?.createdAt ?? 0).getTime();
    const until = madeAt + horizonMonths * 30.4375 * 86_400_000;
    const actual = events.filter((event) => event.at > madeAt && event.at <= until).length;
    return {
      asOf: forecast?.asOf ?? forecast?.createdAt ?? null,
      horizonMonths,
      interval: forecast?.interval ?? null,
      actual,
      // The prediction was registered before the enrolments it is scored on;
      // a slice whose forecast has no timestamp is dropped, not assumed.
      registeredBeforeOutcome: Number.isFinite(madeAt) && madeAt > 0,
    };
  }).filter((slice) => slice.registeredBeforeOutcome);
}

// ---------------------------------------------------------------------------
// Follow-up (plan §7.3, AC-22)
// ---------------------------------------------------------------------------

/**
 * The fields a partner cannot see while their patient is in somebody else's
 * trial. They are recorded as present-and-restricted rather than missing:
 * a blank would be read as 「没有发生」 by the next person to open the table.
 */
export const VCR_TRIAL_RESTRICTED_FIELDS = Object.freeze(["treatment", "outcome", "randomization_arm", "progression_date", "last_dose_date"]);

/** Exit fields that are recorded verbatim and never re-derived into something else. */
export const VCR_EXIT_VERBATIM_FIELDS = Object.freeze(["exitDate", "exitReason"]);

/**
 * Record an exit.
 *
 * The date and the reason go in exactly as the partner wrote them. What this
 * function does **not** do is the point: it does not set a progression date, it
 * does not set a last-dose date, and it does not guess an arm. Those three
 * conversions are how a dataset that is legitimately about 「谁在什么时候出组」
 * turns into a claim about efficacy that nobody is entitled to make.
 *
 * @param {{ studyId: string, subjectKey: string, exitDate: string, exitReason: string,
 *   observations?: readonly any[], windowStart?: string|null, windowEnd?: string|null }} input
 */
export function trialPeriodEpisode(input) {
  /** @type {Record<string, any>} */
  const restricted = {};
  for (const field of VCR_TRIAL_RESTRICTED_FIELDS) {
    restricted[field] = { visible: false, reason: "restricted_in_trial" };
  }
  return {
    studyId: input.studyId,
    subjectKey: input.subjectKey,
    kind: "study_specific",
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? input.exitDate ?? null,
    observations: [...(input.observations ?? [])],
    restricted,
    exitReason: String(input.exitReason ?? ""),
    exitDate: String(input.exitDate ?? ""),
    derived: false,
  };
}

/**
 * The observation window that opens **after** the exit, inside whatever the
 * consent allows.
 *
 * It carries its own scope sentence, because the cohort it describes answers
 * questions about itself and nothing else: not the untreated natural history,
 * not the original trial's efficacy, and not the population that was
 * randomised (plan §7.3).
 * @param {{ studyId: string, subjectKey: string, from: string, to?: string|null, observations?: readonly any[] }} input
 */
export function postExitEpisode(input) {
  return {
    studyId: input.studyId,
    subjectKey: input.subjectKey,
    kind: "post_exit",
    windowStart: input.from,
    windowEnd: input.to ?? null,
    observations: [...(input.observations ?? [])],
    restricted: {},
    exitReason: null,
    scope: "该队列只回答关于这群人本身的问题，不代表未治疗的自然病程、原试验的疗效，也不代表原来入组的全体。",
  };
}

/**
 * Refuse, by name, every conversion of an exit record into a trial fact.
 *
 * It returns a refusal rather than throwing so a caller can record the attempt
 * and carry on: the interesting thing about this function is how often it is
 * called, and an exception would lose that.
 * @param {{ field: string, from?: string }} input
 */
export function deriveFromExit({ field, from = "exit" }) {
  return refuse("vcr_exit_field_not_derivable",
    `出组记录不能转换成「${field}」；出组日期与原因照原样保留（方案 §7.3）。`, { field, from });
}

/**
 * Is this episode a faithful record of what the partner sent?
 *
 * Checks the two verbatim fields and that nothing restricted acquired a value.
 * Advisory: it returns findings, never a block (principle 4).
 * @param {any} episode @param {{ exitDate?: string, exitReason?: string }} source
 */
export function followupFidelityFindings(episode, source) {
  /** @type {{ code: string, message: string, severity: string }[]} */
  const findings = [];
  if (source?.exitDate != null && String(episode?.exitDate ?? "") !== String(source.exitDate)) {
    findings.push({ code: "vcr_exit_date_rewritten", severity: "advisory", message: "出组日期与来源不一致。" });
  }
  if (source?.exitReason != null && String(episode?.exitReason ?? "") !== String(source.exitReason)) {
    findings.push({ code: "vcr_exit_reason_rewritten", severity: "advisory", message: "出组原因与来源不一致。" });
  }
  for (const field of VCR_TRIAL_RESTRICTED_FIELDS) {
    const entry = episode?.restricted?.[field];
    if (episode?.kind === "study_specific" && (!entry || entry.visible !== false)) {
      findings.push({ code: "vcr_restricted_field_not_marked", severity: "advisory", message: `试验期间的「${field}」没有标为不可见。` });
    }
  }
  if (!VCR_FOLLOWUP_KINDS.includes(String(episode?.kind ?? ""))) {
    findings.push({ code: "vcr_followup_kind_unknown", severity: "advisory", message: "随访片段的类型不在词表内。" });
  }
  return findings;
}

/**
 * What an exit-derived cohort may and may not be asked (plan §7.4's table, in
 * code so an interface can render it rather than restate it).
 */
export const VCR_PARTNER_DATA_USES = Object.freeze([
  Object.freeze({ use: "matching_evaluation", allowed: true, note: "历史转诊记录 + 后来是否入组，就是一套真实的中文匹配评测集。" }),
  Object.freeze({ use: "accrual_calibration", allowed: true, note: "历史漏斗给出每中心入组率和筛选失败率的先验。" }),
  Object.freeze({ use: "feasibility", allowed: true, note: "新方案的入排条件在历史候选人群上跑一遍漏斗。" }),
  Object.freeze({ use: "post_exit_observation", allowed: true, note: "范围有限：只针对出组后的这群人。" }),
  Object.freeze({ use: "trial_efficacy", allowed: false, note: "试验期间的分组和结局不可见。" }),
  Object.freeze({ use: "external_control", allowed: false, note: "平台不会从出组后的记录反推试验期间分组。" }),
]);

/** @param {string} use */
export function partnerDataUseAllowed(use) {
  const row = VCR_PARTNER_DATA_USES.find((entry) => entry.use === use);
  return row ? { ...row } : { use, allowed: false, note: "未登记的用途默认不允许。" };
}
