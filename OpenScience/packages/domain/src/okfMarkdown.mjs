/**
 * The two readings every consumer of a compiled page needs: its front matter and its links.
 *
 * Hidden knowledge: the pages are written by OpenViking's Compile (`llm-wiki`, `knowledge-graph`), and what it writes
 * is not quite CommonMark and not quite YAML. Both readers below were written against the trees thirty real compiles
 * left (`.evimed-local/acceptance/course-correction-20261012/lab/knowledge/pages/`), and the cases they exist for are
 * the ones seen there:
 *
 * - a page link's destination may hold spaces, unescaped (`[Lumen 工作组](Lumen 工作组.md)`), or `%20`, or Chinese;
 * - a source link may carry a title, which is where a supporting quotation rides
 *   (`[标题](viking://… "逐字原文")`) — the engine protects whole links when it rewrites a body, so a title survives
 *   where an HTML comment or a block quote would not;
 * - the server re-wraps a long `description` onto indented continuation lines.
 *
 * Neither reader throws on a file it does not understand: a reader that refuses a page shows its user nothing.
 * No YAML library on purpose — the package is dependency-free and browser-safe, and the subset upstream's skills
 * write is small: plain and quoted scalars, inline lists, block lists of scalars, folded and literal block scalars.
 *
 * @module @evimed/domain/okf-markdown
 */

/** @param {string} raw @returns {string} */
function scalar(raw) {
  const value = raw.trim()
  if (!value) return ''
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\nt])/g, (_, /** @type {string} */ c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'")
  return value.replace(/\s+#.*$/, '')
}

/** @param {string} raw @returns {string[]} */
function inlineList(raw) {
  const inner = raw.trim().slice(1, -1)
  /** @type {string[]} */
  const items = []
  let current = ''
  let quote = ''
  for (const ch of inner) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      items.push(current)
      current = ''
    } else current += ch
  }
  if (current.trim()) items.push(current)
  return items.map(scalar).filter((item) => item !== '')
}

/** @param {string} block @returns {Record<string, string | string[]>} */
function parseBlock(block) {
  /** @type {Record<string, string | string[]>} */
  const data = {}
  const lines = block.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[index])
    if (!match) continue
    const key = match[1]
    const rest = (match[2] ?? '').trim()
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = inlineList(rest)
    } else if (/^[>|][+-]?$/.test(rest)) {
      const folded = rest.startsWith('>')
      /** @type {string[]} */
      const collected = []
      while (index + 1 < lines.length && (/^[ \t]+/.test(lines[index + 1]) || lines[index + 1] === '')) collected.push(lines[(index += 1)].trim())
      data[key] = folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim()
    } else if (rest === '') {
      /** @type {string[]} */
      const items = []
      let continuation = ''
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
        const next = lines[(index += 1)]
        const item = /^[ \t]*-[ \t]+(.*)$/.exec(next)
        if (item) items.push(scalar(item[1]))
        else continuation += (continuation ? ' ' : '') + next.trim()
      }
      data[key] = items.length ? items : continuation
    } else {
      // A plain scalar may continue on indented lines (how the server re-wraps a long description).
      let value = rest
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]) && !/^[ \t]*-[ \t]/.test(lines[index + 1])) value += ` ${lines[(index += 1)].trim()}`
      data[key] = scalar(value)
    }
  }
  return data
}

/**
 * A file's front matter and the body after it. `raw` is the front matter block as written, fences included (empty when
 * there is none), so a caller that edits a body can put the same block back in front of it byte for byte.
 * @param {unknown} text
 * @returns {{ data: Record<string, string | string[]>, body: string, hasFrontmatter: boolean, raw: string }}
 */
export function splitOkfFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { data: {}, body: source, hasFrontmatter: false, raw: '' }
  return { data: parseBlock(match[1]), body: source.slice(match[0].length), hasFrontmatter: true, raw: match[0] }
}

/**
 * @typedef {object} OkfLink
 * @property {string} text    the link's words
 * @property {string} target  its destination, as written (not decoded)
 * @property {string | null} title  the quoted title after the destination, when there is one
 * @property {number} index   the offset of the `[` in the text that was read
 * @property {number} end     the offset just past the closing `)`
 */

