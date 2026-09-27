/**
 * The shipped DTCG export (`dist/dtcg/`) read against the DTCG 2025.10 format
 * rules (spec §11.6; appendix E.6 #15).
 *
 * The official JSON Schemas are not fetched: a test that needs the network is
 * a test CI cannot run offline, and a schema pinned by URL changes under it.
 * So the rules the Format, Color and Resolver modules state are written down
 * here instead, and applied to the files on disk — the bytes a designer
 * imports, not the generator's in-memory copy (`designTokens.test.mjs` reads
 * that one):
 *
 *  - a token is an object with `$value`; a group is any other object; names
 *    never begin with `$` and never contain `{`, `}` or `.`; the only `$`
 *    properties are the ones the format defines;
 *  - every token has a type — its own `$type`, the nearest group's, or the
 *    type of the token its alias points at — and the type is one the format
 *    defines, with a value of that type's shape;
 *  - an alias (`{group.token}`) resolves, in every combination of contexts
 *    the resolver can produce, to a token rather than a group, without a
 *    cycle, and to a token of the same type;
 *  - the resolver declares version 2025.10, every source it names is a file
 *    that was exported, every entry of its resolution order points at a set
 *    or a modifier it defines, every modifier's default is one of its
 *    contexts, and no exported token file is left out of it.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const DIR = new URL('../dist/dtcg/', import.meta.url)

/** The types the Format module defines (§8, §9). */
const TYPES = new Set([
  'color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number',
  'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography',
])
/** The Color module's colour spaces. */
const COLOR_SPACES = new Set([
  'srgb', 'srgb-linear', 'hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz-d65', 'xyz-d50',
])
const FONT_WEIGHTS = new Set([
  'thin', 'hairline', 'extra-light', 'ultra-light', 'light', 'normal', 'regular', 'book', 'medium',
  'semi-bold', 'demi-bold', 'bold', 'extra-bold', 'ultra-bold', 'black', 'heavy', 'extra-black', 'ultra-black',
])
const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'outset', 'inset'])
const TOKEN_PROPERTIES = new Set(['$value', '$type', '$description', '$extensions', '$deprecated'])
const GROUP_PROPERTIES = new Set(['$type', '$description', '$extensions', '$deprecated', '$extends', '$schema'])

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value */
const isAlias = (value) => typeof value === 'string' && /^\{[^{}]+\}$/.test(value)
/** @param {unknown} value */
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * What is wrong with one value of a declared type. An alias is checked by
 * `aliasProblems`, against the resolved tree, so it passes here.
 * @param {string} type @param {any} value @returns {string | null}
 */
function valueProblem(type, value) {
  if (isAlias(value)) return null
  switch (type) {
    case 'color': {
      if (!isObject(value)) return 'a colour is an object'
      if (!COLOR_SPACES.has(value.colorSpace)) return `colour space "${value.colorSpace}" is not one the Color module defines`
      if (!Array.isArray(value.components) || value.components.length !== 3
        || value.components.some((/** @type {unknown} */ c) => !isNumber(c) && c !== 'none')) return 'a colour has three components, numbers or "none"'
      if (value.alpha !== undefined && !(isNumber(value.alpha) && value.alpha >= 0 && value.alpha <= 1)) return 'alpha is a number from 0 to 1'
      if (value.hex !== undefined && !/^#[0-9a-fA-F]{6}$/.test(value.hex)) return 'hex is six hexadecimal digits after #'
      return null
    }
    case 'dimension':
      return isObject(value) && isNumber(value.value) && ['px', 'rem'].includes(value.unit) ? null : 'a dimension is { value, unit: px | rem }'
    case 'duration':
      return isObject(value) && isNumber(value.value) && ['ms', 's'].includes(value.unit) ? null : 'a duration is { value, unit: ms | s }'
    case 'number':
      return isNumber(value) ? null : 'a number is a JSON number'
    case 'fontFamily':
      return typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === 'string'))
        ? null : 'a font family is a name or a list of names'
    case 'fontWeight':
      return (isNumber(value) && value >= 1 && value <= 1000) || FONT_WEIGHTS.has(value) ? null : 'a font weight is 1–1000 or a named weight'
    case 'cubicBezier':
      return Array.isArray(value) && value.length === 4 && value.every(isNumber) && value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1
        ? null : 'a cubic Bézier is [x1, y1, x2, y2] with x in [0, 1]'
    case 'strokeStyle':
      return STROKE_STYLES.has(value) || (isObject(value) && Array.isArray(value.dashArray)) ? null : 'a stroke style is a keyword or { dashArray, lineCap }'
    default:
      // The composite types: an object (or, for shadow and gradient, a list).
      return isObject(value) || Array.isArray(value) ? null : `a ${type} is a composite value`
  }
}

