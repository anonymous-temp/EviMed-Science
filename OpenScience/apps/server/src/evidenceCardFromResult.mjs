/**
 * 「发布为证据卡」 (evidence-flywheel plan §5.2, F05, 2026-10-05): one result version of a clinical package becomes a
 * draft evidence card in a zone its researcher owns.
 *
 * Hidden knowledge:
 *
 * - **A draft, written by the result's own writer.** The card goes through `EvidenceZoneService.saveEditorial` with
 *   origin `result` (a user zone accepts it from its owner and nobody else) as a draft. Publishing is the
 *   researcher's own existing click on the card, and opening the zone to the internet is the separate visibility
 *   action; nothing here approves, schedules or publishes anything.
 * - **What the card carries is what the result already proved.** The claims are the evidence matrix's, with the
 *   verdict the run's gate stored at capture (verified claims by default; an unverified one only when the caller
 *   names it). Every number a card shows is computed from events and denominators by the domain, and a comparison
 *   row exists only where the matrix itself carries them — none is invented. Each claim's sources become card
 *   sources with the preserved text, its hash and a short public excerpt, because that preserved text is what the
 *   card's own ✓/⚠ is computed against.
 * - **A restricted source gives its citation and nothing else.** The result's own read refuses to hand its owner a
 *   quotation from a source the project can no longer authorize (`ResultProvenanceService.raw`); the card follows
 *   the same rule per source, so a restricted source is cited by title and address with no preserved text and no
 *   quotation. The claim stays; its card mark says ⚠ because a reader cannot check what the card does not show.
 * - **Idempotent by lineage.** The same result version published twice is the same draft. A newer version of the
 *   same artifact is offered as a new draft that names the earlier card as its `previousCardId`: the earlier card
 *   may be live, and a re-run must never rewrite what readers are reading. When the research began from a card
 *   (`originCardId`, F06), the new card says so; if that card is the researcher's own, it is also offered as that
 *   card's next version.
 * - **Refusals are named and touch this one request.** A result that is not a clinical package, no verified claim,
 *   a zone that is not the caller's or is not a user zone — each its own code, none a verdict on the run.
 *
 * @module evidenceCardFromResult
 */

import { createHash } from "node:crypto";
import {
  EVIDENCE_AI_STEPS,
  EVIDENCE_CLAIM_LIMIT,
  doiOf,
  evidenceCardClaims,
  evidencePublicExcerpt,
  evidenceValueSourceIssues,
  verifyEvidenceCardClaims,
} from "@evimed/domain";
import { claimEvidenceSources, claimVerification } from "@evimed/domain/clinical-evidence";
import { evidenceContract, evidenceStructuredContent } from "./evidenceCardContent.mjs";
import { recordEvidenceSimulatedRefused } from "./evidenceCardMetrics.mjs";
import { evidenceSourceUrl } from "./evidenceZoneService.mjs";
import { recordResultCard } from "./evidencePublishMetrics.mjs";
import { HttpError, assertObject } from "./security.mjs";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ZONE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const CARD_ID = /^ec_[A-Za-z0-9]{8,64}$/;
const REQUEST_FIELDS = ["projectId", "zoneId", "newZone", "claimIds"];
/** The matrix a card is built from is read whole; a larger one is not a package a person wrote. */
const MAX_MATRIX_BYTES = 8 * 1024 * 1024;
const MAX_MATRIX_CLAIMS = 500;
/** The longest preserved text a card source keeps (the zone service's own bound); a longer source is cited with its excerpt. */
const MAX_SOURCE_TEXT = 2_000_000;
const MAX_CARD_SOURCES = 50;

/**
 * Why a claim of the matrix did not reach the card. Reported with the card so the dialog can say what was left out and
 * why; none of them stops the card.
 */
export const RESULT_CARD_OMISSIONS = Object.freeze({
  claim_id_unusable: "结论编号不符合证据卡的格式",
  claim_text_too_long: "结论文字超过证据卡的长度上限",
  source_not_citable: "来源没有可引用的标题或地址",
  synthesis_needs_two_sources: "综合结论需要至少两个可引用的来源",
  synthesis_confidence_missing: "综合结论没有置信度标注",
  derived_fields_missing: "推算结论缺少方法、假设或敏感性说明",
  derived_inputs_missing: "推算结论依据的结论没有一并选入",
  too_many_claims: "超过一张卡最多 60 条结论的上限",
});

