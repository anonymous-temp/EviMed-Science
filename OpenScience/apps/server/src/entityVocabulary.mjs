/**
 * The platform's one entity vocabulary (evidence-flywheel plan §4.2, B3): the
 * frontier feed's glossary and entity keys, made the join key every module
 * calls instead of matching titles.
 *
 * Hidden knowledge:
 *
 * - **The frontier computes nothing different.** The glossary, its reader and
 *   the entity-key function are `frontierGlossary.mjs`'s (they were never
 *   inside the pipeline); this module shares the one `FrontierGlossaryStore`
 *   with the pipeline, so an item's stored keys and a card's keys come out of
 *   the same cache and the same `entityKeys` function. `keysForEntities` is
 *   that function, called on the names an editor already extracted.
 * - **Free text is tagged by a closed vocabulary, never by guessing.** A zone
 *   title, an agenda prompt or a study question is searched for the glossary's
 *   terms — Chinese as substrings, Latin as whole words (an acronym only as
 *   written), the longest term first so `heart failure with preserved ejection
 *   fraction` is one disease and not two — and for DOIs, PMIDs and registry
 *   numbers by format. A name the glossary does not hold is not a key, and no
 *   model reads the text (principle 1: regex never does language, and here
 *   nothing is asked to).
 * - **Organisations are not tagged out of text.** `FDA` and `WHO` stand in the
 *   text of any topic; a join through one would match half the feed. Drugs,
 *   diseases and trials are what a record is about (`ENTITY_TEXT_KINDS`).
 * - **`null` is the vocabulary being unable to tag; `[]` is it finding nothing.**
 *   With the frontier module off, or a glossary that is empty (not seeded yet,
 *   or unreadable), every function answers `[]` and no table is touched; the
 *   stores underneath use {@link EntityVocabulary.tag}, which says `null`, so a
 *   record made in that state stays untagged and the backfill finds it once the
 *   glossary exists, instead of a hollow `[]` standing for good.
 * - **A backfill is bounded and owner-scoped.** Each module registers a runner
 *   that tags its rows still without keys, `ENTITY_BACKFILL_PASS_ROWS` at a
 *   time, reading and writing each row through its owner; the vocabulary runs
 *   them after each (re)load of a non-empty glossary, at most
 *   `ENTITY_BACKFILL_MAX_PASSES` passes each, and a runner that fails is
 *   counted and left for the next load.
 *
 * Which model capability would make it deletable: none for the keys — they are
 * the deterministic join. The text tagging could give way to a model that reads
 * a card and names its entities once the platform trusts that extraction as it
 * trusts a glossary lookup.
 *
 * @module entityVocabulary
 */

import {
  ENTITY_KEY_MAX_CHARS, ENTITY_TEXT_KINDS, identifierKeys, identifierKeysInText, keyKind, overlap, splitKeys,
} from "@evimed/domain/entity-keys";
import { FrontierGlossaryStore } from "./frontierGlossary.mjs";

export { identifierKeys, overlap };

/** At most this many texts are searched in one tagging. */
export const ENTITY_TAGGING_MAX_TEXTS = 24;
/** Each text is searched up to this many characters. */
export const ENTITY_TAGGING_MAX_TEXT_CHARS = 20_000;
/** At most this many entity keys, and at most this many identifier keys, come back for one record. */
export const ENTITY_TAGGING_MAX_ENTITY_KEYS = 24;
export const ENTITY_TAGGING_MAX_IDENTIFIER_KEYS = 16;
/** Rows one backfill pass tags, and the passes a glossary load may run. */
export const ENTITY_BACKFILL_PASS_ROWS = 100;
export const ENTITY_BACKFILL_MAX_PASSES = 10;
/** An empty glossary is looked for again after this long, so a table seeded after boot is picked up. */
export const ENTITY_EMPTY_GLOSSARY_RETRY_MS = 30_000;
/** The most keys `describe` explains in one call. */
export const ENTITY_DESCRIBE_MAX_KEYS = 200;
/** The most published items one lookup returns. */
export const FRONTIER_MATCH_MAX_LIMIT = 100;
/** The most keys one lookup is asked about. */
const FRONTIER_MATCH_MAX_KEYS = 64;

