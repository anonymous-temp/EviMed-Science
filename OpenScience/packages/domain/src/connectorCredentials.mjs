/**
 * The external data sources a researcher may hold their own credential for.
 *
 * Every entry names a credential profile the server's public-source gateway
 * already injects server-side (the runtime never carries a key). A deployment
 * may configure the credential once for everyone; where it has not, the
 * researcher can supply their own from the account page, and the gateway falls
 * back to it for that researcher's runs. This registry is the one place that
 * says which profiles are eligible, what each one unlocks, and where a key
 * comes from — the shell's login prompt, the account card, the gateway and the
 * adapters all read it rather than keeping lists of their own.
 *
 * `evimed-evidence` is deliberately absent: it is the company's own API, and a
 * deployment either has it or does not.
 *
 * @typedef {object} ConnectorCredentialSpec
 * @property {string} id            the gateway credential profile id
 * @property {string} title         what the researcher sees
 * @property {'api-key'|'jwt'|'email'} kind
 * @property {string} unlocks       one sentence, Chinese: what having it enables
 * @property {string} obtainUrl     where a researcher gets one
 * @property {readonly string[]} capabilities  capability ids that depend on it
 * @property {boolean} keyless      true when the upstream serves without one, only slower
 * @property {number} [validityDays] when the upstream expires tokens on a fixed schedule
 */

/** @type {readonly ConnectorCredentialSpec[]} */
export const CONNECTOR_CREDENTIALS = Object.freeze([
  Object.freeze({
    id: 'opengwas', title: 'OpenGWAS', kind: 'jwt',
    unlocks: '孟德尔随机化所需的 GWAS 汇总数据（IEU OpenGWAS）。',
    obtainUrl: 'https://api.opengwas.io/profile/',
    capabilities: Object.freeze(['mendelian-randomization']), keyless: false, validityDays: 14,
  }),
  Object.freeze({
    id: 'semantic-scholar', title: 'Semantic Scholar', kind: 'api-key',
    unlocks: '文献检索与引用图谱；没有密钥也能用，只是配额更低。',
    obtainUrl: 'https://www.semanticscholar.org/product/api#api-key-form',
    capabilities: Object.freeze([]), keyless: true,
  }),
  Object.freeze({
    id: 'core', title: 'CORE', kind: 'api-key',
    unlocks: '开放获取全文的检索与下载。',
    obtainUrl: 'https://core.ac.uk/services/api',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'unpaywall', title: 'Unpaywall', kind: 'email',
    unlocks: '按 DOI 解析开放获取全文；只需一个联系邮箱。',
    obtainUrl: 'https://unpaywall.org/products/api',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'umls', title: 'UMLS', kind: 'api-key',
    unlocks: '医学术语归一化（UMLS Metathesaurus）。',
    obtainUrl: 'https://uts.nlm.nih.gov/uts/profile',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'omim', title: 'OMIM', kind: 'api-key',
    unlocks: '遗传病与基因表型记录。',
    obtainUrl: 'https://www.omim.org/api',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'addgene', title: 'Addgene', kind: 'api-key',
    unlocks: '质粒与试剂目录。',
    obtainUrl: 'https://developers.addgene.org/',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'biogrid', title: 'BioGRID', kind: 'api-key',
    unlocks: '蛋白质与遗传相互作用数据。',
    obtainUrl: 'https://webservice.thebiogrid.org/',
    capabilities: Object.freeze([]), keyless: false,
  }),
  Object.freeze({
    id: 'ncbi', title: 'NCBI E-utilities', kind: 'api-key',
    unlocks: 'PubMed 等 NCBI 检索的更高请求配额；没有也能用。',
    obtainUrl: 'https://www.ncbi.nlm.nih.gov/account/settings/',
    capabilities: Object.freeze([]), keyless: true,
  }),
  Object.freeze({
    id: 'openfda', title: 'openFDA', kind: 'api-key',
    unlocks: 'FAERS 不良事件检索的更高请求配额；没有也能用。',
    obtainUrl: 'https://open.fda.gov/apis/authentication/',
    capabilities: Object.freeze(['adr-analysis']), keyless: true,
  }),
  Object.freeze({
    id: 'materials-project', title: 'Materials Project', kind: 'api-key',
    unlocks: '材料科学数据库检索。',
    obtainUrl: 'https://next-gen.materialsproject.org/api',
    capabilities: Object.freeze([]), keyless: false,
  }),
])

