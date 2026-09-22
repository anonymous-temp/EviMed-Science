import { FRONTIER_DATE_PRECISIONS, FRONTIER_ENTRY_DEFECTS, FRONTIER_VOCABULARY_FALLBACKS } from "@evimed/domain";
import { FRONTIER_META_KEYS, bumpFrontierVersion, metaNumber, migrateFrontier } from "./frontierPersistence.mjs";

/**
 * Pulling the knowledge-source plugin into `evimed_frontier` (plan §14.4).
 *
 * Hidden knowledge:
 *
 * - Three reads, three cadences. The manifest (contract version, what this
 *   plugin build populates, the oldest `seq` it still holds) and the registry
 *   are mirrored hourly; the stream is pulled every
 *   `OPEN_SCIENCE_KNOWLEDGE_PLUGIN_POLL_MS`, page after page while the plugin
 *   says there is more. The platform never reads a source itself: the public
 *   sources page reads the mirror.
 * - One page, one transaction: the rows go in `ON CONFLICT (plugin_entry_id,
 *   revision) DO NOTHING` and the cursor moves in the same commit, so a crash
 *   between the two is impossible and a page read twice stores nothing twice.
 *   The cursor row is locked for the write and compared with the cursor the
 *   page was asked for: a second control plane that got there first wins, and
 *   this one's page is discarded rather than moving the cursor backwards.
 * - Trust, but verify (plan §14.2). The client already refused rows that break
 *   the contract's shape; here the platform's own rules run a second time: only
 *   whitelisted `facts` keys survive, each with its type; a link that is not
 *   http(s) is never stored as something a reader could click (the row is kept
 *   as `dropped` with its reason, so the defect is countable); an identity key
 *   outside the contract's ladder is dropped the same way, because cross-source
 *   dedupe is a lookup by that key.
 * - Unknown vocabulary never rejects an entry (contract rule 1). A lane the
 *   platform does not know becomes `mixed` — the screening model decides — a
 *   source type becomes `media`, and a health word is stored verbatim and
 *   served as `degraded`. Each is counted, because "the plugin started speaking
 *   a word we do not know" is a release note someone forgot to send.
 * - An entry whose source the mirror does not know makes the ingest mirror the
 *   registry again at once. If the plugin still does not list it, a placeholder
 *   row is written so the entry is kept (principle 19) — the next hourly mirror
 *   either fills it in or retires it.
 * - A registry listing with any row skipped, or with no rows at all, never
 *   retires anything: a source missing from an incomplete list is not a source
 *   the plugin retired.
 * - The plugin purges entries 30 days after delivery. A cursor that fell
 *   behind `oldest_seq_available` (the platform was down longer than that)
 *   resumes from there and counts the gap, which is the only honest thing left
 *   to do with entries nobody can deliver any more. A fresh platform starting
 *   from 0 is not a gap: it never had those entries to lose.
 * - A contract major the platform does not consume is refused, not guessed at:
 *   the stream is not pulled until the manifest says a compatible version
 *   again, which is re-checked on every pull until it does.
 * - The plugin being down costs the feed its freshness and nothing else. The
 *   pull backs off exponentially by the code the client named, up to fifteen
 *   minutes, and resumes from the stored cursor — nothing lost, nothing twice.
 *
 * @module frontierIngest
 */

/** Contract rule 1's documented fallbacks for unknown enum values, keyed by
 *  the column each lands in; the values are the domain vocabulary's. */
export const FRONTIER_FALLBACKS = Object.freeze({
  lane: FRONTIER_VOCABULARY_FALLBACKS.lane,
  source_type: FRONTIER_VOCABULARY_FALLBACKS.sourceType,
  health: FRONTIER_VOCABULARY_FALLBACKS.health,
});

const DATE_PRECISIONS = new Set(FRONTIER_DATE_PRECISIONS);
/** A defect this build does not know is dropped, not stored: defects have no
 *  fallback (the domain vocabulary says so) and the pipeline branches on them. */
