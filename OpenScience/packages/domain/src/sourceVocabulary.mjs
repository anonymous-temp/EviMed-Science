/**
 * What a document in the knowledge base is, said once.
 *
 * Hidden knowledge: until 2026-10-07 two lists named the types of a source —
 * the control plane's twenty-two (a medical researcher's filing cabinet, with
 * recordings the upload refuses) and the analysis layer's twenty-two under
 * other ids — and a third, the browser's, grouped files by extension and called
 * every PDF 「文献」. The knowledge base is what a researcher hands EviMed to
 * read: papers, guidelines, protocols, tables, but also a hospital's rules, a
 * drug label, a contract, a web page, a note. So the vocabulary is one table:
 * each type's id, its Chinese name, the chip it is counted under on the page
 * (`kind`), and the understanding schema its slots come from (`schema`).
 *
 * Two decisions live here and nowhere else:
 *
 * - **The first pass knows only the format.** Before anyone has read a word, a
 *   PDF is a `document`, a spreadsheet a `dataset`, a page a `webpage`
 *   (`sourceFirstPassType`). Nothing in a file name decides what a document is
 *   (principle 5: no regex over open vocabulary). After the text is read, the
 *   judge (J7) names the type from this table; a judge that fails leaves the
 *   first pass standing, which reads with the general schema.
 * - **Only a paper is read as a paper.** The paper slots (design, population,
 *   intervention, outcomes, effect, DOI) belong to `published-paper` and
 *   `preprint-manuscript`; every other type has purpose, key information and
 *   limitations (or its own procedure / notes slots). A slot that does not
 *   belong to a type is never offered, so it is never shown as 「尚不明确」.
 *
 * Browser-safe and pure: the server, the capability contract and the page
 * read the same table.
 *
 * @module @evimed/domain/source-vocabulary
 */

import { sourceFileFormat } from './sourceDocuments.mjs'

/**
 * The chips the knowledge base page groups documents under, in the order it
 * shows them. A document is counted under exactly one.
 */
export const SOURCE_KINDS = Object.freeze([
  { id: 'literature', label: '文献与指南' },
  { id: 'table', label: '数据表' },
  { id: 'document', label: '文档' },
  { id: 'page', label: '网页' },
  { id: 'note', label: '笔记' },
  { id: 'image', label: '图片' },
].map((kind) => Object.freeze(kind)))

/** @typedef {'literature' | 'table' | 'document' | 'page' | 'note' | 'image'} SourceKind */
/** @typedef {'paper' | 'procedure' | 'notes' | 'general'} SourceSchemaId */

/**
 * Every type a document can be: its name (`label`, what the judge's choice and
 * a menu say) and the short name a row's meta line uses (`short`), the chip it
 * is counted under, the
 * understanding schema its slots come from, and whether reading it deserves
 * the deep pass (a procedure or a review decomposes into finer statements).
 *
 * The ids that existed before 2026-10-07 keep their spelling: they are on
 * stored sources, in the evolution ledger and in the capsule. Two older ones
 * are not here — `audio-recording` and `video-recording` — because the knowledge
 * base refuses recordings; a stored source that still carries one is read as
 * 「其他」 (`sourceDocTypeLabel`).
 */
