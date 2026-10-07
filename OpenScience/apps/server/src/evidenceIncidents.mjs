/**
 * What happens to a card after it is published goes back into learning (evidence-flywheel plan §5.5, F15, 2026-10-06): every correction and
 * withdrawal the public change log records becomes two things — an incident case for the repository's evals, and an observation on the methods
 * of the run that produced the card.
 *
 * Hidden knowledge:
 *
 * - **The cursor is the change log's own id.** The log is append-only and numbered, so "what happened since I last looked" is one comparison, and
 *   the consumer holds no copy of anything: its position and its lease live in `evidence_upkeep_state` beside the upkeep loops' own, so two control
 *   planes never read the same entries twice at once. It is ticked by the learning worker's housekeeping timer; it has no timer of its own.
 * - **An incident is a ledger document; an eval case is a file.** Principle 6 says every incident becomes an eval case, and evals are repository
 *   files a running server cannot write. So the server writes a `knowledge` document of `recordType: "evidence-incident"` under the platform
 *   publisher's internal evidence project (no tenant owns it: it holds only what the published card already shows) and
 *   `scripts/evals/export-evidence-incidents.mjs` turns the pending ones into `evals/evidence-incidents/cases/`. Only incidents of cards the platform
 *   produced, or whose author opened them to the internet, are exportable; a platform-visible card's incident stays a ledger row.
 * - **The class is closed and decided from the log's own fields**, never from prose: a challenge that amended a claim, a challenge that withdrew one, a
 *   producer's own correction, a card withdrawn, a source that changed under a card. The sentence a case says is made from the class by code.
 * - **A method observation is a label for the sequential test, never a verdict.** It goes to the learned methods and handbooks the producing run *read*
 *   (`MethodFeedbackService`), under the revision it read, as the same `evidence_corrected` signal a researcher's own correction of the result is — so a
 *   result corrected both ways is one outcome. A source that changed under a card is an incident and no observation: the method did not write the
 *   retraction, and the lifecycle's association-not-cause rule would otherwise let a retraction roll a method back. A card of the platform's own
 *   programme, a product card and a card with no result version in its lineage have no researcher's method to observe and say so.
 * - **A failure never loses an incident silently.** An entry that cannot be handled holds the cursor where it is and is tried again on the next tick;
 *   after {@link MAX_ENTRY_ATTEMPTS} attempts it is skipped and counted as abandoned, with its code reported, so one bad row cannot stall every later one.
 *   Every write is keyed by the entry's id, so a replay changes nothing.
 *
 * Which model capability would make it deletable: none for the incident; the class could be read from the correction's reasoning by a model once a
 * model's judgement of why a claim was wrong is trusted as the platform trusts a quotation match.
 *
 * @module evidenceIncidents
 */
import { randomUUID } from "node:crypto";
import { migrateEvidenceZones } from "./evidenceZonePersistence.mjs";

/** The closed classes of what went wrong, as the change log's category and trigger decide them. */
export const EVIDENCE_INCIDENT_CLASSES = Object.freeze(["claim_amended", "claim_withdrawn", "card_withdrawn", "producer_correction", "source_changed"]);
/** The classes that judged the conclusion itself wrong, and so are evidence about the method that wrote it. */
export const EVIDENCE_OBSERVED_CLASSES = Object.freeze(["claim_amended", "claim_withdrawn", "card_withdrawn", "producer_correction"]);
export const EVIDENCE_OBSERVATION_OUTCOMES = Object.freeze(["recorded", "duplicate", "skipped", "failed"]);
/** How often one entry may be tried before it is skipped. */
export const MAX_ENTRY_ATTEMPTS = 3;
export const EVIDENCE_OUTCOMES_STATE_NAME = "learning-evidence-outcomes";
export const EVIDENCE_OUTCOMES_DEFAULT_BATCH = 25;
/** The longest claim or quotation an incident keeps. */
const TEXT_LIMIT = 800;
const SOURCE_CHANGE_LIMIT = 10;
/** The document an incident is. */
export const EVIDENCE_INCIDENT_RECORD_TYPE = "evidence-incident";
const LEASE_MS = 120_000;

/** @param {unknown} value @param {number} [max] */
const text = (value, max = TEXT_LIMIT) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/**
 * The closed class of one change-log entry, or null when it is not an outcome this loop learns from.
 * @param {{ category?: string, trigger?: string, refs?: any }} entry
 * @returns {typeof EVIDENCE_INCIDENT_CLASSES[number] | null}
 */
