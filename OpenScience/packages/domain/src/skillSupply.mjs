/**
 * What a skill package IS, and what it needs before it can run: its source,
 * licence, version, scripts, references, dependencies and supported
 * operations, as one record that travels with it.
 *
 * Hidden knowledge: until this module a skill carried a name and a digest and
 * nothing else. The facts that make a method package reproducible and
 * auditable were scattered over five unrelated files and one of them did not
 * exist for most packages:
 *
 *   - the curated pack's `inventory.json` knew each skill's executable
 *     dependencies and its content digest, but not the licence file or a
 *     version;
 *   - `community/sources.json` knew the repository, commit and licence of the
 *     two vendored skills, and nothing the skill itself runs;
 *   - a capability's `capability.yaml` knew its version and its platform tools,
 *     not the libraries its scripts import;
 *   - a personal skill imported from a public repository was fetched at an exact
 *     commit, previewed with that commit, and then stored with none of it — the
 *     confirm step sent only an upload id;
 *   - the SKILL.md bodies named libraries (`rdkit`, `gseapy`, `pysam`, ...) that
 *     the runtime image never installs, so a skill could be "installed" and
 *     unable to do what its own instructions say.
 *
 * The record below is the one shape all of them are read into, and the one
 * place "can this run here" is decided from. It is a LABEL (owner ruling
 * 2026-10-04): the findings it yields feed the availability projection
 * (`capabilityAvailability.mjs`), which never hides a package, disables a
 * button or refuses a dispatch.
 *
 * Two rules the record keeps:
 *
 * - **Unknown is a value.** A field the upstream does not supply is `null` (or
 *   an empty list) and `unknownFields` says which and why; nothing is
 *   synthesized. A package whose licence nobody recorded reads "licence
 *   unknown", never "MIT".
 * - **Observed dependencies are labelled as observed.** A library found by
 *   reading a package's own files carries `basis: 'observed'` and where it was
 *   seen; one a manifest declared carries `basis: 'declared'`. Nothing here
 *   claims a dependency list is complete, only that these are named.
 *
 * Pure: no clock, no files, no network. The hash function is supplied by the
 * caller (the domain is browser-safe), exactly as `extensions.mjs` does.
 *
 * @module @evimed/domain/src/skillSupply
 */

/** The record's schema version; a stored record of another version is read as absent. */
export const SKILL_PACKAGE_RECORD_VERSION = 1

/** Where a package comes from in the platform's own terms. */
export const SKILL_PACKAGE_ORIGINS = Object.freeze(['core', 'community', 'curated', 'office', 'capability', 'capability-skill', 'evimed', 'extension', 'personal'])

/**
 * How a package's bytes came to be here. `repository` is an exact public
 * commit; `derived` a package we rehabilitated from a named one without
 * recording the commit; `release` the platform's own tree, identified by its
 * release and its digest; `authored` written in the product; `upload` bytes a
 * researcher supplied; `builtin-copy` a built-in package copied to be edited.
 */
export const SKILL_SOURCE_KINDS = Object.freeze(['repository', 'derived', 'release', 'authored', 'upload', 'builtin-copy'])

/** What kind of thing a dependency is. */
export const SKILL_DEPENDENCY_KINDS = Object.freeze(['python-package', 'r-package', 'system-tool', 'platform-tool', 'model-weights', 'dataset', 'compute'])

/**
 * Who has to provide a dependency: the runtime `image`, the `platform` (a tool
 * or engine the deployment offers), the `deployment` (model weights it mounts),
 * or the `researcher` (their data, their machine, their credential — supplied
 * at the moment of use, never a limit on the package).
 */
export const SKILL_DEPENDENCY_SUPPLIES = Object.freeze(['image', 'platform', 'deployment', 'researcher'])

/** `declared` by a manifest, or `observed` in the package's own files. */
export const SKILL_DEPENDENCY_BASES = Object.freeze(['declared', 'observed'])

/** What an operation is. */
export const SKILL_OPERATION_KINDS = Object.freeze(['script', 'tool', 'deliverable', 'method'])

/** The parameter types an operation schema can name. */
export const SKILL_PARAM_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'path', 'object', 'array'])

const MAX_SCRIPTS = 96
const MAX_REFERENCES = 160
const MAX_DEPENDENCIES = 128
const MAX_OPERATIONS = 32
const MAX_PARAMS = 32

const SHA = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u
const LICENCE = /^[A-Za-z0-9][A-Za-z0-9.+() -]{0,79}$/u
const DEPENDENCY_NAME = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/u
const CONSTRAINT = /^(?:==|>=|<=|~=|!=|>|<)[0-9A-Za-z.*+_-]{1,63}$/u