/**
 * Every token of a tree, with the type it has or inherits, and every problem
 * of names, properties, types and values.
 * @param {Record<string, any>} tree @param {string} file
 */
function walkTokens(tree, file) {
  /** @type {{ path: string, token: Record<string, any>, type: string | undefined }[]} */
  const tokens = []
  /** @type {string[]} */
  const problems = []
  /** @param {Record<string, any>} group @param {string[]} path @param {string | undefined} inherited */
  const visit = (group, path, inherited) => {
    for (const key of Object.keys(group).filter((name) => name.startsWith('$'))) {
      if (!GROUP_PROPERTIES.has(key)) problems.push(`${file}:${path.join('.') || '(root)'}: "${key}" is not a group property`)
    }
    const groupType = typeof group.$type === 'string' ? group.$type : inherited
    for (const [name, node] of Object.entries(group)) {
      if (name.startsWith('$')) continue
      const at = [...path, name]
      if (/[{}.]/.test(name)) problems.push(`${file}:${at.join('.')}: a name may not contain { } or .`)
      if (!isObject(node)) {
        problems.push(`${file}:${at.join('.')}: neither a token nor a group`)
      } else if ('$value' in node) {
        for (const key of Object.keys(node)) {
          if (!TOKEN_PROPERTIES.has(key)) problems.push(`${file}:${at.join('.')}: "${key}" is not a token property`)
        }
        tokens.push({ path: at.join('.'), token: node, type: typeof node.$type === 'string' ? node.$type : groupType })
      } else {
        visit(node, at, groupType)
      }
    }
  }
  visit(tree, [], undefined)
  for (const { path, token, type } of tokens) {
    if (type === undefined) {
      if (!isAlias(token.$value)) problems.push(`${file}:${path}: no $type, none inherited, and not an alias`)
      continue
    }
    if (!TYPES.has(type)) {
      problems.push(`${file}:${path}: "${type}" is not a type the format defines`)
      continue
    }
    const problem = valueProblem(type, token.$value)
    if (problem) problems.push(`${file}:${path}: ${problem}`)
  }
  return { tokens, problems }
}

/** Deep merge in resolution order: a later source overrides an earlier one. @param {any[]} trees */
function merged(trees) {
  /** @param {any} into @param {any} from */
  const merge = (into, from) => {
    for (const [key, value] of Object.entries(from)) {
      if (isObject(value) && !('$value' in value) && isObject(into[key]) && !('$value' in into[key])) merge(into[key], value)
      else into[key] = JSON.parse(JSON.stringify(value))
    }
    return into
  }
  return trees.reduce((tree, next) => merge(tree, next), {})
}

/**
 * Aliases that do not resolve to a token, go round in a circle, or land on a
 * token of another type — and tokens whose only type would have come from one.
 * @param {Record<string, any>} tree @param {string} label
 */
function aliasProblems(tree, label) {
  const { tokens } = walkTokens(tree, label)
  const byPath = new Map(tokens.map((entry) => [entry.path, entry]))
  /** @type {string[]} */
  const problems = []
  let aliases = 0
  for (const entry of tokens) {
    if (!isAlias(entry.token.$value)) continue
    aliases += 1
    const seen = new Set([entry.path])
    let at = entry
    while (isAlias(at.token.$value)) {
      const target = String(at.token.$value).slice(1, -1)
      const next = byPath.get(target)
      if (!next) {
        problems.push(`${label}:${entry.path}: {${target}} is not a token`)
        break
      }
      if (seen.has(next.path)) {
        problems.push(`${label}:${entry.path}: its alias goes round in a circle`)
        break
      }
      seen.add(next.path)
      at = next
    }
    if (entry.type !== undefined && at.type !== undefined && !isAlias(at.token.$value) && entry.type !== at.type) {
      problems.push(`${label}:${entry.path}: a ${entry.type} that points at a ${at.type}`)
    }
    if (entry.type === undefined && at.type === undefined) problems.push(`${label}:${entry.path}: no type anywhere along its alias`)
  }
  return { problems, aliases }
}

