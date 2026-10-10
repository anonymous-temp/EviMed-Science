import { createHash } from 'node:crypto';
import { lowerConfidenceBound } from './statistics.mjs';

/**
 * Whether a Jev site earns its place: one rule, applied to every site (owner,
 * 2026-10-10: switch on every site that measurably helps, in speed, quality or
 * effect). Pure functions over the rows `run.mjs --incumbent` writes; nothing
 * here calls a model.
 *
 * A site is switched on when, in every pass, ALL of:
 *
 *  1. Qualification. Where the plan (2026-10-06 §4.1) names launch conditions
 *     that stand in for a statistical bar, they decide (`siteConditions`: J3's
 *     two, which the plan wrote because a routing corpus cannot show a
 *     settled-subset bound); a condition that only adds to it (J4's: no false
 *     notice on real non-clinical sentences) is required as well. Otherwise the
 *     bar is Jev's settled-correct one-sided 95% lower bound (Clopper-Pearson,
 *     `lowerConfidenceBound`) reaching 0.95, the one the J2 and J4 pins were
 *     recorded against (`judgeCalibration.test.mjs`) and `recommendThreshold`
 *     aims at.
 *  2. Non-inferiority. The accuracy of what the site does with Jev on (Jev's
 *     answer where it settles, the path the caller takes everywhere else: the
 *     site's `hybrid`) is not below the incumbent's accuracy on the same cases
 *     by more than the margin, 0.02: the two-point margin J3's record states
 *     and the plan states for every site (§3 rule 7).
 *  3. Benefit. The site with Jev on is faster (median latency per decision), or
 *     cheaper (cost per decision), or more accurate than the incumbent. "With
 *     Jev on" counts what the caller still does after Jev: a decision Jev did
 *     not settle is usually asked of the original path as well, so Jev's call
 *     is an addition for that share, not a replacement (`hybridOf`).
 *  4. No constraint the site's own record adds is broken (J3: not slower than
 *     Flash on the online path).
 *
 * Otherwise the original path stays. The numbers are measured on one host, so a
 * latency verdict is a verdict about that host; the record says where.
 */
export const BENEFIT_RULE = Object.freeze({
  id: 'jev-benefit-2026-10-10',
  qualificationBar: 0.95,
  marginPoints: 0.02,
  statement: 'On when, in every pass: (1) Jev\'s settled-correct lower95 is at least 0.95, or, where the plan names launch conditions that stand in for it (J3), those hold, and J4\'s added condition of no false notice on real non-clinical sentences holds as well; (2) the accuracy of the site with Jev on is not below the incumbent\'s on the same cases by more than 0.02; (3) the site with Jev on is faster (median per decision), or cheaper, or more accurate; (4) no constraint the site\'s record adds is broken (J3: not slower than Flash). Otherwise the original path stays.',
});

/** Nearest-rank percentile of a numeric list; null when empty. @param {number[]} values @param {number} p 0..100 */
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * What a decision takes and costs with the site on: Jev's call, plus the original path's where the caller asks it after Jev.
 * Most callers ask it for every decision Jev did not settle; J3 hands an unsure answer to its regex net, which is no model call,
 * and asks the original classifier only when Jev failed; J4's original path is no notice at all.
 * @param {string} site @param {any} row
 */
export function hybridOf(site, row) {
  const asked = site === 'J4' ? false : site === 'J3' ? row.outcome === 'fallback' : row.outcome !== 'settled';
  const ms = (Number.isFinite(row.ms) ? row.ms : 0) + (asked && Number.isFinite(row.incumbent?.ms) ? row.incumbent.ms : 0);
  const cost = (Number.isFinite(row.cost) ? row.cost : 0) + (asked && Number.isFinite(row.incumbent?.cost) ? row.incumbent.cost : 0);
  return { ms, cost, asked };
}

/** @param {number[]} values */
function latency(values) {
  const finite = values.filter(Number.isFinite);
  return { n: finite.length, p50: percentile(finite, 50), p95: percentile(finite, 95) };
}

/** @param {number[]} values */
function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