/**
 * @typedef {object} SkillSource
 * @property {'repository'|'derived'|'release'|'authored'|'upload'|'builtin-copy'} kind
 * @property {string | null} repository `owner/name`, for a repository
 * @property {string | null} commit the exact 40-character commit, for a repository
 * @property {string | null} path the package's directory inside the repository, or the package it was derived from
 * @property {string | null} package the package or built-in skill name it was derived or copied from
 * @property {string | null} digest the bytes' digest: an upload's, or the built-in package's at the time it was copied
 *
 * @typedef {object} SkillLicence
 * @property {string | null} id an SPDX-style identifier, or null where only a licence file is known
 * @property {{ path: string, sha256: string } | null} file the licence file inside the package, when there is one
 * @property {'declared'|'inventory'|'file-present'} basis who said so
 *
 * @typedef {object} SkillFileRef
 * @property {string} path
 * @property {string} sha256
 *
 * @typedef {object} SkillDependency
 * @property {'python-package'|'r-package'|'system-tool'|'platform-tool'|'model-weights'|'dataset'|'compute'} kind
 * @property {string} name
 * @property {string | null} constraint `==1.2.3` and the like; null when none was stated
 * @property {'image'|'platform'|'deployment'|'researcher'} supply
 * @property {boolean} optional
 * @property {'declared'|'observed'} basis
 * @property {string | null} evidence where an observed dependency was seen
 *
 * @typedef {object} SkillOperationParam
 * @property {string} name
 * @property {'string'|'integer'|'number'|'boolean'|'path'|'object'|'array'} type
 * @property {boolean} required
 * @property {string | number | boolean | null} default
 * @property {string[] | null} values the closed list of values, when there is one
 * @property {number | null} min
 * @property {number | null} max
 * @property {string | null} unit
 * @property {string | null} description
 * @property {{ param: string, equals: string } | null} when the parameter applies only when another one has this value
 *
 * @typedef {object} SkillOperation
 * @property {string} name
 * @property {'script'|'tool'|'deliverable'|'method'} kind
 * @property {string | null} summary
 * @property {string | null} summaryZh
 * @property {string | null} entrypoint a script path inside the package
 * @property {SkillOperationParam[]} params
 * @property {string[]} accepts the formats or inputs the operation takes
 * @property {string[]} produces what it writes
 * @property {string[]} limits bounded statements of its limits ("no code execution")
 *
 * @typedef {object} SkillPackageRecord
 * @property {number} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {'core'|'community'|'curated'|'office'|'capability'|'capability-skill'|'evimed'|'extension'|'personal'} origin
 * @property {string | null} version
 * @property {SkillSource | null} source
 * @property {SkillLicence | null} licence
 * @property {string | null} digest `sha256:` of the package
 * @property {string | null} digestAlgorithm which function made `digest`
 * @property {SkillFileRef[]} scripts
 * @property {SkillFileRef[]} references
 * @property {SkillDependency[]} dependencies
 * @property {SkillOperation[]} operations
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @param {RegExp} pattern @returns {string | null} */
const matching = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null)
/** @param {unknown} value @param {number} limit @returns {string | null} */
const text = (value, limit) => (typeof value === 'string' && value.trim() && [...value].length <= limit && !value.includes('\0') ? value.trim() : null)
/** @param {unknown} value @returns {number | null} */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * A package-relative POSIX path, bounded and without a way out of the package.
 * @param {unknown} value @returns {string | null}
 */
export function packagePath(value) {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 240) return null
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null
  const parts = value.split('/')
  if (parts.length > 16 || parts.some((part) => !part || part === '.' || part === '..')) return null
  return value
}

/** @param {unknown} value @returns {SkillSource | null} */
function normalizeSource(value) {
  if (!isObject(value) || !SKILL_SOURCE_KINDS.includes(value.kind)) return null
  const kind = /** @type {SkillSource['kind']} */ (value.kind)
  const source = {
    kind,
    repository: matching(value.repository, REPOSITORY),
    commit: matching(value.commit, COMMIT),
    path: value.path == null ? null : (packagePath(value.path) ?? text(value.path, 200)),
    package: matching(value.package, NAME),
    digest: matching(value.digest, DIGEST),
  }
  // An exact repository source without its repository or its commit is not an exact source: it is dropped, not softened.
  if (kind === 'repository' && (!source.repository || !source.commit)) return null
  if (kind === 'upload' && !source.digest) return null
  if (kind === 'builtin-copy' && !source.package) return null
  return source
}

/** @param {unknown} value @returns {SkillLicence | null} */
function normalizeLicence(value) {
  if (!isObject(value) || !['declared', 'inventory', 'file-present'].includes(value.basis)) return null
  const id = matching(value.id, LICENCE)
  const path = isObject(value.file) ? packagePath(value.file.path) : null
  const sha256 = isObject(value.file) ? matching(value.file.sha256, SHA) : null
  const file = path && sha256 ? { path, sha256 } : null
  if (!id && !file) return null
  return { id, file, basis: /** @type {SkillLicence['basis']} */ (value.basis) }
}

