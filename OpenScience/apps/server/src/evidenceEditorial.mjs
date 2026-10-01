import { randomUUID } from "node:crypto";
import { FRONTIER_SOURCE_TYPES } from "@evimed/domain";
import { HttpError } from "./security.mjs";
import {
  evidenceHash,
  evidenceContentHash,
  evidenceSourceFingerprint,
  evidencePublicExcerpt,
} from "./evidenceCardContent.mjs";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

const codeOf = (/** @type {any} */ e) =>
  /^[a-z0-9_]{2,100}$/.test(e?.code ?? "")
    ? e.code
    : "evidence_editorial_failed";
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
        `SELECT id,state,attempts,last_error AS "lastError",updated_at AS "updatedAt",card_id AS "cardId" FROM evimed_frontier.evidence_editorial_jobs WHERE zone_id=$1 ORDER BY updated_at DESC LIMIT 10`,
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
      // Maintenance rotates by oldest source check; discovery gets alternating first place. AI authorship and zone opt-in are both required.
      const cards = (
        await client.query(
          `SELECT c.*,j.identity_key AS editorial_identity FROM evimed_frontier.evidence_cards c LEFT JOIN LATERAL(SELECT identity_key,state FROM evimed_frontier.evidence_editorial_jobs WHERE card_id=c.id AND zone_id=c.zone_id ORDER BY updated_at DESC LIMIT 1) j ON true
        WHERE c.zone_id=$1 AND c.state='published' AND c.editorial->'author'->>'kind'='ai' AND COALESCE(j.state,'completed')<>'conflict'
        ORDER BY COALESCE((c.editorial->>'sourceCheckedAt')::timestamptz,'epoch'::timestamptz),c.id LIMIT $2`,
          [settings.zone_id, settings.max_cards_per_run],
        )
      ).rows;
      const candidates = (
        await client.query(
          `SELECT i.public_id,i.identity_key,i.canonical_url,i.title_raw FROM evimed_frontier.items i JOIN evimed_frontier.sources s ON s.id=i.primary_source_id
        WHERE i.state='published' AND s.enabled AND i.source_type=ANY($1::text[]) AND strpos(lower(concat_ws(' ',i.title_raw,i.title_zh,i.summary_zh)),lower($2))>0
        AND NOT EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs j WHERE j.zone_id=$3 AND j.identity_key=i.identity_key)
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
          WHERE evidence_editorial_jobs.state='completed'`,
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
      available_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp() RETURNING id`,
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
  /** @param {any} job */
  async process(job) {
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
      if (targets.length) {
        prefetched = await this.readSource(job.source_url, {
          signal: AbortSignal.timeout(90000),
        });
        await this.requireModel();
        const targetId = await this.editor.evidenceTarget({
          zone: zone.title,
          source: {
            title: job.source_title,
            text: String(prefetched.text ?? "").slice(0, 12000),
          },
          cards: targets,
        });
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
    const readIndexes = new Set(originals.slice(0, 8).map((_, index) => index));
    const newSourceIndex = originals.findIndex(
      (source) => source.url === job.source_url,
    );
    if (newSourceIndex >= 8) {
      readIndexes.delete(7);
      readIndexes.add(newSourceIndex);
    }
    for (const [sourceIndex, source] of originals.entries()) {
      if (!readIndexes.has(sourceIndex)) {
        sources.push(source);
        continue;
      }
      if (!source.url) {
        sources.push(source);
        continue;
      }
      if (!this.canRun())
        throw Object.assign(new Error("Maintenance active."), {
          code: "evidence_maintenance_active",
        });
      const result =
        prefetched && source.url === job.source_url
          ? prefetched
          : await this.readSource(source.url, {
              signal: AbortSignal.timeout(90000),
            });
      const documentText = String(result.text ?? "").slice(0, 2000000);
      if (!documentText.trim())
        throw Object.assign(new Error("No readable source."), {
          code: "evidence_source_empty",
        });
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
        coverage:
          result.coverage ??
          (source.coverage === "full-text" && !result.receipt?.truncated
            ? "full-text"
            : (source.coverage ?? "excerpt")),
      });
      this.counters.checked++;
    }
    // Unread sources retain their original position, document text and check date.
    const fingerprint = evidenceSourceFingerprint(sources);
    const unchanged = card?.editorial?.sourceFingerprint === fingerprint;
    if (unchanged && card.editorial.status === "ai-reviewed") {
      const refreshed = await this.database.query(
        `UPDATE evimed_frontier.evidence_cards SET sources=$3::jsonb,editorial=jsonb_set(editorial,'{sourceCheckedAt}',to_jsonb($4::text))
        WHERE id=$1 AND revision=$2 AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs WHERE id=$5 AND lease_owner=$6 AND lease_until>clock_timestamp()) RETURNING id`,
        [
          card.id,
          baseRevision,
          JSON.stringify(sources),
          this.now().toISOString(),
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
        "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=$3::jsonb WHERE id=$1 AND lease_owner=$2",
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
            sourceCheckedAt: this.now().toISOString(),
            sources,
          }),
        ],
      );
      if (card)
        await this.database.query(
          `UPDATE evimed_frontier.evidence_cards SET editorial=editorial||$3::jsonb WHERE id=$1 AND revision=$2 AND EXISTS(SELECT 1 FROM evimed_frontier.evidence_editorial_jobs WHERE id=$4 AND lease_owner=$5 AND lease_until>clock_timestamp())`,
          [
            card.id,
            baseRevision,
            JSON.stringify({
              status: "review-pending",
              reviewer: null,
              reviewRevision: null,
              sourceChangedAt: this.now().toISOString(),
              observedSourceFingerprint: fingerprint,
            }),
            job.id,
            this.workerId,
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
      const draft = await this.editor.evidenceCard({
        examples,
        previousFindings: card?.editorial?.findings ?? [],
        readerQuestions: feedback,
        zone: { title: zone.title, description: zone.description },
        sources: sources.map((s, index) => ({
          sourceIndex: index + 1,
          title: s.title,
          url: s.url,
          text: (s.documentText ?? s.excerpt ?? "").slice(0, 24000),
          coverage: s.coverage,
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
            sourceCheckedAt: this.now().toISOString(),
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
        "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=$3::jsonb WHERE id=$1 AND lease_owner=$2",
        [
          job.id,
          this.workerId,
          JSON.stringify({ managedRevision: card.revision }),
        ],
      );
      this.counters.published++;
    }
    await this.requireModel();
    const review = await this.editor.evidenceReview({
      title: card.title,
      summary: card.summary,
      body: card.body,
      content: card.content,
      limitations: card.limitations,
      sources: card.sources.map((s, index) => ({
        sourceIndex: index + 1,
        title: s.title,
        text: (s.documentText ?? s.excerpt ?? "").slice(0, 24000),
        coverage: s.coverage,
        inputTruncated: (s.documentText ?? s.excerpt ?? "").length > 24000,
      })),
    });
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
      "UPDATE evimed_frontier.evidence_editorial_jobs SET payload=$3::jsonb WHERE id=$1 AND lease_owner=$2",
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