/** @param {unknown} value @returns {unknown[]} */
const listOf = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
/** @param {string} left @param {string} right */
const byCode = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The entity keys a set of texts names: every glossary term found, the
 * longest first where terms overlap (a term inside a longer one is not a
 * second mention), kept when its kind is one text is tagged with. Ranked by
 * where it first appears, cut at `limit`, returned sorted so an unchanged text
 * gives an unchanged array.
 * @param {import("./frontierGlossary.mjs").FrontierGlossary} glossary
 * @param {readonly string[]} texts
 * @param {{ kinds?: readonly string[], limit?: number }} [options]
 * @returns {{ keys: string[], truncated: boolean }}
 */
export function entityKeysInTexts(glossary, texts, { kinds = ENTITY_TEXT_KINDS, limit = ENTITY_TAGGING_MAX_ENTITY_KEYS } = {}) {
  /** @type {string[]} */
  const ranked = [];
  for (const text of texts) {
    const spans = glossary.spans(text);
    if (!spans.length) continue;
    const claimed = new Uint8Array(spans.reduce((end, span) => Math.max(end, span.end), 0));
    const taken = [];
    for (const span of [...spans].sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start)) {
      let free = true;
      for (let at = span.start; at < span.end; at += 1) if (claimed[at]) { free = false; break; }
      if (!free) continue;
      claimed.fill(1, span.start, span.end);
      taken.push(span);
    }
    for (const span of taken.sort((left, right) => left.start - right.start)) {
      if (!kinds.includes(span.entry.kind)) continue;
      const key = glossary.entityKey(/** @type {any} */ (span.entry.kind), span.entry.termEn);
      if (key && !ranked.includes(key)) ranked.push(key);
    }
  }
  return { keys: ranked.slice(0, limit).sort(byCode), truncated: ranked.length > limit };
}

/**
 * The identifier keys of what a caller states beside its texts: an object
 * (`doi`/`dois`, `pmid`/`pmids`, `registryIds`/`registryId`) or a list whose
 * strings are read as text and whose objects as such an object.
 * @param {unknown} identifiers
 * @returns {string[]}
 */
function statedIdentifierKeys(identifiers) {
  /** @param {any} value */
  const asObject = (value) => identifierKeys({
    doi: [...listOf(value?.doi), ...listOf(value?.dois)], pmid: [...listOf(value?.pmid), ...listOf(value?.pmids)],
    registryIds: [...listOf(value?.registryIds), ...listOf(value?.registryId)],
  });
  if (Array.isArray(identifiers)) {
    const parts = identifiers.slice(0, ENTITY_TAGGING_MAX_TEXTS);
    return [
      ...identifierKeysInText(parts.filter((part) => typeof part === "string").join("\n")),
      ...parts.filter((part) => part && typeof part === "object").flatMap(asObject),
    ];
  }
  if (typeof identifiers === "string") return identifierKeysInText(identifiers);
  return identifiers && typeof identifiers === "object" ? asObject(identifiers) : [];
}

/**
 * Published frontier items that share an identifier key, or at least one
 * entity key, with the keys asked about — identifier matches first, newest
 * first, then entity matches by how many keys they share, then newest. Items
 * the feed withdrew, never published, or whose source is switched off are not
 * there. An identifier is read from `item_keys` (the table the pipeline writes
 * every DOI, PMID and registry key into) and, for a registry number and a
 * DOI, from the item's own columns: a registry key already given to an
 * earlier item of the same trial is not written again.
 * @param {any} database the product database
 * @param {{ entityKeys?: unknown, identifierKeys?: unknown, since?: Date | string | null, limit?: number }} [query]
 *   The two key lists may each carry keys of either kind: they are read together.
 * @returns {Promise<FrontierItemMatch[]>}
 */