/** @param {unknown} value @param {number} limit @returns {SkillFileRef[]} */
function normalizeFiles(value, limit) {
  if (!Array.isArray(value)) return []
  /** @type {Map<string, SkillFileRef>} */
  const files = new Map()
  for (const item of value) {
    if (!isObject(item)) continue
    const path = packagePath(item.path)
    const sha256 = matching(item.sha256, SHA)
    if (path && sha256 && !files.has(path)) files.set(path, { path, sha256 })
    if (files.size >= limit) break
  }
  return [...files.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * The default provider of a kind of dependency.
 * @param {string} kind @returns {SkillDependency['supply']}
 */
export function defaultDependencySupply(kind) {
  if (kind === 'platform-tool') return 'platform'
  if (kind === 'model-weights') return 'deployment'
  // A dataset is the researcher's own files, supplied at the moment of use (owner ruling 2026-10-04); the runtime
  // carries no datasets, so a package naming one as a limit would be wrong for every researcher who holds it.
  if (kind === 'dataset' || kind === 'compute') return 'researcher'
  return 'image'
}

/** @param {unknown} value @returns {SkillDependency | null} */
function normalizeDependency(value) {
  if (!isObject(value) || !SKILL_DEPENDENCY_KINDS.includes(value.kind)) return null
  const name = matching(value.name, DEPENDENCY_NAME)
  if (!name) return null
  const kind = /** @type {SkillDependency['kind']} */ (value.kind)
  const supply = SKILL_DEPENDENCY_SUPPLIES.includes(value.supply) ? /** @type {SkillDependency['supply']} */ (value.supply) : defaultDependencySupply(kind)
  return {
    kind,
    name,
    constraint: matching(value.constraint, CONSTRAINT),
    supply,
    optional: value.optional === true,
    basis: value.basis === 'observed' ? 'observed' : 'declared',
    evidence: value.evidence == null ? null : text(value.evidence, 240),
  }
}

/**
 * Merge two statements of the same dependency: a declaration outranks an
 * observation, a required use outranks an optional one, and a pin is kept.
 * @param {SkillDependency} left @param {SkillDependency} right @returns {SkillDependency}
 */
function mergeDependency(left, right) {
  const declared = left.basis === 'declared' ? left : right.basis === 'declared' ? right : left
  const other = declared === left ? right : left
  return {
    ...declared,
    constraint: declared.constraint ?? other.constraint,
    optional: left.optional && right.optional,
    evidence: declared.evidence ?? other.evidence,
  }
}

/** @param {unknown} value @returns {SkillDependency[]} */
function normalizeDependencies(value) {
  if (!Array.isArray(value)) return []
  /** @type {Map<string, SkillDependency>} */
  const found = new Map()
  for (const item of value) {
    const dependency = normalizeDependency(item)
    if (!dependency) continue
    const key = `${dependency.kind}\0${dependency.name.toLowerCase()}`
    const prior = found.get(key)
    found.set(key, prior ? mergeDependency(prior, dependency) : dependency)
    if (found.size >= MAX_DEPENDENCIES) break
  }
  return [...found.values()].sort((left, right) => (left.kind + left.name < right.kind + right.name ? -1 : 1))
}

/** @param {unknown} value @returns {SkillOperationParam | null} */
function normalizeParam(value) {
  if (!isObject(value) || !SKILL_PARAM_TYPES.includes(value.type)) return null
  const name = matching(value.name, /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,79}$/u)
  if (!name) return null
  const values = Array.isArray(value.values) ? value.values.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.length <= 80).slice(0, 32) : null
  const fallback = value.default
  return {
    name,
    type: /** @type {SkillOperationParam['type']} */ (value.type),
    required: value.required === true,
    default: ['string', 'number', 'boolean'].includes(typeof fallback) ? fallback : null,
    values: values && values.length ? values : null,
    min: finite(value.min),
    max: finite(value.max),
    unit: text(value.unit, 24),
    description: text(value.description, 200),
    when: isObject(value.when) && matching(value.when.param, /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,79}$/u) && typeof value.when.equals === 'string' && value.when.equals.length <= 80
      ? { param: value.when.param, equals: value.when.equals }
      : null,
  }
}

/** @param {unknown} value @param {number} limit @param {number} length @returns {string[]} */
function strings(value, limit, length) {
  if (!Array.isArray(value)) return []
  return value.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim() && item.length <= length && !item.includes('\0')).slice(0, limit)
}

/**
 * One supported operation as it may be stored and shown. Total: whatever does
 * not read as part of an operation is dropped, and an operation without a
 * usable name is `null`.
 * @param {unknown} value @returns {SkillOperation | null}
 */
