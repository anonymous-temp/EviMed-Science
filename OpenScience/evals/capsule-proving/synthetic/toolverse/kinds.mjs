/**
 * The closed vocabulary of value kinds a tool parameter or output field can carry, with a seeded generator per kind.
 * `gap: true` marks kinds a person would plausibly state once and expect to be remembered (the L8 information-gap
 * tasks remove only these). `label` is the plain description handed to the generator model for the request wording.
 * @module capsule-proving/synthetic/toolverse/kinds
 */
import { digits, hex, int, pick } from './rng.mjs';

const r2 = (x) => Math.round(x * 100) / 100;
const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma', 'kappa', 'theta'];
export const KINDS = {
  // ---- EviMed research tools ----
  pmid: { type: 'string', gen: (g) => digits(g, 8), label: 'a PubMed id' },
  doi: { type: 'string', gen: (g) => `10.${int(g, 1000, 9999)}/${hex(g, 6)}`, label: 'a DOI' },
  pmcid: { type: 'string', gen: (g) => `PMC${digits(g, 7)}`, label: 'a PMC id' },
  nctId: { type: 'string', gen: (g) => `NCT${digits(g, 8)}`, label: 'a ClinicalTrials.gov id' },
  sourceId: { type: 'string', derived: true, gen: (g) => `src_${hex(g, 12)}`, label: 'a preserved source id' },
  rxcui: { type: 'string', gen: (g) => digits(g, 5), label: 'an RxNorm id' },
  setid: { type: 'string', derived: true, gen: (g) => `${hex(g, 8)}-${hex(g, 4)}-${hex(g, 4)}-${hex(g, 12)}`, label: 'a label set id' },
  labelId: { type: 'string', derived: true, gen: (g) => `LBL-${digits(g, 6)}`, label: 'a drug label id' },
  gseAccession: { type: 'string', gen: (g) => `GSE${digits(g, 5)}`, label: 'a GEO series accession', gap: false },
  captureDir: { type: 'string', derived: true, gen: (g) => `/workspace/captures/GSE${digits(g, 5)}`, label: 'a preserved capture directory' },
  drugName: { type: 'string', gen: (g) => pick(g, ['metformin', 'atorvastatin', 'amlodipine', 'omeprazole', 'warfarin', 'levothyroxine', 'sertraline', 'rivaroxaban', 'empagliflozin', 'ibuprofen']), gap: true, label: 'a drug name' },
  adverseEvent: { type: 'string', gen: (g) => pick(g, ['hepatotoxicity', 'rhabdomyolysis', 'angioedema', 'QT prolongation', 'lactic acidosis', 'gastrointestinal bleeding']), gap: true, label: 'an adverse event term' },
  searchQuery: { type: 'string', gen: (g) => pick(g, ['SGLT2 inhibitors heart failure outcomes', 'statin therapy older adults primary prevention', 'direct oral anticoagulants renal impairment', 'GLP-1 agonists weight loss maintenance', 'proton pump inhibitors long-term risk', 'metformin cancer incidence cohort']), label: 'a search query' },
  jurisdiction: { type: 'string', gen: (g) => pick(g, ['US', 'CN', 'EU', 'JP']), gap: true, label: 'a jurisdiction code' },
  recruitmentStatus: { type: 'string', gen: (g) => pick(g, ['RECRUITING', 'COMPLETED', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING']), gap: true, label: 'a trial recruitment status' },
  dateFrom: { type: 'string', gen: (g) => `20${int(g, 18, 24)}-${String(int(g, 1, 12)).padStart(2, '0')}-01`, gap: true, label: 'a start date (YYYY-MM-DD)' },
  outputDir: { type: 'string', gen: (g) => `outputs/${pick(g, words)}-${int(g, 10, 99)}`, gap: true, label: 'an output directory' },
  guidelineTitle: { type: 'string', gen: (g) => `${pick(g, ['ESC', 'ADA', 'ACC/AHA', 'KDIGO'])} ${int(g, 2019, 2025)} ${pick(g, ['guideline', 'consensus'])}`, label: 'a guideline title' },
  groupLabels: { type: 'string[]', gen: (g) => [pick(g, ['tumor', 'treated', 'disease']), pick(g, ['normal', 'control', 'healthy'])], label: 'two sample group labels' },
  // ---- generic values ----
  city: { type: 'string', gen: (g) => pick(g, ['北京', '上海', '杭州', '成都', '广州', '武汉', '西安', '南京']), gap: true, label: 'a city' },
  lat: { type: 'number', gen: (g) => r2(20 + g() * 25), label: 'a latitude' },
  lon: { type: 'number', gen: (g) => r2(100 + g() * 20), label: 'a longitude' },
  date: { type: 'string', gen: (g) => `2026-${String(int(g, 1, 12)).padStart(2, '0')}-${String(int(g, 1, 28)).padStart(2, '0')}`, gap: true, label: 'a calendar date (YYYY-MM-DD)' },
  days: { type: 'integer', gen: (g) => int(g, 3, 45), label: 'a number of days' },
  month: { type: 'string', gen: (g) => `2026-${String(int(g, 1, 12)).padStart(2, '0')}`, gap: true, label: 'a month (YYYY-MM)' },
  eventId: { type: 'string', derived: true, gen: (g) => `evt_${hex(g, 8)}`, label: 'a calendar event id' },
  eventTitle: { type: 'string', gen: (g) => pick(g, ['组会', '项目评审', '预算讨论', '导师面谈', '设备验收']), label: 'an event title' },
  email: { type: 'string', gen: (g) => `${pick(g, ['liming', 'zhangwei', 'wangfang', 'chenjie'])}${int(g, 1, 99)}@example.org`, gap: true, label: 'an e-mail address' },
  contactName: { type: 'string', gen: (g) => pick(g, ['李明', '张伟', '王芳', '陈洁', '刘洋']), gap: true, label: 'a contact name' },
  phone: { type: 'string', gen: (g) => `1${int(g, 3, 9)}${digits(g, 9)}`, label: 'a phone number' },
  messageId: { type: 'string', derived: true, gen: (g) => `msg_${hex(g, 10)}`, label: 'a mail message id' },
  currency: { type: 'string', gen: (g) => pick(g, ['CNY', 'USD', 'EUR', 'JPY', 'GBP']), gap: true, label: 'a currency code' },
  amount: { type: 'number', gen: (g) => int(g, 120, 98000), label: 'a money amount' },
  rate: { type: 'number', gen: (g) => r2(0.1 + g() * 8), label: 'an exchange rate' },
  lengthUnit: { type: 'string', gen: (g) => pick(g, ['cm', 'inch', 'm', 'ft', 'km', 'mile']), gap: true, label: 'a length unit' },
  massUnit: { type: 'string', gen: (g) => pick(g, ['kg', 'lb', 'g', 'oz']), gap: true, label: 'a mass unit' },
  quantity: { type: 'number', gen: (g) => int(g, 2, 900), label: 'a plain quantity' },
  filePath: { type: 'string', gen: (g) => `docs/${pick(g, words)}-${int(g, 10, 99)}.${pick(g, ['txt', 'md', 'csv'])}`, label: 'a file path' },
  dirPath: { type: 'string', gen: (g) => `docs/${pick(g, words)}`, gap: true, label: 'a folder path' },
  tableId: { type: 'string', derived: true, gen: (g) => `tbl_${hex(g, 6)}`, label: 'a loaded table id' },
  columnName: { type: 'string', gen: (g) => pick(g, ['amount', 'department', 'status', 'score', 'region']), gap: true, label: 'a table column name' },
  filterValue: { type: 'string', gen: (g) => pick(g, ['finance', 'approved', 'north', 'pending', 'research']), gap: true, label: 'a cell value to filter on' },
  reportId: { type: 'string', derived: true, gen: (g) => `rpt_${hex(g, 6)}`, label: 'a report id' },
  url: { type: 'string', gen: (g) => `https://www.${pick(g, words)}-${int(g, 10, 99)}.example.org/${pick(g, ['a', 'b', 'c'])}${int(g, 100, 999)}`, label: 'a web address' },
  text: { type: 'string', gen: (g) => pick(g, ['会议改到下午三点', '请先确认预算再继续', '样本量需要再核对一次', '本周五前完成初稿', '实验记录已经归档', '价格以最新报价为准', '这一批数据存在缺失值', '下次讨论安排在月底', '设备已经通过验收', '结论需要补充对照组']), label: 'a short text' },
  quoteText: { type: 'string', gen: (g) => pick(g, ['hazard ratio', 'intention-to-treat', 'adverse events', 'primary endpoint', 'median follow-up', 'baseline characteristics', 'randomized controlled trial']), label: 'a phrase quoted from a paper' },
  language: { type: 'string', gen: (g) => pick(g, ['en', 'zh', 'ja', 'fr']), gap: true, label: 'a language code' },
  temperature: { type: 'number', gen: (g) => r2(-5 + g() * 38), label: 'a temperature in Celsius' },
  condition: { type: 'string', gen: (g) => pick(g, ['sunny', 'rain', 'cloudy', 'snow']), label: 'a weather condition' },
  count: { type: 'integer', gen: (g) => int(g, 2, 480), label: 'a count' },
  score: { type: 'number', gen: (g) => r2(0.5 + g() * 9), label: 'a score' },
  boolean: { type: 'boolean', gen: (g) => g() < 0.5, label: 'a flag' },
};
/** Kinds only a tool can produce (handles, ids); a tool needing one cannot start a chain. */
export const DERIVED_KINDS = new Set(Object.keys(KINDS).filter((k) => KINDS[k].derived));
export const GAP_KINDS = Object.keys(KINDS).filter((k) => KINDS[k].gap);
