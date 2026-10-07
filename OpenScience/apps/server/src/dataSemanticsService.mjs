// What a project's datasets MEAN, kept in the product ledger (plan 2026-10-02 §11.3 N03).
//
// One document of kind `dataset-semantics` per dataset of a project, in the same
// `evimed_product.documents` / `revisions` ledger every other durable record uses —
// so a correction is a revision, the history is the ledger's own, a project's
// deletion takes its datasets with it, and there is no second store. The contract
// (what a fact is, how a weaker basis meets a stronger one, what a binding or a
// check report may hold) is `@evimed/domain`'s `dataSemantics.mjs`; this module
// only loads, applies, stores and answers.
//
// Hidden knowledge:
//
// - **No patient data lives here, and the layers enforce it twice.** The runtime's
//   tool sends counts, names, aggregates over at least ten values, and row numbers;
//   `normalizeBinding` and `normalizeCheckReport` drop everything else on the way in.
//   The rows themselves stay in the runtime's workspace, where the checks read them.
// - **A write is a read-modify-write on one revision, retried.** Two conversations
//   of one project (a scoping run and a follow-up analysis) may write the same
//   dataset at once; the ledger's optimistic revision refuses the loser, and the
//   loser re-reads and applies its patch again. The patch is a set of facts with a
//   basis, so applying it to a newer asset is exactly what "later writes meet
//   earlier ones by basis" means; nothing is lost and nothing is last-write-wins.
// - **The id of a document is derived from the project and the dataset id**, so one
//   dataset id in two projects is two assets, and a dataset id can never name another
//   project's record.
// - **Failure keeps the rest.** A patch with a bad item writes every other item
//   (`issues` name the refused ones). A write that would not fit a ledger document is
//   refused by name (`semantics_asset_too_large`) after the profiles were thinned.

