export class MatchingContractError extends TypeError {
  constructor(code, path, message) {
    super(`${path}: ${message}`)
    this.name = 'MatchingContractError'
    this.code = code
    this.path = path
  }
}

export function check(condition, path, message, code = 'invalid_contract') {
  if (!condition) throw new MatchingContractError(code, path, message)
}

export function object(value, path, keys) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, 'expected a plain object')
  if (keys) for (const key of Object.keys(value)) check(keys.includes(key), `${path}.${key}`, 'unknown field')
  return value
}

export function text(value, path) {
  check(typeof value === 'string' && value.trim().length > 0, path, 'expected nonempty text')
  return value
}

export function identifier(value, path) {
  text(value, path)
  check(/^[A-Za-z0-9@][A-Za-z0-9@._:/+-]{0,199}$/.test(value), path, 'expected an opaque identifier')
  return value
}

export function oneOf(value, choices, path) {
  check(choices.includes(value), path, `expected one of ${choices.join(', ')}`)
  return value
}

export function array(value, path, validate) {
  check(Array.isArray(value), path, 'expected an array')
  if (validate) value.forEach((item, index) => validate(item, `${path}[${index}]`))
  return value
}

export function unique(value, path, key = (item) => item) {
  const keys = value.map(key)
  check(new Set(keys).size === keys.length, path, 'duplicate identity', 'duplicate_identity')
  return value
}

export function integer(value, path, minimum = 0) {
  check(Number.isSafeInteger(value) && value >= minimum, path, 'expected a bounded integer')
  return value
}

export function digest(value, path) {
  check(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), path, 'expected a SHA-256 digest')
  return value
}

export function schema(value, path) {
  check(value.schemaVersion === '1', `${path}.schemaVersion`, 'unsupported schema version', 'unsupported_schema')
}

export function strings(value, path) { return array(value, path, text) }
