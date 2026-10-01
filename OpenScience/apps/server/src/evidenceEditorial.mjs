import { randomUUID } from "node:crypto";
import { FRONTIER_SOURCE_TYPES } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import {
  evidenceHash,
  evidenceContentHash,
  evidenceSourceFingerprint,
  evidencePublicExcerpt,
  evidencePublicationStatus,
} from "./evidenceCardContent.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

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
/** Durable, bounded editorial work; one tick checks or produces one card. */
export class EvidenceEditorial {
  /** @param {{database:any,service:any,editor:any,budget?:any,readSource:any,canRun?:()=>boolean,now?:()=>Date,workerId?:string}} dependencies */
  constructor({
    database,
    service,
    editor,
    budget = null,
    readSource,
    canRun = () => true,
    now = () => new Date(),
    workerId = randomUUID(),
  }) {
    this.database = database;
    this.service = service;
    this.editor = editor;
    this.budget = budget;
    this.readSource = readSource;
    this.canRun = canRun;
    this.now = now;
    this.workerId = workerId;
    this.running = false;
    this.lastError = null;
    this.lastRunAt = null;
    this.counters = {
      checked: 0,
      unchanged: 0,
      published: 0,
      reviewed: 0,
      skipped: 0,
      failed: 0,
      conflicts: 0,
    };
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
    await this.database.transaction(async (/** @type {any} */ client) => {
      const zone = await this.service.zoneRow(client, user, zoneId, true);
      if (zone.user_id !== user.id)
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
        if (Object.keys(body).length)
          throw new HttpError(
            400,
            "evidence_invalid",
            "Refresh does not accept additional fields.",
          );
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
  async schedule() {
    return this.database.transaction(async (/** @type {any} */ client) => {
      const settings = (
        await client.query(`SELECT a.* FROM evimed_frontier.evidence_automation a JOIN evimed_frontier.evidence_zones z ON z.id=a.zone_id
        WHERE a.enabled AND a.next_run_at<=clock_timestamp() AND z.state='published' ORDER BY a.next_run_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED`)
      ).rows[0];
      if (!settings) return 0;
      // Maintenance rotates by oldest job attempt; discovery gets alternating first place. AI authorship and zone opt-in are both required.
      const cards = (
        await client.query(
          `SELECT c.*,j.identity_key AS editorial_identity FROM evimed_frontier.evidence_cards c LEFT JOIN LATERAL(SELECT identity_key,state,updated_at FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=c.id AND zone_id=c.zone_id ORDER BY updated_at DESC LIMIT 1) j ON true
        WHERE c.zone_id=$1 AND c.state='published' AND c.editorial->'author'->>'kind'='ai' AND COALESCE(j.state,'completed') NOT IN ('conflict','failed')
        ORDER BY COALESCE(j.updated_at,(c.editorial->>'sourceCheckedAt')::timestamptz,'epoch'::timestamptz),c.id LIMIT $2`,
          [settings.zone_id, settings.max_cards_per_run],
        )
      ).rows;
      const candidates = (
        await client.query(
          `SELECT i.public_id,i.identity_key,i.canonical_url,i.title_raw FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
        WHERE i.state='published' AND s.enabled AND i.source_type=ANY($1::text[]) AND strpos(lower(concat_ws(' ',i.title_raw,i.title_zh,i.summary_zh)),lower($2))>0
        AND NOT EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j WHERE j.zone_id=$3 AND j.identity_key=i.identity_key
          AND NOT COALESCE(j.state='completed' AND j.card_id IS NULL AND j.payload->>'decision'='skip' AND j.available_at<=clock_timestamp(),false))
        ORDER BY i.timeline_at DESC,i.id DESC LIMIT $4`,
          [
            settings.source_types,
            settings.query,
            settings.zone_id,
            settings.max_cards_per_run,
          ],
        )
      ).rows;
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
  async requireModel() {
    const budget = this.budget ? await this.budget() : { state: "ok" };
    if (!this.editor.available || budget.state !== "ok")
      throw Object.assign(
        new Error("Evidence writing is waiting for its editor or budget."),
        { code: "evidence_budget_wait" },
      );
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
        await this.requireModel();
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
        });
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
      const excerpt = evidencePublicExcerpt(
        documentText,
        source.excerpt ?? null,
      );
      sources.push({
        ...source,
        excerpt,
        documentText,
        sha256: evidenceHash(documentText),
        fetchedSha256: result.receipt?.sha256 ?? evidenceHash(documentText),
        checkedAt: this.now().toISOString(),
        // Explicit null clears a previously verified notice; absent metadata does not.
        publicationStatus: evidencePublicationStatus(result.publicationStatus),
        coverage:
          (result.receipt?.truncated || String(result.text ?? "").length > 2000000) ? "excerpt" : result.coverage ??
          (source.coverage === "full-text" && !result.receipt?.truncated
            ? "full-text"
            : (source.coverage ?? "excerpt")),
      });
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
      const checkedCard = await this.database.query(`UPDATE evimed_frontier.evidence_cards SET editorial=editorial||$3::jsonb
        WHERE id=$1 AND revision=$2 AND state='published' AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j JOIN evimed_frontier.evidence_automation a ON a.zone_id=j.zone_id JOIN evimed_frontier.evidence_zones z ON z.id=j.zone_id
        WHERE j.id=$4 AND j.lease_owner=$5 AND j.state='running' AND j.lease_until>clock_timestamp() AND a.enabled AND z.state='published') RETURNING id`,
        [card.id,baseRevision,JSON.stringify(checkMetadata),job.id,this.workerId]);
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
      return;
    }
    if (unchanged && (card.editorial.status === "ai-reviewed" || publicationFindings.length)) {
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
      return;
    }
    if (!unchanged) {
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
      await this.requireModel();
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
      });
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
            sourceChangedAt: card ? this.now().toISOString() : null,
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
      await this.database.query(
        "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=COALESCE(payload,'{}'::jsonb)||$3::jsonb WHERE id=$1 AND lease_owner=$2",
        [
          job.id,
          this.workerId,
          JSON.stringify({ managedRevision: card.revision }),
        ],
      );
      this.counters.published++;
    }
    await this.requireModel();
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
    });
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
      const job = await this.claim();
      if (!job) return;
      try {
        await this.process(job);
        this.lastError = null;
      } catch (e) {
        this.lastError = codeOf(e);
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
