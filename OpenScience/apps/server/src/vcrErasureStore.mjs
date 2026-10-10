/**
 * Withdrawal and retirement, and the marks on what was derived from a basis that has since changed
 * (2026-10-10 owner rulings; OpenMed review E-13, E-17, D-vcr §8).
 *
 * Hidden knowledge:
 *
 * - **The words go; the record stays.** A withdrawn subject's documents and the projections of them, a retired projection, and
 *   a document whose deletion was asked for after an evaluation used it, lose their text (the plane overwrites the files after
 *   the rows below are committed). Their rows keep their ids and their hashes, and the audit trail keeps what was done. A fact
 *   or a judgment an evaluation was frozen on is not deleted — the frozen inputs refer to it by id and hash — it is redacted
 *   (quote, surface, written date, a text value, the quotes of its relations) and keeps the digest it was frozen under in
 *   `withdrawn.digest`, so the frozen evaluation verifies and reads as 「已撤回」 rather than as changed. A fact no evaluation
 *   used is deleted. The quotes in the judgments of a stored assessment are replaced by the hash of what they said.
 * - **The database commits first.** A crash between the commit and the overwrite leaves bytes on disk that no read will serve
 *   (the rows say they are erased) and that the same request, made again, overwrites: the operations are idempotent.
 * - **A withdrawn subject is no candidate.** `subject_withdrawals` takes the subject out of every roster (`candidateSubjects`),
 *   out of a continued batch, and closes their open referrals as 「退出」; nobody is contacted who withdrew.
 * - **Marks are labels.** `markBasisChanged` writes `derived_marks` for the facts, language judgments and assessments that were
 *   derived from a document, a projection or a permission that changed. It reads the derivation from the data (a fact's source,
 *   a judgment's evidence, the facts a frozen input names), blocks nothing and re-runs nothing.
 *
 * @module vcrErasureStore
 */

import { createHash } from "node:crypto";

import { matchingInputDigest } from "./vcrMatching.mjs";
import { languageInput } from "./vcrMatchingSnapshot.mjs";
import { factOf } from "./vcrMatchStore.mjs";
import { VCR_BASIS_CAUSES } from "./vcrErasureSchema.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { VcrStoreBase } from "./vcrStoreBase.mjs";

/** @param {unknown} text */
const sha256 = (text) => createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);

/** The stronger cause of two marks: a withdrawal over a changed permission over a replaced projection over a changed document. */
const CAUSE_RANK = Object.freeze(Object.fromEntries(["document", "projection", "permission", "withdrawn"].map((cause, index) => [cause, index + 1])));

/**
 * A fact without its words: the quote of its source (kept as a hash), its surface, the date as written, a value that is text, and
 * what its relations and its correction quote of the record. Numbers, units, polarity, times and the locator stay: they describe
 * the record, they do not repeat it.
 * @param {any} row a `matching_facts` row
 */
export function redactedFactColumns(row) {
  /** @type {Record<string, any> | null} */
  let source = null;
  if (row.source && typeof row.source === "object") {
    const { quote, ...rest } = row.source;
    source = { ...rest, ...(typeof quote === "string" ? { quoteHash: sha256(quote) } : {}) };
  }
  /** @type {Record<string, any> | null} */
  let clinical = null;
  if (row.clinical && typeof row.clinical === "object") {
    clinical = { ...row.clinical };
    if (Array.isArray(clinical.relations)) clinical.relations = clinical.relations.map((/** @type {any} */ relation) => ({ ...relation, quote: "" }));
    if (typeof clinical.correctionReason === "string") clinical.correctionReason = "";
  }
  return { source, surface: "", dateSurface: null, value: typeof row.value === "string" ? null : row.value ?? null, clinical };
}

/**
 * The evidence of a language judgment or a criterion judgment without the quotes that came out of the erased text: each such
 * item keeps its locator and a hash of what it quoted.
 * @param {unknown} evidence @param {(item: any) => boolean} erased which items to take the words out of
 */
export function redactedEvidence(evidence, erased) {
  let changed = false;
  const items = list(evidence).map((item) => {
    if (!item || typeof item !== "object" || !erased(item) || item.withdrawn === true) return item;
    changed = true;
    const { quote, ...rest } = item;
    return { ...rest, ...(typeof quote === "string" ? { quoteHash: sha256(quote) } : {}), quote: "", withdrawn: true };
  });
  return { evidence: items, changed };
}