/** @param {number} correct @param {number} total */
function share(correct, total) {
  return total ? correct / total : null;
}

/**
 * Summarise one site's rows.
 *
 * A row carries Jev's side (`outcome`, `correct`, `ms`, `cost`) and the incumbent's (`incumbent.correct`, `.ms`, `.cost`,
 * `.failure`), and `hybridCorrect`: whether what the site does with Jev on was right (the runner sets it per site, because what
 * a caller does with an uncertain answer is the caller's: J2 stays in the current project, J3 hands the question to its regex
 * net, most others ask the original path).
 * @param {any[]} rows @param {{ bar?: number, margin?: number }} [options]
 */
export function summarizeSite(rows, { bar = BENEFIT_RULE.qualificationBar, site = '' } = {}) {
  const labelled = rows.filter((row) => typeof row.correct === 'boolean');
  const settled = labelled.filter((row) => row.outcome === 'settled');
  const correctSettled = settled.filter((row) => row.correct).length;
  const paired = rows.filter((row) => typeof row.hybridCorrect === 'boolean' && typeof row.incumbent?.correct === 'boolean');
  const incumbentRows = rows.filter((row) => typeof row.incumbent?.correct === 'boolean');
  const hybridRows = rows.filter((row) => typeof row.hybridCorrect === 'boolean');
  const answered = rows.filter((row) => Number.isFinite(row.ms));
  const incumbentAnswered = rows.filter((row) => Number.isFinite(row.incumbent?.ms));
  return {
    cases: rows.length,
    jev: {
      measured: labelled.length,
      settled: settled.length,
      settledShare: share(settled.length, labelled.length),
      correctSettled,
      settledAccuracy: share(correctSettled, settled.length),
      lower95: settled.length ? lowerConfidenceBound(correctSettled, settled.length) : 0,
      bar,
      // The top choice's accuracy whatever the confidence: what the threshold is trading away.
      rawAccuracy: share(labelled.filter((row) => row.correct).length, labelled.length),
      failures: rows.filter((row) => row.outcome === 'fallback' || row.outcome === 'invalid').length,
      ms: latency(answered.map((row) => row.ms)),
      costCnyPerCall: mean(answered.map((row) => row.cost)),
    },
    incumbent: {
      measured: incumbentRows.length,
      correct: incumbentRows.filter((row) => row.incumbent.correct).length,
      accuracy: share(incumbentRows.filter((row) => row.incumbent.correct).length, incumbentRows.length),
      failures: rows.filter((row) => row.incumbent?.failure).length,
      ms: latency(incumbentAnswered.map((row) => row.incumbent.ms)),
      costCnyPerCall: mean(incumbentAnswered.map((row) => row.incumbent.cost)),
    },
    hybrid: {
      measured: hybridRows.length,
      correct: hybridRows.filter((row) => row.hybridCorrect).length,
      accuracy: share(hybridRows.filter((row) => row.hybridCorrect).length, hybridRows.length),
      // Per decision, with the site on: Jev, and the original path where the caller asks it after Jev (`hybridOf`).
      ms: latency(answered.map((row) => hybridOf(site, row).ms)),
      costCnyPerCall: mean(answered.map((row) => hybridOf(site, row).cost)),
      originalPathAsked: answered.filter((row) => hybridOf(site, row).asked).length,
    },
    // J2 only: what the site did with an unsettled message before it handed it to the original classifier, scored on the same cases.
    ...(rows.some((row) => typeof row.hybridBeforeCorrect === 'boolean') ? { hybridBefore: (() => {
      const before = rows.filter((row) => typeof row.hybridBeforeCorrect === 'boolean');
      return { measured: before.length, correct: before.filter((row) => row.hybridBeforeCorrect).length, accuracy: share(before.filter((row) => row.hybridBeforeCorrect).length, before.length) };
    })() } : {}),
    paired: {
      n: paired.length,
      hybridOnly: paired.filter((row) => row.hybridCorrect && !row.incumbent.correct).length,
      incumbentOnly: paired.filter((row) => !row.hybridCorrect && row.incumbent.correct).length,
      bothRight: paired.filter((row) => row.hybridCorrect && row.incumbent.correct).length,
      bothWrong: paired.filter((row) => !row.hybridCorrect && !row.incumbent.correct).length,
    },
  };
}

