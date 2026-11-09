/**
 * Historical success rates of clinical development, as two published sources, side by side (algorithm round E6, 2026-11-03). Data, never code.
 * Every number was read from the primary text of the source it is credited to on 2026-11-03, with the place it was read at.
 *
 * Hidden knowledge:
 *
 * - **A reference, never this trial's probability.** A success rate here is the share of earlier development programmes that got through a phase.
 *   It says how often programmes like this passed, not how likely this trial is to succeed, and the page words it as 「历史上这一阶段的通过率」
 *   beside an assurance and never as one. The assurance is the engine's number from the stated effect and its uncertainty; this is a base rate for the
 *   stage and the field, which is also a fair prior to hold the assurance up against.
 * - **The two sources are two methods and are never mixed.** BIO/Informa/QLS (2011-2020) count phase transitions of programmes whose sponsors reported
 *   them to a commercial database ("phase by phase": the share advancing out of a phase among those that advanced or were suspended); Wong, Siah and Lo
 *   (2000-2015.10) rebuild every programme's path from trial records and impute the missing steps ("path by path"). They differ by years, by database,
 *   by how a phase is counted, and by a phase 3 that ends at the filing in one and at the approval in the other. The table keeps each source's own
 *   endpoint for each number (`toNext`, `toFiling`, `toApproval`) and the page prints both, each under its source, so a reader sees a range and not one
 *   figure.
 * - **Wong's overall phase 2 to 3 rate is left out on purpose.** The paper's Table 1 and the text print 58.3% for all indications, which is the value of
 *   the infectious-disease row of its Table 2; the path-weighted mean of the nine therapeutic-group rows it sums (21,180 paths) is 48.6%. The authors
 *   published a corrigendum for the phase 2 to 3 column of both tables; which of the two printed forms is the corrected one cannot be told from the
 *   open text, so the overall rate is `null` here and the group rows, each internally consistent, are kept as printed. The same holds for the
 *   non-oncology phase 2 to 3 rate (printed 27.3%, the value of its phase 2 to approval cell).
 * - **The areas are the sources' own, mapped by name, not merged.** BIO has 14 disease areas and an "other"; Wong has nine groups. `wong` on an area
 *   names the Wong group that covers it (neurology and psychiatry both map to Wong's CNS; metabolic and endocrine to metabolic/endocrinology) or is
 *   `null` when there is none; the page says which group it printed. The mapping is ours and is only a pointer.
 *
 * @module @evimed/domain/vcrSuccessRates
 */

export const VCR_SUCCESS_RATE_SOURCES = Object.freeze({
  bio_2011_2020: Object.freeze({
    label: 'BIO / Informa / QLS 2011-2020',
    citation: 'Biotechnology Innovation Organization, Informa Pharma Intelligence, QLS Advisors. Clinical Development Success Rates and Contributing Factors 2011-2020. February 2021',
    place: 'Figure 2 (phase transition success by disease area, with the number of transitions), Figure 5b (likelihood of approval from each phase, with the number of transitions)',
    data: '12,728 phase transitions of 9,704 development programmes of 1,779 companies, Biomedtracker and Pharmapremia, 1 January 2011 to 30 November 2020; company-sponsored programmes aimed at FDA registration',
    method: 'phase by phase: the number that advanced divided by the number that advanced or were suspended; the likelihood of approval is the product of the phase rates',
    endpoint: 'phase 3 is counted to the filing of the application; the likelihood of approval counts on to the FDA approval',
    labelZh: 'BIO / Informa / QLS（2011–2020）',
    dataZh: '2011 年 1 月至 2020 年 11 月，1,779 家公司 9,704 个研发项目的 12,728 次阶段转换（Biomedtracker），限企业发起、面向 FDA 注册的项目',
    methodZh: '按阶段统计：某阶段通过的项目数，除以通过和终止的项目数之和；获批可能性是各阶段通过率的乘积',
    endpointZh: '三期统计到提交上市申请；“获批可能性”一栏统计到获得 FDA 批准',
  }),
  wong_2019: Object.freeze({
    label: 'Wong / Siah / Lo 2019',
    citation: 'Wong CH, Siah KW, Lo AW. Estimation of clinical trial success rates and related parameters. Biostatistics 2019;20(2):273-286. doi:10.1093/biostatistics/kxx069; corrigendum Biostatistics 2019;20(2):366',
    place: 'Table 1 (all indications) and Table 2 (by therapeutic group; industry-sponsored, path by path), open-access text',
    data: '406,038 entries for 185,994 trials of 21,143 compounds, Informa Trialtrove and Pharmaprojects, 1 January 2000 to 31 October 2015; industry-sponsored',
    method: 'path by path: each programme\'s path through the phases is rebuilt from trial records, missing steps are imputed, and the rate of a phase is the share of paths that started in it and went on',
    endpoint: 'phase 3 is counted to the approval (the filing is included); phase 1 and 2 are counted to the next phase and, separately, to the approval',
    labelZh: 'Wong / Siah / Lo（2019）',
    dataZh: '2000 年 1 月至 2015 年 10 月，18.6 万项试验、21,143 个化合物（Trialtrove 与 Pharmaprojects），限企业发起',
    methodZh: '按路径统计：用试验记录还原每个研发项目走过的阶段并补全缺失的步骤，某阶段的通过率是从该阶段开始并继续往下走的路径所占的比例',
    endpointZh: '三期统计到获批（含申报）；一期、二期既给出进入下一期的比例，也给出到获批的比例',
  }),
})

