/**
 * The words a 虚拟临床研究 write is made of, and the near misses that mean one of them.
 *
 * A write field with a closed vocabulary (`evidenceKind`, `valueSource`, `armRole`, `sourceKind`, `criterionType`) refuses a word
 * outside it. A model reaches for the word it would have named itself — `valueSource: "reported"`, `sourceKind: "literature"`,
 * `criterionType: "prior_therapy"` — and on 2026-11-01 each of these cost a round, and one matching write was refused on nineteen
 * lines for three spellings of two words. That a word means the one the vocabulary has is not language judgement: it is a table, and
 * a closed one (principle 1: the deterministic class goes to code).
 *
 * - **A synonym is taken only when it has exactly one meaning here.** `prior_therapy` is `prior_treatment`; `rct` is not an
 *   `evidenceKind` of anything (it names a study design, not a kind of number), so it stays refused, with the allowed words and what
 *   each means. Nothing is guessed from the sentence a value sits in. The one exception is a criterion's type: the vocabulary has its
 *   own "none of these" (`other`), the tag only groups, and a trial's criteria are refused whole for a tag, so a word that is not a
 *   type is saved as `other` and said.
 * - **What was taken is said.** The write's answer lists each word it read as another (`applied`: the field, the word it took, the word
 *   that was written), so the next call writes the closed word.
 * - **A field with one legal word takes it.** An assumption card of the researcher's own setting has exactly one `valueSource`,
 *   `assumed`; a sentence written there is where the number came from, and it goes to `note`, whole, instead of costing a round.
 * - **`plan` takes the lists a model writes.** The analysis plan and the sensitivity analyses are opaque to the platform (it hashes them
 *   and freezes them); a list of sentences is kept as it was written, under `items`, and a single sentence under `text`.
 *
 * The meanings are what the refusal and the contract read (`vcr_read what=contracts`) print beside each word.
 *
 * @module @evimed/domain/vcrWriteWords
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * A word as the table spells it: trimmed, lower-case, one separator.
 * @param {unknown} word
 */
