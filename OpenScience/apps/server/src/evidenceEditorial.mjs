import { randomUUID } from "node:crypto";
import { BALANCE_REFUSAL_CODES, FRONTIER_SOURCE_TYPES, PLATFORM_PUBLISHER_USER_ID, canonicalSourceIdentifier } from "@evimed/domain";
import { identifierKeys } from "@evimed/domain/entity-keys";
import { HttpError } from "./security.mjs";
import { frontierItemsMatching } from "./entityVocabulary.mjs";
import { zoneMatchKeys } from "./evidenceCurrency.mjs";
import {
  evidenceHash,
  evidenceContentHash,
  evidenceSourceFingerprint,
  evidencePublicationStatus,
} from "./evidenceCardContent.mjs";
import { retainedSource } from "./evidenceSourceReader.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";
import { frontierProviderUnavailable, FRONTIER_PROVIDER_RETRY_MS, FRONTIER_PROVIDER_REFUSED_WAIT_MS } from "./frontierPipeline.mjs";

const codeOf = (/** @type {any} */ e) =>
  /^[a-z0-9_]{2,100}$/.test(e?.code ?? "")
    ? e.code
    : "evidence_editorial_failed";
const retainedSourceErrors = new Set([
  "web_read_robots_disallowed", "web_read_unreadable", "web_read_needs_browser",
  "web_read_timeout", "web_read_upstream_unavailable", "web_read_not_found",
  "web_read_login_required", "web_read_upstream_error", "evidence_source_unavailable",
  "evidence_abstract_unavailable", "evidence_source_empty",
  "evidence_source_truncated", "evidence_publication_status_unavailable",
]);
const author = (/** @type {any} */ editor) => ({
  kind: "ai",
  name: "EviMed 证据编辑 AI",
  model: editor.model,
});
const reviewer = (/** @type {any} */ editor) => ({
  kind: "ai",
  name: "EviMed 证据核对 AI",
  model: editor.model,
});
/**
 * Whose money keeps a zone current (evidence-flywheel plan §3.3, B6, 2026-10-05).
 *
 * Hidden knowledge: until 2026-10-05 `automation()` checked that the caller owned the zone and nothing about
 * who they were, so any account in the frontier audience could make a zone, switch on "automatic updates", and
 * have the AI write and review its cards on the platform's frontier budget (10 yuan a day, shared with the
 * feed). The platform's money keeps its own zones current: an **official** zone — one the publisher account
 * owns, or one marked `kind = 'official'` — keeps running on that budget exactly as before. Every other
 * zone is its owner's: the model calls are booked to the owner's own account and project under the purpose
 * `evidence-upkeep`, counted against the owner's own caps, and charged to them through the research allowance
 * like a run's calls. A job whose owner has no allowance is set aside, not run, with a reason the owner reads
 * on the zone's update settings; nothing is ever paid by the platform in their place.
 * @param {any} zone an `evidence_zones` row
 */
export function isOfficialZone(zone) {
  return zone?.kind === "official" || zone?.user_id === PLATFORM_PUBLISHER_USER_ID;
}

/** The reasons an upkeep job waits, in the owner's words, rather than fails: no allowance, or the owner's own cap. */
const UPKEEP_DEFERRALS = Object.freeze(["evidence_upkeep_no_allowance", "usage_budget_exceeded"]);
/** How long a job set aside for an allowance or a cap waits before it is asked again. */
const UPKEEP_DEFERRAL_MS = 3_600_000;

/** Durable, bounded editorial work; one tick checks or produces one card. */
export class EvidenceEditorial {
  /**
   * `credits` and `ensureProject` bill an account's own zone to the account (`isOfficialZone`): `credits` is
   * the research allowance (`EvimedCreditsService`; null where billing is off, and then attribution and the
   * account's caps still apply), `ensureProject(userId)` is the account's `evimed-evidence` project the
   * usage ledger books to. `isOperator` lets an operator manage an official zone, whose owner cannot sign in.
   *
   * `sourceChanges` is the one record of what was published about a work (`sourceChanges.mjs`): what Europe PMC says of a source is
   * written to it as the editor reads it. `upkeep` (`evidenceCurrency.mjs`) and `challenges` (`evidenceChallenges.mjs`) are the loops that
   * keep a card current and answer a reader's challenge; the editor ticks them with its own tick and tells `upkeep` when one of its
   * follow-up jobs ended. `matchItems` finds the frontier items that share keys with a zone (default: `frontierItemsMatching`).
   * All four are absent until `useUpkeep`, and absent they do nothing.
   * @param {{database:any,service:any,editor:any,budget?:any,readSource:any,canRun?:()=>boolean,now?:()=>Date,workerId?:string,
   *   credits?:any,ensureProject?:((userId:string)=>Promise<{userId:string,projectId:string}>)|null,isOperator?:(userId:string)=>boolean,
   *   deferralMs?:number,sourceChanges?:any,upkeep?:any,challenges?:any,matchItems?:((query:any)=>Promise<any[]>)|null}} dependencies
   */
  constructor({
    database,
    service,
    editor,
    budget = null,
    readSource,
    canRun = () => true,
    now = () => new Date(),
    workerId = randomUUID(),
    credits = null,
    ensureProject = null,
    isOperator = () => false,
    deferralMs = UPKEEP_DEFERRAL_MS,
    sourceChanges = null,
    upkeep = null,
    challenges = null,
    matchItems = null,
  }) {
    this.database = database;
    this.service = service;
    this.editor = editor;
    this.budget = budget;
    this.readSource = readSource;
    this.canRun = canRun;
    this.now = now;
    this.workerId = workerId;
    this.credits = credits;
    this.ensureProject = ensureProject;
    this.isOperator = isOperator;
    this.deferralMs = deferralMs;
    this.sourceChanges = sourceChanges;
    this.upkeepLoops = upkeep;
    this.challenges = challenges;
    this.matchItems = matchItems ?? ((/** @type {any} */ query) => frontierItemsMatching(this.database, query));
    /** When each upkeep loop is next due (ms since epoch), so a tick that comes every few seconds asks each only as often as it needs. @type {Record<string, number>} */
    this.nextUpkeepAt = {};
    this.running = false;
    this.lastError = null;
    this.lastRunAt = null;
    this.providerPausedUntil = 0;
    /** The upkeep the running job is billed as, or null (one job at a time: `running`). @type {any} */
    this.upkeep = null;
    this.counters = {
      checked: 0,
      unchanged: 0,
      published: 0,
      reviewed: 0,
      skipped: 0,
      failed: 0,
      conflicts: 0,
      // Upkeep billing (principle 15): jobs run on the platform's budget (official zones) or on the owner's account,
      // jobs set aside for an allowance or a cap, and settlements the research allowance did or did not make.
      officialJobs: 0,
      ownerJobs: 0,
      deferredNoAllowance: 0,
      deferredCap: 0,
      charged: 0,
      waived: 0,
      chargeFailed: 0,
      // Discovery (F13): zones whose candidates came from shared keys, and zones with no keys at all that fell back to the owner's query.
      discoveryByKeys: 0,
      discoveryByQuery: 0,
      // What Europe PMC said of a source, written to the one source-change record, and the writes that failed.
      statusRecorded: 0,
      statusRecordFailed: 0,
      upkeepStepFailures: 0,
    };
  }

  /**
   * Late binding of the loops that keep a card current and answer a challenge: they are composed after the feed (`server.mjs`), and a
   * worker built without them is exactly the editor it was.
   * @param {{ sourceChanges?: any, upkeep?: any, challenges?: any }} loops
   */
  useUpkeep({ sourceChanges, upkeep, challenges }) {
    if (sourceChanges !== undefined) this.sourceChanges = sourceChanges;
    if (upkeep !== undefined) this.upkeepLoops = upkeep;
    if (challenges !== undefined) this.challenges = challenges;
  }