const DEFECTS = new Set(FRONTIER_ENTRY_DEFECTS);
/** The identity ladder of contract rule 3; a key outside it cannot be looked up. */
const IDENTITY_KEY = /^(doi|pmid|wx|reg|fda|url):\S/;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_UNKNOWN_VALUES = 20;
/** The codes that mean the platform cannot reach the plugin at all, as opposed
 *  to reaching it and getting something wrong back. */
const UNREACHABLE_CODES = new Set(["knowledge_plugin_unreachable", "knowledge_plugin_unauthorized", "knowledge_plugin_unconfigured"]);

/** @param {unknown} value @param {number} max */
const boundedText = (value, max) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined);
/** @param {unknown} value @param {number} min @param {number} max */
const boundedInteger = (value, min, max) => (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : undefined);

/**
 * The contract's `Entry.facts`, each key with the type the contract gives it.
 * A key not listed here does not exist past this line; a listed key with the
 * wrong type is dropped on its own. The key set is the domain's
 * `FRONTIER_FACT_KEYS`, and a test holds the two equal: a key added there and
 * forgotten here would be dropped from every entry in silence.
 * @type {Readonly<Record<string, (value: unknown) => unknown>>}
 */
export const FRONTIER_FACT_RULES = Object.freeze({
  crossref_type: (value) => boundedText(value, 60),
  update_to: (value) => {
    if (!Array.isArray(value)) return undefined;
    const notices = value.slice(0, 20).map((notice) => {
      if (!notice || typeof notice !== "object") return null;
      const type = boundedText(/** @type {any} */ (notice).type, 40);
      const doi = boundedText(/** @type {any} */ (notice).doi, 300);
      const date = boundedText(/** @type {any} */ (notice).date, 40);
      return doi ? { ...(type ? { type } : {}), doi, ...(date ? { date } : {}) } : null;
    }).filter(Boolean);
    return notices.length ? notices : undefined;
  },
  author_count: (value) => boundedInteger(value, 0, 100_000),
  journal: (value) => boundedText(value, 300),
  issn: (value) => boundedText(value, 20),
  trial_phase: (value) => boundedText(value, 40),
  trial_status: (value) => boundedText(value, 60),
  trial_event: (value) => boundedText(value, 40),
  sponsor: (value) => boundedText(value, 300),
  recall_class: (value) => boundedText(value, 40),
  fda_application: (value) => boundedText(value, 40),
  fda_supplement: (value) => boundedText(value, 40),
  wx_biz: (value) => boundedText(value, 100),
  wx_author: (value) => boundedText(value, 200),
  wx_original: (value) => (typeof value === "boolean" ? value : undefined),
  is_correction_notice: (value) => (typeof value === "boolean" ? value : undefined),
  is_masthead: (value) => (typeof value === "boolean" ? value : undefined),
});

/**
 * The whitelisted facts of one entry, and the keys that did not survive.
 * @param {unknown} facts
 * @returns {{ facts: Record<string, unknown>, dropped: string[] }}
 */
export function whitelistFacts(facts) {
  /** @type {Record<string, unknown>} */
  const kept = {};
  /** @type {string[]} */
  const dropped = [];
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return { facts: kept, dropped };
  for (const [key, value] of Object.entries(facts)) {
    const rule = Object.hasOwn(FRONTIER_FACT_RULES, key) ? FRONTIER_FACT_RULES[key] : null;
    const checked = rule ? rule(value) : undefined;
    if (checked === undefined) dropped.push(key.slice(0, 60));
    else kept[key] = checked;
  }
  return { facts: kept, dropped };
}

/** @param {string} value */
function httpLink(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch { return false; }
}

