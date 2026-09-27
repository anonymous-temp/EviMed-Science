/**
 * The shipped DTCG export (`dist/dtcg/`) read against the official DTCG
 * 2025.10 JSON Schemas (spec §11.6 rule 3; appendix E.6 #11).
 *
 * `dtcgFormat.test.mjs` holds the format rules as code and runs everywhere.
 * This file adds the community group's own schemas, without a dependency and
 * without the network: CI downloads the two published files
 * (`https://www.designtokens.org/schemas/2025.10/format.json` and
 * `…/resolver.json`) into a directory and names it in `DTCG_SCHEMA_DIR`
 * (`.github/workflows/web.yml`, "Validate the DTCG export against the official
 * schema"). With no directory, or with the files missing, the schema check
 * skips — a download that failed is not a defect in the export — and the
 * validator's own test below still runs.
 *
 * The validator is the draft-07 subset those two files use. Each published
 * file is a bundle: every module is a definition carrying its own `$id`, and a
 * `$ref` is resolved against the nearest `$id`, as draft-07 says. `format` is
 * an annotation (draft-07 does not require it to be asserted), so it is not
 * checked. A keyword the validator does not know fails the test rather than
 * being skipped, so a schema that starts relying on one cannot pass quietly.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const DIR = new URL('../dist/dtcg/', import.meta.url)
const SCHEMA_DIR = process.env.DTCG_SCHEMA_DIR ?? ''
const FORMAT = 'https://www.designtokens.org/schemas/2025.10/format.json'
const RESOLVER = 'https://www.designtokens.org/schemas/2025.10/resolver.json'

/** Keywords that only describe (draft-07 §9, §10) or that this subset reads through `$id` / `$ref`. */
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'definitions', 'default', 'examples', 'format', 'readOnly', 'writeOnly'])
/** Keywords the validator asserts. */
const ASSERTIONS = new Set([
  '$ref', 'type', 'const', 'enum', 'properties', 'patternProperties', 'additionalProperties', 'required',
  'minProperties', 'maxProperties', 'items', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
])
/** Keywords whose value is a map of names to schemas, not a schema. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', 'definitions'])

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function same(a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]))
  }
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
}

/** @param {unknown} value @param {string} type */
function hasType(value, type) {
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    default: throw new Error(`unknown type "${type}"`)
  }
}

/** A JSON pointer segment, unescaped (RFC 6901). @param {string} segment */
const unescapePointer = (segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~')

/**
 * Every keyword a schema tree uses where a keyword can stand.
 * @param {unknown} node @param {Set<string>} [into]
 */
export function keywordsOf(node, into = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) keywordsOf(item, into)
    return into
  }
  if (!isObject(node)) return into
  for (const [key, value] of Object.entries(node)) {
    into.add(key)
    if (key === 'const' || key === 'enum' || key === 'default' || key === 'examples') continue
    if (SCHEMA_MAPS.has(key) && isObject(value)) for (const child of Object.values(value)) keywordsOf(child, into)
    else keywordsOf(value, into)
  }
  return into
}

/**
 * A validator over one or more schema documents. Every subschema with an `$id`
 * is a resource a `$ref` can name; `validate(id, value)` returns the problems
 * as `path: what`, empty when the value is valid.
 * @param {unknown[]} documents
 */
