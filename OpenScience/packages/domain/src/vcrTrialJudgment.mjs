/**
 * Judging a patient against a trial's eligibility text (owner decisions of 2026-11-04): pure functions, no I/O.
 *
 * The prompts are ported from TrialGPT 2.0 (trial-level fit, github.com/TrialGPT2/TrialGPT2.0 at 1c5f9ebc3b98) and TrialGPT 1.0
 * (per-criterion, github.com/ncbi-nlp/TrialGPT at 1b3242cd), both works of the US National Library of Medicine; see NOTICE.
 *
 * What is language and what is not:
 *
 * - **The model decides**: whether a criterion holds, what a note's silence means for it, how relevant the trial is. A criterion the
 *   note says nothing about is judged too, and that judgement is what 「未见记载，按未排除」 and 「未见记载，需确认」 label.
 * - **Code decides**: where sentences and clauses begin and end, whether a sentence id exists, what source text an id resolves to,
 *   whether a label came with evidence (`basis`), and the arithmetic of a verdict and an order. Evidence is an id the code resolves,
 *   so the model never has to copy a quotation and can never invent one.
 *
 * Hidden knowledge:
 *
 * - **The note comes before the trial in the user message.** The system prompt and the note are the same across one patient's trials,
 *   so the provider's prefix cache hits for all of them; the trial is the part that changes.
 * - **Model output never throws.** A parser returns normalised data and `issues`, whatever came back. A clause the model did not
 *   answer is returned as `missing`, never guessed; a sentence id that does not exist is dropped and counted, and the label stands.
 * - **A verdict is a label, not a gate.** Nothing reads it to refuse a write or withhold a result.
 * - **`number` is 1-based and runs across the whole text**, so one call can carry both kinds; `kind` says which section a clause is in.
 *
 * @module @evimed/domain/vcrTrialJudgment
 */

/** Bumped when a prompt changes enough that a pair judged under the old one should be judged again. */
export const VCR_JUDGMENT_PROMPT_VERSIONS = Object.freeze({ fit: 'fit-1', criteria: 'criteria-1' })

/** The labels of a clause, as stored. */
export const VCR_CRITERION_LABELS = Object.freeze(['included', 'not_included', 'excluded', 'not_excluded', 'not_applicable', 'not_enough_information'])

/** The four verdicts, in the order a reader goes through them, with the words a person reads. */
export const VCR_TRIAL_VERDICT_LABELS_ZH = Object.freeze({ eligible: '符合', possible: '可能符合', insufficient: '证据不足', ineligible: '不符合' })

/**
 * The bands of TrialGPT 2.0's score, as a verdict reads them when no clause was judged. Its prompt reserves 80-100 for plausible
 * candidates for screening and near 0 for a clear failure, and lowers the score for a missing non-screenable prerequisite: the band
 * in between is what 「可能符合」 and 「证据不足」 divide.
 */
export const VCR_FIT_BANDS = Object.freeze({ eligible: 80, possible: 50, insufficient: 20 })

/** @param {unknown} value @returns {Record<string, any>} */
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {})

const CJK = /[\u3400-\u9fff]/u

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/**
 * The sentences of a text, numbered from 0, with UTF-16 offsets into it: `text.slice(start, end)` holds the sentence. A line break
 * separates sentences as well, because a clinical note is written in lines that often end without a stop.
 * @param {unknown} text @param {{ locale?: string }} [options]
 * @returns {Array<{ id: number, text: string, start: number, end: number }>}
 */
export function segmentSentences(text, { locale } = {}) {
  const source = String(text ?? '')
  const segmenter = new Intl.Segmenter(locale ?? (CJK.test(source) ? 'zh' : 'en'), { granularity: 'sentence' })
  /** @type {Array<{ id: number, text: string, start: number, end: number }>} */
  const sentences = []
  for (const line of source.matchAll(/[^\r\n\u2028\u2029]+/gu)) {
    for (const part of segmenter.segment(line[0])) {
      const body = part.segment.trim()
      if (!body) continue
      const start = line.index + part.index + (part.segment.length - part.segment.trimStart().length)
      sentences.push({ id: sentences.length, text: body, start, end: start + body.length })
    }
  }
  return sentences
}

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