/**
 * What a capability's result is, as a card says it (plan §4.1): the researcher's own analysis of their own data is
 * `original_research`, a recalculation or pooling of published results `original_analysis`, and a synthesis of
 * the literature `synthesis`. A closed map over capability ids; anything not listed — a result whose run cannot be
 * found included — is the humbler `synthesis`, because a clinical package quotes other people's sources.
 */
export const RESULT_ORIGINALITY_BY_CAPABILITY = Object.freeze({
  "clinical-evidence-synthesis": "synthesis",
  "evidence-appraisal": "synthesis",
  "dataset-research-scoping": "original_research",
  "statistical-analysis": "original_research",
  "meta-analysis": "original_analysis",
  "mendelian-randomization": "original_analysis",
});

/**
 * The steps an AI took to make a package of each capability (the RAISE disclosure items), by capability id. A clinical
 * package is made by searching, screening, extracting and synthesizing; the run does not record these one by one,
 * so the capability's own contract is what states them.
 */
export const RESULT_AI_STEPS_BY_CAPABILITY = Object.freeze({
  "clinical-evidence-synthesis": ["search", "screen", "extract", "synthesize"],
});
const DEFAULT_AI_STEPS = RESULT_AI_STEPS_BY_CAPABILITY["clinical-evidence-synthesis"];

/** @param {unknown} capabilityId @returns {string} */
export function resultOriginality(capabilityId) {
  return /** @type {Record<string, string>} */ (RESULT_ORIGINALITY_BY_CAPABILITY)[String(capabilityId ?? "")] ?? "synthesis";
}

/** @param {number} status @param {string} code @param {string} message */
const refusal = (status, code, message) => new HttpError(status, code, message);
/** @param {string} code @param {number} [status] */
const refused = (code, status = 409) => refusal(status, code, `The result cannot become an evidence card (${code}).`);

/**
 * The request, checked field by field. Exactly one of `zoneId` (an own user zone) and `newZone` names the target.
 * @param {unknown} body
 * @returns {{ projectId: string, zoneId: string | null, newZone: { title: string } | null, claimIds: string[] | null }}
 */
export function readResultCardRequest(body) {
  const input = /** @type {Record<string, any>} */ (assertObject(body, "evidence card request"));
  const invalid = (/** @type {string} */ what) => refusal(400, "evidence_result_request_invalid", `Invalid evidence card request: ${what}.`);
  if (Object.keys(input).some((key) => !REQUEST_FIELDS.includes(key))) throw invalid("unsupported field");
  if (typeof input.projectId !== "string" || !PROJECT_ID.test(input.projectId)) throw invalid("projectId");
  const hasZone = input.zoneId != null, hasNew = input.newZone != null;
  if (hasZone === hasNew) throw refusal(400, "evidence_result_zone_required", "Name an own zone or a new one.");
  if (hasZone && (typeof input.zoneId !== "string" || !ZONE_ID.test(input.zoneId))) throw invalid("zoneId");
  /** @type {{ title: string } | null} */
  let newZone = null;
  if (hasNew) {
    const zone = input.newZone;
    if (!zone || typeof zone !== "object" || Array.isArray(zone) || Object.keys(zone).some((key) => key !== "title")
      || typeof zone.title !== "string" || !zone.title.trim() || zone.title.length > 300) throw invalid("newZone");
    newZone = { title: zone.title.trim() };
  }
  /** @type {string[] | null} */
  let claimIds = null;
  if (input.claimIds != null) {
    if (!Array.isArray(input.claimIds) || input.claimIds.some((id) => typeof id !== "string" || !CLAIM_ID.test(id))) throw invalid("claimIds");
    if (input.claimIds.length > EVIDENCE_CLAIM_LIMIT) throw refusal(400, "evidence_result_too_many_claims", "Too many claims for one card.");
    claimIds = [...new Set(/** @type {string[]} */ (input.claimIds))];
  }
  return { projectId: input.projectId, zoneId: hasZone ? input.zoneId : null, newZone, claimIds };
}

/** An address a reader can open for a source the matrix names, or null. @param {any} bond */
export function citationUrl(bond) {
  if (typeof bond?.sourceUrl === "string" && bond.sourceUrl.trim()) {
    try { return evidenceSourceUrl(bond.sourceUrl.trim()); } catch { /* an address the card cannot keep is not one to cite */ }
  }
  const doi = doiOf(bond?.identifier) ?? doiOf(bond?.sourceUrl);
  if (doi) return `https://doi.org/${doi}`;
  const identifier = typeof bond?.identifier === "string" ? bond.identifier.trim() : "";
  const pmid = /^(?:PMID:?\s*)?(\d{1,9})$/i.exec(identifier);
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid[1]}/`;
  const trial = /^(?:registry:\s*)?(NCT\d{8})$/i.exec(identifier);
  if (trial) return `https://clinicaltrials.gov/study/${trial[1].toUpperCase()}`;
  return null;
}

