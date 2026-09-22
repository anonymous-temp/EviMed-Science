import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { HttpError } from "./security.mjs";

/**
 * The knowledge-source plugin boundary: the one place the platform talks to
 * `evimed-knowledge-plugin` (contract `knowledge-plugin-openapi.yaml`, v1).
 *
 * Hidden knowledge, from the contract and plan §14:
 *
 * - The plugin owns everything between the outside world and a normalised
 *   entry; the platform pulls and never pushes, and the plugin never calls the
 *   platform. So every failure here is the platform failing to *read* — the
 *   feed page keeps serving what the platform already stored, and the pull
 *   loop backs off by the code this module names.
 * - Additive within major 1 (contract rule 1): unknown fields are ignored and
 *   unknown enum values are the consumer's to map (`frontierIngest.mjs`). What
 *   this module refuses is a *shape* violation — a missing required field, a
 *   wrong type, a length past the contract's own maximum — and it refuses it
 *   one entry at a time: an entry that fails is skipped and counted, and the
 *   page it came in still advances the cursor. One bad row must never stop the
 *   stream behind it.
 * - The token is a static bearer the operator writes into a 0600 file mounted
 *   read-only into both containers. It is read on every call, so a rotation is
 *   a file write, not a restart. `/v1/health` is the one route that takes no
 *   credential, and it is sent none — sending it there would only widen where
 *   the key travels. Neither the token nor a response body is ever echoed into
 *   an error: a body is where a misconfigured upstream reflects what it got.
 * - `seq` is the cursor and `next_after` only moves forward. A page whose
 *   `next_after` is behind the `after` it answered would loop the puller for
 *   ever, so it is refused as an invalid response rather than followed.
 * - One retry, on a network failure or a 502/503/504, after half a second:
 *   enough for a container restart's first refused connection, short enough
 *   that a real outage is named on the next line of the worker's status.
 *
 * Returned objects keep the contract's own field names (snake_case), filtered
 * to the fields the contract names: a reader of this module and a reader of
 * the YAML see the same words.
 *
 * @module knowledgePluginClient
 */

/** Every code this module throws, for metrics and for callers that branch. */
export const KNOWLEDGE_PLUGIN_ERROR_CODES = Object.freeze([
  "knowledge_plugin_unconfigured",
  "knowledge_plugin_unreachable",
  "knowledge_plugin_unauthorized",
  "knowledge_plugin_incompatible",
  "knowledge_plugin_invalid_cursor",
  "knowledge_plugin_not_found",
  "knowledge_plugin_rate_limited",
  "knowledge_plugin_upstream_unavailable",
  "knowledge_plugin_response_invalid",
  "knowledge_plugin_response_too_large",
  "knowledge_plugin_request_invalid",
  "knowledge_plugin_capability_unavailable",
  "knowledge_plugin_failed",
]);

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const RETRY_DELAY_MS = 500;
/** A registry is hundreds of rows; fifty pages of the maximum is a loop, not a registry. */
const MAX_SOURCE_PAGES = 50;
const SOURCE_PAGE_LIMIT = 500;
/** Contract `EntryText.body_excerpt` max, and a ceiling for the abstract it leaves unbounded. */
const MAX_TEXT_CHARS = 20_000;
const MAX_ABSTRACT_CHARS = 50_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]{1,60}$/;

/** @param {number} status @param {string} code @param {string} message */
function pluginError(status, code, message) {
  return new HttpError(status, code, message);
}

/**
 * The contract version a string names, or null.
 * @param {unknown} value
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseContractVersion(value) {
  const match = /^(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?$/.exec(String(value ?? "").trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) } : null;
}

/**
 * Whether a plugin speaking `served` satisfies a platform pinned at `minimum`:
 * the same major (contract rule 1: additive only within a major), and at least
 * the minor whose fields the platform consumes.
 * @param {unknown} served @param {unknown} minimum
 */
export function contractCompatible(served, minimum) {
  const have = parseContractVersion(served);
  const need = parseContractVersion(minimum);
  return Boolean(have && need && have.major === need.major && have.minor >= need.minor);
}