/**
 * @param {string} source @param {number} start
 * @returns {{ text: string, target: string, title: string | null, end: number } | null}
 */
function linkAt(source, start) {
  // [text] — one level of nested brackets is enough for what the engine writes.
  let depth = 0
  let close = -1
  for (let i = start; i < source.length && i < start + 2000; i += 1) {
    const ch = source[i]
    if (ch === '\\') i += 1
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) { close = i; break }
    } else if (ch === '\n' && source[i + 1] === '\n') return null
  }
  if (close === -1 || source[close + 1] !== '(') return null
  const text = source.slice(start + 1, close)
  let i = close + 2
  let target = ''
  /** @type {string | null} */
  let title = null
  if (source[i] === '<') {
    const end = source.indexOf('>', i)
    if (end === -1) return null
    target = source.slice(i + 1, end)
    i = end + 1
  } else {
    let parens = 0
    for (; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '\n') return null
      if (ch === '\\' && i + 1 < source.length) {
        target += source[i + 1]
        i += 1
        continue
      }
      if (ch === '(') parens += 1
      if (ch === ')') {
        if (parens === 0) break
        parens -= 1
      }
      // A title starts at whitespace followed by a quote; a space on its own is part of the destination.
      if ((ch === ' ' || ch === '\t') && (source[i + 1] === '"' || source[i + 1] === "'")) break
      target += ch
    }
  }
  while (source[i] === ' ' || source[i] === '\t') i += 1
  if (source[i] === '"' || source[i] === "'") {
    const quote = source[i]
    let value = ''
    let closed = false
    for (let j = i + 1; j < source.length; j += 1) {
      const ch = source[j]
      if (ch === '\\' && j + 1 < source.length) {
        value += source[j + 1]
        j += 1
        continue
      }
      if (ch === quote) {
        // The closing quote is the one followed by `)`; an inner quote the model did not escape stays in the title.
        let k = j + 1
        while (source[k] === ' ' || source[k] === '\t') k += 1
        if (source[k] === ')') {
          closed = true
          i = k
          break
        }
      }
      if (ch === '\n' && source[j + 1] === '\n') break
      value += ch
    }
    if (!closed) return null
    title = value
  }
  if (source[i] !== ')') return null
  return { text, target: target.trim(), title, end: i + 1 }
}

/**
 * Every Markdown link of a text, in order. Images, fenced code and inline code are skipped.
 * @param {unknown} markdown @returns {OkfLink[]}
 */
export function okfMarkdownLinks(markdown) {
  const source = String(markdown ?? '')
  /** @type {OkfLink[]} */
  const links = []
  let index = 0
  let fence = ''
  while (index < source.length) {
    const lineStart = index === 0 || source[index - 1] === '\n'
    if (lineStart) {
      const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(source.slice(index, index + 12))
      if (fenceMatch) {
        const marker = fenceMatch[1][0]
        if (!fence) fence = marker
        else if (fence === marker) fence = ''
        const end = source.indexOf('\n', index)
        index = end === -1 ? source.length : end + 1
        continue
      }
    }
    if (fence) {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end + 1
      continue
    }
    const ch = source[index]
    if (ch === '`') {
      const run = /^`+/.exec(source.slice(index))?.[0] ?? '`'
      const close = source.indexOf(run, index + run.length)
      index = close === -1 ? index + run.length : close + run.length
      continue
    }
    if (ch === '[' && source[index - 1] !== '!' && source[index - 1] !== '\\') {
      const parsed = linkAt(source, index)
      if (parsed) {
        links.push({ text: parsed.text, target: parsed.target, title: parsed.title, index, end: parsed.end })
        index = parsed.end
        continue
      }
    }
    index += 1
  }
  return links
}

/** A link destination with its fragment taken off and its percent-escapes read; as written when they cannot be. @param {string} target */
export function okfLinkPath(target) {
  const raw = String(target ?? '').split('#')[0]
  try { return decodeURIComponent(raw) } catch { return raw }
}
