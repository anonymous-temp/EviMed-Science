/**
 * The three things a forecast can claim, each with its own words (plan C.3, R32).
 *
 * Hidden knowledge:
 *
 * - **Three claims, three inputs, three kinds of evidence.** A batch of virtual patients uses no real person and is judged by distribution
 *   checks. A population forecast for a real patient uses that patient's baseline information only. An individualized forecast also uses the
 *   patient's own earlier observations. They are not interchangeable: the same page or reply must say which one it is, because a reader who
 *   takes the first for the third believes a person's own course was used when it was not.
 * - **The claim follows the inputs, never a wish.** `predictionClaimOf` reads what the forecast was given. A provider that does not say
 *   whether it used the person's history has no claim and the page says nothing rather than guessing (`null`).
 * - **"More accurate" is a separate sentence with its own condition.** Individualizing is claimed to help only where a frozen evaluation
 *   showed it beats carrying the last value forward and a person's own straight-line trend on error, with an interval that excludes zero
 *   (`evals/vcr-in-silico/individual/PROTOCOL.md`). Without such a record the words say what was done and that nothing here shows it is better.
 * - Words are Simplified Chinese with “” quotes and name no tool, id or package.
 *
 * @module vcrPredictionClaims
 */
const frozen = /** @template T @param {T[]} list */ list => Object.freeze(list)

export const VCR_PREDICTION_CLAIMS = frozen(['virtual_cohort', 'population_forecast', 'individualized_forecast'])

/** @type {Readonly<Record<string, {label:string, sentence:string, evidence:string}>>} */
export const VCR_PREDICTION_CLAIM_WORDS_ZH = Object.freeze({
  virtual_cohort: Object.freeze({
    label: '生成一批虚拟患者',
    sentence: '这批人是按所设的分布生成的，不对应任何真实的人；只能用分布检查判断它们像不像目标人群，不能据此说某个人以后会怎样。',
    evidence: '分布检查',
  }),
  population_forecast: Object.freeze({
    label: '为真实患者做群体模型预测',
    sentence: '这次只用了这位患者的基线信息，按群体模型预测；基线相同的人得到相同的预测，他自己此前的变化没有用上。',
    evidence: '与真实随访结果的对照',
  }),
  individualized_forecast: Object.freeze({
    label: '用每个人的历史个体化',
    sentence: '这次在群体模型之上，用这位患者此前的观测更新了他自己的参数再预测；预测区间是在已拟合的群体参数下得到的，没有计入这些参数本身的估计误差。',
    evidence: '与“沿用最近一次观测值”和“沿个人趋势外推”的误差对照',
  }),
})

/** The endpoints the frozen evaluation covered, in words (`vcrIndividualEvaluationFamily` names them). */
export const VCR_INDIVIDUAL_FAMILY_WORDS_ZH = Object.freeze({ serum_bilirubin: '血清胆红素', cd4_count: 'CD4 计数' })

/** The one sentence that says whether the individual claim is backed: `helped` is the frozen evaluation's finding for the endpoint at hand
 * (`true`: both paired comparisons excluded zero; `false`: they did not; `null`: no evaluation for this endpoint). `family` names the endpoint the
 * finding is about, so the sentence never reads as a finding about any other.
 * @param {boolean | null} helped @param {string | null} [family] */
export function individualizationEvidenceSentence(helped, family = null) {
  const about = family && /** @type {Record<string, string>} */ (VCR_INDIVIDUAL_FAMILY_WORDS_ZH)[family]
  const where = about ? `在公开的随访数据上（${about}），` : '在公开的随访数据上，'
  if (helped === true) return `${where}这种个体化预测的平均误差小于沿用最近一次观测值和沿个人趋势外推，差异的95%区间不含0。`
  if (helped === false) return `${where}这种个体化预测没有显示比沿用最近一次观测值或沿个人趋势外推更准，所以这里只给出预测，不说它更准。`
  return '这个终点没有做过个体化预测的对照评估（用的方法不是评估过的那一种，也算没有），这里只给出预测，不说它比简单做法更准。'
}

/**
 * Which claim a forecast supports, from what it was given.
 * @param {{real?: boolean, usesOwnHistory?: boolean | null}} inputs `real`: the forecast is for a real person; `usesOwnHistory`: it
 *   used that person's observations before the origin (`null`/absent: not stated)
 * @returns {'virtual_cohort' | 'population_forecast' | 'individualized_forecast' | null}
 */
export function predictionClaimOf({ real = true, usesOwnHistory = null } = {}) {
  if (!real) return 'virtual_cohort'
  if (usesOwnHistory === true) return 'individualized_forecast'
  if (usesOwnHistory === false) return 'population_forecast'
  return null
}

/**
 * The premise row of a result page for its claim, or null when the claim is unknown.
 * @param {string | null} claim @param {{helped?: boolean | null, family?: string | null}} [evidence]
 */
export function predictionClaimPremise(claim, { helped = null, family = null } = {}) {
  const words = claim ? VCR_PREDICTION_CLAIM_WORDS_ZH[claim] : null
  if (!words) return null
  return {
    key: `claim:${claim}`, label: '这次预测说明了什么', decisive: true, source: 'default',
    value: claim === 'individualized_forecast' ? `${words.sentence}${individualizationEvidenceSentence(helped, family)}` : words.sentence,
  }
}