export const VCR_SUCCESS_RATE_PHASES = Object.freeze(['phase1', 'phase2', 'phase3'])
export const VCR_SUCCESS_RATE_PHASE_LABELS_ZH = Object.freeze({ phase1: '一期', phase2: '二期', phase3: '三期' })

/** The disease areas of the table, in the order the page lists them, with the Wong group that covers each (`null`: none does). */
export const VCR_SUCCESS_RATE_AREAS = Object.freeze([
  Object.freeze({ id: 'all', zh: '全部适应症', bio: 'all', wong: 'overall' }),
  Object.freeze({ id: 'oncology', zh: '肿瘤', bio: 'oncology', wong: 'oncology' }),
  Object.freeze({ id: 'hematology', zh: '血液', bio: 'hematology', wong: null }),
  Object.freeze({ id: 'cardiovascular', zh: '心血管', bio: 'cardiovascular', wong: 'cardiovascular' }),
  Object.freeze({ id: 'neurology', zh: '神经', bio: 'neurology', wong: 'cns' }),
  Object.freeze({ id: 'psychiatry', zh: '精神', bio: 'psychiatry', wong: 'cns' }),
  Object.freeze({ id: 'infectious_disease', zh: '感染', bio: 'infectious_disease', wong: 'infectious_disease' }),
  Object.freeze({ id: 'metabolic', zh: '代谢', bio: 'metabolic', wong: 'metabolic_endocrinology' }),
  Object.freeze({ id: 'endocrine', zh: '内分泌', bio: 'endocrine', wong: 'metabolic_endocrinology' }),
  Object.freeze({ id: 'autoimmune', zh: '自身免疫', bio: 'autoimmune', wong: 'autoimmune_inflammation' }),
  Object.freeze({ id: 'respiratory', zh: '呼吸', bio: 'respiratory', wong: null }),
  Object.freeze({ id: 'gastroenterology', zh: '消化（不含炎症性肠病）', bio: 'gastroenterology', wong: null }),
  Object.freeze({ id: 'urology', zh: '泌尿', bio: 'urology', wong: 'genitourinary' }),
  Object.freeze({ id: 'ophthalmology', zh: '眼科', bio: 'ophthalmology', wong: 'ophthalmology' }),
  Object.freeze({ id: 'allergy', zh: '过敏', bio: 'allergy', wong: null }),
  Object.freeze({ id: 'other', zh: '其他（皮肤、肾、产科、非自身免疫的风湿、耳鼻喉口腔、骨科）', bio: 'other', wong: null }),
])

