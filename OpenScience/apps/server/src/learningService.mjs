/**
 * The method ledger: where a learned method lives, how it changes, and the one
 * rule that no caller may talk its way past.
 *
 * Hidden knowledge: there is no `methods` table, and that is a decision rather
 * than an omission. A method is a `documents.kind="method"` row, its history is
 * `revisions`, and rolling one back is saving an old payload forward — the same
 * three primitives the plugin configuration already uses, tested by the same
 * conflict semantics. The first draft of this design had four new tables, a
 * queue, six endpoints and a seven-state lifecycle with a release review; every
 * one of those was a place for the loop's own bookkeeping to disagree with the
 * product's.
 *
 * The rule that has to be structural: **nothing that generates a method may
 * approve one.** `createCandidate` writes `candidate`, always, with no
 * parameter to say otherwise. `approve` does not take a verdict from its caller
 * either — it recomputes `promotionVerdict` from the stored document and
 * refuses if the answer is not "approved". So a distillation run that decides
 * it has produced something excellent, a consolidation job with a bug, and a
 * hand-written call from a future route all fail the same way. The only path to
 * `approved` runs through evidence that is on the record.
 *
 * The counterpart rule: an explicitly taught method needs none of that. When a
 * researcher says "always check the label revision date first", the loop is not
 * entitled to hold an opinion — `promotionVerdict` returns approved for an
 * explicit origin on the spot, and the safety net is that every change is a
 * revision and every revision can be restored.
 *
 * @module learningService
 */

import { createHash } from "node:crypto";

import {
  METHOD_STATUSES,
  emptyLearning,
  foldEligible,
  foldEvaluation,
  foldObservation,
  foldRelation,
  methodContentDigest,
  libraryEvictions,
  promotionVerdict,
  relationIssues,
  resetLearningForDigest,
  retirementProposal,
  validateMethodSkill,
} from "@evimed/domain";
import { productId } from "./productPersistence.mjs";
import { HttpError } from "./security.mjs";

/** What a method document's payload calls itself, distinct from the
 *  `source-method` rows the source pipeline already writes under this kind. */
export const LEARNED_METHOD_RECORD_TYPE = "learned-method";

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** @param {string} name @returns {string} */
export function learnedMethodId(name) {
  return `method:learned:${name}`;
}

/** @param {any} document @returns {boolean} */
export function isLearnedMethod(document) {
  return document?.payload?.recordType === LEARNED_METHOD_RECORD_TYPE;
}

/**
 * The shape `promotionVerdict` and `retirementProposal` read, assembled from a
 * stored document. Kept in one function because the two callers that build it
 * by hand would be the two that disagree.
 * @param {any} document
 * @returns {any}
 */
export function methodRecordFrom(document) {
  const payload = document?.payload ?? {};
  return {
    id: document?.id,
    name: payload.frontmatter?.name ?? "",
    digest: payload.contentDigest ?? "",
    status: payload.status ?? "candidate",
    dependencies: payload.dependencies ?? [],
    learning: payload.learning ?? emptyLearning(payload.contentDigest ?? ""),
    provenance: payload.provenance ?? { origin: "inferred" },
  };
}

export class LearningService {
  /**
   * @param {{documents: any, jobs?: any, notifications?: any, now?: () => Date}} dependencies
   */
  constructor({ documents, jobs = null, notifications = null, now = () => new Date() }) {
    if (!documents) throw new TypeError("The learning service needs the product document store.");
    this.documents = documents;
    this.jobs = jobs;
    this.notifications = notifications;
    this.now = now;
  }

