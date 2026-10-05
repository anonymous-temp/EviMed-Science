/**
 * Keeping an evidence card current (evidence-flywheel plan 2026-10-05 §2.5, §4.4, §5.4 — F13): what a card says about its own
 * 时效, and the loops that keep it true. A card is `current`, or it has `new_evidence_pending`, or a source of it changed
 * (`source_changed`), or it was superseded or is no longer updated — the closed vocabulary of `currencyLabel` in
 * `@evimed/domain`, written once, not copied here.
 *
 * Until 2026-10-05 the zone's AI editor found "new evidence" by looking for the zone's query as a substring of an item's title,
 * and told no one about a card it did not write. Now every published card is watched by the keys it shares with the frontier
 * feed — an identifier (DOI, PMID, registry number) means the same work, an entity means the same subject — and by the one
 * source-change record (`sourceChanges.mjs`), and when something bears on it the card is labelled first and answered second:
 *
 * - an AI-written card is revised by the editor (the existing flow: `evidenceCard`, `saveEditorial`, review), after which it
 *   is `current` again;
 * - a user's, company's or doctor's card is never rewritten: its producer gets one notice per card and batch of items;
 * - an official synthesis stays labelled for the platform's topic programme, which reads it through `staleOfficialCards`.
 *
 * Hidden knowledge:
 *
 * - **Matching is by keys, and a shared entity is not yet evidence.** An entity match counts only when the item carries at
 *   least two of the card's entity keys (one, when the card has one), and the frontier item the card was made from is its own
 *   source and not news. What an identifier match means is stored: `same_work` (the item names a study the card cites — a
 *   correction, a new report of it) against `new_evidence`; only items newer than the platform's last look are considered, so
 *   the item a cited study entered the feed as, long before, is not raised.
 *   Whether a new item changes the card's answer is the editor's judgement (`evidenceTarget`), never a rule here.
 * - **The label is recomputed from what is known, never stepped.** `currencyLabel` is given the source changes, whether
 *   items are pending, and whether the card was retired; so a source change that is later withdrawn, or an item the editor
 *   judged irrelevant, cannot leave a stale label behind.
 * - **A retired card is still watched.** Retirement takes a card out of the editor's rotation, not out of the watch: a new
 *   matching item re-opens it.
 * - **Everything here is a label or a notice.** Nothing withholds a card from its readers and nothing here rewrites a
 *   person's words.
 *
 * @module evidenceCurrency
 */
import { createHash, randomUUID } from "node:crypto";
import {
  PLATFORM_PUBLISHER_USER_ID, SOURCE_CHANGE_NOTICE_KINDS, SOURCE_CURRENCY_LABELS, SOURCE_CURRENCY_LABELS_ZH, currencyLabel,
  doiOfSourceIdentifier, evidenceConclusionChanged, evidenceNewEvidenceNoticeTitleZh, evidenceUpkeepRoute,
} from "@evimed/domain";
import { identifierKeys, splitKeys } from "@evimed/domain/entity-keys";
import { HttpError } from "./security.mjs";
import { frontierItemsMatching } from "./entityVocabulary.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { sourceIdentifiersOf } from "./sourceChanges.mjs";

/** What the upkeep loops may do at most, and why. Each bound is a resource limit, not an opinion about a card. */
export const EVIDENCE_UPKEEP_LIMITS = Object.freeze({
  /** Frontier items a card holds as pending, and items it remembers having handled (so none is raised twice). */
  pendingItems: 20, handledItems: 200,
  /** Source changes a card remembers. */
  changes: 20,
  /** Items one notice names. */
  noticeItems: 5,
  /** How many of a card's entity keys an item must carry to count as news about the same subject (one, for a card with one). */
  entityMatchMin: 2,
  /** Items one match asks for. */
  matchLimit: 20,
  /** A repeated "searched, nothing new" is one entry of the public log per this many days, not one per check. */
  noChangeLogGapDays: 30,
  /** How long a loop holds its lease, and how long a card that failed is left alone. */
  leaseMs: 120_000, failureBackoffMs: 600_000,
  /** One page of the source-change feed, and the stale source keys refreshed before it is read. */
  sourcePage: 50, sourceKeyBatch: 50,
  /** One page of the feed the downstream reconcilers read, and the accounts they are asked about per tick. */
  downstreamPage: 25, downstreamAccounts: 20,
});

/** The levers the loops read (`config.mjs`), with the defaults that apply when a deployment sets none. */
export const EVIDENCE_UPKEEP_DEFAULTS = Object.freeze({
  batch: 20, intervalHours: 24, retireAfterChecks: 6, retireAfterDays: 180, challengesPerDay: 10,
});

/** @param {unknown} value */
const iso = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : null);
/** @param {string} value */
const sha = (value) => createHash("sha256").update(value).digest("hex");
const codeOf = (/** @type {any} */ error) => (typeof error?.code === "string" && /^[a-z0-9_]{2,100}$/.test(error.code) ? error.code : "evidence_upkeep_failed");

/** Whether a zone row is the platform's: marked official, or owned by the publisher account. @param {any} zone */
export const officialZoneRow = (zone) => zone?.kind === "official" || zone?.user_id === PLATFORM_PUBLISHER_USER_ID || zone?.zone_owner === PLATFORM_PUBLISHER_USER_ID;

/**
 * What a card's 时效 reads as, from its row: the closed label and its Chinese, the frontier items waiting on it, when the
 * platform last looked, whether it was retired, and — for a card taken back — when, why, and the log entry that says so.
 * A card that is withdrawn is read as `no_longer_updated`, whatever else is true of it.
 * @param {any} row an `evidence_cards` row (or a list row carrying these columns)
 */
export function evidenceCurrencyView(row) {
  const withdrawn = row?.withdrawn && typeof row.withdrawn === "object"
    ? { at: row.withdrawn.at ?? null, reason: String(row.withdrawn.reason ?? ""), changeLogId: row.withdrawn.changeLogId == null ? null : String(row.withdrawn.changeLogId) } : null;
  const currency = withdrawn ? "no_longer_updated" : SOURCE_CURRENCY_LABELS.includes(row?.currency) ? row.currency : "current";
  return {
    currency, currencyLabel: /** @type {any} */ (SOURCE_CURRENCY_LABELS_ZH)[currency],
    pendingItemIds: Array.isArray(row?.pending_item_ids) ? row.pending_item_ids.map(String) : [],
    lastCheckedAt: iso(row?.last_checked_at), retiredAt: iso(row?.retired_at), withdrawn,
  };
}