/**
 * The key → label maps (or key lists) of the frontier vocabulary this module
 * reads: the lanes (with `mixed`), source types, health states, read methods,
 * egresses and launch tiers.
 * @typedef {{ lanes: Record<string, string>, sourceTypes: Record<string, string>, health: Record<string, string>,
 *   access?: Record<string, string> | readonly string[], egress?: Record<string, string> | readonly string[],
 *   launchTiers?: readonly string[] }} IngestVocabulary
 */

/** @param {Record<string, string> | readonly string[] | undefined} vocabulary @returns {Set<string>} */
function keysOf(vocabulary) {
  if (!vocabulary) return new Set();
  return new Set(Array.isArray(vocabulary) ? vocabulary : Object.keys(vocabulary));
}

export class FrontierIngest {
  /**
   * @param {{ database: any, plugin: any, vocabulary: IngestVocabulary, now?: () => Date, dimension?: number,
   *   pollMs?: number, pageLimit?: number, maxPagesPerPull?: number }} options
   */
  constructor({ database, plugin, vocabulary, now = () => new Date(), dimension = 1024, pollMs = 60_000,
    pageLimit = 500, maxPagesPerPull = 20 }) {
    if (!database || !plugin || !vocabulary) throw new TypeError("The frontier ingest needs the product database, the plugin client and the vocabulary.");
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) throw new TypeError("The frontier page limit is invalid.");
    if (!Number.isSafeInteger(maxPagesPerPull) || maxPagesPerPull < 1 || maxPagesPerPull > 1000) throw new TypeError("The frontier page budget is invalid.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new TypeError("The frontier poll interval is invalid.");
    this.database = database;
    this.plugin = plugin;
    this.now = now;
    this.dimension = dimension;
    this.pollMs = pollMs;
    this.pageLimit = pageLimit;
    this.maxPagesPerPull = maxPagesPerPull;
    this.vocabulary = {
      lanes: keysOf(vocabulary.lanes),
      sourceTypes: keysOf(vocabulary.sourceTypes),
      health: keysOf(vocabulary.health),
      access: keysOf(vocabulary.access),
      egress: keysOf(vocabulary.egress),
      launchTiers: keysOf(vocabulary.launchTiers),
    };
    if (!this.vocabulary.lanes.has(FRONTIER_FALLBACKS.lane) || !this.vocabulary.sourceTypes.has(FRONTIER_FALLBACKS.source_type)) {
      throw new TypeError("The frontier vocabulary must hold its own fallbacks.");
    }
    /** @type {{ state: "unknown" | "compatible" | "incompatible", contract: string | null, version: string | null, checkedAt: string | null }} */
    this.compatibility = { state: "unknown", contract: null, version: null, checkedAt: null };
    /** @type {number | null} */
    this.oldestSeqAvailable = null;
    /** @type {number | null} */
    this.cursor = null;
    /** @type {number | null} */
    this.latestSeq = null;
    /** @type {string | null} */
    this.pluginHealth = null;
    this.lastPullAt = null;
    this.lastPullOkAt = null;
    /** @type {string | null} */
    this.lastError = null;
    this.lastMirrorAt = null;
    this.lastManifestAt = null;
    this.failures = 0;
    this.backoffUntil = 0;
    this.gaps = { count: 0, entries: 0 };
    /** @type {Record<string, number>} */
    this.unknownVocabulary = {};
    /** @type {Record<string, string[]>} a few of the unknown values seen, for whoever reads the status */
    this.unknownValues = {};
    this.counters = { pulls: 0, pullFailures: 0, pages: 0, received: 0, inserted: 0, duplicates: 0, dropped: 0, invalid: 0,
      placeholders: 0, mirrors: 0, mirrorFailures: 0, factKeysDropped: 0, cursorConflicts: 0 };
  }

