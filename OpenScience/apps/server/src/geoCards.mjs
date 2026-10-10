/**
 * 「循证 GEO」's product zone and the cards its verified claims become (flywheel F21, F28, 2026-10-06).
 *
 * Hidden knowledge:
 *
 * - **One zone per project, made when first needed.** A GEO project's cards live in a product zone its owner holds in the
 *   evidence zones (`kind: product`). The zone's id comes from a request identity derived from the project, so two callers
 *   racing to make it get the same zone; the project row keeps the id (`product_zone_id`, unique) and a zone the owner
 *   deleted is made again. A zone is made a draft: reading it on the open internet is the owner's separate click, as for
 *   every zone.
 * - **The project keeps its claim table.** `evimed_geo.claims` stays the working index a run writes (the page, `geo_read`
 *   and the articles' `claimIds` all read it); this module additionally writes the claims the card ruler verifies into the
 *   cards and records, on each claim row, the card, the card's own claim id and the card revision it became. A claim the
 *   same ruler marks ⚠ is not written; it stays in the project and is reported as held, with the reason.
 * - **The ruler reads the real source.** A claim's quotation is looked for in the preserved source file the claim names
 *   (`artifactPath`, read from the project's workspace without following links). A claim whose file cannot be read is
 *   `source_unavailable` and held — a card never carries the quotation as its own source, which would make its ✓ say
 *   nothing. Held for that reason it keeps its place in the project's record of which card holds it (nothing was found against
 *   it, and the judge keeps holding answers to it); a claim whose quotation the ruler read and did not find, or that is no longer
 *   active, loses its place. A card whose claims no longer name it is found by the identity it was made with.
 * - **Writes are origin `geo`.** Through `EvidenceZoneService.saveEditorial(…, "geo")`, which a product zone accepts from its
 *   owner and nobody else (`evidenceWriteAllowed`). The card is written as the project's account; it stays a draft until the
 *   owner publishes it.
 * - **Idempotent by content.** The plan is a pure function of the claims, so a card already as planned is left alone: no new
 *   revision, no new notice. A card that was taken back (`withdrawn`) is not written again.
 * - **A group's card is the one its identity names.** The card of a group (a journey stage and a clinical question) is made with a
 *   request identity that is a function of the project and the group, and the zone derives the card's id from it; every refresh finds
 *   the card there. The mapping on the claim rows is the record of where a claim was written and nothing the card is found by: a
 *   claim that changes group still names the card it left, and is written into the card of its new group, which is made if it is not
 *   there. A group left with no claim keeps the card it had, as its owner has it.
 * - **The lower layers cite the cards.** `checkText` reads the claim references of an article's text and resolves each against
 *   the card revision it names — the project's own cards, or a published card of an official zone — by the domain's one rule
 *   (`geoReferenceGraph`); `staleReferences` asks the zone's change log whether a cited card was corrected, updated in its
 *   conclusion or withdrawn since. Both only label: the article is shown "被引结论已更新", never withheld.
 * - **The card layer is the card.** For each card with a written public view the project holds one article of the card layer,
 *   made from the card and carrying no text of its own: its text is `geoCardLayerMarkdown` over `evidenceCardPublicView`, read
 *   when it is wanted, and the row records only the hash of that rendering and the card revision it was made from, so a
 *   corrected card is a changed article. The pharmacists' safety rules run over the rendering, as over any article.
 * - **A refusal is for one operation.** No producer, or no named reviewer, refuses the card write with a named code and
 *   nothing else: the claims, the run and every other page of the project are untouched. One card the zone service refuses
 *   is reported and the others are written.
 *
 * @module geoCards
 */

import { createHash } from "node:crypto";
import {
  evidenceCardPublicView, geoCardLayerMarkdown, geoCardPlan, geoCardProducer, geoClaimReferenceMarker, geoDisclosurePerson, geoReferenceGraph, geoStaleReferences,
  parseGeoClaimReferences, verifyEvidenceCardClaims,
} from "@evimed/domain";
import { clinicalSafetyRuleHits } from "@evimed/domain/clinical-evidence";
import { readEvidenceChangeLog } from "./evidenceChangeLog.mjs";
import { evidenceCardId } from "./evidenceZoneService.mjs";
import { HttpError } from "./security.mjs";

