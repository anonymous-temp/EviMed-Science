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
 * `unclear` is a first-class answer on purpose: forcing a binary decision on an
 * abstract that does not settle the question produces a confident wrong answer,
 * and a screening ledger full of those is worse than one that says where a
 * human has to look.
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
    '题录信息不足以判断时给 unclear —— 不要猜。一条猜错的 include 会被后续全文核对发现，一条猜错的 exclude 不会。',
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
