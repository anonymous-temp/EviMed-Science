/**
 * The pills on a blank conversation: what a person may ask, general first and two medical last.
 *
 * Hidden knowledge: these are the only entrance to the assistant's general abilities that is written down as sentences.
 * Documents, spreadsheets, slides, data analysis, web research and code are not capability packages — they are what the base
 * conversation does with the office skills, the web tools and the workspace — so they have no card on 科研工具 (that page is
 * the medical professional workflows and nothing else; owner, 2026-10-14) and nothing to bind: a pill puts a sentence in the
 * composer the person can change before sending. Putting these as starter prompts on a capability would bind the
 * conversation to a medical contract, which is the failure the base conversation exists to avoid.
 *
 * The medical examples are the capabilities' own starter prompts, kept short enough to read as a pill.
 *
 * It lived in `generalTools.mjs` beside a six-card group for the tools page (2026-10-13 to 2026-10-14); the group is gone and
 * the pills stay.
 *
 * @module @evimed/domain/src/blankExamples
 */

/**
 * @typedef {object} BlankExample
 * @property {string} label the short name on the pill
 * @property {string} draft the whole sentence that goes into the composer, never sent
 */

/** The pills on a blank conversation: general first, then two medical. @type {readonly Readonly<BlankExample>[]} */
export const BLANK_EXAMPLES = Object.freeze([
  { label: '整理会议纪要', draft: '把下面的会议纪要整理成一份 Word：标题、与会人、三条决议、待办表（负责人和截止日期）。' },
  { label: '做预算表', draft: '做一张 12 个月的预算表：收入、三项成本、利润用公式，最后一行合计。' },
  { label: '做演示稿', draft: '做一个 10 页的商业计划 PPT：市场、产品、商业模式、竞争、团队、财务预测、融资需求。' },
  { label: '调研对比', draft: '调研国内三家云厂商的对象存储定价，做成对比表，附官网链接。' },
  { label: '临床证据问答', draft: 'SGLT2 抑制剂在 eGFR 低于 30 的患者中还有肾脏获益吗？' },
  { label: '药品安全信号', draft: '比较阿托伐他汀与瑞舒伐他汀的肝损伤报告信号。' },
])