export async function frontierItemsMatching(database, { entityKeys = [], identifierKeys: identifiers = [], since = null, limit = 20 } = {}) {
  const asked = splitKeys([...listOf(entityKeys), ...listOf(identifiers)]);
  const entities = asked.entityKeys.slice(0, FRONTIER_MATCH_MAX_KEYS);
  const wanted = asked.identifierKeys.slice(0, FRONTIER_MATCH_MAX_KEYS);
  if (!entities.length && !wanted.length) return [];
  const size = Math.max(1, Math.min(FRONTIER_MATCH_MAX_LIMIT, Math.trunc(Number(limit)) || 20));
  const from = since == null ? null : new Date(since);
  if (from && Number.isNaN(from.getTime())) throw new TypeError("frontierItemsMatching: `since` is not a date.");
  const sinceIso = from ? from.toISOString() : null;
  /** @type {FrontierItemMatch[]} */
  const matches = [];
  if (wanted.length) {
    const dois = wanted.filter((key) => keyKind(key) === "doi").map((key) => key.slice(4));
    const registered = wanted.filter((key) => keyKind(key) === "reg").map((key) => key.slice(4));
    // Each way an item states an identifier is read through its own index, and the hits are joined to the items.
    const rows = (await database.query(`WITH hits AS (
        SELECT k.item_id AS id FROM evimed_frontier.item_keys k WHERE k.key = ANY($1::text[])
        UNION SELECT i.id FROM evimed_frontier.items i WHERE i.registry_ids && $2::text[]
        UNION SELECT i.id FROM evimed_frontier.items i WHERE lower(i.doi) = ANY($3::text[])
      ) SELECT ${ITEM_COLUMNS},
        (SELECT coalesce(array_agg(k.key), '{}') FROM evimed_frontier.item_keys k WHERE k.item_id = i.id AND k.key = ANY($1::text[])) AS matched_keys
      FROM hits JOIN evimed_frontier.items i ON i.id = hits.id JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND ($4::timestamptz IS NULL OR i.timeline_at >= $4::timestamptz)
      ORDER BY i.timeline_at DESC, i.id DESC LIMIT ${size}`, [wanted, registered, dois, sinceIso])).rows ?? [];
    for (const row of rows) matches.push(matchOf(row, "identifier", wanted, entities, listOf(row.matched_keys).map(String)));
  }
  if (entities.length && matches.length < size) {
    const rows = (await database.query(`SELECT ${ITEM_COLUMNS}
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.state = 'published' AND s.enabled AND i.entity_keys && $1::text[] AND ($2::timestamptz IS NULL OR i.timeline_at >= $2::timestamptz)
        AND i.id <> ALL($3::bigint[])
      ORDER BY (SELECT count(*) FROM unnest(i.entity_keys) shared WHERE shared = ANY($1::text[])) DESC, i.timeline_at DESC, i.id DESC
      LIMIT ${size - matches.length}`, [entities, sinceIso, matches.map((match) => match.id)])).rows ?? [];
    for (const row of rows) matches.push(matchOf(row, "entity", wanted, entities, []));
  }
  return matches;
}

/** The columns a match carries: enough to name the item and link it, none of its text. */
const ITEM_COLUMNS = `i.id, i.public_id, i.title_raw, i.title_zh, i.summary_zh, i.lane, i.source_type, i.evidence_type, i.published_at,
  i.timeline_at, i.doi, i.pmid, i.registry_ids, i.flags, i.safety_alert, i.entity_keys, s.name AS source_name`;

/**
 * @typedef {object} FrontierItemMatch
 * @property {string} id the item's row id, as a string
 * @property {string} publicId
 * @property {"identifier" | "entity"} matchedBy
 * @property {string[]} matchedIdentifierKeys the identifier keys asked about that name this item
 * @property {string[]} matchedEntityKeys the entity keys asked about that this item carries
 * @property {string} titleRaw @property {string | null} titleZh @property {string | null} summaryZh
 * @property {string} lane @property {string} sourceType @property {string | null} sourceName @property {string | null} evidenceType
 * @property {string | null} publishedAt @property {string} timelineAt
 * @property {string | null} doi @property {string | null} pmid @property {string[]} registryIds
 * @property {string[]} flags @property {boolean} safetyAlert @property {string[]} entityKeys
 */