export const vcrWordKey = (word) => String(word ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')

/**
 * @typedef {{ meanings: Readonly<Record<string, string>>, synonyms?: Readonly<Record<string, string>>, one?: string }} VcrWordField
 *   `meanings`: each legal word and what it says (the legal words are its keys, in order); `synonyms`: other spellings of one of them;
 *   `one`: the field has a single legal word and any other string is a sentence for `note`
 */

/** @type {Readonly<Record<string, Readonly<Record<string, VcrWordField>>>>} */
export const VCR_WRITE_WORDS = Object.freeze({
  evidence_item: Object.freeze({
    evidenceKind: Object.freeze({
      meanings: Object.freeze({
        baseline: '入组时的描述（年龄均值、性别比例等基线特征）',
        outcome: '结局与效应（中位生存期、风险比、事件率、置信区间）',
        design: '设计与入组（样本量、随访时间、随机比例）',
      }),
      synonyms: Object.freeze({
        baseline_characteristics: 'baseline', characteristics: 'baseline', demographics: 'baseline', demographic: 'baseline', patient_characteristics: 'baseline',
        efficacy: 'outcome', result: 'outcome', results: 'outcome', endpoint: 'outcome', survival: 'outcome', effect: 'outcome', safety: 'outcome',
        enrollment: 'design', enrolment: 'design', sample_size: 'design', follow_up: 'design', followup: 'design', trial_design: 'design',
      }),
    }),
    valueSource: Object.freeze({
      meanings: Object.freeze({
        extracted: '原文直接写出的数',
        calculated: '由原文的数算出来的数（引文要包含算它用到的数）',
      }),
      synonyms: Object.freeze({
        reported: 'extracted', published: 'extracted', stated: 'extracted', quoted: 'extracted', direct: 'extracted', read: 'extracted', observed: 'extracted',
        verbatim: 'extracted', literal: 'extracted', from_text: 'extracted',
        derived: 'calculated', computed: 'calculated', calculation: 'calculated', estimated: 'calculated',
      }),
    }),
    armRole: Object.freeze({
      meanings: Object.freeze({
        control: '对照组',
        treatment: '试验组（接受试验干预的一组）',
        contrast: '两组之间的比较量（风险比、差值）',
        single_arm: '单臂试验里唯一的一组',
        overall: '不分组的全体',
        unknown: '原文没说是哪一组',
      }),
      synonyms: Object.freeze({
        experimental: 'treatment', intervention: 'treatment', active: 'treatment', investigational: 'treatment', treated: 'treatment', experimental_arm: 'treatment',
        treatment_arm: 'treatment', test: 'treatment',
        comparator: 'control', control_arm: 'control', placebo: 'control', standard: 'control', standard_of_care: 'control', reference: 'control',
        comparison: 'contrast', difference: 'contrast', effect: 'contrast', hazard_ratio: 'contrast', relative: 'contrast',
        single: 'single_arm', singlearm: 'single_arm', total: 'overall', all: 'overall', pooled: 'overall', whole: 'overall',
      }),
    }),
  }),
  assumption: Object.freeze({
    sourceKind: Object.freeze({
      meanings: Object.freeze({
        expert_set: '研究者自己设定的数（出处写在 note 里）',
        scenario: '情景假设（“如果……会怎样”）',
        external_evidence: '直接取自一条已写入的证据条目（要给 evidenceIds）',
      }),
      synonyms: Object.freeze({
        literature: 'external_evidence', published: 'external_evidence', publication: 'external_evidence', paper: 'external_evidence', article: 'external_evidence',
        trial: 'external_evidence', registry: 'external_evidence', evidence: 'external_evidence', external: 'external_evidence', reported: 'external_evidence',
        pubmed: 'external_evidence', published_literature: 'external_evidence', external_literature: 'external_evidence',
        assumption: 'expert_set', assumed: 'expert_set', expert: 'expert_set', expert_opinion: 'expert_set', expert_judgment: 'expert_set',
        expert_judgement: 'expert_set', judgment: 'expert_set', judgement: 'expert_set', opinion: 'expert_set', prior: 'expert_set', researcher: 'expert_set', investigator: 'expert_set',
        hypothetical: 'scenario', what_if: 'scenario', whatif: 'scenario', sensitivity: 'scenario', scenario_analysis: 'scenario',
      }),
    }),
    valueSource: Object.freeze({
      meanings: Object.freeze({ assumed: '设定的数，不是读出来的（只有这一个取值）' }),
      synonyms: Object.freeze({ assumption: 'assumed', set: 'assumed', stated: 'assumed', expert: 'assumed', expert_set: 'assumed', estimate: 'assumed', guess: 'assumed', scenario: 'assumed' }),
      one: 'assumed',
    }),
  }),
  criterion: Object.freeze({
    criterionType: Object.freeze({
      meanings: Object.freeze({
        demographic: '年龄、性别等人口学',
        diagnosis: '诊断、病理类型、分期',
        biomarker: '分子标志物、基因突变',
        lab: '检验与器官功能的阈值',
        prior_treatment: '既往治疗和治疗线数',
        time_window: '距某事件的时间窗',
        performance_status: '体能状态（ECOG、KPS）',
        comorbidity: '合并症与既往病史',
        concomitant_medication: '合并用药',
        pregnancy: '妊娠、哺乳、避孕',
        consent_capacity: '知情同意与依从性',
        other: '以上都不是',
      }),
      synonyms: Object.freeze({
        demographics: 'demographic', age: 'demographic', sex: 'demographic', gender: 'demographic',
        disease: 'diagnosis', histology: 'diagnosis', pathology: 'diagnosis', condition: 'diagnosis', stage: 'diagnosis', staging: 'diagnosis', indication: 'diagnosis',
        tumor_type: 'diagnosis', cancer_type: 'diagnosis', diagnostic: 'diagnosis',
        mutation: 'biomarker', genetic: 'biomarker', genomic: 'biomarker', molecular: 'biomarker', gene: 'biomarker', marker: 'biomarker', biomarkers: 'biomarker',
        organ_function: 'lab', laboratory: 'lab', lab_value: 'lab', lab_values: 'lab', labs: 'lab', hematology: 'lab', hematologic: 'lab', renal: 'lab', hepatic: 'lab',
        liver_function: 'lab', kidney_function: 'lab', renal_function: 'lab', hepatic_function: 'lab', bone_marrow: 'lab', bone_marrow_function: 'lab',
        prior_therapy: 'prior_treatment', prior_therapies: 'prior_treatment', previous_treatment: 'prior_treatment', previous_therapy: 'prior_treatment', treatment_history: 'prior_treatment',
        prior_line: 'prior_treatment', prior_lines: 'prior_treatment', line_of_therapy: 'prior_treatment', prior_chemotherapy: 'prior_treatment', prior_anticancer_therapy: 'prior_treatment',
        washout: 'time_window', window: 'time_window', timing: 'time_window', time_since: 'time_window',
        performance: 'performance_status', ecog: 'performance_status', kps: 'performance_status', karnofsky: 'performance_status', functional_status: 'performance_status', ps: 'performance_status',
        comorbidities: 'comorbidity', medical_history: 'comorbidity', history: 'comorbidity', infection: 'comorbidity', cardiac: 'comorbidity', cardiovascular: 'comorbidity',
        concomitant: 'concomitant_medication', concomitant_medications: 'concomitant_medication', prohibited_medication: 'concomitant_medication', medication: 'concomitant_medication',
        contraception: 'pregnancy', lactation: 'pregnancy', reproductive: 'pregnancy', childbearing: 'pregnancy',
        consent: 'consent_capacity', informed_consent: 'consent_capacity', compliance: 'consent_capacity', capacity: 'consent_capacity',
      }),
    }),
  }),
})

/**
 * Each legal word of a field with what it says, as the sentence a refusal and the contract read print: `baseline（入组时的描述……）、……`.
 * @param {string} what @param {string} field
 * @returns {string}
 */
export function vcrWordList(what, field) {
  const entry = VCR_WRITE_WORDS[what]?.[field]
  if (!entry) return ''
  return Object.entries(entry.meanings).map(([word, meaning]) => `${word}（${meaning}）`).join('、')
}

/**
 * @typedef {{ field: string, from: string, value: string, took?: string, index?: number }} VcrWordApplied
 *   `from`: what was written; `value`: the word the platform wrote it as
 */

/**
 * One word of a field read as the vocabulary's: itself, or the one word the table says its spelling means; null when it is neither.
 * @param {string} what @param {string} field @param {unknown} word
 * @returns {string | null}
 */
export function vcrReadWord(what, field, word) {
  const entry = VCR_WRITE_WORDS[what]?.[field]
  if (!entry || typeof word !== 'string') return null
  if (Object.hasOwn(entry.meanings, word)) return word
  const key = vcrWordKey(word)
  if (Object.hasOwn(entry.meanings, key)) return key
  return entry.synonyms && Object.hasOwn(entry.synonyms, key) ? entry.synonyms[key] : null
}

/** The `criteria` of a row that writes criteria, or the row itself when it is one. @param {string} what @param {Record<string, any>} row */
function criteriaOf(what, row) {
  if (Array.isArray(row.criteria)) return { at: 'criteria', list: row.criteria }
  return what === 'criteria' ? { at: '', list: [row] } : { at: 'criteria', list: [] }
}

/**
 * A write row with its near-miss words read as the closed ones, and what was read as what.
 *
 * @param {string} what the write's kind @param {unknown} row one item
 * @returns {{ row: any, applied: VcrWordApplied[] }}
 */
export function vcrNormalizeWriteRow(what, row) {
  if (!isObject(row)) return { row, applied: [] }
  /** @type {VcrWordApplied[]} */
  const applied = []
  let out = row

  /** @param {Record<string, any>} target @param {string} table @param {string} field @param {string} path */
  const read = (target, table, field, path) => {
    const written = target[field]
    if (typeof written !== 'string') return target
    const taken = vcrReadWord(table, field, written)
    if (taken === null || taken === written) return target
    applied.push({ field: path, from: written, value: taken })
    return { ...target, [field]: taken }
  }

  if (what === 'evidence_item') {
    for (const field of ['evidenceKind', 'valueSource', 'armRole']) out = read(out, 'evidence_item', field, field)
  } else if (what === 'assumption') {
    out = read(out, 'assumption', 'sourceKind', 'sourceKind')
    const kind = out.sourceKind ?? 'expert_set'
    if (out.valueSource != null && kind === 'external_evidence' && out.fromPooling == null && out.expertFrom == null) {
      // A card that takes its number from an evidence item takes its source from it too: what was written there is a label for the
      // evidence's, never the card's own, and is left out (the number is the one thing that is not typed, and it is still refused).
      applied.push({ field: 'valueSource', from: String(out.valueSource).slice(0, 60), value: '(from the evidence)', took: '由被引用的证据决定，已忽略你写的' })
      const { valueSource: _label, ...rest } = out
      out = rest
    } else if (typeof out.valueSource === 'string' && kind !== 'external_evidence' && out.fromPooling == null && out.expertFrom == null) {
      const taken = vcrReadWord('assumption', 'valueSource', out.valueSource)
      if (taken === null) {
        // The one legal word is `assumed`; a sentence here says where the number came from, which is the note's.
        const sentence = out.valueSource.trim()
        const note = typeof out.note === 'string' ? out.note.trim() : ''
        const joined = note && !note.includes(sentence) ? `${note}；${sentence}` : note || sentence
        applied.push({ field: 'valueSource', from: sentence.slice(0, 60), value: 'assumed', took: '写的是出处，已并入 note；valueSource 只有 assumed 一个取值' })
        out = { ...out, valueSource: 'assumed', note: joined.slice(0, 1000) }
      } else if (taken !== out.valueSource) {
        applied.push({ field: 'valueSource', from: out.valueSource, value: taken })
        out = { ...out, valueSource: taken }
      }
    }
  } else if (what === 'protocol' || what === 'criteria' || what === 'candidate_trial') {
    const { at, list } = criteriaOf(what, out)
    let changed = false
    const next = list.map((criterion, index) => {
      if (!isObject(criterion) || typeof criterion.criterionType !== 'string' || !criterion.criterionType.trim()) return criterion
      const where = `${at ? `${at}[${index}].` : ''}criterionType`
      const taken = vcrReadWord('criterion', 'criterionType', criterion.criterionType)
      if (taken === criterion.criterionType) return criterion
      // The type is a tag for grouping; the requirement is what is judged. A trial's criteria are refused whole when one is outside the
      // grammar, so one tag the vocabulary lacks (`cns`) would lose fifteen criteria for a label. `other` is the vocabulary's own "none of
      // these": a word that is not a type is read as that, and the answer lists the types so a later version can say which.
      applied.push(taken === null
        ? { field: where, from: criterion.criterionType.slice(0, 40), value: 'other', took: `不是规定的类型，按 other 保存；要归类用：${Object.keys(VCR_WRITE_WORDS.criterion.criterionType.meanings).join('、')}` }
        : { field: where, from: criterion.criterionType, value: taken })
      changed = true
      return { ...criterion, criterionType: taken ?? 'other' }
    })
    if (changed) out = at ? { ...out, criteria: next } : next[0]
  } else if (what === 'plan') {
    for (const field of ['analysis', 'sensitivity']) {
      const written = out[field]
      if (Array.isArray(written)) {
        applied.push({ field, from: 'list', value: 'items', took: '列表原样保存在 items 下' })
        out = { ...out, [field]: { items: written } }
      } else if (typeof written === 'string' && written.trim()) {
        applied.push({ field, from: 'text', value: 'text', took: '这段话原样保存在 text 下' })
        out = { ...out, [field]: { text: written } }
      }
    }
  }
  return { row: out, applied }
}
