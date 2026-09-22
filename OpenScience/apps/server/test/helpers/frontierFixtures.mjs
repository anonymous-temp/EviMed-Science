// Shared fixtures for the frontier tests: the vocabulary as the build spec
// states it, contract-shaped plugin rows, and an in-memory plugin that speaks
// the contract over a stubbed fetch — so every test goes through the real
// client, its validation and its error mapping.
import { createHash, randomBytes } from "node:crypto";
import { frontierDomainVocabulary } from "../../src/frontierService.mjs";

/** The vocabulary a deployment runs with: `@evimed/domain`'s, as the module reads it. */
export const TEST_VOCABULARY = frontierDomainVocabulary();

/** @param {string} value */
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A contract `Source`. @param {string} id @param {Record<string, any>} [overrides] */
export function pluginSource(id, overrides = {}) {
  return {
    id, name: `${id.toUpperCase()} Journal`, homepage: `https://${id}.example.org/`, lane: "evidence", source_type: "journal",
    access: "crossref-issn", egress: "api", authority: 4, safety_feed: false, owner_entity: `${id}-publisher`, launch_tier: "P0",
    language: "en", region: "US", enabled: true, retired_at: null, health: "healthy", last_ok_at: "2026-09-22T00:00:00Z",
    last_new_entry_at: "2026-09-22T00:00:00Z", entries_7d: 12, registry_sha256: sha256(id), ...overrides,
  };
}

/** A contract `Entry`. @param {string} sourceId @param {number} seq @param {Record<string, any>} [overrides] */
export function pluginEntry(sourceId, seq, overrides = {}) {
  const key = `${sourceId}-${seq}`;
  return {
    entry_id: `${sourceId}:${sha256(key).slice(0, 32)}`, seq, revision: 1, source_id: sourceId, external_key: key,
    identity_key: `doi:10.1000/${key}`, url: `https://${sourceId}.example.org/articles/${seq}`,
    canonical_url: `https://${sourceId}.example.org/articles/${seq}`, doi: `10.1000/${key}`, pmid: null, registry_ids: [],
    title: `Trial ${seq} of ${sourceId}`, summary: `Summary of trial ${seq}: 42% fewer events.`, language: "en", lane_hint: "evidence",
    published_at: "2026-09-21T08:00:00Z", date_precision: "day", first_seen_at: "2026-09-22T01:00:00Z",
    content_sha256: sha256(`content-${key}`), backfill: false, defects: [], text_status: "none",
    facts: { journal: `${sourceId} journal` }, ...overrides,
  };
}

/**
 * A plugin in memory, served through `fetchImpl` exactly as the contract says:
 * `/v1/entries?after=` ascending by seq, `has_more`/`next_after`, `/v1/sources`
 * paged by `next_cursor`, a manifest and a health answer. Mutate its fields to
 * change what it serves; set `down` to make every request fail at the socket.
 */