const QUALIFIER = String.raw`(?:(?:key|main|major|general|additional|specific|principal|primary|secondary|study|other|patient|subject|participant|part\s+\w+|cohort\s+\w+|phase\s+\w+|arm\s+\w+)\s+)*`
const ONLY_QUALIFIER = new RegExp(String.raw`^[\W_]*${QUALIFIER}$`, 'iu')
const EN_HEADER = new RegExp(String.raw`^${QUALIFIER}(inclusions?|exclusions?)(\s+(?:criteria|criterion|conditions?|requirements?))?\b([^\n]*)$`, 'iu')
const ZH_HEADER = /^(?:主要|关键|重要|一般)?(?:受试者|患者|病例)?(?:(入选|入组|纳入)|(排除|剔除|不入选|不入组|不纳入))(?:标准|条件)([^\n]*)$/u
/** A heading that names no side: it says what follows and is no clause. */
const NEUTRAL_HEADER = /^(?:(?:(?:key|main|general|study)\s+)*(?:eligibility(?:\s+criteria)?|inclusion\s*(?:and|\/|&)\s*exclusion(?:\s+criteria)?)|criteria)\s*[:：]?$|^(?:入排|入选排除|入组排除|纳入排除|纳排|入选和排除|纳入和排除)(?:标准|条件)\s*[:：]?$/iu
/** A section heading in the middle of a line (a registry text written as one paragraph). */
const INLINE_HEADER = /(?<=[\s.;。；])(?:(?:key|main)\s+)?(?:inclusion|exclusion)\s+criteria\s*[:：]|(?<=[\s.;。；])(?:入选|入组|纳入|排除)(?:标准|条件)\s*[:：]/giu
const ALL_CAPS = /^[A-Z][A-Z0-9 ,/&()'-]{3,80}[:：]?$/u
/** Decoration around a heading: a Markdown mark, or the 一、 of a Chinese outline. */
const HEADING_DECORATION = /^(?:[#>*_\s]+|\(?[一二三四五六七八九十]{1,3}[、.．)）]\s*|（[一二三四五六七八九十]{1,3}）\s*|\d{1,2}[、.．)）]\s*)*/u
const WORD = /[\p{L}\p{N}]/u
const OPEN_ENDING = /(?:[,，、（(]|\b(?:and|or|with|without|of|the|to|in|for|at|by|a|an|than|including|who|that|which|on|from|as)|和|或|及|以及|或者|并|且)$/iu

/**
 * The bullet or number a line opens with: its length, its class, and for a plain number the number. Letter markers are read only where
 * they cannot be the start of a sentence (`E. coli` opens with no marker).
 * @param {string} body the line without its indent
 * @returns {{ length: number, marker: string, ordinal: number | null } | null}
 */
function markerOf(body) {
  /** @type {RegExpExecArray | null} */
  let found
  if ((found = /^(?:[*•·▪▫◦‣⁃○●■□◆◇※+](?!\*)|[-–—](?!\d)|o(?=\s+[A-Z\d]))\s*/u.exec(body))) return { length: found[0].length, marker: 'bullet', ordinal: null }
  if ((found = /^[(（]?(\d{1,3})(?:[.．](?!\d)|[、)）])\s*/u.exec(body))) return { length: found[0].length, marker: 'number', ordinal: Number(found[1]) }
  if ((found = /^[①-⑳]\s*/u.exec(body))) return { length: found[0].length, marker: 'number', ordinal: body.charCodeAt(0) - 0x2460 + 1 }
  if ((found = /^(?:[一二三四五六七八九十]{1,3}[、.．]|（[一二三四五六七八九十]{1,3}）)\s*/u.exec(body))) return { length: found[0].length, marker: 'number', ordinal: null }
  if ((found = /^(?:[(（]?[a-z][.)）]\s+|[(（]?[A-Z]\)\s+|[A-Z]\.\s+(?=[A-Z\d])|[(（]?(?:[ivx]{1,5}|[IVX]{1,5})\)\s+|(?:[ivx]{1,5}|[IVX]{1,5})\.\s+(?=[A-Z\d]))/u.exec(body))) return { length: found[0].length, marker: 'letter', ordinal: null }
  return null
}

/**
 * A line that opens with number one and goes on to two, three... on the same line (`1、年龄≥18岁；2、确诊…`), at the offsets where each
 * item begins. A number that does not continue the count is the line's own words.
 * @param {string} body @returns {number[]} offsets into `body`, the first being 0; empty when the line is one item
 */
function inlineItems(body) {
  const first = markerOf(body)
  if (first?.ordinal !== 1) return []
  const offsets = [0]
  let next = 2
  for (const hit of body.matchAll(/(?<=[\s；;。.，,])[(（]?(\d{1,2})(?:[.．](?!\d)|[、)）])|[②-⑳]/gu)) {
    const ordinal = hit[1] ? Number(hit[1]) : hit[0].charCodeAt(0) - 0x2460 + 1
    if (ordinal === next) { offsets.push(hit.index); next += 1 }
  }
  return offsets.length > 1 ? offsets : []
}

/** @param {string} line the line without its indent and decoration @returns {{ kind: 'inclusion' | 'exclusion', rest: number, qualified: boolean } | null} */
function sectionHeaderOf(line) {
  const zh = ZH_HEADER.exec(line)
  if (zh) {
    const tail = zh[3]
    if (!/^\s*(?:[（(][^)）]*[)）])?\s*(?:[:：]|$)/u.test(tail)) return null
    const colon = tail.search(/[:：]/u)
    const said = colon < 0 ? tail : tail.slice(0, colon)
    return { kind: zh[1] ? 'inclusion' : 'exclusion', rest: colon < 0 ? line.length : line.length - tail.length + colon + 1, qualified: Boolean(said.trim()) }
  }
  const en = EN_HEADER.exec(line)
  if (!en) return null
  const tail = en[3]
  const colon = tail.search(/[:：]/u)
  const before = colon < 0 ? tail : tail.slice(0, colon)
  // "Inclusion Criteria for Part 1" names a section without a colon; "Inclusion criteria are met" and "Exclusion of brain metastases" do not.
  const heading = colon >= 0 ? before.length <= 60 && !/[.;。；]/u.test(before)
    : !before.trim() || (Boolean(en[2]) && /^\s*(?:for|in|\()/iu.test(before) && before.length <= 60)
  if (!heading) return null
  return { kind: /^inclusion/iu.test(en[1]) ? 'inclusion' : 'exclusion', rest: colon < 0 ? line.length : line.length - tail.length + colon + 1,
    qualified: Boolean(before.trim()) || /^(?:part|cohort|phase|arm)\s/iu.test(line) }
}

/**
 * The lines of a text with their offsets. A section heading in the middle of a line starts a line of its own, and a line that runs
 * through a numbered list is one line per item.
 * @param {string} source @returns {Array<{ start: number, end: number, afterBreak: boolean }>}
 */
function linesOf(source) {
  /** @type {Array<{ start: number, end: number, afterBreak: boolean }>} */
  const lines = []
  for (const line of source.matchAll(/[^\r\n]*/gu)) {
    if (line.index > 0 && !/[\r\n]/u.test(source[line.index - 1])) continue
    const cuts = [...line[0].matchAll(INLINE_HEADER)].map((hit) => hit.index).filter((at) => at > 0 && !ONLY_QUALIFIER.test(line[0].slice(0, at)))
    let from = 0
    for (const at of [...cuts, line[0].length]) {
      lines.push({ start: line.index + from, end: line.index + at, afterBreak: from === 0 })
      from = at
    }
  }
  return lines
}

/**
 * Raw registry eligibility text in numbered clauses, deterministically. English and Chinese section headings, bullets, numbered lists and
 * blank-line blocks are read; a heading is no clause; a clause is never truncated and `text.slice(start, end)` holds it. A bullet indented
 * under another stays with its parent, because "adequate organ function, defined as:" means nothing without its list. A line that only
 * introduces the bullets after it ("Cohort 2 must also have:") is carried as each one's `lead` instead of being a clause of its own. Text
 * with no recognisable structure stays one `unsectioned` clause.
 * @param {unknown} eligibilityText
 * @returns {Array<{ number: number, kind: 'inclusion' | 'exclusion' | 'unsectioned', text: string, start: number, end: number, lead?: string }>}
 */
export function segmentCriteria(eligibilityText) {
  const source = String(eligibilityText ?? '')
  /** @type {Array<{ number: number, kind: 'inclusion' | 'exclusion' | 'unsectioned', text: string, start: number, end: number, lead?: string }>} */
  const clauses = []
  /** @type {'inclusion' | 'exclusion' | 'unsectioned'} */
  let kind = 'unsectioned'
  let sectioned = false
  /** @type {{ start: number, end: number, bullet: boolean, indent: number | null } | null} */
  let current = null
  /** @type {string | null} what the section's own heading adds ("Inclusion Criteria for Part 1:") */
  let sectionLead = null
  /** @type {string | null} a capitalised heading inside a section ("FOR HEALTHY VOLUNTEERS:"), until the next one */
  let groupLead = null
  /** @type {string | null} a line that introduces the bullets right after it */
  let lead = null
  /** @type {number | null} */
  let baseIndent = null
  /** @type {string | null} */
  let primaryMarker = null
  /** @type {number | null} */
  let lastOrdinal = null
  let sawBlank = false

  const close = () => {
    if (!current) return
    const text = source.slice(current.start, current.end).trimEnd()
    const carried = [sectionLead, groupLead, lead].filter(Boolean).join(' ')
    if (WORD.test(text)) clauses.push({ number: clauses.length + 1, kind, text, start: current.start, end: current.start + text.length, ...(carried ? { lead: carried } : {}) })
    current = null
  }

  // A worklist, not a loop over the lines: what is left of a heading's line and each item of an inline list come back as lines of their own.
  const queue = linesOf(source)
  for (let at = 0; at < queue.length; at += 1) {
    const line = queue[at]
    const whole = source.slice(line.start, line.end)
    const body = whole.trimStart()
    // A line that began in the middle of a line has no indent of its own to compare.
    const indent = line.afterBreak ? whole.length - body.length : null
    const start = line.start + (whole.length - body.length)
    const trimmed = body.trimEnd()
    if (!trimmed) { if (line.afterBreak) sawBlank = true; continue }

    const items = inlineItems(body)
    if (items.length > 1) {
      queue.splice(at, 1, ...items.map((offset, index) => ({ start: start + offset, end: index + 1 < items.length ? start + items[index + 1] : line.end, afterBreak: index === 0 && line.afterBreak, itemised: true })))
      at -= 1
      continue
    }

    const decorated = HEADING_DECORATION.exec(trimmed)?.[0].length ?? 0
    const plain = trimmed.slice(decorated).replace(/[*_]+\s*$/u, '').replace(/^[*_]+/u, '')
    const opening = trimmed.indexOf(plain)
    if (NEUTRAL_HEADER.test(plain)) { close(); lead = null; groupLead = null; sectionLead = null; sawBlank = false; continue }
    const header = sectionHeaderOf(plain)
    if (header) {
      close()
      kind = header.kind
      sectioned = true
      sectionLead = header.qualified ? plain.slice(0, header.rest).trim() : null
      groupLead = null
      lead = null
      baseIndent = null
      primaryMarker = null
      lastOrdinal = null
      sawBlank = false
      const remainder = start + opening + header.rest
      if (remainder < line.end && WORD.test(source.slice(remainder, line.end))) queue.splice(at + 1, 0, { start: remainder, end: line.end, afterBreak: false })
      continue
    }

    const marker = markerOf(body)
    if (marker) {
      if (indent !== null && (baseIndent === null || indent < baseIndent)) baseIndent = indent
      primaryMarker = primaryMarker ?? marker.marker
      const held = /** @type {{ start: number, end: number, bullet: boolean, indent: number | null } | null} */ (current)
      const leadIn = held ? /[:：]$/u.test(source.slice(held.start, held.end).trimEnd()) : false
      const nextInCount = marker.ordinal !== null && marker.marker === primaryMarker && marker.ordinal === (lastOrdinal ?? 0) + 1
      const deeper = indent !== null && baseIndent !== null && indent >= baseIndent + 2
      if (held && !nextInCount && (deeper || (leadIn && marker.marker !== primaryMarker))) held.end = line.end
      else {
        close()
        current = { start: start + marker.length, end: line.end, bullet: true, indent }
        if (marker.marker === primaryMarker) lastOrdinal = marker.ordinal
      }
      sawBlank = false
      continue
    }

    const held = /** @type {{ start: number, end: number, bullet: boolean, indent: number | null } | null} */ (current)
    if (held) {
      const previous = source.slice(held.start, held.end).trimEnd()
      const wrapped = /^\p{Ll}/u.test(body) || OPEN_ENDING.test(previous)
      const continues = held.bullet
        ? (indent !== null && held.indent !== null && indent > held.indent) || (!sawBlank && wrapped)
        : !sawBlank && (!sectioned && primaryMarker === null ? true : wrapped)
      if (continues) { held.end = line.end; sawBlank = false; continue }
    }
    close()
    sawBlank = false
    const next = nextLine(source, queue, at)
    const nextMarked = next != null && markerOf(next) != null
    // A line that only introduces what follows, in words or as a capitalised heading, is carried with each item below it: its words are
    // the premise of those items ("FOR PATIENTS UNDERGOING BIOPSIES:"), so they travel with them rather than vanish or stand as a clause.
    if (/[:：]$/u.test(trimmed) && ALL_CAPS.test(trimmed)) { groupLead = trimmed; lead = null; continue }
    if (nextMarked && (/[:：]$/u.test(trimmed) || ALL_CAPS.test(trimmed))) { lead = trimmed; continue }
    lead = null
    current = { start, end: line.end, bullet: false, indent }
  }
  close()
  return clauses
}

/** The next line with words on it, without its indent. @param {string} source @param {ReadonlyArray<{ start: number, end: number }>} queue @param {number} at */
function nextLine(source, queue, at) {
  for (let index = at + 1; index < queue.length; index += 1) {
    const body = source.slice(queue[index].start, queue[index].end).trim()
    if (body) return body
  }
  return null
}

/** One clause as the model reads it: its lead-in, its words on one line. @param {{ text: string, lead?: string }} clause */
const clauseWords = (clause) => `${clause.lead ? `${clause.lead} ` : ''}${clause.text}`.replace(/\s*[\r\n]+\s*/gu, ' ')

// ---------------------------------------------------------------------------
// The model's part
// ---------------------------------------------------------------------------

const REASONS_LANGUAGE = 'Write every reason in the language of the patient note: a Chinese note gets Chinese reasons, an English note English ones. Keep drug, gene and trial names as written.'

const FIT_SYSTEM = [
  "You are a medical assistant matching a patient to a clinical trial using the RAW eligibility text.",
  "You will be given a patient note/summary, the trial's title/brief summary, and the RAW eligibility text.",
  'The raw criteria may imply multiple cohorts/arms. Consider them all internally.',
  '',
  'Evidence reasoning when information is absent:',
  "- If there is no direct evidence for a required piece of information, ask: 'If this were true, is it plausible that a well-documented patient note would omit it?'",
  '  - If omission would be implausible (a good note would almost certainly mention it), infer it is likely NOT true and reflect that in the score.',
  '  - If omission is plausible (a good note could reasonably miss it), treat it as insufficient information.',
  '- Use clinical judgement about whether a requirement can apply to this patient at all: a 78-year-old is not pregnant, whatever the note omits.',
  '',
  'CLINICAL RELEVANCE WEIGHTING',
  "1) If the patient's only eligibility is for non-disease-directed participation (as a healthy control, in a general biorepository or biospecimen banking study, or in a site-wide screening or registry protocol), assign a LOW score (typically near 0 for a healthy-control mismatch, at most 30 for biorepository or screening). Give high confidence and explain that the trial is not disease-directed and is deprioritized.",
  "2) Reserve higher scores for disease-directed therapeutic, diagnostic or supportive-care protocols that directly relate to the patient's condition.",
  '',
  'SCORING RULES',
  '- "score" (0-100): how well the patient matches the trial. Use 80-100 for plausible candidates for screening; use near 0 for patients who clearly fail eligibility.',
  '- "confidence" (0.0-1.0): certainty about the score, based on how complete the information is.',
  '',
  'ASSUME-AT-SCREENING POLICY',
  'Do NOT lower the score for missing routine and feasible requirements: labs, ECOG, serologies, pregnancy test, TB tests, imaging recency, companion screening, biopsy feasibility, TIL availability, EKG/echo, washout windows, contraception counseling, trial-specific biomarkers/antigen expression, or HLA typing. Instead, reduce confidence if such information is missing.',
  'Lower the score when:',
  '- explicit conflicting evidence is present (abnormal labs, positive serologies);',
  '- non-screenable prerequisites (diagnosis/subtype, histology, stage, required mutation, measurable disease, prior therapy lines, transplant history, age/sex) are missing.',
  'If ANY explicit exclusion criterion is met, set the score near 0 with high confidence.',
  '',
  'REASONING FORMAT (STRICT)',
  'Separate your reasoning into JSON fields:',
  '- eligible_reasons: criteria the patient meets or likely meets.',
  '- missing_information: IMPORTANT eligibility drivers that are required but not documented. Prioritize decision-driving, non-screenable prerequisites. Do NOT list routine labs/ECOG individually; you may summarize them together.',
  '- ineligible_reasons: explicit mismatches or exclusion criteria.',
  '- rationale: brief explanation of why the score is high or low. Do NOT restate the score or repeat the note.',
  'List items in each field as: "1. <reason> 2. <reason> 3. <reason>".',
  REASONS_LANGUAGE,
  '',
  'OUTPUT FORMAT (STRICT JSON)',
  'Return strict JSON with exactly these keys:',
  '{"eligible_reasons": "1. ... 2. ...", "missing_information": "1. ... 2. ...", "ineligible_reasons": "1. ... 2. ...", "rationale": "1. ... 2. ...", "score": <integer 0-100>, "confidence": <float between 0.0 and 1.0>}',
  'No markdown, no comments, no additional text outside the JSON object.',
].join('\n')

/**
 * The trial-level call of one patient and one trial (TrialGPT 2.0). A trial whose record carries no eligibility text is judged on what it
 * does carry, and the prompt says so.
 * @param {{ title?: string, summary?: string, eligibility?: string, note: string, conditions?: readonly string[], interventions?: readonly string[] }} input
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function fitMessages({ title = '', summary = '', eligibility = '', note, conditions = [], interventions = [] }) {
  const raw = String(eligibility ?? '').trim()
  const user = [
    `Patient note/summary:\n${String(note ?? '').trim()}`,
    '',
    `Title: ${String(title ?? '').trim()}`,
    ...(conditions.length ? [`Target conditions: ${conditions.join(', ')}`] : []),
    ...(interventions.length ? [`Interventions: ${interventions.join(', ')}`] : []),
    `Brief summary: ${String(summary ?? '').trim()}`,
    '',
    raw ? `Eligibility Criteria (raw):\n${raw}` : 'Eligibility Criteria (raw): the registry record carries none. Judge from the title, target conditions and summary, and say in missing_information that the eligibility text was not available.',
    '',
    'Task: Evaluate eligibility using the rules above, apply the clinical relevance weighting, identify all inclusion/exclusion issues, and produce the required JSON with numbered reasons.',
  ].join('\n')
  return [{ role: 'system', content: FIT_SYSTEM }, { role: 'user', content: user }]
}

const SIDE = Object.freeze({
  inclusion: {
    about: 'The factors that allow someone to participate in a clinical study are called inclusion criteria. They are based on characteristics such as age, gender, the type and stage of a disease, previous treatment history, and other medical conditions.',
    labels: 'for an inclusion criterion the label must be chosen from {"not applicable", "not enough information", "included", "not included"}. "included" denotes that the patient meets the inclusion criterion, while "not included" means the reverse.',
  },
  exclusion: {
    about: 'The factors that disqualify someone from participating are called exclusion criteria. They are based on characteristics such as age, gender, the type and stage of a disease, previous treatment history, and other medical conditions.',
    labels: 'for an exclusion criterion the label must be chosen from {"not applicable", "not enough information", "excluded", "not excluded"}. "excluded" denotes that the patient meets the exclusion criterion and should be excluded from the trial, while "not excluded" means the reverse.',
  },
})

/** @param {'inclusion' | 'exclusion' | undefined} kind */
function criteriaSystem(kind) {
  const sides = kind ? [SIDE[kind]] : [SIDE.inclusion, SIDE.exclusion]
  const which = kind ?? 'inclusion and exclusion'
  return [
    `You are a helpful assistant for clinical trial recruitment. Your task is to compare a given patient note and the ${which} criteria of a clinical trial to determine the patient's eligibility at the criterion level.`,
    ...sides.map((side) => side.about),
    `You should check the ${which} criteria one-by-one, and output the following three elements for each criterion:`,
    "\tElement 1. For each criterion, briefly generate your reasoning process: First, judge whether the criterion is not applicable (not very common), where the patient does not meet the premise of the criterion. Then, check if the patient note contains direct evidence. If so, judge whether the patient meets or does not meet the criterion. If there is no direct evidence, try to infer from existing evidence, and answer one question: If the criterion is true, is it possible that a good patient note will miss such information? If impossible, then you can assume that the criterion is not true. Otherwise, there is not enough information.",
    '\tElement 2. If there is relevant information, you must generate a list of relevant sentence IDs in the patient note. If there is no relevant information, you must annotate an empty list.',
    `\tElement 3. Classify the patient eligibility for this specific criterion: ${sides.map((side) => side.labels).join(' ')}${kind ? '' : ' A criterion listed under "Other criteria" takes whichever of the two label sets fits how it is worded.'} "not applicable" should only be used for criteria that are not applicable to the patient. "not enough information" should be used where the patient note does not contain sufficient information for making the classification. Try to use as less "not enough information" as possible because if the note does not mention a medically important fact, you can assume that the fact is not true for the patient.`,
    'Judge what the person is, not only what the note says: a 78-year-old woman is not pregnant, so a pregnancy exclusion is "not excluded" or "not applicable" for her, and never "not enough information".',
    REASONS_LANGUAGE,
    'You should output only a JSON dict exactly formatted as: dict{str(criterion_number): list[str(element_1_brief_reasoning), list[int(element_2_sentence_id)], str(element_3_eligibility_label)]}.',
  ].join('\n')
}

/**
 * The per-criterion call of one patient and one trial (TrialGPT 1.0): numbered sentences, numbered clauses, one answer per clause. With
 * `kind` the call carries that side only, as the original does; without it, one call carries both.
 * @param {{ title?: string, summary?: string, kind?: 'inclusion' | 'exclusion', criteria: ReadonlyArray<{ number: number, kind: string, text: string, lead?: string }>, sentences: ReadonlyArray<{ id: number, text: string }>, conditions?: readonly string[], interventions?: readonly string[] }} input
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function criteriaMessages({ title = '', summary = '', kind, criteria, sentences, conditions = [], interventions = [] }) {
  const listed = kind ? criteria.filter((clause) => clause.kind === kind || clause.kind === 'unsectioned') : criteria
  /** @param {string} name @param {string} heading */
  const section = (name, heading) => {
    const rows = listed.filter((clause) => clause.kind === name)
    return rows.length ? [`${heading}:`, ...rows.map((clause) => `${clause.number}. ${clauseWords(clause)}`)] : []
  }
  const user = [
    'Here is the patient note, each sentence is led by a sentence_id:',
    ...sentences.map((sentence) => `${sentence.id}. ${sentence.text}`),
    '',
    'Here is the clinical trial:',
    `Title: ${String(title ?? '').trim()}`,
    ...(conditions.length ? [`Target diseases: ${conditions.join(', ')}`] : []),
    ...(interventions.length ? [`Interventions: ${interventions.join(', ')}`] : []),
    `Summary: ${String(summary ?? '').trim()}`,
    ...section('inclusion', 'Inclusion criteria'),
    ...section('exclusion', 'Exclusion criteria'),
    ...section('unsectioned', kind ? `${kind === 'inclusion' ? 'Inclusion' : 'Exclusion'} criteria` : 'Other criteria'),
    '',
    'Plain JSON output:',
  ].join('\n')
  return [{ role: 'system', content: criteriaSystem(kind) }, { role: 'user', content: user }]
}

// ---------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------

/**
 * The JSON of a model's answer, in the shapes models really return it: an object already, a bare string, a fenced block, words around it,
 * a trailing comma. `null` when there is none in it.
 * @param {unknown} raw @returns {any}
 */
function looseJson(raw) {
  if (raw && typeof raw === 'object') return raw
  const text = String(raw ?? '').replace(/^\uFEFF/u, '').trim()
  if (!text) return null
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/u.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  const brace = body.search(/[{[]/u)
  const last = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  for (const candidate of [body, ...(brace >= 0 && last > brace ? [body.slice(brace, last + 1)] : [])]) {
    try { return JSON.parse(candidate) } catch { /* the next shape */ }
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/gu, '$1')) } catch { /* the next shape */ }
  }
  return null
}

/** @param {unknown} value @returns {number | null} a number, also out of a string that prints one ("85", "85%", "85/100") */
function numberIn(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const found = /-?\d+(?:\.\d+)?/u.exec(value)
  return found ? Number(found[0]) : null
}

const NOTHING = /^(?:n\/?a|none|nil|null|no|no information|not applicable|无|暂无|没有|无。|-+|—+|\.+)\.?$/iu

/** @param {string} text the items of one reasons field, in whichever way they were listed */
function splitNumbered(text) {
  const body = text.trim()
  const offsets = inlineItems(body)
  const pieces = offsets.length ? offsets.map((at, index) => body.slice(at, offsets[index + 1])) : body.split(/\r?\n+/u)
  return pieces.map((piece) => {
    const marker = markerOf(piece.trim())
    return (marker ? piece.trim().slice(marker.length) : piece).trim()
  }).filter((piece) => piece && !NOTHING.test(piece))
}

/**
 * A reasons field as a list, whether it came as a string, an array, an object or something nested of those.
 * @param {unknown} value @returns {string[]}
 */
export function reasonList(value) {
  if (typeof value === 'string') return splitNumbered(value)
  if (Array.isArray(value)) return value.flatMap(reasonList)
  if (typeof value === 'number') return [String(value)]
  if (value && typeof value === 'object') return Object.values(value).flatMap(reasonList)
  return []
}

/** @param {Record<string, any>} row @param {readonly string[]} names */
const firstOf = (row, names) => { for (const name of names) if (row[name] != null) return row[name]; return undefined }

/**
 * A trial-level answer, normalised. `fit` is null when the answer holds no score; `issues` says what was off, and nothing here throws.
 * @param {unknown} raw
 * @returns {{ fit: number | null, confidence: number | null, reasons: { eligible: string[], ineligible: string[], missing: string[], rationale: string }, issues: Array<{ code: string }> }}
 */
export function parseFitAnswer(raw) {
  /** @type {Array<{ code: string }>} */
  const issues = []
  const parsed = looseJson(raw)
  const row = asObject(Array.isArray(parsed) ? parsed[0] : parsed)
  if (!Object.keys(row).length) issues.push({ code: 'answer_unreadable' })
  const score = numberIn(firstOf(row, ['score', 'fit', 'fit_score', 'fitScore', 'match_score', 'matchScore']))
  if (score === null && Object.keys(row).length) issues.push({ code: 'fit_missing' })
  if (score !== null && (score < 0 || score > 100)) issues.push({ code: 'fit_out_of_range' })
  const given = firstOf(row, ['confidence', 'certainty'])
  let confidence = numberIn(given)
  if (confidence !== null) {
    // 80 and "80%" are a share on the other scale.
    if (confidence > 1) confidence /= 100
    if (confidence < 0 || confidence > 1) { issues.push({ code: 'confidence_out_of_range' }); confidence = Math.max(0, Math.min(1, confidence)) }
  } else if (given != null) issues.push({ code: 'confidence_unreadable' })
  return {
    fit: score === null ? null : Math.round(Math.max(0, Math.min(100, score))),
    confidence,
    reasons: {
      eligible: reasonList(firstOf(row, ['eligible_reasons', 'eligibleReasons', 'eligible'])),
      ineligible: reasonList(firstOf(row, ['ineligible_reasons', 'ineligibleReasons', 'ineligible'])),
      missing: reasonList(firstOf(row, ['missing_information', 'missingInformation', 'missing_info', 'missing_reasons', 'missing'])),
      rationale: reasonList(firstOf(row, ['rationale', 'explanation', 'reasoning'])).join(' '),
    },
    issues,
  }
}

const LABEL_WORDS = Object.freeze({
  included: 'included', include: 'included', met: 'included',
  'not included': 'not_included', 'not include': 'not_included', 'not met': 'not_included',
  excluded: 'excluded', exclude: 'excluded',
  'not excluded': 'not_excluded', 'not exclude': 'not_excluded',
  'not applicable': 'not_applicable', na: 'not_applicable', 'n a': 'not_applicable',
  'not enough information': 'not_enough_information', 'not enough info': 'not_enough_information', 'insufficient information': 'not_enough_information',
  unknown: 'not_enough_information',
})

/** What a label says on the other side's clause: an exclusion "included" is met, so the patient is excluded. */
const OTHER_SIDE = Object.freeze({
  inclusion: Object.freeze({ excluded: 'not_included', not_excluded: 'included' }),
  exclusion: Object.freeze({ included: 'excluded', not_included: 'not_excluded' }),
})

/** @param {unknown} value @returns {string | null} */
function labelOf(value) {
  const word = String(value ?? '').toLowerCase().replace(/[^a-z]+/gu, ' ').trim()
  return /** @type {Record<string, string>} */ (LABEL_WORDS)[word] ?? null
}

/** @param {unknown} value @returns {number[]} the ids in whatever way they were written */
function sentenceIdsIn(value) {
  if (value == null) return []
  if (typeof value === 'number') return Number.isInteger(value) ? [value] : []
  if (typeof value === 'string') return [...value.matchAll(/\d+/gu)].map((hit) => Number(hit[0]))
  if (Array.isArray(value)) return value.flatMap(sentenceIdsIn)
  return []
}

/** One clause's answer in either of the two shapes models write it. @param {unknown} value */
function clauseAnswer(value) {
  if (Array.isArray(value)) {
    const label = value.find((entry) => typeof entry === 'string' && labelOf(entry))
    const reason = value.find((entry) => typeof entry === 'string' && entry !== label)
    const ids = value.find((entry) => Array.isArray(entry)) ?? value[1]
    return { reason, ids, label }
  }
  const row = asObject(value)
  return {
    reason: firstOf(row, ['reason', 'reasoning', 'rationale', 'element_1_brief_reasoning', 'element_1']),
    ids: firstOf(row, ['sentenceIds', 'sentence_ids', 'sentence_id', 'sentences', 'ids', 'evidence', 'element_2_sentence_id', 'element_2']),
    label: firstOf(row, ['label', 'eligibility', 'eligibility_label', 'element_3_eligibility_label', 'element_3']),
  }
}

/** The per-clause entries of an answer as [number, value], from a dict keyed by number, a list of rows, or either nested a level down. @param {any} parsed */
function clauseEntries(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((row, index) => {
      const number = numberIn(firstOf(asObject(row), ['number', 'criterion_number', 'criterionNumber', 'criterion', 'id', 'index']))
      return number === null ? (Array.isArray(row) && typeof row[0] === 'number' ? [[row[0], row.slice(1)]] : [[index + 1, row, true]]) : [[number, row]]
    })
  }
  const row = asObject(parsed)
  /** @type {any[]} */
  const out = []
  for (const [key, value] of Object.entries(row)) {
    if (/^\D*\d+\D*$/u.test(key)) out.push([numberIn(key), value])
    else if (value && typeof value === 'object') out.push(...clauseEntries(value))
  }
  return out
}

/**
 * A per-clause answer, normalised, with its evidence resolved by code: each id that exists becomes the sentence's exact text and offsets,
 * an id that does not is dropped and counted and the label stands. `basis` is `stated` when at least one id resolved, otherwise `silent`.
 * A clause the model did not answer, or answered with a word outside the labels, is returned in `missing` and nowhere else.
 * @param {unknown} raw
 * @param {{ criteria: ReadonlyArray<{ number: number, kind: string, text: string, start?: number, end?: number, lead?: string }>, sentences: ReadonlyArray<{ id: number, text: string, start?: number, end?: number, documentId?: string | null }> }} context
 * @returns {{ rows: Array<Record<string, any>>, missing: Array<{ number: number, kind: string, text: string }>, droppedSentenceIds: number, issues: Array<Record<string, any>> }}
 */
export function parseCriteriaAnswer(raw, { criteria, sentences }) {
  /** @type {Array<Record<string, any>>} */
  const issues = []
  const parsed = looseJson(raw)
  if (parsed == null) issues.push({ code: 'answer_unreadable' })
  const clauses = new Map(criteria.map((clause) => [clause.number, clause]))
  const lines = new Map(sentences.map((sentence) => [sentence.id, sentence]))
  /** @type {Map<number, Record<string, any>>} */
  const answered = new Map()
  let droppedSentenceIds = 0
  for (const [number, value, unnumbered] of parsed == null ? [] : clauseEntries(parsed)) {
    const clause = clauses.get(number)
    if (!clause) { issues.push({ code: 'criterion_unknown', number }); continue }
    if (answered.has(number)) { issues.push({ code: 'criterion_repeated', number }); continue }
    if (unnumbered) issues.push({ code: 'criterion_by_position', number })
    const answer = clauseAnswer(value)
    let label = labelOf(answer.label)
    if (!label) { issues.push({ code: 'label_unknown', number }); continue }
    const other = /** @type {Record<string, Record<string, string>>} */ (OTHER_SIDE)[clause.kind]?.[label]
    if (other) { issues.push({ code: 'label_other_side', number }); label = other }
    const evidence = []
    const seen = new Set()
    for (const id of sentenceIdsIn(answer.ids)) {
      if (seen.has(id)) continue
      seen.add(id)
      const sentence = lines.get(id)
      if (!sentence) { droppedSentenceIds += 1; continue }
      evidence.push({ sentenceId: id, text: sentence.text, ...(sentence.start != null ? { start: sentence.start, end: sentence.end } : {}),
        ...(sentence.documentId !== undefined ? { documentId: sentence.documentId } : {}) })
    }
    answered.set(number, { number, kind: clause.kind, clause: clause.text, ...(clause.lead ? { lead: clause.lead } : {}), label,
      reason: reasonList(answer.reason).join(' '), sentenceIds: evidence.map((item) => item.sentenceId), evidence, basis: evidence.length ? 'stated' : 'silent' })
  }
  const rows = criteria.flatMap((clause) => answered.get(clause.number) ?? [])
  const missing = criteria.filter((clause) => !answered.has(clause.number)).map((clause) => ({ number: clause.number, kind: clause.kind, text: clause.text }))
  if (droppedSentenceIds) issues.push({ code: 'sentence_ids_dropped', count: droppedSentenceIds })
  return { rows, missing, droppedSentenceIds, issues }
}

// ---------------------------------------------------------------------------
// What a person reads
// ---------------------------------------------------------------------------

/**
 * A clause's label in plain Chinese. A clause judged with no sentence behind it says so: what the model made of the silence is its
 * judgement, and the words keep that apart from what the note states.
 * @param {{ label?: string | null, basis?: string | null }} row @returns {string}
 */
export function criterionDisplay(row) {
  const silent = row?.basis !== 'stated'
  switch (row?.label) {
    case 'included': return silent ? '未见记载，按符合' : '符合'
    case 'not_included': return silent ? '未见记载，按不符合' : '不符合'
    case 'excluded': return silent ? '未见记载，按排除' : '符合排除条件'
    case 'not_excluded': return silent ? '未见记载，按未排除' : '未符合排除条件'
    case 'not_applicable': return '不适用'
    case 'not_enough_information': return silent ? '未见记载，需确认' : '记载不足，需确认'
    default: return '未判断'
  }
}

/** Whether a clause states a conflict: the note says it, the label is against the patient. @param {{ label?: string, basis?: string }} row */
const statedDisqualifier = (row) => row.basis === 'stated' && (row.label === 'excluded' || row.label === 'not_included')

/**
 * The verdict of one pair, from the trial-level score and the clause rows. A label, not a gate. Each branch:
 *
 * 1. A clause the note states against the patient: `ineligible`, and it says which. Evidence outranks a score.
 * 2. Clause rows and nothing against: everything resolved in the patient's favour is `eligible`; anything left open (not enough information, a
 *    silent clause read against the patient, a clause the model did not answer) is `possible`, because a routine item is settled at
 *    screening, unless a score below 50 says the model found a prerequisite missing, which is `insufficient`.
 * 3. No clause rows, only the score: its bands. A band of 80 and up with something still missing is `possible`.
 * 4. Neither: `insufficient`.
 *
 * @param {{ fit?: number | null, criteria?: ReadonlyArray<{ label?: string, basis?: string, number?: number }> | null, missing?: ReadonlyArray<unknown> | null, missingReasons?: ReadonlyArray<unknown> | null }} input
 * @returns {{ verdict: 'eligible' | 'possible' | 'insufficient' | 'ineligible', label: string, because: string, disqualifiers: number[] }}
 */
export function trialVerdict({ fit = null, criteria = null, missing = null, missingReasons = null }) {
  /** @param {'eligible' | 'possible' | 'insufficient' | 'ineligible'} verdict @param {string} because @param {number[]} [disqualifiers] */
  const said = (verdict, because, disqualifiers = []) => ({ verdict, label: VCR_TRIAL_VERDICT_LABELS_ZH[verdict], because, disqualifiers })
  const rows = criteria ?? []
  const against = rows.filter(statedDisqualifier)
  if (against.length) return said('ineligible', 'stated_disqualifier', against.flatMap((row) => row.number ?? []))
  if (rows.length) {
    const open = rows.filter((row) => row.label === 'not_enough_information' || row.label === 'excluded' || row.label === 'not_included').length + (missing?.length ?? 0)
    if (!open) return said('eligible', 'all_resolved')
    return Number.isFinite(fit) && Number(fit) < VCR_FIT_BANDS.possible ? said('insufficient', 'prerequisite_open') : said('possible', 'items_open')
  }
  if (!Number.isFinite(fit)) return said('insufficient', 'no_judgment')
  const score = Number(fit)
  if (score >= VCR_FIT_BANDS.eligible) return missingReasons?.length ? said('possible', 'fit_with_missing') : said('eligible', 'fit_band')
  if (score >= VCR_FIT_BANDS.possible) return said('possible', 'fit_band')
  if (score >= VCR_FIT_BANDS.insufficient) return said('insufficient', 'fit_band')
  return said('ineligible', 'fit_band')
}

/**
 * Judgments in the order a reader wants them: one with a stated disqualifier after every one without, then by fit, then by confidence, then
 * by id, so the same rows always come back in the same order. A judgment with no score sorts after those with one. Pure; the input is not
 * touched.
 * @template {{ id?: string | number, fit?: number | null, confidence?: number | null, criteria?: ReadonlyArray<{ label?: string, basis?: string }> | null }} T
 * @param {readonly T[]} items @returns {T[]}
 */
export function rankJudgments(items) {
  /** @param {number | null | undefined} value */
  const known = (value) => (Number.isFinite(value) ? Number(value) : -1)
  return [...items].sort((a, b) => {
    const against = Number((a.criteria ?? []).some(statedDisqualifier)) - Number((b.criteria ?? []).some(statedDisqualifier))
    if (against) return against
    const fit = known(b.fit) - known(a.fit)
    if (fit) return fit
    const confidence = known(b.confidence) - known(a.confidence)
    if (confidence) return confidence
    const left = String(a.id ?? ''), right = String(b.id ?? '')
    return left < right ? -1 : left > right ? 1 : 0
  })
}

// ---------------------------------------------------------------------------
// A record too long for one call
// ---------------------------------------------------------------------------

/**
 * A patient's records as the parts one call each can read: whole records while they fit, a longer record at its blank lines, and only then
 * at sentences, so a part never ends inside a sentence. A single sentence longer than the cap is a part by itself, over the cap, and never
 * cut. Sentence ids are the caller's and survive the split.
 * @param {ReadonlyArray<{ text: string, sentences: ReadonlyArray<{ id: number, start: number, end: number, text: string }>, documentId?: string | null }>} records
 * @param {number} cap characters of one part
 * @returns {Array<{ text: string, sentences: Array<any> }>}
 */
export function splitNoteParts(records, cap) {
  /** @type {Array<{ text: string, sentences: Array<any> }>} */
  const parts = []
  /** @type {{ pieces: string[], sentences: any[], chars: number }} */
  let current = { pieces: [], sentences: [], chars: 0 }
  const flush = () => {
    if (current.pieces.length) parts.push({ text: current.pieces.join('\n\n'), sentences: current.sentences })
    current = { pieces: [], sentences: [], chars: 0 }
  }
  /** @param {string} text @param {any[]} sentences */
  const add = (text, sentences) => {
    if (current.chars && current.chars + text.length + 2 > cap) flush()
    current.pieces.push(text)
    current.sentences.push(...sentences)
    current.chars += text.length + 2
  }
  for (const record of records) {
    if (record.text.length <= cap) { add(record.text, [...record.sentences]); continue }
    // The record's blank lines divide it where it divides itself; each block is then held whole if it can be, and cut at sentences if not.
    /** @type {Array<any[]>} */
    const blocks = []
    let previous = -1
    for (const sentence of record.sentences) {
      const gap = previous < 0 ? '' : record.text.slice(previous, sentence.start)
      if (previous < 0 || /\n\s*\n/u.test(gap)) blocks.push([])
      blocks[blocks.length - 1].push(sentence)
      previous = sentence.end
    }
    for (const block of blocks) {
      const text = record.text.slice(block[0].start, block[block.length - 1].end)
      if (text.length <= cap) { add(text, block); continue }
      let run = []
      let from = block[0].start
      for (const sentence of block) {
        if (run.length && sentence.end - from > cap) {
          add(record.text.slice(from, run[run.length - 1].end), run)
          run = []
          from = sentence.start
        }
        run.push(sentence)
      }
      if (run.length) add(record.text.slice(from, run[run.length - 1].end), run)
    }
  }
  flush()
  return parts
}

/**
 * The trial-level answers of a long record's parts as one: a part that states a conflict is the most specific thing known (the lowest score
 * among those); otherwise the part that found the most (the highest score). What the other parts found to the patient's favour and against
 * is kept; what is missing is what the chosen part still misses, because another part may have said it.
 * @param {ReadonlyArray<ReturnType<typeof parseFitAnswer>>} answers @returns {ReturnType<typeof parseFitAnswer>}
 */
export function mergeFitAnswers(answers) {
  if (answers.length <= 1) return answers[0]
  const scored = answers.filter((answer) => answer.fit !== null)
  if (!scored.length) return answers[0]
  const conflict = scored.filter((answer) => answer.reasons.ineligible.length)
  const chosen = conflict.length
    ? conflict.reduce((low, answer) => (Number(answer.fit) < Number(low.fit) ? answer : low))
    : scored.reduce((high, answer) => (Number(answer.fit) > Number(high.fit) ? answer : high))
  return {
    ...chosen,
    reasons: {
      eligible: [...new Set(scored.flatMap((answer) => answer.reasons.eligible))],
      ineligible: [...new Set(scored.flatMap((answer) => answer.reasons.ineligible))],
      missing: chosen.reasons.missing,
      rationale: chosen.reasons.rationale,
    },
    issues: answers.flatMap((answer) => answer.issues),
  }
}

/** How specific a clause row is, across a long record's parts. @param {{ label: string, basis: string }} row */
function specificity(row) {
  if (row.basis === 'stated') {
    if (row.label === 'excluded' || row.label === 'not_included') return 6
    if (row.label === 'included' || row.label === 'not_excluded') return 5
    return row.label === 'not_applicable' ? 4 : 3
  }
  return row.label === 'not_enough_information' ? 1 : 2
}

/**
 * The per-clause answers of a long record's parts as one: for each clause the most specific row of any part, where a statement against the
 * patient outranks one for them, a statement outranks silence, and a judgement of the silence outranks "not enough information". A clause
 * is missing only if every part left it out.
 * @param {ReadonlyArray<ReturnType<typeof parseCriteriaAnswer>>} answers @returns {ReturnType<typeof parseCriteriaAnswer>}
 */
export function mergeCriteriaAnswers(answers) {
  if (answers.length <= 1) return answers[0]
  /** @type {Map<number, Record<string, any>>} */
  const best = new Map()
  for (const answer of answers) {
    for (const row of answer.rows) {
      const held = best.get(row.number)
      if (!held || specificity(/** @type {any} */ (row)) > specificity(/** @type {any} */ (held))) best.set(row.number, row)
    }
  }
  const missing = answers[0].missing.filter((clause) => !best.has(clause.number))
  const order = [...best.keys()].sort((a, b) => a - b)
  return {
    rows: order.map((number) => /** @type {Record<string, any>} */ (best.get(number))),
    missing,
    droppedSentenceIds: answers.reduce((sum, answer) => sum + answer.droppedSentenceIds, 0),
    issues: answers.flatMap((answer) => answer.issues),
  }
}