  /**
   * What Europe PMC said of a source as the editor read it, written through the one record every module reads (B5). A clear status is
   * an answered check with nothing found, a missing one nothing at all (`recordPublicationStatus`); a work with no identifier of the
   * kinds the record holds is not recorded, and a write that fails is counted, never thrown: the editor's own card carries the status either way.
   * @param {string} url @param {any} result what `readSource` returned
   */
  async noteStatus(url, result) {
    if (!this.sourceChanges || result?.publicationStatus === undefined) return;
    const identifier = canonicalSourceIdentifier(url);
    if (!identifier) return;
    try {
      await this.sourceChanges.recordPublicationStatus(identifier, result.publicationStatus);
      this.counters.statusRecorded++;
    } catch (error) {
      this.counters.statusRecordFailed++;
      this.sourceChanges.failed?.(codeOf(error));
    }
  }

  /**
   * Late binding of the research allowance: it is composed after the feed (`server.mjs`), and a worker
   * built without it still attributes and caps an account's upkeep.
   * @param {{ credits?: any, ensureProject?: ((userId: string) => Promise<{ userId: string, projectId: string }>) | null }} billing
   */
  useBilling({ credits, ensureProject }) {
    if (credits !== undefined) this.credits = credits;
    if (ensureProject !== undefined) this.ensureProject = ensureProject;
  }