/**
 * The bearer token, read the way every secret file of this deployment is read:
 * a regular file, not a link, owner-only, bounded, one line. The value is
 * returned only to the caller that sends it; the error names what is wrong
 * with the file, never its content.
 * @param {string} file
 * @returns {Promise<{ value: string, error: string | null }>}
 */
export async function readKnowledgePluginToken(file) {
  if (!file) return { value: "", error: "token_file_unconfigured" };
  let handle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { value: "", error: "token_file_not_regular" };
    if (stat.size > MAX_TOKEN_BYTES + 2) return { value: "", error: "token_file_too_large" };
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) return { value: "", error: "token_file_permissions" };
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (!value) return { value: "", error: "token_file_empty" };
    // It becomes an HTTP header value: anything outside visible ASCII would be
    // refused by fetch at best and a header injection at worst.
    if (!/^[\x21-\x7e]+$/.test(value) || Buffer.byteLength(value) > MAX_TOKEN_BYTES) return { value: "", error: "token_file_invalid" };
    return { value, error: null };
  } catch (error) {
    return { value: "", error: /** @type {any} */ (error)?.code === "ELOOP" ? "token_file_symlink" : "token_file_unavailable" };
  } finally {
    await handle?.close();
  }
}

/** A bounded, trimmed string or undefined. @param {unknown} value @param {number} max */
function text(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** An ISO timestamp or null. @param {unknown} value */
function isoTime(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : undefined;
}

/** A list of bounded strings, deduplicated, or undefined. @param {unknown} value @param {number} maxItems @param {number} maxChars */
function textList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(value.map((item) => text(item, maxChars)).filter((item) => item !== undefined))];
  return items.slice(0, maxItems);
}

/** An absolute http(s) URL of bounded length, or undefined. @param {unknown} value */
function httpUrl(value) {
  const candidate = text(value, 2048);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return ["http:", "https:"].includes(parsed.protocol) ? candidate : undefined;
  } catch { return undefined; }
}

/** @param {unknown} value */
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * One `Entry`, checked against the contract's shape and lengths. The platform's
 * own rules — the facts whitelist, the lane vocabulary, safe URL schemes — are
 * the ingest's second look; this is the first.
 * `ok` with the entry, or not with the reason and the id when it could be read.
 * @param {unknown} raw
 * @returns {{ ok: boolean, entry?: Record<string, any>, reason?: string, entryId?: string | null }}
 */
export function validateEntry(raw) {
  if (!isObject(raw)) return { ok: false, reason: "entry_not_object", entryId: null };
  const value = /** @type {Record<string, any>} */ (raw);
  const entryId = typeof value.entry_id === "string" && value.entry_id.length <= 200 ? value.entry_id : null;
  const fail = (/** @type {string} */ reason) => ({ ok: false, reason, entryId });
  if (!entryId || entryId.length < 3) return fail("entry_id_invalid");
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) return fail("seq_invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) return fail("revision_invalid");
  const sourceId = text(value.source_id, 120);
  if (!sourceId) return fail("source_id_invalid");
  const identityKey = text(value.identity_key, 600);
  if (!identityKey) return fail("identity_key_invalid");
  if (typeof value.url !== "string" || !value.url || value.url.length > 2048) return fail("url_invalid");
  if (typeof value.canonical_url !== "string" || !value.canonical_url || value.canonical_url.length > 2048) return fail("canonical_url_invalid");
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 1000) return fail("title_invalid");
  if (typeof value.language !== "string" || !value.language || value.language.length > 35) return fail("language_invalid");
  const firstSeenAt = isoTime(value.first_seen_at);
  if (!firstSeenAt) return fail("first_seen_at_invalid");
  if (typeof value.content_sha256 !== "string" || !SHA256.test(value.content_sha256)) return fail("content_sha256_invalid");
  if (typeof value.backfill !== "boolean") return fail("backfill_invalid");
  if (value.summary != null && (typeof value.summary !== "string" || value.summary.length > 20_000)) return fail("summary_invalid");
  if (value.external_key != null && (typeof value.external_key !== "string" || value.external_key.length > 512)) return fail("external_key_invalid");
  return {
    ok: true,
    entry: {
      entry_id: entryId,
      seq: value.seq,
      revision: value.revision,
      source_id: sourceId,
      identity_key: identityKey,
      url: value.url,
      canonical_url: value.canonical_url,
      doi: text(value.doi, 300) ?? null,
      pmid: text(value.pmid, 32) ?? null,
      registry_ids: textList(value.registry_ids, 20, 64) ?? [],
      title: value.title.trim(),
      summary: typeof value.summary === "string" && value.summary.trim() ? value.summary : null,
      language: value.language,
      lane_hint: text(value.lane_hint, 40) ?? null,
      published_at: isoTime(value.published_at),
      // Optional in the contract; the platform's column needs one of three.
      date_precision: typeof value.date_precision === "string" ? value.date_precision : null,
      first_seen_at: firstSeenAt,
      content_sha256: value.content_sha256,
      backfill: value.backfill,
      defects: (textList(value.defects, 16, 40) ?? []).filter((defect) => /^[a-z][a-z0-9-]{0,39}$/.test(defect)),
      text_status: ["none", "pending", "available"].includes(value.text_status) ? value.text_status : null,
      facts: isObject(value.facts) ? value.facts : {},
    },
  };
}

