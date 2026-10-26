/** The analytic sizing basis is scientific output, never arbitrary engine prose.
 * @param {any} result @param {any} [execution] */
export function vcrAnalyticComputationBasis(result, execution = null) {
  if ((execution?.method ?? result?.method) !== "design.analytic" || (execution?.methodVersion ?? result.methodVersion) !== "1.2.0") return null;
  const s = result.diagnostics?.sampleSize;
  if (!s || !["normal_approximation", "schoenfeld_event_probability"].includes(s.basis) || s.rounding !== "ceiling_each_arm_then_sum"
    || !["two_sample_means_normal_approximation", "two_proportion_normal_approximation", "schoenfeld_lachin_foulkes"].includes(s.formula)) return null;
  const continuous = s.formula === "two_sample_means_normal_approximation";
  const survival = s.formula === "schoenfeld_lachin_foulkes";
  if (s.basis !== (survival ? "schoenfeld_event_probability" : "normal_approximation")) return null;
  const check = continuous ? "pooled_two_sample_t" : survival ? "logrank_martingale_integral" : "two_proportion_normal_approximation";
  const value = (/** @type {string} */ name) => result.measures?.find((/** @type {any} */ item) => item.name === name)?.value;
  if (![s.nTreatment, s.nControl, s.total].every(n => Number.isSafeInteger(n) && n > 0)
    || s.total !== s.nTreatment + s.nControl || value(survival ? "required_patients" : "required_total") !== s.total
    || value("required_treatment") !== s.nTreatment || value("required_control") !== s.nControl
    || ![s.targetPower, s.powerAtAllocatedN, s.allocationRequested, s.allocationAchieved].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    || Math.abs(s.allocationAchieved - s.nTreatment / s.total) > 1e-12 || s.powerCheckBasis !== check
    || ![s.unrounded?.total, s.unrounded?.treat, s.unrounded?.control].every(n => Number.isFinite(n) && n > 0)
    || Math.ceil(s.unrounded.treat) !== s.nTreatment || Math.ceil(s.unrounded.control) !== s.nControl
    || Math.abs(s.unrounded.total - s.unrounded.treat - s.unrounded.control) > 1e-10 * Math.max(1, s.unrounded.total)) return null;
  if (survival && (!(s.expectedEventsAtAllocatedN > 0) || !Number.isFinite(s.expectedEventsAtAllocatedN))) return null;
  return { basis: s.basis, formula: s.formula, rounding: s.rounding,
    nTreatment: s.nTreatment, nControl: s.nControl, total: s.total,
    allocationRequested: s.allocationRequested, allocationAchieved: s.allocationAchieved,
    unrounded: { total: s.unrounded.total, treatment: s.unrounded.treat, control: s.unrounded.control },
    targetPower: s.targetPower, powerCheckBasis: check, powerAtAllocatedN: s.powerAtAllocatedN,
    ...(survival ? { expectedEventsAtAllocatedN: s.expectedEventsAtAllocatedN } : {}),
    note: survival ? "Sample size uses Schoenfeld event requirements and the declared distribution's event probabilities. Each arm is rounded up separately. Power is checked by the logrank martingale integral at these integer arm sizes." : continuous ? "Sample size uses a normal approximation, not an exact two-sample t calculation. The separate pooled-t power at these integer arm sizes may be below the target."
      : "Sample size and checked power use a large-sample two-proportion normal approximation, not an exact binary test. Each arm is rounded up separately; their sum is the total." };
}
