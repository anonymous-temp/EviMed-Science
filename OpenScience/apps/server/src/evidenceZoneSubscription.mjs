import { evidenceCardIdentifiers, verifyEvidenceCardClaims } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { productId } from "./productPersistence.mjs";
import { recordSubscriptionEvent } from "./capsuleShareMetrics.mjs";

/**
 * Subscribing a project to an evidence zone, and reading the state of the cards and frontier items that memories name
 * (evidence-flywheel plan §5.5, §6.2 F18 and F19, 2026-10-05).
 *
 * Hidden knowledge:
 *
 * - **A subscription is a pointer, never a copy.** One product document per (project, zone) says that the project follows the
 *   zone; no card is stored. Every recall reads the zone's published cards as they are now, so a card the zone retracts, replaces
 *   or unpublishes leaves the project's recall at once, and an unsubscribe removes the whole thing with nothing left behind.
 * - **The reader's access is the zone service's, read here rather than called.** A zone is readable once it is published and a card
 *   once it and its zone are, by any signed-in account (`EvidenceZoneService.zoneRow` and `cardRow`); `visibility` only widens a
 *   published zone to the open web and changes nothing for a signed-in reader. An unpublished zone is read by nobody here, its
 *   owner included: a subscription is to what others can read, and one whose zone goes back to draft or is deleted yields nothing
 *   and says so (`status`).
 * - **A card in recall is an index, never a source (plan §4.3 rule 2).** What a recall hands the model is the card's question, its
 *   answer, each claim with the ✓/⚠ the reader sees, and the primary sources the card cites, with the instruction to cite those
 *   and not the card. Verification is the domain's own (`verifyEvidenceCardClaims`), computed from the preserved text of the card's
 *   sources and kept per (card, revision), so a recall pays for it once.
 * - **Bounded, and only in the project that subscribed.** At most `maxItems` cards of a recall, from at most `maxPerProject` zones,
 *   ranked by how many of the question's terms the card holds. Nothing is read for another project, and nothing at all with the
 *   switch off.
 * - **A card's currency is read defensively.** The `currency` and `withdrawn` columns belong to the upkeep of the zone and may not
 *   exist on this database: a missing column reads as `current` and not withdrawn.
 *
 * @module evidenceZoneSubscription
 */

export const ZONE_SUBSCRIPTION_RECORD_TYPE = "zone-subscription";
const SUBSCRIPTION_ID = (/** @type {string} */ projectId, /** @type {string} */ zoneId) => `zone-subscription:${projectId}:${zoneId}`;
const ZONE_ID = /^ez_[A-Za-z0-9]{8,64}$/;
/** How many candidate cards of a zone a recall ranks. */
const CANDIDATES_PER_RECALL = 400;
const DOCUMENT_BYTES_LIMIT = 8 * 1024 * 1024;

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
}

/**
 * The terms a question is matched on: Latin words of three letters or more, and every adjacent pair of Chinese characters. A
 * tokenisation for ranking, not a reading of the question.
 * @param {string} query @returns {string[]}
 */
export function queryTerms(query) {
  const text = String(query ?? "").toLowerCase();
  const terms = new Set();
  for (const match of text.matchAll(/[a-z0-9]{3,}/g)) terms.add(match[0]);
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
  return [...terms].slice(0, 80);
}

/**
 * How many of the terms a text holds, and the least that counts as a match: two terms, or the one a very short question has.
 * @param {readonly string[]} terms @param {string} haystack
 */
export function termScore(terms, haystack) {
  const text = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  return score;
}
const matchedAtLeast = (/** @type {readonly string[]} */ terms) => (terms.length <= 1 ? 1 : 2);