/**
 * One `Source`. A registry row is never skipped for an optional field: a
 * source missing from the mirror's list is retired, so a row this module
 * dropped would retire a source that is alive. Only a row with no usable id
 * or name is refused.
 * @param {unknown} raw
 * @returns {{ ok: boolean, source?: Record<string, any>, reason?: string }}
 */
export function validateSource(raw) {
  if (!isObject(raw)) return { ok: false, reason: "source_not_object" };
  const value = /** @type {Record<string, any>} */ (raw);
  const id = text(value.id, 120);
  if (!id) return { ok: false, reason: "source_id_invalid" };
  const name = text(value.name, 300);
  if (!name) return { ok: false, reason: "source_name_invalid" };
  return {
    ok: true,
    source: {
      id,
      name,
      homepage: httpUrl(value.homepage) ?? null,
      lane: text(value.lane, 40) ?? null,
      source_type: text(value.source_type, 40) ?? null,
      access: text(value.access, 40) ?? null,
      egress: text(value.egress, 40) ?? null,
      authority: integer(value.authority, 1, 5) ?? null,
      safety_feed: value.safety_feed === true,
      owner_entity: text(value.owner_entity, 200) ?? null,
      launch_tier: text(value.launch_tier, 16) ?? null,
      language: text(value.language, 35) ?? null,
      region: text(value.region, 35) ?? null,
      enabled: value.enabled !== false,
      retired_at: isoTime(value.retired_at),
      health: text(value.health, 40) ?? null,
      last_ok_at: isoTime(value.last_ok_at),
      last_new_entry_at: isoTime(value.last_new_entry_at),
      entries_7d: integer(value.entries_7d, 0, 10_000_000) ?? 0,
      registry_sha256: typeof value.registry_sha256 === "string" && SHA256.test(value.registry_sha256) ? value.registry_sha256 : null,
    },
  };
}

/**
 * The manifest's parts the platform reads. The contract's required members
 * must be there; everything else is optional and additive.
 * @param {unknown} raw
 */
