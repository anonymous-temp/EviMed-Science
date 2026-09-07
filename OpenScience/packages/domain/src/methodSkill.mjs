/**
 * What a learned method is, and every property of one that code can decide.
 *
 * Hidden knowledge: a method is not a new artefact type. It is an Agent Skills
 * `SKILL.md` — the same file format the runtime image already ships forty-five
 * of — stored as a `documents.kind="method"` row and mounted read-only into a
 * project's container. That choice is what makes the learning loop cheap: no
 * new table, no new loader, no new format, and a learned method is readable by
 * anyone who can read a skill.
 *
 * It also means two specifications have to hold at once, and they disagree:
 *
 *   - The Agent Skills open specification says `name` (<= 64 characters,
 *     kebab-case, equal to the directory name), `description` (<= 1024), and
 *     optionally `license`, `compatibility`, `metadata` (a *string to string*
 *     map) and `allowed-tools` (space separated, experimental).
 *   - DSH's `skill-filesystem` requires `name` and `description`, additionally
 *     understands `whenToUse`, `disable-model-invocation` and `user-invocable`,
 *     insists `metadata` be an object — and *ignores* `allowed-tools`,
 *     `license` and `compatibility` entirely.
 *
 * So our structured fields live where both are happy: routing text in
 * `whenToUse`, everything else as string values under `metadata`. Writing
 * `required_tools:` at the top level, which is what the first draft of this
 * module did, produces a key the specification does not define and the kernel
 * does not read — a field that looks like configuration and is decoration.
 *
 * The validator here decides only what is decidable: shape, closed
 * vocabularies, digests, acyclicity, byte budgets, and leakage. Whether a
 * method is *good* is a question for the paired evaluation in `evals/`, never
 * for a regex (development principle #1, and #5's ban on open-vocabulary prose
 * patterns). Every issue it can raise is in `METHOD_SKILL_ISSUE_CODES`, and a
 * test walks that list, because an issue code that no test constructs is a
 * rule nobody has ever seen fire.
 */
import { SKILL_AUTHORING_LIMITS } from './constants.mjs'
import { RUNTIME_SKILL_ROOTS } from './skillRoots.mjs'
import { unmountedToolReferences, MOUNTED_TOOL_NAMES } from './toolNames.mjs'
import { hasSensitiveText, sensitiveTextTokens } from './sensitiveText.mjs'

/** The `metadata.evimed_schema` value this module understands. */
export const METHOD_SKILL_SCHEMA = 'method-skill/1'

/**
 * What kind of thing the method is, as a label only.
 *
 * The pyramid level is *derived* from `depends_on` (see `methodGraph.mjs`), not
 * from this field. SkillPyramid's paper does the same: the level is relative to
 * what a skill depends on, so a self-declared tier would be a second, drifting
 * source of truth for something already computable.
 */
export const METHOD_ROLES = Object.freeze(['atomic', 'functional', 'abstract'])

/** Lifecycle of a method document. There is no review state: an approved method
 *  is effective immediately and is rolled back by restoring a revision. */
export const METHOD_STATUSES = Object.freeze(['candidate', 'approved', 'retired'])

/** What a distillation run may propose. `no_change` is a real answer and the
 *  most common one — a loop that must always produce something produces noise. */
export const METHOD_OPERATIONS = Object.freeze(['create', 'amend', 'merge', 'no_change'])

/** SkillPyramid's section template, which the distiller writes and the
 *  consolidation builder must preserve. */
export const METHOD_BODY_SECTIONS = Object.freeze([
  'Purpose', 'When to Use', 'Inputs', 'Workflow', 'Verification', 'Constraints', 'Output',
])

/** The two sections a rewrite may only ever grow (§6.4 builder hard rule). */
export const METHOD_PRESERVED_SECTIONS = Object.freeze(['Verification', 'Constraints'])

/** Directory prefixes a method's attached files may use. `references/` and
 *  `assets/` are legal in the Agent Skills specification but a learned method
 *  has no business shipping either; adding one later is a deliberate act. */
export const METHOD_FILE_PREFIXES = Object.freeze(['scripts/', 'tests/'])

/** Byte budget for all attached files together (§4.1). */
export const METHOD_FILES_MAX_BYTES = 64 * 1024

/** Python imports a code skill may not name. The runtime container has no
 *  egress, so this is defence in depth rather than the boundary — but a script
 *  that *tries* to reach the network is a script whose author misunderstood
 *  where it runs, and that is worth catching before it is mounted. */
export const METHOD_SCRIPT_DENIED_IMPORTS = Object.freeze([
  'socket', 'requests', 'urllib', 'urllib2', 'urllib3', 'http', 'httplib', 'http.client',
  'httpx', 'aiohttp', 'ftplib', 'smtplib', 'telnetlib', 'paramiko', 'subprocess', 'pty',
  'ctypes', 'multiprocessing', 'xmlrpc', 'websockets', 'websocket',
])

/**
 * Every issue this module can raise. Closed on purpose: the run side receives
 * these codes through the contract and repairs against them, so a code invented
 * at a call site is an instruction the run cannot act on.
 */