export const SOURCE_DOC_TYPES = Object.freeze([
  { id: 'published-paper', label: '已发表论文', short: '论文', kind: 'literature', schema: 'paper', deep: false },
  { id: 'preprint-manuscript', label: '手稿或预印本', short: '预印本', kind: 'literature', schema: 'paper', deep: false },
  { id: 'review-guideline', label: '综述或指南', short: '综述或指南', kind: 'literature', schema: 'general', deep: false },
  { id: 'book-chapter', label: '书籍章节', short: '书籍章节', kind: 'literature', schema: 'general', deep: false },
  { id: 'conference-material', label: '会议材料', short: '会议材料', kind: 'literature', schema: 'general', deep: false },
  { id: 'grant-proposal', label: '标书或课题申请', short: '标书', kind: 'document', schema: 'procedure', deep: true },
  { id: 'research-protocol', label: '研究方案、SOP 或检查表', short: '研究方案', kind: 'document', schema: 'procedure', deep: true },
  { id: 'peer-review', label: '审稿意见', short: '审稿意见', kind: 'document', schema: 'general', deep: true },
  { id: 'medical-case', label: '医案', short: '医案', kind: 'document', schema: 'general', deep: false },
  { id: 'patient-record', label: '病例或病历', short: '病历', kind: 'document', schema: 'general', deep: false },
  { id: 'policy-document', label: '制度或规范文件', short: '制度文件', kind: 'document', schema: 'general', deep: false },
  { id: 'drug-label', label: '药品说明书', short: '药品说明书', kind: 'document', schema: 'general', deep: false },
  { id: 'administrative-record', label: '合同或行政文件', short: '合同或行政文件', kind: 'document', schema: 'general', deep: false },
  { id: 'lecture-slides', label: '幻灯片或讲义', short: '幻灯片', kind: 'document', schema: 'general', deep: false },
  { id: 'course-bundle', label: '课程包', short: '课程包', kind: 'document', schema: 'general', deep: false },
  { id: 'message-export', label: '邮件或聊天导出', short: '邮件或聊天', kind: 'document', schema: 'notes', deep: false },
  { id: 'code', label: '代码', short: '代码', kind: 'document', schema: 'general', deep: false },
  { id: 'document', label: '文档', short: '文档', kind: 'document', schema: 'general', deep: false },
  { id: 'cohort-data', label: '队列数据或数据字典', short: '队列数据', kind: 'table', schema: 'general', deep: false },
  { id: 'statistical-output', label: '统计输出', short: '统计输出', kind: 'table', schema: 'general', deep: false },
  { id: 'dataset', label: '数据表', short: '数据表', kind: 'table', schema: 'general', deep: false },
  { id: 'webpage', label: '网页', short: '网页', kind: 'page', schema: 'general', deep: false },
  { id: 'note-memo', label: '笔记或备忘', short: '笔记', kind: 'note', schema: 'notes', deep: false },
  { id: 'certificate-scan', label: '证书或扫描件', short: '扫描件', kind: 'image', schema: 'general', deep: false },
  { id: 'image-figure', label: '图片或图表', short: '图片', kind: 'image', schema: 'general', deep: false },
  { id: 'other', label: '其他', short: '文档', kind: 'document', schema: 'general', deep: false },
].map((type) => Object.freeze(type)))

/** The ids, in the table's order: what the judge chooses among and what an override may name. */
export const SOURCE_TYPES = Object.freeze(SOURCE_DOC_TYPES.map((type) => type.id))

/** @type {ReadonlyMap<string, (typeof SOURCE_DOC_TYPES)[number]>} */
const BY_ID = new Map(SOURCE_DOC_TYPES.map((type) => [type.id, type]))

/**
 * The understanding schema ids and the types each one reads. `general` has no
 * list: it is what every other type, and any id this table does not know,
 * falls to.
 * @param {SourceSchemaId} schema
 * @returns {readonly string[]}
 */
export function sourceDocTypesOfSchema(schema) {
  return SOURCE_DOC_TYPES.filter((type) => type.schema === schema).map((type) => type.id)
}

/** The Chinese name of a type: an id this table does not know reads as 「其他」, never as the id. @param {unknown} docType */
export function sourceDocTypeLabel(docType) {
  return BY_ID.get(String(docType))?.label ?? '其他'
}

/** The short name a row's meta line carries (「指南 · 18 页 · 上传」); an id this table does not know reads as 「文档」. @param {unknown} docType */
export function sourceDocTypeShort(docType) {
  return BY_ID.get(String(docType))?.short ?? '文档'
}

/**
 * The chip a document is counted under. An id this table does not know (a
 * recording type a stored source still carries) is a 「文档」.
 * @param {unknown} docType @returns {SourceKind}
 */
export function sourceKindOf(docType) {
  return /** @type {SourceKind} */ (BY_ID.get(String(docType))?.kind ?? 'document')
}

/** @param {unknown} kind @returns {string} */
export function sourceKindLabel(kind) {
  return SOURCE_KINDS.find((entry) => entry.id === kind)?.label ?? '文档'
}

/** Whether reading this type deserves the deep pass. @param {unknown} docType */
export function sourceDocTypeIsDeep(docType) {
  return BY_ID.get(String(docType))?.deep === true
}

/**
 * Where a document lives in the project's knowledge base, by folder. These are
 * folders the platform itself writes (a closed list, not a reading of file
 * names): 「添加网页链接」 writes `links/`, 「新建笔记」 `notes/`, 「存入知识库」
 * from a conversation `chat/`, the frontier feed `frontier/` and `evidence/`,
 * and a run's hand-off of what it preserved `open-access/`.
 */