export function memoryPlugin({ sources = [], entries = [], contract = "1.0.0", oldest = 0, sourcePage = 500 } = {}) {
  const plugin = {
    sources, entries, contract, oldest, sourcePage, down: false, status: 200,
    /** @type {{ path: string, query: Record<string, string>, authorization: string | undefined }[]} */
    requests: [],
    /** @type {Record<string, any> | null} what `/v1/entries/:id/text` answers */
    text: null,
    manifest() {
      return {
        plugin: { name: "evimed-knowledge-plugin", version: "0.1.0-test", build: "test" }, contract: { version: plugin.contract },
        capabilities: { stream: true, text: true, refresh: false, lookups: [] },
        vocabularies: { lane: Object.keys(TEST_VOCABULARY.lanes) }, sources: { total: plugin.sources.length, enabled: plugin.sources.length },
        fields: { entry: ["summary", "published_at"], facts: ["journal"], enrichment: ["publication_types"] },
        limits: { entries_page_max: 500, text_max_chars: 20000 }, oldest_seq_available: plugin.oldest,
      };
    },
    /** @param {string | URL} input @param {RequestInit} [init] */
    fetchImpl: async (input, init = {}) => {
      if (plugin.down) throw new TypeError("fetch failed");
      const url = new URL(String(input));
      const query = Object.fromEntries(url.searchParams);
      const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
      plugin.requests.push({ path: url.pathname, query, authorization: headers.authorization });
      const json = (/** @type {any} */ body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (plugin.status !== 200) return json({ code: "internal", message: "down for the test", retryable: true }, plugin.status);
      if (url.pathname === "/v1/manifest") return json(plugin.manifest());
      if (url.pathname === "/v1/health") {
        const latest = plugin.entries.reduce((max, row) => Math.max(max, row.seq), 0);
        return json({ status: "ok", contract: plugin.contract, sources: { healthy: plugin.sources.length }, egress: { direct: "ok" }, latest_seq: latest });
      }
      if (url.pathname === "/v1/sources") {
        const offset = Number(query.cursor ?? 0);
        const page = plugin.sources.slice(offset, offset + plugin.sourcePage);
        const next = offset + plugin.sourcePage < plugin.sources.length ? String(offset + plugin.sourcePage) : null;
        return json({ sources: page, next_cursor: next, fetched_at: new Date().toISOString() });
      }
      if (url.pathname === "/v1/entries") {
        const after = Number(query.after);
        const limit = Number(query.limit ?? 200);
        const visible = plugin.entries.filter((row) => row.seq > Math.max(after, plugin.oldest - 1) && (query.include_backfill === "true" || !row.backfill || row.deliverBackfill))
          .sort((left, right) => left.seq - right.seq);
        const page = visible.slice(0, limit).map(({ deliverBackfill: _hidden, ...row }) => row);
        const nextAfter = page.length ? page[page.length - 1].seq : after;
        return json({ entries: page, next_after: nextAfter, has_more: visible.length > limit, server_time: new Date().toISOString() });
      }
      if (/^\/v1\/entries\/[^/]+\/text$/.test(url.pathname)) {
        return plugin.text ? json(plugin.text) : json({ code: "not_found", message: "x", retryable: false }, 404);
      }
      return json({ code: "not_found", message: "x", retryable: false }, 404);
    },
  };
  return plugin;
}

let itemCounter = 0;

/**
 * A mirror row written straight into `evimed_frontier.sources`, for tests that
 * start after the ingest. @param {any} database @param {string} id @param {Record<string, any>} [overrides]
 */
export async function insertSource(database, id, overrides = {}) {
  const row = { name: `${id.toUpperCase()} Journal`, homepage: `https://${id}.example.org/`, lane: "evidence", source_type: "journal",
    access: "crossref-issn", egress: "api", authority: 4, safety_feed: false, owner_entity: `${id}-publisher`, launch_tier: "P0",
    enabled: true, plugin_health: "healthy", retired_at: null, ...overrides };
  await database.query(`INSERT INTO evimed_frontier.sources (id, name, homepage, lane, source_type, access, egress, authority, safety_feed,
      owner_entity, launch_tier, enabled, plugin_health, retired_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, enabled=EXCLUDED.enabled, plugin_health=EXCLUDED.plugin_health, retired_at=EXCLUDED.retired_at`,
  [id, row.name, row.homepage, row.lane, row.source_type, row.access, row.egress, row.authority, row.safety_feed, row.owner_entity,
    row.launch_tier, row.enabled, row.plugin_health, row.retired_at]);
}

/**
 * A published item the way the pipeline leaves one, with its text row and,
 * when asked, mentions from other sources. Returns the row id and public id.
 * @param {any} database @param {Record<string, any>} [overrides]
 */
export async function insertItem(database, overrides = {}) {
  const { tsvectorLiteral } = await import("../../src/kbChunker.mjs");
  itemCounter += 1;
  const item = {
    publicId: `t${randomBytes(8).toString("hex")}`, sourceId: "nejm", title: `Item ${itemCounter}`, titleZh: null, summaryZh: null,
    reasonZh: null, lane: "evidence", sourceType: "journal", evidenceType: "rct", evidenceBasis: "pubmed-types", specialties: [],
    entities: {}, flags: [], selected: false, selectedRule: null, safetyAlert: false, verification: "passed", state: "published",
    publishedAt: "2026-09-21T08:00:00Z", timelineAt: "2026-09-22T01:00:00Z", visibleAt: "2026-09-22T01:00:00Z",
    scores: { authority: 24, impact: 12, novelty: 5, relevance: null }, doi: null, pmid: null, openAccess: null, oaPdfUrl: null,
    abstract: null, mentions: [], ...overrides,
  };
  const lexemes = tsvectorLiteral([item.title, item.titleZh, item.summaryZh].filter(Boolean).join("\n"));
  const inserted = await database.query(`INSERT INTO evimed_frontier.items (public_id, primary_source_id, canonical_url, identity_key, doi, pmid,
      title_raw, title_zh, summary_zh, reason_zh, lang, lane, source_type, evidence_type, evidence_basis, specialties, entities, flags,
      score_authority, score_impact, score_novelty, score_relevance, selected, selected_rule, safety_alert, verification, published_at,
      first_seen_at, timeline_at, state, visible_at, lexemes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'en',$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::tsvector)
    RETURNING id`, [item.publicId, item.sourceId, `https://${item.sourceId}.example.org/${item.publicId}`, `url:${sha256(item.publicId)}`,
    item.doi, item.pmid, item.title, item.titleZh, item.summaryZh, item.reasonZh, item.lane, item.sourceType, item.evidenceType,
    item.evidenceBasis, item.specialties, JSON.stringify(item.entities), item.flags, item.scores.authority, item.scores.impact,
    item.scores.novelty, item.scores.relevance, item.selected, item.selectedRule, item.safetyAlert, item.verification, item.publishedAt,
    item.visibleAt ?? item.timelineAt, item.timelineAt, item.state, item.visibleAt, lexemes]);
  const id = String(inserted.rows[0].id);
  await database.query(`INSERT INTO evimed_frontier.item_texts (item_id, abstract_raw, model_input, model_input_sha256, publication_types,
      open_access, enrichment) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
  [id, item.abstract, item.title, sha256(item.title), ["Randomized Controlled Trial"], item.openAccess,
    JSON.stringify(item.oaPdfUrl ? { oa_pdf_url: item.oaPdfUrl, impact_factor: 50.1 } : {})]);
  for (const [index, mention] of item.mentions.entries()) {
    const entry = await database.query(`INSERT INTO evimed_frontier.entries (plugin_entry_id, plugin_seq, source_id, identity_key, url, canonical_url,
        title_raw, first_seen_at, content_sha256, state, item_id)
      VALUES ($1, $2, $3, $4, $5, $5, $6, clock_timestamp(), $7, 'merged', $8) RETURNING id`,
    [`${mention.sourceId}:${sha256(`${item.publicId}-${index}`).slice(0, 32)}`, 900_000 + itemCounter * 10 + index, mention.sourceId,
      `url:${sha256(item.publicId)}`, mention.url, item.title, sha256(`${item.publicId}-${index}`), id]);
    await database.query(`INSERT INTO evimed_frontier.item_mentions (item_id, entry_id, source_id, url, published_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, entry.rows[0].id, mention.sourceId, mention.url, mention.publishedAt ?? null]);
  }
  return { id, publicId: item.publicId };
}