/**
 * Apply the rule to a summary.
 * @param {ReturnType<typeof summarizeSite>} summary
 * @param {{ bar?: number, margin?: number, extraBar?: { id: string, ok: boolean, detail: string } | null, constraints?: Array<{ id: string, ok: boolean, detail: string }> }} [options]
 *   `extraBar` replaces the settled-correct bar with a bar the site's own record states (J3's final-route non-inferiority).
 */
export function decideSite(summary, { bar = BENEFIT_RULE.qualificationBar, margin = BENEFIT_RULE.marginPoints, extraBar = null, constraints = [] } = {}) {
  const { jev, incumbent, hybrid } = summary;
  /** @type {Array<{ id: string, ok: boolean, detail: string }>} */
  const checks = [];
  if (extraBar) checks.push(extraBar);
  else checks.push({ id: 'qualification', ok: jev.settled > 0 && jev.lower95 >= bar,
    detail: `settled-correct ${jev.correctSettled}/${jev.settled}, lower95 ${fixed(jev.lower95)} against the bar ${bar}` });
  const haveBoth = hybrid.accuracy !== null && incumbent.accuracy !== null;
  checks.push({ id: 'non-inferiority', ok: haveBoth && hybrid.accuracy >= incumbent.accuracy - margin,
    detail: haveBoth ? `site with Jev on ${fixed(hybrid.accuracy)} against incumbent ${fixed(incumbent.accuracy)} less the margin ${margin}`
      : 'the incumbent or the site with Jev on was not measured on these cases' });
  const faster = hybrid.ms.p50 !== null && incumbent.ms.p50 !== null && hybrid.ms.p50 < incumbent.ms.p50;
  const cheaper = hybrid.costCnyPerCall !== null && incumbent.costCnyPerCall !== null && hybrid.costCnyPerCall < incumbent.costCnyPerCall;
  const moreAccurate = haveBoth && hybrid.accuracy > incumbent.accuracy;
  checks.push({ id: 'benefit', ok: faster || cheaper || moreAccurate,
    detail: `with the site on: faster ${faster} (p50 ${hybrid.ms.p50} against ${incumbent.ms.p50} ms), cheaper ${cheaper} (${fixed(hybrid.costCnyPerCall, 6)} against ${fixed(incumbent.costCnyPerCall, 6)} CNY per decision), more accurate ${moreAccurate}` });
  for (const constraint of constraints) checks.push(constraint);
  const failed = checks.filter((check) => !check.ok);
  return { decision: failed.length ? 'original-path' : 'on', checks, reasons: failed.map((check) => `${check.id}: ${check.detail}`) };
}

/** @param {number | null} value @param {number} [digits] */
function fixed(value, digits = 4) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
}

