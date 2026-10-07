/**
 * Batch screening: the parts that are decisions rather than plumbing.
 *
 * @module @evimed/dsh-socket/src/screening
 */

/** What a screening child answers with. Fixed, so the ledger is one shape. */
export const SCREEN_VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'decision', 'reason'],
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['include', 'exclude', 'unclear'] },
          reason: { type: 'string' },
          criterion: { type: 'string' },
        },
      },
    },
  },
})

/**
 * @template T
 * @param {readonly T[]} items @param {number} size
 * @returns {T[][]}
 */
export function chunk(items, size) {
  const width = Math.max(1, Math.floor(size) || 1)
  /** @type {T[][]} */
  const out = []
  for (let index = 0; index < items.length; index += width) out.push(items.slice(index, index + width))
  return out
}

/**
 * The prompt one screening child gets.
 *
 * Missing abstract details advance to full-text review. `unclear` remains a
 * separate answer for unreadable records or failed assessments, never an
 * implicit exclusion.
 *
 * @param {string} criteria @param {readonly Record<string, any>[]} records
 * @returns {string}
 */
export function screeningPrompt(criteria, records) {
  return [
    '按下面的标准逐条判断这些记录，只判断给你的这些，不要检索。',
    '',
    '## 标准',
    '',
    criteria,
    '',
    '## 记录',
    '',
    ...records.map((record) => [
      `### ${record.id}`,
      record.title ? `题名：${record.title}` : '',
      record.year ? `年份：${record.year}` : '',
      record.source ? `来源：${record.source}` : '',
      record.abstract ? `摘要：${record.abstract}` : '',
    ].filter(Boolean).join('\n')),
    '',
    '每条给出 include / exclude / unclear 与一句理由，排除时写清违反了哪条标准。',
    '标题摘要筛选采用保守纳入：没有明确违反标准时给 include，并说明需要全文核对的信息。只有明确不合格才 exclude；无法处理或记录损坏才给 unclear，unclear 也进入全文核对。',
  ].join('\n')
}

/**
 * The screening ledger.
 *
 * CSV because it is what a reviewer opens, and quoted properly because a reason
 * containing a comma is the normal case, not an edge case.
 * @param {readonly Record<string, any>[]} verdicts
 * @returns {string}
 */
export function renderScreeningLedger(verdicts) {
  const rows = [['id', 'decision', 'criterion', 'reason']]
  for (const verdict of verdicts) {
    rows.push([
      String(verdict?.id ?? ''),
      String(verdict?.decision ?? 'unclear'),
      String(verdict?.criterion ?? ''),
      String(verdict?.reason ?? ''),
    ])
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

/** @param {string} value @returns {string} */
function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