import { createHash } from "node:crypto";
import {
  DATA_SEMANTICS_KIND, DATA_SEMANTICS_LIMITS, applyCheckReport, applySemanticsPatch, applyTransformation, confirmationPatch, emptySemanticsAsset,
  fitAsset, interpretationOf, isDatasetId, normalizeTransformation, semanticsListing, summarizeSemantics,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";

const WRITE_ATTEMPTS = 4;

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** @param {string} projectId @param {string} datasetId */
export function dataSemanticsDocumentId(projectId, datasetId) {
  return `dsem_${sha256(`${projectId}\0${datasetId}`).slice(0, 32)}`;
}

/** @param {unknown} datasetId */
function requireDatasetId(datasetId) {
  if (!isDatasetId(datasetId)) throw new HttpError(400, "semantics_dataset_invalid", "datasetId is lowercase letters, digits, - and _, at most 64 characters.");
  return /** @type {string} */ (datasetId);
}

export class DataSemanticsService {
  /** @param {{ documents: any, now?: () => string, onChanged?: ((event:any)=>Promise<void>)|null,evolutionSignals?:any }} dependencies */
  constructor({ documents, now = () => new Date().toISOString(), onChanged = null, evolutionSignals = null }) {
    this.documents = documents;
    this.now = now;
    this.onChanged = onChanged;
    this.evolutionSignals = evolutionSignals;
  }

  /** The datasets a project has, newest first, in the short form a list shows.
   * @param {string} userId @param {string} projectId */
  async list(userId, projectId) {
    const page = await this.documents.list(userId, DATA_SEMANTICS_KIND, { projectId, limit: 100 });
    return page.items.map((/** @type {any} */ row) => ({ ...semanticsListing(row.payload), revision: row.revision }));
  }

  /**
   * The transformations a project recorded whose code is one of these files, by sha-256: how a result's producer
   * snapshot names a dataset transformation without restating it (plan 2026-10-02 §11.3 N06). Identity only — the
   * dataset, the transformation's name and its version.
   * @param {string} userId @param {string} projectId @param {readonly string[]} digests
   * @returns {Promise<Array<{ datasetId: string, name: string, version: number, codeDigest: string }>>}
   */
  async transformationsByCode(userId, projectId, digests) {
    const wanted = new Set(digests);
    const page = await this.documents.list(userId, DATA_SEMANTICS_KIND, { projectId, limit: 100 });
    /** @type {Array<{ datasetId: string, name: string, version: number, codeDigest: string }>} */
    const found = [];
    for (const row of page.items) {
      for (const transformation of Array.isArray(row.payload?.transformations) ? row.payload.transformations : []) {
        const codeDigest = transformation?.code?.sha256;
        if (typeof codeDigest === "string" && wanted.has(codeDigest)) {
          found.push({ datasetId: String(row.payload.datasetId), name: String(transformation.name), version: Number(transformation.version), codeDigest });
        }
      }
    }
    return found.slice(0, 32);
  }

  /** One dataset's asset with the digest of its interpretation, or null.
   * @param {string} userId @param {string} projectId @param {string} datasetId */
  async get(userId, projectId, datasetId) {
    requireDatasetId(datasetId);
    const row = await this.documents.get(userId, DATA_SEMANTICS_KIND, dataSemanticsDocumentId(projectId, datasetId));
    if (!row || row.projectId !== projectId) return null;
    return this.#view(row);
  }

  /** @param {any} row */
  #view(row) {
    const asset = row.payload;
    return { asset, revision: row.revision, interpretation: sha256(interpretationOf(asset)), summary: summarizeSemantics(asset), updatedAt: row.updatedAt };
  }

  /**
   * Load the asset (or start one), let `change` edit it, store it. `change` returns what the caller wants
   * answered, or `null` to say nothing changed; a lost race re-reads and runs `change` again.
   * @template T
   * @param {string} userId @param {string} projectId @param {string} datasetId @param {boolean} create
   * @param {(asset: any, now: string) => { asset: any, answer: T, changed: boolean }} change
   * @param {{ telemetry?: boolean }} [options] `telemetry`: the change is derived from the data rather than a change of the
   *   meaning (a check's findings), so the ledger moves the revision and keeps no history row for it
   */
  async #mutate(userId, projectId, datasetId, create, change, { telemetry = false } = {}) {
    const id = dataSemanticsDocumentId(projectId, datasetId);
    for (let attempt = 1; ; attempt += 1) {
      const row = await this.documents.get(userId, DATA_SEMANTICS_KIND, id);
      if (row && row.projectId !== projectId) throw new HttpError(404, "semantics_asset_not_found", "No recorded meaning for that dataset.");
      if (!row && !create) throw new HttpError(404, "semantics_asset_not_found", "No recorded meaning for that dataset.");
      if (!row) {
        const existing = await this.documents.list(userId, DATA_SEMANTICS_KIND, { projectId, limit: 100 });
        if (existing.items.length >= DATA_SEMANTICS_LIMITS.datasetsPerProject) {
          throw new HttpError(409, "semantics_too_many_datasets", `A project records the meaning of at most ${DATA_SEMANTICS_LIMITS.datasetsPerProject} datasets.`);
        }
      }
      const now = this.now();
      const outcome = change(row ? row.payload : emptySemanticsAsset(datasetId, now), now);
      if (!outcome.changed && row) return { ...outcome, revision: row.revision, trimmed: false };
      const fitted = fitAsset(outcome.asset);
      if (!fitted) throw new HttpError(413, "semantics_asset_too_large", "The recorded meaning of this dataset no longer fits one record; split it into several datasets.");
      try {
        const saved = await this.documents.put(userId, DATA_SEMANTICS_KIND, id, fitted.asset, { expectedRevision: row ? row.revision : 0, projectId, telemetry: telemetry && Boolean(row) });
        // The record is saved. What a consumer of the change does with it is the consumer's business: its failure is
        // not the write's, and an error of its own that looks like a lost race must not make this one write again.
        try { await this.onChanged?.({ userId, projectId, datasetId, revision: saved.revision, asset: fitted.asset }); } catch { /* the consumer's failure is its own */ }
        const outcomes=/** @type {any} */ (outcome.answer)?.outcomes??[];
        const codes=Array.isArray(outcomes)?outcomes:Object.values(outcomes);
        for(const kind of [...(codes.some(item=>item?.outcome==="kept_stronger")?["semantics-contested"]:[]),...(codes.some(item=>item?.outcome==="corrected" || (row && !telemetry && ["applied","upgraded"].includes(item?.outcome)))?["semantics-correction"]:[]),...(telemetry&&fitted.asset.lastCheck?.clean?.length?["availability"]:[])]){
          try{await this.evolutionSignals?.record({userId,projectId,eventId:`semantics:${id}:${saved.revision}:${kind}`,moduleId:"sources",kind,capability:"dataset-research-scoping",operation:"transform",dataShape:"table",version:saved.revision});}catch{/* semantic write remains authoritative */}
        }
        return { ...outcome, asset: fitted.asset, revision: saved.revision, trimmed: fitted.trimmed };
      } catch (error) {
        if (error instanceof HttpError && error.code === "product_revision_conflict" && attempt < WRITE_ATTEMPTS) continue;
        if (error instanceof HttpError && error.code === "product_revision_conflict") throw new HttpError(409, "semantics_revision_conflict", "The record changed while it was being written; write it again.");
        throw error;
      }
    }
  }

  /**
   * Apply a patch of facts and bindings. `via` is where the words came from: the runtime's tool says
   * 'conversation', the files page says 'page'.
   * @param {string} userId @param {string} projectId @param {unknown} patch @param {{ via: 'conversation' | 'page' }} context
   */
  async write(userId, projectId, patch, { via }) {
    const datasetId = requireDatasetId(/** @type {any} */ (patch)?.datasetId);
    const done = await this.#mutate(userId, projectId, datasetId, true, (asset, now) => {
      const result = applySemanticsPatch(asset, patch, { now, via });
      return { asset: result.asset, changed: result.changed, answer: { outcomes: result.outcomes, issues: result.issues } };
    });
    return {
      datasetId, revision: done.revision, changed: done.changed, outcomes: done.answer.outcomes, issues: done.answer.issues, trimmed: done.trimmed,
      interpretation: sha256(interpretationOf(done.asset)), summary: summarizeSemantics(done.asset),
    };
  }

  /**
   * The researcher confirms facts as they stand, from the files page.
   * @param {string} userId @param {string} projectId @param {string} datasetId @param {readonly string[]} targets
   */
  async confirm(userId, projectId, datasetId, targets) {
    requireDatasetId(datasetId);
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 400 || targets.some((target) => typeof target !== "string" || target.length > 400)) {
      throw new HttpError(400, "semantics_request_invalid", "Name the facts to confirm.");
    }
    const done = await this.#mutate(userId, projectId, datasetId, false, (asset, now) => {
      const { patch, unknown } = confirmationPatch(asset, targets);
      const result = applySemanticsPatch(asset, { datasetId, ...patch }, { now, via: "page" });
      return { asset: result.asset, changed: result.changed, answer: { outcomes: result.outcomes, issues: result.issues, unknown } };
    });
    return { datasetId, revision: done.revision, changed: done.changed, outcomes: done.answer.outcomes, issues: done.answer.issues, unknown: done.answer.unknown,
      interpretation: sha256(interpretationOf(done.asset)), summary: summarizeSemantics(done.asset) };
  }

  /**
   * Keep the last check's findings (names, counts, row numbers) and the denominators it observed on the asset.
   * @param {string} userId @param {string} projectId @param {string} datasetId @param {unknown} report @param {unknown} denominators
   */
  async recordCheck(userId, projectId, datasetId, report, denominators) {
    requireDatasetId(datasetId);
    const done = await this.#mutate(userId, projectId, datasetId, false, (asset, now) => {
      const stored = structuredClone(asset);
      const result = applyCheckReport(stored, report, denominators, now);
      if ("problem" in result) throw new HttpError(400, "semantics_request_invalid", result.problem);
      return { asset: stored, changed: true, answer: null };
      // A check is how the data looked on a day, not a change of what it means: it would otherwise add a full copy of
      // the asset to the history every time an analysis looks.
    }, { telemetry: true });
    return { datasetId, revision: done.revision, recorded: true };
  }

  /**
   * Record a derived variable or a filter, and say whether it is new, the same, or what changed.
   * @param {string} userId @param {string} projectId @param {string} datasetId @param {unknown} transformation
   */
  async recordTransformation(userId, projectId, datasetId, transformation) {
    requireDatasetId(datasetId);
    const normalized = normalizeTransformation(transformation);
    if ("problem" in normalized) throw new HttpError(400, "semantics_request_invalid", normalized.problem);
    const done = await this.#mutate(userId, projectId, datasetId, true, (asset, now) => {
      const stored = structuredClone(asset);
      const result = applyTransformation(stored, normalized.transformation, now);
      if ("problem" in result) throw new HttpError(409, "semantics_asset_too_large", result.problem);
      return { asset: stored, changed: result.status !== "same" || result.rebound, answer: result };
    });
    return { datasetId, revision: done.revision, ...done.answer };
  }
}