export function createValidator(documents) {
  /** @type {Map<string, { schema: any, base: string }>} */
  const resources = new Map()
  /** @param {unknown} node @param {string} base */
  const register = (node, base) => {
    if (Array.isArray(node)) {
      for (const item of node) register(item, base)
      return
    }
    if (!isObject(node)) return
    let here = base
    if (typeof node.$id === 'string') {
      here = new URL(node.$id, base || undefined).href.replace(/#$/, '')
      resources.set(here, { schema: node, base: here })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'const' || key === 'enum' || key === 'default' || key === 'examples') continue
      if (SCHEMA_MAPS.has(key) && isObject(value)) for (const child of Object.values(value)) register(child, here)
      else register(value, here)
    }
  }
  for (const document of documents) register(document, '')

  /** @param {string} reference @param {string} base */
  function resolve(reference, base) {
    const url = new URL(reference, base || undefined)
    const address = url.href.replace(/#.*$/, '')
    const resource = resources.get(address)
    if (!resource) throw new Error(`$ref ${reference} names no schema this validator holds (from ${base || 'the root'})`)
    let schema = resource.schema
    const pointer = url.hash.replace(/^#/, '')
    if (pointer) {
      for (const segment of pointer.split('/').slice(1).map(unescapePointer)) {
        schema = Array.isArray(schema) ? schema[Number(segment)] : schema?.[segment]
        if (schema === undefined) throw new Error(`$ref ${reference} points at nothing`)
      }
    }
    return { schema, base: address }
  }

  /**
   * @param {any} schema @param {unknown} value @param {string} base @param {string} path
   * @returns {string[]}
   */
  function check(schema, value, base, path) {
    if (schema === true) return []
    if (schema === false) return [`${path}: no value is allowed here`]
    if (!isObject(schema)) throw new Error(`${path}: a schema must be an object or a boolean`)
    if (typeof schema.$id === 'string') base = new URL(schema.$id, base || undefined).href.replace(/#$/, '')
    // Draft-07: beside `$ref`, every other keyword is ignored.
    if (typeof schema.$ref === 'string') {
      const target = resolve(schema.$ref, base)
      return check(target.schema, value, target.base, path)
    }
    for (const keyword of Object.keys(schema)) {
      if (!ASSERTIONS.has(keyword) && !ANNOTATIONS.has(keyword)) throw new Error(`${path}: keyword "${keyword}" is not supported`)
    }
    /** @type {string[]} */
    const problems = []
    const fail = (/** @type {string} */ what) => problems.push(`${path}: ${what}`)
    const below = (/** @type {any} */ child, /** @type {unknown} */ childValue, /** @type {string} */ childPath) => {
      problems.push(...check(child, childValue, base, childPath))
    }
    const passes = (/** @type {any} */ child) => check(child, value, base, path).length === 0

    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type]
      if (!types.some((type) => hasType(value, type))) fail(`is not ${types.join(' | ')}`)
    }
    if ('const' in schema && !same(value, schema.const)) fail(`is not ${JSON.stringify(schema.const)}`)
    if (Array.isArray(schema.enum) && !schema.enum.some((/** @type {unknown} */ option) => same(value, option))) {
      fail(`is not one of ${JSON.stringify(schema.enum)}`)
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`is below ${schema.minimum}`)
      if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`is above ${schema.maximum}`)
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(`is not above ${schema.exclusiveMinimum}`)
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(`is not below ${schema.exclusiveMaximum}`)
      if (typeof schema.multipleOf === 'number' && !Number.isInteger(value / schema.multipleOf)) fail(`is not a multiple of ${schema.multipleOf}`)
    }
    if (typeof value === 'string') {
      const length = [...value].length
      if (typeof schema.minLength === 'number' && length < schema.minLength) fail(`is shorter than ${schema.minLength}`)
      if (typeof schema.maxLength === 'number' && length > schema.maxLength) fail(`is longer than ${schema.maxLength}`)
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(`does not match ${schema.pattern}`)
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`has fewer than ${schema.minItems} items`)
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`has more than ${schema.maxItems} items`)
      if (schema.uniqueItems === true && value.some((item, index) => value.findIndex((other) => same(item, other)) !== index)) fail('repeats an item')
      if (Array.isArray(schema.items)) {
        schema.items.forEach((/** @type {any} */ child, /** @type {number} */ index) => {
          if (index < value.length) below(child, value[index], `${path}/${index}`)
        })
        if (schema.additionalItems !== undefined) {
          for (let index = schema.items.length; index < value.length; index += 1) below(schema.additionalItems, value[index], `${path}/${index}`)
        }
      } else if (schema.items !== undefined) {
        value.forEach((item, index) => below(schema.items, item, `${path}/${index}`))
      }
    }
    if (isObject(value)) {
      const names = Object.keys(value)
      if (typeof schema.minProperties === 'number' && names.length < schema.minProperties) fail(`has fewer than ${schema.minProperties} properties`)
      if (typeof schema.maxProperties === 'number' && names.length > schema.maxProperties) fail(`has more than ${schema.maxProperties} properties`)
      for (const name of Array.isArray(schema.required) ? schema.required : []) {
        if (!Object.hasOwn(value, name)) fail(`lacks "${name}"`)
      }
      const patterns = Object.entries(isObject(schema.patternProperties) ? schema.patternProperties : {})
        .map(([pattern, child]) => /** @type {[RegExp, any]} */ ([new RegExp(pattern, 'u'), child]))
      for (const name of names) {
        const childPath = `${path}/${name}`
        let matched = false
        if (isObject(schema.properties) && Object.hasOwn(schema.properties, name)) {
          matched = true
          below(schema.properties[name], value[name], childPath)
        }
        for (const [pattern, child] of patterns) {
          if (!pattern.test(name)) continue
          matched = true
          below(child, value[name], childPath)
        }
        if (!matched && schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) fail(`"${name}" is not allowed`)
          else below(schema.additionalProperties, value[name], childPath)
        }
      }
    }
    if (Array.isArray(schema.allOf)) for (const child of schema.allOf) below(child, value, path)
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some(passes)) fail('matches none of anyOf')
    if (Array.isArray(schema.oneOf)) {
      const count = schema.oneOf.filter(passes).length
      if (count !== 1) fail(`matches ${count} of oneOf, not exactly one`)
    }
    if (schema.not !== undefined && passes(schema.not)) fail('matches what "not" forbids')
    if (schema.if !== undefined) {
      if (passes(schema.if)) {
        if (schema.then !== undefined) below(schema.then, value, path)
      } else if (schema.else !== undefined) below(schema.else, value, path)
    }
    return problems
  }

  return {
    /** @param {string} id @param {unknown} value */
    validate(id, value) {
      const resource = resources.get(id)
      if (!resource) throw new Error(`no schema has the $id ${id}`)
      return check(resource.schema, value, resource.base, '')
    },
  }
}

