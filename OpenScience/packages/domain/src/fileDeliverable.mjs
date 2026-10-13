/**
 * `file-deliverable` — what an ordinary file has to be to be handed over.
 *
 * Hidden knowledge: an e-mail, a rename script, a budget workbook and a ten-page
 * deck are what the platform's users ask for most, and none of them was a
 * deliverable: the contract kinds were all medicine-shaped (a report, a matrix, a
 * package of one study), the ledger saw only files a `write` tool call named, and
 * the project listed only files a contract declared (course correction
 * 2026-10-12, finding GA16). This is the one kind that says what any file must be,
 * and it says only what a program can decide: it exists, it is not empty, and it
 * opens as the format its name claims. Nothing here reads a word of the file
 * (principle 1) and nothing here withholds one (principle 4, the blocking budget
 * is unchanged): every finding is advice the reader or the run may act on.
 *
 * Pure bytes in, findings out, no dependency — the package is browser-safe, so
 * there is no inflate here either: an Office file "opens" when it is a zip whose
 * directory lists the parts its format cannot do without. A package whose
 * directory is intact and whose parts are present is what Word, Excel and
 * PowerPoint open; one cut short, or not a zip at all, is what they report as
 * corrupt.
 *
 * @module fileDeliverable
 */

/** The contract kind of an ordinary file. */
export const FILE_DELIVERABLE_KIND = 'file-deliverable'

/** The check id its findings carry on the gate ledger. */
export const FILE_FORMAT_CHECK = 'file-format'

/**
 * The finding codes, each titled for a reader in `gateIssueText.mjs`.
 */
export const FILE_FORMAT_CODES = Object.freeze({
  missing: 'file_deliverable_missing',
  empty: 'file_empty',
  malformed: 'file_unreadable',
})

/** An Office package: the parts it cannot be opened without. */
const OFFICE_PARTS = Object.freeze({
  docx: Object.freeze({ label: 'Word', parts: ['[Content_Types].xml', 'word/document.xml'] }),
  xlsx: Object.freeze({ label: 'Excel', parts: ['[Content_Types].xml', 'xl/workbook.xml'] }),
  pptx: Object.freeze({ label: 'PowerPoint', parts: ['[Content_Types].xml', 'ppt/presentation.xml'] }),
})

/** Plain-text formats: UTF-8 with no NUL byte. A listing, not a guess at language. */
const TEXT_EXTENSIONS = Object.freeze(new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'css', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'py', 'r', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'sql', 'tex', 'bib', 'ris', 'svg', 'log', 'rst',
]))

/** The longest a text file is read for the "decodes" and "parses" findings, in bytes. */
const TEXT_READ_LIMIT = 8 * 1024 * 1024

/**
 * A file's format class from its name: what its extension says it is, which is
 * the only claim a name makes.
 * @param {string} path
 * @returns {{ extension: string, kind: 'office' | 'pdf' | 'image' | 'text' | 'other', label: string }}
 */
export function fileFormatOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (Object.hasOwn(OFFICE_PARTS, extension)) return { extension, kind: 'office', label: OFFICE_PARTS[/** @type {keyof typeof OFFICE_PARTS} */ (extension)].label }
  if (extension === 'pdf') return { extension, kind: 'pdf', label: 'PDF' }
  if (extension === 'png' || extension === 'jpg' || extension === 'jpeg' || extension === 'gif') return { extension, kind: 'image', label: '图片' }
  if (TEXT_EXTENSIONS.has(extension)) return { extension, kind: 'text', label: extension === 'json' ? 'JSON' : '文本' }
  return { extension, kind: 'other', label: '文件' }
}

/** @param {Uint8Array} bytes @param {number} offset */
const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8)
/** @param {Uint8Array} bytes @param {number} offset */
const u32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0

/**
 * The names of a zip package's entries, read from its central directory, or null
 * when the bytes are not a zip whose directory is intact. A directory that
 * points outside the file, or an entry that does not start where the last one
 * ended, is a cut-short download or a half-written file — the commonest way a
 * generated document fails to open.
 * @param {Uint8Array} bytes
 * @returns {string[] | null}
 */
