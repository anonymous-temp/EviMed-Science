/**
 * The capability handbook's self-maintained section: ACE's playbook, in the one
 * place both the writer and the guard can read it.
 *
 * Hidden knowledge: the whole design turns on refusing to let a model rewrite
 * the handbook. Dynamic Cheatsheet-style "hand the model the document and ask
 * for a better one" loses whatever the model did not happen to copy forward —
 * context collapse — and it loses it silently, because the result still reads
 * like a handbook. ACE's answer is to make the unit of change a *line*: the
 * model proposes deltas and tags, and a deterministic curator applies them.
 * That curator is this module, and it is code precisely because "apply an
 * increment to a counter, keep the first id, refuse to touch anything outside
 * this section" is a decidable operation and a model is the wrong tool for it.
 *
 * The grammar is ACE's, kept verbatim so the reference implementation's
 * analysis scripts still parse our sections:
 *
 *     - [E-<capability>-<n>] helpful=<int> harmful=<int> :: <content>
 *
 * The headings are English because a capability's SKILL.md is English (the
 * workspace rule); nothing else about the format is ours.
 *
 * What this module will never do is decide whether a note is *good*. It counts
 * how often a note was present when a run went well and when it went badly, and
 * it presents both numbers. The judgement stays with the reflector, and the
 * decision to ship stays with a pull request.
 */
import { DEDUP_SEMANTIC_COSINE } from './constants.mjs'

/** The heading the automated section lives under. Everything outside it is
 *  hand-written and may not be touched by the loop. */
export const EXPERIENCE_SECTION_HEADING = 'Learned Notes'

/** ACE's four buckets, which are about what a note *is*, not how good it is. */
export const EXPERIENCE_SUBSECTIONS = Object.freeze([
  'Strategies and Insights',
  'Common Mistakes',
  'Context Cues',
  'Other',
])

/** What the reflector may say about a note that was present during a run. */
export const BULLET_TAGS = Object.freeze(['helpful', 'harmful', 'neutral'])

const SECTION_LINE = `## ${EXPERIENCE_SECTION_HEADING}`
/** The marker that tells a human reader — and a diff reviewer — not to hand-edit. */
export const EXPERIENCE_SECTION_NOTE =
  '<!-- Maintained by the consolidation job. Edit the sections above instead; changes here are overwritten. -->'

const BULLET_PATTERN = /^-\s*\[(E-[a-z0-9-]+-\d+)\]\s+helpful=(\d+)\s+harmful=(\d+)\s*::\s*(.*\S)\s*$/

/**
 * @typedef {object} ExperienceBullet
 * @property {string} id
 * @property {number} helpful
 * @property {number} harmful
 * @property {string} content
 * @property {string} section
 */

/**
 * @typedef {object} ExperienceSection
 * @property {boolean} present
 * @property {ExperienceBullet[]} bullets
 * @property {string} before   everything above the section, byte for byte
 * @property {string} after    everything below the section, byte for byte
 * @property {string[]} malformed  lines inside the section that are not bullets
 */

/** @param {string} text @returns {string} */
function normalizeContent(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\u3000]+/g, ' ').replace(/[.,;:!?，。；：！？]+$/g, '').trim()
}

/**
 * Split a SKILL.md into the hand-written part and the maintained section.
 *
 * `before` and `after` are returned verbatim rather than re-rendered, because
 * the only way to prove an automated edit touched nothing else is to put the
 * untouched bytes back exactly as they were found.
 * @param {string} markdown
 * @returns {ExperienceSection}
 */
export function parseExperienceSection(markdown) {
  const source = String(markdown ?? '').replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.trim() === SECTION_LINE)
  if (start < 0) return { present: false, bullets: [], before: source, after: '', malformed: [] }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index]) && lines[index].trim() !== SECTION_LINE) { end = index; break }
  }
  /** @type {ExperienceBullet[]} */
  const bullets = []
  /** @type {string[]} */
  const malformed = []
  let section = EXPERIENCE_SUBSECTIONS[EXPERIENCE_SUBSECTIONS.length - 1]
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^###\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      section = EXPERIENCE_SUBSECTIONS.includes(heading[1]) ? heading[1] : EXPERIENCE_SUBSECTIONS[EXPERIENCE_SUBSECTIONS.length - 1]
      continue
    }
    if (!line.trim() || line.trim().startsWith('<!--')) continue
    const match = BULLET_PATTERN.exec(line)
    if (!match) { malformed.push(line); continue }
    bullets.push({ id: match[1], helpful: Number(match[2]), harmful: Number(match[3]), content: match[4], section })
  }
  return {
    present: true,
    bullets,
    before: lines.slice(0, start).join('\n'),
    after: end < lines.length ? lines.slice(end).join('\n') : '',
    malformed,
  }
}