/** @type {WeakMap<object, Promise<Set<string>>>} */
const columnCache = new WeakMap();
/** The columns of `evidence_cards` this build may read when they exist. @param {any} database @returns {Promise<Set<string>>} */
async function evidenceCardColumns(database) {
  const cached = columnCache.get(database);
  if (cached) { const known = await cached; if (known.has("currency") || known.has("__absent__")) return known; }
  const read = (async () => {
    const rows = (await database.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='evimed_frontier' AND table_name='evidence_cards' AND column_name IN ('currency','withdrawn','retired_at')`)).rows;
    const names = new Set(rows.map((/** @type {any} */ row) => String(row.column_name)));
    if (!names.size) names.add("__absent__");
    return names;
  })();
  columnCache.set(database, read);
  return read;
}
/** The test hook: a column added after the first read. */
export function forgetEvidenceCardColumns(/** @type {any} */ database) { columnCache.delete(database); }

/**
 * What a card says about itself that a memory resting on it should hear: withdrawn, superseded, or resting on a source that was
 * retracted or corrected. `null` is nothing to say. @param {{ state?: string, currency?: string, withdrawn?: boolean } | undefined} found
 * @returns {{ state: "retracted" | "changed", reason: string } | null}
 */
export function cardFinding(found) {
  if (!found) return null;
  if (found.withdrawn) return { state: "retracted", reason: "card_withdrawn" };
  if (found.currency === "superseded") return { state: "changed", reason: "card_superseded" };
  if (found.currency === "source_changed") return { state: "changed", reason: "card_source_changed" };
  return null;
}

/**
 * What a frontier item says about itself: withdrawn or retracted, corrected or under an expression of concern.
 * @param {{ state?: string, flags?: string[] } | undefined} found @returns {{ state: "retracted" | "changed", reason: string } | null}
 */
export function itemFinding(found) {
  if (!found) return null;
  if (found.state === "withdrawn" || (found.flags ?? []).includes("retracted")) return { state: "retracted", reason: "item_retracted" };
  if ((found.flags ?? []).some((flag) => flag === "corrected" || flag === "expression-of-concern")) return { state: "changed", reason: "item_corrected" };
  return null;
}

/**
 * The state of evidence cards and frontier items by id, read from the evidence tables, for the labelling of memories that name them
 * (`KnowledgeChangeService.sweepEvidenceLinks`). An id with no row is absent from the map: a deleted card says nothing.
 * @param {any} database
 */
export function createEvidenceLinkStates(database) {
  return {
    /** @param {readonly string[]} ids @returns {Promise<Map<string, { state: string, currency: string, withdrawn: boolean }>>} */
    async cardStates(ids) {
      if (!ids.length) return new Map();
      const columns = await evidenceCardColumns(database);
      const currency = columns.has("currency") ? "currency" : "'current'";
      const withdrawn = columns.has("withdrawn") ? "(withdrawn IS NOT NULL)" : "false";
      const rows = (await database.query(`SELECT id,state,${currency} AS currency,${withdrawn} AS withdrawn FROM evimed_frontier.evidence_cards WHERE id=ANY($1::text[])`, [[...ids]])).rows;
      return new Map(rows.map((/** @type {any} */ row) => [String(row.id), { state: String(row.state), currency: String(row.currency), withdrawn: Boolean(row.withdrawn) }]));
    },
    /** @param {readonly string[]} ids @returns {Promise<Map<string, { state: string, flags: string[] }>>} */
    async itemStates(ids) {
      if (!ids.length) return new Map();
      const rows = (await database.query("SELECT public_id,state,flags FROM evimed_frontier.items WHERE public_id=ANY($1::text[])", [[...ids]])).rows;
      return new Map(rows.map((/** @type {any} */ row) => [String(row.public_id), { state: String(row.state), flags: Array.isArray(row.flags) ? row.flags : [] }]));
    },
  };
}

export class EvidenceZoneSubscriptions {
  /**
   * @param {{ database: any, documents: import('./productStore.mjs').ProductDocuments, enabled?: boolean, maxPerProject?: number, maxItems?: number }} options
   */
  constructor({ database, documents, enabled = false, maxPerProject = 5, maxItems = 6 }) {
    this.database = database; this.documents = documents;
    this.enabled = enabled; this.maxPerProject = maxPerProject; this.maxItems = maxItems;
    /** Verification per (card, revision): the claims with their marks and the sources a recall names. @type {Map<string, any>} */
    this.cache = new Map();
  }

  #assertEnabled() {
    if (!this.enabled) throw new HttpError(404, "evidence_zone_subscription_not_enabled", "Evidence-zone subscription is not enabled.");
  }

  /**
   * A zone as a signed-in reader may read it: published. Anything else is the same answer as no zone at all.
   * @param {string} zoneId @returns {Promise<{ id: string, title: string, kind: string, cards: number } | null>}
   */
  async #readableZone(zoneId) {
    if (!ZONE_ID.test(zoneId)) return null;
    const row = (await this.database.query(`SELECT z.id,z.title,z.kind,(SELECT count(*) FROM evimed_frontier.evidence_cards c WHERE c.zone_id=z.id AND c.state='published')::integer AS cards
      FROM evimed_frontier.evidence_zones z WHERE z.id=$1 AND z.state='published'`, [zoneId])).rows[0];
    return row ? { id: String(row.id), title: String(row.title), kind: String(row.kind), cards: Number(row.cards) } : null;
  }

  /**
   * Subscribe one of the account's projects to a published zone. The caller has checked that the project is the account's. Asking
   * twice is the first subscription.
   * @param {string} userId @param {string} projectId @param {string} zoneId
   */
  async subscribe(userId, projectId, zoneId) {
    this.#assertEnabled();
    productId(projectId, "project");
    const zone = await this.#readableZone(String(zoneId));
    if (!zone) throw new HttpError(404, "evidence_zone_subscription_not_found", "The evidence zone is unavailable.");
    const id = SUBSCRIPTION_ID(projectId, zone.id);
    let existing = await this.documents.get(userId, "preferences", id, { includeDeleted: true });
    if (existing && !existing.deletedAt) return this.#view(existing, zone);
    const held = await this.documents.list(userId, "preferences", { limit: 100, projectId, filter: { recordType: ZONE_SUBSCRIPTION_RECORD_TYPE } });
    if (held.items.filter((item) => item.id !== id).length >= this.maxPerProject) {
      throw new HttpError(409, "evidence_zone_subscription_limit", "This project follows too many evidence zones.");
    }
    const payload = { recordType: ZONE_SUBSCRIPTION_RECORD_TYPE, zoneId: zone.id, subscribedAt: new Date().toISOString() };
    // A subscription that was removed is a soft-deleted document: it comes back, then says when it was made again.
    if (existing) existing = await this.documents.restore(userId, "preferences", id, existing.revision);
    const saved = existing
      ? await this.documents.put(userId, "preferences", id, payload, { expectedRevision: existing.revision, projectId })
      : await this.documents.put(userId, "preferences", id, payload, { expectedRevision: 0, projectId });
    recordSubscriptionEvent("subscribed");
    return this.#view(saved, zone);
  }

  /** Take the subscription away at once. @param {string} userId @param {string} projectId @param {string} zoneId */
  async unsubscribe(userId, projectId, zoneId) {
    this.#assertEnabled();
    const id = SUBSCRIPTION_ID(productId(projectId, "project"), String(zoneId));
    const existing = await this.documents.get(userId, "preferences", id);
    if (!existing) return { unsubscribed: false };
    await this.documents.remove(userId, "preferences", id, existing.revision);
    recordSubscriptionEvent("unsubscribed");
    return { unsubscribed: true };
  }

  /**
   * The project's subscriptions, each with whether the zone can be read now: a zone that was unpublished or deleted is listed as
   * what it is, with nothing recalled from it.
   * @param {string} userId @param {string} projectId
   */
  async list(userId, projectId) {
    this.#assertEnabled();
    const held = await this.documents.list(userId, "preferences", { limit: 100, projectId: productId(projectId, "project"), filter: { recordType: ZONE_SUBSCRIPTION_RECORD_TYPE } });
    const zones = await this.#zonesById(held.items.map((item) => String(item.payload.zoneId)));
    return held.items.map((item) => this.#view(item, zones.get(String(item.payload.zoneId)) ?? null));
  }

  /** Whether one zone is subscribed in a project, for the zone page's control. @param {string} userId @param {string} projectId @param {string} zoneId */
  async status(userId, projectId, zoneId) {
    this.#assertEnabled();
    const found = await this.documents.get(userId, "preferences", SUBSCRIPTION_ID(productId(projectId, "project"), String(zoneId)));
    if (!found) return { subscribed: false, subscription: null };
    const zone = (await this.#zonesById([String(zoneId)])).get(String(zoneId)) ?? null;
    return { subscribed: true, subscription: this.#view(found, zone) };
  }

  /** @param {readonly string[]} ids @returns {Promise<Map<string, { id: string, title: string, kind: string, cards: number, state: string }>>} */
  async #zonesById(ids) {
    const valid = ids.filter((id) => ZONE_ID.test(id));
    if (!valid.length) return new Map();
    const rows = (await this.database.query(`SELECT z.id,z.title,z.kind,z.state,(SELECT count(*) FROM evimed_frontier.evidence_cards c WHERE c.zone_id=z.id AND c.state='published')::integer AS cards
      FROM evimed_frontier.evidence_zones z WHERE z.id=ANY($1::text[])`, [valid])).rows;
    return new Map(rows.map((/** @type {any} */ row) => [String(row.id), { id: String(row.id), title: String(row.title), kind: String(row.kind), cards: Number(row.cards), state: String(row.state) }]));
  }

  /** @param {any} record @param {any} zone */
  #view(record, zone) {
    const readable = Boolean(zone) && (zone.state === undefined || zone.state === "published");
    const reason = readable ? null : zone ? "unpublished" : "deleted";
    return {
      zoneId: String(record.payload.zoneId), projectId: record.projectId, subscribedAt: record.payload.subscribedAt ?? record.createdAt,
      title: zone?.title ?? null, kind: zone?.kind ?? null, cards: readable ? zone.cards : 0,
      status: readable ? "active" : "unavailable", reason,
      message: readable ? null : reason === "deleted" ? "这个证据专区已经删除，订阅里不再有内容。" : "这个证据专区已取消发布，订阅里暂时没有内容。",
    };
  }

  /**
   * The published cards of the project's subscribed zones that answer a question, as index-only context for a recall in that project
   * (`capsuleGateway.mjs`). Nothing when the switch is off, the project follows no zone, or no card matches; a failure to read costs
   * the recall this part and nothing else.
   * @param {string} userId @param {string} projectId @param {string} query @param {{ limit?: number }} [options]
   * @returns {Promise<Record<string, any>[]>}
   */
  async recall(userId, projectId, query, { limit = this.maxItems } = {}) {
    if (!this.enabled) return [];
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const held = await this.documents.list(userId, "preferences", { limit: 100, projectId: productId(projectId, "project"), filter: { recordType: ZONE_SUBSCRIPTION_RECORD_TYPE } });
    const zoneIds = held.items.map((item) => String(item.payload.zoneId)).filter((id) => ZONE_ID.test(id));
    if (!zoneIds.length) return [];
    const columns = await evidenceCardColumns(this.database);
    const live = [columns.has("withdrawn") ? "c.withdrawn IS NULL" : "true", columns.has("currency") ? "c.currency<>'superseded'" : "true"].join(" AND ");
    const rows = (await this.database.query(`SELECT c.id,c.zone_id,c.revision,z.title AS zone_title,c.title,c.summary,
        c.content->>'question' AS question,c.content->>'answer' AS answer,
        COALESCE((SELECT string_agg(cl->>'claim',' ') FROM jsonb_array_elements(c.claims) cl),'') AS claims_text,
        ${columns.has("currency") ? "c.currency" : "'current'"} AS currency
      FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
      WHERE c.zone_id=ANY($1::text[]) AND z.state='published' AND c.state='published' AND ${live}
      ORDER BY c.updated_at DESC,c.id LIMIT ${CANDIDATES_PER_RECALL}`, [zoneIds])).rows;
    const need = matchedAtLeast(terms);
    const ranked = rows
      .map((/** @type {any} */ row) => ({ row, score: termScore(terms, [row.title, row.summary, row.question, row.answer, row.claims_text].join(" ")) }))
      .filter((entry) => entry.score >= need)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(limit, this.maxItems)));
    const items = [];
    for (const { row } of ranked) items.push(await this.#indexItem(row));
    if (items.length) recordSubscriptionEvent("recalled");
    return items;
  }

  /** @param {any} row */
  async #indexItem(row) {
    const key = `${row.id}:${row.revision}`;
    let parts = this.cache.get(key);
    if (!parts) {
      const full = (await this.database.query(`SELECT c.claims,c.producer,c.lineage,
          CASE WHEN pg_column_size(c.sources)<=${DOCUMENT_BYTES_LIMIT} THEN c.sources ELSE '[]'::jsonb END AS sources
        FROM evimed_frontier.evidence_cards c WHERE c.id=$1`, [row.id])).rows[0];
      const claims = Array.isArray(full?.claims) ? full.claims : [];
      const sources = Array.isArray(full?.sources) ? full.sources : [];
      const verdicts = new Map(verifyEvidenceCardClaims({ claims, sources }).claims.map((claim) => [claim.claimId, claim.mark]));
      parts = {
        claims: claims.slice(0, 6).map((/** @type {any} */ claim) => ({ text: clip(claim.claim, 300), mark: verdicts.get(claim.claimId) ?? null })),
        sources: sources.slice(0, 6).map((/** @type {any} */ source) => ({ title: clip(source.title, 200), ...(source.url ? { url: String(source.url) } : {}) })),
        identifiers: evidenceCardIdentifiers({ sources, lineage: full?.lineage ?? null }).slice(0, 8),
        producer: full?.producer?.name ? clip(full.producer.name, 80) : null,
      };
      if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, parts);
    }
    const label = `来自证据专区《${clip(row.zone_title, 60)}》`;
    const note = row.currency && row.currency !== "current" ? row.currency : null;
    const content = [
      `${label}（索引，不是来源）：${clip(row.title, 150)}`,
      row.question ? `问题：${clip(row.question, 300)}` : "",
      row.answer ? `结论：${clip(row.answer, 500)}` : "",
      parts.claims.length ? `要点：${parts.claims.map((/** @type {any} */ claim) => `${claim.mark ?? "·"} ${claim.text}`).join("；")}` : "",
      parts.sources.length ? `原始来源：${parts.sources.map((/** @type {any} */ source) => source.title + (source.url ? `（${source.url}）` : "")).join("；")}` : "",
      note ? `时效：${note}（以原始来源为准）` : "",
      "引用时请直接引用上面的原始来源，不要把这张卡片当作来源；标 ⚠ 的要点先到原文核对。",
    ].filter(Boolean).join("\n");
    return {
      id: String(row.id), source: "evidence_zone", kind: "evidence_card_index", scope: "project", contextOnly: true,
      label, zoneId: String(row.zone_id), zoneTitle: String(row.zone_title), cardTitle: String(row.title),
      claims: parts.claims, primarySources: parts.sources, identifiers: parts.identifiers, producer: parts.producer,
      ...(note ? { currency: note } : {}),
      citeInstruction: "这是索引：引用时请引用 primarySources 里的原始来源，不要引用这张证据卡；标 ⚠ 的要点先到原文核对。",
      content,
    };
  }
}
