/**
 * The write side of the topic zones (「证据专区」, owner 2026-10-29; plan §4.8, §6.4): a reader's 我的专区 drafted from a sentence,
 * previewed, created, edited, published to the platform and deleted; a reader's word on one item of a zone; and the typed follows
 * (「用自己的话关注」) that became zones.
 *
 * Hidden knowledge:
 *
 * - **A zone is live when made.** There is no review, no approval and no gate anywhere here (owner 2026-10-29): creating a zone
 *   saves its definition and tells the membership module (`afterSave`), which collects the last ninety days and keeps collecting;
 *   publishing is one flip of `state` that puts the zone in the directory's 「大家建的」 for the platform's signed-in readers and never
 *   on the open internet (a user zone's `visibility` stays `platform`). The width of a zone, the number of its keywords and its
 *   words are never refused — the only refusals are the reader's own bounds: thirty zones, ownership, a stale revision, a body that
 *   is not a zone.
 * - **The model is the drafter's, the data plane the membership's.** This module holds only exact things: the shape of a body, the
 *   rows, ownership and revision, the count of a reader's zones, request identity, the change record. Everything that needs the
 *   membership module (resolving names to tag and entity ids, previews, collecting, a reader's `not-in`) is an optional dependency:
 *   a deployment without it saves the definition and the zone simply collects nothing yet, and says so as a status where it must
 *   (`feedback`), never as a fake success.
 * - **Identity is replay-safe.** A zone made with a `requestId` has the id every other writer of this module's family derives from
 *   the account and the request (`zoneIdFor`); the same body again is the same zone and a different body under the same request is a
 *   409 — the thirty-zone limit is checked after the replay, so retrying the thirtieth zone's request succeeds.
 * - **Typed follows are zones now.** `POST /follows kind:'query'` is a zone made from the words (`createFromWords`: draft, then
 *   create, unpublished); the same words again are the same zone. The follows that existed when this shipped were turned into
 *   unpublished zones once, in one transaction, under a marker in the feed's `meta` (`convertTypedFollows`), and deleted with their
 *   matches.
 * - **Every change is recorded** in `zone_changes` (who: `owner:<id>`), without a foreign key, so a deleted zone keeps its history.
 *
 * @module evidenceZoneWrites
 */

import { createHash, randomUUID } from "node:crypto";
import {
  EVIDENCE_ZONE_LIMITS,
  FRONTIER_SPECIALTY_LABELS_ZH,
  PLATFORM_PUBLISHER_NAME,
  evidenceZoneBand,
  normalizeEvidenceZoneDefinition,
} from "@evimed/domain";
import { publicZoneDefinition } from "./evidenceZoneDraft.mjs";
import { migrateFrontier } from "./frontierPersistence.mjs";
import { HttpError } from "./security.mjs";

const error = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) => new HttpError(status, `evidence_${code}`, message);
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const PUBLIC_ITEM_ID = /^[a-z0-9]{12,32}$/;
/** The `meta` key of the one-time conversion of typed follows into zones. */
export const TYPED_FOLLOWS_MARKER = "typed_follows_to_zones";
const FEEDBACK_KINDS = Object.freeze(["not-in", "more-like"]);

/**
 * The id a zone gets from its owner and a request identity: the derivation `EvidenceZoneService#save` has always used for `ez_…`
 * (a test holds the two equal), so a request made twice is one zone whichever writer made it.
 * @param {string} userId @param {string} requestId
 */
export const zoneIdFor = (userId, requestId) => `ez_${createHash("sha256").update(`${userId}:${requestId}`).digest("hex").slice(0, 32)}`;

/** @param {unknown} value */
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @param {number} max */
const clean = (value, max) => (typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "");
/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);

/**
 * A body that carries only the fields a route allows.
 * @param {unknown} body @param {readonly string[]} allowed @returns {Record<string, any>}
 */
