/**
 * The shape of a report's prose, compact enough to read in one tool result.
 *
 * Hidden knowledge: this replaced a Python heredoc the clinical skill told
 * every child to run before submitting (`SKILL.md` "Finishing: check the prose
 * mechanically"). It printed one line per paragraph — section, length, the
 * first fourteen characters — and a count per watched phrase, because reading
 * a 60 KB report back to check its rhythm floods the context and `grep` on
 * long Markdown lines can exceed the tool output limit. The script was the
 * same few lines in every run, so it is a tool option now
 * (`evimed_package_check{prose: true}`).
 *
 * It measures and counts; it judges nothing. Which lengths are too flat, which
 * openings too alike and which phrases are empty is the model's reading, and
 * the phrases to count come from the skill text that names them — this module
 * holds no vocabulary of its own (principle 5).
 *
 * @module @evimed/dsh-socket/src/proseShape
 */

/** Paragraph rows returned at most; a report with more is summarised by the first ones. */
export const PROSE_SHAPE_PARAGRAPHS = 200
/** Phrases counted at most, and the longest phrase accepted. */
export const PROSE_SHAPE_PHRASES = 40
const PHRASE_MAX_CHARS = 24

/**
 * @param {string} text the report
 * @param {readonly unknown[]} [phrases] literal phrases to count
 * @returns {{ paragraphs: { section: string, chars: number, opening: string }[], truncated: number, phrases: Record<string, number> }}
 */
export function proseShape(text, phrases = []) {
  // Single-line comments only, as the script did: claim markers are one line.
  const source = String(text ?? '').replace(/<!--.*?-->/g, '')
  /** @type {{ section: string, chars: number, opening: string }[]} */
  const rows = []
  /** @type {string[]} */
  let buffer = []
  let section = ''
  const flush = () => {
    const paragraph = buffer.join('').trim()
    buffer = []
    // Tables, quotations, list items and numbered lines are not running prose.
    if (paragraph && !/^[|>*\-0-9]/.test(paragraph)) {
      rows.push({ section: section.slice(0, 8), chars: [...paragraph].length, opening: [...paragraph].slice(0, 14).join('') })
    }
  }
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || /^[#|>*\-0-9]/.test(trimmed)) {
      flush()
      if (trimmed.startsWith('#')) section = trimmed.replace(/^#+\s*/, '')
      continue
    }
    buffer.push(trimmed)
  }
  flush()

  /** @type {Record<string, number>} */
  const counts = {}
  for (const phrase of phrases.slice(0, PROSE_SHAPE_PHRASES)) {
    const literal = String(phrase ?? '').trim()
    if (!literal || literal.length > PHRASE_MAX_CHARS || literal in counts) continue
    const found = source.split(literal).length - 1
    if (found) counts[literal] = found
  }
  return {
    paragraphs: rows.slice(0, PROSE_SHAPE_PARAGRAPHS),
    truncated: Math.max(0, rows.length - PROSE_SHAPE_PARAGRAPHS),
    phrases: counts,
  }
}