/**
 * BIO 2011-2020 by disease area: for each phase, `toNext` is [number of transitions, rate of advancing to the next phase]; `toFiling` (phase 3) the rate of
 * reaching the filing of the application; `toApproval` the likelihood of approval from that phase.
 */
export const VCR_BIO_2011_2020 = Object.freeze({
  all: Object.freeze({ phase1: Object.freeze({ toNext: [4414, 0.52], toApproval: [12728, 0.079] }), phase2: Object.freeze({ toNext: [4933, 0.289], toApproval: [8314, 0.151] }), phase3: Object.freeze({ toFiling: [1928, 0.578], toApproval: [3381, 0.524] }), filingToApproval: [1453, 0.906] }),
  oncology: Object.freeze({ phase1: Object.freeze({ toNext: [1628, 0.488], toApproval: [4179, 0.053] }), phase2: Object.freeze({ toNext: [1732, 0.246], toApproval: [2551, 0.108] }), phase3: Object.freeze({ toFiling: [495, 0.477], toApproval: [819, 0.439] }), filingToApproval: [324, 0.92] }),
  hematology: Object.freeze({ phase1: Object.freeze({ toNext: [92, 0.696], toApproval: [352, 0.239] }), phase2: Object.freeze({ toNext: [106, 0.481], toApproval: [260, 0.344] }), phase3: Object.freeze({ toFiling: [82, 0.768], toApproval: [154, 0.715] }), filingToApproval: [72, 0.931] }),
  cardiovascular: Object.freeze({ phase1: Object.freeze({ toNext: [214, 0.5], toApproval: [651, 0.048] }), phase2: Object.freeze({ toNext: [252, 0.21], toApproval: [437, 0.096] }), phase3: Object.freeze({ toFiling: [105, 0.552], toApproval: [185, 0.456] }), filingToApproval: [80, 0.825] }),
  neurology: Object.freeze({ phase1: Object.freeze({ toNext: [516, 0.477], toApproval: [1411, 0.059] }), phase2: Object.freeze({ toNext: [504, 0.268], toApproval: [895, 0.123] }), phase3: Object.freeze({ toFiling: [226, 0.531], toApproval: [391, 0.46] }), filingToApproval: [165, 0.867] }),
  psychiatry: Object.freeze({ phase1: Object.freeze({ toNext: [150, 0.527], toApproval: [442, 0.073] }), phase2: Object.freeze({ toNext: [164, 0.268], toApproval: [292, 0.138] }), phase3: Object.freeze({ toFiling: [71, 0.563], toApproval: [128, 0.514] }), filingToApproval: [57, 0.912] }),
  infectious_disease: Object.freeze({ phase1: Object.freeze({ toNext: [403, 0.578], toApproval: [1170, 0.132] }), phase2: Object.freeze({ toNext: [414, 0.384], toApproval: [767, 0.228] }), phase3: Object.freeze({ toFiling: [197, 0.64], toApproval: [353, 0.594] }), filingToApproval: [156, 0.929] }),
  metabolic: Object.freeze({ phase1: Object.freeze({ toNext: [136, 0.618], toApproval: [399, 0.155] }), phase2: Object.freeze({ toNext: [149, 0.45], toApproval: [263, 0.25] }), phase3: Object.freeze({ toFiling: [66, 0.636], toApproval: [114, 0.557] }), filingToApproval: [48, 0.875] }),
  endocrine: Object.freeze({ phase1: Object.freeze({ toNext: [319, 0.433], toApproval: [887, 0.066] }), phase2: Object.freeze({ toNext: [293, 0.266], toApproval: [568, 0.152] }), phase3: Object.freeze({ toFiling: [151, 0.662], toApproval: [275, 0.571] }), filingToApproval: [124, 0.863] }),
  autoimmune: Object.freeze({ phase1: Object.freeze({ toNext: [413, 0.552], toApproval: [1305, 0.107] }), phase2: Object.freeze({ toNext: [471, 0.314], toApproval: [892, 0.193] }), phase3: Object.freeze({ toFiling: [219, 0.653], toApproval: [421, 0.614] }), filingToApproval: [202, 0.941] }),
  respiratory: Object.freeze({ phase1: Object.freeze({ toNext: [179, 0.559], toApproval: [501, 0.075] }), phase2: Object.freeze({ toNext: [215, 0.219], toApproval: [322, 0.135] }), phase3: Object.freeze({ toFiling: [62, 0.645], toApproval: [107, 0.616] }), filingToApproval: [45, 0.956] }),
  gastroenterology: Object.freeze({ phase1: Object.freeze({ toNext: [45, 0.467], toApproval: [186, 0.083] }), phase2: Object.freeze({ toNext: [73, 0.342], toApproval: [141, 0.178] }), phase3: Object.freeze({ toFiling: [35, 0.571], toApproval: [68, 0.519] }), filingToApproval: [33, 0.909] }),
  urology: Object.freeze({ phase1: Object.freeze({ toNext: [22, 0.409], toApproval: [88, 0.036] }), phase2: Object.freeze({ toNext: [40, 0.15], toApproval: [66, 0.088] }), phase3: Object.freeze({ toFiling: [13, 0.692], toApproval: [26, 0.586] }), filingToApproval: [13, 0.846] }),
  ophthalmology: Object.freeze({ phase1: Object.freeze({ toNext: [88, 0.716], toApproval: [415, 0.119] }), phase2: Object.freeze({ toNext: [200, 0.355], toApproval: [327, 0.166] }), phase3: Object.freeze({ toFiling: [82, 0.512], toApproval: [127, 0.467] }), filingToApproval: [45, 0.911] }),
  allergy: Object.freeze({ phase1: Object.freeze({ toNext: [55, 0.564], toApproval: [201, 0.103] }), phase2: Object.freeze({ toNext: [92, 0.283], toApproval: [146, 0.183] }), phase3: Object.freeze({ toFiling: [34, 0.647], toApproval: [54, 0.647] }), filingToApproval: [20, 1.0] }),
  other: Object.freeze({ phase1: Object.freeze({ toNext: [154, 0.636], toApproval: [541, 0.13] }), phase2: Object.freeze({ toNext: [228, 0.386], toApproval: [387, 0.205] }), phase3: Object.freeze({ toFiling: [90, 0.6], toApproval: [159, 0.53] }), filingToApproval: [69, 0.884] }),
})