  /** @param {string} vocabulary @param {unknown} value */
  #unknown(vocabulary, value) {
    this.unknownVocabulary[vocabulary] = (this.unknownVocabulary[vocabulary] ?? 0) + 1;
    const seen = this.unknownValues[vocabulary] ?? [];
    const label = String(value ?? "").slice(0, 60);
    if (!seen.includes(label) && seen.length < MAX_UNKNOWN_VALUES) seen.push(label);
    this.unknownValues[vocabulary] = seen;
  }

  async ready() { return migrateFrontier(this.database, { dimension: this.dimension }); }

  /**
   * Read the manifest and store it with its verdict (`meta.plugin_manifest`).
   * An incompatible contract is recorded, not thrown: the caller reads
   * `compatibility` and the status page says which versions disagree.
   */
  async mirrorManifest() {
    await this.ready();
    const manifest = await this.plugin.manifest();
    const at = this.now().toISOString();
    this.compatibility = {
      state: manifest.compatible ? "compatible" : "incompatible",
      contract: manifest.contract.version,
      version: manifest.plugin.version,
      checkedAt: at,
    };
    this.oldestSeqAvailable = manifest.oldest_seq_available;
    this.lastManifestAt = at;
    const stored = { manifest: { ...manifest, compatible: undefined }, compatible: manifest.compatible, fetchedAt: at };
    await this.database.query(`INSERT INTO evimed_frontier.meta(key, value, updated_at) VALUES ($1, $2::jsonb, clock_timestamp())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
    [FRONTIER_META_KEYS.pluginManifest, JSON.stringify(stored)]);
    return this.compatibility;
  }

  /**
   * One registry row as the mirror stores it: vocabulary checked, fallbacks
   * applied, unknowns counted.
   * @param {Record<string, any>} source
   */
  #sourceRow(source) {
    let lane = source.lane;
    if (!lane || !this.vocabulary.lanes.has(lane)) { this.#unknown("lane", lane); lane = FRONTIER_FALLBACKS.lane; }
    let sourceType = source.source_type;
    if (!sourceType || !this.vocabulary.sourceTypes.has(sourceType)) { this.#unknown("source_type", sourceType); sourceType = FRONTIER_FALLBACKS.source_type; }
    // Stored verbatim, served as `degraded` (the schema's own comment): the
    // word is evidence of what the plugin said, and a reader needs a state.
    const health = source.health ?? FRONTIER_FALLBACKS.health;
    if (!this.vocabulary.health.has(health)) this.#unknown("health", health);
    for (const [name, value] of /** @type {const} */ ([["access", source.access], ["egress", source.egress], ["launchTiers", source.launch_tier]])) {
      const known = this.vocabulary[name];
      if (known.size && (!value || !known.has(value))) this.#unknown(name === "launchTiers" ? "launch_tier" : name, value);
    }
    return {
      id: source.id,
      name: source.name,
      homepage: source.homepage,
      lane,
      source_type: sourceType,
      access: source.access ?? "unknown",
      egress: source.egress ?? "unknown",
      authority: source.authority ?? 2,
      safety_feed: source.safety_feed === true,
      // Independent-source counts are by operating entity (plan §11.6); a row
      // without one counts as its own entity rather than as nobody.
      owner_entity: source.owner_entity ?? source.id,
      launch_tier: source.launch_tier ?? "P2",
      language: source.language,
      region: source.region,
      retired_at: source.retired_at,
      plugin_health: health,
      last_ok_at: source.last_ok_at,
      last_new_entry_at: source.last_new_entry_at,
      entries_7d: source.entries_7d ?? 0,
      registry_sha256: source.registry_sha256,
    };
  }

  /**
   * Mirror the registry. Every plugin field is replaced; the platform's own
   * `enabled` and `selected_30d` are kept. Sources the plugin no longer lists
   * are retired, never deleted — items still point at them.
   */
  async mirrorSources() {
    await this.ready();
    let listing;
    try {
      listing = await this.plugin.sources({ includeRetired: true });
    } catch (error) {
      this.counters.mirrorFailures += 1;
      throw error;
    }
    const rows = listing.sources.map((source) => this.#sourceRow(source));
    const complete = listing.skipped.length === 0 && rows.length > 0;
    const result = await this.database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-frontier-mirror'))");
      // What a card shows of its source: a change of either is a change of the
      // content, and the lists' version has to move with it.
      const before = new Map((await client.query("SELECT id, name, homepage FROM evimed_frontier.sources")).rows
        .map((/** @type {any} */ row) => [row.id, `${row.name}\u0000${row.homepage ?? ""}`]));
      const displayChanged = rows.some((row) => before.has(row.id) && before.get(row.id) !== `${row.name}\u0000${row.homepage ?? ""}`);
      if (rows.length) {
        await client.query(`INSERT INTO evimed_frontier.sources AS s (id, name, homepage, lane, source_type, access, egress, authority,
            safety_feed, owner_entity, launch_tier, language, region, retired_at, plugin_health, last_ok_at, last_new_entry_at,
            entries_7d, registry_sha256, mirrored_at)
          SELECT r.id, r.name, r.homepage, r.lane, r.source_type, r.access, r.egress, r.authority, r.safety_feed, r.owner_entity,
            r.launch_tier, r.language, r.region, r.retired_at, r.plugin_health, r.last_ok_at, r.last_new_entry_at, r.entries_7d,
            r.registry_sha256, clock_timestamp()
          FROM jsonb_to_recordset($1::jsonb) AS r(id text, name text, homepage text, lane text, source_type text, access text,
            egress text, authority smallint, safety_feed boolean, owner_entity text, launch_tier text, language text, region text,
            retired_at timestamptz, plugin_health text, last_ok_at timestamptz, last_new_entry_at timestamptz, entries_7d integer,
            registry_sha256 text)
          ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, homepage=EXCLUDED.homepage, lane=EXCLUDED.lane,
            source_type=EXCLUDED.source_type, access=EXCLUDED.access, egress=EXCLUDED.egress, authority=EXCLUDED.authority,
            safety_feed=EXCLUDED.safety_feed, owner_entity=EXCLUDED.owner_entity, launch_tier=EXCLUDED.launch_tier,
            language=EXCLUDED.language, region=EXCLUDED.region, retired_at=EXCLUDED.retired_at,
            plugin_health=EXCLUDED.plugin_health, last_ok_at=EXCLUDED.last_ok_at, last_new_entry_at=EXCLUDED.last_new_entry_at,
            entries_7d=EXCLUDED.entries_7d, registry_sha256=EXCLUDED.registry_sha256, mirrored_at=EXCLUDED.mirrored_at`,
        [JSON.stringify(rows)]);
      }
      let retired = 0;
      if (complete) {
        retired = (await client.query(`UPDATE evimed_frontier.sources SET retired_at = clock_timestamp(), mirrored_at = clock_timestamp()
          WHERE retired_at IS NULL AND NOT (id = ANY($1::text[]))`, [rows.map((row) => row.id)])).rowCount ?? 0;
      }
      if (displayChanged) await bumpFrontierVersion(client);
      return { retired, displayChanged };
    });
    this.counters.mirrors += 1;
    this.lastMirrorAt = this.now().toISOString();
    return { mirrored: rows.length, skipped: listing.skipped.length, retired: result.retired, complete };
  }

  /**
   * The stored row for one entry: the platform's own rules applied.
   * @param {Record<string, any>} entry a contract `Entry` the client accepted
   */
  #entryRow(entry) {
    const { facts, dropped } = whitelistFacts(entry.facts);
    if (dropped.length) this.counters.factKeysDropped += dropped.length;
    let laneHint = entry.lane_hint ?? null;
    if (laneHint && !this.vocabulary.lanes.has(laneHint)) { this.#unknown("lane_hint", laneHint); laneHint = FRONTIER_FALLBACKS.lane; }
    let precision = entry.date_precision ?? "instant";
    if (!DATE_PRECISIONS.has(precision)) {
      // Not knowing how precise a date is is itself imprecision: say so.
      this.#unknown("date_precision", precision);
      precision = "inferred";
    }
    const defects = [];
    for (const defect of entry.defects ?? []) {
      if (DEFECTS.has(defect)) defects.push(defect);
      else this.#unknown("defect", defect);
    }
    /** @type {string | null} */
    let reason = null;
    if (!httpLink(entry.url) || !httpLink(entry.canonical_url)) reason = "url_scheme_invalid";
    else if (!IDENTITY_KEY.test(entry.identity_key)) reason = "identity_key_invalid";
    return {
      plugin_entry_id: entry.entry_id,
      plugin_seq: entry.seq,
      revision: entry.revision,
      source_id: entry.source_id,
      identity_key: entry.identity_key,
      url: entry.url,
      canonical_url: entry.canonical_url,
      doi: entry.doi,
      pmid: entry.pmid,
      registry_ids: entry.registry_ids,
      title_raw: entry.title,
      summary_raw: entry.summary,
      facts,
      lang: entry.language,
      lane_hint: laneHint,
      published_at: entry.published_at,
      date_precision: precision,
      first_seen_at: entry.first_seen_at,
      content_sha256: entry.content_sha256,
      backfill: entry.backfill,
      defects,
      state: reason ? "dropped" : entry.backfill ? "backfill" : "received",
      state_reason: reason,
    };
  }

  /** Source ids of these entries the mirror does not hold. @param {Record<string, any>[]} entries */
  async #unknownSources(entries) {
    const ids = [...new Set(entries.map((entry) => entry.source_id))];
    if (!ids.length) return [];
    const known = new Set((await this.database.query("SELECT id FROM evimed_frontier.sources WHERE id = ANY($1::text[])", [ids]))
      .rows.map((/** @type {any} */ row) => row.id));
    return ids.filter((id) => !known.has(id));
  }

  /**
   * Store one page and move the cursor, in one transaction.
   * @param {Record<string, any>[]} rows @param {number} expected the cursor the page was asked with
   * @param {number} nextAfter @param {string[]} placeholders source ids to create first
   * @returns {Promise<{ inserted: number, conflict: boolean }>}
   */
  async #storePage(rows, expected, nextAfter, placeholders) {
    return this.database.transaction(async (/** @type {any} */ client) => {
      const locked = await client.query("SELECT value FROM evimed_frontier.meta WHERE key=$1 FOR UPDATE", [FRONTIER_META_KEYS.pluginCursor]);
      const stored = metaNumber(locked.rows[0]?.value);
      if (stored !== expected) return { inserted: 0, conflict: true };
      if (placeholders.length) {
        await client.query(`INSERT INTO evimed_frontier.sources (id, name, lane, source_type, access, egress, owner_entity, launch_tier, plugin_health)
          SELECT id, id, $2, $3, 'unknown', 'unknown', id, 'P2', $4 FROM unnest($1::text[]) AS p(id)
          ON CONFLICT (id) DO NOTHING`, [placeholders, FRONTIER_FALLBACKS.lane, FRONTIER_FALLBACKS.source_type, FRONTIER_FALLBACKS.health]);
      }
      let inserted = 0;
      if (rows.length) {
        const result = await client.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, revision, source_id,
            identity_key, url, canonical_url, doi, pmid, registry_ids, title_raw, summary_raw, facts, lang, lane_hint, published_at,
            date_precision, first_seen_at, content_sha256, backfill, defects, state, state_reason)
          SELECT r.plugin_entry_id, r.plugin_seq, r.revision, r.source_id, r.identity_key, r.url, r.canonical_url, r.doi, r.pmid,
            coalesce(r.registry_ids, '{}'), r.title_raw, r.summary_raw, coalesce(r.facts, '{}'::jsonb), r.lang, r.lane_hint,
            r.published_at, r.date_precision, r.first_seen_at, r.content_sha256, r.backfill, coalesce(r.defects, '{}'), r.state,
            r.state_reason
          FROM jsonb_to_recordset($1::jsonb) AS r(plugin_entry_id text, plugin_seq bigint, revision integer, source_id text,
            identity_key text, url text, canonical_url text, doi text, pmid text, registry_ids text[], title_raw text,
            summary_raw text, facts jsonb, lang text, lane_hint text, published_at timestamptz, date_precision text,
            first_seen_at timestamptz, content_sha256 text, backfill boolean, defects text[], state text, state_reason text)
          ON CONFLICT (plugin_entry_id, revision) DO NOTHING`, [JSON.stringify(rows)]);
        inserted = result.rowCount ?? 0;
      }
      if (nextAfter > stored) {
        await client.query(`UPDATE evimed_frontier.meta SET value = to_jsonb($2::bigint), updated_at = clock_timestamp() WHERE key=$1`,
          [FRONTIER_META_KEYS.pluginCursor, nextAfter]);
      }
      return { inserted, conflict: false };
    });
  }

  /** The stored cursor. */
  async #storedCursor() {
    const result = await this.database.query("SELECT value FROM evimed_frontier.meta WHERE key=$1", [FRONTIER_META_KEYS.pluginCursor]);
    return metaNumber(result.rows[0]?.value);
  }

  /**
   * A cursor behind what the plugin still holds resumes from there, and the
   * entries it skipped are counted (see the module header).
   * @param {number} cursor
   */
  async #resyncIfPurged(cursor) {
    const oldest = this.oldestSeqAvailable;
    if (oldest == null || oldest <= cursor + 1) return cursor;
    const resumed = oldest - 1;
    const moved = await this.database.transaction(async (/** @type {any} */ client) => {
      const locked = await client.query("SELECT value FROM evimed_frontier.meta WHERE key=$1 FOR UPDATE", [FRONTIER_META_KEYS.pluginCursor]);
      if (metaNumber(locked.rows[0]?.value) !== cursor) return false;
      await client.query(`UPDATE evimed_frontier.meta SET value = to_jsonb($2::bigint), updated_at = clock_timestamp() WHERE key=$1`,
        [FRONTIER_META_KEYS.pluginCursor, resumed]);
      return true;
    });
    if (!moved) return this.#storedCursor();
    if (cursor > 0) {
      this.gaps.count += 1;
      this.gaps.entries += resumed - cursor;
    }
    return resumed;
  }

  /** Whether a pull may run now (not inside a backoff window). */
  due() { return this.now().getTime() >= this.backoffUntil; }

  /**
   * Pull the stream from the stored cursor: pages until the plugin says there
   * is no more, at most `maxPagesPerPull` of them — the rest is the next
   * pull's.
   * @returns {Promise<Record<string, any>>}
   */
  async pull() {
    if (!this.due()) return { skipped: "backoff", retryAt: new Date(this.backoffUntil).toISOString() };
    this.counters.pulls += 1;
    this.lastPullAt = this.now().toISOString();
    const totals = { pages: 0, received: 0, inserted: 0, duplicates: 0, dropped: 0, invalid: 0 };
    try {
      await this.ready();
      if (this.compatibility.state !== "compatible") await this.mirrorManifest();
      if (this.compatibility.state !== "compatible") {
        this.lastError = "knowledge_plugin_incompatible";
        return { skipped: "incompatible", contract: this.compatibility.contract };
      }
      // Liveness and the latest seq ride along; a health failure is not a
      // pull failure — the stream itself answers for that below.
      try {
        const health = await this.plugin.health();
        this.latestSeq = health.latest_seq;
        this.pluginHealth = health.status;
        if (!health.compatible) {
          // Upgraded under us: the manifest is the authority, read it now.
          await this.mirrorManifest();
          if (this.compatibility.state !== "compatible") {
            this.lastError = "knowledge_plugin_incompatible";
            return { skipped: "incompatible", contract: this.compatibility.contract };
          }
        }
      } catch {
        this.pluginHealth = null;
      }
      let cursor = await this.#resyncIfPurged(await this.#storedCursor());
      let remirrored = false;
      for (let page = 0; page < this.maxPagesPerPull; page += 1) {
        const answer = await this.plugin.entries({ after: cursor, limit: this.pageLimit });
        totals.pages += 1;
        totals.received += answer.entries.length + answer.skipped.length;
        totals.invalid += answer.skipped.length;
        let unknown = await this.#unknownSources(answer.entries);
        if (unknown.length && !remirrored) {
          remirrored = true;
          await this.mirrorSources().catch(() => null);
          unknown = await this.#unknownSources(answer.entries);
        }
        if (unknown.length) this.counters.placeholders += unknown.length;
        const rows = answer.entries.map((entry) => this.#entryRow(entry));
        const stored = await this.#storePage(rows, cursor, answer.nextAfter, unknown);
        if (stored.conflict) {
          // Another control plane moved the cursor first; its page stands.
          this.counters.cursorConflicts += 1;
          cursor = await this.#storedCursor();
          break;
        }
        totals.inserted += stored.inserted;
        totals.duplicates += rows.length - stored.inserted;
        totals.dropped += rows.filter((row) => row.state === "dropped").length;
        cursor = Math.max(cursor, answer.nextAfter);
        if (!answer.hasMore) break;
      }
      this.cursor = cursor;
      this.counters.pages += totals.pages;
      this.counters.received += totals.received;
      this.counters.inserted += totals.inserted;
      this.counters.duplicates += totals.duplicates;
      this.counters.dropped += totals.dropped;
      this.counters.invalid += totals.invalid;
      this.failures = 0;
      this.backoffUntil = 0;
      this.lastError = null;
      this.lastPullOkAt = this.now().toISOString();
      return { ...totals, cursor };
    } catch (error) {
      this.counters.pullFailures += 1;
      this.failures += 1;
      const code = typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "frontier_pull_failed";
      this.lastError = code;
      const retryAfter = Number(/** @type {any} */ (error)?.retryAfterSeconds) * 1000;
      const wait = Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** Math.min(this.failures - 1, 10));
      this.backoffUntil = this.now().getTime() + Math.max(wait, Number.isFinite(retryAfter) ? retryAfter : 0);
      throw error;
    }
  }

  /** What readiness, metrics and the status route read about the plugin. */
  status() {
    const lag = this.latestSeq != null && this.cursor != null ? Math.max(0, this.latestSeq - this.cursor) : null;
    // `degraded` also covers "not verified yet": before the first pull there
    // is no evidence the plugin answers, and `ok` would claim some.
    /** @type {"ok" | "degraded" | "unreachable" | "incompatible" | "unconfigured"} */
    let state = "ok";
    if (!this.plugin.configured) state = "unconfigured";
    else if (this.compatibility.state === "incompatible") state = "incompatible";
    else if (this.lastError && UNREACHABLE_CODES.has(this.lastError)) state = "unreachable";
    else if (this.lastError || !this.lastPullOkAt || (this.pluginHealth && this.pluginHealth !== "ok")) state = "degraded";
    return {
      state,
      contract: this.compatibility.contract,
      version: this.compatibility.version,
      compatibility: this.compatibility.state,
      pluginHealth: this.pluginHealth,
      lastPullAt: this.lastPullAt,
      lastPullOkAt: this.lastPullOkAt,
      lastError: this.lastError,
      cursor: this.cursor,
      latestSeq: this.latestSeq,
      lag,
      oldestSeqAvailable: this.oldestSeqAvailable,
      lastMirrorAt: this.lastMirrorAt,
      lastManifestAt: this.lastManifestAt,
      backoffUntil: this.backoffUntil ? new Date(this.backoffUntil).toISOString() : null,
      gaps: { ...this.gaps },
      unknownVocabulary: { ...this.unknownVocabulary },
      unknownValues: Object.fromEntries(Object.entries(this.unknownValues).map(([key, values]) => [key, [...values]])),
      counters: { ...this.counters },
    };
  }
}