/** @param {unknown} value */
const safeArtifactPath = (value) => (typeof value === "string" && value && !value.startsWith("/") && !value.includes("\\")
  && !value.split("/").includes("..") ? value : null);

/**
 * The identity the result's own input record gives a source: its DOI, else its preserved path
 * (`clinicalResultLinks`). It is how a claim's source finds the reference the capture recorded for it.
 * @param {any} bond @returns {string | null}
 */
export function sourceIdentity(bond) {
  return doiOf(bond?.identifier) ?? doiOf(bond?.sourceUrl) ?? safeArtifactPath(bond?.artifactPath);
}

/** @param {string} value @param {number} max */
const clip = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");
/** @param {any} claim */
const claimTypeOf = (claim) => String(claim?.claimType ?? "direct");

export class EvidenceCardFromResult {
  /**
   * @param {{ database: any, results: any, zones: any, runs?: { list: (project: any) => Promise<any[]> } | null, now?: () => Date }} options
   *   `results` is the `ResultProvenanceService`, `zones` the `EvidenceZoneService`; `runs` is the project's run ledger,
   *   read for the capability that produced the result and for the card the research began from.
   */
  constructor({ database, results, zones, runs = null, now = () => new Date() }) {
    this.database = database;
    this.results = results;
    this.zones = zones;
    this.runs = runs;
    this.now = now;
  }

  /**
   * @param {{ id: string, name?: string }} user @param {string} versionId @param {unknown} body
   * @returns {Promise<{ evidence: any, zone: any, created: boolean, outcome: "created" | "existing" | "next_version", previousCardId: string | null, omitted: { claimId: string, reason: string }[] }>}
   */
  async publish(user, versionId, body) {
    try {
      const answer = await this.#publish(user, versionId, body);
      recordResultCard(answer.outcome);
      return answer;
    } catch (error) {
      recordResultCard("refused");
      throw error;
    }
  }

  /** @param {{ id: string, name?: string }} user @param {string} versionId @param {unknown} body */
  async #publish(user, versionId, body) {
    const input = readResultCardRequest(body);
    await this.zones.ready();
    const project = await this.results.scope(user.id, input.projectId);
    // Another account's version is never here: the read is keyed by the caller's own account and project.
    const version = await this.results.get(user.id, project.id, versionId);
    const review = version.review;
    if (typeof review?.matrixVersionId !== "string" || typeof review?.matrixDigest !== "string") {
      throw refused("evidence_result_not_clinical_package");
    }
    const zone = input.zoneId ? await this.#ownUserZone(user, input.zoneId) : null;
    const existing = await this.#cardOfVersion(user.id, versionId);
    if (existing) {
      const detail = await this.zones.detail(user, existing.zone_id, existing.id);
      const owner = await this.zones.detail(user, existing.zone_id);
      return { evidence: detail.evidence, zone: owner.zone, created: false, outcome: /** @type {const} */ ("existing"), previousCardId: null, omitted: [] };
    }

    const { matrix, matrixVersion } = await this.#readMatrix(user.id, project, review);
    const references = await this.#sourceReferences(user.id, project, matrixVersion);
    const run = await this.#runOf(project, version.producer?.runId);
    const built = await this.#build({ user, version, matrix, references, run, claimIds: input.claimIds, review });

    // What the zone service would refuse is refused here, before a new zone is made for a card that cannot be saved: a
    // simulated value never enters a card (plan §4.3 rule 3), and the claims are checked as the card will hold them.
    const [simulated] = evidenceValueSourceIssues({ claims: built.card.claims, content: built.card.content });
    if (simulated) {
      recordEvidenceSimulatedRefused(simulated.valueSource);
      throw refusal(400, simulated.code, simulated.message);
    }
    evidenceContract(evidenceCardClaims)(built.card.claims, built.card.sources.length);