function fieldsOf(body, allowed) {
  if (!isRecord(body) || Object.keys(/** @type {object} */ (body)).some((key) => !allowed.includes(key))) throw error(400, "invalid", "Unsupported zone fields.");
  return /** @type {Record<string, any>} */ (body);
}

/**
 * The reader-visible face of a definition, as JSON with sorted keys: what a change is compared by, so ids the platform resolved
 * (which move when the tag tree does) never make an unchanged definition look edited.
 * @param {any} definition
 */
function visibleKey(definition) {
  const visible = publicZoneDefinition(definition);
  return JSON.stringify(visible, (_key, value) => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value));
}

/**
 * Append what happened to a zone (`zone_changes`): who did it (`planner`, `owner:<id>`, `operator:<name>`, `migration`) and the detail.
 * @param {any} client @param {string} zoneId @param {string} kind @param {string} actor @param {Record<string, unknown>} [detail]
 */
export async function recordZoneChange(client, zoneId, kind, actor, detail = {}) {
  await client.query("INSERT INTO evimed_frontier.zone_changes(zone_id, kind, actor, detail) VALUES ($1, $2, $3, $4::jsonb)", [zoneId, kind, actor, JSON.stringify(detail)]);
}

/**
 * Insert a topic zone row: its definition at version 1, active, and the columns the directory and the data plane read. Returns false
 * when the id is taken (a replay). The caller holds the transaction, the lock it needs and the change record.
 * @param {any} client
 * @param {{ id: string, userId: string, kind: "user" | "official", state: "draft" | "published", visibility: "platform" | "internet", title: string,
 *   definition: import("@evimed/domain").EvidenceZoneDefinition, slug?: string | null }} input
 * @returns {Promise<boolean>}
 */
export async function insertTopicZone(client, { id, userId, kind, state, visibility, title, definition, slug = null }) {
  const inserted = await client.query(`INSERT INTO evimed_frontier.evidence_zones
      (id, user_id, kind, title, description, background, state, visibility, slug, zone_type, specialties, group_label, scope_zh, definition, definition_version, lifecycle)
    VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10::text[], $11, $12, $13::jsonb, 1, 'active')
    ON CONFLICT (id) DO NOTHING RETURNING id`,
  [id, userId, kind, title, definition.scope, state, visibility, slug, definition.type, definition.specialties, definition.group, definition.scope, JSON.stringify(definition)]);
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * A typed follow's stored query as a zone definition: one keyword per concept (its first Chinese name, else its first English one,
 * else the registry number it was typed as), every name of it as the keyword's terms, its entity keys; the typed words as the scope.
 * @param {string} label @param {any} query
 * @returns {import("@evimed/domain").EvidenceZoneDefinition | null}
 */
export function definitionFromTypedFollow(label, query) {
  const concepts = Array.isArray(query?.concepts) ? query.concepts : [];
  const identifier = /^(reg|doi|pmid):/;
  const keywords = concepts.slice(0, EVIDENCE_ZONE_LIMITS.keywordsMax).map((/** @type {any} */ concept) => {
    const names = [...(Array.isArray(concept?.terms_zh) ? concept.terms_zh : []), ...(Array.isArray(concept?.terms_en) ? concept.terms_en : [])]
      .filter((/** @type {unknown} */ name) => typeof name === "string" && name);
    const keys = (Array.isArray(concept?.keys) ? concept.keys : []).filter((/** @type {unknown} */ key) => typeof key === "string");
    const identifiers = keys.filter((/** @type {string} */ key) => identifier.test(key)).map((/** @type {string} */ key) => key.replace(/^[a-z]+:/, ""));
    return { label: names[0] ?? identifiers[0] ?? "", terms: [...names, ...identifiers], tagIds: [], entityKeys: keys.filter((/** @type {string} */ key) => !identifier.test(key)) };
  }).filter((/** @type {{ label: string }} */ keyword) => keyword.label);
  const words = clean(label, EVIDENCE_ZONE_LIMITS.termChars);
  const { definition } = normalizeEvidenceZoneDefinition({
    type: concepts.some((/** @type {any} */ concept) => concept?.type === "drug") ? "drug-indication" : "disease-strategy",
    keywords: keywords.length ? keywords : [{ label: words, terms: [words] }],
    perspective: null, scope: label, include: "", exclude: "", excludeTerms: [], specialties: [], group: "",
  });
  return definition;
}