function validateManifest(raw) {
  if (!isObject(raw)) throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin manifest is not an object.");
  const value = /** @type {Record<string, any>} */ (raw);
  const name = text(value.plugin?.name, 120);
  const version = text(value.plugin?.version, 64);
  const contract = text(value.contract?.version, 32);
  if (!name || !version || !contract || !parseContractVersion(contract) || !isObject(value.capabilities)
    || !isObject(value.sources) || !isObject(value.limits)) {
    throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin manifest is missing required members.");
  }
  /** @param {unknown} list */
  const words = (list) => textList(list, 200, 80) ?? [];
  return {
    plugin: { name, version, build: text(value.plugin.build, 200) ?? null, started_at: isoTime(value.plugin.started_at) },
    contract: { version: contract },
    capabilities: {
      stream: value.capabilities.stream === true,
      text: value.capabilities.text === true,
      refresh: value.capabilities.refresh === true,
      lookups: words(value.capabilities.lookups),
    },
    vocabularies: {
      lane: words(value.vocabularies?.lane),
      source_type: words(value.vocabularies?.source_type),
      egress: words(value.vocabularies?.egress),
      access: words(value.vocabularies?.access),
    },
    sources: { total: integer(value.sources.total, 0, 1_000_000) ?? 0, enabled: integer(value.sources.enabled, 0, 1_000_000) ?? 0 },
    fields: {
      entry: words(value.fields?.entry),
      facts: words(value.fields?.facts),
      enrichment: words(value.fields?.enrichment),
    },
    limits: {
      entries_page_max: integer(value.limits.entries_page_max, 1, 100_000) ?? 500,
      text_max_chars: integer(value.limits.text_max_chars, 1, 10_000_000) ?? MAX_TEXT_CHARS,
    },
    oldest_seq_available: integer(value.oldest_seq_available, 0, Number.MAX_SAFE_INTEGER) ?? null,
  };
}

/** @param {unknown} raw */
function validateHealth(raw) {
  if (!isObject(raw)) throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin health answer is not an object.");
  const value = /** @type {Record<string, any>} */ (raw);
  const contract = text(value.contract, 32);
  if (!contract || !parseContractVersion(contract)) {
    throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin health answer names no contract.");
  }
  /** @type {Record<string, number>} */
  const sources = {};
  if (isObject(value.sources)) {
    for (const [state, count] of Object.entries(value.sources).slice(0, 40)) {
      if (/^[a-z][a-z0-9-]{0,39}$/.test(state) && integer(count, 0, 1_000_000) !== undefined) sources[state] = count;
    }
  }
  return {
    status: ["ok", "degraded", "down"].includes(value.status) ? value.status : "degraded",
    contract,
    uptime_s: integer(value.uptime_s, 0, Number.MAX_SAFE_INTEGER) ?? null,
    sources,
    last_fetch_at: isoTime(value.last_fetch_at),
    last_new_entry_at: isoTime(value.last_new_entry_at),
    model_calls_24h: integer(value.model_calls_24h, 0, 10_000_000) ?? null,
    latest_seq: integer(value.latest_seq, 0, Number.MAX_SAFE_INTEGER) ?? null,
  };
}

/**
 * `EntryText.enrichment`, whitelisted and typed: these facts are snapshotted
 * into the platform's own tables and shown on cards, so nothing the contract
 * does not name survives, and every URL is http(s).
 * @param {unknown} raw
 */
export function validateEnrichment(raw) {
  if (!isObject(raw)) return {};
  const value = /** @type {Record<string, any>} */ (raw);
  /** @type {Record<string, any>} */
  const enrichment = {};
  const assign = (/** @type {string} */ key, /** @type {unknown} */ checked) => { if (checked !== undefined) enrichment[key] = checked; };
  assign("publication_types", textList(value.publication_types, 30, 120));
  assign("mesh", textList(value.mesh, 80, 200));
  assign("journal", text(value.journal, 300));
  assign("authors_short", text(value.authors_short, 300));
  assign("open_access", ["gold", "green", "bronze", "closed", "unknown"].includes(value.open_access) ? value.open_access : undefined);
  assign("oa_pdf_url", httpUrl(value.oa_pdf_url));
  assign("impact_factor", typeof value.impact_factor === "number" && Number.isFinite(value.impact_factor)
    && value.impact_factor >= 0 && value.impact_factor <= 1000 ? value.impact_factor : undefined);
  assign("core_journal_tags", textList(value.core_journal_tags, 20, 80));
  assign("preprint_of_doi", text(value.preprint_of_doi, 300));
  assign("published_version_doi", text(value.published_version_doi, 300));
  if (isObject(value.trial_facts)) {
    /** @type {Record<string, any>} */
    const facts = {};
    const phase = text(value.trial_facts.phase, 60);
    const status = text(value.trial_facts.status, 60);
    const enrollment = integer(value.trial_facts.enrollment, 0, 100_000_000);
    const sponsor = text(value.trial_facts.sponsor, 300);
    if (phase !== undefined) facts.phase = phase;
    if (status !== undefined) facts.status = status;
    if (enrollment !== undefined) facts.enrollment = enrollment;
    if (sponsor !== undefined) facts.sponsor = sponsor;
    if (Object.keys(facts).length) enrichment.trial_facts = facts;
  }
  assign("drug_label_excerpt", text(value.drug_label_excerpt, 4_000));
  // Contract 1.1.0: ISO 3166-1 alpha-2 codes of the authors' affiliations,
  // from which the platform derives its deterministic China flag.
  if (Array.isArray(value.affiliation_countries)) {
    const countries = [...new Set(value.affiliation_countries.filter((code) => typeof code === "string")
      .map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)))].slice(0, 50);
    if (countries.length) enrichment.affiliation_countries = countries;
  }
  return enrichment;
}