/**
 * @param {any} row @param {"identifier" | "entity"} matchedBy @param {string[]} wanted @param {string[]} entities
 * @param {string[]} viaKeys the identifier keys `item_keys` holds for this item among those asked
 * @returns {FrontierItemMatch}
 */
function matchOf(row, matchedBy, wanted, entities, viaKeys) {
  const own = identifierKeys({ doi: row.doi, pmid: row.pmid, registryIds: row.registry_ids });
  const ownEntities = listOf(row.entity_keys).map(String);
  const iso = (/** @type {any} */ value) => (value ? new Date(value).toISOString() : null);
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    matchedBy,
    matchedIdentifierKeys: [...new Set([...own.filter((key) => wanted.includes(key)), ...viaKeys.filter((key) => wanted.includes(key))])].sort(byCode),
    matchedEntityKeys: entities.filter((key) => ownEntities.includes(key)),
    titleRaw: String(row.title_raw),
    titleZh: row.title_zh ?? null,
    summaryZh: row.summary_zh ?? null,
    lane: String(row.lane),
    sourceType: String(row.source_type),
    sourceName: row.source_name ?? null,
    evidenceType: row.evidence_type ?? null,
    publishedAt: iso(row.published_at),
    timelineAt: /** @type {string} */ (iso(row.timeline_at)),
    doi: row.doi ?? null,
    pmid: row.pmid ?? null,
    registryIds: listOf(row.registry_ids).map(String),
    flags: listOf(row.flags).map(String),
    safetyAlert: row.safety_alert === true,
    entityKeys: ownEntities,
  };
}

/**
 * The glossary's display names, by key: the Chinese name a reader knows the
 * entity by, or the term as written where the glossary keeps it so.
 * @param {import("./frontierGlossary.mjs").FrontierGlossary} glossary
 * @returns {Map<string, string>}
 */
function labelsOf(glossary) {
  /** @type {Map<string, string>} */
  const labels = new Map();
  for (const entry of glossary.entries) {
    if (!["drug", "disease", "trial", "org"].includes(entry.kind)) continue;
    const key = glossary.entityKey(/** @type {any} */ (entry.kind), entry.termEn);
    if (key && !labels.has(key)) labels.set(key, entry.keepOriginal ? entry.termEn : entry.termZh);
  }
  return labels;
}

/**
 * @typedef {object} EntityVocabularyStats
 * @property {boolean} enabled
 * @property {number} glossaryEntries the glossary's size as last loaded (0 before the first load)
 * @property {{ found: number, empty: number, unavailable: number, truncated: number, backfillFailures: number, backfilled: Record<string, number> }} counters
 */

/**
 * @typedef {object} EntityVocabulary
 * @property {boolean} enabled
 * @property {{ current: () => Promise<any> } | null} glossaryStore the glossary reader the frontier pipeline shares
 * @property {(entities: any) => Promise<string[]>} keysForEntities the frontier's own key function over an item's extracted names
 * @property {(input?: { texts?: unknown, identifiers?: unknown }) => Promise<string[]>} keysForText
 * @property {(input?: { texts?: unknown, identifiers?: unknown }) => Promise<string[] | null>} tag `keysForText`, but `null` when the vocabulary cannot tag
 * @property {(input?: { texts?: unknown, identifiers?: unknown }) => Promise<string[]>} entityKeysFor the adapter the evidence-zone service receives
 * @property {(keys: unknown) => Promise<Array<{ key: string, type: string, label: string }>>} describe
 * @property {() => Promise<{ entries: number }>} refresh
 * @property {typeof identifierKeys} identifierKeys
 * @property {(query?: Parameters<typeof frontierItemsMatching>[1]) => Promise<FrontierItemMatch[]>} frontierItemsMatching
 * @property {(name: string, runner: (pass: { limit: number }) => Promise<{ tagged: number }>) => void} registerBackfill
 * @property {() => Promise<Record<string, number>>} backfill
 * @property {() => EntityVocabularyStats} stats
 */