/**
 * Every problem of an export: each file on its own, the resolver's shape and
 * references, and every combination of contexts it can resolve.
 * @param {Record<string, any>} files file name → parsed JSON
 * @param {string} resolverName
 */
function dtcgProblems(files, resolverName) {
  /** @type {string[]} */
  const problems = []
  let tokenCount = 0
  let combinations = 0
  let aliasCount = 0
  const resolver = files[resolverName]
  if (!isObject(resolver)) return { problems: [`${resolverName} is missing`], tokenCount, combinations, aliasCount }

  for (const [name, file] of Object.entries(files)) {
    if (name === resolverName) continue
    const walked = walkTokens(file, name)
    tokenCount += walked.tokens.length
    problems.push(...walked.problems)
  }

  if (resolver.version !== '2025.10') problems.push(`${resolverName}: version is "${resolver.version}", not 2025.10`)
  /** @type {Set<string>} */
  const referenced = new Set()
  /** @param {any} source @param {string} where @returns {any} */
  const load = (source, where) => {
    if (!isObject(source)) {
      problems.push(`${where}: a source is { $ref } or a token tree`)
      return {}
    }
    if (typeof source.$ref !== 'string') return source
    referenced.add(source.$ref)
    if (!isObject(files[source.$ref])) {
      problems.push(`${where}: ${source.$ref} was not exported`)
      return {}
    }
    return files[source.$ref]
  }
  const sets = isObject(resolver.sets) ? resolver.sets : {}
  const modifiers = isObject(resolver.modifiers) ? resolver.modifiers : {}
  for (const [name, set] of Object.entries(sets)) {
    if (!Array.isArray(set?.sources) || set.sources.length === 0) problems.push(`${resolverName}: set "${name}" has no sources`)
  }
  for (const [name, modifier] of Object.entries(modifiers)) {
    const contexts = isObject(modifier?.contexts) ? Object.keys(modifier.contexts) : []
    if (contexts.length === 0) problems.push(`${resolverName}: modifier "${name}" has no contexts`)
    if (modifier?.default !== undefined && !contexts.includes(modifier.default)) {
      problems.push(`${resolverName}: modifier "${name}" defaults to "${modifier.default}", which is not one of its contexts`)
    }
    for (const context of contexts) {
      if (!Array.isArray(modifier.contexts[context])) problems.push(`${resolverName}: ${name}/${context} is not a list of sources`)
    }
  }
  const order = Array.isArray(resolver.resolutionOrder) ? resolver.resolutionOrder : []
  if (order.length === 0) problems.push(`${resolverName}: no resolutionOrder`)
  /** @type {{ kind: 'sets' | 'modifiers', name: string }[]} */
  const steps = []
  for (const entry of order) {
    const match = /^#\/(sets|modifiers)\/([^/]+)$/.exec(String(entry?.$ref ?? ''))
    const kind = /** @type {'sets' | 'modifiers' | undefined} */ (match?.[1])
    if (!match || !kind || !(kind === 'sets' ? sets : modifiers)[match[2]]) {
      problems.push(`${resolverName}: resolutionOrder entry ${JSON.stringify(entry)} points at nothing it defines`)
      continue
    }
    steps.push({ kind, name: match[2] })
  }
  for (const name of Object.keys(sets)) {
    if (!steps.some((step) => step.kind === 'sets' && step.name === name)) problems.push(`${resolverName}: set "${name}" is never resolved`)
  }
  for (const name of Object.keys(modifiers)) {
    if (!steps.some((step) => step.kind === 'modifiers' && step.name === name)) problems.push(`${resolverName}: modifier "${name}" is never resolved`)
  }

  // Every combination of contexts: base, one theme, one motion setting.
  /** @type {Record<string, string>[]} */
  let choices = [{}]
  for (const step of steps.filter((entry) => entry.kind === 'modifiers')) {
    const contexts = Object.keys(modifiers[step.name]?.contexts ?? {})
    choices = choices.flatMap((choice) => contexts.map((context) => ({ ...choice, [step.name]: context })))
  }
  for (const choice of choices) {
    const label = Object.entries(choice).map(([modifier, context]) => `${modifier}=${context}`).join(',') || 'base'
    const trees = steps.flatMap((step) => (step.kind === 'sets'
      ? (sets[step.name].sources ?? []).map((/** @type {any} */ source) => load(source, `${resolverName}#/sets/${step.name}`))
      : (modifiers[step.name].contexts[choice[step.name]] ?? []).map((/** @type {any} */ source) => load(source, `${resolverName}#/modifiers/${step.name}/${choice[step.name]}`))))
    const resolved = aliasProblems(merged(trees), `[${label}]`)
    problems.push(...resolved.problems)
    aliasCount += resolved.aliases
    combinations += 1
  }

  for (const name of Object.keys(files)) {
    if (name !== resolverName && name.endsWith('.tokens.json') && !referenced.has(name)) {
      problems.push(`${name} is exported but the resolver never reads it`)
    }
  }
  return { problems: [...new Set(problems)], tokenCount, combinations, aliasCount }
}