/** @param {ExperienceBullet} bullet @returns {string} */
export function renderBullet(bullet) {
  return `- [${bullet.id}] helpful=${bullet.helpful} harmful=${bullet.harmful} :: ${bullet.content}`
}

/**
 * @param {readonly ExperienceBullet[]} bullets
 * @returns {string}
 */
export function renderExperienceSection(bullets) {
  const lines = [SECTION_LINE, '', EXPERIENCE_SECTION_NOTE]
  for (const section of EXPERIENCE_SUBSECTIONS) {
    const members = bullets.filter((bullet) => bullet.section === section)
    if (!members.length) continue
    lines.push('', `### ${section}`, '')
    for (const bullet of members) lines.push(renderBullet(bullet))
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Put a new set of bullets back into a document, leaving every other byte alone.
 * @param {string} markdown
 * @param {readonly ExperienceBullet[]} bullets
 * @returns {string}
 */
export function replaceExperienceSection(markdown, bullets) {
  const parsed = parseExperienceSection(markdown)
  const rendered = renderExperienceSection(bullets)
  if (!parsed.present) {
    const base = parsed.before.replace(/\s*$/, '')
    return `${base}\n\n${rendered}`
  }
  const tail = parsed.after ? `\n${parsed.after.replace(/^\n+/, '')}` : ''
  return `${parsed.before.replace(/\s*$/, '')}\n\n${rendered}${tail}`
}

/**
 * The next free id for a capability. Ids are never reused: a retired note's
 * number stays retired, so an old reflection referring to `E-x-7` can never be
 * read as being about a different note.
 * @param {string} capability
 * @param {readonly ExperienceBullet[]} bullets
 * @returns {string}
 */
export function nextBulletId(capability, bullets) {
  const prefix = `E-${String(capability ?? 'capability').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-`
  let highest = 0
  for (const bullet of bullets ?? []) {
    if (!bullet.id.startsWith(prefix)) continue
    const number = Number(bullet.id.slice(prefix.length))
    if (Number.isFinite(number)) highest = Math.max(highest, number)
  }
  return `${prefix}${highest + 1}`
}

/**
 * @typedef {object} CurationOperations
 * @property {{section?: string, content: string}[]} [additions]
 * @property {{id: string, tag: string}[]} [tags]
 * @property {{keep: string, drop: string, content?: string}[]} [merges]
 */

/**
 * @typedef {object} CurationResult
 * @property {ExperienceBullet[]} bullets
 * @property {string[]} added
 * @property {{keep: string, drop: string}[]} merged
 * @property {{operation: unknown, reason: string}[]} rejected
 */

/**
 * Apply the reflector's proposals deterministically.
 *
 * The reflector may say "this note helped", "this note hurt", "add this note",
 * and "these two notes are the same note". It may not say what the counters
 * become, which note keeps its id, or where in the file anything goes — those
 * are this function's, and the reason is that every one of them is checkable
 * and a model that gets to decide them can drift the whole section a little on
 * every pass.
 *
 * ACE's reference curator only ever adds. Merging is ours, because a handbook
 * that only grows becomes a handbook nobody loads: near-duplicates are the
 * commonest thing a nightly reflection produces.
 * @param {readonly ExperienceBullet[]} existing
 * @param {CurationOperations} operations
 * @param {{capability: string, similarity?: (left: string, right: string) => number, mergeThreshold?: number}} options
 * @returns {CurationResult}
 */
export function curateBullets(existing, operations, options) {
  /** @type {ExperienceBullet[]} */
  const bullets = (existing ?? []).map((bullet) => ({ ...bullet }))
  /** @type {string[]} */
  const added = []
  /** @type {{keep: string, drop: string}[]} */
  const merged = []
  /** @type {{operation: unknown, reason: string}[]} */
  const rejected = []
  const threshold = options?.mergeThreshold ?? DEDUP_SEMANTIC_COSINE
  const similarity = options?.similarity

  for (const tag of operations?.tags ?? []) {
    const bullet = bullets.find((entry) => entry.id === tag.id)
    if (!bullet) { rejected.push({ operation: tag, reason: `no note has id ${tag.id}` }); continue }
    if (!BULLET_TAGS.includes(tag.tag)) { rejected.push({ operation: tag, reason: `${tag.tag} is not one of ${BULLET_TAGS.join(', ')}` }); continue }
    if (tag.tag === 'helpful') bullet.helpful += 1
    if (tag.tag === 'harmful') bullet.harmful += 1
  }

  for (const merge of operations?.merges ?? []) {
    const keepIndex = bullets.findIndex((entry) => entry.id === merge.keep)
    const dropIndex = bullets.findIndex((entry) => entry.id === merge.drop)
    if (keepIndex < 0 || dropIndex < 0) { rejected.push({ operation: merge, reason: 'a merge names an id that is not in the section' }); continue }
    if (keepIndex === dropIndex) { rejected.push({ operation: merge, reason: 'a note cannot be merged into itself' }); continue }
    const keep = bullets[keepIndex]
    const drop = bullets[dropIndex]
    if (similarity && similarity(keep.content, drop.content) < threshold) {
      rejected.push({ operation: merge, reason: `the two notes are less alike than ${threshold}; merging them would lose one of them` })
      continue
    }
    keep.helpful += drop.helpful
    keep.harmful += drop.harmful
    if (merge.content) keep.content = merge.content
    bullets.splice(dropIndex, 1)
    merged.push({ keep: merge.keep, drop: merge.drop })
  }

  for (const addition of operations?.additions ?? []) {
    const content = String(addition?.content ?? '').replace(/\s+/g, ' ').trim()
    if (!content) { rejected.push({ operation: addition, reason: 'an empty note' }); continue }
    if (content.includes('::')) { rejected.push({ operation: addition, reason: 'a note may not contain `::`, which is the grammar\'s separator' }); continue }
    const normalized = normalizeContent(content)
    const duplicate = bullets.find((entry) => normalizeContent(entry.content) === normalized)
    if (duplicate) { rejected.push({ operation: addition, reason: `already present as ${duplicate.id}` }); continue }
    const near = similarity ? bullets.find((entry) => similarity(entry.content, content) >= threshold) : null
    if (near) { rejected.push({ operation: addition, reason: `too close to ${near.id}; tag that one instead of adding a near-duplicate` }); continue }
    const section = EXPERIENCE_SUBSECTIONS.includes(addition.section ?? '') ? String(addition.section) : EXPERIENCE_SUBSECTIONS[EXPERIENCE_SUBSECTIONS.length - 1]
    const id = nextBulletId(options.capability, bullets)
    bullets.push({ id, helpful: 0, harmful: 0, content, section })
    added.push(id)
  }

  return { bullets, added, merged, rejected }
}

/**
 * Notes that have earned removal: seen often and blamed more than credited.
 *
 * A proposal, like every other retirement in this loop — it goes into the pull
 * request as a suggested deletion with its counters attached, so the reviewer
 * sees the evidence rather than the conclusion.
 * @param {readonly ExperienceBullet[]} bullets
 * @param {{minObservations?: number}} [options]
 * @returns {ExperienceBullet[]}
 */
export function harmfulBullets(bullets, options = {}) {
  const minObservations = options.minObservations ?? 3
  return (bullets ?? []).filter((bullet) => bullet.helpful + bullet.harmful >= minObservations && bullet.harmful > bullet.helpful)
}

/**
 * Whether an automated edit stayed inside its section.
 *
 * This is the guard that lets the loop open a pull request against a shipped
 * capability handbook at all: the contract paragraphs and the "must" sentences
 * live above the section, and a diff that touches them is rejected by the
 * generator before a human ever sees it.
 * @param {string} before
 * @param {string} after
 * @returns {{ok: boolean, issues: string[]}}
 */
export function onlyExperienceSectionChanged(before, after) {
  const left = parseExperienceSection(before)
  const right = parseExperienceSection(after)
  /** @type {string[]} */
  const issues = []
  if (left.before.replace(/\s*$/, '') !== right.before.replace(/\s*$/, '')) {
    issues.push('the hand-written text above the maintained section changed')
  }
  if (left.after.replace(/\s*$/, '') !== right.after.replace(/\s*$/, '')) {
    issues.push('the hand-written text below the maintained section changed')
  }
  if (left.present && !right.present) issues.push('the maintained section was removed')
  if (right.malformed.length) issues.push(`the maintained section has ${right.malformed.length} line(s) that are not notes`)
  const leftIds = new Set(left.bullets.map((bullet) => bullet.id))
  const rightIds = new Set(right.bullets.map((bullet) => bullet.id))
  for (const bullet of right.bullets) {
    if (leftIds.has(bullet.id)) continue
    const reused = left.bullets.find((entry) => entry.id === bullet.id)
    if (reused) issues.push(`note ${bullet.id} was reused for different content`)
  }
  for (const id of leftIds) {
    if (!rightIds.has(id)) continue
    const from = /** @type {ExperienceBullet} */ (left.bullets.find((entry) => entry.id === id))
    const to = /** @type {ExperienceBullet} */ (right.bullets.find((entry) => entry.id === id))
    if (to.helpful < from.helpful || to.harmful < from.harmful) {
      issues.push(`note ${id} had a counter decremented; counters only ever grow or are summed into a merge`)
    }
  }
  return { ok: issues.length === 0, issues }
}