/**
 * @param {{ database?: any, enabled?: boolean, now?: () => Date | number, ttlMs?: number,
 *   store?: { current: () => Promise<any>, refresh?: () => Promise<any>, loadedAt?: number, glossary?: any } | null,
 *   report?: (code: string) => void }} [options]
 *   `enabled` is the frontier module's switch; off, or without a database,
 *   nothing is ever read. `store` is a glossary reader of the caller's own
 *   (tests; the default reads `evimed_frontier.glossary`).
 * @returns {EntityVocabulary}
 */
export function createEntityVocabulary({ database = null, enabled = false, now = () => Date.now(), ttlMs, store = null, report = () => {} } = {}) {
  const clock = () => { const value = now(); return value instanceof Date ? value.getTime() : Number(value); };
  const on = Boolean(enabled) && Boolean(store || database);
  const glossaryStore = on ? (store ?? new FrontierGlossaryStore({ database, now: clock, ...(ttlMs ? { ttlMs } : {}) })) : null;
  const counters = { found: 0, empty: 0, unavailable: 0, truncated: 0, backfillFailures: 0, /** @type {Record<string, number>} */ backfilled: {} };
  /** @type {Map<string, (pass: { limit: number }) => Promise<{ tagged: number }>>} */
  const runners = new Map();
  /** @type {Promise<Record<string, number>> | null} */
  let running = null;
  /** The glossary the last load produced, to notice a new one. @type {any} */
  let seen = null;
  /** @type {WeakMap<object, Map<string, string>>} */
  const labelCache = new WeakMap();

  /** One pass over every registered runner, bounded; a failing runner is counted and left. */
  function backfill() {
    if (running) return running;
    running = (async () => {
      /** @type {Record<string, number>} */
      const tagged = {};
      for (const [name, runner] of runners) {
        tagged[name] = 0;
        try {
          for (let pass = 0; pass < ENTITY_BACKFILL_MAX_PASSES; pass += 1) {
            const { tagged: count } = await runner({ limit: ENTITY_BACKFILL_PASS_ROWS });
            tagged[name] += count;
            counters.backfilled[name] = (counters.backfilled[name] ?? 0) + count;
            if (count < ENTITY_BACKFILL_PASS_ROWS) break;
          }
        } catch (error) {
          counters.backfillFailures += 1;
          report(`entity vocabulary backfill ${name}: ${typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "failed"}`);
        }
      }
      return tagged;
    })().finally(() => { running = null; });
    return running;
  }

  /** The glossary, or null while the vocabulary cannot tag: off, unreadable or still empty. */
  async function available() {
    if (!glossaryStore) return null;
    let glossary = await glossaryStore.current();
    if (!glossary.size && typeof glossaryStore.refresh === "function" && clock() - (Number(glossaryStore.loadedAt) || 0) >= ENTITY_EMPTY_GLOSSARY_RETRY_MS) {
      glossary = await glossaryStore.refresh();
    }
    if (glossary !== seen) {
      seen = glossary;
      // A glossary that just arrived is the moment rows made without one can be tagged.
      if (glossary.size && runners.size) void backfill();
    }
    return glossary.size ? glossary : null;
  }

  /** @type {EntityVocabulary["tag"]} */
  async function tag({ texts = [], identifiers = null } = {}) {
    const glossary = await available();
    if (!glossary) { counters.unavailable += 1; return null; }
    const searched = listOf(texts).filter((text) => typeof text === "string" && text.trim())
      .slice(0, ENTITY_TAGGING_MAX_TEXTS).map((text) => String(text).slice(0, ENTITY_TAGGING_MAX_TEXT_CHARS));
    const { keys: entities, truncated } = entityKeysInTexts(glossary, searched);
    const stated = splitKeys([...searched.flatMap((text) => identifierKeysInText(text)), ...statedIdentifierKeys(identifiers)]).identifierKeys;
    const kept = [...entities, ...stated.slice(0, ENTITY_TAGGING_MAX_IDENTIFIER_KEYS)].filter((key) => key.length <= ENTITY_KEY_MAX_CHARS);
    if (truncated || stated.length > ENTITY_TAGGING_MAX_IDENTIFIER_KEYS) counters.truncated += 1;
    counters[kept.length ? "found" : "empty"] += 1;
    return kept;
  }

  /** @type {EntityVocabulary["keysForText"]} */
  const keysForText = async (input) => (await tag(input)) ?? [];

  return {
    enabled: on,
    glossaryStore,
    identifierKeys,
    tag,
    keysForText,
    entityKeysFor: keysForText,

    async keysForEntities(entities) {
      const glossary = await available();
      if (!glossary) { counters.unavailable += 1; return []; }
      const keys = glossary.entityKeys(entities);
      counters[keys.length ? "found" : "empty"] += 1;
      return keys;
    },

    async describe(keys) {
      const glossary = await available();
      if (!glossary) return [];
      let labels = labelCache.get(glossary);
      if (!labels) { labels = labelsOf(glossary); labelCache.set(glossary, labels); }
      /** @type {Array<{ key: string, type: string, label: string }>} */
      const described = [];
      for (const key of [...new Set(listOf(keys))].slice(0, ENTITY_DESCRIBE_MAX_KEYS)) {
        const kind = keyKind(key);
        if (!kind || typeof key !== "string") continue;
        const name = key.slice(kind.length + 1);
        described.push({ key, type: kind === "reg" ? "registry" : kind,
          label: kind === "pmid" ? `PMID ${name}` : kind === "doi" || kind === "reg" ? name : labels.get(key) ?? name });
      }
      return described;
    },

    async refresh() {
      if (!glossaryStore) return { entries: 0 };
      const glossary = typeof glossaryStore.refresh === "function" ? await glossaryStore.refresh() : await glossaryStore.current();
      if (glossary !== seen) {
        seen = glossary;
        if (glossary.size && runners.size) await backfill();
      }
      return { entries: glossary.size };
    },

    frontierItemsMatching: async (query) => (on && database ? frontierItemsMatching(database, query) : []),

    registerBackfill(name, runner) { runners.set(String(name), runner); },
    backfill: async () => (on ? backfill() : {}),

    stats: () => ({ enabled: on, glossaryEntries: glossaryStore?.glossary?.size ?? 0, counters: { ...counters, backfilled: { ...counters.backfilled } } }),
  };
}

