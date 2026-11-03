/**
 * The files an earlier conversation of the project left in the workspace, said once at the first step of a new one.
 *
 * Hidden knowledge: every conversation of a project shares one `/workspace`. The kernel's working directory, the path guard,
 * the run ledger's file detection and the file panel all assume one root, and a project's files are meant to be shared — so
 * a new conversation cannot be given a directory of its own. What it can be given is the fact. On 2026-11-01 a new
 * conversation asked 「帮我算一下这个试验要多少人」 found the design files an earlier one had written, read them as
 * 「这个试验」, asked nothing and made 53 tool calls on work nobody had asked it to continue. The listing is data
 * (principle 20b): names the model could have found with `ls`, handed over before it has a reason to guess, with one
 * sentence on what they are and are not.
 *
 * The listing uses the control plane's own closed list of what an ordinary file is (`ordinaryOutputPath`, domain), so the
 * names here are the files the run ledger would call a conversation's outputs, and never the platform's directories, the
 * knowledge base or anything hidden. It is bounded in depth, in entries read and in time, and the caller treats every
 * failure as "nothing to say": a block like this one never costs a step.
 *
 * @module @evimed/dsh-socket/src/earlierFiles
 */

import { isOrdinaryOutputDirectory, ordinaryOutputPath } from '@evimed/domain'

/** How deep below the workspace root a file is looked for. */
export const EARLIER_FILES_DEPTH = 3
/** How many directory entries one listing reads before it stops. */
export const EARLIER_FILES_ENTRIES = 400
/** How long the listing may take; the first step waits for it. */
export const EARLIER_FILES_MS = 1500
/** How many names the block carries. */
export const EARLIER_FILES_NAMES = 12

/**
 * @typedef {object} EarlierFiles
 * @property {string[]} names workspace-relative file paths, at most `EARLIER_FILES_NAMES`, shallowest first
 * @property {number} more files found beyond those named
 * @property {boolean} truncated the listing stopped at a bound, so `more` is a lower bound
 */

/**
 * @param {(relative: string) => Promise<{ name: string, directory: boolean }[]>} list one directory's entries, workspace-relative
 * @param {{ now?: () => number, depth?: number, entries?: number, ms?: number, names?: number, exclude?: (path: string) => boolean }} [options]
 *   `exclude` drops a path the first message of this conversation names (a file the person attached to it is theirs, not an earlier one's)
 * @returns {Promise<EarlierFiles>}
 */
export async function listEarlierFiles(list, options = {}) {
  const now = options.now ?? Date.now
  const maxDepth = options.depth ?? EARLIER_FILES_DEPTH
  const maxEntries = options.entries ?? EARLIER_FILES_ENTRIES
  const deadline = now() + (options.ms ?? EARLIER_FILES_MS)
  const named = options.names ?? EARLIER_FILES_NAMES
  const exclude = options.exclude ?? (() => false)
  /** @type {string[]} */
  const found = []
  /** @type {{ relative: string, depth: number }[]} */
  const queue = [{ relative: '', depth: 0 }]
  let read = 0
  let truncated = false
  while (queue.length > 0) {
    if (read >= maxEntries || now() > deadline) { truncated = true; break }
    const { relative, depth } = /** @type {{ relative: string, depth: number }} */ (queue.shift())
    const entries = await list(relative)
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      read += 1
      if (read > maxEntries) { truncated = true; break }
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.directory) {
        if (depth + 1 <= maxDepth && isOrdinaryOutputDirectory(entry.name, relative === '')) queue.push({ relative: child, depth: depth + 1 })
        continue
      }
      if (ordinaryOutputPath(child) && !exclude(child)) found.push(child)
    }
  }
  return { names: found.slice(0, named), more: Math.max(0, found.length - named), truncated }
}

/**
 * The block, or nothing when there is nothing to say.
 * @param {EarlierFiles} files
 * @returns {string}
 */
export function earlierFilesText(files) {
  if (!files.names.length) return ''
  const shown = files.names.join('、')
  const rest = files.more > 0 ? `，另有${files.truncated ? '至少 ' : ' '}${files.more} 个` : files.truncated ? '，目录较大，只列到这里' : ''
  return `<evimed-earlier-files>此前的对话在工作目录里留下了这些文件：${shown}${rest}。这次的请求没有点到其中任何一份时，不要打开它们，也不要当作这次的材料；觉得用户可能指的是其中某一份，先问清楚再动手，不要替用户猜。</evimed-earlier-files>`
}