/** The aggregate a zone's counts query adds: how many published cards stand under each label, and when one was last looked at. */
export const EVIDENCE_ZONE_CURRENCY_SQL = [
  ...SOURCE_CURRENCY_LABELS.map((label) => `count(*) FILTER(WHERE state='published' AND currency='${label}')::integer AS currency_${label}`),
  "max(last_checked_at) FILTER(WHERE state='published') AS currency_last_checked_at",
].join(",");

/** @param {any} counts the row `EVIDENCE_ZONE_CURRENCY_SQL` produced */
export const evidenceZoneCurrencyView = (counts) => ({
  currencyCounts: Object.fromEntries(SOURCE_CURRENCY_LABELS.map((label) => [label, Number(counts?.[`currency_${label}`] ?? 0)])),
  lastCheckedAt: iso(counts?.currency_last_checked_at),
});

/**
 * The identifier keys a card's sources and the study it verified name, in the frontier's own form (`doi:`, `pmid:`, `reg:`).
 * @param {{ sources?: any[], lineage?: any }} card
 * @returns {string[]}
 */
export function cardIdentifierKeys(card) {
  const study = card?.lineage?.verifiedStudy;
  const stated = identifierKeys({ doi: study?.doi, pmid: study?.pmid, registryIds: study?.registryId ? [study.registryId] : [] });
  const cited = (Array.isArray(card?.sources) ? card.sources : []).flatMap((source) => sourceIdentifiersOf(source));
  return [...new Set([...cited, ...stated])].sort();
}

/**
 * What a zone is about, as keys: its own words resolved through the vocabulary, joined to the entity keys and the identifier
 * keys of the cards it holds. A resolver that cannot answer leaves the zone with its cards' keys alone.
 * @param {{ database: any, service?: any, zone: { id: string, title?: string, description?: string, background?: string } }} input
 * @returns {Promise<{ entityKeys: string[], identifierKeys: string[] }>}
 */
export async function zoneMatchKeys({ database, service = null, zone }) {
  const texts = [zone.title, zone.description, zone.background].filter((text) => typeof text === "string" && text.trim());
  const own = typeof service?.entityKeysFor === "function" && texts.length
    ? await service.entityKeysFor({ texts, identifiers: [] }).catch(() => []) : [];
  const cards = (await database.query(
    `SELECT c.entity_keys,c.source_keys FROM evimed_frontier.evidence_cards c WHERE c.zone_id=$1 AND c.state='published' ORDER BY c.updated_at DESC LIMIT 200`, [zone.id],
  )).rows;
  return splitKeys([...(Array.isArray(own) ? own : []), ...cards.flatMap((row) => [...(row.entity_keys ?? []), ...(row.source_keys ?? [])])]);
}

const CARD_COLUMNS = `c.id,c.zone_id,c.user_id,c.revision,c.title,c.state,c.source_item_id,c.lineage,c.entity_keys,c.producer,c.originality,
  c.currency,c.pending_item_ids,c.currency_detail,c.last_checked_at,c.withdrawn,c.retired_at,c.no_change_checks,c.no_change_since,
  c.source_keys,c.source_keys_revision,c.created_at,
  c.editorial->'author'->>'kind' AS author_kind,
  coalesce(c.editorial->>'automationContentHash' IS NOT NULL AND c.editorial->>'automationContentHash'=c.editorial->>'contentHash',false) AS ai_managed,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('url',s->>'url')),'[]'::jsonb) FROM jsonb_array_elements(c.sources) s) AS source_refs,
  z.kind AS zone_kind,z.user_id AS zone_owner,z.title AS zone_title,
  coalesce((SELECT a.enabled FROM evimed_frontier.evidence_automation a WHERE a.zone_id=c.zone_id),false) AS automation_enabled`;
const CARD_FROM = "evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id";

/**
 * Who answers for this card right now: the editor (an AI card, kept by one, in a zone whose upkeep is on), the producer, or
 * the programme. An AI card whose zone's upkeep is off or whose text a person edited is its owner's to answer for — or, in
 * an official zone, waits for the programme.
 * @param {any} row a card row with `CARD_COLUMNS`
 * @returns {'editor' | 'producer_notice' | 'programme'}
 */
export function cardUpkeepRoute(row) {
  const official = officialZoneRow(row);
  const route = evidenceUpkeepRoute({
    zoneKind: official ? "official" : row.zone_kind, producerKind: row.producer?.kind ?? null,
    authorKind: row.author_kind === "ai" && row.ai_managed ? "ai" : "human", originality: row.originality, lineage: row.lineage,
  });
  if (route === "editor" && !row.automation_enabled) return official ? "programme" : "producer_notice";
  return route;
}

/**
 * The official cards the platform's topic programme is to take up: published, in an official zone, labelled as having new
 * evidence or a changed source, and not ones the editor is keeping itself. Newest label first.
 * @param {any} database @param {{ limit?: number }} [options]
 * @returns {Promise<Array<{ cardId: string, zoneId: string, currency: string, pendingItemIds: string[], lastCheckedAt: string | null }>>}
 */
export async function staleOfficialCards(database, { limit = 20 } = {}) {
  const size = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 20));
  await migrateEvidenceZones(database);
  const rows = (await database.query(
    `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM}
     WHERE c.state='published' AND z.state='published' AND c.withdrawn IS NULL AND c.currency IN ('new_evidence_pending','source_changed')
       AND (z.kind='official' OR z.user_id=$1) ORDER BY c.updated_at DESC,c.id LIMIT 1000`, [PLATFORM_PUBLISHER_USER_ID],
  )).rows;
  return rows.filter((row) => cardUpkeepRoute(row) === "programme").slice(0, size).map((row) => ({
    cardId: row.id, zoneId: row.zone_id, currency: row.currency, pendingItemIds: row.pending_item_ids ?? [], lastCheckedAt: iso(row.last_checked_at),
  }));
}

/**
 * @typedef {{ itemId: string, kind: 'same_work' | 'new_evidence', title: string | null, source: string | null }} PendingItem
 * @typedef {{ identifier: string | null, kind: string, noticeIdentifier: string | null, date: string | null, firstSeenAt: string | null }} CardChange
 */

/** @param {any} change @param {string | null} identifier @returns {CardChange} */
const changeOf = (change, identifier) => ({
  identifier, kind: String(change.kind), noticeIdentifier: change.noticeIdentifier ?? null, date: change.date ?? null, firstSeenAt: change.firstSeenAt ?? null,
});
/** @param {CardChange} change */
const changeKey = (change) => `${change.identifier ?? ""}|${change.kind}|${change.noticeIdentifier ?? ""}`;