/** The longest preserved source text a card keeps (the zone service's own bound). */
const MAX_SOURCE_TEXT = 2_000_000;

/** @param {number} status @param {string} code @param {string} message */
const failure = (status, code, message) => new HttpError(status, code, message);
/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** The request identity a group's card is made with: a function of the project and the group. @param {string} projectId @param {string} groupKey */
const cardRequestId = (projectId, groupKey) => `gc-${sha256(`${projectId}\0${groupKey}`).slice(0, 40)}`;
/**
 * Why the ruler held a claim for a moment rather than for good: it could not read the source file this time, which says nothing about
 * the claim. Every other reason is about the claim itself.
 */
const HELD_FOR_NOW = new Set(["source_unavailable"]);

/**
 * A value in the one form two equal values share, for comparing a stored card with a planned one: object keys sorted, so
 * what JSONB reordered and what the plan wrote in another order read alike.
 * @param {any} value @returns {any}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
/** @param {unknown} value @param {unknown} other */
const same = (value, other) => JSON.stringify(canonical(value ?? null)) === JSON.stringify(canonical(other ?? null));

/**
 * What a card is, for deciding whether a write would change it: the scientific payload and who is named, never the times it
 * was generated or last checked.
 * @param {any} card
 */
function comparable(card) {
  return {
    title: card.title,
    claims: card.claims ?? [],
    // A source is the text the platform read: a source with no public address keeps only the passages its claims quote, and its
    // read receipt (`fetchedSha256`) is what still names the whole text (EvidenceZoneService, 2026-10-06).
    sources: (card.sources ?? []).map((/** @type {any} */ source) => [source.title, source.url ?? null, source.fetchedSha256 ?? source.sha256 ?? sha256(String(source.documentText ?? source.excerpt ?? ""))]),
    journeyStage: card.journeyStage ?? null,
    producer: card.producer ?? null,
    authors: card.disclosure?.authors ?? [],
    reviewers: card.disclosure?.reviewers ?? [],
    publicView: card.publicView ?? null,
    content: card.content ?? null,
  };
}

export class GeoCards {
  /**
   * @param {{ store: import("./geoStore.mjs").GeoStore, zones: { saveEditorial: Function, save: Function, ready: () => Promise<unknown> } | null,
   *   database: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> },
   *   people?: ((project: any, actor: { id: string, name?: string }) => Promise<{ authors: { name: string }[], reviewers: { name: string }[] }>) | null,
   *   ownerName?: ((userId: string) => Promise<string | null>) | null, now?: () => Date, report?: (code: string) => void }} options
   *   `zones` is the evidence zone service, or null where the evidence zones are not composed (every call then answers
   *   `geo_cards_unavailable`). `people` names the authors and the reviewers a card discloses; without it the project's owner is
   *   the author, and a doctor project's doctor is also its reviewer.
   */
  constructor({ store, zones, database, people = null, ownerName = null, now = () => new Date(), report = () => {} }) {
    if (!store || !database) throw new TypeError("The GEO cards need the GEO store and the database.");
    this.store = store;
    this.zones = zones;
    this.database = database;
    this.people = people;
    this.ownerName = ownerName;
    this.now = now;
    this.report = report;
    this.counters = { zonesMade: 0, cardsCreated: 0, cardsUpdated: 0, cardsUnchanged: 0, claimsHeld: 0, claimsCarded: 0, refused: 0,
      referencesChecked: 0, referencesUnresolved: 0, articlesFlagged: 0 };
  }