/** @param {unknown} raw */
function validateEntryText(raw) {
  if (!isObject(raw)) throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin text answer is not an object.");
  const value = /** @type {Record<string, any>} */ (raw);
  const entryId = text(value.entry_id, 200);
  if (!entryId || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !["available", "pending", "unavailable"].includes(value.status)) {
    throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin text answer is missing required members.");
  }
  const abstract = typeof value.abstract === "string" && value.abstract.trim() ? value.abstract.slice(0, MAX_ABSTRACT_CHARS) : null;
  const excerpt = typeof value.body_excerpt === "string" && value.body_excerpt.trim() ? value.body_excerpt.slice(0, MAX_TEXT_CHARS) : null;
  return {
    entry_id: entryId,
    revision: value.revision,
    status: value.status,
    text_kind: ["abstract", "excerpt", "full", "none"].includes(value.text_kind) ? value.text_kind : null,
    abstract,
    body_excerpt: excerpt,
    fetched_from: text(value.fetched_from, 40) ?? null,
    fetched_at: isoTime(value.fetched_at),
    next_attempt_at: isoTime(value.next_attempt_at),
    enrichment: validateEnrichment(value.enrichment),
  };
}

/** @param {Response} response @param {number} limit */
async function boundedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw pluginError(502, "knowledge_plugin_response_too_large", "The plugin response exceeded its limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw pluginError(502, "knowledge_plugin_response_too_large", "The plugin response exceeded its limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** `Retry-After` in whole seconds, bounded to an hour; null when absent. @param {Headers} headers */
function retryAfterSeconds(headers) {
  const value = String(headers.get("retry-after") ?? "").trim();
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(1, seconds)) : null;
}

export class KnowledgePluginClient {
  /**
   * @param {{ baseUrl?: string, tokenFile?: string, timeoutMs?: number, minContract?: string, fetchImpl?: typeof fetch,
   *   maxResponseBytes?: number, sleep?: (ms: number) => Promise<unknown> }} [options]
   */
  constructor({ baseUrl = "", tokenFile = "", timeoutMs = 8_000, minContract = "1.0", fetchImpl = globalThis.fetch,
    maxResponseBytes = MAX_RESPONSE_BYTES, sleep = (ms) => delay(ms) } = {}) {
    this.baseUrl = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (this.baseUrl) {
      let parsed;
      try { parsed = new URL(this.baseUrl); } catch { throw new TypeError("The knowledge plugin URL is invalid."); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new TypeError("The knowledge plugin URL is invalid.");
      }
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) throw new TypeError("The knowledge plugin timeout is invalid.");
    if (!parseContractVersion(minContract)) throw new TypeError("The knowledge plugin minimum contract is invalid.");
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new TypeError("The knowledge plugin response limit is invalid.");
    this.tokenFile = String(tokenFile ?? "");
    this.timeoutMs = timeoutMs;
    this.minContract = String(minContract);
    this.fetch = fetchImpl;
    this.maxResponseBytes = maxResponseBytes;
    this.sleep = sleep;
    /** @type {string | null} the code of the last failed call, cleared by the next success */
    this.lastError = null;
    /** Observable counters (principle 15). */
    this.counters = { requests: 0, failures: 0, retries: 0, skippedEntries: 0, skippedSources: 0 };
  }