  /** Whether `user` may manage this zone's updates: its owner, or an operator for an official zone (whose owner is nobody).
   *  @param {any} user @param {any} zone */
  canManage(user, zone) {
    return zone.user_id === user.id || (isOfficialZone(zone) && this.isOperator(user.id) === true);
  }
  /** @param {any} user @param {string} zoneId @param {any} body @param {string} method */
  async automation(user, zoneId, body = {}, method = "GET") {
    if (
      method !== "GET" &&
      (!body || typeof body !== "object" || Array.isArray(body))
    )
      throw new HttpError(
        400,
        "evidence_invalid",
        "Invalid evidence automation request.",
      );
    await migrateEvidenceZones(this.database);
    let official = false;
    await this.database.transaction(async (/** @type {any} */ client) => {
      const rewriteRequest = method === "POST" && Object.keys(body).length > 0;
      const zone = await this.service.zoneRow(client, user, zoneId, !rewriteRequest);
      official = isOfficialZone(zone);
      if (!this.canManage(user, zone))
        throw new HttpError(
          403,
          "evidence_owner_required",
          "Only the zone owner may manage evidence updates.",
        );
      if (method === "PUT") {
        if (body.expectedRevision !== zone.revision)
          throw new HttpError(
            409,
            "evidence_revision_conflict",
            "The zone changed; reload before saving.",
          );
        if (
          Object.keys(body).some(
            (k) =>
              ![
                "enabled",
                "query",
                "sourceTypes",
                "intervalHours",
                "maxCardsPerRun",
                "expectedRevision",
              ].includes(k),
          ) ||
          typeof body.enabled !== "boolean" ||
          typeof body.query !== "string" ||
          body.query.trim().length < 2 ||
          body.query.length > 200 ||
          !Array.isArray(body.sourceTypes) ||
          !body.sourceTypes.length ||
          body.sourceTypes.some((t) => !FRONTIER_SOURCE_TYPES.includes(t)) ||
          !Number.isSafeInteger(body.intervalHours) ||
          body.intervalHours < 1 ||
          body.intervalHours > 720 ||
          !Number.isSafeInteger(body.maxCardsPerRun) ||
          body.maxCardsPerRun < 1 ||
          body.maxCardsPerRun > 10
        )
          throw new HttpError(
            400,
            "evidence_invalid",
            "Invalid evidence update settings.",
          );
        // A product zone is written by its producer alone (`evidenceWriteAllowed`: the editor's origin `model` is not one of its origins), so
        // switching the editor on there would only make every job fail at its first write. The producer is told of new evidence instead.
        if (body.enabled === true && zone.kind === "product")
          throw new HttpError(409, "evidence_automation_product_zone", "A product zone's cards are written by its producer; the platform tells the producer about new evidence instead.");
        await client.query(
          `INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query,source_types,interval_hours,max_cards_per_run)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(zone_id) DO UPDATE SET enabled=$2,query=$3,source_types=$4,interval_hours=$5,max_cards_per_run=$6,next_run_at=clock_timestamp(),updated_at=clock_timestamp()`,
          [
            zoneId,
            body.enabled,
            body.query.trim(),
            body.sourceTypes,
            body.intervalHours,
            body.maxCardsPerRun,
          ],
        );
      } else if (method === "POST") {
        if (rewriteRequest) {
          if (Object.keys(body).some(key=>!["cardId","expectedRevision"].includes(key)) ||
              typeof body.cardId !== "string" || !body.cardId || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1)
            throw new HttpError(400,"evidence_invalid","A card rewrite requires its id and current revision.");
          // Match internal save's job -> zone -> card lock order. A running job
          // cannot be replaced by an owner request while its save holds these locks.
          let jobs = (await client.query(`SELECT * FROM evimed_frontier.evidence_editorial_jobs
            WHERE zone_id=$1 AND card_id=$2 ORDER BY updated_at DESC,id FOR UPDATE`,[zoneId,body.cardId])).rows;
          if (!jobs.length) {
            const existing = await this.service.cardRow(client,user,zoneId,body.cardId);
            const identityKey = `card:${existing.id}`;
            // Resolve a first-schedule race before taking the zone/card locks:
            // an internal save may already hold the conflicting job's lock.
            await client.query(`INSERT INTO evimed_frontier.evidence_editorial_jobs(id,zone_id,identity_key,card_id,source_item_id,source_url,source_title,payload)
              VALUES($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb) ON CONFLICT(zone_id,identity_key) DO NOTHING`,[
              `ej_${evidenceHash([zoneId,identityKey]).slice(0,32)}`,zoneId,identityKey,existing.id,existing.source_item_id,existing.sources[0]?.url??null,existing.sources[0]?.title??null,
            ]);
            jobs = (await client.query(`SELECT * FROM evimed_frontier.evidence_editorial_jobs
              WHERE zone_id=$1 AND card_id=$2 ORDER BY updated_at DESC,id FOR UPDATE`,[zoneId,body.cardId])).rows;
          }
          if (jobs.some(job=>job.state==="running")) throw new HttpError(409,"evidence_revision_conflict","This card already has an active editorial job.");
          const currentZone = await this.service.zoneRow(client,user,zoneId,true);
          const current = await this.service.cardRow(client,user,zoneId,body.cardId,true);
          if (currentZone.state !== "published" || current.state !== "published" || current.user_id !== currentZone.user_id || current.revision !== body.expectedRevision ||
              current.editorial?.author?.kind !== "ai" || !current.editorial?.contentHash ||
              current.editorial.automationContentHash !== current.editorial.contentHash || evidenceContentHash(current) !== current.editorial.contentHash)
            throw new HttpError(409,"evidence_revision_conflict","Only the current published AI-managed card may be rewritten.");
          const enabled = await client.query("SELECT zone_id FROM evimed_frontier.evidence_automation WHERE zone_id=$1 AND enabled",[zoneId]);
          if (!enabled.rowCount) throw new HttpError(409,"evidence_automation_disabled","Enable evidence updates before rewriting.");
          const payload = {managedRevision:current.revision,rewriteRevision:current.revision};
          await client.query(`UPDATE evimed_frontier.evidence_editorial_jobs
              SET state='pending',attempts=0,available_at=clock_timestamp(),last_error=NULL,lease_owner=NULL,lease_until=NULL,
                payload=COALESCE(payload,'{}'::jsonb)||$2::jsonb,updated_at=clock_timestamp() WHERE id=$1`,[jobs[0].id,JSON.stringify(payload)]);
          return;
        }
        const result = await client.query(
          "UPDATE evimed_frontier.evidence_automation SET next_run_at=clock_timestamp() WHERE zone_id=$1 AND enabled RETURNING zone_id",
          [zoneId],
        );
        if (!result.rowCount)
          throw new HttpError(
            409,
            "evidence_automation_disabled",
            "Enable evidence updates before refreshing.",
          );
        await client.query(
          "UPDATE evimed_frontier.evidence_editorial_jobs SET state='pending',attempts=0,available_at=clock_timestamp(),last_error=NULL WHERE zone_id=$1 AND state IN ('failed','conflict')",
          [zoneId],
        );
        await client.query(
          `WITH skipped AS(SELECT j.id FROM evimed_frontier.evidence_editorial_jobs j
          JOIN evimed_frontier.evidence_automation a ON a.zone_id=j.zone_id
          WHERE j.zone_id=$1 AND j.state='completed' AND j.card_id IS NULL AND j.payload->>'decision'='skip'
          ORDER BY j.updated_at,j.id LIMIT(SELECT max_cards_per_run FROM evimed_frontier.evidence_automation WHERE zone_id=$1)
          FOR UPDATE OF j SKIP LOCKED)
          UPDATE evimed_frontier.evidence_editorial_jobs j SET state='pending',attempts=0,available_at=clock_timestamp(),last_error=NULL
          FROM skipped WHERE j.id=skipped.id`,
          [zoneId],
        );
      }
    });
    const row = (
      await this.database.query(
        "SELECT * FROM evimed_frontier.evidence_automation WHERE zone_id=$1",
        [zoneId],
      )
    ).rows[0];
    const counts = (
      await this.database.query(
        "SELECT state,count(*)::integer AS n FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 GROUP BY state",
        [zoneId],
      )
    ).rows;
    const recent = (
      await this.database.query(
        `SELECT id,state,attempts,last_error AS "lastError",updated_at AS "updatedAt",card_id AS "cardId",payload->>'skipReason' AS "skipReason",payload->>'sourceCheckStatus' AS "sourceCheckStatus" FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 ORDER BY updated_at DESC LIMIT 10`,
        [zoneId],
      )
    ).rows;
    return {
      // Who pays for keeping this zone current, said where the owner switches it on (B6): the platform's
      // frontier budget for an official zone, the owner's own allowance and caps for every other.
      billing: official
        ? { payer: "platform", official: true, purpose: "frontier" }
        : { payer: "owner", official: false, purpose: "evidence-upkeep" },
      automation: row
        ? {
            enabled: row.enabled,
            query: row.query,
            sourceTypes: row.source_types,
            intervalHours: row.interval_hours,
            maxCardsPerRun: row.max_cards_per_run,
            nextRunAt: row.next_run_at,
            lastRunAt: row.last_run_at,
            lastError: row.last_error,
          }
        : {
            enabled: false,
            query: "",
            sourceTypes: ["journal", "regulator", "evidence-body"],
            intervalHours: 24,
            maxCardsPerRun: 2,
            nextRunAt: null,
            lastRunAt: null,
            lastError: null,
          },
      jobs: {
        pending: 0,
        running: 0,
        failed: 0,
        ...Object.fromEntries(counts.map((r) => [r.state, r.n])),
      },
      recent,
    };
  }
  /**
   * The frontier items a zone has not yet been asked about, found by what they share with it (F13, 2026-10-05). Until then an item was a
   * candidate when the zone's query was a substring of its title or summary, which finds a drug under its brand name's translation only by
   * luck. Now an item is a candidate when it carries an entity key of the zone — its own words resolved through the vocabulary, joined to the
   * entities of its cards — or names a study one of its cards cites (an identifier key: a correction, a new report of it, which the editor
   * maps onto that card). An item that is itself a cited source is the card's own and is left out.
   *
   * The owner's query stays what they wrote it for: it orders the candidates (an item that also carries their words first) and, for a zone
   * with no keys at all — nothing the vocabulary or a card can say it is about — it is the only thing left to match by, as it always was.
   * @param {any} client @param {any} settings the zone's `evidence_automation` row
   * @returns {Promise<Array<{public_id:string,identity_key:string,canonical_url:string,title_raw:string}>>}
   */
  async discover(client, settings) {
    const zone = (await client.query("SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1", [settings.zone_id])).rows[0];
    const keys = zone ? await zoneMatchKeys({ database: this.database, service: this.service, zone }) : { entityKeys: [], identifierKeys: [] };
    const unseen = `NOT EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j WHERE j.zone_id=$3 AND j.identity_key=i.identity_key
          AND NOT COALESCE(j.state='completed' AND j.card_id IS NULL AND j.payload->>'decision'='skip' AND j.available_at<=clock_timestamp(),false))`;
    if (!keys.entityKeys.length && !keys.identifierKeys.length) {
      this.counters.discoveryByQuery++;
      return (await client.query(
        `SELECT i.public_id,i.identity_key,i.canonical_url,i.title_raw FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
        WHERE i.state='published' AND s.enabled AND i.source_type=ANY($1::text[]) AND strpos(lower(concat_ws(' ',i.title_raw,i.title_zh,i.summary_zh)),lower($2))>0
        AND ${unseen}
        ORDER BY i.timeline_at DESC,i.id DESC LIMIT $4`,
        [settings.source_types, settings.query, settings.zone_id, settings.max_cards_per_run],
      )).rows;
    }
    this.counters.discoveryByKeys++;
    const matched = await this.matchItems({ entityKeys: keys.entityKeys, identifierKeys: keys.identifierKeys, limit: 50 });
    const cited = new Set(keys.identifierKeys.filter((key) => key.startsWith("doi:") || key.startsWith("pmid:")));
    const ids = matched.filter((item) => !identifierKeys({ doi: item.doi, pmid: item.pmid }).some((key) => cited.has(key))).map((item) => item.publicId);
    if (!ids.length) return [];
    const rows = (await client.query(
      `SELECT i.public_id,i.identity_key,i.canonical_url,i.title_raw,lower(concat_ws(' ',i.title_raw,i.title_zh,i.summary_zh)) AS words
        FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
        WHERE i.public_id=ANY($2::text[]) AND i.state='published' AND s.enabled AND i.source_type=ANY($1::text[]) AND ${unseen}`,
      [settings.source_types, ids, settings.zone_id],
    )).rows;
    const wording = String(settings.query ?? "").trim().toLowerCase();
    // Matched order (identifier matches, then the most keys shared, then the newest) is kept; the owner's wording only moves its items up.
    const rank = (/** @type {any} */ row) => ids.indexOf(row.public_id) - (wording && row.words.includes(wording) ? ids.length : 0);
    return rows.sort((left, right) => rank(left) - rank(right)).slice(0, settings.max_cards_per_run);
  }
  async schedule() {
    return this.database.transaction(async (/** @type {any} */ client) => {
      const settings = (
        await client.query(`SELECT a.* FROM evimed_frontier.evidence_automation a JOIN evimed_frontier.evidence_zones z ON z.id=a.zone_id
        WHERE a.enabled AND a.next_run_at<=clock_timestamp() AND z.state='published' AND z.kind<>'product' ORDER BY a.next_run_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED`)
      ).rows[0];
      if (!settings) return 0;
      // Maintenance rotates by oldest job attempt; discovery gets alternating first place. AI authorship and zone opt-in are both required.
      const cards = (
        await client.query(
          `SELECT c.*,j.identity_key AS editorial_identity FROM evimed_frontier.evidence_cards c LEFT JOIN LATERAL(SELECT identity_key,state,updated_at FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=c.id AND zone_id=c.zone_id ORDER BY updated_at DESC LIMIT 1) j ON true
        WHERE c.zone_id=$1 AND c.state='published' AND c.retired_at IS NULL AND c.withdrawn IS NULL AND c.editorial->'author'->>'kind'='ai' AND COALESCE(j.state,'completed') NOT IN ('conflict','failed')
        ORDER BY COALESCE(j.updated_at,(c.editorial->>'sourceCheckedAt')::timestamptz,'epoch'::timestamptz),c.id LIMIT $2`,
          [settings.zone_id, settings.max_cards_per_run],
        )
      ).rows;
      const candidates = await this.discover(client, settings);
      const maintained = cards.map((c) => ({
        identity_key: c.editorial_identity ?? `card:${c.id}`,
        card_id: c.id,
        card_revision: c.revision,
        public_id: c.source_item_id,
        canonical_url: c.sources[0]?.url,
        title_raw: c.sources[0]?.title,
      }));
      const selected = [];
      for (
        let index = 0;
        index < Math.max(maintained.length, candidates.length);
        index++
      ) {
        const pair = settings.discovery_turn
          ? [candidates[index], maintained[index]]
          : [maintained[index], candidates[index]];
        selected.push(...pair.filter(Boolean));
      }
      for (const entry of selected.slice(0, settings.max_cards_per_run)) {
        const id = `ej_${evidenceHash([settings.zone_id, entry.identity_key]).slice(0, 32)}`;
        await client.query(
          `INSERT INTO evimed_frontier.evidence_editorial_jobs(id,zone_id,identity_key,card_id,source_item_id,source_url,source_title,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(zone_id,identity_key) DO UPDATE SET state='pending',attempts=0,available_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE evidence_editorial_jobs.state='completed' AND (evidence_editorial_jobs.card_id IS NOT NULL
            OR (evidence_editorial_jobs.payload->>'decision'='skip' AND evidence_editorial_jobs.available_at<=clock_timestamp()))`,
          [
            id,
            settings.zone_id,
            entry.identity_key,
            entry.card_id ?? null,
            entry.public_id,
            entry.canonical_url,
            entry.title_raw,
            JSON.stringify(
              entry.card_id ? { managedRevision: entry.card_revision } : {},
            ),
          ],
        );
      }
      await client.query(
        "UPDATE evimed_frontier.evidence_automation SET discovery_turn=NOT discovery_turn,last_run_at=clock_timestamp(),next_run_at=clock_timestamp()+interval_hours*interval '1 hour',last_error=NULL WHERE zone_id=$1",
        [settings.zone_id],
      );
      return Math.min(selected.length, settings.max_cards_per_run);
    });
  }
  async claim() {
    const result = await this.database.query(
      `WITH candidate AS(SELECT j.id FROM evimed_frontier.evidence_editorial_jobs j JOIN evimed_frontier.evidence_automation a ON a.zone_id=j.zone_id
      WHERE a.enabled AND j.attempts<3 AND ((j.state='pending' AND j.available_at<=clock_timestamp()) OR (j.state='running' AND j.lease_until<clock_timestamp()))
        AND NOT EXISTS(SELECT 1 FROM evimed_frontier.evidence_zones pz WHERE pz.id=j.zone_id AND pz.kind='product')
      ORDER BY j.available_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
      UPDATE evimed_frontier.evidence_editorial_jobs j SET state='running',attempts=attempts+1,lease_owner=$1,lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
      [this.workerId],
    );
    return result.rows[0] ?? null;
  }
  /** @param {any} job @param {string} state @param {string|null} [lastError] */
  async finish(job, state, lastError = null) {
    const finished = await this.database.query(
      `UPDATE evimed_frontier.evidence_editorial_jobs SET state=$3,last_error=$4,lease_owner=NULL,lease_until=NULL,
      available_at=clock_timestamp()+CASE WHEN $3='completed' AND card_id IS NULL AND payload->>'decision'='skip'
        THEN interval '7 days' ELSE interval '5 minutes' END,
      updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp() RETURNING id`,
      [job.id, this.workerId, state, lastError],
    );
    if (!finished.rowCount) return;
    await this.database.query(
      "UPDATE evimed_frontier.evidence_automation SET last_error=$2 WHERE zone_id=$1",
      [job.zone_id, lastError],
    );
  }
  /**
   * Admit one model-using step. An official zone is the platform's: the feed's editor and its frontier budget,
   * exactly as before. Any other zone is its owner's: the provider must be configured, the owner must have an
   * allowance to pay with (`evidence_upkeep_no_allowance`), and the call is booked to the owner (`billingFor`);
   * the frontier budget is never consulted, so an account's zone can neither spend it nor be held by it.
   * @param {any} [upkeep] the running job's billing (`startUpkeep`)
   */
  async requireModel(upkeep = null) {
    if (upkeep && !upkeep.official) {
      if (!(this.editor.providerReady ?? this.editor.available))
        throw Object.assign(new Error("Evidence writing is waiting for its editor."), { code: "evidence_budget_wait" });
      await this.requireAllowance(upkeep);
      upkeep.billing ??= await this.billingFor(upkeep);
      upkeep.called = true;
      return;
    }
    const budget = this.budget ? await this.budget() : { state: "ok" };
    if (!this.editor.available || budget.state !== "ok")
      throw Object.assign(
        new Error("Evidence writing is waiting for its editor or budget."),
        { code: "evidence_budget_wait" },
      );
  }
  /**
   * The billing of one job execution: who pays and the scope its model calls are booked under. The scope is a
   * `run_id` the usage ledger and the research allowance can both sum (`vcrUsageScope.mjs` explains the
   * pattern): unique per execution, so a retried job settles each attempt on its own.
   * @param {any} zone @param {any} job
   */
  startUpkeep(zone, job) {
    const official = isOfficialZone(zone);
    this.counters[official ? "officialJobs" : "ownerJobs"] += 1;
    const startedAt = this.now().toISOString();
    this.upkeep = {
      official, ownerId: zone.user_id, zoneTitle: zone.title, startedAt, called: false, billing: null,
      scope: `evup_${evidenceHash([job.id, String(job.attempts), String(job.updated_at instanceof Date ? job.updated_at.toISOString() : job.updated_at), startedAt]).slice(0, 32)}`,
    };
    return this.upkeep;
  }
  /** Who the next call is booked to: the owner's own account and `evimed-evidence` project, purpose `evidence-upkeep`. @param {any} upkeep */
  async billingFor(upkeep) {
    // A deployment that cannot say whose project to book to cannot bill the owner, and the platform does not
    // pay instead: the job waits.
    if (typeof this.ensureProject !== "function")
      throw Object.assign(new Error("An account's zone upkeep cannot be attributed in this deployment."), { code: "evidence_budget_wait" });
    const project = await this.ensureProject(upkeep.ownerId);
    return { userId: project.userId, projectId: project.projectId, purpose: "evidence-upkeep", runId: upkeep.scope };
  }
  /**
   * Whether the owner can pay: the research allowance's own start check (a plain call, so it asks only that
   * something is left). Billing off or unreachable admits — attribution and the owner's caps still apply and
   * refusing work because accounting is down is the one outcome nobody can act on (`evimedCreditsService.mjs`).
   * @param {any} upkeep
   */
  async requireAllowance(upkeep) {
    if (!this.credits) return;
    try {
      await this.credits.assertBalanceForStart(upkeep.ownerId, null, { unattended: true });
    } catch (error) {
      if (BALANCE_REFUSAL_CODES.includes(/** @type {any} */ (error)?.code))
        throw Object.assign(new Error("The zone owner has no allowance to pay for this upkeep."), { code: "evidence_upkeep_no_allowance" });
      throw error;
    }
  }
  /**
   * Charge the owner for the model calls this execution made, the way a run's are charged: one settlement per
   * execution, keyed by its scope, through the research allowance (`settleRun` — idempotent, never throws). A
   * job that ended without a delivery is recorded and not charged, the rule a failed run follows. Nothing is
   * settled for an execution that made no call, and nothing at all for the platform's own zones.
   * @param {any} job @param {any} failure the error the job ended with, or null
   */
  async settleUpkeep(job, failure) {
    const upkeep = this.upkeep;
    this.upkeep = null;
    if (!upkeep || upkeep.official || !upkeep.billing || !upkeep.called || !this.credits) return;
    try {
      // An execution that made no call has nothing to charge, and a zero line on every no-op job is noise on a statement.
      const spent = await this.database.query(`SELECT 1 FROM evimed_usage.model_requests WHERE user_id=$1 AND run_id=$2 LIMIT 1`, [upkeep.ownerId, upkeep.scope]);
      if (!spent.rowCount) return;
      const account = (await this.database.query("SELECT created_at::text AS \"createdAt\" FROM evimed_control.users WHERE id=$1", [upkeep.ownerId])).rows[0];
      const result = await this.credits.settleRun({
        userId: upkeep.ownerId, projectId: upkeep.billing.projectId, runId: upkeep.scope, dispatchId: null,
        status: failure ? "failed" : "completed", errorCode: failure ? codeOf(failure) : null,
        accountCreatedAt: account?.createdAt ?? null, startedAt: upkeep.startedAt, finishedAt: this.now().toISOString(),
        capabilityId: null, statementLine: "证据专区更新", subject: upkeep.zoneTitle,
      });
      // `settled` with nothing taken is a recorded, waived line (a job that delivered nothing); a failed settlement is
      // visible in the usage ledger (the scope's rows stay unsettled) and in this counter.
      if (result?.status === "error") this.counters.chargeFailed++;
      else if (result?.status === "settled" || result?.status === "pending") this.counters[Number(result.credits) > 0 ? "charged" : "waived"]++;
    } catch {
      this.counters.chargeFailed++;
    }
  }
  /**
   * Set a job aside, not failed: its owner has no allowance or has reached their own cap. The job goes back to
   * pending a while later and the reason is on it and on the zone's update settings, where the owner reads it.
   * @param {any} job @param {string} code
   */
  async deferUpkeep(job, code) {
    const waiting = await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs
      SET state='pending',attempts=greatest(0,attempts-1),available_at=clock_timestamp()+$3*interval '1 millisecond',
        last_error=$4,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
    [job.id, this.workerId, this.deferralMs, code]);
    if (waiting.rowCount)
      await this.database.query("UPDATE evimed_frontier.evidence_automation SET last_error=$2 WHERE zone_id=$1", [job.zone_id, code]);
    this.counters[code === "evidence_upkeep_no_allowance" ? "deferredNoAllowance" : "deferredCap"]++;
  }
  /** Renew between bounded source/model calls; an expired lease is never revived. @param {any} job */
  async renew(job) {
    if (!this.canRun()) throw Object.assign(new Error("Maintenance active."), {code:"evidence_maintenance_active"});
    const held = await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs j
      SET lease_until=clock_timestamp()+interval '10 minutes'
      WHERE j.id=$1 AND j.lease_owner=$2 AND j.state='running' AND j.lease_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_automation a JOIN evimed_frontier.evidence_zones z ON z.id=a.zone_id
          WHERE a.zone_id=j.zone_id AND a.enabled AND z.state='published') RETURNING j.id`,[job.id,this.workerId]);
    if (!held.rowCount) throw new HttpError(409,"evidence_revision_conflict","The editorial lease or update settings changed; this worker has stopped.");
  }
  /** @param {any} job */
  async process(job) {
    await this.renew(job);
    const zone = (
      await this.database.query(
        "SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1",
        [job.zone_id],
      )
    ).rows[0];
    if (!zone || zone.state !== "published")
      throw new HttpError(
        409,
        "evidence_revision_conflict",
        "The researcher withdrew this zone; automatic writing has stopped.",
      );
    const user = { id: zone.user_id };
    const upkeep = this.startUpkeep(zone, job);
    // An account's own zone is paid for by its owner, so whether they can pay comes before anything that costs a network read (2026-10-06
    // review: the source was read first and the allowance asked at the model step, so an owner with no allowance had every source of the
    // zone re-read each time the job was set aside and came back). Official zones are the platform's and are not asked.
    if (!upkeep.official) await this.requireAllowance(upkeep);
    const roleAccounts = (
      await this.database.query(
        "SELECT id,name,auth_type FROM evimed_control.users WHERE id=ANY($1::text[])",
        [["evidence-editor-ai", "evidence-review-ai"]],
      )
    ).rows;
    const roleId = (/** @type {string} */ id) =>
      roleAccounts.find(
        (account) =>
          account.id === id &&
          account.auth_type === "local" &&
          /\bAI\b/i.test(account.name),
      )?.id;
    let reviewerActor = null;
    const requestId = `auto_${evidenceHash([zone.id, job.identity_key]).slice(0, 40)}`;
    const existingId =
      job.card_id ??
      `ec_${evidenceHash(`${user.id}:${requestId}`).slice(0, 32)}`;
    let card =
      (
        await this.database.query(
          "SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1",
          [existingId],
        )
      ).rows[0] ?? null;
    let prefetched = null;
    if (!card && job.source_url) {
      const targets = (
        await this.database.query(
          `SELECT id,title,summary,content FROM evimed_frontier.evidence_cards WHERE zone_id=$1 AND state='published'
        AND editorial->'author'->>'kind'='ai' AND editorial->>'automationContentHash'=editorial->>'contentHash' ORDER BY updated_at DESC LIMIT 20`,
          [zone.id],
        )
      ).rows;
      {
        if (!this.canRun())
          throw Object.assign(new Error("Maintenance active."), {
            code: "evidence_maintenance_active",
          });
        await this.renew(job);
        prefetched = await this.readSource(job.source_url, {
          signal: AbortSignal.timeout(90000),
        });
        await this.noteStatus(job.source_url, prefetched);
        await this.renew(job);
        if (prefetched.publicationStatus) {
          const skipped = await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs
            SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb
            WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp()`,
            [job.id,this.workerId,JSON.stringify({decision:"skip",skipReason:"原始文献存在撤稿、更正或关注声明，不能作为普通推荐依据。",publicationStatus:prefetched.publicationStatus})]);
          if (!skipped.rowCount) throw new HttpError(409,"evidence_revision_conflict","The publication-status check lost its editorial lease.");
          await this.finish(job,"completed");
          this.counters.skipped++;
          return;
        }
        if (!String(prefetched.text ?? "").trim())
          throw Object.assign(new Error("No readable source."), {
            code: "evidence_source_empty",
          });
        await this.requireModel(upkeep);
        await this.renew(job);
        const targetId = await this.editor.evidenceTarget({
          zone: zone.title,
          description: zone.description,
          background: zone.background,
          source: {
            title: job.source_title,
            url: job.source_url,
            coverage: prefetched.receipt?.truncated ? "excerpt" : prefetched.coverage ?? "excerpt",
            publicationStatus: prefetched.publicationStatus ?? null,
            inputTruncated: !!prefetched.receipt?.truncated || String(prefetched.text ?? "").length > 12000,
            text: String(prefetched.text ?? "").slice(0, 12000),
          },
          cards: targets,
        }, upkeep.billing);
        await this.renew(job);
        if (targetId?.skip === true) {
          const skipped = await this.database.query(
            `UPDATE evimed_frontier.evidence_editorial_jobs
            SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb,updated_at=clock_timestamp()
            WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
            [
              job.id,
              this.workerId,
              JSON.stringify({ decision: "skip", skipReason: targetId.reason }),
            ],
          );
          if (!skipped.rowCount)
            throw new HttpError(
              409,
              "evidence_revision_conflict",
              "The editorial lease changed; this worker has stopped.",
            );
          await this.finish(job, "completed");
          this.counters.skipped++;
          return;
        }
        const accepted = await this.database.query(
          `UPDATE evimed_frontier.evidence_editorial_jobs
          SET payload=COALESCE(payload,'{}'::jsonb)-'decision'-'skipReason'
          WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
          [job.id, this.workerId],
        );
        if (!accepted.rowCount)
          throw new HttpError(
            409,
            "evidence_revision_conflict",
            "The editorial lease changed; this worker has stopped.",
          );
        if (targetId)
          card = (
            await this.database.query(
              "SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1 AND zone_id=$2",
              [targetId, zone.id],
            )
          ).rows[0];
      }
    }
    if (card && card.state !== "published")
      throw new HttpError(
        409,
        "evidence_revision_conflict",
        "The researcher withdrew this card; automatic writing has stopped.",
      );
    reviewerActor = card?.editorial?.reviewer?.userId ?? null;
    const baseRevision = card?.revision ?? null;
    const rewriteRequested = !!card && job.payload?.rewriteRevision === baseRevision;
    if (
      card &&
      card.editorial?.automationContentHash !== card.editorial?.contentHash
    )
      throw new HttpError(
        409,
        "evidence_revision_conflict",
        "A researcher edited this card; automatic writing has stopped for it.",
      );
    if (
      card &&
      job.payload?.managedRevision != null &&
      job.payload.managedRevision !== card.revision
    )
      throw new HttpError(
        409,
        "evidence_revision_conflict",
        "A researcher edited this card; automatic writing has stopped for it.",
      );
    // A follow-up the platform queued because frontier items bear on this card (F13): the editor first judges whether the newest one does
    // bear on this card's question, the way it does for a discovered item (`evidenceTarget`), and only a source that does is taken in. An item
    // that does not is handled and the card is as current as it was; it is never added to the card's sources.
    const upkeepJob = job.payload?.upkeep ?? null;
    if (card && upkeepJob?.kind === "new_evidence" && job.source_url && !card.sources.some((/** @type {any} */ source) => source.url === job.source_url)) {
      await this.renew(job);
      prefetched = await this.readSource(job.source_url, { signal: AbortSignal.timeout(90000) });
      await this.noteStatus(job.source_url, prefetched);
      await this.renew(job);
      let relevant = false;
      if (!prefetched.publicationStatus) {
        if (!String(prefetched.text ?? "").trim())
          throw Object.assign(new Error("No readable source."), { code: "evidence_source_empty" });
        await this.requireModel(upkeep);
        await this.renew(job);
        const verdict = await this.editor.evidenceTarget({
          zone: zone.title, description: zone.description, background: zone.background,
          source: {
            title: job.source_title, url: job.source_url,
            coverage: prefetched.receipt?.truncated ? "excerpt" : prefetched.coverage ?? "excerpt",
            publicationStatus: null,
            inputTruncated: !!prefetched.receipt?.truncated || String(prefetched.text ?? "").length > 12000,
            text: String(prefetched.text ?? "").slice(0, 12000),
          },
          cards: [{ id: card.id, title: card.title, summary: card.summary, content: card.content }],
        }, upkeep.billing);
        await this.renew(job);
        relevant = verdict === card.id;
      }
      if (!relevant) {
        // The job goes back to the card's own first source, so a later rotation does not read the rejected one as an addition.
        await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs SET source_item_id=$3,source_url=$4,source_title=$5,
          payload=COALESCE(payload,'{}'::jsonb)||$6::jsonb WHERE id=$1 AND lease_owner=$2`,
          [job.id, this.workerId, card.source_item_id, card.sources[0]?.url ?? null, card.sources[0]?.title ?? null, JSON.stringify({ managedRevision: card.revision, decision: "upkeep-not-relevant" })]);
        await this.finish(job, "completed");
        this.counters.skipped++;
        await this.endUpkeepJob(job, card, "not_relevant");
        return;
      }
    }
    const originals = card
      ? [...card.sources]
      : [{ title: job.source_title, url: job.source_url, coverage: "excerpt" }];
    if (
      card &&
      job.source_url &&
      !originals.some((s) => s.url === job.source_url)
    )
      originals.push({
        title: job.source_title,
        url: job.source_url,
        coverage: "excerpt",
      });
    if (originals.length > 50)
      throw Object.assign(
        new Error("Card has reached its source storage limit."),
        { code: "evidence_source_capacity" },
      );
    const sources = [];
    const sourceChecks = [];
    // The job survives scheduling. A newly discovered source mapped to this
    // card inherits its previous job's cursor instead of restarting at zero.
    let cursor = job.payload?.sourceReadCursor;
    if (!Number.isSafeInteger(cursor) && card) cursor = (await this.database.query(
      `SELECT payload->'sourceReadCursor' AS cursor FROM evimed_frontier.evidence_editorial_jobs
        WHERE card_id=$1 AND id<>$2 AND payload ? 'sourceReadCursor' ORDER BY updated_at DESC,id LIMIT 1`,[card.id,job.id],
    )).rows[0]?.cursor;
    const readCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor % originals.length : 0;
    const selectedIndexes = Array.from({length:Math.min(8,originals.length)},(_,index)=>(readCursor+index)%originals.length);
    const readIndexes = new Set(selectedIndexes);
    const nextReadCursor = (readCursor+selectedIndexes.length)%originals.length;
    const newSourceIndex = originals.findIndex(
      (source) => source.url === job.source_url,
    );
    if (card && newSourceIndex >= 0 && !card.sources.some(source=>source.url === job.source_url) && !readIndexes.has(newSourceIndex)) {
      readIndexes.delete(selectedIndexes.at(-1));
      readIndexes.add(newSourceIndex);
    }
    for (const [sourceIndex, source] of originals.entries()) {
      if (!readIndexes.has(sourceIndex)) {
        sources.push(source);
        sourceChecks.push({sourceIndex:sourceIndex+1,status:"retained",attemptedAt:this.now().toISOString(),code:"evidence_source_check_deferred"});
        continue;
      }
      if (!source.url) {
        sourceChecks.push({sourceIndex:sourceIndex+1,status:"retained",attemptedAt:this.now().toISOString(),code:"evidence_source_url_missing"});
        sources.push(source);
        continue;
      }
      await this.renew(job);
      const check = {sourceIndex:sourceIndex+1,status:"checked",attemptedAt:this.now().toISOString()};
      sourceChecks.push(check);
      let result, documentText;
      try {
        result = prefetched && source.url === job.source_url
          ? prefetched : await this.readSource(source.url,{signal:AbortSignal.timeout(90000)});
        if (result !== prefetched) await this.noteStatus(source.url, result);
        documentText = String(result.text ?? "").slice(0,2000000);
        const retained = typeof source.documentText === "string" && source.documentText.trim() && source.sha256 === evidenceHash(source.documentText);
        if (!documentText.trim() && result.publicationStatus && card && retained) {
          Object.assign(check,{status:"retained",code:"evidence_source_empty"});
          sources.push({...source,publicationStatus:evidencePublicationStatus(result.publicationStatus)});
          await this.renew(job);
          continue;
        }
        if (!documentText.trim()) throw Object.assign(new Error("No readable source."),{code:"evidence_source_empty"});
        if ((result.receipt?.truncated || String(result.text ?? "").length > 2000000) && retained)
          throw Object.assign(new Error("Only truncated text was read; the complete retained source is preserved."),{code:"evidence_source_truncated"});
        if (source.publicationStatus && result.publicationStatus === undefined)
          throw Object.assign(new Error("Publication status could not be verified."),{code:"evidence_publication_status_unavailable"});
      } catch (error) {
        const code = error?.name === "TimeoutError" ? "web_read_timeout" : error?.code;
        if (error instanceof TypeError || !card || !retainedSourceErrors.has(code) || typeof source.documentText !== "string" || !source.documentText.trim() || source.sha256 !== evidenceHash(source.documentText)) throw error;
        Object.assign(check,{status:"retained",code});
        sources.push(code === "evidence_source_truncated" && result.publicationStatus !== undefined
          ? {...source,publicationStatus:evidencePublicationStatus(result.publicationStatus)} : source);
        await this.renew(job);
        continue;
      }
      await this.renew(job);
      sources.push(retainedSource(source, result, documentText, this.now().toISOString()));
      this.counters.checked++;
    }
    // Unread sources retain their original position, document text and check date.
    const fingerprint = evidenceSourceFingerprint(sources);
    const unchanged = card?.editorial?.sourceFingerprint === fingerprint;
    const sourceCheckStatus = sourceChecks.every(check=>check.status==="checked") ? "complete" : "partial";
    const sourceCheckedAt = sourceCheckStatus === "complete" ? this.now().toISOString() : card?.editorial?.sourceCheckedAt ?? null;
    const checkMetadata = {sourceChecks,sourceCheckedAt,...(card && !unchanged ? {
      status:"review-pending",reviewer:null,reviewRevision:null,sourceChangedAt:this.now().toISOString(),observedSourceFingerprint:fingerprint,
    } : {})};
    const checkedJob = await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb
      WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[job.id,this.workerId,JSON.stringify({sourceCheckStatus,sourceReadCursor:nextReadCursor})]);
    if (!checkedJob.rowCount) throw new HttpError(409,"evidence_revision_conflict","The source check lost its editorial lease.");
    if (card) {
      // Persist only volatile capture metadata with this receipt. Scientific
      // fields still pass through the normal save, even if quote normalization
      // changed while the retained document fingerprint stayed unchanged.
      const checkedSources = unchanged ? card.sources.map((source,index)=>({
        ...source,checkedAt:sources[index].checkedAt,fetchedSha256:sources[index].fetchedSha256,
      })) : sources;
      const checkedCard = await this.database.query(`UPDATE evimed_frontier.evidence_cards SET editorial=editorial||$3::jsonb,
        sources=CASE WHEN $7::boolean THEN $6::jsonb ELSE sources END
        WHERE id=$1 AND revision=$2 AND state='published' AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j JOIN evimed_frontier.evidence_automation a ON a.zone_id=j.zone_id JOIN evimed_frontier.evidence_zones z ON z.id=j.zone_id
        WHERE j.id=$4 AND j.lease_owner=$5 AND j.state='running' AND j.lease_until>clock_timestamp() AND a.enabled AND z.state='published') RETURNING id`,
        [card.id,baseRevision,JSON.stringify(checkMetadata),job.id,this.workerId,JSON.stringify(checkedSources),unchanged]);
      if (!checkedCard.rowCount) throw new HttpError(409,"evidence_revision_conflict","Card or lease changed during the source check.");
      card.editorial={...card.editorial,...checkMetadata};
    }
    const publicationFindings = sources.flatMap((source,index) => source.publicationStatus ? [{
      kind:"publication-status",sourceIndex:index+1,
      text:source.publicationStatus.kind === "retracted" ? "该来源存在撤稿记录，原有结论须重新核查；本卡暂停 AI 评议。" : source.publicationStatus.kind === "concern" ? "该来源存在关注声明，原有结论须重新核查；本卡暂停 AI 评议。" : "该来源存在更正记录，尚未确认对本卡结论的影响；本卡暂停 AI 评议。",
    }] : []);
    if (publicationFindings.length && (!unchanged || card?.editorial.status !== "review-pending" || !card?.editorial.findings?.some(finding=>finding.kind === "publication-status"))) {
      if (card) {
        const saved = await this.service.saveEditorial(user,{
          expectedRevision:baseRevision,sources,
          editorial:{...card.editorial,status:"review-pending",reviewer:null,reviewRevision:null,sourceCheckedAt,sourceChecks,
            sourceChangedAt:unchanged ? card.editorial.sourceChangedAt : this.now().toISOString(),
            findings:[...(card.editorial.findings ?? []).filter(finding=>finding.kind !== "publication-status"),...publicationFindings]},
        },zone.id,card.id,false,"model",{jobId:job.id,workerId:this.workerId});
        card.revision=saved.evidence.revision;
      }
      await this.database.query("UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND lease_owner=$2",
        [job.id,this.workerId,JSON.stringify({managedRevision:card?.revision,publicationStatus:"requires-review"})]);
      await this.finish(job,"completed");
      await this.endUpkeepJob(job, card, "paused");
      return;
    }
    if (unchanged && !rewriteRequested && (card.editorial.status === "ai-reviewed" || publicationFindings.length)) {
      const refreshed = await this.database.query(
        `UPDATE evimed_frontier.evidence_cards SET sources=$3::jsonb,editorial=editorial||$4::jsonb
        WHERE id=$1 AND revision=$2 AND state='published' AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j JOIN evimed_frontier.evidence_automation a ON a.zone_id=j.zone_id JOIN evimed_frontier.evidence_zones z ON z.id=j.zone_id WHERE j.id=$5 AND j.lease_owner=$6 AND j.state='running' AND j.lease_until>clock_timestamp() AND a.enabled AND z.state='published') RETURNING id`,
        [
          card.id,
          baseRevision,
          JSON.stringify(sources),
          JSON.stringify(checkMetadata),
          job.id,
          this.workerId,
        ],
      );
      if (!refreshed.rowCount)
        throw new HttpError(
          409,
          "evidence_revision_conflict",
          "Card or lease changed during the source check.",
        );
      await this.database.query(
        "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND lease_owner=$2",
        [
          job.id,
          this.workerId,
          JSON.stringify({ managedRevision: card.revision }),
        ],
      );
      this.counters.unchanged++;
      await this.finish(job, "completed");
      await this.endUpkeepJob(job, card, "unchanged");
      return;
    }
    if (!unchanged || rewriteRequested) {
      await this.database.query(
        `UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND lease_owner=$2`,
        [
          job.id,
          this.workerId,
          JSON.stringify({
            observedSourceFingerprint: fingerprint,
            sourceCheckedAt,
            sourceChecks,
            sources,
          }),
        ],
      );
      await this.requireModel(upkeep);
      const examples = (
        await this.database.query(
          `SELECT title,summary,content,limitations FROM evimed_frontier.evidence_cards
        WHERE zone_id=$1 AND id<>$2 AND editorial->>'status'='ai-reviewed' ORDER BY updated_at DESC LIMIT 2`,
          [zone.id, card?.id ?? ""],
        )
      ).rows;
      const feedback = (
        await this.database.query(
          `SELECT origin,text FROM (
            SELECT 'card-comment' AS origin,text,created_at FROM evimed_frontier.evidence_comments WHERE card_id=$1
            UNION ALL SELECT 'zone-question' AS origin,text,created_at FROM evimed_frontier.evidence_zone_feedback WHERE zone_id=$2
          ) questions ORDER BY created_at DESC LIMIT 8`,
          [card?.id ?? "", zone.id],
        )
      ).rows;
      await this.renew(job);
      const draft = await this.editor.evidenceCard({
        rewriteRequested,
        examples,
        sourceChecks,
        previousFindings: card?.editorial?.findings ?? [],
        readerQuestions: feedback,
        zone: { title: zone.title, description: zone.description },
        sources: sources.map((s, index) => ({
          sourceIndex: index + 1,
          title: s.title,
          url: s.url,
          text: (s.documentText ?? s.excerpt ?? "").slice(0, 24000),
          coverage: s.coverage,
          publicationStatus: s.publicationStatus ?? null,
          inputTruncated: (s.documentText ?? s.excerpt ?? "").length > 24000,
        })),
        previous: card
          ? {
              title: card.title,
              summary: card.summary,
              body: card.body,
              content: card.content,
              limitations: card.limitations,
              sources: card.sources.map((source, index) => ({
                sourceIndex: index + 1,
                title: source.title,
                url: source.url,
              })),
            }
          : null,
      }, upkeep.billing);
      await this.renew(job);
      const saved = await this.service.saveEditorial(
        user,
        {
          ...draft,
          sources,
          state: "published",
          subtype: card?.subtype ?? "academic",
          provenance:
            "AI-authored synthesis of the retained source material; separate AI verification is recorded below.",
          ...(card
            ? { expectedRevision: baseRevision }
            : { requestId, sourceItemId: job.source_item_id }),
          editorial: {
            author: {
              ...card?.editorial?.author,
              ...author(this.editor),
              ...((card?.editorial?.author?.userId ??
              roleId("evidence-editor-ai"))
                ? {
                    userId:
                      card?.editorial?.author?.userId ??
                      roleId("evidence-editor-ai"),
                  }
                : {}),
            },
            status: "review-pending",
            sourceCheckedAt,
            sourceChecks,
            sourceChangedAt: card ? (!unchanged ? this.now().toISOString() : card.editorial?.sourceChangedAt ?? null) : null,
            findings: [],
          },
        },
        zone.id,
        card?.id ?? null,
        !card,
        "model",
        { jobId: job.id, workerId: this.workerId },
      );
      card = (
        await this.database.query(
          "SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1",
          [saved.evidence.id],
        )
      ).rows[0];
      await this.database.query(
        "UPDATE evimed_frontier.evidence_editorial_jobs SET card_id=$3 WHERE id=$1 AND lease_owner=$2",
        [job.id, this.workerId, card.id],
      );
      const authored = await this.database.query(
        `UPDATE evimed_frontier.evidence_editorial_jobs SET payload=(COALESCE(payload,'{}'::jsonb)-'rewriteRevision')||$3::jsonb
          WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
        [
          job.id,
          this.workerId,
          JSON.stringify({ managedRevision: card.revision }),
        ],
      );
      if (!authored.rowCount) throw new HttpError(409,"evidence_revision_conflict","The author save lost its editorial lease.");
      this.counters.published++;
    }
    await this.requireModel(upkeep);
    await this.renew(job);
    const review = await this.editor.evidenceReview({
      title: card.title,
      summary: card.summary,
      body: card.body,
      content: card.content,
      limitations: card.limitations,
      sourceChecks,
      sources: card.sources.map((s, index) => ({
        sourceIndex: index + 1,
        title: s.title,
        text: (s.documentText ?? s.excerpt ?? "").slice(0, 24000),
        coverage: s.coverage,
        publicationStatus: s.publicationStatus ?? null,
        inputTruncated: (s.documentText ?? s.excerpt ?? "").length > 24000,
      })),
    }, upkeep.billing);
    await this.renew(job);
    const findings = [
      ...review.findings,
      ...card.sources.flatMap((s, index) =>
        (s.documentText ?? s.excerpt ?? "").length > 24000
          ? [
              {
                kind: "coverage",
                text: "本次 AI 核对仅使用该来源的部分已保存正文。",
                sourceIndex: index + 1,
              },
            ]
          : [],
      ),
    ];
    await this.service.saveEditorial(
      user,
      {
        expectedRevision: card.revision,
        editorial: {
          ...card.editorial,
          status: "ai-reviewed",
          reviewer: {
            ...reviewer(this.editor),
            ...((reviewerActor ?? roleId("evidence-review-ai"))
              ? { userId: reviewerActor ?? roleId("evidence-review-ai") }
              : {}),
          },
          reviewedAt: this.now().toISOString(),
          contentHash: evidenceContentHash(card),
          findings,
        },
      },
      zone.id,
      card.id,
      false,
      "model",
      { jobId: job.id, workerId: this.workerId },
    );
    await this.database.query(
      "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND lease_owner=$2",
      [
        job.id,
        this.workerId,
        JSON.stringify({ managedRevision: card.revision + 1 }),
      ],
    );

    this.counters.reviewed++;
    await this.finish(job, "completed");
    await this.endUpkeepJob(job, card, "revised");
  }
  /**
   * A follow-up job queued by the upkeep ended; tell it how, so the card's label and the public log say what was done. Never fails the job:
   * the card is as the editor left it either way, and the next check of the card reads it again.
   * @param {any} job @param {any} card @param {'revised'|'not_relevant'|'paused'|'unchanged'} outcome
   */
  async endUpkeepJob(job, card, outcome) {
    const upkeep = job.payload?.upkeep;
    if (!upkeep || !card || !this.upkeepLoops) return;
    try {
      await this.upkeepLoops.afterFollowUp({ cardId: card.id, upkeep, outcome });
      // Told once: a later rotation of the same job must not raise the same items again.
      await this.database.query("UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)-'upkeep' WHERE id=$1", [job.id]);
    } catch (error) { this.counters.upkeepStepFailures++; this.lastError = codeOf(error); }
  }
  /**
   * The loops that keep a card current (`evidenceCurrency.mjs`) and answer a reader's challenge (`evidenceChallenges.mjs`), each asked as
   * often as it needs and each leased by itself, so two control planes never run the same pass. A loop that fails is counted and does not
   * hold up the editor's own work.
   */
  async upkeepStep() {
    if (!this.upkeepLoops && !this.challenges) return;
    const at = this.now().getTime();
    /** @type {Array<[string, number, (() => Promise<unknown>) | null]>} */
    const loops = [
      ["sourceChanges", 60_000, this.upkeepLoops ? () => this.upkeepLoops.sourcePollTick() : null],
      ["watch", 60_000, this.upkeepLoops ? () => this.upkeepLoops.watchTick() : null],
      ["downstream", 60_000, this.upkeepLoops ? () => this.upkeepLoops.downstreamTick() : null],
      ["challenges", 30_000, this.challenges ? () => this.challenges.recheckTick() : null],
    ];
    for (const [name, every, run] of loops) {
      if (!run || at < (this.nextUpkeepAt[name] ?? 0)) continue;
      this.nextUpkeepAt[name] = at + every;
      try { await run(); }
      catch (error) { this.counters.upkeepStepFailures++; this.lastError = codeOf(error); }
    }
  }
  async tick() {
    if (this.running || !this.canRun()) return;
    this.running = true;
    this.lastRunAt = this.now().toISOString();
    try {
      await migrateEvidenceZones(this.database);
      await this.database.query(
        "UPDATE evimed_frontier.evidence_editorial_jobs SET state='failed',lease_owner=NULL,lease_until=NULL,last_error='evidence_lease_expired' WHERE state='running' AND lease_until<clock_timestamp() AND attempts>=3",
      );
      await this.schedule();
      await this.upkeepStep();
      if (this.now().getTime() < this.providerPausedUntil) return;
      const job = await this.claim();
      if (!job) return;
      try {
        await this.process(job);
        this.lastError = null;
        await this.settleUpkeep(job, null);
      } catch (e) {
        this.lastError = codeOf(e);
        // What an account's own zone cost before the job stopped is the account's, the way a failed run's is recorded.
        const owners = this.upkeep && !this.upkeep.official;
        await this.settleUpkeep(job, e);
        // An allowance or a cap is a wait, not a failure: the job is set aside with the reason (`deferUpkeep`).
        if (owners && UPKEEP_DEFERRALS.includes(this.lastError)) {
          await this.deferUpkeep(job, this.lastError);
          return;
        }
        if (frontierProviderUnavailable(e)) {
          const waitMs = this.lastError === "model_gateway_payment_required" ? FRONTIER_PROVIDER_REFUSED_WAIT_MS : FRONTIER_PROVIDER_RETRY_MS;
          const waiting = await this.database.query(`UPDATE evimed_frontier.evidence_editorial_jobs
            SET state='pending',attempts=greatest(0,attempts-1),available_at=clock_timestamp()+$3*interval '1 millisecond',
              last_error=$4,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
            WHERE id=$1 AND lease_owner=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
            [job.id,this.workerId,waitMs,this.lastError]);
          if (waiting.rowCount) {
            this.providerPausedUntil = this.now().getTime()+waitMs;
            await this.database.query("UPDATE evimed_frontier.evidence_automation SET last_error=$2 WHERE zone_id=$1",[job.zone_id,this.lastError]);
          }
          return;
        }
        if (this.lastError === "evidence_budget_wait") {
          await this.database.query(
            "UPDATE evimed_frontier.evidence_editorial_jobs SET attempts=greatest(0,attempts-1) WHERE id=$1 AND lease_owner=$2",
            [job.id, this.workerId],
          );
          await this.finish(job, "pending", this.lastError);
          return;
        }
        this.counters.failed++;
        const conflict = this.lastError === "evidence_revision_conflict";
        if (conflict) this.counters.conflicts++;
        await this.finish(
          job,
          conflict ? "conflict" : job.attempts >= 3 ? "failed" : "pending",
          this.lastError,
        );
      }
    } finally {
      this.running = false;
    }
  }
  status() {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }
}