export const SOURCE_FOLDERS = Object.freeze({
  root: 'knowledge-base',
  links: 'knowledge-base/links',
  notes: 'knowledge-base/notes',
  chat: 'knowledge-base/chat',
  frontier: 'knowledge-base/frontier',
  evidence: 'knowledge-base/evidence',
  openAccess: 'knowledge-base/open-access',
  /** The original bytes of a page a link read, kept beside its text snapshot and never a source of its own. */
  snapshots: 'knowledge-base/.evimed-snapshots',
})

/** Where a document came from, as a row says it. */
export const SOURCE_ORIGINS = Object.freeze([
  { id: 'upload', label: '上传' },
  { id: 'drive', label: '网盘' },
  { id: 'link', label: '链接' },
  { id: 'note', label: '笔记' },
  { id: 'frontier', label: '前沿动态' },
  { id: 'conversation', label: '对话产出' },
].map((origin) => Object.freeze(origin)))

/** @typedef {'upload' | 'drive' | 'link' | 'note' | 'frontier' | 'conversation'} SourceOrigin */

/** @param {unknown} origin */
export function sourceOriginLabel(origin) {
  return SOURCE_ORIGINS.find((entry) => entry.id === origin)?.label ?? '上传'
}

/**
 * Where a source came from, read off where it lives: the connector a drive
 * import registered under, else the platform folder its path is in, else an
 * upload. Nothing is read from a file's name.
 * @param {{ connectorType?: unknown, path?: unknown }} source
 * @returns {SourceOrigin}
 */
export function sourceOriginOf({ connectorType, path }) {
  if (connectorType === 'openlist') return 'drive'
  const file = String(path ?? '').replaceAll('\\', '/')
  const inside = (/** @type {string} */ folder) => file.startsWith(`${folder}/`)
  if (inside(SOURCE_FOLDERS.links)) return 'link'
  if (inside(SOURCE_FOLDERS.notes)) return 'note'
  if (inside(SOURCE_FOLDERS.frontier) || inside(SOURCE_FOLDERS.evidence)) return 'frontier'
  if (inside(SOURCE_FOLDERS.chat) || inside(SOURCE_FOLDERS.openAccess)) return 'conversation'
  return 'upload'
}

/** Formats read as an image, a table, a presentation or a page — the whole of the first pass. */
const IMAGE_FORMATS = Object.freeze(['jpg', 'jpeg', 'png', 'bmp', 'gif'])
const TABLE_FORMATS = Object.freeze(['csv', 'tsv', 'xls', 'xlsx', 'xlsm'])
const SLIDE_FORMATS = Object.freeze(['ppt', 'pptx'])
const PAGE_FORMATS = Object.freeze(['htm', 'html', 'xml'])
const CODE_FORMATS = Object.freeze(['r', 'py', 'sql', 'json', 'yaml', 'yml'])

/**
 * The first guess at what a file is, from its format and the platform folder
 * it was written to — and nothing else. Nobody has read it yet; the judge
 * decides what it is once the text is in (`SOURCE_DOC_TYPES`), and a document
 * that is never judged is simply what its format says it is.
 *
 * Images are only indexed; every other format is read and understood
 * (`structured`). The depth is the reading's, not the document's worth.
 *
 * @param {string} file the registered path, relative to the project's base folder
 * @returns {{ docType: string, depth: 'index_only' | 'structured', reason: string }}
 */
export function sourceFirstPassType(file) {
  const origin = sourceOriginOf({ path: file })
  const format = sourceFileFormat(file)
  if (origin === 'note') return { docType: 'note-memo', depth: 'structured', reason: 'A note written in the knowledge base.' }
  // A link's own text snapshot is a page; a PDF it kept is read as the document it is.
  if (origin === 'link' && ['md', 'txt', 'htm', 'html'].includes(format)) return { docType: 'webpage', depth: 'structured', reason: 'A web page saved as a snapshot.' }
  if (IMAGE_FORMATS.includes(format)) return { docType: 'image-figure', depth: 'index_only', reason: 'The image is indexed before optional visual extraction.' }
  if (TABLE_FORMATS.includes(format)) return { docType: 'dataset', depth: 'structured', reason: 'The tabular format is profiled as a table.' }
  if (SLIDE_FORMATS.includes(format)) return { docType: 'lecture-slides', depth: 'structured', reason: 'The presentation format is read slide by slide.' }
  if (PAGE_FORMATS.includes(format)) return { docType: 'webpage', depth: 'structured', reason: 'The markup format is read as a web page.' }
  if (CODE_FORMATS.includes(format)) return { docType: 'code', depth: 'structured', reason: 'The file is source code or a structured text file.' }
  return { docType: 'document', depth: 'structured', reason: 'The document format is parsed into traceable units.' }
}