/**
 * Wong, Siah and Lo (2019), Table 2, all indications, industry-sponsored, path by path, by therapeutic group: `toNext` is [paths, rate] of reaching the next
 * phase, `toApproval` the rate of reaching the approval from that phase (`null` where the paper does not print a value that agrees with the rest of its table:
 * see the header), and `overall` the rate of reaching the approval from phase 1. For phase 3 the paper gives [paths, rate to the approval].
 */
export const VCR_WONG_2019 = Object.freeze({
  overall: Object.freeze({ phase1: Object.freeze({ toNext: [41040, 0.664], toApproval: 0.138 }), phase2: Object.freeze({ toNext: null, toApproval: 0.351, paths: 21180 }), phase3: Object.freeze({ toApproval: [7532, 0.590] }) }),
  oncology: Object.freeze({ phase1: Object.freeze({ toNext: [17368, 0.576], toApproval: 0.034 }), phase2: Object.freeze({ toNext: [6533, 0.327], toApproval: 0.067, paths: 6533 }), phase3: Object.freeze({ toApproval: [1236, 0.355] }) }),
  metabolic_endocrinology: Object.freeze({ phase1: Object.freeze({ toNext: [3589, 0.762], toApproval: 0.196 }), phase2: Object.freeze({ toNext: [2357, 0.597], toApproval: 0.241, paths: 2357 }), phase3: Object.freeze({ toApproval: [1101, 0.516] }) }),
  cardiovascular: Object.freeze({ phase1: Object.freeze({ toNext: [2810, 0.733], toApproval: 0.255 }), phase2: Object.freeze({ toNext: [1858, 0.657], toApproval: 0.323, paths: 1858 }), phase3: Object.freeze({ toApproval: [964, 0.622] }) }),
  cns: Object.freeze({ phase1: Object.freeze({ toNext: [4924, 0.732], toApproval: 0.150 }), phase2: Object.freeze({ toNext: [3037, 0.519], toApproval: 0.195, paths: 3037 }), phase3: Object.freeze({ toApproval: [1156, 0.511] }) }),
  autoimmune_inflammation: Object.freeze({ phase1: Object.freeze({ toNext: [5086, 0.698], toApproval: 0.151 }), phase2: Object.freeze({ toNext: [2910, 0.457], toApproval: 0.212, paths: 2910 }), phase3: Object.freeze({ toApproval: [969, 0.637] }) }),
  genitourinary: Object.freeze({ phase1: Object.freeze({ toNext: [757, 0.687], toApproval: 0.216 }), phase2: Object.freeze({ toNext: [475, 0.571], toApproval: 0.297, paths: 475 }), phase3: Object.freeze({ toApproval: [212, 0.665] }) }),
  infectious_disease: Object.freeze({ phase1: Object.freeze({ toNext: [3963, 0.701], toApproval: 0.252 }), phase2: Object.freeze({ toNext: [2314, 0.583], toApproval: 0.351, paths: 2314 }), phase3: Object.freeze({ toApproval: [1078, 0.753] }) }),
  ophthalmology: Object.freeze({ phase1: Object.freeze({ toNext: [674, 0.871], toApproval: 0.326 }), phase2: Object.freeze({ toNext: [461, 0.607], toApproval: 0.336, paths: 461 }), phase3: Object.freeze({ toApproval: [207, 0.749] }) }),
  vaccines: Object.freeze({ phase1: Object.freeze({ toNext: [1869, 0.768], toApproval: 0.334 }), phase2: Object.freeze({ toNext: [1235, 0.582], toApproval: 0.421, paths: 1235 }), phase3: Object.freeze({ toApproval: [609, 0.854] }) }),
})