export const METHOD_SKILL_ISSUE_CODES = Object.freeze([
  'method_frontmatter_missing',
  'method_frontmatter_unterminated',
  'method_frontmatter_unsupported',
  'method_frontmatter_ambiguous_scalar',
  'method_name_missing',
  'method_name_shape',
  'method_name_directory_mismatch',
  'method_description_missing',
  'method_description_too_long',
  'method_when_to_use_missing',
  'method_invocation_flag_type',
  'method_legacy_camel_key',
  'method_metadata_shape',
  'method_metadata_schema_unknown',
  'method_role_unknown',
  'method_applies_when_missing',
  'method_not_when_missing',
  'method_allowed_tools_unknown',
  'method_unmounted_tool_reference',
  'method_depends_on_shape',
  'method_depends_on_self',
  'method_depends_on_unresolved',
  'method_derived_from_missing',
  'method_body_empty',
  'method_body_too_long',
  'method_body_section_missing',
  'method_reference_too_deep',
  'method_reuse_reference_shape',
  'method_skill_root_leak',
  'method_sensitive_content',
  'method_files_prefix',
  'method_files_path',
  'method_files_too_large',
  'method_files_incomplete',
  'method_script_shape',
  'method_script_import_denied',
  'method_script_absolute_path',
  'method_tool_config_invalid',
  'method_tool_config_mismatch',
])

/**
 * @typedef {object} MethodSkillIssue
 * @property {string} code   one of METHOD_SKILL_ISSUE_CODES
 * @property {string} message  what is wrong, phrased so a run can repair it
 * @property {string} [field]  the frontmatter key or file path at fault
 */

/**
 * @typedef {object} SkillFrontmatterResult
 * @property {Record<string, unknown>} frontmatter
 * @property {string} body
 * @property {MethodSkillIssue[]} issues
 */

/** @param {string} code @param {string} message @param {string} [field] @returns {MethodSkillIssue} */
function issue(code, message, field) {
  return field == null ? { code, message } : { code, message, field }
}

/* --------------------------------------------------------------- frontmatter */

const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_.-]*):[ \t]*(.*)$/
const NESTED_PATTERN = /^([ ]+)([A-Za-z][A-Za-z0-9_.-]*):[ \t]*(.*)$/
const BLOCK_SCALAR_PATTERN = /^[>|][-+]?$/
/** YAML 1.1 parsers read these bare words as booleans and YAML 1.2 does not.
 *  Which parser reads our file is not ours to decide, so we refuse the
 *  ambiguity rather than pick a winner. */
const AMBIGUOUS_SCALARS = new Set(['yes', 'no', 'on', 'off', 'True', 'False', 'TRUE', 'FALSE', 'null', 'Null', 'NULL', '~'])

/**
 * Parse one unquoted or quoted scalar.
 * @param {string} raw
 * @param {string} key
 * @param {MethodSkillIssue[]} issues
 * @returns {string | boolean}
 */
function parseScalar(raw, key, issues) {
  const text = raw.trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (AMBIGUOUS_SCALARS.has(text)) {
    issues.push(issue('method_frontmatter_ambiguous_scalar',
      `\`${key}\` is the bare word \`${text}\`, which one YAML version reads as a boolean or null and another as a string. Quote it.`, key))
    return text
  }
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2)
    || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    const inner = text.slice(1, -1)
    return text.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
  }
  if (/\s#/.test(text)) {
    issues.push(issue('method_frontmatter_unsupported',
      `\`${key}\` contains an unquoted \` #\`, which YAML reads as the start of a comment and this parser does not. Quote the value.`, key))
  }
  return text
}

/**
 * Read the `---` block at the top of a SKILL.md.
 *
 * A deliberately small YAML subset: scalars, folded and literal block scalars,
 * and exactly one level of nested map. Anything else is reported rather than
 * guessed at, because a frontmatter this parser and the kernel's real YAML read
 * differently is a method whose digest means nothing.
 * @param {string} text
 * @returns {SkillFrontmatterResult}
 */
