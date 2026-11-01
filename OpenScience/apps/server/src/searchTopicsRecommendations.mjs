import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { CATEGORIES, RECOMMENDATION_ALGORITHM, validateFeed } from '@evimed/dsh-search-topics/contract';
import { frontierChannelSql } from './frontierService.mjs';
import { SEARCH_TOPICS_MAX_BYTES as MAX_FEED_BYTES } from './searchTopicsRuntime.mjs';
import { HttpError } from './security.mjs';
import { createSearchTopicsTrialSource } from './searchTopicsTrialSource.mjs';

const DAY = 86_400_000;
export const SEARCH_TOPICS_REFRESH_MS = 5 * 60_000;
export const SEARCH_TOPICS_STALE_MS = DAY;
export const SEARCH_TOPICS_ALGORITHM = RECOMMENDATION_ALGORITHM;
const MAX_TOPICS = 12;
const CANDIDATES_PER_CATEGORY = 60;
const REGISTRY_SOURCE = 'clinicaltrials-v2-interventional';
const unavailable = () => new HttpError(503, 'evimed_search_topics_unavailable', 'Search topic recommendations are temporarily unavailable.');
const clip = (value, max) => [...String(value ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim()].slice(0, max).join('');
const iso = value => value == null || !Number.isFinite(new Date(value).getTime()) ? null : new Date(value).toISOString();

/** Published medical developments only. No search logs, generated topics or user records enter this query. */
export const SEARCH_TOPICS_CANDIDATES_SQL = `
WITH readable AS MATERIALIZED (
  SELECT i.id, i.public_id, coalesce(i.title_zh, i.title_raw) AS title, i.canonical_url AS url,
    i.published_at, i.date_precision, i.timeline_at, i.registry_ids, i.identity_key, i.genre, i.evidence_type,
    s.name AS source_name, s.owner_entity, ${frontierChannelSql} AS channel,
    CASE WHEN e.id IS NOT NULL THEN 'event:' || coalesce(e.merged_into, e.id)::text
      ELSE 'identity:' || coalesce(nullif(i.identity_key, ''), i.public_id) END AS event_key
  FROM evimed_frontier.items i
  JOIN evimed_frontier.sources s ON s.id = i.primary_source_id AND s.enabled AND s.retired_at IS NULL
  LEFT JOIN evimed_frontier.events e ON e.id = i.event_id
  WHERE i.state = 'published' AND i.timeline_at >= $1::timestamptz AND i.timeline_at <= $2::timestamptz
    AND s.platform_produced IS NOT TRUE
), tagged AS MATERIALIZED (
  SELECT DISTINCT c.category, t.id AS tag_id, t.name, t.kind, i.*
  FROM readable i
  JOIN evimed_frontier.item_tags it ON it.item_id = i.id
  JOIN evimed_frontier.tags original ON original.id = it.tag_id
  JOIN evimed_frontier.tags t ON t.id = coalesce(original.merged_into, original.id) AND t.state = 'active'
  CROSS JOIN LATERAL (VALUES
    ('literature', i.channel IN ('journal', 'preprint') AND t.kind IN ('disease', 'drug')),
    ('guidelines', (i.channel = 'guideline' OR i.genre = 'guideline' OR i.evidence_type = 'guideline') AND t.kind = 'disease'),
    ('drugs', t.kind = 'drug')
  ) c(category, eligible)
  WHERE c.eligible
), occurrences AS MATERIALIZED (
  SELECT DISTINCT ON (category, tag_id, event_key) category, tag_id, name, event_key, public_id, title, url,
    source_name, published_at, date_precision, timeline_at
  FROM tagged ORDER BY category, tag_id, event_key, timeline_at DESC, public_id
), activity AS (
  SELECT category, tag_id, min(name) AS name, count(*)::integer AS event_count,
    sum(power(2.0, -extract(epoch FROM ($2::timestamptz - timeline_at)) / 604800.0))::float8 AS activity,
    max(timeline_at) AS latest_at, (array_agg(event_key ORDER BY timeline_at DESC, event_key))[1:50] AS event_keys
  FROM occurrences GROUP BY category, tag_id
), institutions AS (
  SELECT category, tag_id, count(DISTINCT owner_entity)::integer AS source_count FROM tagged GROUP BY category, tag_id
), ranked AS (
  SELECT a.*, s.source_count, row_number() OVER (PARTITION BY a.category
    ORDER BY a.activity DESC, s.source_count DESC, a.latest_at DESC, a.tag_id) AS position
  FROM activity a JOIN institutions s USING (category, tag_id)
), topic_references AS (
  SELECT o.*, row_number() OVER (PARTITION BY category, tag_id ORDER BY timeline_at DESC, public_id) AS position
  FROM occurrences o
)
SELECT r.*, (SELECT jsonb_agg(jsonb_build_object('id', x.public_id, 'title', x.title, 'url', x.url,
  'source', x.source_name, 'publishedAt', x.published_at, 'datePrecision', x.date_precision, 'timelineAt', x.timeline_at)
  ORDER BY x.position) FROM topic_references x WHERE x.category = r.category AND x.tag_id = r.tag_id AND x.position <= 3) AS sources
FROM ranked r WHERE r.position <= $3 ORDER BY r.category, r.position`;

/** Avoid filling the first three cards with different tags of the same evidence. Counts retain the full corpus. */
export function selectSearchTopics(/** @type {any[]} */ rows, /** @type {Date} */ now) {
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, []]));
  for (const category of CATEGORIES) {
    const candidates = rows.filter(row => row.category === category).sort((a, b) => Number(b.activity) - Number(a.activity)
      || Number(b.source_count) - Number(a.source_count) || Date.parse(b.latest_at) - Date.parse(a.latest_at)
      || String(a.tag_id).localeCompare(String(b.tag_id), 'en', { numeric: true }));
    const selected = [];
    for (const row of candidates) {
      if (selected.some(other => other.topic.query.normalize('NFKC').toLowerCase() === String(row.name).normalize('NFKC').toLowerCase())) continue;
      const keys = new Set(Array.isArray(row.event_keys) ? row.event_keys.map(String) : []);
      if (selected.some(other => {
        const intersection = [...keys].filter(key => other.keys.has(key)).length;
        return intersection > 0 && intersection / (keys.size + other.keys.size - intersection) >= 0.7;
      })) continue;
      const sources = (Array.isArray(row.sources) ? row.sources : []).flatMap(raw => {
        const timelineAt = iso(raw.timelineAt);
        if (!timelineAt || Date.parse(timelineAt) > now.getTime() || Date.parse(timelineAt) < now.getTime() - 30 * DAY) return [];
        const known = raw.datePrecision !== 'inferred' && iso(raw.publishedAt) && Date.parse(raw.publishedAt) <= Date.parse(timelineAt);
        const source = { id: clip(raw.id, 64), title: clip(raw.title, 200), url: String(raw.url ?? ''), source: clip(raw.source, 120),
          publishedAt: known ? iso(raw.publishedAt) : null, timelineAt, dateBasis: raw.datePrecision === 'updated' ? 'updated' : known ? 'published' : 'observed' };
        // The shared contract validates the actual public address rather than silently accepting a private source URL.
        try {
          validateFeed({ schemaVersion: 1, updatedAt: now.toISOString(), source: { kind: 'provider', label: '近期医学动态', isExample: false },
            recommendation: { algorithm: SEARCH_TOPICS_ALGORITHM, windowDays: 30, generatedAt: now.toISOString(), dataThrough: now.toISOString(), stale: false, corpusVersion: 'check' },
            categories: Object.fromEntries(CATEGORIES.map(key => [key, key === category ? [{ id: 'check', query: 'Check', description: 'Check',
              basis: { eventCount: 1, sourceCount: 1, latestAt: now.toISOString(), sources: [source] } }] : []])) });
          return [source];
        } catch { return []; }
      });
      if (!sources.length) continue;
      const latestAt = iso(row.latest_at);
      if (!latestAt) continue;
      const topic = { id: `frontier-${category}-${row.tag_id}`, query: clip(row.name, 160),
        description: `近30天 · ${Number(row.event_count)}${category === 'trials' ? '项试验更新' : '项动态'} · ${Number(row.source_count)}家来源`,
        basis: { eventCount: Number(row.event_count), sourceCount: Number(row.source_count), latestAt, sources } };
      selected.push({ keys, topic });
      if (selected.length === MAX_TOPICS) break;
    }
    categories[category] = selected.map(row => row.topic);
  }
  return categories;
}