export function evidenceIncidentClass({ category, trigger, refs }) {
  if (category === "withdrawal") return trigger === "challenge" && typeof refs?.claimId === "string" && refs.claimId ? "claim_withdrawn" : "card_withdrawn";
  if (category !== "correction") return null;
  if (trigger === "challenge") return "claim_amended";
  if (trigger === "source_change") return "source_changed";
  if (trigger === "producer_edit") return "producer_correction";
  return null;
}

/** What found it, in the words the case files use. @param {string} trigger */
const caughtBy = (trigger) => (trigger === "challenge" ? "reader" : trigger === "source_change" ? "source-change" : trigger === "producer_edit" ? "producer" : "nobody");

/**
 * What a case says is wrong, and what a fix has to get right, by class: made by code from the closed class, never from the card's prose.
 * @type {Readonly<Record<string, { why: string, note: string }>>}
 */
const CASE_WORDS = Object.freeze({
  claim_amended: { why: "A published claim was challenged by a reader and, on re-check, its wording and the source sentence it rests on were corrected: the claim as first published was not supported by the source it cited.",
    note: "A fix has to get the claim and its quotation to agree before publication — the quotation bond is the check — rather than word the claim to what the model remembers of the source." },
  claim_withdrawn: { why: "A published claim was challenged by a reader and, on re-check, withdrawn: the source it cited could not support it.",
    note: "A fix has to leave a conclusion out when no source sentence carries it, instead of publishing it with the nearest quotation." },
  card_withdrawn: { why: "A published card was withdrawn whole: what it concluded no longer stands.",
    note: "A fix has to catch what made the whole card unsafe to stand, not only the claim a reader named." },
  producer_correction: { why: "The producer of a published card corrected it themselves: the version first published was wrong.",
    note: "A fix has to find the error the producer later found, from what the run itself had in hand when it wrote the card." },
  source_changed: { why: "A source a published card cites was retracted, corrected or issued in a new version after publication, so the conclusions resting on it need a second look.",
    note: "Not a defect of the method that wrote the card unless the change was already public when it did; a case of whether the platform's watch noticed and said so in time." },
});

/**
 * One incident document as an eval case, in the shape of `evals/writing-incidents/cases/` (id, genre, observedIn, verbatim, whyItIsWrong, caughtBy, note) with the
 * structured fields an evidence incident has beside them. `verbatim` is the claim as first published, copied; for an incident with no claim it is the card's title.
 * @param {any} payload an `evidence-incident` document's payload
 * @returns {Record<string, any>}
 */
export function evidenceIncidentCase(payload) {
  const words = CASE_WORDS[payload.class] ?? { why: "", note: "" };
  const day = String(payload.occurredAt ?? "").slice(0, 10);
  return {
    id: `${day}-evidence-${payload.cardId}-${payload.logEntryId}-${String(payload.class).replaceAll("_", "-")}`,
    genre: `evidence-${String(payload.class).replaceAll("_", "-")}`,
    observedIn: `evidence-card:${payload.cardId}@revision-${payload.revisionBefore ?? "unknown"}`,
    verbatim: payload.claimBefore?.text ?? payload.card?.title ?? "",
    whyItIsWrong: words.why,
    caughtBy: payload.caughtBy,
    note: words.note,
    cardId: payload.cardId, zoneId: payload.zoneId, claimId: payload.claimId ?? null,
    revisionBefore: payload.revisionBefore ?? null, revisionAfter: payload.revisionAfter ?? null,
    claimAfter: payload.claimAfter?.text ?? null,
    quoteBefore: payload.claimBefore?.quote ?? null, quoteAfter: payload.claimAfter?.quote ?? null,
    sourceChanges: payload.sourceChanges ?? [],
    trigger: payload.trigger, producerKind: payload.card?.producerKind ?? null,
    capabilityId: payload.produced?.capabilityId ?? null, runId: payload.produced?.runId ?? null,
    occurredAt: payload.occurredAt,
  };
}

/** @param {any} claim @returns {string | null} the first quotation the claim stands on */
function quoteOf(claim) {
  if (!claim) return null;
  if (typeof claim.supportQuote === "string") return text(claim.supportQuote);
  const bond = Array.isArray(claim.supportingSources) ? claim.supportingSources.find((/** @type {any} */ source) => typeof source?.supportQuote === "string") : null;
  return text(bond?.supportQuote);
}

