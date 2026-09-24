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
 * assert its own status.** `createCandidate` takes no `status` parameter and
 * `approve` takes no verdict; both recompute `promotionVerdict` from the stored
 * document. So a distillation run that decides it has produced something
 * excellent, a consolidation job with a bug, and a hand-written call from a
 * future route all reach exactly the same answer as everybody else.
 *
 * What that answer is changed on 2026-09-20. It used to be: an inferred method
 * waits for three trajectories, two independent runs and a passing paired
 * evaluation against a live baseline. In production it never once cleared that
 * bar — `learningEvaluationCommand` defaults to empty, so the evaluate job
 * failed terminally by name and `evimed_product.documents` held zero effective
 * methods while the product told researchers it learned their way of working.
 * The evidence bar moved to demotion: a method takes effect the night it is
 * learned, wears 「新」, and the same paired evaluation runs afterwards and
 * retires it if it measures worse (`retirementProposal`). The only thing that
 * still blocks effect is an unresolved conflict with another method, which no
 * measurement repairs. The safety net is unchanged: every change is a revision
 * and every revision can be restored.
 *
 * @module learningService
 */

import { createHash } from "node:crypto";

import {
  METHOD_STATUSES,
  cleanMethodDisplay,
  emptyLearning,
  foldEligible,
  foldEvaluation,
  foldObservation,
  foldRead,
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

/**
 * How many candidates one trial may name.
 *
 * A paired evaluation measures one change at a time; a trial naming a dozen
 * candidates would produce a verdict nobody could attribute to any of them.
 */
export const MAX_TRIAL_METHODS = 4;

export class LearningService {
  /**
   * No inbox: the method library's own changes — a method put in force or
   * retired — are shown on the memory page, in the method's own row and its
   * history, and used to arrive as quiet inbox records nobody read, under the
   * 「自动运行」 fold (plan 2026-09-23 §5.8).
   *
   * @param {{documents: any, jobs?: any, now?: () => Date,
   * resolveBaselineDigest?: (userId: string, projectId: string) => Promise<string>}} dependencies
   */
  constructor({ documents, jobs = null, now = () => new Date(), resolveBaselineDigest }) {
    if (!documents) throw new TypeError("The learning service needs the product document store.");
    this.documents = documents;
    this.jobs = jobs;
    this.now = now;
    this.resolveBaselineDigest = resolveBaselineDigest;
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
   * decided its own output is good enough to mount; what decides is the verdict
   * below, over the record's own fields.
   * @param {string} userId
   * @param {{projectId?: string|null, frontmatter: any, body: string, files?: any, provenance: any, dependencies?: any[], mountedTools?: readonly string[], display?: unknown}} input
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
      // The researcher's line for the method (`cleanMethodDisplay`); outside
      // the digest, like everything else on the record that is not SKILL.md.
      ...(cleanMethodDisplay(input.display) ? { display: cleanMethodDisplay(input.display) } : {}),
      createdAt: this.now().toISOString(),
    };
    // A method takes effect now — the researcher's own, and since 2026-09-20 a
    // distilled one too (see `promotionVerdict`: the evidence bar moved to
    // demotion, because under stock configuration the promotion bar had never
    // once been cleared).
    //
    // The verdict is computed here rather than passed in — the same rule
    // `approve` applies, in the same module, from the record's own fields — so
    // there is still exactly one place that decides what may be mounted and no
    // caller can assert its way past it. A fresh candidate with an unresolved
    // conflict is still born `candidate`, which is the one thing measurement
    // cannot repair.
    const verdict = promotionVerdict(methodRecordFrom({ id, payload }));
    if (verdict.status === "approved") {
      payload.status = "approved";
      // The reader's sentence; `verdict.reasons` are the log's.
      payload.statusReason = payload.provenance?.origin === "explicit"
        ? "你亲口定下的做法，已直接生效；回到上一版即可撤销。"
        : "从你自己的研究里学到，已直接生效；用上它的研究若明显更常被退回，会自动停用，你也可以随时停用。";
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
   * @param {{expectedRevision: number, frontmatter: any, body: string, files?: any, provenance?: any, dependencies?: any[], mountedTools?: readonly string[], display?: unknown}} input
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
      // A new line when the revision brought one; otherwise the old one stands.
      ...(cleanMethodDisplay(input.display) ? { display: cleanMethodDisplay(input.display) } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (payload.files === undefined) delete payload.files;
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision: input.expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * Give a method the line its researcher reads, and nothing else: not a
   * revision of the method (the digest, status and counters are untouched).
   * @param {string} userId @param {string} methodId @param {unknown} display
   */
  async setDisplay(userId, methodId, display) {
    const cleaned = cleanMethodDisplay(display);
    if (!cleaned) throw new HttpError(422, "method_display_invalid", "A method's display needs a title and a summary within their limits.");
    const document = await this.getMethod(userId, methodId);
    await this.documents.put(userId, "method", document.id, { ...document.payload, display: cleaned }, {
      expectedRevision: document.revision,
    });
    return this.getMethod(userId, methodId);
  }

  /** @param {string} userId @param {string} methodId */
  async getMethod(userId, methodId) {
    const document = await this.documents.get(userId, "method", productId(methodId, "method"));
    if (!document) throw new HttpError(404, "method_not_found", "The method is unavailable.");
    return document;
  }

  /**
   * The candidates this project is mounting under trial, or an empty list.
   *
   * A trial is the one way a method the loop has not approved reaches a
   * container, and it exists because without it the loop cannot close:
   * promotion needs observed trajectories, trajectories need the method to have
   * been mounted, and only approved methods are mounted. The paired evaluation
   * breaks that circle by naming the candidate it is measuring.
   *
   * Expiry is applied on read rather than by a sweeper. A row nobody cleared is
   * then harmless by the time it matters, and there is no job whose failure
   * would leave an unproven method mounted indefinitely.
   *
   * @param {string} userId @param {string} projectId
   * @returns {Promise<{methodIds: string[], digestById: Record<string, string>, expiresAt: string|null, requestedBy: string|null}>}
   */
  async methodTrial(userId, projectId) {
    const empty = { methodIds: [], digestById: {}, expiresAt: null, requestedBy: null };
    let document = null;
    try { document = await this.documents.get(userId, "method-trial", productId(String(projectId), "project id")); }
    catch { return empty; }
    const payload = document?.payload;
    if (!payload || document.deletedAt) return empty;
    const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : null;
    if (expiresAt && Date.parse(expiresAt) <= this.now().getTime()) return empty;
    const methodIds = Array.isArray(payload.methodIds)
      ? payload.methodIds.filter((value) => typeof value === "string" && value.trim()).map(String)
      : [];
    const digestById = payload.digestById && typeof payload.digestById === "object" && !Array.isArray(payload.digestById)
      ? payload.digestById
      : {};
    return { methodIds, digestById, expiresAt, requestedBy: payload.requestedBy ?? null };
  }

  /**
   * Put candidates on trial for one project.
   *
   * The digest of each method as it stands now is recorded beside its id, so
   * the arm that asked can read back what it actually got. An evaluation that
   * measured a method which was amended between the request and the launch
   * would otherwise report a verdict about text nobody chose.
   *
   * Only `candidate` methods may be named: putting an approved method "on
   * trial" would be a no-op that reads as a control, and putting a retired one
   * on trial would resurrect it by a route with no promotion rule behind it.
   *
   * @param {string} userId
   * @param {{projectId: string, methodIds: readonly string[], requestedBy: string, ttlMs: number}} input
   */
  async setMethodTrial(userId, input) {
    const projectId = productId(String(input.projectId ?? ""), "project id");
    const ids = [...new Set((input.methodIds ?? []).map((value) => String(value)))].filter(Boolean);
    if (ids.length === 0) throw new HttpError(400, "method_trial_empty", "A trial must name at least one method.");
    if (ids.length > MAX_TRIAL_METHODS) {
      throw new HttpError(400, "method_trial_too_many", `A trial may name at most ${MAX_TRIAL_METHODS} methods.`);
    }
    /** @type {Record<string, string>} */
    const digestById = {};
    for (const methodId of ids) {
      const document = await this.getMethod(userId, methodId);
      const status = document.payload?.status;
      // Anything but retired. It read `!== "candidate"` until 2026-09-20, when
      // a distilled method started taking effect the night it is learned:
      // every method the evaluation account would want to pin is `approved`
      // from birth, and a trial that only accepted candidates could pin none
      // of them.
      if (status === "retired" || !status) {
        throw new HttpError(409, "method_trial_not_candidate", `A retired method cannot be put on trial; ${methodId} is ${status}.`);
      }
      digestById[methodId] = String(document.payload?.contentDigest ?? "");
    }
    const expiresAt = new Date(this.now().getTime() + Math.max(60_000, Number(input.ttlMs) || 0)).toISOString();
    const payload = { methodIds: ids, digestById, expiresAt, requestedBy: String(input.requestedBy ?? ""), setAt: this.now().toISOString() };
    // One row per project, replaced in place. A deleted row is restored rather
    // than inserted over, because the store keeps the revision of a removed
    // document and an insert at revision 0 would conflict with it forever.
    const current = await this.documents.get(userId, "method-trial", projectId, { includeDeleted: true });
    if (current?.deletedAt) await this.documents.restore(userId, "method-trial", projectId, current.revision);
    const revision = current ? (current.deletedAt ? current.revision + 1 : current.revision) : 0;
    await this.documents.put(userId, "method-trial", projectId, payload, { expectedRevision: revision, projectId });
    return payload;
  }

  /** @param {string} userId @param {string} projectId @returns {Promise<boolean>} */
  async clearMethodTrial(userId, projectId) {
    const id = productId(String(projectId ?? ""), "project id");
    const current = await this.documents.get(userId, "method-trial", id);
    if (!current) return false;
    await this.documents.remove(userId, "method-trial", id, current.revision);
    return true;
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

  /** Read the current owner/project mount, never a digest asserted by a caller.
   * An unscoped inferred method has no project baseline it can safely claim.
   * @param {string} userId @param {string|null} projectId
   */
  async currentBaselineDigest(userId, projectId) {
    if (!projectId || !this.resolveBaselineDigest) return "";
    return this.resolveBaselineDigest(userId, projectId);
  }

  /**
   * Promote a candidate, if the record says it may be promoted.
   *
   * The verdict is recomputed here rather than accepted from the caller. A
   * consolidation job that has just spent an hour reasoning about a method is
   * exactly the caller most likely to believe its own conclusion, and this is
   * the one place where believing it would put unvalidated text into every
   * later run of a project.
   * The current baseline is read here, immediately before the revision write;
   * a caller-supplied digest cannot make an old evaluation current again.
   * @param {string} userId
   * @param {string} methodId
   * @param {{expectedRevision: number}} input
   */
  async approve(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    // No baseline read: since 2026-09-20 the verdict reads the method's own
    // conflicts and nothing else, so fetching a digest it will not look at
    // would be one more thing to be down at the moment of a write.
    const verdict = promotionVerdict(methodRecordFrom(document));
    if (verdict.status !== "approved") {
      throw new HttpError(409, "method_not_promotable", `The method is not eligible: ${verdict.missing.join("; ")}`);
    }
    return this.#setStatus(userId, methodId, "approved", input.expectedRevision, document);
  }

  /**
   * Retire a method. Unlike promotion this needs no evidence, because stopping
   * is always allowed and is always reversible by restoring a revision.
   *
   * There is no `revive`. There was, and it had no caller: `rollback` already
   * restores an earlier revision, which is the reversal this docstring
   * promises and the one the route exposes. Two ways to un-retire a method
   * would have been two places for the status rules to drift, and the second
   * one was reachable from nowhere.
   * @param {string} userId @param {string} methodId @param {{expectedRevision: number, reason?: string}} input
   */
  async retire(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    return this.#setStatus(userId, methodId, "retired", input.expectedRevision, document, input.reason);
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
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = await this.getMethod(userId, methodId);
      if (observation?.contentDigest && observation.contentDigest !== document.payload.contentDigest) return document;
      const learning = foldObservation(document.payload.learning, observation);
      if (learning === document.payload.learning) return document;
      try {
        return await this.#saveLearning(userId, methodId, document, learning);
      } catch (error) {
        if (error?.code !== "product_revision_conflict" || attempt === 7) throw error;
      }
    }
    throw new HttpError(409, "product_revision_conflict", "Concurrent method observations did not settle.");
  }

  /** @param {string} userId @param {string} methodId */
  async recordEligible(userId, methodId) {
    const document = await this.getMethod(userId, methodId);
    return this.#saveLearning(userId, methodId, document, foldEligible(document.payload.learning));
  }

  /**
   * Count a run that read the body with no delegation to attribute it to.
   *
   * Separate from `recordObservation` because it has to be: an observation
   * carries a deliverable's verdict, and these runs produce no deliverable.
   * The only thing it may change is whether the retirement rule reads the
   * method as idle.
   * @param {string} userId @param {string} methodId @param {string} [at]
   */
  async recordRead(userId, methodId, at = new Date().toISOString()) {
    const document = await this.getMethod(userId, methodId);
    return this.#saveLearning(userId, methodId, document, foldRead(document.payload.learning, at));
  }

  /** @param {string} userId @param {string} methodId @param {any} evaluation */
  async recordEvaluation(userId, methodId, evaluation) {
    const document = await this.getMethod(userId, methodId);
    // The verdict names the text it measured, and this is where that claim is
    // checked against the text the method holds now. An evaluation runs for
    // hours; the method can be amended while it is in flight, and the amend
    // resets the record, so an unchecked write made the old text's score the
    // new text's first vote. Refused loudly rather than folded quietly: a
    // measurement of something that no longer exists is not a smaller fact, it
    // is a different one.
    const measured = typeof evaluation?.candidateDigest === "string" ? evaluation.candidateDigest : null;
    if (measured !== null && measured !== document.payload.contentDigest) {
      throw new HttpError(409, "method_evaluation_stale",
        "The evaluation measured a revision this method no longer holds; it was not recorded.");
    }
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

}

/**
 * What a researcher calls a method: its own Chinese line when it has one, its
 * machine name until then.
 * @param {any} document
 */
export function methodLabel(document) {
  return cleanMethodDisplay(document?.payload?.display)?.title ?? document?.payload?.frontmatter?.name ?? String(document?.id ?? "");
}
