// Arm G's tools: the knowledge base read the way `kb_browse` lets a run read it (list, grep, read), in-process over the same
// documents the other arms search. The limits are the gateway's (`apps/server/src/kbBrowseGateway.mjs`): a read is at most 400
// lines and 80,000 characters, a grep at most 50 matches of at most 400 characters each, and a grep is a case-insensitive literal.
// A document keeps the line structure of its file; nothing is re-wrapped.

import { BROWSE_MAX_CALLS } from './prompts.mjs'

export const BROWSE_MAX_TOOL_CALLS = BROWSE_MAX_CALLS
export const READ_DEFAULT_LINES = 200
export const READ_MAX_LINES = 400
export const READ_MAX_CHARS = 80_000
export const GREP_MAX_MATCHES = 50
export const GREP_MATCH_CHARS = 400
export const GREP_MAX_PATTERN = 200

export const BROWSE_TOOLS = Object.freeze([
  Object.freeze({
    type: 'function',
    function: {
      name: 'kb_list',
      description: "List the researcher's knowledge base: every document's id and title.",
      parameters: { type: 'object', properties: {} },
    },
  }),
  Object.freeze({
    type: 'function',
    function: {
      name: 'kb_grep',
      description: 'Find the lines that contain a piece of text. The text is matched as written (not a pattern), ignoring case, within one line. Returns up to 50 matches, each with the document id, the line number and the line.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Plain text to look for.' },
          doc: { type: 'string', description: 'A document id, to search only that document. Omit to search them all.' },
        },
        required: ['pattern'],
      },
    },
  }),
  Object.freeze({
    type: 'function',
    function: {
      name: 'kb_read',
      description: 'Read a document by numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'The document id.' },
          offset: { type: 'integer', description: 'Lines to skip (default 0).' },
          limit: { type: 'integer', description: 'Lines to read (default 200, at most 400).' },
        },
        required: ['doc'],
      },
    },
  }),
])

/** A document's lines as the gateway counts them: split on newlines, a final empty piece dropped. @param {string} text */
export function linesOf(text) {
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The line-length facts of a set of documents, for the report: how many lines, how many are not blank, and the percentiles of
 * the non-blank lines' lengths.
 * @param {Array<{ text: string }>} documents
 */
export function lineStats(documents) {
  const lengths = documents.flatMap((document) => linesOf(document.text)).filter((line) => line.trim()).map((line) => line.length).sort((a, b) => a - b)
  const at = (share) => lengths[Math.min(lengths.length - 1, Math.floor(share * lengths.length))] ?? 0
  const totalLines = documents.reduce((sum, document) => sum + linesOf(document.text).length, 0)
  return { documents: documents.length, lines: totalLines, nonBlankLines: lengths.length, p50: at(0.5), p90: at(0.9), max: lengths.at(-1) ?? 0, over400: lengths.filter((n) => n > GREP_MATCH_CHARS).length }
}

/** @param {Array<{ sourceId: string, title: string, text: string }>} documents */
export function createBrowseStore(documents) {
  const byId = new Map(documents.map((document) => [document.sourceId, { ...document, lines: linesOf(document.text) }]))
  const unknown = (doc) => `No document has the id "${doc}". Use kb_list to see the ids.`

  return {
    list() {
      return `Documents (${documents.length}):\n${documents.map((document) => `${document.sourceId}\t${document.title}`).join('\n')}`
    },
    /** @param {string} pattern @param {string} [doc] */
    grep(pattern, doc) {
      const text = String(pattern ?? '')
      // eslint-disable-next-line no-control-regex -- control characters are exactly what a literal to search for must not hold
      if (!text.trim() || text.length > GREP_MAX_PATTERN || /[\u0000-\u001f\u007f]/.test(text)) return `kb_grep needs a pattern: plain text of at most ${GREP_MAX_PATTERN} characters, matched as written.`
      if (doc && !byId.has(doc)) return unknown(doc)
      const needle = text.toLowerCase()
      const matches = []
      let more = false
      for (const document of doc ? [byId.get(doc)] : byId.values()) {
        for (const [index, line] of document.lines.entries()) {
          if (!line.toLowerCase().includes(needle)) continue
          if (matches.length >= GREP_MAX_MATCHES) { more = true; break }
          matches.push({ doc: document.sourceId, line: index + 1, text: line.slice(0, GREP_MATCH_CHARS) })
        }
        if (more) break
      }
      if (!matches.length) return `No line holds "${text}" as written.`
      const body = matches.map((match) => `${match.doc}:${match.line}: ${match.text}`).join('\n')
      return `${matches.length} match${matches.length === 1 ? '' : 'es'}${more ? ` (stopped at the limit of ${GREP_MAX_MATCHES}; there are more)` : ''}:\n${body}`
    },
    /** @param {string} doc @param {unknown} [offset] @param {unknown} [limit] */
    read(doc, offset, limit) {
      const document = byId.get(doc)
      if (!document) return unknown(doc)
      const from = offset == null ? 0 : Number(offset)
      const wanted = limit == null ? READ_DEFAULT_LINES : Number(limit)
      if (!Number.isInteger(from) || from < 0) return 'offset must be an integer of at least 0.'
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > READ_MAX_LINES) return `limit must be an integer between 1 and ${READ_MAX_LINES}.`
      const kept = []
      let chars = 0
      let lineCut = false
      for (const [index, line] of document.lines.slice(from, from + wanted).entries()) {
        if (chars + line.length > READ_MAX_CHARS) {
          if (!kept.length) { kept.push(`${from + 1}\t${line.slice(0, READ_MAX_CHARS)}`); lineCut = true }
          break
        }
        kept.push(`${from + index + 1}\t${line}`)
        chars += line.length + 1
      }
      const to = from + kept.length
      const more = to < document.lines.length || lineCut
      const header = kept.length ? `${document.title} (${document.sourceId}) lines ${from + 1}-${to} of ${document.lines.length}${more ? '; more follows, read on from offset ' + to : ''}` : `${document.title} (${document.sourceId}) has ${document.lines.length} lines; none at offset ${from}.`
      return `${header}\n${kept.join('\n')}`
    },
  }
}

/**
 * One tool call of arm G answered. @param {ReturnType<typeof createBrowseStore>} store @param {string} name @param {string} rawArguments
 * @returns {{ content: string, call: { tool: string, args: Record<string, unknown> } }}
 */
export function runBrowseTool(store, name, rawArguments) {
  let args = {}
  try { args = JSON.parse(rawArguments || '{}') ?? {} } catch { return { content: `${name}: the arguments were not valid JSON.`, call: { tool: name, args: {} } } }
  const call = { tool: name, args }
  if (name === 'kb_list') return { content: store.list(), call }
  if (name === 'kb_grep') return { content: store.grep(args.pattern, args.doc ? String(args.doc) : undefined), call }
  if (name === 'kb_read') return { content: store.read(String(args.doc ?? ''), args.offset, args.limit), call }
  return { content: `Unknown tool ${name}. The tools are kb_list, kb_grep and kb_read.`, call }
}