export function parseSkillFrontmatter(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n')
  /** @type {MethodSkillIssue[]} */
  const issues = []
  const lines = source.split('\n')
  if (lines[0] !== '---') {
    return { frontmatter: {}, body: source, issues: [issue('method_frontmatter_missing', 'The file does not start with a `---` frontmatter block.')] }
  }
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') { close = index; break }
  }
  if (close < 0) {
    return { frontmatter: {}, body: '', issues: [issue('method_frontmatter_unterminated', 'The frontmatter block is never closed by a `---` line.')] }
  }
  const head = lines.slice(1, close)
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '')
  /** @type {Record<string, unknown>} */
  const frontmatter = {}

  let cursor = 0
  while (cursor < head.length) {
    const line = head[cursor]
    if (line.trim() === '' || line.trimStart().startsWith('#')) { cursor += 1; continue }
    if (/^\t/.test(line) || /\t/.test(line)) {
      issues.push(issue('method_frontmatter_unsupported', 'The frontmatter contains a tab; YAML forbids tabs for indentation.'))
      cursor += 1
      continue
    }
    const match = KEY_PATTERN.exec(line)
    if (!match) {
      issues.push(issue('method_frontmatter_unsupported', `Unsupported frontmatter line: ${JSON.stringify(line.slice(0, 80))}. Only \`key: value\`, block scalars, and one level of nested map are read here.`))
      cursor += 1
      continue
    }
    const key = match[1]
    const rest = match[2]
    cursor += 1

    if (BLOCK_SCALAR_PATTERN.test(rest.trim())) {
      /** @type {string[]} */
      const block = []
      while (cursor < head.length && (head[cursor].trim() === '' || /^\s+\S/.test(head[cursor]))) {
        block.push(head[cursor].trim())
        cursor += 1
      }
      while (block.length && block[block.length - 1] === '') block.pop()
      frontmatter[key] = rest.trim().startsWith('>') ? block.join(' ').trim() : block.join('\n')
      continue
    }

    if (rest.trim() === '') {
      /** @type {Record<string, string | boolean>} */
      const nested = {}
      let sawNested = false
      while (cursor < head.length) {
        const candidate = head[cursor]
        if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) { cursor += 1; continue }
        const inner = NESTED_PATTERN.exec(candidate)
        if (!inner) break
        sawNested = true
        const innerKey = inner[2]
        const innerRest = inner[3]
        cursor += 1
        if (BLOCK_SCALAR_PATTERN.test(innerRest.trim())) {
          /** @type {string[]} */
          const innerBlock = []
          while (cursor < head.length && (head[cursor].trim() === '' || /^\s\s+\S/.test(head[cursor]))) {
            innerBlock.push(head[cursor].trim())
            cursor += 1
          }
          while (innerBlock.length && innerBlock[innerBlock.length - 1] === '') innerBlock.pop()
          nested[innerKey] = innerRest.trim().startsWith('>') ? innerBlock.join(' ').trim() : innerBlock.join('\n')
          continue
        }
        if (innerRest.trim() === '') {
          issues.push(issue('method_frontmatter_unsupported', `\`${key}.${innerKey}\` nests a second level; only one level of nested map is supported.`, key))
          continue
        }
        nested[innerKey] = parseScalar(innerRest, `${key}.${innerKey}`, issues)
      }
      frontmatter[key] = sawNested ? nested : ''
      continue
    }

    frontmatter[key] = parseScalar(rest, key, issues)
  }
  return { frontmatter, body, issues }
}

/**
 * Render frontmatter back to a form this parser and a real YAML parser agree on.
 *
 * Every scalar is double-quoted with JSON escaping, which is valid YAML and
 * removes every ambiguity the parser above refuses. That makes rendering
 * canonical, which is what lets the digest be stable across a round trip.
 * @param {Record<string, unknown>} frontmatter
 * @returns {string}
 */