/**
 * The operator metrics: the glossary's size, and what the taggings found.
 * @param {EntityVocabularyStats | null} stats
 * @returns {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]}
 */
export function entityVocabularyMetricFamilies(stats) {
  const families = [{ name: "open_science_entity_vocabulary_enabled", help: "Whether the shared entity vocabulary is composed in this process (it follows the frontier module).",
    type: /** @type {"gauge"} */ ("gauge"), series: [{ value: stats?.enabled ? 1 : 0 }] }];
  if (!stats?.enabled) return families;
  const { counters } = stats;
  families.push(
    { name: "open_science_entity_vocabulary_glossary_entries", help: "Glossary entries as last loaded (0 until the first load, or while the glossary is empty).",
      type: "gauge", series: [{ value: stats.glossaryEntries }] },
    { name: "open_science_entity_vocabulary_taggings_total", help: "Taggings by outcome since process start: found keys, found none, or could not tag (module off, glossary empty).",
      type: /** @type {any} */ ("counter"), series: [
        { labels: { outcome: "found" }, value: counters.found }, { labels: { outcome: "empty" }, value: counters.empty },
        { labels: { outcome: "unavailable" }, value: counters.unavailable }] },
    { name: "open_science_entity_vocabulary_truncated_total", help: "Taggings whose keys were cut at the per-record bound.",
      type: /** @type {any} */ ("counter"), series: [{ value: counters.truncated }] },
    { name: "open_science_entity_vocabulary_backfilled_total", help: "Rows tagged by the backfill, by module.",
      type: /** @type {any} */ ("counter"), series: Object.entries(counters.backfilled).map(([module, value]) => ({ labels: { module }, value })) },
    { name: "open_science_entity_vocabulary_backfill_failures_total", help: "Backfill runs that failed and were left for the next glossary load.",
      type: /** @type {any} */ ("counter"), series: [{ value: counters.backfillFailures }] },
  );
  return families;
}