/** The store of withdrawals, retirements and basis marks. @extends VcrStoreBase */
export class VcrErasureStore extends VcrStoreBase {
  /** @param {{ database: any, matchStore?: { transitionReferral: Function } | null, statementTimeoutMs?: number }} options */
  constructor({ database, matchStore = null, statementTimeoutMs }) {
    super({ database, ...(statementTimeoutMs ? { statementTimeoutMs } : {}) });
    this.matchStore = matchStore;
  }

  /**
   * The facts and judgments a frozen input refers to: the ones that are redacted instead of deleted.
   * @param {any} client @param {string} studyId
   */
  async #frozenReferences(client, studyId) {
    // A frozen matching input names its facts and judgments by id and hash, and so does a correction case captured from an
    // evaluation: both are verified later against the digest they were frozen under, so neither may be deleted.
    const facts = await client.query(`SELECT ref->>'id' AS id FROM ${VCR_SCHEMA}.matching_inputs m, jsonb_array_elements(m.manifest->'facts') ref WHERE m.study_id=$1
      UNION SELECT ref->>'id' FROM ${VCR_SCHEMA}.audit a, jsonb_array_elements(COALESCE(a.detail->'evaluationCase'->'facts','[]'::jsonb)) ref
        WHERE a.study_id=$1 AND a.action='vcr.judgment.override'`, [studyId]);
    const languages = await client.query(`SELECT ref->>'id' AS id FROM ${VCR_SCHEMA}.matching_inputs m, jsonb_array_elements(m.manifest->'languages') ref WHERE m.study_id=$1
      UNION SELECT ref->>'id' FROM ${VCR_SCHEMA}.audit a, jsonb_array_elements(COALESCE(a.detail->'evaluationCase'->'language','[]'::jsonb)) ref
        WHERE a.study_id=$1 AND a.action='vcr.judgment.override'`, [studyId]);
    return { facts: new Set(facts.rows.map((/** @type {any} */ row) => String(row.id))), languages: new Set(languages.rows.map((/** @type {any} */ row) => String(row.id))) };
  }

  /**
   * One mark per thing, the stronger cause kept.
   * @param {any} client @param {string} studyId @param {"fact" | "language_judgment" | "assessment"} kind
   * @param {{ id: string, subjectKey: string }[]} targets @param {string} cause @param {string} causeId
   */
  async #mark(client, studyId, kind, targets, cause, causeId) {
    if (!VCR_BASIS_CAUSES.includes(cause)) throw new TypeError(`A mark has a cause from ${VCR_BASIS_CAUSES.join(", ")}.`);
    for (const target of targets) {
      await client.query(`INSERT INTO ${VCR_SCHEMA}.derived_marks (study_id, kind, target_id, subject_key, cause, cause_id)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (study_id, kind, target_id) DO UPDATE SET marked_at = now(),
          cause = CASE WHEN $7::int >= (CASE derived_marks.cause WHEN 'withdrawn' THEN 4 WHEN 'permission' THEN 3 WHEN 'projection' THEN 2 ELSE 1 END) THEN EXCLUDED.cause ELSE derived_marks.cause END,
          cause_id = CASE WHEN $7::int >= (CASE derived_marks.cause WHEN 'withdrawn' THEN 4 WHEN 'permission' THEN 3 WHEN 'projection' THEN 2 ELSE 1 END) THEN EXCLUDED.cause_id ELSE derived_marks.cause_id END`,
      [studyId, kind, target.id, target.subjectKey, cause, causeId, CAUSE_RANK[/** @type {keyof typeof CAUSE_RANK} */ (cause)]]);
    }
    return targets.length;
  }

  /**
   * The assessments that rest on these documents: the ones whose judgments cite a document or a fact, and those of a subject
   * whose facts or judgments a frozen input named (the input is what an assessment was computed from).
   * @param {any} client @param {string} studyId @param {string[]} documentIds @param {string[]} factIds @param {string[]} judgmentIds @param {string[]} subjects
   * @returns {Promise<{ id: string, subjectKey: string }[]>}
   */
  async #derivedAssessments(client, studyId, documentIds, factIds, judgmentIds, subjects) {
    const rows = (await client.query(
      `SELECT DISTINCT a.id, a.subject_key FROM ${VCR_SCHEMA}.matching_assessments a
        WHERE a.study_id=$1 AND (
          EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.criterion_judgments cj, jsonb_array_elements(cj.evidence) e
            WHERE cj.assessment_id = a.id AND (e->'locator'->>'documentId' = ANY($2::text[]) OR e->>'factId' = ANY($3::text[])))
          OR (a.subject_key = ANY($4::text[]) AND a.input_snapshot_id IN (
            SELECT m.id FROM ${VCR_SCHEMA}.matching_inputs m WHERE m.study_id=$1 AND (
              EXISTS (SELECT 1 FROM jsonb_array_elements(m.manifest->'facts') ref WHERE ref->>'id' = ANY($3::text[]))
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(m.manifest->'languages') ref WHERE ref->>'id' = ANY($5::text[]))))))`,
      [studyId, documentIds, factIds, subjects, judgmentIds])).rows;
    return rows.map((/** @type {any} */ row) => ({ id: String(row.id), subjectKey: String(row.subject_key) }));
  }

  /**
   * Take the words out of what was read from these documents (and, for a subject, out of everything of theirs), inside the
   * caller's transaction. The caller overwrites the files named in the answer after the commit.
   * @param {any} client
   * @param {{ studyId: string, userId: string, actor: string, fileIds?: string[], projectionIds?: string[], subjectKey?: string | null,
   *   cause: "withdrawn" | "projection", reason?: string }} input
   */
  async #erase(client, { studyId, userId, actor, fileIds = [], projectionIds = [], subjectKey = null, cause, reason = "" }) {
    const files = fileIds.length ? (await client.query(
      `SELECT * FROM ${VCR_SCHEMA}.source_files WHERE study_id=$1 AND role='document' AND id = ANY($2::text[]) FOR UPDATE`, [studyId, fileIds])).rows : [];
    const projections = (await client.query(
      `SELECT * FROM ${VCR_SCHEMA}.document_projections WHERE study_id=$1 AND (document_id = ANY($2::text[]) OR id = ANY($3::text[])) FOR UPDATE`,
      [studyId, files.map((/** @type {any} */ file) => file.id), projectionIds])).rows;
    await client.query(`UPDATE ${VCR_SCHEMA}.source_files SET erased_at = COALESCE(erased_at, now()) WHERE study_id=$1 AND id = ANY($2::text[])`, [studyId, files.map((/** @type {any} */ file) => file.id)]);
    await client.query(`UPDATE ${VCR_SCHEMA}.document_projections SET retired_at = COALESCE(retired_at, now()) WHERE study_id=$1 AND id = ANY($2::text[])`, [studyId, projections.map((/** @type {any} */ row) => row.id)]);
    const documentIds = [...files.map((/** @type {any} */ file) => String(file.id)), ...projections.map((/** @type {any} */ row) => String(row.id))];
    const at = new Date().toISOString();
    const frozen = await this.#frozenReferences(client, studyId);

    // Facts: deleted when no evaluation used them, redacted (and marked) when one did.
    const factRows = (await client.query(
      `SELECT * FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND withdrawn IS NULL
         AND ((source->>'documentId') = ANY($2::text[]) OR ($3::text IS NOT NULL AND subject_key=$3)) FOR UPDATE`, [studyId, documentIds, subjectKey])).rows;
    const factIds = factRows.map((/** @type {any} */ row) => String(row.id));
    /** @type {{ id: string, subjectKey: string }[]} */
    const redactedFacts = [];
    let factsRemoved = 0;
    for (const row of factRows) {
      if (!frozen.facts.has(String(row.id))) {
        await client.query(`DELETE FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND id=$2`, [studyId, row.id]);
        factsRemoved += 1;
        continue;
      }
      const digest = matchingInputDigest(factOf(row));
      const words = redactedFactColumns(row);
      await client.query(`UPDATE ${VCR_SCHEMA}.matching_facts SET source=$3::jsonb, surface=$4, date_surface=$5, value=$6::jsonb, clinical=$7::jsonb, withdrawn=$8::jsonb
        WHERE study_id=$1 AND id=$2`,
      [studyId, row.id, words.source == null ? null : JSON.stringify(words.source), words.surface, words.dateSurface, JSON.stringify(words.value), words.clinical == null ? null : JSON.stringify(words.clinical),
        JSON.stringify({ at, digest, cause })]);
      redactedFacts.push({ id: String(row.id), subjectKey: String(row.subject_key) });
    }

    // Language judgments: the same.
    const judgmentRows = (await client.query(
      `SELECT * FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND withdrawn IS NULL
         AND (EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'documentId' = ANY($2::text[])) OR ($3::text IS NOT NULL AND subject_key=$3)) FOR UPDATE`,
      [studyId, documentIds, subjectKey])).rows;
    /** @type {{ id: string, subjectKey: string }[]} */
    const redactedJudgments = [];
    let judgmentsRemoved = 0;
    for (const row of judgmentRows) {
      if (!frozen.languages.has(String(row.id))) {
        await client.query(`DELETE FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND id=$2`, [studyId, row.id]);
        judgmentsRemoved += 1;
        continue;
      }
      const digest = matchingInputDigest(languageInput({ id: row.id, state: row.state, evidence: row.evidence, protocolVersionId: row.protocol_version_id,
        criterionHash: row.criterion_hash, provenance: row.provenance }));
      const { evidence } = redactedEvidence(row.evidence, (item) => subjectKey != null || documentIds.includes(String(item.documentId ?? "")));
      await client.query(`UPDATE ${VCR_SCHEMA}.language_judgments SET evidence=$3::jsonb, withdrawn=$4::jsonb WHERE study_id=$1 AND id=$2`,
        [studyId, row.id, JSON.stringify(evidence), JSON.stringify({ at, digest, cause })]);
      redactedJudgments.push({ id: String(row.id), subjectKey: String(row.subject_key) });
    }

    // Stored assessments: the quotes of their judgments, and the assessments themselves read as withdrawn.
    const assessmentRows = (await client.query(
      `SELECT cj.id, cj.assessment_id, cj.evidence, a.subject_key FROM ${VCR_SCHEMA}.criterion_judgments cj
         JOIN ${VCR_SCHEMA}.matching_assessments a ON a.id = cj.assessment_id
        WHERE a.study_id=$1 AND (($3::text IS NOT NULL AND a.subject_key=$3)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(cj.evidence) e WHERE e->'locator'->>'documentId' = ANY($2::text[]) OR e->>'factId' = ANY($4::text[])))
        FOR UPDATE OF cj`, [studyId, documentIds, subjectKey, factIds])).rows;
    /** @type {Map<string, string>} */
    const touched = new Map();
    let judgmentQuotes = 0;
    for (const row of assessmentRows) {
      const cites = (/** @type {any} */ item) => documentIds.includes(String(item.locator?.documentId ?? "")) || factIds.includes(String(item.factId ?? ""))
        || (subjectKey != null && item.quoteKind === "verbatim");
      const { evidence, changed } = redactedEvidence(row.evidence, cites);
      if (changed) {
        await client.query(`UPDATE ${VCR_SCHEMA}.criterion_judgments SET evidence=$2::jsonb WHERE id=$1`, [row.id, JSON.stringify(evidence)]);
        judgmentQuotes += 1;
      }
      if (changed || subjectKey != null) touched.set(String(row.assessment_id), String(row.subject_key));
    }
    // The trials a patient was judged against (「给患者找试验」) store quotes of the same kind: their judgments are redacted the same way,
    // for a withdrawn subject and for whatever cites what was erased.
    const candidateRows = (await client.query(
      `SELECT cj.id, cj.evidence FROM ${VCR_SCHEMA}.candidate_trial_judgments cj
         JOIN ${VCR_SCHEMA}.candidate_trial_assessments a ON a.id = cj.assessment_id
        WHERE a.study_id=$1 AND (($3::text IS NOT NULL AND a.subject_key=$3)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(cj.evidence) e WHERE e->'locator'->>'documentId' = ANY($2::text[]) OR e->>'factId' = ANY($4::text[])))
        FOR UPDATE OF cj`, [studyId, documentIds, subjectKey, factIds])).rows;
    let candidateQuotes = 0;
    for (const row of candidateRows) {
      const { evidence, changed } = redactedEvidence(row.evidence, (/** @type {any} */ item) => documentIds.includes(String(item.locator?.documentId ?? "")) || factIds.includes(String(item.factId ?? ""))
        || (subjectKey != null && item.quoteKind === "verbatim"));
      if (!changed) continue;
      await client.query(`UPDATE ${VCR_SCHEMA}.candidate_trial_judgments SET evidence=$2::jsonb WHERE id=$1`, [row.id, JSON.stringify(evidence)]);
      candidateQuotes += 1;
    }
    // A withdrawn subject's assessments are all marked, with or without a quote in them; any other assessment that rests on what
    // was erased is marked too.
    if (subjectKey != null) {
      for (const row of (await client.query(`SELECT id, subject_key FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id=$1 AND subject_key=$2`, [studyId, subjectKey])).rows) {
        touched.set(String(row.id), String(row.subject_key));
      }
    }
    const subjects = [...new Set([...factRows, ...judgmentRows].map((/** @type {any} */ row) => String(row.subject_key)))];
    for (const derived of await this.#derivedAssessments(client, studyId, documentIds, factIds, judgmentRows.map((/** @type {any} */ row) => String(row.id)), subjects)) touched.set(derived.id, derived.subjectKey);
    const causeId = subjectKey ?? documentIds[0] ?? "";
    const assessments = [...touched].map(([id, subject]) => ({ id, subjectKey: subject }));
    await this.#mark(client, studyId, "fact", redactedFacts, cause, causeId);
    await this.#mark(client, studyId, "language_judgment", redactedJudgments, cause, causeId);
    await this.#mark(client, studyId, "assessment", assessments, cause, causeId);

    // The audit trail: hashes and ids of what was erased, never a word of it.
    for (const file of files) {
      await this.audit({ client, studyId, userId, actor, action: "source.file.erase", object: String(file.id),
        detail: { sourceId: file.source_id, sha256: file.sha256, bytes: Number(file.bytes), ...(file.detail?.original?.sha256 ? { originalSha256: file.detail.original.sha256 } : {}), reason } });
    }
    for (const row of projections) {
      await this.audit({ client, studyId, userId, actor, action: "document.projection.retire", object: String(row.id),
        detail: { documentId: row.document_id, projectionHash: row.projection_hash, manifestHash: row.manifest_hash, reason } });
    }
    return {
      files: files.map((/** @type {any} */ file) => ({ id: String(file.id), location: String(file.location), originalLocation: file.detail?.original?.location ? String(file.detail.original.location) : null })),
      projections: projections.map((/** @type {any} */ row) => ({ id: String(row.id), location: String(row.location) })),
      counts: { files: files.length, projections: projections.length, factsRemoved, factsRedacted: redactedFacts.length,
        judgmentsRemoved, judgmentsRedacted: redactedJudgments.length, assessmentQuotesRedacted: judgmentQuotes + candidateQuotes, assessmentsMarked: assessments.length },
    };
  }

  /**
   * A subject's consent withdrawn: every document of theirs, and the projections of them, is erased; what was read from them
   * is deleted or redacted; they leave every roster; their open referrals close as 「退出」. Idempotent: asked again, it finds
   * the same documents (already erased) and answers the files to overwrite again.
   * @param {{ studyId: string, userId: string, actor: string, subjectKey: string, reason?: string }} input
   */
  async withdrawSubject({ studyId, userId, actor, subjectKey, reason = "" }) {
    return this.transaction(async (client) => {
      const files = (await client.query(
        `SELECT id FROM ${VCR_SCHEMA}.source_files WHERE study_id=$1 AND role='document' AND detail->>'subjectKey'=$2`, [studyId, subjectKey])).rows;
      const known = await this.#holdsSubject(client, studyId, subjectKey, files.length);
      if (!known) return null;
      const erased = await this.#erase(client, { studyId, userId, actor, fileIds: files.map((/** @type {any} */ row) => String(row.id)), subjectKey, cause: "withdrawn", reason });
      let referralsClosed = 0;
      for (const referral of (await client.query(
        `SELECT id FROM ${VCR_SCHEMA}.referrals WHERE study_id=$1 AND subject_key=$2 AND state NOT IN ('withdrawn','screen_failed')`, [studyId, subjectKey])).rows) {
        const moved = await this.matchStore?.transitionReferral({ referralId: referral.id, studyId, to: "withdrawn", actor, userId, note: "知情同意已撤回", guard: () => ({ ok: true }), client });
        if (moved?.ok) referralsClosed += 1;
      }
      await client.query(`INSERT INTO ${VCR_SCHEMA}.subject_withdrawals (study_id, subject_key, withdrawn_by, detail)
        VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (study_id, subject_key) DO NOTHING`, [studyId, subjectKey, actor, JSON.stringify({ reason })]);
      await this.audit({ client, studyId, userId, actor, action: "subject.withdraw", object: subjectKey,
        detail: { ...erased.counts, referralsClosed, reason } });
      return { subjectKey, ...erased, counts: { ...erased.counts, referralsClosed } };
    });
  }

  /**
   * Whether the study holds this subject at all: a document, a fact, an assessment, a referral or a candidate row. A subject
   * the study has never heard of is not withdrawn (and not made up).
   * @param {any} client @param {string} studyId @param {string} subjectKey @param {number} documents
   */
  async #holdsSubject(client, studyId, subjectKey, documents) {
    if (documents > 0) return true;
    const row = (await client.query(
      `SELECT (EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND subject_key=$2)
        OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id=$1 AND subject_key=$2)
        OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND subject_key=$2)
        OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.referrals WHERE study_id=$1 AND subject_key=$2)
        OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.matching_candidates WHERE study_id=$1 AND subject_key=$2)
        OR EXISTS (SELECT 1 FROM ${VCR_SCHEMA}.subject_withdrawals WHERE study_id=$1 AND subject_key=$2)) AS held`, [studyId, subjectKey])).rows[0];
    return row?.held === true;
  }

  /**
   * Documents erased on a deletion request that a stored evaluation was frozen on: the text goes, the row, its hashes and the
   * evaluation stay.
   * @param {{ studyId: string, userId: string, actor: string, fileIds: string[], reason?: string }} input
   */
  async eraseDocuments({ studyId, userId, actor, fileIds, reason = "deletion" }) {
    return this.transaction((client) => this.#erase(client, { studyId, userId, actor, fileIds, cause: "withdrawn", reason }));
  }

  /**
   * A projection that missed an identifier: retired, so no read serves it and a newer one is chosen, and what was quoted from
   * it is deleted or redacted. Null where the study has no such projection.
   * @param {{ studyId: string, userId: string, actor: string, projectionId: string, reason?: string }} input
   */
  async retireProjection({ studyId, userId, actor, projectionId, reason = "retired" }) {
    return this.transaction(async (client) => {
      const row = (await client.query(`SELECT id FROM ${VCR_SCHEMA}.document_projections WHERE study_id=$1 AND id=$2`, [studyId, projectionId])).rows[0];
      if (!row) return null;
      return this.#erase(client, { studyId, userId, actor, projectionIds: [projectionId], cause: "projection", reason });
    });
  }

  /** The projections whose text was overwritten. @param {string} studyId @param {string[]} projectionIds */
  async markPurged(studyId, projectionIds) {
    if (!projectionIds.length) return;
    await this.query(`UPDATE ${VCR_SCHEMA}.document_projections SET purged_at = COALESCE(purged_at, now()) WHERE study_id=$1 AND id = ANY($2::text[])`, [studyId, projectionIds]);
  }

  /**
   * What was derived from these documents is marked: the facts that were read from them, the language judgments that cite them,
   * and the assessments that rest on those (through the facts a frozen input names and through the evidence they cite). Nothing
   * is blocked and nothing re-runs; a re-evaluation writes a new assessment, which is not marked.
   * @param {{ studyId: string, cause: "document" | "projection" | "permission" | "withdrawn", causeId: string, documentIds: string[] }} input
   */
  async markBasisChanged({ studyId, cause, causeId, documentIds }) {
    if (!documentIds.length) return { facts: 0, languageJudgments: 0, assessments: 0 };
    return this.transaction(async (client) => {
      const facts = (await client.query(`SELECT id, subject_key FROM ${VCR_SCHEMA}.matching_facts WHERE study_id=$1 AND withdrawn IS NULL AND (source->>'documentId') = ANY($2::text[])`,
        [studyId, documentIds])).rows.map((/** @type {any} */ row) => ({ id: String(row.id), subjectKey: String(row.subject_key) }));
      const judgments = (await client.query(
        `SELECT id, subject_key FROM ${VCR_SCHEMA}.language_judgments WHERE study_id=$1 AND withdrawn IS NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'documentId' = ANY($2::text[]))`, [studyId, documentIds])).rows
        .map((/** @type {any} */ row) => ({ id: String(row.id), subjectKey: String(row.subject_key) }));
      const subjects = [...new Set([...facts, ...judgments].map((row) => row.subjectKey))];
      const assessments = await this.#derivedAssessments(client, studyId, documentIds, facts.map((row) => row.id), judgments.map((row) => row.id), subjects);
      await this.#mark(client, studyId, "fact", facts, cause, causeId);
      await this.#mark(client, studyId, "language_judgment", judgments, cause, causeId);
      await this.#mark(client, studyId, "assessment", assessments, cause, causeId);
      return { facts: facts.length, languageJudgments: judgments.length, assessments: assessments.length };
    });
  }

  /**
   * A subject has new evidence (a record was added): the assessments already made of them rested on less. They are marked, and
   * a new evaluation writes a new assessment that is not.
   * @param {{ studyId: string, subjectKey: string, cause: "document" | "projection" | "permission" | "withdrawn", causeId: string }} input
   */
  async markSubjectChanged({ studyId, subjectKey, cause, causeId }) {
    return this.transaction(async (client) => {
      const assessments = (await client.query(`SELECT id, subject_key FROM ${VCR_SCHEMA}.matching_assessments WHERE study_id=$1 AND subject_key=$2`, [studyId, subjectKey])).rows
        .map((/** @type {any} */ row) => ({ id: String(row.id), subjectKey: String(row.subject_key) }));
      return this.#mark(client, studyId, "assessment", assessments, cause, causeId);
    });
  }

  /**
   * The marks on some assessments, by id.
   * @param {string} studyId @param {readonly string[]} assessmentIds
   * @returns {Promise<Map<string, { cause: string, markedAt: string | null }>>}
   */
  async assessmentMarks(studyId, assessmentIds) {
    if (!assessmentIds.length) return new Map();
    const rows = await this.rows(`SELECT target_id, cause, marked_at FROM ${VCR_SCHEMA}.derived_marks WHERE study_id=$1 AND kind='assessment' AND target_id = ANY($2::text[])`, [studyId, [...assessmentIds]]);
    return new Map(rows.map((row) => [String(row.target_id), { cause: String(row.cause), markedAt: row.marked_at ? new Date(row.marked_at).toISOString() : null }]));
  }

  /**
   * The marks on some facts, by id.
   * @param {string} studyId @param {readonly string[]} factIds
   * @returns {Promise<Map<string, { cause: string }>>}
   */
  async factMarks(studyId, factIds) {
    if (!factIds.length) return new Map();
    const rows = await this.rows(`SELECT target_id, cause FROM ${VCR_SCHEMA}.derived_marks WHERE study_id=$1 AND kind='fact' AND target_id = ANY($2::text[])`, [studyId, [...factIds]]);
    return new Map(rows.map((row) => [String(row.target_id), { cause: String(row.cause) }]));
  }

  /** The subjects of the study whose newest assessment is marked, with the cause: the page's one count and its re-evaluation list.
   * @param {string} studyId @returns {Promise<{ subjectKey: string, cause: string }[]>} */
  async markedSubjects(studyId) {
    const rows = await this.rows(
      `SELECT DISTINCT ON (a.subject_key) a.subject_key, m.cause FROM ${VCR_SCHEMA}.matching_assessments a
         LEFT JOIN ${VCR_SCHEMA}.derived_marks m ON m.study_id=a.study_id AND m.kind='assessment' AND m.target_id=a.id
        WHERE a.study_id=$1 ORDER BY a.subject_key, a.as_of DESC, a.created_at DESC`, [studyId]);
    return rows.filter((row) => row.cause).map((row) => ({ subjectKey: String(row.subject_key), cause: String(row.cause) }));
  }
}