/**
 * @param {{ database: any, zones: { ready: () => Promise<void>, bump: (client: any) => Promise<void> }, membership?: any, draft?: any,
 *   detail?: ((user: any, zoneId: string) => Promise<any>) | null, config?: Record<string, any>, now?: () => Date }} options
 *   `zones` the `EvidenceZoneService` (its migration and its content version); `membership` the zones' data plane (`resolveKeywords`,
 *   `afterSave`, `feedback`); `draft` the drafter (`draft`, `preview`); `detail` the read side's `ZoneDetail` for a reader, which
 *   answers every write — without it a plainer `ZoneDetail` is read from the row.
 */
export function createEvidenceZoneWrites({ database, zones, membership = null, draft = null, detail = null, config = {}, now = () => new Date() }) {
  const max = Number.isSafeInteger(config.evidenceUserZonesMax) ? config.evidenceUserZonesMax : EVIDENCE_ZONE_LIMITS.userZonesMax;
  const dimension = Number(config.kbEmbeddingDimension) || 1024;
  const counters = { created: 0, updated: 0, deleted: 0, published: 0, fromWords: 0, feedback: 0, limitRefused: 0, converted: 0, afterSaveFailures: 0 };
  /** @type {Promise<void> | null} */
  let readyPromise = null;

  /** The tables exist, and the typed follows of before were turned into zones — once. */
  function ready() {
    readyPromise ??= (async () => {
      await zones.ready();
      await migrateFrontier(database, { dimension });
      await convertTypedFollows();
    })().catch((failure) => { readyPromise = null; throw failure; });
    return readyPromise;
  }

  /** The data plane is told a zone is new or changed; it collects in its own time and a failure of it is not the writer's. @param {string} zoneId */
  function afterSave(zoneId) {
    if (!membership?.afterSave) return;
    Promise.resolve().then(() => membership.afterSave(zoneId)).catch(() => { counters.afterSaveFailures += 1; });
  }

  /** @param {import("@evimed/domain").EvidenceZoneDefinition} definition */
  async function resolveNames(definition) {
    if (!membership?.resolveKeywords) return definition;
    try { return (await membership.resolveKeywords(definition)) ?? definition; } catch { return definition; }
  }

  /**
   * A body's definition made into a stored one: the shape checked (a refusal names what is missing), the reader's seeds kept, the
   * names resolved to the tag tree's and the glossary's ids.
   * @param {unknown} input @param {{ positive?: unknown, negative?: unknown } | null} [seeds]
   */
  async function definitionOf(input, seeds = null) {
    const withSeeds = isRecord(input) && seeds ? { ...(/** @type {object} */ (input)), seeds } : input;
    const { definition, issues } = normalizeEvidenceZoneDefinition(withSeeds);
    if (!definition) throw error(400, "invalid", `The zone definition is incomplete: ${issues.join(", ")}.`);
    return resolveNames(definition);
  }

  /**
   * Seeds are items of the feed named by their public ids: only ones that exist and can be read stay.
   * @param {unknown} seeds
   */
  async function readableSeeds(seeds) {
    const raw = isRecord(seeds) ? /** @type {Record<string, unknown>} */ (seeds) : {};
    /** @param {unknown} list */
    const ids = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && PUBLIC_ITEM_ID.test(id)))].slice(0, EVIDENCE_ZONE_LIMITS.seeds);
    const positive = ids(raw.positive);
    const negative = ids(raw.negative);
    const wanted = [...new Set([...positive, ...negative])];
    if (!wanted.length) return { positive: [], negative: [] };
    const found = new Set(((await database.query(`SELECT i.public_id FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.public_id = ANY($1::text[]) AND i.state = 'published' AND s.enabled`, [wanted])).rows ?? []).map((/** @type {any} */ row) => row.public_id));
    return { positive: positive.filter((id) => found.has(id)), negative: negative.filter((id) => found.has(id)) };
  }

  /**
   * A zone the reader may read, as a row (locked for update when asked): a topic zone that is published or the reader's own. Anything
   * else is not found — a private zone does not exist for another reader.
   * @param {any} client @param {any} user @param {string} ref a zone id or its slug @param {boolean} [lock]
   */
  async function zoneRow(client, user, ref, lock = false) {
    if (typeof ref !== "string" || !ref || ref.length > 100) throw error(404, "not_found", "No such visible zone.");
    const row = (await client.query(`SELECT z.*, u.name AS creator FROM evimed_frontier.evidence_zones z JOIN evimed_control.users u ON u.id = z.user_id
      WHERE (z.id = $1 OR z.slug = $1) AND z.lifecycle <> 'none' AND (z.state = 'published' OR z.user_id = $2) ${lock ? "FOR UPDATE OF z" : ""}`, [ref, user.id])).rows[0];
    if (!row) throw error(404, "not_found", "No such visible zone.");
    return row;
  }

  /** @param {any} row @param {any} user */
  const ownsUserZone = (row, user) => row.kind === "user" && row.user_id === user.id;

  /**
   * The `ZoneDetail` of a zone for a reader: the read side's when it is composed, else read from the row (counts from the last stats
   * snapshot; no related zones).
   * @param {any} user @param {string} zoneId
   */
  async function detailOf(user, zoneId) {
    if (detail) {
      try {
        const found = await detail(user, zoneId);
        if (found) return found;
      } catch { /* the plainer reading below answers; a write is never reported failed because its echo was */ }
    }
    const row = (await database.query(`SELECT z.*, u.name AS creator,
        EXISTS (SELECT 1 FROM evimed_frontier.evidence_zone_follows f WHERE f.zone_id = z.id AND f.user_id = $2) AS followed
      FROM evimed_frontier.evidence_zones z JOIN evimed_control.users u ON u.id = z.user_id WHERE z.id = $1`, [zoneId, user.id])).rows[0];
    if (!row) throw error(404, "not_found", "No such visible zone.");
    const stats = isRecord(row.stats) ? row.stats : {};
    const owner = ownsUserZone(row, user);
    const definition = isRecord(row.definition) ? row.definition : null;
    return {
      id: row.id, slug: row.slug ?? null, title: row.title, type: row.zone_type ?? null,
      keywords: (Array.isArray(definition?.keywords) ? definition.keywords : []).map((/** @type {any} */ keyword) => String(keyword.label)),
      scope: row.scope_zh, specialties: (row.specialties ?? []).map((/** @type {string} */ key) => ({ key, label: FRONTIER_SPECIALTY_LABELS_ZH[key] ?? key })),
      group: row.group_label, kind: row.kind, published: row.state === "published", creator: row.kind === "official" ? PLATFORM_PUBLISHER_NAME : row.creator,
      following: owner || row.followed === true,
      counts: { week: Number(stats.week) || 0, month: Number(stats.month) || 0, all: Number(stats.all) || 0 },
      perWeek: typeof stats.perWeek === "number" ? stats.perWeek : null, cards: 0, latest: stats.latest ?? null,
      lifecycle: row.lifecycle === "none" ? "active" : row.lifecycle, updatedAt: iso(row.updated_at),
      revision: row.revision, definition: owner ? publicZoneDefinition(/** @type {any} */ (definition)) : null, canEdit: owner, canDelete: owner,
      band: evidenceZoneBand(typeof stats.perWeek === "number" ? stats.perWeek : null), overviewAt: iso(row.overview_at), related: [],
    };
  }

  /**
   * The feed's own record of an item a reader may read: its row id, title, tags and entities.
   * @param {unknown} publicId
   */
  async function itemRecord(publicId) {
    if (typeof publicId !== "string" || !PUBLIC_ITEM_ID.test(publicId)) return null;
    const row = (await database.query(`SELECT i.id, i.public_id, coalesce(i.title_zh, i.title_raw) AS title, i.entities,
        coalesce((SELECT array_agg(t.name ORDER BY it.rank) FROM evimed_frontier.item_tags it JOIN evimed_frontier.tags t ON t.id = it.tag_id
          WHERE it.item_id = i.id AND t.state = 'active'), '{}') AS tag_names
      FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id = i.primary_source_id
      WHERE i.public_id = $1 AND i.state = 'published' AND s.enabled`, [publicId])).rows[0];
    if (!row) return null;
    const entities = isRecord(row.entities) ? /** @type {Record<string, unknown>} */ (row.entities) : {};
    /** @param {unknown} list */
    const names = (list) => (Array.isArray(list) ? list.filter((name) => typeof name === "string").slice(0, 6) : []);
    return { rowId: String(row.id), id: String(row.public_id), title: String(row.title ?? ""), tags: names(row.tag_names),
      entities: { drugs: names(entities.drugs), diseases: names(entities.diseases), trials: names(entities.trials), orgs: names(entities.orgs) } };
  }

  /**
   * Whether a zone is a topic zone the reader can read (a definition, a lifecycle): the routes send its edits here and any other
   * zone's to the older writer.
   * @param {any} user @param {string} ref
   */
  async function isTopicZone(user, ref) {
    if (typeof ref !== "string" || !ref || ref.length > 100) return false;
    return (await database.query(`SELECT 1 FROM evimed_frontier.evidence_zones z WHERE (z.id = $1 OR z.slug = $1) AND z.lifecycle <> 'none'
      AND (z.state = 'published' OR z.user_id = $2)`, [ref, user.id])).rowCount > 0;
  }

  /**
   * `POST /zones/draft` — `{text, baseZoneId?, fromItemId?}`.
   * @param {any} user @param {unknown} body
   */
  async function draftZone(user, body) {
    const input = fieldsOf(body, ["text", "baseZoneId", "fromItemId"]);
    if (input.text != null && typeof input.text !== "string") throw error(400, "invalid", "The words for the zone are not text.");
    const text = clean(input.text, EVIDENCE_ZONE_LIMITS.draftTextChars + 1);
    if (text.length > EVIDENCE_ZONE_LIMITS.draftTextChars) throw error(400, "invalid", `Describe the zone in at most ${EVIDENCE_ZONE_LIMITS.draftTextChars} characters.`);
    if (!draft) throw error(503, "draft_unavailable", "Drafting a zone is not available here.");
    await ready();
    let baseZone = null;
    if (input.baseZoneId != null) {
      const row = await database.transaction((/** @type {any} */ client) => zoneRow(client, user, String(input.baseZoneId)));
      // A reader sees the definition of their own zones; another reader's is theirs to read as the zone's title and scope.
      baseZone = { id: row.id, title: row.title, definition: row.definition };
    }
    let fromItem = null;
    if (input.fromItemId != null) {
      const record = await itemRecord(input.fromItemId);
      if (!record) throw error(404, "not_found", "No such visible frontier item.");
      fromItem = record;
    }
    if (!text && !baseZone && !fromItem) throw error(400, "invalid", "Say what to follow.");
    return draft.draft({ user, text, baseZone, fromItem });
  }

  /**
   * `POST /zones/preview` — `{definition}`: recall only, over the last thirty days.
   * @param {any} user @param {unknown} body
   */
  async function previewZone(user, body) {
    const input = fieldsOf(body, ["definition"]);
    await ready();
    const definition = await definitionOf(input.definition);
    return { preview: draft ? await draft.preview(user, definition) : { count30: 0, perWeek: 0, band: null, recent: [], borderline: [] } };
  }

  /**
   * `POST /zones` with a definition — a reader's 我的专区.
   * @param {any} user @param {unknown} body
   */
  async function create(user, body) {
    const input = fieldsOf(body, ["title", "definition", "seeds", "published", "requestId"]);
    const title = clean(input.title, EVIDENCE_ZONE_LIMITS.titleChars);
    if (!title) throw error(400, "invalid", "A zone needs a name.");
    if (input.published != null && typeof input.published !== "boolean") throw error(400, "invalid", "published must be true or false.");
    if (input.requestId != null && (typeof input.requestId !== "string" || !REQUEST_ID.test(input.requestId))) throw error(400, "invalid", "Invalid request identity.");
    await ready();
    const definition = await definitionOf(input.definition, await readableSeeds(input.seeds));
    const id = input.requestId ? zoneIdFor(user.id, input.requestId) : `ez_${randomUUID().replaceAll("-", "")}`;
    const state = input.published === true ? "published" : "draft";
    const result = await database.transaction(async (/** @type {any} */ client) => {
      // One reader's creations are taken in turn, so two requests at twenty-nine zones cannot both make the thirtieth.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evidence-user-zones:${user.id}`]);
      const held = (await client.query("SELECT user_id, title, state, definition FROM evimed_frontier.evidence_zones WHERE id = $1", [id])).rows[0];
      if (held) {
        if (held.user_id !== user.id || held.title !== title || held.state !== state || visibleKey(held.definition) !== visibleKey(definition))
          throw error(409, "request_conflict", "Request identity was already used for a different zone.");
        return { replay: true };
      }
      const owned = Number((await client.query("SELECT count(*)::integer AS n FROM evimed_frontier.evidence_zones WHERE user_id = $1 AND kind = 'user' AND lifecycle <> 'none'", [user.id])).rows[0].n);
      if (owned >= max) {
        counters.limitRefused += 1;
        throw error(409, "user_zone_limit", `At most ${max} zones of your own.`);
      }
      await insertTopicZone(client, { id, userId: user.id, kind: "user", state, visibility: "platform", title, definition });
      await recordZoneChange(client, id, "created", `owner:${user.id}`, { title, published: state === "published" });
      await zones.bump(client);
      return { replay: false };
    });
    if (!result.replay) {
      counters.created += 1;
      if (state === "published") counters.published += 1;
      afterSave(id);
    }
    return { zone: await detailOf(user, id) };
  }

  /**
   * `PATCH /zones/:id` — `{title?, definition?, published?, expectedRevision}`: the owner of a reader's zone.
   * @param {any} user @param {string} ref @param {unknown} body
   */
  async function update(user, ref, body) {
    const input = fieldsOf(body, ["title", "definition", "published", "expectedRevision"]);
    if (!Number.isSafeInteger(input.expectedRevision)) throw error(400, "invalid", "expectedRevision is required.");
    if (input.published != null && typeof input.published !== "boolean") throw error(400, "invalid", "published must be true or false.");
    let title = null;
    if (input.title !== undefined) {
      title = clean(input.title, EVIDENCE_ZONE_LIMITS.titleChars);
      if (!title) throw error(400, "invalid", "A zone needs a name.");
    }
    await ready();
    const wanted = input.definition === undefined ? null : await definitionOf(input.definition);
    const outcome = await database.transaction(async (/** @type {any} */ client) => {
      const row = await zoneRow(client, user, ref, true);
      if (!ownsUserZone(row, user)) throw error(403, "owner_required", "Only the owner of a zone may change it.");
      if (input.expectedRevision !== row.revision) throw error(409, "revision_conflict", "The zone changed; reload before saving.");
      /** @type {string[]} */
      const sets = [];
      /** @type {unknown[]} */
      const values = [row.id];
      const set = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => { values.push(value); sets.push(`${column} = $${values.length}${cast}`); };
      const changes = [];
      let definitionChanged = false;
      if (title !== null && title !== row.title) { set("title", title); changes.push(["definition", { title }]); }
      if (wanted && visibleKey(wanted) !== visibleKey(row.definition)) {
        // The reader's seeds and the likes and dislikes they gave stay with the zone through an edit of its words.
        const kept = { ...wanted, seeds: isRecord(row.definition?.seeds) ? row.definition.seeds : wanted.seeds };
        set("definition", JSON.stringify(kept), "::jsonb");
        set("zone_type", kept.type);
        set("specialties", kept.specialties, "::text[]");
        set("group_label", kept.group);
        set("scope_zh", kept.scope);
        set("description", kept.scope);
        sets.push("definition_version = definition_version + 1");
        definitionChanged = true;
        changes.push(["definition", { version: row.definition_version + 1, keywords: kept.keywords.map((keyword) => keyword.label) }]);
      }
      let flipped = null;
      if (input.published != null && (input.published ? "published" : "draft") !== row.state) {
        flipped = input.published ? "published" : "draft";
        set("state", flipped);
        changes.push([input.published ? "published" : "unpublished", {}]);
      }
      if (sets.length) {
        sets.push("revision = revision + 1", "updated_at = clock_timestamp()");
        await client.query(`UPDATE evimed_frontier.evidence_zones SET ${sets.join(", ")} WHERE id = $1`, values);
        for (const [kind, detailValue] of changes) await recordZoneChange(client, row.id, String(kind), `owner:${user.id}`, /** @type {Record<string, unknown>} */ (detailValue));
        await zones.bump(client);
      }
      return { id: row.id, definitionChanged, flipped };
    });
    if (outcome.definitionChanged || outcome.flipped) counters.updated += 1;
    if (outcome.flipped === "published") counters.published += 1;
    if (outcome.definitionChanged) afterSave(outcome.id);
    return { zone: await detailOf(user, outcome.id) };
  }

  /**
   * `DELETE /zones/:id` — the owner of a reader's zone. Its items, follows and cards go with it; its history stays.
   * @param {any} user @param {string} ref
   */
  async function remove(user, ref) {
    await ready();
    await database.transaction(async (/** @type {any} */ client) => {
      const row = await zoneRow(client, user, ref, true);
      if (!ownsUserZone(row, user)) throw error(403, "owner_required", "Only the owner of a zone may delete it.");
      await client.query("DELETE FROM evimed_frontier.evidence_zones WHERE id = $1", [row.id]);
      await recordZoneChange(client, row.id, "deleted", `owner:${user.id}`, { title: row.title, published: row.state === "published" });
      await zones.bump(client);
    });
    counters.deleted += 1;
    return { deleted: true };
  }

  /**
   * `POST /zones/:id/items/:itemId/feedback` — `{kind: 'not-in' | 'more-like'}`: the reader's word on one item of a zone they can read.
   * The data plane decides what it means (a reader's own zone obeys at once; a platform zone's judge reads the pair again).
   * @param {any} user @param {string} ref @param {string} itemPublicId @param {unknown} body
   */
  async function feedback(user, ref, itemPublicId, body) {
    const input = fieldsOf(body, ["kind"]);
    if (!FEEDBACK_KINDS.includes(input.kind)) throw error(400, "invalid", "kind must be not-in or more-like.");
    await ready();
    const row = await database.transaction((/** @type {any} */ client) => zoneRow(client, user, ref));
    const item = await itemRecord(itemPublicId);
    if (!item) throw error(404, "not_found", "No such visible frontier item.");
    if (!membership?.feedback) throw error(503, "feedback_unavailable", "Zone feedback is not available here.");
    await membership.feedback(row.id, item.rowId, input.kind, { userId: user.id, isOwner: ownsUserZone(row, user) });
    counters.feedback += 1;
    return { accepted: true };
  }

  /**
   * A zone made from the words a reader typed to follow (`POST /follows kind:'query'`): drafted, then created, unpublished. The
   * same words are the same zone — the second request finds the first's, without drafting again.
   * @param {any} user @param {unknown} words
   */
  async function createFromWords(user, words) {
    const label = clean(words, EVIDENCE_ZONE_LIMITS.draftTextChars);
    if (!label) throw error(400, "invalid", "The words to follow are empty.");
    if (!draft) throw error(503, "draft_unavailable", "Drafting a zone is not available here.");
    await ready();
    const requestId = `typed-${createHash("sha256").update(label.toLowerCase()).digest("hex").slice(0, 40)}`;
    const id = zoneIdFor(user.id, requestId);
    const held = (await database.query("SELECT 1 FROM evimed_frontier.evidence_zones WHERE id = $1 AND user_id = $2", [id, user.id])).rowCount;
    if (held) return { zone: await detailOf(user, id) };
    counters.fromWords += 1;
    const drafted = await draft.draft({ user, text: label });
    try {
      return await create(user, { title: drafted.draft.title, definition: drafted.draft.definition, seeds: { positive: [], negative: [] }, published: false, requestId });
    } catch (failure) {
      // Two requests for the same words drafted two different zones: the first one made is the one.
      if (/** @type {any} */ (failure)?.code === "evidence_request_conflict") return { zone: await detailOf(user, id) };
      throw failure;
    }
  }

  /**
   * The typed follows that existed when topic zones shipped become unpublished zones of their readers, once: in one transaction, under
   * the marker, the follows (and their matches) are deleted and the readers' lists moved on. A follow whose words cannot make a
   * definition is dropped with the rest.
   */
  async function convertTypedFollows() {
    const made = await database.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [TYPED_FOLLOWS_MARKER]);
      const marker = await client.query("INSERT INTO evimed_frontier.meta(key, value, updated_at) VALUES ($1, '{}'::jsonb, clock_timestamp()) ON CONFLICT (key) DO NOTHING RETURNING key", [TYPED_FOLLOWS_MARKER]);
      if (!marker.rowCount) return [];
      const follows = (await client.query("SELECT id, user_id, key, label, query FROM evimed_frontier.user_follows WHERE kind = 'query' ORDER BY id")).rows;
      /** @type {string[]} */
      const ids = [];
      const readers = new Set();
      for (const follow of follows) {
        readers.add(follow.user_id);
        const definition = definitionFromTypedFollow(String(follow.label), follow.query);
        if (!definition) continue;
        const id = zoneIdFor(follow.user_id, `typed-follow-${createHash("sha256").update(String(follow.key)).digest("hex").slice(0, 32)}`);
        const title = clean(follow.label, EVIDENCE_ZONE_LIMITS.titleChars) || definition.keywords[0].label;
        if (await insertTopicZone(client, { id, userId: follow.user_id, kind: "user", state: "draft", visibility: "platform", title, definition })) {
          await recordZoneChange(client, id, "created", "migration", { from: "typed-follow", title });
          ids.push(id);
        }
      }
      if (follows.length) {
        await client.query("DELETE FROM evimed_frontier.user_follows WHERE kind = 'query'");
        for (const reader of readers) {
          await client.query(`INSERT INTO evimed_frontier.user_prefs (user_id, state_version) VALUES ($1, 1)
            ON CONFLICT (user_id) DO UPDATE SET state_version = evimed_frontier.user_prefs.state_version + 1`, [reader]);
          await client.query("UPDATE evimed_frontier.user_profiles SET for_you_at = NULL WHERE user_id = $1", [reader]);
        }
        await zones.bump(client);
      }
      return ids;
    });
    counters.converted += made.length;
    for (const id of made) afterSave(id);
    return made;
  }

  return {
    ready, draft: draftZone, preview: previewZone, create, update, remove, feedback, createFromWords, convertTypedFollows, isTopicZone,
    status: () => ({ counters: { ...counters }, userZonesMax: max, composedAt: now().toISOString() }),
  };
}