export function normalizeSkillOperation(value) {
  if (!isObject(value) || !SKILL_OPERATION_KINDS.includes(value.kind)) return null
  const name = matching(value.name, /^[A-Za-z0-9][A-Za-z0-9_.:/ -]{0,99}$/u)
  if (!name) return null
  const params = Array.isArray(value.params) ? value.params.slice(0, MAX_PARAMS).map(normalizeParam).filter((/** @type {unknown} */ item) => item !== null) : []
  return {
    name,
    kind: /** @type {SkillOperation['kind']} */ (value.kind),
    summary: text(value.summary, 300),
    summaryZh: text(value.summaryZh, 150),
    entrypoint: value.entrypoint == null ? null : packagePath(value.entrypoint),
    params: /** @type {SkillOperationParam[]} */ (params),
    accepts: strings(value.accepts, 16, 80),
    produces: strings(value.produces, 16, 120),
    limits: strings(value.limits, 8, 160),
  }
}

/** @param {unknown} value @returns {SkillOperation[]} */
function normalizeOperations(value) {
  if (!Array.isArray(value)) return []
  /** @type {Map<string, SkillOperation>} */
  const found = new Map()
  for (const item of value) {
    const operation = normalizeSkillOperation(item)
    if (operation && !found.has(operation.name)) found.set(operation.name, operation)
    if (found.size >= MAX_OPERATIONS) break
  }
  return [...found.values()]
}

/**
 * A stored or submitted record, read back. Total: a record that does not read as
 * one is `null`, so a bad row can lose its own provenance and nothing else.
 * The record is rebuilt field by field — nothing the input carries beyond the
 * fields below survives, so a record cannot smuggle authority into the product.
 * @param {unknown} value @returns {SkillPackageRecord | null}
 */
export function normalizeSkillPackageRecord(value) {
  if (!isObject(value) || value.schemaVersion !== SKILL_PACKAGE_RECORD_VERSION || !SKILL_PACKAGE_ORIGINS.includes(value.origin)) return null
  const id = matching(value.id, ID)
  const name = matching(value.name, NAME)
  if (!id || !name) return null
  return {
    schemaVersion: SKILL_PACKAGE_RECORD_VERSION,
    id,
    name,
    origin: /** @type {SkillPackageRecord['origin']} */ (value.origin),
    version: matching(value.version, VERSION),
    source: normalizeSource(value.source),
    licence: normalizeLicence(value.licence),
    digest: matching(value.digest, DIGEST),
    digestAlgorithm: matching(value.digestAlgorithm, /^[a-z0-9-]{1,40}$/u),
    scripts: normalizeFiles(value.scripts, MAX_SCRIPTS),
    references: normalizeFiles(value.references, MAX_REFERENCES),
    dependencies: normalizeDependencies(value.dependencies),
    operations: normalizeOperations(value.operations),
  }
}

/**
 * The fields of a record whose value is unknown, and why — what a reader is
 * shown as "not recorded" instead of an absence that reads as "none".
 * @param {SkillPackageRecord} record
 * @returns {{ field: 'version' | 'source' | 'source.commit' | 'licence' | 'digest' | 'dependencies' | 'operations', reason: string }[]}
 */
export function unknownFields(record) {
  /** @type {{ field: 'version' | 'source' | 'source.commit' | 'licence' | 'digest' | 'dependencies' | 'operations', reason: string }[]} */
  const unknown = []
  if (!record.version) unknown.push({ field: 'version', reason: '没有记录版本。' })
  if (!record.source) unknown.push({ field: 'source', reason: '没有记录来源。' })
  else if (record.source.kind === 'derived' && !record.source.commit) unknown.push({ field: 'source.commit', reason: '来源只记录了它派生自的包，没有记录提交。' })
  if (!record.licence) unknown.push({ field: 'licence', reason: '没有记录许可证。' })
  else if (!record.licence.id) unknown.push({ field: 'licence', reason: '包里有许可证文件，但没有声明许可证名称。' })
  if (!record.digest) unknown.push({ field: 'digest', reason: '没有可核对的包摘要。' })
  return unknown
}

/**
 * The words a reader is shown for a source, in the product's Chinese: one line.
 * @param {SkillSource | null} source @returns {string}
 */
export function describeSkillSource(source) {
  if (!source) return '来源未记录'
  const short = (/** @type {string | null} */ commit) => (commit ? commit.slice(0, 12) : '')
  switch (source.kind) {
    case 'repository': return `公开仓库 ${source.repository} @ ${short(source.commit)}${source.path ? `（${source.path}）` : ''}`
    case 'derived': return `派生自 ${source.package ?? '一个已审查的包'}${source.path ? `（${source.path}）` : ''}，提交未记录`
    case 'release': return '平台随版本发布'
    case 'authored': return '在产品内创作'
    case 'upload': return '研究者上传的文件'
    case 'builtin-copy': return `复制自内置技能 ${source.package}${source.digest ? `（${source.digest.slice(7, 19)}）` : ''}`
    default: return '来源未记录'
  }
}