test('the validator asserts each keyword it claims to, and follows $ref through $id', () => {
  const colour = {
    $id: 'https://example.test/colour.json',
    type: 'object',
    required: ['components'],
    properties: { components: { $ref: '#/definitions/three' }, hex: { type: 'string', pattern: '^#[0-9a-f]{6}$' } },
    additionalProperties: false,
    definitions: { three: { type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 3, maxItems: 3 } },
  }
  const root = {
    $id: 'https://example.test/root.json',
    type: 'object',
    patternProperties: { '^[^$]': { $ref: 'https://example.test/colour.json' } },
    properties: { $kind: { enum: ['a', 'b'] }, $one: { oneOf: [{ type: 'string' }, { const: 'x' }] }, $not: { not: { type: 'null' } } },
    additionalProperties: false,
    if: { required: ['$kind'], properties: { $kind: { const: 'b' } } },
    then: { required: ['$one'] },
    definitions: { colour },
  }
  const { validate } = createValidator([root])
  assert.deepEqual(validate('https://example.test/root.json', { brand: { components: [0, 0.5, 1], hex: '#005dc1' } }), [])
  const said = validate('https://example.test/root.json', {
    short: { components: [0, 1] },
    bright: { components: [0, 2, 1], hex: '#FFF', alpha: 1 },
    none: {},
    $kind: 'b',
    $not: null,
    $other: 1,
  }).join('\n')
  for (const expected of [
    /\/short\/components: has fewer than 3 items/, /\/bright\/components\/1: is above 1/, /\/bright\/hex: does not match/,
    /\/bright: "alpha" is not allowed/, /\/none: lacks "components"/, /: lacks "\$one"/, /\/\$not: matches what "not" forbids/,
    /: "\$other" is not allowed/,
  ]) assert.match(said, expected)
  // `const: 'x'` is also a string, so "x" matches both branches and oneOf fails.
  assert.match(validate('https://example.test/root.json', { $one: 'x' }).join('\n'), /\/\$one: matches 2 of oneOf/)
  assert.throws(() => createValidator([{ $id: 'https://example.test/u.json', unevaluatedProperties: false }]).validate('https://example.test/u.json', {}), /"unevaluatedProperties" is not supported/)
  assert.throws(() => createValidator([{ $id: 'https://example.test/r.json', $ref: 'elsewhere.json' }]).validate('https://example.test/r.json', {}), /names no schema/)
})

/** The two published schema files, when CI has fetched them. */
function officialSchemas() {
  if (!SCHEMA_DIR) return null
  const paths = ['format.json', 'resolver.json'].map((name) => join(SCHEMA_DIR, name))
  if (!paths.every((path) => existsSync(path))) return null
  return paths.map((path) => JSON.parse(readFileSync(path, 'utf8')))
}

test('the shipped export is valid against the official DTCG 2025.10 schemas', (t) => {
  const schemas = officialSchemas()
  if (!schemas) {
    t.skip('DTCG_SCHEMA_DIR does not hold format.json and resolver.json (CI downloads them)')
    return
  }
  assert.deepEqual(schemas.map((schema) => schema.$id), [FORMAT, RESOLVER], 'the files are the 2025.10 schemas')
  const unknown = [...keywordsOf(schemas)].filter((keyword) => !ASSERTIONS.has(keyword) && !ANNOTATIONS.has(keyword))
  assert.deepEqual(unknown, [], 'the schemas use a keyword this validator does not assert')
  const { validate } = createValidator(schemas)

  const names = readdirSync(DIR).filter((name) => name.endsWith('.json')).sort()
  assert.deepEqual(names, [
    'base.tokens.json', 'dark.tokens.json', 'evimed.resolver.json', 'light.tokens.json', 'motion-full.tokens.json', 'motion-reduced.tokens.json',
  ])
  for (const name of names) {
    const file = JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))
    assert.deepEqual(validate(name.endsWith('.resolver.json') ? RESOLVER : FORMAT, file), [], name)
  }

  // The same check fails on what the format forbids, so a pass is not an
  // accident of an empty walk: a name with a dot, a colour with two
  // components, a size in a unit the format does not have, a type it does not
  // define, and a resolver without its version.
  const broken = {
    'a.b': { $type: 'color', $value: { colorSpace: 'srgb', components: [0, 0.4, 0.8], hex: '#0066cc' } },
    pale: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1], hex: '#ffffff' } },
    far: { $type: 'dimension', $value: { value: 4, unit: 'em' } },
    odd: { $type: 'colour', $value: '#ffffff' },
  }
  const problems = validate(FORMAT, broken)
  for (const name of Object.keys(broken)) {
    assert.ok(problems.some((problem) => problem.startsWith(`/${name}`) || problem.includes(`"${name}"`)), `${name}: ${problems.join('\n')}`)
  }
  const resolver = JSON.parse(readFileSync(new URL('evimed.resolver.json', DIR), 'utf8'))
  delete resolver.version
  assert.match(validate(RESOLVER, resolver).join('\n'), /lacks "version"/)
})