  /**
   * Validate a proposed body and compute its digest.
   *
   * Called on every write, including the ones that originate inside this
   * control plane: a method that reaches the store is a method that will be
   * mounted read-only into a container, and the check that it names no absent
   * tool and carries no credential is worth more at the boundary than in the
   * caller that happens to be trusted today.
   * @param {{frontmatter: any, body: string, files?: any, requireProvenance?: boolean, resolveDigest?: (d: any) => boolean, mountedTools?: readonly string[]}} input
   */
  #validated(input) {
    const verdict = validateMethodSkill({
      frontmatter: input.frontmatter,
      body: input.body,
      files: input.files,
      directoryName: input.frontmatter?.name,
      requireProvenance: input.requireProvenance !== false,
      resolveDigest: input.resolveDigest,
      ...(input.mountedTools ? { mountedTools: input.mountedTools } : {}),
    });
    if (!verdict.ok) {
      throw new HttpError(422, "method_invalid", verdict.issues.slice(0, 4).map((issue) => `${issue.code}: ${issue.message}`).join(" "));
    }
    return methodContentDigest({ frontmatter: input.frontmatter, body: input.body, files: input.files }, sha256);
  }

  /**
   * A resolver for `depends_on`, built from what this account actually holds.
   *
   * The contract validator cannot do this — it runs inside the run, which has
   * no method store — so `method_depends_on_unresolved` would never fire
   * anywhere unless the control plane decided it here. A method pinning a
   * digest nobody has is a reuse reference pointing at text that does not
   * exist, and it fails silently at mount time.
   * @param {string} userId
   * @returns {Promise<(dependency: {name: string, digest: string}) => boolean>}
   */
  async #digestResolver(userId) {
    const page = await this.documents.list(userId, "method", { limit: 100, filter: { recordType: LEARNED_METHOD_RECORD_TYPE } });
    /** @type {Map<string, Set<string>>} */
    const digests = new Map();
    for (const document of page.items ?? []) {
      const name = document.payload?.frontmatter?.name;
      if (!name) continue;
      const known = digests.get(name) ?? new Set();
      known.add(document.payload?.contentDigest);
      digests.set(name, known);
    }
    return (dependency) => Boolean(digests.get(dependency.name)?.has(dependency.digest));
  }

  /**
   * Record a new candidate.
   *
   * There is no `status` parameter. A caller who wants one is a caller who has
   * decided their own output is good enough to mount.
   * @param {string} userId
   * @param {{projectId?: string|null, frontmatter: any, body: string, files?: any, provenance: any, dependencies?: any[], mountedTools?: readonly string[]}} input
   */
  async createCandidate(userId, input) {
    const digest = this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
    const name = String(input.frontmatter?.name ?? "");
    const id = learnedMethodId(name);
    const provenance = { origin: "inferred", ...input.provenance };
    /** @type {any} */
    const payload = {
      recordType: LEARNED_METHOD_RECORD_TYPE,
      status: "candidate",
      frontmatter: input.frontmatter,
      body: input.body,
      ...(input.files ? { files: input.files } : {}),
      dependencies: input.dependencies ?? [],
      contentDigest: digest,
      learning: emptyLearning(digest),
      provenance,
      createdAt: this.now().toISOString(),
    };
    // A method the researcher wrote takes effect now.
    //
    // The verdict is computed here rather than passed in — the same rule
    // `approve` applies, in the same module, from the record's own fields — so
    // there is still exactly one place that decides what may be mounted and no
    // caller can assert its way past it. For an inferred method this is never
    // true at creation: it has no observations and no evaluation, so
    // `promotionVerdict` returns `candidate` and the nightly job is still the
    // only path to effect.
    //
    // This is what makes the absence of an approve route honest rather than a
    // gap. Without it the only way a method could ever be mounted was to
    // survive a threshold that needs the method to have already been mounted.
    const verdict = promotionVerdict(methodRecordFrom({ id, payload }));
    if (verdict.status === "approved") {
      payload.status = "approved";
      payload.statusReason = verdict.reasons[0] ?? "";
      // The same field `#setStatus` stamps, so "when did this become effective"
      // has one answer however it became effective.
      payload.statusChangedAt = payload.createdAt;
    }
    await this.documents.put(userId, "method", productId(id, "method"), payload, {
      expectedRevision: 0,
      projectId: input.projectId ?? null,
    });
    return this.getMethod(userId, id);
  }

  /**
   * Replace a method's body, which resets everything measured about the old one.
   *
   * A revised method goes back to `candidate` even if it was effective, and its
   * counters go to zero. That is the whole point of keying counts to
   * `(method, contentDigest)`: the alternative is EvoDS's, where a rewrite
   * inherits its predecessor's confidence and the authors left a comment saying
   * they knew.
   * @param {string} userId
   * @param {string} methodId
   * @param {{expectedRevision: number, frontmatter: any, body: string, files?: any, provenance?: any, dependencies?: any[], mountedTools?: readonly string[]}} input
   */
  async amendMethod(userId, methodId, input) {
    const current = await this.getMethod(userId, methodId);
    const digest = this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
    const learning = resetLearningForDigest(current.payload.learning, digest);
    const payload = {
      ...current.payload,
      status: digest === current.payload.contentDigest ? current.payload.status : "candidate",
      frontmatter: input.frontmatter,
      body: input.body,
      ...(input.files ? { files: input.files } : { files: undefined }),
      dependencies: input.dependencies ?? current.payload.dependencies ?? [],
      contentDigest: digest,
      learning,
      provenance: { ...current.payload.provenance, ...input.provenance },
      updatedAt: this.now().toISOString(),
    };
    if (payload.files === undefined) delete payload.files;
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision: input.expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /** @param {string} userId @param {string} methodId */
  async getMethod(userId, methodId) {
    const document = await this.documents.get(userId, "method", productId(methodId, "method"));
    if (!document) throw new HttpError(404, "method_not_found", "The method is unavailable.");
    return document;
  }

  /**
   * @param {string} userId
   * @param {{projectId?: string|null, status?: string, limit?: number, cursor?: string|null}} [options]
   */
  async listMethods(userId, options = {}) {
    const filter = { recordType: LEARNED_METHOD_RECORD_TYPE, ...(options.status ? { status: options.status } : {}) };
    return this.documents.list(userId, "method", {
      limit: options.limit ?? 50,
      cursor: options.cursor ?? null,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      filter,
    });
  }

  /**
   * The methods a run may mount: effective, and nothing else.
   * @param {string} userId @param {{projectId?: string|null}} [options]
   */
  async approvedMethods(userId, options = {}) {
    const page = await this.listMethods(userId, { ...options, status: "approved", limit: 100 });
    return page.items ?? [];
  }

  /**
   * Promote a candidate, if the record says it may be promoted.
   *
   * The verdict is recomputed here rather than accepted from the caller. A
   * consolidation job that has just spent an hour reasoning about a method is
   * exactly the caller most likely to believe its own conclusion, and this is
   * the one place where believing it would put unvalidated text into every
   * later run of a project.
   * @param {string} userId
   * @param {string} methodId
   * @param {{expectedRevision: number, currentBaselineDigest?: string}} input
   */
  async approve(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    const verdict = promotionVerdict(methodRecordFrom(document), {
      ...(input.currentBaselineDigest ? { currentBaselineDigest: input.currentBaselineDigest } : {}),
    });
    if (verdict.status !== "approved") {
      throw new HttpError(409, "method_not_promotable", `The method is not eligible: ${verdict.missing.join("; ")}`);
    }
    const updated = await this.#setStatus(userId, methodId, "approved", input.expectedRevision, document);
    await this.#notify(userId, document, {
      title: "已启用一条学到的方法",
      body: `${document.payload.frontmatter?.name}：${verdict.reasons.join("；")}。可随时回滚到上一版本。`,
    });
    return updated;
  }

  /**
   * Retire a method. Unlike promotion this needs no evidence, because stopping
   * is always allowed and is always reversible by restoring a revision.
   * @param {string} userId @param {string} methodId @param {{expectedRevision: number, reason?: string}} input
   */
  async retire(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    const updated = await this.#setStatus(userId, methodId, "retired", input.expectedRevision, document, input.reason);
    await this.#notify(userId, document, {
      title: "已停用一条学到的方法",
      body: `${document.payload.frontmatter?.name}：${input.reason ?? "不再使用"}。`,
    });
    return updated;
  }

  /** @param {string} userId @param {string} methodId @param {{expectedRevision: number}} input */
  async revive(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    return this.#setStatus(userId, methodId, "candidate", input.expectedRevision, document);
  }

  /**
   * @param {string} userId @param {string} methodId @param {string} status
   * @param {number} expectedRevision @param {any} document @param {string} [reason]
   */
  async #setStatus(userId, methodId, status, expectedRevision, document, reason) {
    if (!METHOD_STATUSES.includes(status)) throw new HttpError(400, "method_status_invalid", "Unknown method status.");
    const payload = {
      ...document.payload,
      status,
      ...(reason ? { statusReason: String(reason).slice(0, 500) } : {}),
      statusChangedAt: this.now().toISOString(),
    };
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * Restore an earlier revision by saving it forward.
   *
   * Never by deleting: the history of a method includes the versions that were
   * withdrawn, and a rollback that erased its own cause would remove the
   * evidence for the next decision about the same method.
   * @param {string} userId @param {string} methodId @param {{expectedRevision: number, targetRevision: number}} input
   */
  async rollback(userId, methodId, input) {
    const history = await this.documents.history(userId, "method", methodId, { limit: 100 });
    const target = (history.items ?? history ?? []).find((entry) => entry.revision === input.targetRevision);
    if (!target) throw new HttpError(404, "method_revision_unavailable", "That method revision is unavailable.");
    const payload = {
      ...target.payload,
      // A restored body is a body whose measurements were taken elsewhere. It
      // comes back as a candidate for the same reason an amendment does.
      status: target.payload.status === "approved" ? "approved" : "candidate",
      restoredFromRevision: input.targetRevision,
      updatedAt: this.now().toISOString(),
    };
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision: input.expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * Fold one run's use of a method into its counters.
   *
   * Silently does nothing when the document has moved on to a different body:
   * an observation about text that is no longer mounted is not evidence about
   * the method that is.
   * @param {string} userId @param {string} methodId @param {any} observation
   */
  async recordObservation(userId, methodId, observation) {
    const document = await this.getMethod(userId, methodId);
    const learning = foldObservation(document.payload.learning, observation);
    if (learning === document.payload.learning) return document;
    return this.#saveLearning(userId, methodId, document, learning);
  }

  /** @param {string} userId @param {string} methodId */
  async recordEligible(userId, methodId) {
    const document = await this.getMethod(userId, methodId);
    return this.#saveLearning(userId, methodId, document, foldEligible(document.payload.learning));
  }

  /** @param {string} userId @param {string} methodId @param {any} evaluation */
  async recordEvaluation(userId, methodId, evaluation) {
    const document = await this.getMethod(userId, methodId);
    return this.#saveLearning(userId, methodId, document, foldEvaluation(document.payload.learning, evaluation));
  }

  /**
   * @param {string} userId @param {string} methodId @param {any[]} relations
   * @param {(id: string) => boolean} [exists]
   */
  async recordRelations(userId, methodId, relations, exists) {
    const document = await this.getMethod(userId, methodId);
    let learning = document.payload.learning;
    for (const relation of relations ?? []) {
      const issues = relationIssues(relation, exists);
      if (issues.length) {
        throw new HttpError(422, "method_relation_invalid", issues.slice(0, 3).map((issue) => issue.message).join(" "));
      }
      learning = foldRelation(learning, relation);
    }
    return this.#saveLearning(userId, methodId, document, learning);
  }

  /** @param {string} userId @param {string} methodId @param {any} document @param {any} learning */
  async #saveLearning(userId, methodId, document, learning) {
    await this.documents.put(userId, "method", methodId, { ...document.payload, learning }, {
      expectedRevision: document.revision,
    });
    return this.getMethod(userId, methodId);
  }

  /**
   * Which effective methods should be proposed for retirement tonight.
   * A proposal, not an action: the caller sends a notice with a rollback target.
   * @param {string} userId @param {{projectId?: string|null, nowMs?: number, cap?: number}} [options]
   */
  async retirementProposals(userId, options = {}) {
    const page = await this.listMethods(userId, { ...options, limit: 100 });
    const items = page.items ?? [];
    const approved = new Set(items.filter((item) => item.payload.status === "approved").map((item) => item.id));
    /** @type {{document: any, proposal: any}[]} */
    const proposals = [];
    const records = new Map(items.map((document) => [document.id, methodRecordFrom(document)]));
    for (const document of items) {
      if (document.payload.status !== "approved") continue;
      const proposal = retirementProposal(/** @type {any} */ (records.get(document.id)), {
        nowMs: options.nowMs ?? this.now().getTime(),
        isApproved: (id) => approved.has(id),
      });
      if (proposal.propose) proposals.push({ document, proposal });
    }
    // The library-level rule, on top of the per-method ones.
    //
    // Every clause above asks "is this method worth keeping" and a library can
    // pass all of them method by method and still be too large to retrieve from
    // — which is the failure mode the published work names, and its symptom is
    // silence: the wrong method gets injected and the run says nothing. So the
    // cap is applied to what is left after the per-method proposals, and it
    // proposes the lowest contributions until the library is back under it.
    const proposed = new Set(proposals.map((entry) => entry.document.id));
    const remaining = items.filter((document) => document.payload.status === "approved" && !proposed.has(document.id));
    for (const eviction of libraryEvictions(remaining.map((document) => records.get(document.id)), { cap: options.cap })) {
      const document = remaining.find((entry) => entry.id === eviction.id);
      if (document) proposals.push({ document, proposal: { propose: true, immediate: false, reason: eviction.reason, strength: 0, contribution: eviction.contribution } });
    }
    return proposals;
  }

  /** @param {string} userId @param {any} document @param {{title: string, body: string}} notice */
  async #notify(userId, document, notice) {
    if (!this.notifications) return;
    try {
      await this.notifications.create(userId, {
        noticeType: "notify",
        title: notice.title,
        body: notice.body,
        ...(document.projectId ? { projectId: document.projectId } : {}),
        source: { type: "system", id: document.id },
        idempotencyKey: `method-status:${document.id}:${document.revision}`,
      });
    } catch {
      // isolated: evimed_learning_notice_failed_total
    }
  }
}