  /** The zone service, or the named refusal. */
  #zones() {
    if (!this.zones) throw failure(503, "geo_cards_unavailable", "The evidence zones are not composed on this deployment.");
    return this.zones;
  }

  /**
   * The product zone of a project, made when it is first needed. The same project always gets the same zone.
   * @param {{ id: string, userId: string, product?: Record<string, any>, productZoneId?: string | null }} project
   * @returns {Promise<{ id: string, created: boolean }>}
   */
  async ensureProductZone(project) {
    const zones = this.#zones();
    await zones.ready();
    const owner = { id: project.userId };
    if (project.productZoneId) {
      const row = (await this.database.query("SELECT id FROM evimed_frontier.evidence_zones WHERE id = $1 AND user_id = $2 AND kind = 'product'", [project.productZoneId, project.userId])).rows[0];
      if (row) return { id: String(row.id), created: false };
    }
    const brand = project.product?.brandName || project.product?.genericName || "";
    const made = await zones.save(owner, {
      title: `${brand || "产品"} · 产品专区`.slice(0, 300),
      description: `${brand ? `${brand}的` : ""}证据：每条结论都带原文引文，由出品方署名。`.slice(0, 1000),
      background: "",
      kind: "product",
      // The identity makes the zone a function of the project: a second caller finds the first one's zone.
      requestId: `gz-${project.id}`,
    }, null, null, false, null);
    const zoneId = String(made.zone.id);
    await this.store.setProductZoneId(project.userId, project.id, zoneId);
    this.counters.zonesMade += 1;
    return { id: zoneId, created: true };
  }

  /**
   * The people a card discloses.
   * @param {any} project @param {{ id: string, name?: string }} actor
   */
  async #peopleOf(project, actor) {
    if (this.people) return this.people(project, actor);
    const name = (project.producer?.kind === "doctor" ? project.producer?.name : null) ?? await this.ownerName?.(project.userId) ?? null;
    if (!name) return { authors: [], reviewers: [] };
    const person = geoDisclosurePerson({ name, ...(project.producer?.kind === "doctor" ? {
      hospital: project.producer.hospital, department: project.producer.department, specialty: project.producer.specialty, title: project.producer.title } : {}) });
    // A doctor stands behind their own content as its author and its reviewer; a company names a reviewing doctor separately.
    return { authors: [person], reviewers: project.producer?.kind === "doctor" ? [person] : [] };
  }

  /**
   * What a card of this project needs before it can be written: someone who speaks for the product, and a named author and
   * reviewing doctor. The one place both checks are made, for the write and for the question of why nothing was written.
   * @param {any} project @param {{ id: string, name?: string }} actor
   * @returns {Promise<{ blockedBy: "producer" | "reviewer" | null, producer: any, people: any }>}
   */
  async #readiness(project, actor) {
    const producer = geoCardProducer(project.producer, project.product);
    if (!producer) return { blockedBy: "producer", producer: null, people: null };
    const people = await this.#peopleOf(project, actor);
    if (!people.authors.length || !people.reviewers.length) return { blockedBy: "reviewer", producer, people };
    return { blockedBy: null, producer, people };
  }

  /**
   * Why this project's cards cannot be written now, or null when they can: `producer` (nobody is named as speaking for the product)
   * or `reviewer` (no named author and reviewing doctor). Asked without writing and without counting a refusal — the project's page
   * reads it to say what is left to set up, where the run-end import used to leave it in a log (D-28).
   * @param {any} project @param {{ id: string, name?: string }} [actor]
   * @returns {Promise<"producer" | "reviewer" | null>}
   */
  async blockedBy(project, actor = { id: project.userId }) {
    return (await this.#readiness(project, actor)).blockedBy;
  }

  /**
   * Write the project's verified claims into its product zone as cards, one per key clinical question on the patient journey.
   *
   * @param {any} project the GEO project
   * @param {{ readSource: (claim: { artifactPath: string | null, claimKey: string }) => Promise<string | null>, actor?: { id: string, name?: string } }} options
   *   `readSource` reads a claim's preserved source file from the project's workspace; it answers null for a file it cannot read.
   * @returns {Promise<{ zoneId: string, cards: Array<{ cardId: string, revision: number, journeyStage: { key: string, label: string },
   *   title: string, change: "created" | "updated" | "unchanged", claims: number, articleId: string | null }>,
   *   held: Array<{ claimKey: string, claimId: string, reason: string, message: string }>,
   *   failed: Array<{ title: string, code: string }>, skipped: Array<{ title: string, reason: string }> }>}
   */
  async refresh(project, { readSource, actor = { id: project.userId } }) {
    const ready = await this.#readiness(project, actor);
    if (ready.blockedBy === "producer") {
      this.counters.refused += 1;
      throw failure(409, "geo_card_producer_required", "The project does not say who speaks for the product (an enterprise or a doctor).");
    }
    if (ready.blockedBy === "reviewer") {
      this.counters.refused += 1;
      throw failure(409, "geo_card_reviewer_required", "A product card names its author and a reviewing doctor.");
    }
    const { producer, people } = ready;
    const claims = await this.store.listClaims(project.id);
    /** @type {Map<string, Promise<string | null>>} */
    const reads = new Map();
    const textOf = (/** @type {any} */ claim) => {
      if (!claim.artifactPath) return Promise.resolve(null);
      const cached = reads.get(claim.artifactPath);
      if (cached) return cached;
      const read = Promise.resolve(readSource(claim)).then((value) => (typeof value === "string" && value.length <= MAX_SOURCE_TEXT && !value.includes("\0") ? value : null)).catch(() => null);
      reads.set(claim.artifactPath, read);
      return read;
    };
    const enriched = [];
    for (const claim of claims) enriched.push({ ...claim, sourceText: await textOf(claim) });
    const now = this.now();
    const plan = geoCardPlan({ claims: enriched, producer, authors: people.authors, reviewers: people.reviewers, entityKeys: project.entityKeys ?? [], now });
    const zone = await this.ensureProductZone(project);
    const zones = this.#zones();
    const owner = { id: project.userId };
    /** @type {Array<{ cardId: string, revision: number, journeyStage: any, title: string, change: "created" | "updated" | "unchanged", claims: number, articleId: string | null }>} */
    const cards = [];
    /** @type {Array<{ title: string, code: string }>} */
    const failed = [];
    /** @type {Array<{ title: string, reason: string }>} */
    const skipped = [];
    for (const card of plan.cards) {
      // A group's card is the one its identity names, never one a claim's mapping points to: the mapping is the record of where a
      // claim was written, and a claim that changed group still names the card it left (two groups found one card by it and wrote
      // over each other on every refresh).
      const requestId = cardRequestId(project.id, card.groupKey);
      const existing = await this.#cardRow(zone.id, project.userId, evidenceCardId(project.userId, requestId));
      if (existing?.withdrawn) { skipped.push({ title: card.payload.title, reason: "card_withdrawn" }); continue; }
      try {
        let cardId = existing?.id ?? null;
        let revision = existing?.revision ?? 0;
        /** @type {"created" | "updated" | "unchanged"} */
        let change = "unchanged";
        if (!existing || !same(comparable(existing), comparable({ ...card.payload, sources: card.payload.sources.map((/** @type {any} */ source) => ({ ...source, sha256: sha256(source.documentText) })) }))) {
          const body = existing ? { ...card.payload, expectedRevision: existing.revision }
            : { ...card.payload, requestId };
          const saved = await zones.saveEditorial(owner, body, zone.id, existing?.id ?? null, true, "geo");
          cardId = String(saved.evidence.id);
          revision = Number(saved.evidence.revision);
          change = existing ? "updated" : "created";
        }
        if (change === "created") this.counters.cardsCreated += 1;
        else if (change === "updated") this.counters.cardsUpdated += 1;
        else this.counters.cardsUnchanged += 1;
        const marks = card.map.map((entry) => ({ id: entry.claimId, cardId: /** @type {string} */ (cardId), cardClaimId: entry.cardClaimId, cardRevision: revision }));
        this.counters.claimsCarded += await this.store.markClaimsCarded(project.id, marks);
        // The project as it is now: the zone it was just given is where the card is read back from.
        const article = await this.#syncCardArticle({ ...project, productZoneId: zone.id }, /** @type {string} */ (cardId), card.map.map((entry) => entry.claimId));
        cards.push({ cardId: /** @type {string} */ (cardId), revision, journeyStage: card.journeyStage, title: card.payload.title, change, claims: card.map.length,
          articleId: article?.id ?? null });
      } catch (error) {
        const code = typeof (/** @type {any} */ (error))?.code === "string" ? /** @type {any} */ (error).code : "geo_card_write_failed";
        failed.push({ title: card.payload.title, code });
        this.report(code);
      }
    }
    // A claim the ruler no longer verifies is no longer in its card's plan, so the card above was brought to the claims that
    // stand; here its mapping is cleared. A group left with no claim at all has no plan, and its card stays as its owner has it.
    // A claim held only because its source file could not be read this time keeps its place: nothing was found against it.
    const heldIds = plan.held.filter((entry) => !HELD_FOR_NOW.has(entry.reason)).map((entry) => entry.claimId);
    if (heldIds.length) await this.store.clearClaimCards(project.id, heldIds);
    this.counters.claimsHeld += plan.held.length;
    return { zoneId: zone.id, cards, held: plan.held, failed, skipped };
  }

  /**
   * One card of the project's zone as the project reads it, or null.
   * @param {string} zoneId @param {string} userId @param {string} cardId
   */
  async #cardRow(zoneId, userId, cardId) {
    const row = (await this.database.query(`SELECT id, revision, state, title, claims, sources, journey_stage, producer, disclosure, public_view, content, withdrawn
      FROM evimed_frontier.evidence_cards WHERE id = $1 AND zone_id = $2 AND user_id = $3`, [cardId, zoneId, userId])).rows[0];
    if (!row) return null;
    return { id: String(row.id), revision: Number(row.revision), state: String(row.state), title: row.title, claims: row.claims ?? [], sources: row.sources ?? [],
      journeyStage: row.journey_stage ?? null, producer: row.producer ?? null, disclosure: row.disclosure ?? null, publicView: row.public_view ?? null,
      content: row.content ?? null, withdrawn: row.withdrawn ?? null };
  }

  /**
   * The cards of a project's product zone as a run or a page reads them: each with its journey stage, its revision and every
   * claim with its quotation and its ✓/⚠ against the card's own sources. Nothing of another account's is here: the read is
   * keyed by the project's owner and its zone.
   * @param {any} project
   */
  async list(project) {
    if (!project.productZoneId) return { zoneId: null, cards: [] };
    const rows = (await this.database.query(`SELECT id, revision, state, title, claims, sources, journey_stage, producer, disclosure, withdrawn, updated_at
      FROM evimed_frontier.evidence_cards WHERE zone_id = $1 AND user_id = $2 ORDER BY created_at, id LIMIT 200`, [project.productZoneId, project.userId])).rows;
    const keyOf = new Map((await this.store.listClaims(project.id)).filter((claim) => claim.cardId).map((claim) => [`${claim.cardId}\0${claim.cardClaimId}`, claim]));
    return {
      zoneId: String(project.productZoneId),
      cards: rows.map((row) => {
        const withdrawn = row.withdrawn && typeof row.withdrawn === "object";
        const verdict = verifyEvidenceCardClaims({ claims: row.claims ?? [], sources: row.sources ?? [] });
        const marks = new Map(verdict.claims.map((entry) => [entry.claimId, entry.mark]));
        return {
          id: String(row.id),
          revision: Number(row.revision),
          state: String(row.state),
          title: String(row.title),
          journeyStage: row.journey_stage ?? null,
          producer: row.producer ?? null,
          withdrawn: withdrawn ? { at: row.withdrawn.at ?? null, reason: String(row.withdrawn.reason ?? "") } : null,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
          // A card taken back keeps its page but no claim of it stands as evidence.
          claims: withdrawn ? [] : (row.claims ?? []).map((/** @type {any} */ claim) => {
            const geo = keyOf.get(`${row.id}\0${claim.claimId}`);
            return {
              claimId: String(claim.claimId),
              // What to write after a sentence that stands on this claim: made here, so a run never types a card or claim id.
              reference: geoClaimReferenceMarker({ cardId: String(row.id), claimId: String(claim.claimId), revision: Number(row.revision) }),
              claimKey: geo?.claimKey ?? null,
              statement: String(claim.claim),
              quote: claim.supportQuote ?? null,
              mark: marks.get(claim.claimId) ?? "⚠",
              comparisonType: geo?.comparisonType ?? null,
              applicability: claim.applicability ?? null,
            };
          }),
        };
      }),
    };
  }

  /**
   * The card as a reader of the page sees it, with the sources it carries: the current row, or the snapshot of an earlier revision.
   * The project's own cards and the published cards of an official zone can be cited; no other account's card can.
   * @param {{ id: string, userId: string, productZoneId?: string | null }} project @param {string} cardId @param {number | null} revision
   */
  async #cardAt(project, cardId, revision) {
    const row = (await this.database.query(`SELECT c.id, c.revision, c.title, c.claims, c.sources, c.journey_stage, c.producer, c.disclosure, c.public_view,
        c.content, c.originality, c.withdrawn
      FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id = c.zone_id
      WHERE c.id = $1 AND ((c.zone_id = $2 AND c.user_id = $3) OR (z.kind = 'official' AND z.state = 'published' AND c.state = 'published'))`,
    [cardId, project.productZoneId ?? "", project.userId])).rows[0];
    if (!row) return null;
    let at = row;
    if (revision != null && Number(row.revision) !== revision) {
      const snapshot = (await this.database.query("SELECT snapshot FROM evimed_frontier.evidence_card_revisions WHERE card_id = $1 AND revision = $2", [cardId, revision])).rows[0]?.snapshot;
      at = snapshot ?? null;
    }
    return { current: row, at };
  }

  /**
   * What the cards say about each reference of a text, as the domain's `geoReferenceGraph` reads it.
   * @param {any} project @param {{ cardId: string, claimId: string, revision: number }[]} references
   * @returns {Promise<(reference: { cardId: string, claimId: string, revision: number }) => any>}
   */
  async #resolver(project, references) {
    /** @type {Map<string, any>} */
    const lookups = new Map();
    for (const { cardId, revision } of references) {
      const key = `${cardId}@${revision}`;
      if (lookups.has(key)) continue;
      const found = await this.#cardAt(project, cardId, revision);
      if (!found) { lookups.set(key, null); continue; }
      const claims = found.at?.claims;
      if (!Array.isArray(claims)) { lookups.set(key, { currentRevision: Number(found.current.revision), withdrawn: Boolean(found.current.withdrawn), claims: null }); continue; }
      const verdict = verifyEvidenceCardClaims({ claims, sources: found.at.sources ?? [] });
      const marks = new Map(verdict.claims.map((entry) => [entry.claimId, entry.mark]));
      lookups.set(key, {
        currentRevision: Number(found.current.revision),
        withdrawn: Boolean(found.current.withdrawn),
        claims: Object.fromEntries(claims.map((/** @type {any} */ claim) => [String(claim.claimId),
          { claim: String(claim.claim), supportQuote: claim.supportQuote ?? null, applicability: claim.applicability ?? null, mark: marks.get(claim.claimId) ?? "⚠" }])),
      });
    }
    return (reference) => lookups.get(`${reference.cardId}@${reference.revision}`) ?? null;
  }

  /**
   * The reference graph of a text against the cards of a project (`geoReferenceGraph`), and the status an article carries for it:
   * `none` when it cites nothing, `resolved` when every reference resolves, `unresolved` when one does not.
   * @param {any} project @param {{ text: string, layer: string }} input
   */
  async checkText(project, { text, layer }) {
    const references = parseGeoClaimReferences(text);
    const resolve = await this.#resolver(project, references);
    const graph = geoReferenceGraph({ text, layer, resolve });
    this.counters.referencesChecked += 1;
    if (!graph.ok) this.counters.referencesUnresolved += 1;
    const status = !references.length && !graph.counts.malformed ? "none" : graph.ok ? "resolved" : "unresolved";
    return { status, graph, references: [...new Set(references.map(({ cardId, claimId, revision }) => `${cardId}\0${claimId}\0${revision}`))]
      .map((key) => { const [cardId, claimId, revision] = key.split("\0"); return { cardId, claimId, revision: Number(revision) }; }) };
  }

  /**
   * Read an article's references and record the finding on the article: the references, the status, and the hash of the text read.
   * @param {any} project @param {{ id: string, layer: string | null }} article @param {string} text
   */
  async checkArticle(project, article, text) {
    const result = await this.checkText(project, { text, layer: String(article.layer ?? "") });
    await this.store.setArticleReferences(project.id, article.id, { refs: result.references, status: result.status, sha256: sha256(text) });
    return result;
  }

  /**
   * The articles that cite a claim of a card revision since corrected, updated in its conclusion or withdrawn, by the zone's own
   * change log (`readEvidenceChangeLog`): article id to the references that moved. A notice for the project's page.
   * @param {any} project @param {Array<{ id: string, claimRefs?: Array<{ cardId: string, claimId: string, revision: number }> }>} articles
   * @returns {Promise<Map<string, Array<{ cardId: string, claimId: string, revision: number, category: string, occurredAt: string, summary: string }>>>}
   */
  async staleReferences(project, articles) {
    /** @type {Map<string, any[]>} */
    const out = new Map();
    const cardIds = [...new Set(articles.flatMap((article) => (article.claimRefs ?? []).map((reference) => reference.cardId)))].slice(0, 40);
    if (!cardIds.length) return out;
    /** @type {any[]} */
    const entries = [];
    for (const cardId of cardIds) {
      try { entries.push(...(await readEvidenceChangeLog(this.database, { cardId, limit: 100 })).items); } catch { /* a log that cannot be read leaves the article unflagged, not blocked */ }
    }
    for (const article of articles) {
      const stale = geoStaleReferences(article.claimRefs ?? [], entries.map((entry) => ({ cardId: entry.cardId, category: entry.category, revisionAfter: entry.revisionAfter,
        occurredAt: entry.occurredAt, summary: entry.summary, refs: entry.refs })));
      if (stale.length) out.set(article.id, stale);
    }
    this.counters.articlesFlagged += out.size;
    return out;
  }

  /**
   * The text of a card-layer article: the card's public view in Markdown, rendered now from the card's current revision.
   * @param {any} project @param {{ cardId: string | null }} article @returns {Promise<{ markdown: string, revision: number, title: string } | null>}
   */
  async cardLayerText(project, article) {
    if (!article.cardId) return null;
    const found = await this.#cardAt(project, article.cardId, null);
    if (!found || found.current.withdrawn) return null;
    return this.#render(found.current);
  }

  /** @param {any} row */
  #render(row) {
    const card = { title: row.title, producer: row.producer, originality: row.originality, journeyStage: row.journey_stage, disclosure: row.disclosure,
      claims: row.claims ?? [], sources: row.sources ?? [], content: row.content, publicView: row.public_view };
    const view = evidenceCardPublicView(card);
    const markdown = geoCardLayerMarkdown({ view: /** @type {any} */ (view), card: { id: String(row.id), revision: Number(row.revision) } });
    return { markdown, revision: Number(row.revision), title: String(row.title), written: view.panels.some((/** @type {any} */ panel) => panel.status === "written" && panel.key !== "sourcesAndCheckDate") };
  }

  /**
   * The card-layer article of a card, brought to the card's current text. A card whose public view has nothing written has none:
   * a heading and a producer are not an article. The pharmacists' safety rules decide whether it waits for a person.
   * @param {any} project @param {string} cardId @param {string[]} claimIds
   */
  async #syncCardArticle(project, cardId, claimIds) {
    const found = await this.#cardAt(project, cardId, null);
    if (!found) return null;
    const rendered = this.#render(found.current);
    if (!rendered.written) return null;
    const hits = clinicalSafetyRuleHits({ reportText: rendered.markdown, practical: rendered.markdown });
    return this.store.upsertCardArticle(project.userId, project.id, {
      cardId, cardRevision: rendered.revision, title: rendered.title, claimIds, contentSha256: sha256(rendered.markdown), safety: hits.length ? "open" : "clear",
    });
  }

  /** What the operator metrics read. */
  metrics() {
    return { ...this.counters };
  }
}