/**
 * @param {{
 *   database: any, changeLog: ReturnType<typeof import("./evidenceChangeLog.mjs").createEvidenceChangeLog>,
 *   sourceChanges?: ReturnType<typeof import("./sourceChanges.mjs").createSourceChanges> | null,
 *   notifications?: { create: (userId: string, input: any) => Promise<any> } | null,
 *   matchItems?: ((query: any) => Promise<any[]>) | null,
 *   levers?: { batch?: number, intervalHours?: number, retireAfterChecks?: number, retireAfterDays?: number, challengesPerDay?: number }, now?: () => Date, workerId?: string, report?: (code: string) => void,
 *   isOperator?: (userId: string) => boolean,
 *   notifyZoneFollowers?: ((event: { zoneId: string, cardId: string, revision: number, kind: 'updated' | 'corrected' | 'withdrawn' }) => Promise<any>) | null,
 *   resultImpacts?: any, knowledgeChange?: any,
 * }} options
 *   `matchItems` finds the frontier items that share keys with a card (default: `frontierItemsMatching` over `database`).
 *   `notifyZoneFollowers` is the frontier-links package's push to a zone's followers; absent, nothing is pushed.
 *   `resultImpacts` and `knowledgeChange` are what a changed source reaches besides cards (`resultImpact.mjs`,
 *   `knowledgeChange.mjs`); absent, those two are not driven.
 */