export function zipEntryNames(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) return null
  // The end-of-central-directory record: 22 bytes plus a comment of up to 65,535, found from the back.
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) { end = at; break }
  }
  if (end < 0) return null
  const total = u16(bytes, end + 10)
  const size = u32(bytes, end + 12)
  const offset = u32(bytes, end + 16)
  // ZIP64 puts these in a second record; its readers are not ours to guess, and a file that needs it is not a document.
  if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null
  if (offset + size > end) return null
  /** @type {string[]} */
  const names = []
  let at = offset
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > end || u32(bytes, at) !== 0x02014b50) return null
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    const commentLength = u16(bytes, at + 32)
    if (at + 46 + nameLength + extraLength + commentLength > end) return null
    names.push(new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength)))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/**
 * Whether the bytes are UTF-8 text: they decode without a replacement and hold no NUL byte.
 * @param {Uint8Array} bytes
 */
function decodesAsText(bytes) {
  const head = bytes.length > TEXT_READ_LIMIT ? bytes.subarray(0, TEXT_READ_LIMIT) : bytes
  if (head.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(head)
  } catch {
    // A cut at the read limit can split one character; that is the limit's doing, not the file's.
    if (bytes.length > TEXT_READ_LIMIT) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 3))
      } catch { /* not text */ }
    }
    return null
  }
}

/**
 * What is wrong with one file, if anything. Every finding is advisory.
 * @param {string} path the file's name or workspace-relative path
 * @param {Uint8Array} bytes
 * @returns {{ code: string, message: string, check: string, path: string }[]}
 */
export function fileFormatIssues(path, bytes) {
  const name = String(path ?? '').split('/').pop() || String(path ?? '')
  /** @param {string} code @param {string} message */
  const finding = (code, message) => ({ code, message, check: FILE_FORMAT_CHECK, path })
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return [finding(FILE_FORMAT_CODES.empty, `${name} 是空文件。`)]
  }
  const format = fileFormatOf(path)
  if (format.kind === 'office') {
    const names = zipEntryNames(bytes)
    if (!names) return [finding(FILE_FORMAT_CODES.malformed, `${name} 不是完整的 ${format.label} 文件（压缩包目录读不出来，可能写到一半，或不是 ${format.extension} 格式）。`)]
    const missing = OFFICE_PARTS[/** @type {keyof typeof OFFICE_PARTS} */ (format.extension)].parts.filter((part) => !names.includes(part))
    if (missing.length) return [finding(FILE_FORMAT_CODES.malformed, `${name} 缺少 ${format.label} 打开所必需的部分（${missing.join('、')}）。`)]
    return []
  }
  if (format.kind === 'pdf') {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
    const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 2048)))
    if (!head.includes('%PDF-')) return [finding(FILE_FORMAT_CODES.malformed, `${name} 不是 PDF 文件（开头没有 PDF 标记）。`)]
    if (!tail.includes('%%EOF')) return [finding(FILE_FORMAT_CODES.malformed, `${name} 不是完整的 PDF 文件（结尾缺失，可能写到一半）。`)]
    return []
  }
  if (format.kind === 'image') {
    const signed = format.extension === 'png' ? bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      : format.extension === 'gif' ? bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    return signed ? [] : [finding(FILE_FORMAT_CODES.malformed, `${name} 不是有效的图片文件（${format.extension} 格式的文件头不对）。`)]
  }
  if (format.kind === 'text') {
    const text = decodesAsText(bytes)
    if (text === null) return [finding(FILE_FORMAT_CODES.malformed, `${name} 不是文本文件（含有无法按 UTF-8 读出的内容）。`)]
    if (format.extension === 'json' && bytes.length <= TEXT_READ_LIMIT) {
      try {
        JSON.parse(text)
      } catch {
        return [finding(FILE_FORMAT_CODES.malformed, `${name} 不是有效的 JSON。`)]
      }
    }
  }
  return []
}