/** @type {ReadonlySet<string>} */
export const CONNECTOR_CREDENTIAL_IDS = Object.freeze(new Set(CONNECTOR_CREDENTIALS.map((spec) => spec.id)))

/** @param {unknown} id @returns {ConnectorCredentialSpec | null} */
export function connectorCredentialSpec(id) {
  return CONNECTOR_CREDENTIALS.find((spec) => spec.id === id) ?? null
}

/** The gateway's configKey for a profile: `semantic-scholar` → `semanticScholar`. */
const CONFIG_KEYS = Object.freeze({
  opengwas: 'opengwas', 'semantic-scholar': 'semanticScholar', core: 'core', unpaywall: 'unpaywall', umls: 'umls',
  omim: 'omim', addgene: 'addgene', biogrid: 'biogrid', ncbi: 'ncbi', openfda: 'openFda', 'materials-project': null,
})

/**
 * Which `publicSourceCredentials` entry (or first-party config value) a
 * profile reads from on the deployment side.
 * @param {string} id @returns {{ configKey: string } | { configValue: string } | null}
 */
export function connectorDeploymentSource(id) {
  if (!CONNECTOR_CREDENTIAL_IDS.has(id)) return null
  if (id === 'materials-project') return { configValue: 'materialsProjectApiKey' }
  const key = CONFIG_KEYS[/** @type {keyof typeof CONFIG_KEYS} */ (id)]
  return key ? { configKey: key } : null
}

/**
 * Whether a submitted credential value is a plausible one for the profile.
 * Shape only: a value is never sent upstream to find out.
 * @param {string} id @param {unknown} value
 * @returns {{ ok: true, expiresAt: string | null } | { ok: false, reason: string }}
 */
export function validateConnectorCredentialValue(id, value) {
  const spec = connectorCredentialSpec(id)
  if (!spec) return { ok: false, reason: 'unknown connector' }
  if (typeof value !== 'string') return { ok: false, reason: 'the credential must be a string' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, reason: 'the credential is empty' }
  if (trimmed.length > 8 * 1024) return { ok: false, reason: 'the credential is longer than 8 KB' }
  if (/[\r\n\0\s]/.test(trimmed)) return { ok: false, reason: 'the credential contains whitespace or control characters' }
  if (spec.kind === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) return { ok: false, reason: 'not an email address' }
    return { ok: true, expiresAt: null }
  }
  if (spec.kind === 'jwt') {
    const parts = trimmed.split('.')
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return { ok: false, reason: 'not a JWT' }
    let exp = null
    try {
      // Decoded with nothing but arithmetic and TextDecoder: this module loads
      // in the browser bundle and the plugin sandbox as well as in Node, and
      // neither `Buffer` nor `atob` is promised in all three.
      const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])))
      if (payload && typeof payload === 'object' && Number.isFinite(Number(payload.exp))) exp = Number(payload.exp)
    } catch {
      return { ok: false, reason: 'the JWT payload is not readable' }
    }
    if (exp != null && exp * 1000 < Date.now()) return { ok: false, reason: 'the token has already expired' }
    return { ok: true, expiresAt: exp == null ? null : new Date(exp * 1000).toISOString() }
  }
  return { ok: true, expiresAt: null }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** @param {string} text @returns {Uint8Array} */
function base64UrlBytes(text) {
  const bytes = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE64URL_ALPHABET.indexOf(char)
    if (value < 0) throw new Error('not base64url')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}