/**
 * @param {{ database: any, documents: any, ensureOwner: () => Promise<{ userId: string, projectId: string }>,
 *   methodFeedback?: { fromEvidenceOutcome: (project: any, outcome: any) => Promise<any> } | null,
 *   resolveProject?: ((userId: string, projectId: string) => Promise<any>) | null,
 *   batch?: number, now?: () => Date, report?: ((code: string) => void) | null }} options
 */
export function createEvidenceOutcomes({ database, documents, ensureOwner, methodFeedback = null, resolveProject = null, batch = EVIDENCE_OUTCOMES_DEFAULT_BATCH, now = () => new Date(), report = null }) {
  const workerId = `learning-outcomes-${randomUUID()}`;
  const size = Math.max(1, Math.min(200, Math.floor(batch)));
  const counters = {
    ticks: 0, entriesRead: 0, abandoned: 0, unclassified: 0,
    incidents: /** @type {Record<string, number>} */ (Object.fromEntries(EVIDENCE_INCIDENT_CLASSES.map((name) => [name, 0]))),
    incidentsExportable: 0,
    observations: /** @type {Record<string, number>} */ (Object.fromEntries(EVIDENCE_OBSERVATION_OUTCOMES.map((name) => [name, 0]))),
    skippedBecause: /** @type {Record<string, number>} */ ({}),
  };

  /** @param {string} reason */
  const skipped = (reason) => { counters.observations.skipped += 1; counters.skippedBecause[reason] = (counters.skippedBecause[reason] ?? 0) + 1; return { state: "skipped", reason }; };

  /** @returns {Promise<{ cursor: number, payload: any } | null>} */
  async function lease() {
    await migrateEvidenceZones(database);
    await database.query("INSERT INTO evimed_frontier.evidence_upkeep_state(name) VALUES($1) ON CONFLICT DO NOTHING", [EVIDENCE_OUTCOMES_STATE_NAME]);
    const taken = await database.query(
      `UPDATE evimed_frontier.evidence_upkeep_state SET lease_owner=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond'
       WHERE name=$1 AND (lease_owner IS NULL OR lease_until<clock_timestamp()) RETURNING cursor,payload`, [EVIDENCE_OUTCOMES_STATE_NAME, workerId, LEASE_MS]);
    return taken.rows[0] ? { cursor: Number(taken.rows[0].cursor), payload: taken.rows[0].payload ?? {} } : null;
  }
  /** @param {{ cursor: number, payload: any }} state */
  async function release(state) {
    await database.query(
      `UPDATE evimed_frontier.evidence_upkeep_state SET cursor=$3::bigint,payload=$4::jsonb,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE name=$1 AND lease_owner=$2`, [EVIDENCE_OUTCOMES_STATE_NAME, workerId, state.cursor, JSON.stringify(state.payload)]);
  }

  /**
   * The method observation of one entry, or why there is none.
   * @param {any} entry the change-log row @param {any} card the card row @param {string} outcomeClass
   */
  async function observe(entry, card, outcomeClass) {
    if (!EVIDENCE_OBSERVED_CLASSES.includes(/** @type {any} */ (outcomeClass))) return { ...skipped("source_change_is_not_the_methods"), capabilityId: null };
    if (!methodFeedback || !resolveProject) return { ...skipped("learning_off"), capabilityId: null };
    const lineage = card?.lineage ?? {};
    if (!card || card.zone_kind !== "user") return { ...skipped(!card ? "card_gone" : "not_a_researchers_card"), capabilityId: null };
    if (typeof lineage.resultVersionId !== "string" || typeof lineage.runId !== "string") return { ...skipped("no_result_version_in_lineage"), capabilityId: null };
    // The result version is the author's own record: the project it belongs to and the digest the signal is bound to come from it.
    const version = await documents.get(String(card.user_id), "result-version", lineage.resultVersionId).catch(() => null);
    if (!version?.projectId || typeof version.payload?.digest !== "string") return { ...skipped("result_version_unavailable"), capabilityId: null };
    const project = await resolveProject(String(card.user_id), version.projectId).catch(() => null);
    if (!project) return { ...skipped("project_unavailable"), capabilityId: null };
    const joined = await methodFeedback.fromEvidenceOutcome(project, {
      runId: lineage.runId, result: { versionId: lineage.resultVersionId, digest: version.payload.digest },
      at: new Date(entry.occurred_at).toISOString(), logEntryId: String(entry.id), outcomeClass,
    });
    if (joined.skipped && !joined.recorded.length) return { ...skipped(String(joined.skipped)), capabilityId: joined.capabilityId ?? null };
    const added = joined.recorded.filter((/** @type {any} */ item) => item.added);
    if (added.length) counters.observations.recorded += 1; else counters.observations.duplicate += 1;
    return {
      state: added.length ? "recorded" : "duplicate", methods: joined.recorded.filter((/** @type {any} */ item) => item.kind === "method").length,
      handbooks: joined.recorded.filter((/** @type {any} */ item) => item.kind === "handbook").length, capabilityId: joined.capabilityId ?? null,
    };
  }

  /** The claim as it stood before and after one entry, from the card's own revision history. @param {any} entry @param {string | null} claimId */
  async function claimsOf(entry, claimId) {
    if (!claimId) return { before: null, after: null };
    const read = async (/** @type {number | null} */ revision) => {
      if (!Number.isSafeInteger(revision)) return null;
      const snapshot = (await database.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id=$1 AND revision=$2", [entry.card_id, revision])).rows[0]?.snapshot;
      const claim = (Array.isArray(snapshot?.claims) ? snapshot.claims : []).find((/** @type {any} */ item) => item?.claimId === claimId) ?? null;
      return claim ? { text: text(claim.claim), quote: quoteOf(claim) } : null;
    };
    return { before: await read(entry.revision_before), after: await read(entry.revision_after) };
  }

  /** @param {any} entry the change-log row */
  async function handle(entry) {
    const outcomeClass = evidenceIncidentClass({ category: entry.category, trigger: entry.trigger, refs: entry.refs });
    if (!outcomeClass) { counters.unclassified += 1; return; }
    const card = (await database.query(
      `SELECT c.id,c.title,c.user_id,c.lineage,c.producer,c.originality,z.kind AS zone_kind,z.visibility AS zone_visibility
       FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id WHERE c.id=$1`, [entry.card_id])).rows[0] ?? null;
    const claimId = text(entry.refs?.claimId, 80);
    const claims = await claimsOf(entry, claimId);
    const observation = await observe(entry, card, outcomeClass).catch((error) => {
      counters.observations.failed += 1;
      report?.(typeof error?.code === "string" ? `evidence_outcome_observation_${error.code}` : "evidence_outcome_observation_failed");
      return { state: "failed", reason: "observation_failed", capabilityId: null };
    });
    const producerKind = card?.producer?.kind ?? null;
    const exportable = Boolean(card) && (producerKind === "platform" || (card.zone_kind === "user" && card.zone_visibility === "internet"));
    const owner = await ensureOwner();
    const id = `evidence-incident-${entry.id}`;
    const payload = {
      recordType: EVIDENCE_INCIDENT_RECORD_TYPE, schemaVersion: 1, logEntryId: String(entry.id), class: outcomeClass,
      category: entry.category, trigger: entry.trigger, caughtBy: caughtBy(entry.trigger), occurredAt: new Date(entry.occurred_at).toISOString(),
      cardId: entry.card_id, zoneId: entry.zone_id, revisionBefore: entry.revision_before ?? null, revisionAfter: entry.revision_after ?? null,
      claimId, claimBefore: claims.before, claimAfter: claims.after,
      sourceChanges: (Array.isArray(entry.refs?.sourceChanges) ? entry.refs.sourceChanges : []).slice(0, SOURCE_CHANGE_LIMIT)
        .map((/** @type {any} */ change) => ({ kind: text(change?.kind, 40), identifier: text(change?.identifier, 300) })),
      card: card ? { title: text(card.title, 300), zoneKind: card.zone_kind, visibility: card.zone_visibility, producerKind, originality: card.originality ?? null } : null,
      produced: { runId: text(card?.lineage?.runId, 128), capabilityId: observation.capabilityId ?? null, resultVersionId: text(card?.lineage?.resultVersionId, 128) },
      exportable, exportedAt: null,
      observation: { state: observation.state, ...("reason" in observation ? { reason: observation.reason } : {}), ...("methods" in observation ? { methods: observation.methods, handbooks: observation.handbooks } : {}) },
      createdAt: now().toISOString(),
    };
    try {
      await documents.put(owner.userId, "knowledge", id, payload, { expectedRevision: 0, projectId: owner.projectId });
    } catch (error) {
      // Already there: a replay of an entry whose incident was written before the cursor moved.
      if (/** @type {any} */ (error)?.code !== "product_revision_conflict") throw error;
      return;
    }
    counters.incidents[outcomeClass] += 1;
    if (exportable) counters.incidentsExportable += 1;
  }

  /** One pass over the entries since the cursor. Never throws: the learning worker's housekeeping goes on. */
  async function tick() {
    let state = null;
    try {
      state = await lease();
      if (!state) return { read: 0, leased: false };
      counters.ticks += 1;
      const rows = (await database.query(
        "SELECT * FROM evimed_frontier.evidence_change_log WHERE id>$1 AND category IN ('correction','withdrawal') ORDER BY id LIMIT $2", [state.cursor, size])).rows;
      const failures = { ...(state.payload?.failures ?? {}) };
      let cursor = state.cursor;
      for (const entry of rows) {
        try {
          await handle(entry);
          delete failures[String(entry.id)];
        } catch (error) {
          const attempts = Number(failures[String(entry.id)] ?? 0) + 1;
          report?.(typeof error?.code === "string" ? `evidence_outcome_${error.code}` : "evidence_outcome_failed");
          if (attempts < MAX_ENTRY_ATTEMPTS) { failures[String(entry.id)] = attempts; break; }
          counters.abandoned += 1;
          delete failures[String(entry.id)];
        }
        counters.entriesRead += 1;
        cursor = Number(entry.id);
      }
      await release({ cursor, payload: { ...state.payload, failures } });
      state = null;
      return { read: rows.length, leased: true };
    } catch (error) {
      report?.(typeof /** @type {any} */ (error)?.code === "string" ? `evidence_outcome_${/** @type {any} */ (error).code}` : "evidence_outcome_tick_failed");
      return { read: 0, leased: false };
    } finally {
      // A lease this tick took and could not hand back lapses by its own time; nothing here waits on it.
      if (state) await release(state).catch(() => {});
    }
  }

  /**
   * The incidents an export has not taken yet, oldest first. Only exportable ones; a platform-visible card's incident never appears.
   * @param {{ limit?: number }} [options]
   */
  async function pendingExports({ limit = 100 } = {}) {
    const owner = await ensureOwner();
    const page = await documents.list(owner.userId, "knowledge", { limit: Math.max(1, Math.min(100, limit)), projectId: owner.projectId,
      filter: { recordType: EVIDENCE_INCIDENT_RECORD_TYPE, exportable: true, exportedAt: null } });
    return page.items.slice().reverse();
  }

  return { tick, pendingExports, stats: () => ({ ...counters, incidents: { ...counters.incidents }, observations: { ...counters.observations }, skippedBecause: { ...counters.skippedBecause } }) };
}

/**
 * The consumer's counters for the operator's metrics endpoint: nothing while it is not composed.
 * @param {ReturnType<ReturnType<typeof createEvidenceOutcomes>["stats"]> | null | undefined} stats
 * @returns {Array<{ name: string, help: string, type: "counter", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function evidenceOutcomeMetricFamilies(stats) {
  if (!stats) return [];
  return [
    { name: "open_science_learning_evidence_incidents_total", type: "counter", help: "Incident documents the learning loop wrote for corrections and withdrawals of published evidence cards, by closed class.",
      series: EVIDENCE_INCIDENT_CLASSES.map((name) => ({ value: stats.incidents[name] ?? 0, labels: { class: name } })) },
    { name: "open_science_learning_evidence_observations_total", type: "counter", help: "Method observations attached for those outcomes: recorded, already recorded, skipped (with the reason in the skipped-by-reason series) or failed.",
      series: EVIDENCE_OBSERVATION_OUTCOMES.map((name) => ({ value: stats.observations[name] ?? 0, labels: { outcome: name } })) },
    { name: "open_science_learning_evidence_observations_skipped_total", type: "counter", help: "Observations not attached, by the reason: no researcher's method to observe, a source change, learning off.",
      series: Object.entries(stats.skippedBecause).map(([reason, value]) => ({ value, labels: { reason } })) },
    { name: "open_science_learning_evidence_outcomes_total", type: "counter", help: "Change-log entries the outcome consumer read, entries it gave up on after repeated failures, entries that were not outcomes it learns from, and incidents a card's visibility allows to be exported as eval cases.",
      series: [{ value: stats.entriesRead, labels: { kind: "read" } }, { value: stats.abandoned, labels: { kind: "abandoned" } }, { value: stats.unclassified, labels: { kind: "unclassified" } }, { value: stats.incidentsExportable, labels: { kind: "exportable_incident" } }] },
  ];
}