export function renderSkillFrontmatter(frontmatter) {
  /** @param {unknown} value @returns {string} */
  const scalar = (value) => (typeof value === 'boolean' ? String(value) : JSON.stringify(String(value ?? '')))
  const lines = ['---']
  for (const key of Object.keys(frontmatter)) {
    const value = frontmatter[key]
    if (value != null && typeof value === 'object') {
      lines.push(`${key}:`)
      const nested = /** @type {Record<string, unknown>} */ (value)
      for (const innerKey of Object.keys(nested)) lines.push(`  ${innerKey}: ${scalar(nested[innerKey])}`)
      continue
    }
    lines.push(`${key}: ${scalar(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** @param {Record<string, unknown>} frontmatter @param {string} body @returns {string} */
export function renderMethodSkill(frontmatter, body) {
  return `${renderSkillFrontmatter(frontmatter)}\n\n${String(body ?? '').trim()}\n`
}

/* ------------------------------------------------------------------ digests */

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value != null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = canonical(/** @type {Record<string, unknown>} */ (value)[key])
    }
    return out
  }
  return value
}

/**
 * The exact bytes a body is hashed over.
 *
 * Exported because the digest is taken in three places with two different hash
 * implementations — the control plane has `node:crypto`, and the socket bundle
 * deliberately does not (it uses WebCrypto so a plugin stays loadable wherever
 * the kernel runs it). What must be identical is not the hash function but what
 * is fed to it, so that is what lives here.
 * @param {string} text @returns {string}
 */
export function normalizeSkillBody(text) {
  return `${String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`
}

/** @param {string} text @returns {string} */
function normalizeText(text) {
  return normalizeSkillBody(text)
}

/**
 * @typedef {object} MethodPayload
 * @property {Record<string, unknown>} frontmatter
 * @property {string} body
 * @property {Record<string, string>} [files]
 */

/**
 * The exact bytes a method's digest is taken over.
 *
 * Split out from the digest itself because `@evimed/domain` loads in a browser
 * and in a plugin sandbox and therefore may not reach for `node:crypto`. The
 * canonicalisation is the part that must exist only once — three places compute
 * this digest (the control plane, the capsule plugin that mounts methods, and
 * the delegation receipt) and a method whose digest differs between them would
 * reset its own usage counters on every run.
 * @param {MethodPayload} payload
 * @returns {string}
 */
export function methodDigestInput(payload) {
  const frontmatter = JSON.stringify(canonical(payload?.frontmatter ?? {}))
  const body = normalizeText(payload?.body ?? '')
  const files = payload?.files ?? {}
  const filePart = Object.keys(files).sort().map((path) => `${path}\n${normalizeText(files[path])}`).join('')
  return `${frontmatter}\n${body}${filePart}`
}

/**
 * @param {MethodPayload} payload
 * @param {(text: string) => string} sha256  hex digest of a utf-8 string
 * @returns {string}
 */
export function methodContentDigest(payload, sha256) {
  return `sha256:${sha256(methodDigestInput(payload))}`
}

/**
 * The digest of a skill body on its own, as the delegation receipt and the
 * capsule mount record it. Normalised the same way as a method body so a method
 * mounted as a skill hashes identically on both paths.
 * @param {string} body
 * @param {(text: string) => string} sha256
 * @returns {string}
 */
export function skillBodyDigest(body, sha256) {
  return `sha256:${sha256(normalizeText(body))}`
}

/**
 * The digest of a method as the runtime mounts it.
 *
 * Three parties have to agree on this number or the counters are meaningless:
 * whatever writes the method into the mounted directory, the plugin that reads
 * that directory back and hashes it into the delegation receipt, and the
 * control plane that folds the receipt into `(method, digest)` counters. They
 * hash the *file*, not the payload — frontmatter included — so the payload's
 * own `contentDigest` is the wrong number here and using it would silently
 * attribute every run to a digest no receipt can ever carry.
 *
 * @param {MethodPayload} payload
 * @param {(text: string) => string} sha256
 * @returns {string}
 */
export function mountedMethodDigest(payload, sha256) {
  return skillBodyDigest(renderMethodSkill(payload?.frontmatter ?? {}, payload?.body ?? ''), sha256)
}

/** @param {string} value @returns {boolean} */
export function isMethodDigest(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value ?? ''))
}

/* ------------------------------------------------------------- dependencies */

/**
 * @typedef {object} MethodDependency
 * @property {string} name
 * @property {string} digest
 */

/**
 * Read `metadata.depends_on`, which is a comma-separated `name@sha256:...` list.
 *
 * A plain name would have been friendlier and wrong: a dependency that is not
 * pinned to a digest silently re-points at whatever that name means later,
 * which is how a rewritten sub-method changes the meaning of every method that
 * reuses it without any of them recording a revision.
 * @param {unknown} value
 * @returns {{dependencies: MethodDependency[], malformed: string[]}}
 */
export function parseDependsOn(value) {
  /** @type {MethodDependency[]} */
  const dependencies = []
  /** @type {string[]} */
  const malformed = []
  const text = typeof value === 'string' ? value : ''
  for (const entry of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = entry.lastIndexOf('@')
    const name = at < 0 ? '' : entry.slice(0, at)
    const digest = at < 0 ? '' : entry.slice(at + 1)
    if (!name || !isMethodDigest(digest)) { malformed.push(entry); continue }
    dependencies.push({ name, digest })
  }
  return { dependencies, malformed }
}

/** @param {readonly MethodDependency[]} dependencies @returns {string} */
export function formatDependsOn(dependencies) {
  return dependencies.map((entry) => `${entry.name}@${entry.digest}`).join(', ')
}

/**
 * SkillPyramid's reuse reference, as it appears inline in a body:
 * `[reuse method: <name> | when: <trigger> | provides: <capability>]`.
 * The paper's tuple is (name, identity, condition, capability); the identity is
 * the digest, which lives in `depends_on` rather than in the prose so the prose
 * stays readable.
 */
const REUSE_PATTERN = /\[reuse method:([^|\]]*)\|\s*when:([^|\]]*)\|\s*provides:([^\]]*)\]/g
/** Anything that opens like a reuse reference but does not match the grammar. */
const REUSE_LOOSE_PATTERN = /\[reuse method:[^\]]*\]/g

/**
 * @param {string} body
 * @returns {{references: {name: string, when: string, provides: string}[], malformed: string[]}}
 */
export function parseReuseReferences(body) {
  const source = String(body ?? '')
  /** @type {{name: string, when: string, provides: string}[]} */
  const references = []
  const wellFormed = new Set()
  for (const match of source.matchAll(new RegExp(REUSE_PATTERN.source, 'g'))) {
    references.push({ name: match[1].trim(), when: match[2].trim(), provides: match[3].trim() })
    wellFormed.add(match[0])
  }
  const malformed = [...source.matchAll(new RegExp(REUSE_LOOSE_PATTERN.source, 'g'))]
    .map((match) => match[0])
    .filter((text) => !wellFormed.has(text))
  return { references, malformed }
}

/* ---------------------------------------------------------------- body shape */

/**
 * The `## ` headings a body actually carries, in order.
 * @param {string} body
 * @returns {string[]}
 */
export function methodBodySections(body) {
  return [...String(body ?? '').matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((match) => match[1].trim())
}

/**
 * The bullet or numbered items under the sections a rewrite may only grow.
 *
 * The consolidation builder is allowed to add a reuse reference to a method and
 * nothing else; SkillPyramid states the rule as "preserve the source skill's
 * procedures, constraints, edge cases and verification checks". Stated that way
 * it is a judgement. Stated as "the set of items under `## Verification` and
 * `## Constraints` may gain members and may not lose them", it is decidable,
 * which is the only form a validator can hold.
 * @param {string} body
 * @returns {string[]}
 */
export function preservedSectionItems(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n')
  /** @type {string[]} */
  const items = []
  let inside = false
  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line)
    if (heading) {
      inside = METHOD_PRESERVED_SECTIONS.includes(heading[1].trim())
      continue
    }
    if (!inside) continue
    const item = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+(.*\S)/.exec(line)
    if (item) items.push(item[1].replace(/\s+/g, ' ').trim())
  }
  return items
}

/**
 * Whether a rewrite kept every verification and constraint item the source had.
 * @param {string} before
 * @param {string} after
 * @returns {{ok: boolean, dropped: string[]}}
 */
export function preservedSectionsIntact(before, after) {
  const kept = new Set(preservedSectionItems(after))
  const dropped = preservedSectionItems(before).filter((item) => !kept.has(item))
  return { ok: dropped.length === 0, dropped }
}

/* ----------------------------------------------------------- code skills */

/**
 * The one shape a code skill's script may take, taken from EvoDS's creation
 * tool: a single top-level `def <name>(...)` plus an `if __name__ ==
 * '__main__':` block that calls it. The self-call is the script's own smoke
 * test and is what `runtime.exec-verify` runs.
 * @param {string} source
 * @returns {{name: string | null, parameters: {name: string, required: boolean}[], hasMain: boolean}}
 */
export function parsePythonToolShape(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n')
  const def = /^def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(([\s\S]*?)\)[ \t]*(?:->[^:]*)?:/m.exec(text)
  const hasMain = /^if[ \t]+__name__[ \t]*==[ \t]*['"]__main__['"][ \t]*:/m.test(text)
  if (!def) return { name: null, parameters: [], hasMain }
  /** @type {{name: string, required: boolean}[]} */
  const parameters = []
  let depth = 0
  let current = ''
  for (const character of `${def[2]},`) {
    if ('([{'.includes(character)) depth += 1
    if (')]}'.includes(character)) depth -= 1
    if (character === ',' && depth === 0) {
      const piece = current.trim()
      current = ''
      if (!piece || piece === '/' || piece === '*' || piece.startsWith('*')) continue
      const [declaration, ...defaults] = piece.split('=')
      const name = declaration.split(':')[0].trim()
      if (!name || name === 'self') continue
      parameters.push({ name, required: defaults.length === 0 })
      continue
    }
    current += character
  }
  return { name: def[1], parameters, hasMain }
}

/**
 * Whether a `scripts/<name>.tool.json` describes the function beside it.
 *
 * EvoDS's extraction prompt states three rules — the schema name must equal the
 * function name, required parameters are exactly those without defaults, and no
 * parameter may be invented or omitted. All three are decidable from the two
 * files, so none of them is left to the model to promise.
 * @param {string} scriptSource
 * @param {unknown} toolConfig
 * @param {string} path  the tool config's path, for the message
 * @param {string} [expectedName]  the file stem the pair is named after
 * @returns {MethodSkillIssue[]}
 */
export function toolConfigIssues(scriptSource, toolConfig, path, expectedName) {
  /** @type {MethodSkillIssue[]} */
  const issues = []
  const shape = parsePythonToolShape(scriptSource)
  if (!shape.name) {
    issues.push(issue('method_script_shape', `${path}: the script beside it has no top-level \`def\`; a code skill is one function plus a \`__main__\` self-call.`, path))
    return issues
  }
  if (!shape.hasMain) {
    issues.push(issue('method_script_shape', `${path}: the script has no \`if __name__ == '__main__':\` block, so there is nothing for the container to execute as its own check.`, path))
  }
  // The three files of a code skill are found by their shared stem, so the
  // function has to be named after the file. Without this the pair validates
  // happily and nothing can work out which function to call.
  if (expectedName && shape.name !== expectedName) {
    issues.push(issue('method_tool_config_mismatch', `${path}: the function is \`${shape.name}\` but the files are named after \`${expectedName}\`; a code skill's script, test, and schema share one stem and the function takes that name.`, path))
  }
  const config = /** @type {Record<string, unknown>} */ (toolConfig ?? {})
  const parameters = /** @type {Record<string, unknown>} */ (config.parameters ?? {})
  const properties = /** @type {Record<string, unknown>} */ (parameters.properties ?? {})
  const required = Array.isArray(parameters.required) ? parameters.required.map(String) : []
  if (typeof config.name !== 'string' || !config.name) {
    issues.push(issue('method_tool_config_invalid', `${path}: no \`name\`.`, path))
  } else if (config.name !== shape.name) {
    issues.push(issue('method_tool_config_mismatch', `${path}: names the tool \`${config.name}\` while the function is \`${shape.name}\`; they must be the same string.`, path))
  }
  if (typeof config.description !== 'string' || !config.description.trim()) {
    issues.push(issue('method_tool_config_invalid', `${path}: no \`description\`.`, path))
  }
  const declared = new Set(Object.keys(properties))
  const actual = new Set(shape.parameters.map((parameter) => parameter.name))
  for (const name of actual) {
    if (!declared.has(name)) issues.push(issue('method_tool_config_mismatch', `${path}: the function takes \`${name}\` and the schema omits it.`, path))
  }
  for (const name of declared) {
    if (!actual.has(name)) issues.push(issue('method_tool_config_mismatch', `${path}: the schema invents \`${name}\`, which the function does not take.`, path))
  }
  for (const name of declared) {
    const property = /** @type {Record<string, unknown>} */ (properties[name] ?? {})
    if (typeof property.type !== 'string' || !property.type) {
      issues.push(issue('method_tool_config_invalid', `${path}: \`${name}\` has no \`type\`.`, path))
    }
    if (typeof property.description !== 'string' || !property.description.trim()) {
      issues.push(issue('method_tool_config_invalid', `${path}: \`${name}\` has no \`description\`.`, path))
    }
  }
  const expected = shape.parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name).sort()
  const got = [...required].sort()
  if (expected.join(',') !== got.join(',')) {
    issues.push(issue('method_tool_config_mismatch',
      `${path}: \`required\` is [${got.join(', ')}] but the parameters without defaults are [${expected.join(', ')}].`, path))
  }
  return issues
}

/**
 * Static checks on a code skill's script: no network imports, no absolute
 * paths. Neither is the security boundary — the container has no egress and the
 * workspace is the only writable tree — but both catch a script written for a
 * machine it will never run on.
 * @param {string} source
 * @param {string} path
 * @returns {MethodSkillIssue[]}
 */
export function scriptStaticIssues(source, path) {
  /** @type {MethodSkillIssue[]} */
  const issues = []
  const text = String(source ?? '').replace(/\r\n/g, '\n')
  const denied = new Set(METHOD_SCRIPT_DENIED_IMPORTS)
  for (const match of text.matchAll(/^[ \t]*(?:import[ \t]+([A-Za-z_][\w.]*)|from[ \t]+([A-Za-z_][\w.]*)[ \t]+import)/gm)) {
    const module = (match[1] ?? match[2] ?? '').split('.')[0]
    const full = match[1] ?? match[2] ?? ''
    if (denied.has(module) || denied.has(full)) {
      issues.push(issue('method_script_import_denied',
        `${path}: imports \`${full}\`. A code skill runs inside the run's container, which has no network egress; reach for data through the tools instead.`, path))
    }
  }
  for (const match of text.matchAll(/['"](\/[A-Za-z0-9_.-][^'"\n]*)['"]/g)) {
    issues.push(issue('method_script_absolute_path',
      `${path}: names the absolute path ${JSON.stringify(match[1])}. Write paths relative to the workspace; the skill's own files resolve against its skill root.`, path))
  }
  return issues
}

/* --------------------------------------------------------------- validation */

/**
 * @typedef {object} MethodSkillInput
 * @property {Record<string, unknown>} frontmatter
 * @property {string} body
 * @property {Record<string, string>} [files]
 * @property {string} [directoryName]   the directory the skill will be written to
 * @property {readonly string[]} [mountedTools]  overrides the composition's tool set
 * @property {(dependency: MethodDependency) => boolean} [resolveDigest]
 * @property {boolean} [requireProvenance]  candidates must name where they came from
 */

/**
 * Everything about a method that code can decide.
 *
 * Returns a verdict, never a throw: the gate's contract is that a failing
 * package comes back with specific, actionable issues the run repairs in place
 * (development principle #3), and the same is true of a failing method.
 * @param {MethodSkillInput} input
 * @returns {{ok: boolean, issues: MethodSkillIssue[]}}
 */
export function validateMethodSkill(input) {
  /** @type {MethodSkillIssue[]} */
  const issues = []
  const frontmatter = input?.frontmatter ?? {}
  const body = String(input?.body ?? '')
  const files = input?.files ?? {}
  const mounted = new Set(input?.mountedTools ?? MOUNTED_TOOL_NAMES)

  /* name */
  const name = frontmatter.name
  if (typeof name !== 'string' || !name.trim()) {
    issues.push(issue('method_name_missing', 'Frontmatter has no `name`.', 'name'))
  } else {
    if (name.length > 64) issues.push(issue('method_name_shape', `\`name\` is ${name.length} characters; the specification allows 64.`, 'name'))
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      issues.push(issue('method_name_shape', `\`name\` must be lower-case kebab-case with no leading, trailing, or repeated hyphens; got ${JSON.stringify(name)}.`, 'name'))
    }
    if (input?.directoryName && input.directoryName !== name) {
      issues.push(issue('method_name_directory_mismatch', `\`name\` is ${JSON.stringify(name)} but the directory is ${JSON.stringify(input.directoryName)}; the loader addresses a skill by its directory.`, 'name'))
    }
  }

  /* description and routing */
  const description = frontmatter.description
  if (typeof description !== 'string' || !description.trim()) {
    issues.push(issue('method_description_missing', 'Frontmatter has no `description`. Without one the method is invisible to selection.', 'description'))
  } else if (description.length > SKILL_AUTHORING_LIMITS.maxDescriptionChars) {
    issues.push(issue('method_description_too_long', `\`description\` is ${description.length} characters; the limit is ${SKILL_AUTHORING_LIMITS.maxDescriptionChars}.`, 'description'))
  }
  const whenToUse = frontmatter.whenToUse
  if (typeof whenToUse !== 'string' || !whenToUse.trim()) {
    issues.push(issue('method_when_to_use_missing', 'Frontmatter has no `whenToUse`. It is the routing hint the kernel reads, and without it the method loads only when named.', 'whenToUse'))
  }

  /* invocation flags and the camelCase trap */
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (key in frontmatter && typeof frontmatter[key] !== 'boolean') {
      issues.push(issue('method_invocation_flag_type', `\`${key}\` must be a boolean.`, key))
    }
  }
  for (const key of ['disableModelInvocation', 'userInvocable', 'allowedTools', 'whenToUseText']) {
    if (key in frontmatter) {
      issues.push(issue('method_legacy_camel_key', `\`${key}\` is the old spelling; the kernel rejects it outright. Use its hyphenated form.`, key))
    }
  }

  /* allowed-tools: the specification's field, and our closed set */
  const allowedTools = frontmatter['allowed-tools']
  if (allowedTools != null && allowedTools !== '') {
    if (typeof allowedTools !== 'string') {
      issues.push(issue('method_allowed_tools_unknown', '`allowed-tools` must be a space-separated string.', 'allowed-tools'))
    } else {
      for (const tool of allowedTools.split(/\s+/).filter(Boolean)) {
        if (!mounted.has(tool) && !tool.startsWith('mcp__')) {
          issues.push(issue('method_allowed_tools_unknown', `\`allowed-tools\` names \`${tool}\`, which this composition does not mount.`, 'allowed-tools'))
        }
      }
    }
  }

  /* metadata: a string map, by the specification */
  const metadataValue = frontmatter.metadata
  /** @type {Record<string, unknown>} */
  let metadata = {}
  if (metadataValue == null) {
    issues.push(issue('method_metadata_shape', 'Frontmatter has no `metadata`; the structured fields of a method live there.', 'metadata'))
  } else if (typeof metadataValue !== 'object' || Array.isArray(metadataValue)) {
    issues.push(issue('method_metadata_shape', '`metadata` must be a map of string keys to string values.', 'metadata'))
  } else {
    metadata = /** @type {Record<string, unknown>} */ (metadataValue)
    for (const key of Object.keys(metadata)) {
      if (typeof metadata[key] !== 'string') {
        issues.push(issue('method_metadata_shape', `\`metadata.${key}\` is ${typeof metadata[key]}; the specification requires string values. Quote it.`, `metadata.${key}`))
      }
    }
    if (metadata.evimed_schema !== METHOD_SKILL_SCHEMA) {
      issues.push(issue('method_metadata_schema_unknown', `\`metadata.evimed_schema\` must be ${JSON.stringify(METHOD_SKILL_SCHEMA)}; got ${JSON.stringify(metadata.evimed_schema ?? null)}.`, 'metadata.evimed_schema'))
    }
    if (metadata.role != null && !METHOD_ROLES.includes(String(metadata.role))) {
      issues.push(issue('method_role_unknown', `\`metadata.role\` must be one of ${METHOD_ROLES.join(', ')}; got ${JSON.stringify(metadata.role)}.`, 'metadata.role'))
    }
    if (typeof metadata.applies_when !== 'string' || !metadata.applies_when.trim()) {
      issues.push(issue('method_applies_when_missing', '`metadata.applies_when` must say the situation this method is for.', 'metadata.applies_when'))
    }
    if (typeof metadata.not_when !== 'string' || !metadata.not_when.trim()) {
      issues.push(issue('method_not_when_missing', '`metadata.not_when` must say when this method does not apply. A method with no stated boundary is one that will be loaded everywhere.', 'metadata.not_when'))
    }
    if (input?.requireProvenance && (typeof metadata.derived_from !== 'string' || !metadata.derived_from.trim())) {
      issues.push(issue('method_derived_from_missing', '`metadata.derived_from` must name the run, feedback event, or method this was learned from.', 'metadata.derived_from'))
    }
  }

  /* dependencies */
  const { dependencies, malformed } = parseDependsOn(metadata.depends_on)
  for (const entry of malformed) {
    issues.push(issue('method_depends_on_shape', `\`metadata.depends_on\` entry ${JSON.stringify(entry)} is not \`name@sha256:<64 hex>\`.`, 'metadata.depends_on'))
  }
  for (const dependency of dependencies) {
    if (typeof name === 'string' && dependency.name === name) {
      issues.push(issue('method_depends_on_self', 'A method may not depend on itself.', 'metadata.depends_on'))
    }
    if (input?.resolveDigest && !input.resolveDigest(dependency)) {
      issues.push(issue('method_depends_on_unresolved', `\`${dependency.name}@${dependency.digest}\` does not resolve to a known method revision.`, 'metadata.depends_on'))
    }
  }

  /* body */
  if (!body.trim()) {
    issues.push(issue('method_body_empty', 'The method has no body.'))
  } else {
    const lines = body.replace(/\r\n/g, '\n').split('\n').length
    if (lines > SKILL_AUTHORING_LIMITS.maxBodyLines) {
      issues.push(issue('method_body_too_long', `The body is ${lines} lines; the authoring limit is ${SKILL_AUTHORING_LIMITS.maxBodyLines}. Move detail into a script or split the method.`))
    }
    const sections = new Set(methodBodySections(body))
    for (const section of METHOD_BODY_SECTIONS) {
      if (!sections.has(section)) issues.push(issue('method_body_section_missing', `The body has no \`## ${section}\` section.`))
    }
    for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      const depth = target.replace(/^\.\//, '').split('/').length - 1
      if (depth > SKILL_AUTHORING_LIMITS.maxReferenceDepth) {
        issues.push(issue('method_reference_too_deep', `The body links ${JSON.stringify(target)}, which is ${depth} directories deep; references may go one level.`))
      }
    }
    const reuse = parseReuseReferences(body)
    for (const text of reuse.malformed) {
      issues.push(issue('method_reuse_reference_shape', `${JSON.stringify(text)} is not \`[reuse method: <name> | when: <trigger> | provides: <capability>]\`.`))
    }
    const declared = new Set(dependencies.map((entry) => entry.name))
    for (const reference of reuse.references) {
      if (!declared.has(reference.name)) {
        issues.push(issue('method_depends_on_shape', `The body reuses \`${reference.name}\` but \`metadata.depends_on\` does not pin it to a digest.`, 'metadata.depends_on'))
      }
    }
    for (const root of RUNTIME_SKILL_ROOTS) {
      if (body.includes(root.path)) {
        issues.push(issue('method_skill_root_leak', `The body writes the absolute skill root ${root.path}. Reference your own files relatively; the run is told where the roots are.`))
      }
    }
    for (const tool of unmountedToolReferences(body)) {
      if (!mounted.has(tool)) {
        issues.push(issue('method_unmounted_tool_reference', `The body instructs the model to call \`${tool}\`, which this composition does not mount. A method that names an absent tool degrades the run silently.`))
      }
    }
    if (hasSensitiveText(body)) {
      issues.push(issue('method_sensitive_content', `The body carries ${sensitiveTextTokens(body).join(', ')}. A method is mounted into every later run of the project; it may not carry credentials or patient identifiers.`))
    }
  }

  /* attached files */
  let total = 0
  const scripts = new Set()
  const tests = new Set()
  const configs = new Set()
  for (const path of Object.keys(files)) {
    const content = String(files[path] ?? '')
    total += content.length
    if (!METHOD_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      issues.push(issue('method_files_prefix', `${path}: attached files must live under ${METHOD_FILE_PREFIXES.join(' or ')}.`, path))
      continue
    }
    if (!/^(?:scripts|tests)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(path) || path.includes('..')) {
      issues.push(issue('method_files_path', `${path}: not a safe relative path.`, path))
      continue
    }
    if (hasSensitiveText(content)) {
      issues.push(issue('method_sensitive_content', `${path} carries ${sensitiveTextTokens(content).join(', ')}.`, path))
    }
    if (path.endsWith('.tool.json')) {
      configs.add(path.slice('scripts/'.length, -'.tool.json'.length))
      continue
    }
    if (path.startsWith('scripts/') && path.endsWith('.py')) {
      scripts.add(path.slice('scripts/'.length, -'.py'.length))
      issues.push(...scriptStaticIssues(content, path))
      continue
    }
    if (path.startsWith('tests/') && path.endsWith('.py')) {
      tests.add(path.slice('tests/test_'.length, -'.py'.length))
    }
  }
  if (total > METHOD_FILES_MAX_BYTES) {
    issues.push(issue('method_files_too_large', `The attached files total ${total} bytes; the budget is ${METHOD_FILES_MAX_BYTES}.`))
  }
  for (const stem of scripts) {
    if (!configs.has(stem)) {
      issues.push(issue('method_files_incomplete', `scripts/${stem}.py has no scripts/${stem}.tool.json, so nothing describes how to call it.`, `scripts/${stem}.py`))
    }
    if (!tests.has(stem)) {
      issues.push(issue('method_files_incomplete', `scripts/${stem}.py has no tests/test_${stem}.py, so nothing verifies it before it is mounted.`, `scripts/${stem}.py`))
    }
  }
  for (const stem of configs) {
    const scriptPath = `scripts/${stem}.py`
    if (!scripts.has(stem)) {
      issues.push(issue('method_files_incomplete', `scripts/${stem}.tool.json describes a script that is not attached.`, `scripts/${stem}.tool.json`))
      continue
    }
    let parsed = null
    try {
      parsed = JSON.parse(files[`scripts/${stem}.tool.json`])
    } catch {
      issues.push(issue('method_tool_config_invalid', `scripts/${stem}.tool.json is not valid JSON.`, `scripts/${stem}.tool.json`))
      continue
    }
    issues.push(...toolConfigIssues(files[scriptPath], parsed, `scripts/${stem}.tool.json`, stem))
  }

  return { ok: issues.length === 0, issues }
}
