/**
 * The two document operations of the contained document tools, as data.
 *
 * Hidden knowledge: this is the one description of what `doc_read` and
 * `doc_write` accept. The bridge builds the tool's parameter schema and its
 * help text from it (`coworkToolSpecs`), the generated skill-package table
 * carries it as the extension's supported operations, and
 * `scripts/ops/test/coworkOperationSchema.test.mjs` holds it against the policy
 * that enforces the same limits inside the isolated image
 * (`scripts/runtime/extensions/cowork/policy.mjs`). The bridge used to tell the
 * model that `options` and `spec` were "an object" and nothing else, while the
 * policy refused every key but a handful and bounded each one: a model could
 * only learn the limits by spending calls on refusals.
 *
 * The policy is not edited to read this file: it runs inside an admitted image
 * whose digest binds its bytes. The test is what keeps the two equal — it
 * derives its boundary cases from this schema, so a limit that moves on one side
 * is a red test and not a stale help line.
 *
 * Plain data, no imports: the generator and the bridge both read it, and it must
 * load where the harness port does not.
 *
 * @module @evimed/dsh-socket/extensions/cowork/operations
 */

/** The bounds the policy enforces, named once. */
export const COWORK_LIMITS = Object.freeze({
  idPattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$',
  pages: Object.freeze({ min: 1, max: 5 }),
  page: Object.freeze({ min: 1, max: 100000 }),
  rowOffset: Object.freeze({ min: 1, max: 100000 }),
  rows: Object.freeze({ min: 1, max: 100 }),
  cell: Object.freeze({ min: 0, max: 100000 }),
  cells: Object.freeze({ min: 1, max: 100 }),
  sheetsRead: 1,
  sheetNameChars: 31,
  sheetsWrite: 4,
  cellsWrite: 1000,
  notebookCells: 100,
  cellTextBytes: 8192,
  requestBytes: 65536,
})

/** @type {readonly Record<string, any>[]} */
export const COWORK_OPERATIONS = Object.freeze([
  {
    name: 'doc_read',
    kind: 'tool',
    summary: 'Inspect a permitted document resource in bounded windows.',
    summaryZh: '分页或按单元格查看一个已授权的文档资源。',
    accepts: ['xlsx', 'ipynb', 'docx', 'pdf'],
    produces: ['一个有大小上限的文本窗口'],
    limits: [`每次最多 ${COWORK_LIMITS.pages.max} 页、${COWORK_LIMITS.rows.max} 行、${COWORK_LIMITS.cells.max} 个单元格`, '只读，不执行任何内容', '只接受已授权资源的编号，不接受路径'],
    params: [
      { name: 'resourceId', type: 'string', required: true, description: '已授权资源的编号' },
      { name: 'options.page', type: 'integer', min: COWORK_LIMITS.page.min, max: COWORK_LIMITS.page.max },
      { name: 'options.pages', type: 'integer', min: COWORK_LIMITS.pages.min, max: COWORK_LIMITS.pages.max, unit: '页' },
      { name: 'options.sheets', type: 'array', description: `工作表名，最多 ${COWORK_LIMITS.sheetsRead} 个，每个不超过 ${COWORK_LIMITS.sheetNameChars} 个字符` },
      { name: 'options.rowOffset', type: 'integer', min: COWORK_LIMITS.rowOffset.min, max: COWORK_LIMITS.rowOffset.max },
      { name: 'options.rows', type: 'integer', min: COWORK_LIMITS.rows.min, max: COWORK_LIMITS.rows.max, unit: '行' },
      { name: 'options.cell', type: 'integer', min: COWORK_LIMITS.cell.min, max: COWORK_LIMITS.cell.max },
      { name: 'options.cells', type: 'integer', min: COWORK_LIMITS.cells.min, max: COWORK_LIMITS.cells.max, unit: '个' },
    ],
  },
  {
    name: 'doc_write',
    kind: 'tool',
    summary: 'Create a new permitted XLSX workbook or inert notebook.',
    summaryZh: '新建一个 XLSX 工作簿或不会被执行的笔记本。',
    accepts: ['JSON spec'],
    produces: ['xlsx', 'ipynb'],
    limits: [
      `工作表最多 ${COWORK_LIMITS.sheetsWrite} 个，单元格合计最多 ${COWORK_LIMITS.cellsWrite} 个`,
      `笔记本单元格最多 ${COWORK_LIMITS.notebookCells} 个，每个文本不超过 ${COWORK_LIMITS.cellTextBytes} 字节`,
      '只新建，不改已有文件；不生成 DOCX 或 PDF；不执行笔记本代码；单元格里没有公式、链接或宏',
    ],
    params: [
      { name: 'targetId', type: 'string', required: true, description: '新文档的编号' },
      { name: 'format', type: 'string', required: true, values: ['xlsx', 'ipynb'] },
      { name: 'spec.kind', type: 'string', required: true, values: ['create'] },
      { name: 'spec.sheets', type: 'array', required: true, when: { param: 'format', equals: 'xlsx' }, description: '每项为 {name, cells}；name 不超过 31 个字符且不含 \\ / * ? : [ ]；cells 每项为 {ref, value}，ref 形如 A1，值为文本、数值、布尔或空' },
      { name: 'spec.cells', type: 'array', required: true, when: { param: 'format', equals: 'ipynb' }, description: '每项为 {type, source}，type 为 markdown、code 或 raw' },
    ],
  },
])

/**
 * The tool parameter schema a harness `defineTool` takes, from an operation's
 * params: top-level names become keys, a dotted name becomes a property of its
 * parent object, and each carries its generated description (type, range and
 * default are the schema's, written by `describeParam`).
 *
 * @param {Record<string, any>} operation
 * @param {(param: Record<string, any>) => string} describeParam
 * @returns {Record<string, any>}
 */
export function toolParameters(operation, describeParam) {
  /** @type {Record<string, any>} */ const parameters = {}
  for (const param of operation.params) {
    const [head, ...rest] = String(param.name).split('.')
    const leaf = {
      type: param.type === 'path' ? 'string' : param.type,
      ...(param.values ? { enum: [...param.values] } : {}),
      description: describeParam(param),
    }
    if (!rest.length) {
      parameters[head] = { ...leaf, ...(param.required && !param.when ? { required: true } : {}) }
      continue
    }
    const parent = parameters[head] ?? { type: 'object', properties: {}, additionalProperties: false }
    parent.properties[rest.join('.')] = leaf
    if (param.required && !param.when) parent.required = true
    parameters[head] = parent
  }
  return parameters
}