export const VCR_WONG_2019_GROUP_LABELS_ZH = Object.freeze({
  "overall": "全部适应症",
  "oncology": "肿瘤",
  "metabolic_endocrinology": "代谢与内分泌",
  "cardiovascular": "心血管",
  "cns": "中枢神经（含精神）",
  "autoimmune_inflammation": "自身免疫与炎症",
  "genitourinary": "泌尿生殖",
  "infectious_disease": "感染",
  "ophthalmology": "眼科",
  "vaccines": "疫苗（感染）"
})

/**
 * One area's rates for the page and for `vcr_read`: each source's rows for the phase asked, with the endpoint each counts to. A phase or an area the table
 * does not hold gives `null` for that source; nothing is filled from the other source.
 * @param {{ phase?: string | null, area?: string | null }} [query]
 */
export function vcrSuccessRates({ phase = null, area = null } = {}) {
  const chosen = VCR_SUCCESS_RATE_AREAS.find((entry) => entry.id === (area ?? 'all')) ?? null
  if (!chosen) return null
  const phases = phase && VCR_SUCCESS_RATE_PHASES.includes(phase) ? [phase] : [...VCR_SUCCESS_RATE_PHASES]
  /** @type {Record<string, any>} */
  const bioTable = VCR_BIO_2011_2020
  /** @type {Record<string, any>} */
  const wongTable = VCR_WONG_2019
  const bio = bioTable[chosen.bio]
  const wong = chosen.wong ? wongTable[chosen.wong] : null
  return {
    area: { id: chosen.id, zh: chosen.zh },
    wongGroup: chosen.wong ? { id: chosen.wong, zh: /** @type {Record<string, string>} */ (VCR_WONG_2019_GROUP_LABELS_ZH)[chosen.wong] } : null,
    phases: phases.map((id) => ({
      id, zh: /** @type {Record<string, string>} */ (VCR_SUCCESS_RATE_PHASE_LABELS_ZH)[id],
      bio: bio ? { ...bio[id] } : null,
      wong: wong ? { ...wong[id] } : null,
    })),
    sources: VCR_SUCCESS_RATE_SOURCES,
  }
}