const shipped = () => Object.fromEntries(
  readdirSync(DIR).filter((name) => name.endsWith('.json'))
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))]),
)

test('the shipped DTCG export keeps the 2025.10 format rules', () => {
  const files = shipped()
  // Prove the walk walked: every file, every combination, a real number of tokens.
  assert.deepEqual(Object.keys(files).sort(), [
    'base.tokens.json', 'dark.tokens.json', 'evimed.resolver.json', 'light.tokens.json', 'motion-full.tokens.json', 'motion-reduced.tokens.json',
  ])
  const result = dtcgProblems(files, 'evimed.resolver.json')
  assert.deepEqual(result.problems, [])
  assert.ok(result.tokenCount > 250, `only ${result.tokenCount} tokens were read`)
  assert.equal(result.combinations, 4, 'two themes × two motion settings')
})

test('the rules catch what they claim to catch', () => {
  const color = { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.3647, 0.7569], alpha: 1, hex: '#005dc1' } }
  const base = {
    color: { brand: color, $type: 'color', alias: { $value: '{color.brand}' } },
    size: { $type: 'dimension', ok: { $value: { value: 4, unit: 'px' } } },
  }
  const resolver = {
    version: '2025.10',
    sets: { base: { sources: [{ $ref: 'base.tokens.json' }] } },
    modifiers: { theme: { default: 'light', contexts: { light: [{ $ref: 'light.tokens.json' }] } } },
    resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/theme' }],
  }
  const good = dtcgProblems({ 'base.tokens.json': base, 'light.tokens.json': { role: { accent: { $value: '{color.brand}', $type: 'color' } } }, 'r.json': resolver }, 'r.json')
  assert.deepEqual(good.problems, [])
  assert.equal(good.aliasCount, 2, 'an alias across files resolves in the merged tree')
  // Type inherited from a group, and one resolved through an alias, both count.
  assert.equal(walkTokens(base, 'b').problems.length, 0)

  const broken = dtcgProblems({
    'base.tokens.json': {
      'a.b': color,
      untyped: { $value: 3 },
      odd: { $type: 'colour', $value: '#fff' },
      pale: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1], hex: '#fff' } },
      far: { $type: 'dimension', $value: { value: 4, unit: 'em' } },
      dangling: { $type: 'color', $value: '{color.nowhere}' },
      loop: { a: { $type: 'number', $value: '{loop.b}' }, b: { $type: 'number', $value: '{loop.a}' } },
      mistyped: { $type: 'number', $value: '{size}' },
      extra: { $type: 'number', $value: 1, $comment: 'x' },
      size: { $type: 'dimension', $value: { value: 1, unit: 'px' } },
    },
    'orphan.tokens.json': {},
    'r.json': {
      version: '2025.06',
      sets: { base: { sources: [{ $ref: 'base.tokens.json' }, { $ref: 'missing.tokens.json' }] } },
      modifiers: { theme: { default: 'sepia', contexts: { light: [] } } },
      resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/sets/other' }],
    },
  }, 'r.json')
  const said = broken.problems.join('\n')
  for (const expected of [
    /a name may not contain/, /untyped: no \$type/, /"colour" is not a type/, /three components/, /unit: px \| rem/,
    /\{color\.nowhere\} is not a token/, /circle/, /a number that points at a dimension/, /"\$comment" is not a token property/,
    /version is "2025\.06"/, /missing\.tokens\.json was not exported/, /defaults to "sepia"/, /#\/sets\/other/,
    /modifier "theme" is never resolved/, /orphan\.tokens\.json is exported but the resolver never reads it/,
  ]) assert.match(said, expected)
})
