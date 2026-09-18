/**
 * A delegated child's method text, capped.
 *
 * Hidden knowledge: how much of a capability's method a child is handed before
 * its first step, and how it reaches the rest. The bodies used to travel whole
 * inside the child's first message, uncapped: a clinical child started with
 * 158 KB of instructions and re-sent them on every one of its ~190 steps
 * (review appendix E §2.4), while the answer persona beside it was capped at
 * 32,000 characters. The same cap now applies here, and nothing is deleted:
 * every `##` section that is not inlined keeps its heading, in place, with the
 * name the child loads it by, and that name resolves — through the kernel's
 * own `skill` tool — to the section's exact text.
 *
 * The largest sections go first. A method's long sections are its phase
 * procedures — the search protocol, the citation-traceability rules, the report
 * and output specifications — which a child needs at one stage of its work;
 * its short ones are principles and boundaries it needs throughout. Deferring
 * in document order instead left the safety boundaries and the last steps
 * before delivering out of a clinical child's first message, and split the
 * small supporting skills into nineteen stubs.
 *
 * Build to delete: a model that keeps a long method in view without re-reading
 * it on every step makes the cap unnecessary.
 *
 * @module @evimed/dsh-socket/src/skillBodies
 */

/** The same ceiling the answer persona has, in characters. */
export const SKILL_BODY_MAX_CHARS = 32_000

/** A fence opener or closer: three or more backticks or tildes, up to three spaces in. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** A level-two heading and nothing deeper. */
const SECTION_HEADING = /^## (?!#)/

/**
 * A skill body split at its `##` headings, outside fenced code. Joining
 * `[preamble, ...sections.map(s => s.text)]` (empty preamble omitted) with a
 * newline gives back the body byte for byte.
 * @param {string} body
 * @returns {{ preamble: string, sections: { heading: string, text: string }[] }}
 */
export function splitSkillSections(body) {
  const lines = String(body ?? '').split('\n')
  /** @type {string[]} */
  const preamble = []
  /** @type {{ heading: string, lines: string[] }[]} */
  const sections = []
  let fenceChar = ''
  let fenceLength = 0
  for (const line of lines) {
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      if (!fenceChar) {
        fenceChar = marker[0]
        fenceLength = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLength && !fence[2].trim()) {
        fenceChar = ''
        fenceLength = 0
      }
    } else if (!fenceChar && SECTION_HEADING.test(line)) {
      sections.push({ heading: line.slice(3).trim(), lines: [line] })
      continue
    }
    if (sections.length) sections[sections.length - 1].lines.push(line)
    else preamble.push(line)
  }
  return {
    preamble: preamble.join('\n'),
    sections: sections.map((section) => ({ heading: section.heading, text: section.lines.join('\n') })),
  }
}

/**
 * The name a deferred section is loaded by. Kebab-case, because the kernel's
 * skill registry accepts nothing else, and ordinal rather than slugged: most
 * headings are Chinese or mixed, and a slug of them would be empty or unstable.
 * @param {string} skill @param {number} index 1-based position among the skill's `##` sections
 * @returns {string}
 */
export function sectionSkillName(skill, index) {
  return `${skill}-section-${String(index).padStart(2, '0')}`
}

/**
 * What stands in a capped body where a section was not inlined.
 * @param {string} name @param {{ heading: string, text: string }} section
 * @returns {string}
 */
function sectionStub(name, section) {
  return [
    `## ${section.heading}`,
    '',
    `〔本节 ${section.text.length} 字未随任务注入。用到它之前调用 \`skill\`，name 填 \`${name}\`；内容与原文逐字相同，可随时重新加载。〕`,
    '',
  ].join('\n')
}

/**
 * Cap a child's skill bodies.
 *
 * Under the cap the bodies pass through untouched. Over it, every body keeps
 * its preamble and every heading; the largest `##` sections, across all the
 * skills, are replaced one at a time by a stub naming the section skill that
 * carries their text, until the total fits in `maxChars`. A second pass puts
 * back, in document order, any replaced section the remaining room still
 * holds. Deterministic: the same bodies always produce the same split, so the
 * child's first message stays a stable prefix.
 *
 * @param {readonly { name: string, body: string }[]} bodies
 * @param {{ maxChars?: number }} [options]
 * @returns {{
 *   inline: { name: string, body: string }[],
 *   deferred: { skill: string, index: number, name: string, heading: string, chars: number, content: string }[],
 *   total: number,
 * }}
 */
export function capSkillBodies(bodies, options = {}) {
  const maxChars = options.maxChars ?? SKILL_BODY_MAX_CHARS
  const total = bodies.reduce((sum, skill) => sum + String(skill.body ?? '').length, 0)
  if (total <= maxChars) return { inline: bodies.map((skill) => ({ name: skill.name, body: skill.body })), deferred: [], total }

  const parsed = bodies.map((skill) => {
    const { preamble, sections } = splitSkillSections(skill.body)
    return {
      name: skill.name,
      preamble,
      sections: sections.map((section, position) => {
        const name = sectionSkillName(skill.name, position + 1)
        return { ...section, index: position + 1, name, stub: sectionStub(name, section), keep: true }
      }),
    }
  })
  /** @param {typeof parsed[number]} skill */
  const render = (skill) => [
    ...(skill.preamble ? [skill.preamble] : []),
    ...skill.sections.map((section) => (section.keep ? section.text : section.stub)),
  ].join('\n')

  // A stub and the text it stands for are joined by the same separator, so
  // swapping one for the other changes the size by exactly their difference.
  let size = parsed.reduce((sum, skill) => sum + render(skill).length, 0)
  const inOrder = parsed.flatMap((skill) => skill.sections)
  const largestFirst = inOrder
    .map((section, position) => ({ section, position }))
    .sort((left, right) => right.section.text.length - left.section.text.length || right.position - left.position)
    .map(({ section }) => section)
  for (const section of largestFirst) {
    if (size <= maxChars) break
    // A section shorter than its stub would grow the body by being deferred.
    if (section.text.length <= section.stub.length) continue
    section.keep = false
    size -= section.text.length - section.stub.length
  }
  for (const section of inOrder) {
    if (section.keep) continue
    const grows = section.text.length - section.stub.length
    if (size + grows > maxChars) continue
    section.keep = true
    size += grows
  }

  return {
    inline: parsed.map((skill) => ({ name: skill.name, body: render(skill) })),
    deferred: parsed.flatMap((skill) => skill.sections
      .filter((section) => !section.keep)
      .map((section) => ({
        skill: skill.name,
        index: section.index,
        name: section.name,
        heading: section.heading,
        chars: section.text.length,
        content: section.text,
      }))),
    total,
  }
}

/**
 * The skill a deferred section is registered as in its child's own scope.
 * `resourceDir` lets a relative path inside the section resolve against the
 * skill's own directory, the way it would in the whole body.
 * @param {{ skill: string, index: number, name: string, heading: string, content: string }} section
 * @param {string} skillsDir
 * @returns {{ name: string, description: string, content: string, resourceDir?: string }}
 */
export function deferredSectionSkill(section, skillsDir) {
  const heading = section.heading.length > 160 ? `${section.heading.slice(0, 157)}...` : section.heading
  return {
    name: section.name,
    description: `${section.skill} 的第 ${section.index} 节：${heading}`,
    content: section.content,
    ...(skillsDir ? { resourceDir: `${skillsDir.replace(/\/+$/, '')}/${section.skill}` } : {}),
  }
}