  get configured() { return Boolean(this.baseUrl); }

  /** Whether a contract version this plugin serves is one this platform consumes. @param {unknown} version */
  compatible(version) { return contractCompatible(version, this.minContract); }

  /** Throw `knowledge_plugin_incompatible` unless the manifest's contract is consumable. @param {{ contract: { version: string } }} manifest */
  assertCompatible(manifest) {
    if (!this.compatible(manifest?.contract?.version)) {
      throw pluginError(502, "knowledge_plugin_incompatible",
        `The plugin serves contract ${manifest?.contract?.version ?? "unknown"}; this platform consumes ${this.minContract}.`);
    }
    return manifest;
  }

  /** What this build delivers, with its contract verdict. The caller decides what an incompatible one costs. */
  async manifest() {
    const manifest = validateManifest(await this.#request("GET", "/v1/manifest"));
    return { ...manifest, compatible: this.compatible(manifest.contract.version) };
  }

  /** Liveness, counts, the latest `seq`. Sent no credential (see the module header). */
  async health() {
    const health = validateHealth(await this.#request("GET", "/v1/health", { auth: false }));
    return { ...health, compatible: this.compatible(health.contract) };
  }

  /**
   * The whole registry, following `next_cursor` to its end. Rows that fail the
   * shape check are counted in `skipped`; a caller that retires sources missing
   * from the list must not do so when anything was skipped.
   * @param {{ cursor?: string | null, limit?: number, includeRetired?: boolean }} [options]
   */
  async sources({ cursor = null, limit = SOURCE_PAGE_LIMIT, includeRetired = true } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("The source page limit is invalid.");
    /** @type {Record<string, any>[]} */
    const sources = [];
    /** @type {{ reason: string }[]} */
    const skipped = [];
    const seen = new Set();
    let next = cursor;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_SOURCE_PAGES) {
        throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's source listing did not end.");
      }
      const body = await this.#request("GET", "/v1/sources", { query: {
        limit: String(limit), include_retired: includeRetired ? "true" : "false", ...(next ? { cursor: next } : {}),
      } });
      if (!isObject(body) || !Array.isArray(body.sources)) {
        throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's source page is not a list.");
      }
      for (const raw of body.sources) {
        const checked = validateSource(raw);
        if (!checked.ok) { skipped.push({ reason: checked.reason }); continue; }
        if (seen.has(checked.source.id)) continue;
        seen.add(checked.source.id);
        sources.push(checked.source);
      }
      const following = body.next_cursor == null ? null : text(body.next_cursor, 2000);
      if (body.next_cursor != null && !following) {
        throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's source cursor is invalid.");
      }
      if (!following) break;
      if (following === next) throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's source cursor did not advance.");
      next = following;
    }
    this.counters.skippedSources += skipped.length;
    return { sources, skipped, fetchedAt: new Date().toISOString() };
  }

  /**
   * One page of the stream after `after`, ascending by `seq`. Entries that fail
   * the shape check are in `skipped` and still covered by `nextAfter`.
   * @param {{ after: number, limit?: number, includeBackfill?: boolean }} options
   */
  async entries({ after, limit = 500, includeBackfill = false }) {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw pluginError(400, "knowledge_plugin_invalid_cursor", "The plugin cursor must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("The entry page limit is invalid.");
    const body = await this.#request("GET", "/v1/entries", { query: {
      after: String(after), limit: String(limit), ...(includeBackfill ? { include_backfill: "true" } : {}),
    } });
    if (!isObject(body) || !Array.isArray(body.entries) || typeof body.has_more !== "boolean"
      || !Number.isSafeInteger(body.next_after) || body.next_after < after || body.entries.length > limit) {
      throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's entry page is not a valid page.");
    }
    /** @type {Record<string, any>[]} */
    const entries = [];
    /** @type {{ reason: string, entryId: string | null }[]} */
    const skipped = [];
    for (const raw of body.entries) {
      const checked = validateEntry(raw);
      if (!checked.ok) { skipped.push({ reason: checked.reason, entryId: checked.entryId }); continue; }
      // A row outside the window this page claims to cover is a plugin bug the
      // cursor must not follow: it would be stored under a position it is not at.
      if (checked.entry.seq <= after || checked.entry.seq > body.next_after) {
        skipped.push({ reason: "seq_out_of_page", entryId: checked.entry.entry_id });
        continue;
      }
      entries.push(checked.entry);
    }
    // A page that claims more with nothing in it and no progress would be
    // asked for again with the same cursor, for ever.
    if (body.has_more && body.next_after === after) {
      throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's entry page did not advance.");
    }
    this.counters.skippedEntries += skipped.length;
    return { entries, skipped, nextAfter: body.next_after, hasMore: body.has_more, serverTime: isoTime(body.server_time) };
  }

  /** One entry, latest revision. @param {string} entryId */
  async entry(entryId) {
    const checked = validateEntry(await this.#request("GET", `/v1/entries/${this.#segment(entryId)}`));
    if (!checked.ok) throw pluginError(502, "knowledge_plugin_response_invalid", `The plugin's entry is invalid (${checked.reason}).`);
    return checked.entry;
  }

  /** The abstract, excerpt and enrichment of one entry, or `pending`. @param {string} entryId */
  async text(entryId) {
    return validateEntryText(await this.#request("GET", `/v1/entries/${this.#segment(entryId)}/text`));
  }

  /** The on-demand capabilities this build offers (an empty list in batch 1). */
  async lookups() {
    const body = await this.#request("GET", "/v1/lookups");
    if (!isObject(body) || !Array.isArray(body.lookups)) {
      throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's lookup list is not a list.");
    }
    return {
      lookups: body.lookups.filter(isObject).map((/** @type {any} */ entry) => ({
        id: text(entry.id, 64) ?? null, title: text(entry.title, 200) ?? null, upstream: text(entry.upstream, 200) ?? null,
        params: isObject(entry.params) ? entry.params : {}, coverage: text(entry.coverage, 1000) ?? null,
      })).filter((entry) => entry.id && CAPABILITY_ID.test(entry.id)),
    };
  }

  /**
   * Run one on-demand lookup. The parameters are the capability's own to
   * validate; this module bounds the name and the answer.
   * @param {string} capability @param {Record<string, any>} params
   */
  async lookup(capability, params) {
    if (!CAPABILITY_ID.test(String(capability ?? ""))) throw pluginError(400, "knowledge_plugin_request_invalid", "The lookup capability is invalid.");
    if (!isObject(params)) throw pluginError(400, "knowledge_plugin_request_invalid", "The lookup parameters must be an object.");
    const body = await this.#request("POST", `/v1/lookups/${capability}`, { body: params });
    if (!isObject(body) || !Array.isArray(body.results) || typeof body.capability !== "string" || typeof body.provider !== "string") {
      throw pluginError(502, "knowledge_plugin_response_invalid", "The plugin's lookup result is not a result.");
    }
    return {
      capability: body.capability.slice(0, 64),
      provider: body.provider.slice(0, 200),
      fetched_at: isoTime(body.fetched_at),
      results: body.results.filter(isObject).slice(0, 200),
      total: integer(body.total, 0, Number.MAX_SAFE_INTEGER) ?? null,
      coverage: text(body.coverage, 1000) ?? null,
      missing: textList(body.missing, 100, 300) ?? [],
      warnings: textList(body.warnings, 50, 500) ?? [],
    };
  }

  status() {
    return { configured: this.configured, minContract: this.minContract, lastError: this.lastError, counters: { ...this.counters } };
  }

  /** A path segment for an id the plugin minted (`<source>:<hash>`). @param {unknown} value */
  #segment(value) {
    const id = String(value ?? "");
    if (!id || id.length > 200 || [...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw pluginError(400, "knowledge_plugin_request_invalid", "The entry id is invalid.");
    }
    return encodeURIComponent(id);
  }

  /** @returns {Promise<string>} */
  async #token() {
    if (!this.tokenFile) throw pluginError(503, "knowledge_plugin_unconfigured", "The knowledge plugin token file is not configured.");
    const loaded = await readKnowledgePluginToken(this.tokenFile);
    if (loaded.error) throw pluginError(503, "knowledge_plugin_unconfigured", `The knowledge plugin token file is unusable (${loaded.error}).`);
    return loaded.value;
  }

  /**
   * @param {"GET" | "POST"} method @param {string} pathname
   * @param {{ query?: Record<string, string>, body?: Record<string, any>, auth?: boolean }} [options]
   */
  async #request(method, pathname, { query = {}, body, auth = true } = {}) {
    try {
      const result = await this.#attempt(method, pathname, { query, body, auth });
      this.lastError = null;
      return result;
    } catch (error) {
      this.counters.failures += 1;
      this.lastError = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "knowledge_plugin_failed";
      throw error;
    }
  }

  /**
   * @param {"GET" | "POST"} method @param {string} pathname
   * @param {{ query: Record<string, string>, body?: Record<string, any>, auth: boolean }} options
   */
  async #attempt(method, pathname, { query, body, auth }) {
    if (!this.baseUrl) throw pluginError(503, "knowledge_plugin_unconfigured", "The knowledge plugin is not configured for this deployment.");
    const token = auth ? await this.#token() : null;
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    for (let attempt = 1; ; attempt += 1) {
      this.counters.requests += 1;
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: {
            accept: "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        // A refused connection, a DNS miss or the deadline: nothing reached a
        // handler, so a second attempt is safe for GET and POST alike.
        if (attempt < 2) { this.counters.retries += 1; await this.sleep(RETRY_DELAY_MS); continue; }
        throw pluginError(503, "knowledge_plugin_unreachable", "The knowledge plugin is unreachable.");
      }
      const raw = await boundedBody(response, this.maxResponseBytes);
      let parsed = null;
      try { parsed = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { parsed = null; }
      if (response.ok) {
        if (parsed === null) throw pluginError(502, "knowledge_plugin_response_invalid", "The knowledge plugin answered with no JSON.");
        return parsed;
      }
      const code = isObject(parsed) && typeof parsed.code === "string" ? parsed.code : "";
      if ([502, 503, 504].includes(response.status) && code !== "upstream_unavailable" && attempt < 2) {
        this.counters.retries += 1;
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }
      throw this.#failure(response.status, code, response.headers);
    }
  }

  /** @param {number} status @param {string} code @param {Headers} headers */
  #failure(status, code, headers) {
    if (status === 401 || status === 403) return pluginError(502, "knowledge_plugin_unauthorized", "The knowledge plugin refused this deployment's token.");
    if (status === 404) return pluginError(404, "knowledge_plugin_not_found", "The knowledge plugin does not know that id.");
    if (status === 400 && code === "invalid_cursor") return pluginError(400, "knowledge_plugin_invalid_cursor", "The knowledge plugin refused the cursor.");
    if (status === 400) return pluginError(502, "knowledge_plugin_request_invalid", "The knowledge plugin refused the request's parameters.");
    if (status === 429) {
      const error = /** @type {HttpError & { retryAfterSeconds?: number }} */ (pluginError(503, "knowledge_plugin_rate_limited", "The knowledge plugin is rate limiting this capability."));
      const wait = retryAfterSeconds(headers);
      if (wait != null) error.retryAfterSeconds = wait;
      return error;
    }
    if (status === 501) return pluginError(501, "knowledge_plugin_capability_unavailable", "This knowledge plugin build does not offer that capability.");
    if (code === "upstream_unavailable") return pluginError(502, "knowledge_plugin_upstream_unavailable", "The knowledge plugin's upstream is unavailable.");
    if ([502, 503, 504].includes(status)) return pluginError(503, "knowledge_plugin_unreachable", "The knowledge plugin is unavailable.");
    return pluginError(502, "knowledge_plugin_failed", `The knowledge plugin failed with HTTP ${status}.`);
  }
}