/** The digest a record binds its rows with: the rows as JSON, in order. @param {any[]} rows */
export function rowsDigest(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * The launch conditions the plan (2026-10-06 `jev-judge-integration.md`) names for a site. Where it names some, they decide that
 * site (the generic qualification bar, which is a statistical bar on a settled subset, applies only where it names none).
 * Each returns the conditions as checks; `extraBar` takes the place of the generic qualification, `constraints` are added to it.
 * @param {string} site @param {any[]} rows @param {ReturnType<typeof summarizeSite>} summary
 * @returns {{ extraBar: { id: string, ok: boolean, detail: string } | null, constraints: Array<{ id: string, ok: boolean, detail: string }>, basis: string | null }}
 */
export function siteConditions(site, rows, summary) {
  if (site === 'J3') {
    // §4.1: "上线前必须满足两条: title-to-paper 的 50 条应答普通回答的问题，一条都不误送; 误送专项的次数不多于 Flash." Misrouting is
    // read on the final route, regex net included, which is what a researcher gets.
    const titleToPaper = rows.filter((row) => row.tag === 'title-to-paper');
    const misrouted = titleToPaper.filter((row) => row.falseSpecialist).length;
    const jev = rows.filter((row) => row.falseSpecialist).length;
    const flash = rows.filter((row) => row.baselineFalseSpecialist).length;
    return {
      basis: 'plan 2026-10-06 section 4.1, J3: none of the 50 title-to-paper ordinary-answer questions is routed to a specialist, and J3 routes to specialists no more often than Flash',
      extraBar: { id: 'plan-launch-conditions', ok: titleToPaper.length === 50 && misrouted === 0 && jev <= flash,
        detail: `${misrouted} of ${titleToPaper.length} title-to-paper questions routed to a specialist; ordinary questions sent to a specialist: Jev ${jev}, Flash ${flash}` },
      // "Not slower on the online path": median and 95th percentile of what a decision takes with the site on, against Flash.
      constraints: [{ id: 'not-slower', ok: summary.hybrid.ms.p50 !== null && summary.incumbent.ms.p50 !== null && summary.hybrid.ms.p50 <= summary.incumbent.ms.p50 && summary.hybrid.ms.p95 <= summary.incumbent.ms.p95,
        detail: `p50 ${summary.hybrid.ms.p50} and p95 ${summary.hybrid.ms.p95} ms with Jev, against ${summary.incumbent.ms.p50} and ${summary.incumbent.ms.p95} ms for Flash, on the measuring host` }],
    };
  }
  if (site === 'J4') {
    // §4.1: "上线前补上非临床能力报告的真实句子，确认 0 误报."
    const real = rows.filter((row) => /nonclinical/.test(String(row.source ?? '')));
    const falsePositives = real.filter((row) => row.outcome === 'settled' && row.jev?.leakage === true && row.label?.leakage === false).length;
    return { basis: 'plan 2026-10-06 section 4.1, J4: no false notice on real sentences of non-clinical capability reports', extraBar: null,
      constraints: [{ id: 'nonclinical-false-notices', ok: real.length > 0 && falsePositives === 0, detail: `${falsePositives} false notices among ${real.length} non-clinical sentences` }] };
  }
  if (site === 'J5') {
    // §4.2: "evals/frontier-editing 的 5 个栏目事故案例全过；和库里已发布条目的一致率不低于校准值". The five lane incidents are read as
    // the feed would meet them (Jev's verdict for an item it is sure of, the editor's for the rest). The second condition names a
    // calibrated agreement value that was never recorded anywhere, so it cannot be shown, and the site is not switched on on the first alone.
    const incidents = rows.filter((row) => row.releaseEligible && String(row.id).startsWith('incident-'));
    const passing = incidents.filter((row) => row.hybridCorrect === true).length;
    const calibratedAgreementRecorded = false;
    return { basis: 'plan 2026-10-06 section 4.2, J5: the 5 lane incident cases pass, and agreement with the published items is not below the calibrated value',
      extraBar: { id: 'plan-launch-conditions', ok: incidents.length === 5 && passing === 5 && calibratedAgreementRecorded,
        detail: `${passing} of ${incidents.length} lane incident cases pass with the site on; the calibrated agreement value the second condition names was never recorded, so that condition cannot be shown` },
      constraints: [] };
  }
  if (site === 'J6') {
    // §4.2: "11 个同事件事故案例全过：既查误合并，也查该合并的有没有漏". Read the way the caller reads Jev: an unsure answer is not a merge.
    const incidents = rows.filter((row) => row.releaseEligible);
    const accepted = (/** @type {any} */ label) => (Array.isArray(label?.relation) ? label.relation : [label?.relation]);
    const passing = incidents.filter((row) => accepted(row.label).includes(row.outcome === 'settled' ? row.jev?.relation : 'different')).length;
    return { basis: 'plan 2026-10-06 section 4.2, J6: all 11 same-event incident cases pass, the false merges and the missed ones both',
      extraBar: { id: 'plan-launch-conditions', ok: incidents.length === 11 && passing === 11,
        detail: `${passing} of ${incidents.length} same-event incident cases pass, read the way the caller reads Jev (an unsure answer is not a merge)` },
      constraints: [] };
  }
  return { extraBar: null, constraints: [], basis: null };
}