/** @param {SkillLicence | null} licence @returns {string} */
export function describeSkillLicence(licence) {
  if (!licence) return '许可证未记录'
  if (licence.id) return licence.id
  return '含许可证文件，名称未声明'
}

// ---------------------------------------------------------------------------
// Reading dependencies out of a package's own files
// ---------------------------------------------------------------------------

/**
 * Python's standard library (3.11 and 3.12), the closed list a third-party
 * import is told apart from by. A name here is never a dependency.
 */
const PYTHON_STDLIB = new Set(('__future__ abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 '
  + 'cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg crypt csv '
  + 'ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch '
  + 'fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io '
  + 'ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc '
  + 'nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix '
  + 'posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets '
  + 'select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics '
  + 'string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter '
  + 'token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser '
  + 'winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo').split(' '))

/**
 * The modules a Python source imports, told apart by where the statement sits.
 *
 * A statement at the start of a line is needed for the script to start; one that
 * is indented (inside a function or a `try`) is used only on a path, so it is
 * `optional`. Comments and docstrings are skipped. This reads import
 * STATEMENTS — a closed, decidable syntax — and never prose; relative imports
 * and the caller's own modules are not dependencies.
 *
 * @param {string} source @param {{ localModules?: ReadonlySet<string> | readonly string[] }} [options]
 * @returns {{ required: string[], optional: string[] }}
 */