/** Registered conditions stay exactly attributable to NCT records; known disease aliases use the existing controlled name. */
export function trialRecommendationCandidates(/** @type {any} */ result, /** @type {Date} */ now, /** @type {any} */ vocabulary = null) {
  const records = new Map();
  for (const row of Array.isArray(result?.records) ? result.records : []) {
    const at = iso(`${row.updatedDate}T00:00:00.000Z`);
    if (!/^NCT\d{8}$/u.test(String(row.id)) || !at || Date.parse(at) > now.getTime() || Date.parse(at) < now.getTime() - 30 * DAY) continue;
    const prior = records.get(row.id);
    if (!prior || row.updatedDate > prior.updatedDate) records.set(row.id, row);
  }
  const groups = new Map();
  for (const record of records.values()) {
    const seen = new Set();
    for (const condition of Array.isArray(record.conditions) ? record.conditions : []) {
      if (typeof condition !== 'string' || condition.trim().length > 160) continue;
      const tag = vocabulary?.byName(condition);
      const controlled = tag?.state === 'active' && tag.kind === 'disease' ? tag : null;
      const name = controlled ? controlled.name : clip(condition, 160);
      if (!name) continue;
      const key = controlled ? `tag:${controlled.id}` : `condition:${name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, { key, name, records: [] });
      groups.get(key).records.push(record);
    }
  }
  return [...groups.values()].map(group => {
    const sorted = group.records.sort((a, b) => b.updatedDate.localeCompare(a.updatedDate) || a.id.localeCompare(b.id));
    const at = record => `${record.updatedDate}T00:00:00.000Z`;
    return { category: 'trials', tag_id: `ctg-${createHash('sha256').update(group.key).digest('hex').slice(0, 20)}`, name: group.name,
      event_count: sorted.length, source_count: 1, latest_at: at(sorted[0]),
      activity: sorted.reduce((total, row) => total + 2 ** (-(now.getTime() - Date.parse(at(row))) / (7 * DAY)), 0),
      event_keys: sorted.map(row => `trial:${row.id}`),
      sources: sorted.slice(0, 3).map(row => ({ id: row.id.toLowerCase(), title: row.title,
        url: row.url, source: 'ClinicalTrials.gov', publishedAt: null, timelineAt: at(row), datePrecision: 'updated' })) };
  });
}

/** Only real provider snapshots qualify for recovery; the previous example file is never served as recommendations. */
function realFeed(value) {
  const feed = validateFeed(value);
  if (feed.source.kind !== 'provider' || feed.source.isExample || feed.recommendation?.algorithm !== SEARCH_TOPICS_ALGORITHM
    || !feed.recommendation.corpusVersion.startsWith(`${REGISTRY_SOURCE}:`)) throw unavailable();
  return feed;
}

/** One shared publisher for every account and category; public source collection uses no model and holds no transaction. */
export class SearchTopicsRecommendations {
  /** @param {{database:any,config:any,now?:()=>Date,trialSource?:any,tags?:any}} input */
  constructor({ database, config, now = () => new Date(), trialSource = null, tags = null }) {
    this.database = database;
    this.root = path.resolve(config.dataDir);
    this.directory = path.join(this.root, '.openscience', 'search-topics');
    this.file = path.join(this.directory, 'topics.json');
    this.now = now;
    this.trialSource = trialSource ?? createSearchTopicsTrialSource({ now });
    this.tags = tags;
    /** @type {Promise<any> | null} */
    this.inFlight = null;
  }

  /** Project authorization belongs to the route, before this shared publication can run. */
  async ensureCurrent() {
    if (this.inFlight) return this.inFlight;
    const work = () => this.refresh();
    const attempt = Promise.resolve().then(() => typeof this.database.withoutTransactionClient === 'function'
      ? this.database.withoutTransactionClient(work) : work());
    this.inFlight = attempt;
    try { return await attempt; } finally { if (this.inFlight === attempt) this.inFlight = null; }
  }

  async storage() {
    const root = await realpath(this.root);
    let current = this.root;
    for (const component of ['.openscience', 'search-topics']) {
      current = path.join(current, component);
      try { await mkdir(current, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unavailable();
    }
    if (await realpath(this.directory) !== path.join(root, '.openscience', 'search-topics')) throw unavailable();
    try {
      const stat = await lstat(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FEED_BYTES) throw unavailable();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return lstat(this.directory);
  }

  async existing() {
    await this.storage();
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FEED_BYTES) throw unavailable();
      const bytes = Buffer.alloc(MAX_FEED_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_FEED_BYTES) throw unavailable();
      return realFeed(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    } finally { await handle.close(); }
  }

  async version(client) {
    const result = await client.query("SELECT key, value FROM evimed_frontier.meta WHERE key IN ('content_version', 'tags_version') ORDER BY key");
    if (result.rows.length !== 2) throw unavailable();
    const digest = createHash('sha256').update(JSON.stringify({ versions: result.rows, algorithm: SEARCH_TOPICS_ALGORITHM, registrySource: REGISTRY_SOURCE })).digest('hex');
    return `${REGISTRY_SOURCE}:${digest}`;
  }

  /** The lock covers the complete atomic publication; readers of mounted directories observe either whole generation. */
  async publish(feed) {
    const checked = realFeed(feed);
    let bytes = Buffer.from(`${JSON.stringify(checked)}\n`);
    // Long public URLs can exhaust the wire budget. Keep real counts and at least one reference for every retained topic.
    for (const category of CATEGORIES) {
      for (const topic of checked.categories[category]) {
        while (bytes.length > MAX_FEED_BYTES && topic.basis.sources.length > 1) {
          topic.basis.sources.pop(); bytes = Buffer.from(`${JSON.stringify(checked)}\n`);
        }
      }
    }
    while (bytes.length > MAX_FEED_BYTES) {
      const category = [...CATEGORIES].sort((a, b) => checked.categories[b].length - checked.categories[a].length)[0];
      if (!checked.categories[category].length) throw unavailable();
      checked.categories[category].pop(); bytes = Buffer.from(`${JSON.stringify(checked)}\n`);
    }
    const before = await this.storage();
    const temporary = path.join(this.directory, `.topics-${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(bytes); await handle.sync(); await handle.close();
      const after = await this.storage();
      if (before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
      await rename(temporary, this.file);
    } finally {
      await handle.close().catch(() => {}); await unlink(temporary).catch(() => {});
    }
    return checked;
  }

  async refresh() {
    const now = this.now();
    try {
      const version = await this.version(this.database);
      const current = await this.existing().catch(() => null);
      if (current && this.fresh(current, now, version)) return this.state(current, false);
      // Network work finishes before any transaction/lock is held; one in-process refresh serves every category.
      const [trialRecords, vocabulary] = await Promise.all([this.trialSource.read(), this.tags?.vocabulary() ?? null]);
      const trialCandidates = trialRecommendationCandidates(trialRecords, now, vocabulary);
      const result = await this.database.transaction(async client => {
        await client.query("SET LOCAL statement_timeout = '10000ms'");
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('evimed-search-topics-v1')) AS acquired");
        if (lock.rows[0]?.acquired !== true) throw unavailable();
        const corpusVersion = await this.version(client);
        const onDisk = await this.existing().catch(() => null);
        if (onDisk && this.fresh(onDisk, now, corpusVersion)) return onDisk;
        const rows = (await client.query(SEARCH_TOPICS_CANDIDATES_SQL, [new Date(now.getTime() - 30 * DAY).toISOString(), now.toISOString(), CANDIDATES_PER_CATEGORY])).rows;
        const categories = selectSearchTopics([...rows, ...trialCandidates], now);
        const dates = Object.values(categories).flat().map(topic => topic.basis.latestAt).sort();
        return this.publish({ schemaVersion: 1, updatedAt: now.toISOString(),
          source: { kind: 'provider', label: '近期医学动态', isExample: false }, categories,
          recommendation: { algorithm: SEARCH_TOPICS_ALGORITHM, windowDays: 30, generatedAt: now.toISOString(),
            dataThrough: dates.at(-1) ?? null, stale: false, corpusVersion } });
      });
      return this.state(result, false);
    } catch {
      const previous = await this.existing().catch(() => null);
      const age = previous ? now.getTime() - Date.parse(previous.recommendation.generatedAt) : Infinity;
      if (!previous || age < 0 || age > SEARCH_TOPICS_STALE_MS) throw unavailable();
      return this.state(previous, true);
    }
  }

  fresh(feed, now, version) {
    const age = now.getTime() - Date.parse(feed.recommendation.generatedAt);
    return age >= 0 && age < SEARCH_TOPICS_REFRESH_MS && feed.recommendation.corpusVersion === version;
  }

  state(feed, stale) {
    return { generatedAt: feed.recommendation.generatedAt, corpusVersion: feed.recommendation.corpusVersion, stale };
  }
}