export function createEvidenceUpkeep({
  database, changeLog, sourceChanges = null, notifications = null, matchItems = null, levers = {}, now = () => new Date(),
  workerId = randomUUID(), report = () => {}, isOperator = () => false, notifyZoneFollowers = null, resultImpacts = null, knowledgeChange = null,
}) {
  const lever = { ...EVIDENCE_UPKEEP_DEFAULTS, ...levers };
  const L = EVIDENCE_UPKEEP_LIMITS;
  const match = matchItems ?? ((/** @type {any} */ query) => frontierItemsMatching(database, query));
  const counters = {
    watched: 0, watchFailures: 0, newEvidence: 0, sameWork: 0, sourceChanged: 0, noChange: 0, retired: 0, reopened: 0, followUpsQueued: 0, programmeHeld: 0,
    noticesSent: 0, noticesSkipped: 0, noticeFailures: 0, followUpsDone: 0, notRelevant: 0, producerEdits: 0,
    sourcePolls: 0, sourceCardsMarked: 0, sourceKeysRefreshed: 0, downstreamPages: 0, downstreamAccounts: 0, downstreamFailures: 0,
  };
  /** Cards whose check failed, left alone for a while so one bad card cannot starve the rest. @type {Map<string, number>} */
  const failedUntil = new Map();

  /** @param {string} code @param {unknown} error */
  const failed = (code, error) => { try { report(`evidence upkeep ${code}: ${codeOf(error)}`); } catch { /* the report is advice */ } };

  // ----- leased loop state ------------------------------------------------------------------------------------------

  /**
   * Take the lease of a loop, or none: the loop's cursor and payload, held for `leaseMs`; `null` when another worker has it.
   * @param {string} name
   */
  async function lease(name) {
    await migrateEvidenceZones(database);
    await database.query("INSERT INTO evimed_frontier.evidence_upkeep_state(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
    const taken = await database.query(
      `UPDATE evimed_frontier.evidence_upkeep_state SET lease_owner=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond'
       WHERE name=$1 AND (lease_owner IS NULL OR lease_until<clock_timestamp()) RETURNING cursor,payload`, [name, workerId, L.leaseMs],
    );
    return taken.rows[0] ? { cursor: Number(taken.rows[0].cursor), payload: taken.rows[0].payload ?? {} } : null;
  }
  /** @param {string} name @param {{ cursor?: number, payload?: any }} [state] */
  async function release(name, state = {}) {
    await database.query(
      `UPDATE evimed_frontier.evidence_upkeep_state SET cursor=coalesce($3::bigint,cursor),payload=coalesce($4::jsonb,payload),lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE name=$1 AND lease_owner=$2`, [name, workerId, state.cursor ?? null, state.payload === undefined ? null : JSON.stringify(state.payload)],
    );
  }

  // ----- notices and follow-ups ---------------------------------------------------------------------------------------

  /**
   * One notice to a card's producer, once per card and batch (the inbox's idempotency key). Never for the platform's own cards,
   * whose publisher cannot sign in, and never an error to the loop that sent it.
   * @param {any} row @param {{ kind: 'new_evidence' | 'source_change', items?: PendingItem[], changes?: CardChange[], key: string }} notice
   */
  async function notifyProducer(row, { kind, items = [], changes = [], key }) {
    if (!notifications || officialZoneRow(row) || row.user_id === PLATFORM_PUBLISHER_USER_ID) { counters.noticesSkipped += 1; return null; }
    const names = items.slice(0, L.noticeItems).map((item) => `· ${item.title ?? item.itemId}${item.source ? `（${item.source}）` : ""}`);
    const more = items.length > L.noticeItems ? `\n另有 ${items.length - L.noticeItems} 项。` : "";
    const title = kind === "new_evidence" ? evidenceNewEvidenceNoticeTitleZh({ count: items.length }) : "你的卡片引用的来源出现了变更";
    const body = kind === "new_evidence"
      ? `你的卡片「${row.title}」可能受到下面这些新研究影响：\n${names.join("\n")}${more}\n请核对后决定要不要更新卡片；平台不会替你改写你的卡片。核对后在卡片上点“已核对”，或直接修改卡片，这个提示就会消失。`
      : `你的卡片「${row.title}」引用的来源出现了${[...new Set(changes.map((change) => change.kind))].join("、")}：\n${changes.slice(0, L.noticeItems).map((change) => `· ${change.identifier}`).join("\n")}\n卡片已标注，读者会看到提示；请核对依据这些来源的结论，决定是否修改。`;
    try {
      const sent = await notifications.create(row.user_id, {
        noticeType: "notify", severity: kind === "source_change" ? "attention" : "info", title: title.slice(0, 150), body: body.slice(0, 8000),
        source: { type: "system", id: `evidence-card-${row.id}` }, idempotencyKey: `evidence-upkeep:${row.id}:${kind}:${key}`.slice(0, 200),
      });
      counters.noticesSent += 1;
      return sent;
    } catch (error) { counters.noticeFailures += 1; failed("notice", error); return null; }
  }

  /**
   * Ask the editor to revise a card: its job (the maintenance job of that card, made if there is none) goes back to pending with the
   * newest matching item as the source to read. Only a card of a zone whose upkeep is on is ever queued; a job that is running is
   * left alone, and the next pass finds the card still labelled.
   * @param {any} row @param {{ kind: 'new_evidence' | 'source_change', items?: PendingItem[] }} request
   */
  async function queueFollowUp(row, { kind, items = [] }) {
    const target = items[0] ? (await database.query(
      "SELECT public_id,canonical_url,title_raw FROM evimed_frontier.items WHERE public_id=$1", [items[0].itemId])).rows[0] ?? null : null;
    const payload = { managedRevision: row.revision, upkeep: { kind, itemIds: items.map((item) => item.itemId), beforeRevision: row.revision, requestedAt: now().toISOString() } };
    return database.transaction(async (/** @type {any} */ client) => {
      const jobs = (await client.query(
        `SELECT * FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 AND card_id=$2 ORDER BY updated_at DESC,id FOR UPDATE`, [row.zone_id, row.id])).rows;
      if (jobs.some((job) => job.state === "running")) return false;
      if (jobs.length) {
        await client.query(
          `UPDATE evimed_frontier.evidence_editorial_jobs SET state='pending',attempts=0,available_at=clock_timestamp(),last_error=NULL,lease_owner=NULL,lease_until=NULL,
             source_item_id=coalesce($2,source_item_id),source_url=coalesce($3,source_url),source_title=coalesce($4,source_title),
             payload=(COALESCE(payload,'{}'::jsonb)-'rewriteRevision'-'sourceReadCursor')||$5::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
          [jobs[0].id, target?.public_id ?? null, target?.canonical_url ?? null, target?.title_raw ?? null, JSON.stringify(payload)],
        );
      } else {
        const identity = `card:${row.id}`;
        await client.query(
          `INSERT INTO evimed_frontier.evidence_editorial_jobs(id,zone_id,identity_key,card_id,source_item_id,source_url,source_title,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(zone_id,identity_key) DO NOTHING`,
          [`ej_${sha(JSON.stringify([row.zone_id, identity])).slice(0, 32)}`, row.zone_id, identity, row.id, target?.public_id ?? row.source_item_id ?? null,
            target?.canonical_url ?? null, target?.title_raw ?? null, JSON.stringify(payload)],
        );
      }
      counters.followUpsQueued += 1;
      return true;
    });
  }

  /**
   * What happens after a card was labelled, by who answers for it. An editor card is queued; everything else — or an editor card
   * that could not be queued — is told to its producer; an official synthesis is left for the programme.
   * @param {any} row @param {{ kind: 'new_evidence' | 'source_change', items?: PendingItem[], changes?: CardChange[] }} what
   */
  async function answer(row, { kind, items = [], changes = [] }) {
    const route = cardUpkeepRoute(row);
    const key = sha(JSON.stringify(kind === "new_evidence" ? items.map((item) => item.itemId).sort() : changes.map(changeKey).sort())).slice(0, 24);
    if (route === "programme") { counters.programmeHeld += 1; return route; }
    if (route === "editor") {
      let queued = false;
      try { queued = await queueFollowUp(row, { kind, items }); } catch (error) { failed("queue", error); }
      // A source change on a person's own zone is told to them as well: the editor can re-read a retracted source but not repair the card.
      if (kind === "source_change" && !officialZoneRow(row)) await notifyProducer(row, { kind, changes, key });
      if (!queued && kind === "new_evidence") await notifyProducer(row, { kind, items, key });
      return route;
    }
    await notifyProducer(row, { kind, items, changes, key });
    return route;
  }

  // ----- the card's own check -------------------------------------------------------------------------------------------

  /** The card's sources' identifiers, written when the revision they were read from is not the card's. @param {any} row */
  async function ensureSourceKeys(row) {
    if (row.source_keys_revision === row.revision) return row.source_keys ?? [];
    const keys = [...new Set((row.source_refs ?? []).flatMap((/** @type {any} */ source) => sourceIdentifiersOf(source)))].sort();
    await database.query("UPDATE evimed_frontier.evidence_cards SET source_keys=$2,source_keys_revision=$3 WHERE id=$1 AND revision=$3", [row.id, keys, row.revision]);
    counters.sourceKeysRefreshed += 1;
    return keys;
  }

  /**
   * The source changes the record holds against a card's sources: read from the one record, no network.
   * @param {any} row @returns {Promise<CardChange[]>}
   */
  async function recordedChanges(row) {
    if (!sourceChanges) return [];
    const found = await sourceChanges.changesForCardSources(row.source_refs ?? []);
    const seen = new Map();
    for (const entry of found) for (const change of entry.changes) {
      const record = changeOf(change, entry.identifiers[0] ?? null);
      if (!seen.has(changeKey(record))) seen.set(changeKey(record), record);
    }
    return [...seen.values()].slice(0, L.changes);
  }

  /**
   * The frontier items that now bear on a card: new since the platform last looked, not the card's own source, not handled before.
   * @param {any} row @param {string[]} sourceKeys @param {Set<string>} handled @returns {Promise<PendingItem[]>}
   */
  async function newItems(row, sourceKeys, handled) {
    const keys = splitKeys([...(row.entity_keys ?? []), ...sourceKeys]);
    const study = identifierKeys({ doi: row.lineage?.verifiedStudy?.doi, pmid: row.lineage?.verifiedStudy?.pmid, registryIds: row.lineage?.verifiedStudy?.registryId ? [row.lineage.verifiedStudy.registryId] : [] });
    const identifiers = [...new Set([...keys.identifierKeys, ...study])];
    if (!keys.entityKeys.length && !identifiers.length) return [];
    const matches = await match({ entityKeys: keys.entityKeys, identifierKeys: identifiers, since: row.last_checked_at ?? row.created_at, limit: L.matchLimit });
    const need = Math.min(L.entityMatchMin, keys.entityKeys.length);
    /** @type {PendingItem[]} */
    const fresh = [];
    for (const item of matches) {
      if (handled.has(item.publicId) || (row.pending_item_ids ?? []).includes(item.publicId)) continue;
      if (item.publicId === row.source_item_id) continue;
      if (item.matchedBy === "entity" && (item.matchedEntityKeys?.length ?? 0) < need) continue;
      fresh.push({ itemId: item.publicId, kind: item.matchedBy === "identifier" ? "same_work" : "new_evidence", title: item.titleZh ?? item.titleRaw ?? null, source: item.sourceName ?? null });
    }
    return fresh;
  }

  /**
   * One card, once: refresh its keys, read what the source-change record holds against its sources, look for items that bear on it,
   * and write what it found — label, pending items, log entries — in one transaction; then answer (notice, follow-up).
   * @param {any} row
   */
  async function checkCard(row) {
    const at = now();
    const sourceKeys = await ensureSourceKeys(row);
    const detail = row.currency_detail ?? {};
    const handled = new Set(Array.isArray(detail.handled) ? detail.handled : []);
    const changes = await recordedChanges(row);
    const held = new Set((Array.isArray(detail.changes) ? detail.changes : []).map(changeKey));
    const noticeChanges = changes.filter((change) => SOURCE_CHANGE_NOTICE_KINDS.includes(change.kind));
    const addedChanges = noticeChanges.filter((change) => !held.has(changeKey(change)));
    const fresh = await newItems(row, sourceKeys, handled);
    /** @type {PendingItem[]} */
    const pending = [...(Array.isArray(detail.pending) ? detail.pending : []), ...fresh].slice(-L.pendingItems);
    const reopened = Boolean(row.retired_at) && fresh.length > 0;
    const retiredAt = reopened ? null : row.retired_at;
    const label = currencyLabel({ changes, hasNewEvidence: pending.length > 0, retired: Boolean(retiredAt) });
    const quiet = !fresh.length && !addedChanges.length && !pending.length;
    const checks = fresh.length || pending.length ? 0 : row.no_change_checks + 1;
    await database.transaction(async (/** @type {any} */ client) => {
      const written = await client.query(
        `UPDATE evimed_frontier.evidence_cards SET currency=$2,pending_item_ids=$3,currency_detail=$4::jsonb,last_checked_at=$5,retired_at=$6,
           no_change_checks=$7,no_change_since=CASE WHEN $7=0 THEN NULL ELSE coalesce(no_change_since,$5) END WHERE id=$1 AND revision=$8 RETURNING id`,
        [row.id, label, pending.map((item) => item.itemId), JSON.stringify({ changes: changes.slice(0, L.changes), pending, handled: [...handled].slice(-L.handledItems) }), at, retiredAt, checks, row.revision],
      );
      // The card was edited since it was read: what was found is about a card that is gone; the next pass reads the new one.
      if (!written.rowCount) throw new HttpError(409, "evidence_revision_conflict", "The card changed during its check.");
      if (addedChanges.length) {
        await changeLog.append({
          zoneId: row.zone_id, cardId: row.id, category: "correction", trigger: "source_change", revisionBefore: row.revision, revisionAfter: row.revision,
          facts: { sourceChangeKinds: addedChanges.map((change) => change.kind), sourceCount: new Set(addedChanges.map((change) => change.identifier)).size },
          refs: { sourceChanges: addedChanges },
        }, { client });
      }
    });
    if (fresh.length) { counters.newEvidence += 1; if (fresh.some((item) => item.kind === "same_work")) counters.sameWork += 1; }
    if (addedChanges.length) counters.sourceChanged += 1;
    if (reopened) counters.reopened += 1;
    // The card that is already pending and was asked again is not re-queued: its first answer is still under way or was given.
    const route = cardUpkeepRoute(row);
    if (addedChanges.length) await answer(row, { kind: "source_change", changes: addedChanges });
    if (fresh.length) await answer({ ...row, retired_at: retiredAt }, { kind: "new_evidence", items: pending });
    else if (!addedChanges.length && pending.length && route !== "programme") await revisitPending(row, pending);
    if (quiet) await afterQuietCheck({ ...row, no_change_checks: checks, last_checked_at: at }, route);
  }

  /**
   * A card still waiting on its items when an editor could not take them (its job failed or was refused), is told to its owner once.
   * @param {any} row @param {PendingItem[]} pending
   */
  async function revisitPending(row, pending) {
    if (cardUpkeepRoute(row) !== "editor") return;
    const job = (await database.query(`SELECT state FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 AND card_id=$2 ORDER BY updated_at DESC LIMIT 1`, [row.zone_id, row.id])).rows[0];
    if (job && ["failed", "conflict"].includes(job.state))
      await notifyProducer(row, { kind: "new_evidence", items: pending, key: sha(JSON.stringify(pending.map((item) => item.itemId).sort())).slice(0, 24) });
  }

  /**
   * A check that found nothing: for a card the platform keeps, a repeated "searched, no change" is written to the public log
   * (at most once per `noChangeLogGapDays`) and a card that nobody reads, follows or comments on, after enough such checks over
   * enough days, is retired.
   * @param {any} row @param {string} route
   */
  async function afterQuietCheck(row, route) {
    counters.noChange += 1;
    if (route !== "editor" || row.retired_at) return;
    const gap = (await database.query(
      `SELECT 1 FROM evimed_frontier.evidence_change_log WHERE card_id=$1 AND category='searched_no_change' AND trigger='scheduled_check'
         AND occurred_at>clock_timestamp()-$2*interval '1 day' LIMIT 1`, [row.id, L.noChangeLogGapDays])).rowCount;
    if (!gap) await changeLog.append({ zoneId: row.zone_id, cardId: row.id, category: "searched_no_change", trigger: "scheduled_check", revisionBefore: row.revision, revisionAfter: row.revision });
    const since = row.no_change_since ? new Date(row.no_change_since) : null;
    if (row.no_change_checks < lever.retireAfterChecks || !since || now().getTime() - since.getTime() < lever.retireAfterDays * 86_400_000) return;
    // Reads of a page are not recorded, so "nobody reads it" is read from what is: a follow of the zone, or a comment, review or
    // question since the quiet period began.
    const attended = (await database.query(
      `SELECT (EXISTS(SELECT 1 FROM evimed_frontier.evidence_zone_follows WHERE zone_id=$1)
        OR EXISTS(SELECT 1 FROM evimed_frontier.evidence_comments WHERE card_id=$2 AND created_at>=$3)
        OR EXISTS(SELECT 1 FROM evimed_frontier.evidence_reviews WHERE card_id=$2 AND updated_at>=$3)
        OR EXISTS(SELECT 1 FROM evimed_frontier.evidence_zone_feedback WHERE zone_id=$1 AND created_at>=$3)) AS attended`, [row.zone_id, row.id, since])).rows[0].attended;
    if (!attended) await retireCard(row, { by: "inactivity" });
  }

  /**
   * Take a card out of the editor's rotation: `no_longer_updated`, with the date of the last check, and one entry in the log.
   * @param {any} row @param {{ by: 'producer' | 'inactivity' }} options
   */
  async function retireCard(row, { by }) {
    const at = now();
    const detail = row.currency_detail ?? {};
    const label = currencyLabel({ changes: detail.changes ?? [], hasNewEvidence: (row.pending_item_ids ?? []).length > 0, retired: true });
    await database.transaction(async (/** @type {any} */ client) => {
      const done = await client.query("UPDATE evimed_frontier.evidence_cards SET retired_at=$2,currency=$3 WHERE id=$1 AND retired_at IS NULL RETURNING id", [row.id, at, label]);
      if (!done.rowCount) return;
      await changeLog.append({
        zoneId: row.zone_id, cardId: row.id, category: "retired", trigger: by === "producer" ? "producer_edit" : "scheduled_check",
        revisionBefore: row.revision, revisionAfter: row.revision, facts: { retiredBy: by, lastCheckedAt: iso(row.last_checked_at ?? at) },
      }, { client });
      counters.retired += 1;
    });
  }

  /**
   * The watch: published cards the platform has not looked at for `intervalHours`, oldest check first, a batch per tick.
   * @returns {Promise<number>} cards checked
   */
  async function watchTick() {
    const state = await lease("watch");
    if (!state) return 0;
    let checked = 0;
    try {
      const skip = [...failedUntil].filter(([, until]) => until > now().getTime()).map(([id]) => id);
      const due = (await database.query(
        `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM}
         WHERE c.state='published' AND z.state='published' AND c.withdrawn IS NULL AND NOT (c.id=ANY($3::text[]))
           AND (c.last_checked_at IS NULL OR c.last_checked_at<$1) ORDER BY c.last_checked_at NULLS FIRST,c.id LIMIT $2`,
        [new Date(now().getTime() - lever.intervalHours * 3_600_000), lever.batch, skip],
      )).rows;
      for (const row of due) {
        try { await checkCard(row); checked += 1; counters.watched += 1; }
        catch (error) { counters.watchFailures += 1; failedUntil.set(row.id, now().getTime() + L.failureBackoffMs); failed("watch", error); }
      }
    } finally { await release("watch"); }
    return checked;
  }

  // ----- the source-change feed ---------------------------------------------------------------------------------------

  /**
   * The source-change feed, read from a stored position: every published card that cites a changed identifier is labelled
   * `source_changed`, gets an entry in the public log, and is answered the way item 3 of F13 says. No network: the record is read.
   * @returns {Promise<number>} cards marked
   */
  async function sourcePollTick() {
    if (!sourceChanges) return 0;
    const state = await lease("source_changes");
    if (!state) return 0;
    let marked = 0;
    /** @type {{ cursor?: number }} */
    let next = {};
    try {
      // The keys are what finds a card, so a page is read only once every card's keys are current.
      const stale = (await database.query(
        `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.state='published' AND c.source_keys_revision IS DISTINCT FROM c.revision ORDER BY c.id LIMIT $1`, [L.sourceKeyBatch])).rows;
      for (const row of stale) await ensureSourceKeys(row);
      if (stale.length >= L.sourceKeyBatch) return 0;
      const page = await sourceChanges.changedSince(state.cursor, L.sourcePage);
      counters.sourcePolls += 1;
      for (const fact of page.items) {
        const cards = (await database.query(
          `SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.state='published' AND z.state='published' AND c.withdrawn IS NULL AND c.source_keys && $1::text[]`, [[fact.identifier]])).rows;
        for (const row of cards) {
          try { await checkSourceChange(row); marked += 1; } catch (error) { counters.watchFailures += 1; failed("source-change", error); }
        }
      }
      counters.sourceCardsMarked += marked;
      next = { cursor: page.cursor };
      return marked;
    } finally { await release("source_changes", next); }
  }

  /** The source-change half of a card's check, alone: new notices are labelled, logged and answered; nothing else moves. @param {any} row */
  async function checkSourceChange(row) {
    const detail = row.currency_detail ?? {};
    const changes = await recordedChanges(row);
    const held = new Set((Array.isArray(detail.changes) ? detail.changes : []).map(changeKey));
    const added = changes.filter((change) => SOURCE_CHANGE_NOTICE_KINDS.includes(change.kind) && !held.has(changeKey(change)));
    if (!added.length) return;
    const label = currencyLabel({ changes, hasNewEvidence: (row.pending_item_ids ?? []).length > 0, retired: Boolean(row.retired_at) });
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query("UPDATE evimed_frontier.evidence_cards SET currency=$2,currency_detail=$3::jsonb WHERE id=$1",
        [row.id, label, JSON.stringify({ ...detail, changes: changes.slice(0, L.changes) })]);
      await changeLog.append({
        zoneId: row.zone_id, cardId: row.id, category: "correction", trigger: "source_change", revisionBefore: row.revision, revisionAfter: row.revision,
        facts: { sourceChangeKinds: added.map((change) => change.kind), sourceCount: new Set(added.map((change) => change.identifier)).size }, refs: { sourceChanges: added },
      }, { client });
    });
    counters.sourceChanged += 1;
    await answer(row, { kind: "source_change", changes: added });
  }

  // ----- what a changed source reaches besides cards -------------------------------------------------------------------

  /**
   * The two readers of the feed nothing polled until now: the result impact path and the memory labels. For a page of the feed,
   * the accounts whose result versions cite a changed DOI are reconciled (`reconcileSince`) and the accounts with a memory that names
   * it are labelled (`labelSince`), each through the module that owns the rule; a bounded number of accounts per tick, the position
   * kept until every account of a page was asked.
   * @returns {Promise<number>} accounts reconciled
   */
  async function downstreamTick() {
    if (!sourceChanges || (!resultImpacts && !knowledgeChange)) return 0;
    const state = await lease("downstream");
    if (!state) return 0;
    let done = 0;
    /** @type {{ cursor?: number, payload?: any }} */
    let next = {};
    try {
      const page = await sourceChanges.changedSince(state.cursor, L.downstreamPage);
      counters.downstreamPages += 1;
      const dois = [...new Set(page.items.filter((fact) => fact.state === "changed").map((fact) => doiOfSourceIdentifier(fact.identifier)).filter(Boolean))];
      /** @type {Array<{ userId: string, projectId: string | null }>} */
      let accounts = [];
      if (dois.length) {
        const results = resultImpacts ? (await database.query(
          `SELECT DISTINCT user_id,project_id FROM evimed_product.documents d WHERE kind='result-version' AND deleted_at IS NULL AND project_id IS NOT NULL
             AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload->'inputs')='array' THEN d.payload->'inputs' ELSE '[]'::jsonb END) i
               JOIN unnest($1::text[]) doi ON right(lower(i->>'id'),length(doi))=doi) ORDER BY user_id,project_id`, [dois])).rows : [];
        const memories = knowledgeChange ? (await database.query(
          `SELECT DISTINCT user_id FROM evimed_memory.record_sources WHERE source_type='doi' AND source_id=ANY($1::text[]) ORDER BY user_id`, [dois]).catch(() => ({ rows: [] }))).rows : [];
        accounts = [...results.map((row) => ({ userId: row.user_id, projectId: row.project_id })),
          ...memories.filter((row) => !results.some((result) => result.user_id === row.user_id)).map((row) => ({ userId: row.user_id, projectId: null }))];
      }
      const start = Number(state.payload?.offset) || 0;
      for (const account of accounts.slice(start, start + L.downstreamAccounts)) {
        try {
          if (resultImpacts && account.projectId) await resultImpacts.reconcileSince(account.userId, { projectId: account.projectId, since: state.cursor, limit: L.downstreamPage });
          if (knowledgeChange) await knowledgeChange.labelSince(account.userId, account.projectId ?? "-", { since: state.cursor, limit: L.downstreamPage });
          done += 1;
        } catch (error) { counters.downstreamFailures += 1; failed("downstream", error); }
      }
      counters.downstreamAccounts += done;
      next = start + L.downstreamAccounts >= accounts.length ? { cursor: page.cursor, payload: {} } : { payload: { offset: start + L.downstreamAccounts } };
      return done;
    } finally { await release("downstream", next); }
  }

  // ----- the editor's side ---------------------------------------------------------------------------------------------

  /**
   * An upkeep job of the editor ended (`outcome`: `revised` — the card was rewritten and reviewed; `not_relevant` — the editor
   * judged the new items did not bear on it; `paused` — a source's publication status stopped the rewrite; `unchanged` — nothing to
   * rewrite). The items it was given are handled; a revised card is `current` again with an entry that says whether its conclusion
   * moved; its zone's followers are told.
   * @param {{ cardId: string, upkeep: any, outcome: 'revised' | 'not_relevant' | 'paused' | 'unchanged' }} input
   */
  async function afterFollowUp({ cardId, upkeep, outcome }) {
    if (!upkeep || upkeep.kind !== "new_evidence") return;
    const row = (await database.query(`SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.id=$1`, [cardId])).rows[0];
    if (!row) return;
    const itemIds = Array.isArray(upkeep.itemIds) ? upkeep.itemIds : [];
    const detail = row.currency_detail ?? {};
    const pending = (Array.isArray(detail.pending) ? detail.pending : []).filter((/** @type {PendingItem} */ item) => !itemIds.includes(item.itemId));
    const handled = [...new Set([...(Array.isArray(detail.handled) ? detail.handled : []), ...itemIds])].slice(-L.handledItems);
    const changes = Array.isArray(detail.changes) ? detail.changes : [];
    const label = currencyLabel({ changes, hasNewEvidence: pending.length > 0, retired: Boolean(row.retired_at) });
    const sameWork = (Array.isArray(detail.pending) ? detail.pending : []).some((/** @type {PendingItem} */ item) => itemIds.includes(item.itemId) && item.kind === "same_work");
    let before = null;
    if (outcome === "revised" && Number.isSafeInteger(upkeep.beforeRevision))
      before = (await database.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 AND revision=$2", [cardId, upkeep.beforeRevision])).rows[0]?.snapshot ?? null;
    const after = outcome === "revised" ? (await database.query("SELECT title,summary,content,claims FROM evimed_frontier.evidence_cards WHERE id=$1", [cardId])).rows[0] : null;
    await database.transaction(async (/** @type {any} */ client) => {
      await client.query(
        `UPDATE evimed_frontier.evidence_cards SET currency=$2,pending_item_ids=$3,currency_detail=$4::jsonb,last_checked_at=$5,
           no_change_checks=CASE WHEN $6 THEN no_change_checks+1 ELSE 0 END,no_change_since=CASE WHEN $6 THEN coalesce(no_change_since,$5) ELSE NULL END WHERE id=$1`,
        [cardId, label, pending.map((/** @type {PendingItem} */ item) => item.itemId), JSON.stringify({ ...detail, pending, handled }), now(), outcome === "not_relevant" || outcome === "unchanged"],
      );
      if (outcome === "revised") {
        const changed = before && after ? evidenceConclusionChanged(before, after) : false;
        await changeLog.append({
          zoneId: row.zone_id, cardId, category: changed ? "new_evidence_conclusion_changed" : "new_evidence_conclusion_unchanged", trigger: "new_evidence",
          revisionBefore: upkeep.beforeRevision ?? null, revisionAfter: row.revision, facts: { itemCount: itemIds.length, sameWork }, refs: { frontierItemIds: itemIds },
        }, { client });
      }
    });
    if (outcome === "revised") {
      counters.followUpsDone += 1;
      if (notifyZoneFollowers) await notifyZoneFollowers({ zoneId: row.zone_id, cardId, revision: row.revision, kind: "updated" }).catch((error) => failed("followers", error));
    } else if (outcome === "not_relevant" || outcome === "unchanged") {
      // The editor looked and the card stands: a quiet check, in the log's words and in the retirement rule's count.
      counters.notRelevant += 1;
      await afterQuietCheck({ ...row, currency: label, last_checked_at: now(), no_change_checks: row.no_change_checks + 1, no_change_since: row.no_change_since ?? now() }, cardUpkeepRoute(row));
    }
  }

  /**
   * A published card got a new revision from someone other than the editor: its producer's own edit (or the programme's), which is
   * an entry of the public log. An edit made while new studies were pending is the producer's answer to them; it names them and
   * says whether the conclusion moved.
   * @param {{ origin: string, zoneId: string, cardId: string, revision: number, state?: string }} event
   */
  async function onCardRevision({ origin, zoneId, cardId, revision, state = "published" }) {
    if (origin === "model" || state !== "published" || revision < 2) return;
    const previous = (await database.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 AND revision=$2", [cardId, revision - 1])).rows[0]?.snapshot;
    // The edit that published a draft is a publication; the log records changes to a card readers could already see.
    if (!previous || previous.state !== "published") return;
    const row = (await database.query(`SELECT ${CARD_COLUMNS},c.content,c.claims,c.summary FROM ${CARD_FROM} WHERE c.id=$1`, [cardId])).rows[0];
    if (!row || row.withdrawn) return;
    const detail = row.currency_detail ?? {};
    const pending = Array.isArray(detail.pending) ? detail.pending : [];
    const changed = evidenceConclusionChanged(previous, row);
    const answered = pending.length > 0;
    const handled = [...new Set([...(Array.isArray(detail.handled) ? detail.handled : []), ...pending.map((/** @type {PendingItem} */ item) => item.itemId)])].slice(-L.handledItems);
    const label = currencyLabel({ changes: detail.changes ?? [], hasNewEvidence: false, retired: Boolean(row.retired_at) });
    await database.transaction(async (/** @type {any} */ client) => {
      if (answered) await client.query("UPDATE evimed_frontier.evidence_cards SET currency=$2,pending_item_ids='{}',currency_detail=$3::jsonb WHERE id=$1",
        [cardId, label, JSON.stringify({ ...detail, pending: [], handled })]);
      await changeLog.append({
        zoneId, cardId, trigger: "producer_edit", category: answered ? (changed ? "new_evidence_conclusion_changed" : "new_evidence_conclusion_unchanged") : "correction",
        revisionBefore: revision - 1, revisionAfter: revision, facts: { itemCount: pending.length }, refs: { frontierItemIds: pending.map((/** @type {PendingItem} */ item) => item.itemId) },
      }, { client });
    });
    counters.producerEdits += 1;
    if (notifyZoneFollowers) await notifyZoneFollowers({ zoneId, cardId, revision, kind: "updated" }).catch((error) => failed("followers", error));
  }

  // ----- the owner's own words about their card ---------------------------------------------------------------------

  /**
   * What a producer may say about a card of theirs: that it is no longer updated, that it is updated again, or that they have read
   * the new studies and the card stands.
   * @param {{ id: string }} user @param {string} cardId @param {{ action: string, reason?: string }} input
   */
  async function setUpkeep(user, cardId, input) {
    if (!input || typeof input !== "object" || !["retire", "reopen", "reviewed"].includes(input.action)) throw new HttpError(400, "evidence_upkeep_action_invalid", "Unknown upkeep action.");
    await migrateEvidenceZones(database);
    const row = (await database.query(`SELECT ${CARD_COLUMNS} FROM ${CARD_FROM} WHERE c.id=$1 AND c.state='published'`, [cardId])).rows[0];
    if (!row || (row.user_id !== user.id && !(officialZoneRow(row) && isOperator(user.id)))) throw new HttpError(404, "evidence_not_found", "No such visible evidence content.");
    if (row.withdrawn) throw new HttpError(409, "evidence_card_withdrawn", "The card is withdrawn.");
    if (input.action === "retire") {
      await retireCard(row, { by: "producer" });
    } else if (input.action === "reopen") {
      const detail = row.currency_detail ?? {};
      const label = currencyLabel({ changes: detail.changes ?? [], hasNewEvidence: (row.pending_item_ids ?? []).length > 0, retired: false });
      await database.query("UPDATE evimed_frontier.evidence_cards SET retired_at=NULL,currency=$2,no_change_checks=0,no_change_since=NULL,last_checked_at=NULL WHERE id=$1", [cardId, label]);
      counters.reopened += 1;
    } else {
      const pending = Array.isArray(row.currency_detail?.pending) ? row.currency_detail.pending : [];
      if (!pending.length) throw new HttpError(409, "evidence_upkeep_action_invalid", "There are no new studies waiting on this card.");
      const handled = [...new Set([...(row.currency_detail?.handled ?? []), ...pending.map((/** @type {PendingItem} */ item) => item.itemId)])].slice(-L.handledItems);
      const label = currencyLabel({ changes: row.currency_detail?.changes ?? [], hasNewEvidence: false, retired: Boolean(row.retired_at) });
      await database.transaction(async (/** @type {any} */ client) => {
        await client.query("UPDATE evimed_frontier.evidence_cards SET currency=$2,pending_item_ids='{}',currency_detail=$3::jsonb,last_checked_at=$4 WHERE id=$1",
          [cardId, label, JSON.stringify({ ...row.currency_detail, pending: [], handled }), now()]);
        await changeLog.append({
          zoneId: row.zone_id, cardId, category: "new_evidence_conclusion_unchanged", trigger: "producer_edit", revisionBefore: row.revision, revisionAfter: row.revision,
          facts: { itemCount: pending.length, reviewed: true }, refs: { frontierItemIds: pending.map((/** @type {PendingItem} */ item) => item.itemId) },
        }, { client });
      });
    }
    const updated = (await database.query(`SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1`, [cardId])).rows[0];
    return evidenceCurrencyView(updated);
  }

  return {
    watchTick, sourcePollTick, downstreamTick, afterFollowUp, onCardRevision, setUpkeep, retireCard,
    staleOfficialCards: (/** @type {{ limit?: number }} */ options = {}) => staleOfficialCards(database, options),
    stats: () => ({ ...counters }),
  };
}

/**
 * The upkeep's counters for the operator's metrics endpoint (principle 15: every limit and every loop is countable).
 * @param {ReturnType<ReturnType<typeof createEvidenceUpkeep>["stats"]> | null | undefined} stats
 */
export function evidenceUpkeepMetricFamilies(stats) {
  if (!stats) return [];
  /** @param {string} name @param {string} help @param {Array<[Record<string, string> | undefined, number]>} series */
  const counter = (name, help, series) => ({ name: `open_science_evidence_upkeep_${name}`, help, type: /** @type {const} */ ("counter"), series: series.map(([labels, value]) => ({ value, ...(labels ? { labels } : {}) })) });
  return [
    counter("cards_checked_total", "Published evidence cards the watch checked (keys, source changes and new frontier items), and the checks that failed.",
      [[{ outcome: "checked" }, stats.watched], [{ outcome: "failed" }, stats.watchFailures]]),
    counter("labelled_total", "Cards labelled by what bears on them: new evidence (and, of those, items naming a study the card cites), a changed source, a card re-opened, a card retired.",
      [[{ label: "new_evidence" }, stats.newEvidence], [{ label: "same_work" }, stats.sameWork], [{ label: "source_changed" }, stats.sourceChanged],
        [{ label: "reopened" }, stats.reopened], [{ label: "retired" }, stats.retired], [{ label: "searched_no_change" }, stats.noChange]]),
    counter("answers_total", "What was done about a labelled card, by who answers for it: a follow-up queued for the editor, an official card held for the topic programme, a notice sent to its producer, a follow-up finished, new items the editor judged not to bear on the card.",
      [[{ answer: "editor_queued" }, stats.followUpsQueued], [{ answer: "programme_held" }, stats.programmeHeld], [{ answer: "notice_sent" }, stats.noticesSent],
        [{ answer: "notice_skipped" }, stats.noticesSkipped], [{ answer: "notice_failed" }, stats.noticeFailures], [{ answer: "follow_up_done" }, stats.followUpsDone],
        [{ answer: "not_relevant" }, stats.notRelevant], [{ answer: "producer_edit_logged" }, stats.producerEdits]]),
    counter("source_feed_total", "Source-change feed pages read for cards, cards marked from them, and card source keys refreshed.",
      [[{ what: "pages" }, stats.sourcePolls], [{ what: "cards_marked" }, stats.sourceCardsMarked], [{ what: "keys_refreshed" }, stats.sourceKeysRefreshed]]),
    counter("downstream_total", "Pages of the source-change feed handed to the result impact and memory-label readers, accounts they were asked about, and the asks that failed.",
      [[{ what: "pages" }, stats.downstreamPages], [{ what: "accounts" }, stats.downstreamAccounts], [{ what: "failures" }, stats.downstreamFailures]]),
  ];
}