export function pythonImports(source, { localModules = [] } = {}) {
  const local = new Set(localModules)
  /** @type {Set<string>} */ const required = new Set()
  /** @type {Set<string>} */ const optional = new Set()
  /** @type {string | null} */
  let fence = null
  for (const raw of String(source).split('\n')) {
    let line = raw.replace(/\r$/u, '')
    if (fence) {
      const close = line.indexOf(fence)
      if (close < 0) continue
      line = line.slice(close + 3)
      fence = null
    }
    // A triple quote opens a string that may run on: only what precedes it can be a statement.
    const quote = /("""|''')/u.exec(line)
    if (quote) {
      if (line.indexOf(quote[1], quote.index + 3) < 0) fence = quote[1]
      line = line.slice(0, quote.index)
    }
    if (/^\s*#/u.test(line)) continue
    const match = /^(\s*)(?:from\s+([A-Za-z_][\w]*)(?:\.[\w.]*)?\s+import\s|import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$)/u.exec(line)
    if (!match) continue
    const modules = match[2] ? [match[2]] : (match[3] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/u)[0].split('.')[0])
    for (const module of modules) {
      if (!module || PYTHON_STDLIB.has(module) || local.has(module)) continue
      (match[1] === '' ? required : optional).add(module)
    }
  }
  for (const module of required) optional.delete(module)
  return { required: [...required].sort(), optional: [...optional].sort() }
}

/**
 * The code in a Markdown body's Python fences, joined: what the skill's
 * instructions tell a model to run. Anything in it is instruction, so every
 * import found there is optional.
 * @param {string} markdown @returns {string}
 */
export function fencedPython(markdown) {
  /** @type {string[]} */ const blocks = []
  const pattern = /^```[ \t]*(?:python3?|py)\b[^\n]*\n([\s\S]*?)^```[ \t]*$/gmu
  for (const match of String(markdown).matchAll(pattern)) blocks.push(match[1])
  return blocks.join('\n')
}

/**
 * The R packages a source loads: `library(x)`, `require(x)`, `requireNamespace("x")`
 * and `x::`. Comments are skipped.
 * @param {string} source @returns {string[]}
 */
export function rLibraries(source) {
  /** @type {Set<string>} */ const found = new Set()
  for (const raw of String(source).split('\n')) {
    const line = raw.replace(/#.*$/u, '')
    for (const match of line.matchAll(/\b(?:library|require|requireNamespace|loadNamespace)\(\s*["']?([A-Za-z][A-Za-z0-9.]*)["']?/gu)) found.add(match[1])
    for (const match of line.matchAll(/\b([A-Za-z][A-Za-z0-9.]*)::/gu)) found.add(match[1])
  }
  return [...found].sort()
}

/** The R packages `r-base-core` and `r-recommended` install: what an R script may load without a download. */
export const R_IMAGE_PACKAGES = Object.freeze([
  'base', 'boot', 'class', 'cluster', 'codetools', 'compiler', 'datasets', 'foreign', 'graphics', 'grDevices', 'grid', 'KernSmooth', 'lattice', 'MASS', 'Matrix',
  'methods', 'mgcv', 'nlme', 'nnet', 'parallel', 'rpart', 'spatial', 'splines', 'stats', 'stats4', 'survival', 'tcltk', 'tools', 'utils',
])

/**
 * The top-level Python modules each distribution the runtime image pins
 * provides. A closed table: a pinned distribution without a row here is a build
 * failure of `check:skill-supply`, so an image that gains a library cannot leave
 * the table behind. A module a distribution pulls in (`IPython` by `ipykernel`)
 * belongs here too, because a script that imports it runs.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PYTHON_DISTRIBUTION_MODULES = Object.freeze({
  ipykernel: ['ipykernel', 'IPython', 'traitlets', 'jupyter_client', 'jupyter_core', 'tornado', 'zmq', 'comm', 'debugpy'],
  jupyterlab: ['jupyterlab', 'jupyter_server', 'nbformat', 'nbconvert', 'nbclient', 'notebook_shim', 'jupyter_lsp'],
  matplotlib: ['matplotlib', 'mpl_toolkits', 'pylab', 'cycler', 'kiwisolver', 'pyparsing', 'dateutil', 'contourpy', 'fontTools'],
  numpy: ['numpy'],
  openpyxl: ['openpyxl', 'et_xmlfile'],
  xlrd: ['xlrd'],
  pandas: ['pandas', 'pytz', 'tzdata'],
  pillow: ['PIL'],
  playwright: ['playwright', 'greenlet', 'pyee'],
  pypdf: ['pypdf'],
  'scikit-learn': ['sklearn', 'joblib', 'threadpoolctl'],
  scipy: ['scipy'],
  statsmodels: ['statsmodels', 'patsy'],
})

/**
 * What the runtime image build installs, as the generated table carries it.
 * @typedef {object} ImageRecipe
 * @property {Record<string, string>} python distribution -> pinned version
 * @property {Record<string, readonly string[]>} modules distribution -> top-level modules
 * @property {readonly string[]} apt installed distribution packages
 * @property {readonly string[]} tools commands the build verifies
 * @property {readonly string[]} rPackages R packages that need no download
 */

/** @param {string} value @returns {string} */
const canonicalDistribution = (value) => value.toLowerCase().replace(/[-_.]+/gu, '-')

/**
 * Whether the image recipe provides a dependency, and at which version.
 * `present: null` means the recipe cannot say.
 * @param {ImageRecipe | null} recipe @param {SkillDependency} dependency
 * @returns {{ present: boolean | null, version: string | null }}
 */
export function imageProvides(recipe, dependency) {
  if (!recipe) return { present: null, version: null }
  const name = dependency.name
  if (dependency.kind === 'python-package') {
    const wanted = canonicalDistribution(name)
    for (const [distribution, version] of Object.entries(recipe.python)) {
      if (canonicalDistribution(distribution) === wanted) return { present: true, version }
    }
    for (const [distribution, modules] of Object.entries(recipe.modules)) {
      if (modules.includes(name)) return { present: true, version: recipe.python[distribution] ?? null }
    }
    return { present: false, version: null }
  }
  if (dependency.kind === 'r-package') return { present: recipe.rPackages.includes(name), version: null }
  if (dependency.kind === 'system-tool') {
    const lowered = name.toLowerCase()
    if (lowered === 'python' || lowered === 'python3') return { present: recipe.tools.includes('python') || recipe.apt.includes('python3'), version: null }
    return { present: recipe.tools.includes(name) || recipe.apt.includes(name), version: null }
  }
  return { present: null, version: null }
}

/**
 * Whether a pinned `==` constraint holds for the version the image carries. Any
 * other constraint is not evaluated here (`null`): a range is a statement of
 * compatibility the image builder owns, and guessing it would be the failure
 * this module exists to avoid.
 * @param {string | null} constraint @param {string | null} version @returns {boolean | null}
 */
export function pinHolds(constraint, version) {
  if (!constraint || !version || !constraint.startsWith('==')) return null
  return constraint.slice(2) === version
}

/**
 * Everything a package's dependencies are read against: the image recipe,
 * which platform tools this deployment offers, and which datasets or weights it
 * mounts. Each is `null` where the caller cannot say, and an absent fact is
 * "unchecked", never "fine".
 * @typedef {object} SupplyFacts
 * @property {ImageRecipe | null} image
 * @property {((tool: string) => { offered: boolean, why?: string } | null) | null} tools
 * @property {ReadonlySet<string> | null} deployment
 */

/**
 * Why a package may not run here: one reason (a code from the availability
 * table plus the thing it names) per dependency that is missing, differs or
 * could not be checked. A dependency the researcher supplies at the moment of
 * use is never a reason.
 *
 * @param {SkillPackageRecord} record @param {SupplyFacts} facts
 * @returns {{ code: string, detail: string, source: 'image-recipe' | 'deployment-composition' | 'package-record', optional: boolean, facts?: Record<string, unknown> }[]}
 */
export function skillDependencyReasons(record, facts) {
  /** @type {{ code: string, detail: string, source: 'image-recipe' | 'deployment-composition' | 'package-record', optional: boolean, facts?: Record<string, unknown> }[]} */
  const reasons = []
  for (const dependency of record.dependencies) {
    if (dependency.supply === 'researcher') continue
    if (dependency.kind === 'platform-tool') {
      const answer = facts.tools ? facts.tools(dependency.name) : null
      if (!answer) {
        reasons.push({ code: 'dependency-unchecked', detail: dependency.name, source: 'deployment-composition', optional: dependency.optional })
      } else if (!answer.offered) {
        reasons.push({
          code: dependency.optional ? 'optional-tool-not-offered' : 'required-tool-not-offered', detail: dependency.name,
          source: 'deployment-composition', optional: dependency.optional, facts: { why: answer.why ?? 'unknown' },
        })
      }
      continue
    }
    if (dependency.kind === 'model-weights' || dependency.kind === 'dataset') {
      if (!facts.deployment) reasons.push({ code: 'dependency-unchecked', detail: dependency.name, source: 'package-record', optional: dependency.optional })
      else if (!facts.deployment.has(dependency.name)) reasons.push({ code: 'dependency-data-missing', detail: dependency.name, source: 'package-record', optional: dependency.optional, facts: { kind: dependency.kind } })
      continue
    }
    if (dependency.kind === 'compute') continue
    const provided = imageProvides(facts.image, dependency)
    if (provided.present === null) reasons.push({ code: 'dependency-unchecked', detail: dependency.name, source: 'image-recipe', optional: dependency.optional })
    else if (!provided.present) reasons.push({ code: 'dependency-software-missing', detail: dependency.name, source: 'image-recipe', optional: dependency.optional, facts: { kind: dependency.kind, basis: dependency.basis } })
    else if (pinHolds(dependency.constraint, provided.version) === false) {
      reasons.push({
        code: 'dependency-version-differs', detail: dependency.name, source: 'image-recipe', optional: dependency.optional,
        facts: { wanted: dependency.constraint, have: provided.version },
      })
    }
  }
  return reasons.sort((left, right) => Number(left.optional) - Number(right.optional))
}

// ---------------------------------------------------------------------------
// Building a record from a package's files
// ---------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = /\.(?:py|r|sh|mjs|js|ts)$/iu
const LICENCE_FILE = /^(?:.*\/)?(?:licen[cs]e|copying)(?:[._-][A-Za-z0-9.-]+)?$/iu

/**
 * The libraries and commands a package's metadata declares it needs. The
 * convention (`metadata.requires`) is the one a skill author can write in the
 * frontmatter's free-form `metadata:` map:
 *
 *     metadata: {"requires": {"python": ["numpy==2.2.6"], "r": ["survival"],
 *       "tools": ["pandoc"], "data": ["gnomad-v4"], "weights": ["esm2-650m"], "compute": ["gpu"]}}
 *
 * Anything else in `metadata` is ignored; a value that does not read is dropped.
 * @param {unknown} metadata @returns {SkillDependency[]}
 */
export function declaredDependencies(metadata) {
  const requires = isObject(metadata) && isObject(metadata.requires) ? metadata.requires : null
  if (!requires) return []
  /** @type {SkillDependency[]} */ const found = []
  /** @param {unknown} list @param {SkillDependency['kind']} kind */
  const add = (list, kind) => {
    for (const entry of Array.isArray(list) ? list.slice(0, 64) : []) {
      if (typeof entry !== 'string') continue
      const parsed = /^([A-Za-z0-9][A-Za-z0-9._+/-]*)\s*((?:==|>=|<=|~=|!=|>|<)\s*[0-9A-Za-z.*+_-]+)?$/u.exec(entry.trim())
      if (!parsed) continue
      const dependency = normalizeDependency({ kind, name: parsed[1], constraint: parsed[2] ? parsed[2].replace(/\s+/gu, '') : null, basis: 'declared', evidence: 'metadata.requires' })
      if (dependency) found.push(dependency)
    }
  }
  add(requires.python, 'python-package')
  add(requires.r, 'r-package')
  add(requires.tools, 'system-tool')
  add(requires.platformTools, 'platform-tool')
  add(requires.data, 'dataset')
  add(requires.weights, 'model-weights')
  add(requires.compute, 'compute')
  return found
}

/**
 * @typedef {object} PackageFile
 * @property {string} path package-relative, POSIX
 * @property {string} sha256 hex
 * @property {string} [text] the file's text, given for source files and SKILL.md only
 */

/**
 * The libraries a package's own files import, as dependencies.
 * @param {readonly PackageFile[]} files @param {readonly string[]} localModules
 * @returns {SkillDependency[]}
 */
export function observedDependencies(files, localModules = []) {
  /** @type {SkillDependency[]} */ const found = []
  const local = new Set([...localModules, ...files.filter((file) => /\.py$/u.test(file.path)).map((file) => file.path.split('/').at(-1)?.replace(/\.py$/u, '') ?? '')])
  for (const file of files) {
    if (typeof file.text !== 'string') continue
    if (/\.py$/iu.test(file.path)) {
      const { required, optional } = pythonImports(file.text, { localModules: local })
      for (const module of required) found.push({ kind: 'python-package', name: module, constraint: null, supply: 'image', optional: false, basis: 'observed', evidence: file.path })
      for (const module of optional) found.push({ kind: 'python-package', name: module, constraint: null, supply: 'image', optional: true, basis: 'observed', evidence: file.path })
    } else if (/\.r$/iu.test(file.path)) {
      for (const name of rLibraries(file.text)) found.push({ kind: 'r-package', name, constraint: null, supply: 'image', optional: false, basis: 'observed', evidence: file.path })
    } else if (/(?:^|\/)SKILL\.md$/u.test(file.path)) {
      const { required, optional } = pythonImports(fencedPython(file.text), { localModules: local })
      for (const module of [...required, ...optional]) found.push({ kind: 'python-package', name: module, constraint: null, supply: 'image', optional: true, basis: 'observed', evidence: `${file.path} (instructions)` })
    }
  }
  return found
}

/**
 * Build a package record from what is known about a package and its files. The
 * one derivation of scripts, references, licence file and observed dependencies
 * for every origin — managed packages (the build generator) and personal ones
 * (at import) — so the two cannot read a package differently.
 *
 * Nothing is guessed: `version`, `source`, `licence` and `digest` are what the
 * caller supplies or the package's own metadata declares, else null.
 *
 * @param {{
 *   id: string, name: string, origin: SkillPackageRecord['origin'],
 *   version?: string | null, source?: unknown, licence?: unknown, digest?: string | null, digestAlgorithm?: string | null,
 *   files: readonly PackageFile[], metadata?: unknown,
 *   dependencies?: readonly unknown[], operations?: readonly unknown[], localModules?: readonly string[],
 * }} input
 * @returns {SkillPackageRecord | null}
 */
export function buildSkillPackageRecord(input) {
  const metadata = isObject(input.metadata) ? input.metadata : {}
  const files = input.files.filter((file) => packagePath(file.path) && SHA.test(file.sha256))
  const licenceFile = files.find((file) => LICENCE_FILE.test(file.path))
  const declaredLicence = typeof metadata.license === 'string' ? metadata.license : typeof metadata.licence === 'string' ? metadata.licence : null
  const licence = input.licence ?? (declaredLicence && LICENCE.test(declaredLicence)
    ? { id: declaredLicence, file: licenceFile ? { path: licenceFile.path, sha256: licenceFile.sha256 } : null, basis: 'declared' }
    : licenceFile ? { id: null, file: { path: licenceFile.path, sha256: licenceFile.sha256 }, basis: 'file-present' } : null)
  const scripts = files.filter((file) => SCRIPT_EXTENSIONS.test(file.path))
  const scriptPaths = new Set(scripts.map((file) => file.path))
  const references = files.filter((file) => file.path !== 'SKILL.md' && !/(?:^|\/)SKILL\.md$/u.test(file.path) && !scriptPaths.has(file.path) && file !== licenceFile)
  const version = input.version ?? (typeof metadata.version === 'string' || typeof metadata.version === 'number' ? String(metadata.version) : null)
  return normalizeSkillPackageRecord({
    schemaVersion: SKILL_PACKAGE_RECORD_VERSION, id: input.id, name: input.name, origin: input.origin, version,
    source: input.source ?? null, licence, digest: input.digest ?? null, digestAlgorithm: input.digestAlgorithm ?? null,
    scripts, references,
    dependencies: [...(input.dependencies ?? []), ...declaredDependencies(metadata), ...observedDependencies(files, input.localModules)],
    operations: input.operations ?? [],
  })
}

/**
 * The record's own digest: a hash over its canonical content, so two readers
 * can tell they hold the same statement. Not a package digest.
 * @param {SkillPackageRecord} record @param {(text: string) => string} sha256Hex @returns {string}
 */
export function skillPackageRecordDigest(record, sha256Hex) {
  return `sha256:${sha256Hex(JSON.stringify(record))}`
}

/**
 * The part of a record an ordinary reader is shown: what it is and where it
 * came from, with the unknowns named, and no digest of anything private.
 * @param {SkillPackageRecord | null} record
 */
export function publicSkillPackage(record) {
  if (!record) return null
  return {
    id: record.id,
    name: record.name,
    origin: record.origin,
    version: record.version,
    source: record.source,
    sourceText: describeSkillSource(record.source),
    licence: record.licence,
    licenceText: describeSkillLicence(record.licence),
    digest: record.digest,
    digestAlgorithm: record.digestAlgorithm,
    scripts: record.scripts.length,
    references: record.references.length,
    dependencies: record.dependencies.map((dependency) => ({ kind: dependency.kind, name: dependency.name, constraint: dependency.constraint, optional: dependency.optional, supply: dependency.supply, basis: dependency.basis })),
    operations: record.operations.map((operation) => ({ name: operation.name, kind: operation.kind })),
    unknown: unknownFields(record),
  }
}