    const targetZone = zone ?? (await this.zones.save(user, {
      title: /** @type {{ title: string }} */ (input.newZone).title, description: "", background: "",
      requestId: `rz-${createHash("sha256").update(`${versionId}\0${/** @type {{ title: string }} */ (input.newZone).title}`).digest("hex").slice(0, 40)}`,
    })).zone;
    const origin = await this.#originOf(user.id, run);
    const earlier = await this.#earlierCardOfArtifact(user.id, project.id, version) ?? (origin?.own ? origin.cardId : null);
    const lineage = {
      resultVersionId: version.versionId,
      ...(version.producer?.runId ? { runId: version.producer.runId } : {}),
      ...(origin ? { originCardId: origin.cardId } : {}),
      ...(earlier ? { previousCardId: earlier } : {}),
    };
    const card = {
      ...built.card,
      lineage,
      requestId: `rc-${createHash("sha256").update(`${versionId}\0${targetZone.id}`).digest("hex").slice(0, 40)}`,
    };
    const saved = await this.zones.saveEditorial(user, card, targetZone.id, null, true, "result");
    return {
      evidence: saved.evidence, zone: targetZone, created: true,
      outcome: earlier ? /** @type {const} */ ("next_version") : /** @type {const} */ ("created"),
      previousCardId: earlier ?? null, omitted: built.omitted,
    };
  }

  /** The zone the card is written to, which must be the caller's and a user zone. @param {{ id: string }} user @param {string} zoneId */
  async #ownUserZone(user, zoneId) {
    const { zone } = await this.zones.detail(user, zoneId);
    if (zone.kind !== "user") throw refused("evidence_result_zone_kind_refused");
    if (!zone.canEdit) throw refused("evidence_result_zone_not_owned", 403);
    return zone;
  }

  /** The caller's card for this very version, if there is one. @param {string} userId @param {string} versionId */
  async #cardOfVersion(userId, versionId) {
    const { rows } = await this.database.query(
      `SELECT c.id, c.zone_id FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
        WHERE c.user_id=$1 AND z.user_id=$1 AND c.lineage->>'resultVersionId'=$2 ORDER BY c.created_at, c.id LIMIT 1`,
      [userId, versionId],
    );
    return rows[0] ?? null;
  }

  /**
   * The caller's newest card from an earlier version of this artifact: what a newer version follows.
   * @param {string} userId @param {string} projectId @param {any} version
   */
  async #earlierCardOfArtifact(userId, projectId, version) {
    let versions;
    try {
      versions = await this.results.documents.list(userId, "result-version", { projectId, limit: 100,
        filter: { recordType: "result-version", artifactId: version.artifactId } });
    } catch { return null; }
    const ids = versions.items.map((/** @type {any} */ row) => row.payload?.versionId).filter((/** @type {unknown} */ id) => typeof id === "string" && id !== version.versionId);
    if (!ids.length) return null;
    const { rows } = await this.database.query(
      `SELECT c.id FROM evimed_frontier.evidence_cards c JOIN evimed_frontier.evidence_zones z ON z.id=c.zone_id
        WHERE c.user_id=$1 AND z.user_id=$1 AND c.lineage->>'resultVersionId'=ANY($2::text[]) ORDER BY c.created_at DESC, c.id LIMIT 1`,
      [userId, ids],
    );
    return rows[0]?.id ?? null;
  }

  /** @param {any} project @param {unknown} runId */
  async #runOf(project, runId) {
    if (!this.runs || typeof runId !== "string") return null;
    try { return (await this.runs.list(project)).find((/** @type {any} */ run) => run.id === runId) ?? null; } catch { return null; }
  }

  /**
   * The card the research began from, when the run recorded one that still exists: and whether it is the caller's own.
   * @param {string} userId @param {any} run
   */
  async #originOf(userId, run) {
    const cardId = run?.originCardId;
    if (typeof cardId !== "string" || !CARD_ID.test(cardId)) return null;
    const { rows } = await this.database.query("SELECT user_id FROM evimed_frontier.evidence_cards WHERE id=$1", [cardId]);
    return rows[0] ? { cardId, own: rows[0].user_id === userId } : null;
  }

  /**
   * The evidence matrix, read from its own captured version and checked against the digest the result recorded. The
   * projected result withholds the matrix text when an input is restricted, so the bytes come from the snapshot —
   * the researcher's own data — and each restricted source is held back below, claim by claim.
   * @param {string} userId @param {any} project @param {any} review
   */
  async #readMatrix(userId, project, review) {
    try {
      const matrixVersion = await this.results.get(userId, project.id, review.matrixVersionId);
      if (matrixVersion.digest !== review.matrixDigest || !/clinical-evidence-matrix\.json$/.test(matrixVersion.path)) throw new Error("matrix mismatch");
      if (matrixVersion.size > MAX_MATRIX_BYTES) throw new Error("matrix too large");
      const bytes = await this.results.readSnapshot(project, { ...matrixVersion, storagePath: `result-snapshots/${matrixVersion.digest}` });
      const matrix = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!Array.isArray(matrix?.claims) || matrix.claims.length > MAX_MATRIX_CLAIMS
        || matrix.claims.some((/** @type {any} */ claim) => typeof claim?.claimId !== "string")) throw new Error("matrix shape");
      return { matrix, matrixVersion };
    } catch {
      throw refused("evidence_result_matrix_unreadable");
    }
  }

  /**
   * The references the capture recorded for the matrix's sources, by identity: the version to read a source's text
   * from, or the fact that it may not be read. Reading goes through the result's own `raw`, which verifies the bytes.
   * @param {string} userId @param {any} project @param {any} matrixVersion
   */
  async #sourceReferences(userId, project, matrixVersion) {
    /** @type {Map<string, { ref: any, text: string | null, capturedAt: string | null, digest: string | null }>} */
    const found = new Map();
    for (const ref of Array.isArray(matrixVersion.inputs) ? matrixVersion.inputs : []) {
      if (ref?.kind !== "source" || typeof ref.id !== "string") continue;
      const previous = found.get(ref.id);
      if (previous && previous.ref.availability === "captured") continue;
      let preserved = null, capturedAt = null, digest = null;
      if (ref.availability === "captured" && typeof ref.versionId === "string") {
        try {
          const { version, bytes } = await this.results.raw(userId, project.id, ref.versionId);
          if (version.digest === ref.digest) {
            preserved = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            capturedAt = version.capturedAt ?? null;
            digest = version.digest;
          }
        } catch { /* binary bytes or an unreadable snapshot: the source is cited without text */ }
      }
      found.set(ref.id, { ref, text: preserved, capturedAt, digest });
    }
    return found;
  }

  /**
   * The card's fields from the matrix, the stored verdict and the sources: claims, sources, disclosure, content.
   * @param {{ user: { id: string, name?: string }, version: any, matrix: any, references: Map<string, any>, run: any, claimIds: string[] | null, review: any }} input
   */
  async #build({ user, version, matrix, references, run, claimIds, review }) {
    /** @type {Map<string, any>} */
    const byId = new Map(matrix.claims.map((/** @type {any} */ claim) => [claim.claimId, claim]));
    const stored = Array.isArray(review.verification?.claims) ? review.verification : null;
    // The verdict the run's gate stored. When the projection withheld it (a restricted input), it is recomputed over
    // the text this account may read: a claim resting on a source it may not read is then not verified, never assumed.
    const verdict = stored ?? claimVerification({
      matrix, sourceArtifacts: Object.fromEntries([...references.values()].filter((entry) => entry.text !== null && entry.ref.availability === "captured")
        .map((entry) => [entry.ref.path ?? entry.ref.id, entry.text])),
    });
    const statusOf = new Map(verdict.claims.map((/** @type {any} */ claim) => [claim.claimId, claim.status]));
    /** @type {string[]} */
    let wanted;
    if (claimIds) {
      const unknown = claimIds.find((id) => !byId.has(id));
      if (unknown) throw refusal(400, "evidence_result_claim_unknown", `Claim ${unknown} is not in this result.`);
      wanted = claimIds;
    } else {
      wanted = matrix.claims.filter((/** @type {any} */ claim) => statusOf.get(claim.claimId) === "verified").map((/** @type {any} */ claim) => claim.claimId);
    }
    if (!wanted.length) throw refused("evidence_result_no_verified_claim");

    /** @type {{ claimId: string, reason: string }[]} */
    const omitted = [];
    const omit = (/** @type {string} */ claimId, /** @type {keyof typeof RESULT_CARD_OMISSIONS} */ reason) => omitted.push({ claimId, reason });
    /** @type {any[]} */
    const sources = [];
    /** @type {Map<string, number>} */
    const indexOf = new Map();
    /** The preserved text of each source that has no public address (1-based), which the card does not keep: see below. @type {Map<number, string>} */
    const unaddressed = new Map();
    /**
     * The card source for one bond of a claim, 1-based, or null when it cannot be cited.
     * @param {any} bond
     */
    const sourceFor = (bond) => {
      const identity = sourceIdentity(bond);
      const key = identity ?? text(bond.sourceUrl) ?? text(bond.sourceTitle);
      if (!key) return null;
      const known = indexOf.get(key);
      if (known) return known;
      const entry = identity ? references.get(identity) : undefined;
      const url = citationUrl(bond);
      // Text is read only for a source this account may still read (`#sourceReferences`); a restricted one has none.
      const preserved = typeof entry?.text === "string" && entry.text ? entry.text : null;
      const title = clip(text(bond.sourceTitle) || text(bond.identifier) || url || "", 500);
      if (!title || (!url && !preserved) || sources.length >= MAX_CARD_SOURCES) return null;
      const kept = preserved && preserved.length <= MAX_SOURCE_TEXT ? preserved : null;
      const accessLevel = text(bond.accessLevel);
      sources.push({
        title, url,
        excerpt: preserved ? evidencePublicExcerpt(preserved, text(bond.supportQuote) || null) : null,
        ...(preserved && entry.digest ? { fetchedSha256: entry.digest } : {}),
        ...(preserved && entry.capturedAt ? { checkedAt: entry.capturedAt } : {}),
        coverage: kept && accessLevel === "full_text" ? "full-text" : accessLevel === "abstract" ? "abstract" : "excerpt",
        ...(kept ? { documentText: kept } : {}),
      });
      indexOf.set(key, sources.length);
      // The text the card does not keep: a source with no public address, or one too large to keep whole.
      if (preserved && (!url || !kept)) unaddressed.set(sources.length, preserved);
      return sources.length;
    };
    /** Whether the bond's source is one this account may no longer read. @param {any} bond */
    const isRestricted = (bond) => references.get(sourceIdentity(bond) ?? "")?.ref?.availability === "restricted";
    /** The quotation a bond may show: none for a restricted source. @param {any} bond */
    const quoteOf = (bond) => (isRestricted(bond) || !text(bond.supportQuote) ? {} : { supportQuote: clip(text(bond.supportQuote), 2000) });
    /** @param {string} value @param {number} max */
    const optional = (value, max) => (value ? { value: clip(value, max) } : null);

    /** @type {any[]} */
    const claims = [];
    for (const claimId of wanted) {
      if (claims.length >= EVIDENCE_CLAIM_LIMIT) { omit(claimId, "too_many_claims"); continue; }
      const matrixClaim = byId.get(claimId);
      const type = claimTypeOf(matrixClaim);
      if (!CLAIM_ID.test(claimId)) { omit(claimId, "claim_id_unusable"); continue; }
      const statement = text(matrixClaim.claim);
      if (!statement || statement.length > 1500) { omit(claimId, "claim_text_too_long"); continue; }
      const applicability = optional(text(matrixClaim.applicability), 800);
      const uncertainty = optional(text(matrixClaim.uncertainty), 800);
      const common = {
        claimId, claimType: type, claim: statement,
        ...(applicability ? { applicability: applicability.value } : {}),
        ...(uncertainty ? { uncertainty: uncertainty.value } : {}),
      };
      if (type === "derived") {
        const fields = ["method", "assumptions", "sensitivity"].map((key) => text(matrixClaim[key]));
        if (fields.some((value) => !value || value.length > 3000)) { omit(claimId, "derived_fields_missing"); continue; }
        claims.push({ ...common, derivedFrom: Array.isArray(matrixClaim.derivedFrom) ? matrixClaim.derivedFrom.filter((/** @type {unknown} */ id) => typeof id === "string") : [],
          method: fields[0], assumptions: fields[1], sensitivity: fields[2],
          ...(["high", "moderate", "low"].includes(matrixClaim.confidence) ? { confidence: matrixClaim.confidence } : {}) });
        continue;
      }
      const bonds = claimEvidenceSources(matrixClaim).filter((/** @type {any} */ bond) => bond && typeof bond === "object");
      if (type === "synthesized") {
        if (!["high", "moderate", "low"].includes(matrixClaim.confidence)) { omit(claimId, "synthesis_confidence_missing"); continue; }
        const used = new Map();
        for (const bond of bonds) {
          const index = sourceFor(bond);
          if (index && !used.has(index)) used.set(index, bond);
        }
        if (used.size < 2) { omit(claimId, used.size ? "synthesis_needs_two_sources" : "source_not_citable"); continue; }
        claims.push({ ...common, confidence: matrixClaim.confidence,
          supportingSources: [...used].sort((a, b) => a[0] - b[0]).map(([sourceIndex, bond]) => ({ sourceIndex, ...quoteOf(bond) })) });
        continue;
      }
      const index = bonds[0] ? sourceFor(bonds[0]) : null;
      if (!index) { omit(claimId, "source_not_citable"); continue; }
      claims.push({ ...common, claimType: "direct", sourceIndexes: [index], ...quoteOf(bonds[0]) });
    }
    // A derived claim stands on the claims it reasons from, and the chain must reach a quoted one. One that does not is left
    // out and said so — repeatedly, because dropping one can orphan another.
    for (let attempts = 0; attempts <= wanted.length; attempts += 1) {
      const present = new Set(claims.map((claim) => claim.claimId));
      const orphan = claims.find((claim) => claim.claimType === "derived" && (!claim.derivedFrom.length
        || claim.derivedFrom.some((/** @type {string} */ id) => !present.has(id) || id === claim.claimId)));
      if (orphan) {
        omit(orphan.claimId, "derived_inputs_missing");
        claims.splice(claims.indexOf(orphan), 1);
        continue;
      }
      const grounded = new Set(claims.filter((claim) => claim.claimType !== "derived").map((claim) => claim.claimId));
      for (let changed = true; changed;) {
        changed = false;
        for (const claim of claims) {
          if (claim.claimType === "derived" && !grounded.has(claim.claimId) && claim.derivedFrom.some((/** @type {string} */ id) => grounded.has(id))) {
            grounded.add(claim.claimId);
            changed = true;
          }
        }
      }
      const floating = claims.find((claim) => !grounded.has(claim.claimId));
      if (!floating) break;
      omit(floating.claimId, "derived_inputs_missing");
      claims.splice(claims.indexOf(floating), 1);
    }
    // Every selected claim fell out: nothing is left to publish.
    if (!claims.length) throw refused("evidence_result_no_verified_claim");

    // A source with no public address is the researcher's own document (an upload, a private record), and one too large is not kept whole:
    // the card keeps none of the text (`EvidenceZoneService` drops the first) and shows only the passages its claims quote, found verbatim
    // in the text the platform read and carried as the excerpt beside the read receipt — which is what keeps those claims ✓ without
    // keeping the document.
    for (const [index, preserved] of unaddressed) {
      /** @type {string[]} */
      const found = [];
      for (const claim of claims) {
        const quoted = claim.claimType === "synthesized" ? (claim.supportingSources ?? []).map((/** @type {any} */ bond) => [bond.sourceIndex, bond.supportQuote])
          : claim.claimType === "direct" ? [[claim.sourceIndexes?.[0], claim.supportQuote]] : [];
        for (const [at, quote] of quoted) {
          if (at !== index || typeof quote !== "string" || !quote || found.includes(quote)) continue;
          const checked = verifyEvidenceCardClaims({ claims: [{ claimId: "Q", claimType: "direct", claim: "q", sourceIndexes: [1], supportQuote: quote }],
            sources: [{ title: "s", documentText: preserved, fetchedSha256: "0".repeat(64) }] });
          if (checked.claims[0]?.status === "verified") found.push(quote);
        }
      }
      if (found.length) sources[index - 1].excerpt = clip(found.join("\n\n"), 12000);
    }

    const comparisons = this.#comparisons(matrix, claims, sourcesOfClaims(claims));
    const pico = matrix.questionPico && typeof matrix.questionPico === "object" ? matrix.questionPico : null;
    const question = pico ? [["人群", pico.population], ["干预", pico.intervention], ["对照", pico.comparator], ["结局", pico.outcome]]
      .filter(([, value]) => text(value)).map(([label, value]) => `${label}：${text(value)}`).join("；") : "";
    const contentDraft = {
      ...(question ? { question: clip(question, 4000) } : {}),
      ...(text(pico?.population) ? { population: clip(text(pico.population), 4000) } : {}),
      ...(comparisons.length ? { comparisons } : {}),
    };
    const content = Object.keys(contentDraft).length ? evidenceStructuredContent(contentDraft, sources.length) : null;

    const name = await this.#nameOf(user);
    const capability = run?.effectiveAgentId ?? null;
    const generatedAt = typeof version.capturedAt === "string" ? version.capturedAt : this.now().toISOString();
    const aiSteps = /** @type {Record<string, string[]>} */ (RESULT_AI_STEPS_BY_CAPABILITY)[String(capability ?? "")] ?? DEFAULT_AI_STEPS;
    const model = typeof run?.model === "string" ? run.model.split("/").at(-1) : "";
    const title = await this.#titleOf(user.id, version, matrix);
    return {
      omitted,
      card: {
        title,
        subtype: "academic",
        summary: "",
        body: bodyOf(claims),
        limitations: "",
        provenance: clip(`研究结果 ${text(version.path).split("/").at(-1)}，保存于 ${generatedAt.slice(0, 10)}`, 12000),
        sources,
        ...(content ? { content } : {}),
        claims,
        producer: { kind: "user", name, relation: "none" },
        originality: resultOriginality(capability),
        disclosure: {
          ...(model ? { model: clip(model, 200) } : {}),
          generatedAt, lastCheckedAt: generatedAt,
          aiSteps: aiSteps.filter((step) => /** @type {readonly string[]} */ (EVIDENCE_AI_STEPS).includes(step)),
          authors: [{ name }],
        },
        state: "draft",
      },
    };
  }

  /**
   * The summary-of-findings rows the matrix itself carries — a root `comparisons` list whose entries name the claims
   * their numbers come from. A row stands only on claims the card has, takes its sources from them, and is kept only
   * when the domain's own check of events and denominators accepts it. Nothing here computes or completes a number.
   * @param {any} matrix @param {any[]} claims @param {Map<string, number[]>} sourcesByClaim
   */
  #comparisons(matrix, claims, sourcesByClaim) {
    if (!Array.isArray(matrix.comparisons)) return [];
    const rows = [];
    for (const raw of matrix.comparisons.slice(0, 10)) {
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.claimIds) || !raw.claimIds.length) continue;
      if (raw.claimIds.some((/** @type {string} */ id) => !claims.some((claim) => claim.claimId === id))) continue;
      const indexes = [...new Set(raw.claimIds.flatMap((/** @type {string} */ id) => sourcesByClaim.get(id) ?? []))].sort((a, b) => a - b);
      if (!indexes.length) continue;
      const { claimIds: _claimIds, ...row } = raw;
      try {
        evidenceStructuredContent({ comparisons: [{ ...row, sourceIndexes: indexes }] }, Math.max(...indexes));
        rows.push({ ...row, sourceIndexes: indexes });
      } catch { /* a row the domain refuses is not carried: no number is repaired or invented */ }
    }
    return rows;
  }

  /** The name this account signs with: its display name, never a guess. @param {{ id: string, name?: string }} user */
  async #nameOf(user) {
    if (typeof user.name === "string" && user.name.trim()) return clip(user.name.trim(), 300);
    const { rows } = await this.database.query("SELECT name FROM evimed_control.users WHERE id=$1", [user.id]);
    return clip(text(rows[0]?.name) || user.id, 300);
  }

  /**
   * The card's title: the report's own first heading when the selected result is that report, else its file name.
   * A heading is a structure of the file, not a reading of its prose.
   * @param {string} userId @param {any} version @param {any} _matrix
   */
  async #titleOf(userId, version, _matrix) {
    const file = text(version.path).split("/").at(-1) ?? "";
    if (/\.md$/i.test(file)) {
      try {
        const { bytes } = await this.results.raw(userId, version.projectId, version.versionId);
        const heading = /^#\s+(.+?)\s*$/m.exec(bytes.toString("utf8"));
        if (heading?.[1]) return clip(heading[1], 300);
      } catch { /* an unreadable report is titled by its file */ }
    }
    return clip(file.replace(/\.[A-Za-z0-9]+$/, "") || "研究结果", 300);
  }
}

/** The card sources each claim stands on, by claim id. @param {any[]} claims @returns {Map<string, number[]>} */
function sourcesOfClaims(claims) {
  return new Map(claims.map((claim) => [claim.claimId, claim.claimType === "synthesized" ? claim.supportingSources.map((/** @type {any} */ bond) => bond.sourceIndex) : (claim.sourceIndexes ?? [])]));
}

/**
 * The draft's body: the claims' own statements, one to a line, to the zone service's length bound. The researcher
 * writes the card's prose; this is what the claims already say, so a draft opens with something true and checkable.
 * @param {any[]} claims
 */
function bodyOf(claims) {
  const lines = [];
  let length = 0;
  for (const claim of claims) {
    const line = `· ${claim.claim}`;
    if (length + line.length + 1 > 49_000) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}
