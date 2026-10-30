/**
 * The research-database connector's limits, in one place with the reason each exists (principle 15: a limit protects a
 * resource, has a key, and has a counter -- `researchDbMetrics.mjs`). The defaults are the values the connector shipped
 * with; an operator moves one by its key. Every limit here bounds the work of ONE control-plane process: two replicas
 * each admit their own slots, and a remote database sees at most `slots` x replicas readers.
 *
 * What a snapshot is cut at is not silent: the title of the source, its sidecar file and the study's material entry say
 * how much of the table was kept and what was left out (`researchDbImport.mjs`).
 */

/** One entry per limit: the environment key, the property, the default, the range an operator may choose, and why. */
export const RESEARCH_DB_LIMIT_SPECS = Object.freeze([
  { key: 'rows', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_ROWS', fallback: 20_000, min: 1, max: 1_000_000,
    why: 'One CSV source is parsed, profiled and read by a run whole; past this a table is a different job (a data plane), not a snapshot.' },
  { key: 'columns', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_COLUMNS', fallback: 64, min: 1, max: 1_600,
    why: 'The width of one CSV a person can read in the table view and a run can profile; PostgreSQL itself allows 1,600.' },
  { key: 'cellBytes', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_CELL_BYTES', fallback: 32_768, min: 256, max: 1_048_576,
    why: 'A cell longer than this is a document or a blob, not a value; it is withheld in the remote database and never transferred.' },
  { key: 'bytes', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_BYTES', fallback: 12 * 1024 * 1024, min: 65_536, max: 256 * 1024 * 1024,
    why: 'The cell text of the kept rows, held in the control-plane process while the snapshot is read.' },
  { key: 'tables', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_TABLES', fallback: 200, min: 1, max: 5_000,
    why: 'Tables one listing offers; the listing is one response and one dialog.' },
  { key: 'slots', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_CONCURRENT', fallback: 4, min: 1, max: 64,
    why: 'Remote connections open at once from this process; each is a socket, a TLS session and up to the byte cap in memory.' },
  { key: 'perUser', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_PER_USER', fallback: 1, min: 1, max: 16,
    why: 'One person cannot take every slot, and cannot point several readers at one remote database.' },
  { key: 'connections', env: 'OPEN_SCIENCE_RESEARCH_DB_MAX_CONNECTIONS', fallback: 50, min: 1, max: 1_000,
    why: 'Saved credentials one project keeps; each is an encrypted row and a standing grant.' },
  { key: 'connectionMs', env: 'OPEN_SCIENCE_RESEARCH_DB_CONNECTION_MS', fallback: 30_000, min: 5_000, max: 300_000,
    why: 'The hard end of one remote connection, however slowly the remote answers.' },
  { key: 'readMs', env: 'OPEN_SCIENCE_RESEARCH_DB_READ_MS', fallback: 20_000, min: 1_000, max: 280_000,
    why: 'A snapshot stops reading on its own after this long and ends as a truncated snapshot; it must leave room inside the connection\'s end.' },
  { key: 'wireBytes', env: 'OPEN_SCIENCE_RESEARCH_DB_WIRE_BYTES', fallback: 24 * 1024 * 1024, min: 1_048_576, max: 512 * 1024 * 1024,
    why: 'Decrypted protocol bytes one connection may deliver (authentication and catalogue messages included): the cell text of a full snapshot plus four bytes a cell and a marker string a row.' },
])

/** @typedef {{rows:number,columns:number,cellBytes:number,bytes:number,tables:number,slots:number,perUser:number,connections:number,connectionMs:number,readMs:number,wireBytes:number}} ResearchDbLimits */

/** The shipped values, for a caller that is handed no configuration (the module's own tests, a default parameter).
 * @type {Readonly<ResearchDbLimits>} */
export const RESEARCH_DB_LIMIT_DEFAULTS = Object.freeze(/** @type {ResearchDbLimits} */ (Object.fromEntries(RESEARCH_DB_LIMIT_SPECS.map(spec => [spec.key, spec.fallback]))))

/** @param {unknown} value @param {{env:string,fallback:number,min:number,max:number}} spec */
function bounded(value, spec) {
  if (value === undefined || value === null || value === '') return spec.fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < spec.min || number > spec.max) {
    throw new Error(`${spec.env} must be a whole number from ${spec.min} to ${spec.max}, got ${JSON.stringify(value)}.`)
  }
  return number
}

/**
 * The configured limits, refused by name when out of range or when two of them could not both hold.
 * @param {Record<string, any>} [overrides] `researchDbLimits` (an object keyed as above) wins over the environment
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<ResearchDbLimits>}
 */
export function researchDbLimitSettings(overrides = {}, env = process.env) {
  const given = overrides.researchDbLimits ?? {}
  const limits = /** @type {ResearchDbLimits} */ (Object.fromEntries(RESEARCH_DB_LIMIT_SPECS.map(spec => [spec.key, bounded(given[spec.key] ?? env[spec.env], spec)])))
  if (limits.readMs + 5_000 > limits.connectionMs) {
    throw new Error('OPEN_SCIENCE_RESEARCH_DB_READ_MS must leave at least 5000 ms inside OPEN_SCIENCE_RESEARCH_DB_CONNECTION_MS for the row count and the close.')
  }
  if (limits.wireBytes < limits.bytes + 1_048_576) {
    throw new Error('OPEN_SCIENCE_RESEARCH_DB_WIRE_BYTES must exceed OPEN_SCIENCE_RESEARCH_DB_MAX_BYTES by at least 1 MiB for the protocol\'s own bytes.')
  }
  if (limits.perUser > limits.slots) throw new Error('OPEN_SCIENCE_RESEARCH_DB_MAX_PER_USER cannot exceed OPEN_SCIENCE_RESEARCH_DB_MAX_CONCURRENT.')
  return Object.freeze(limits)
}

/**
 * The connector's settings for `config.mjs`: the egress allowlist, the keyring file, the operator-owned CA directory and
 * the limits. Not the connector's switch: it exists only when the allowlist and the keyring are both set.
 *
 * - `researchDbCaDir`: a directory the operator owns, holding `<host>.pem` (the host name in lower case, as the allowlist
 *   writes it) for each database whose certificate chain does not end in a public authority -- a cloud provider's own
 *   root, a self-signed certificate. A host with no file is verified against the built-in public authorities only.
 * @param {Record<string, any>} overrides @param {Record<string, string | undefined>} [env]
 */
export function researchDbSettings(overrides, env = process.env) {
  return {
    researchDbAllow: String(overrides.researchDbAllow ?? env.OPEN_SCIENCE_RESEARCH_DB_ALLOW ?? '').trim(),
    researchDbKeyringFile: String(overrides.researchDbKeyringFile ?? env.OPEN_SCIENCE_RESEARCH_DB_KEYRING_FILE ?? '').trim(),
    researchDbCaDir: String(overrides.researchDbCaDir ?? env.OPEN_SCIENCE_RESEARCH_DB_CA_DIR ?? '').trim(),
    researchDbLimits: researchDbLimitSettings(overrides, env),
  }
}
