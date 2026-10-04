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
 * Two things a method is not, since 2026-09-27 (audit 2026-09-26, L-G1/L-G4):
 *
 *  - **Not a project's.** A method follows the researcher, so it is stored at
 *    account level (`project_id` NULL) and the project it was learnt in is a
 *    fact of its provenance (`provenance.sourceProjectId`). It used to be filed
 *    under that project, and `documents(user_id, project_id) → projects ON
 *    DELETE CASCADE` took `pre-submission-freeze-check` and every one of its
 *    revisions with the project on 2026-09-23.
 *  - **Not its counters.** A use is telemetry, written without a revision
 *    (`ProductDocuments.put` `telemetry`). A method that saved each use as a
 *    revision had 77 of them and two bodies, and 「回到上一版」 restored a
 *    counter. `bodyVersion` counts the bodies; `history` lists them.
 *
 * @module learningService
 */

import { createHash } from "node:crypto";

import {
  METHOD_STATUSES,
  appendMethodLink,
  cleanMethodDisplay,
  cleanMethodScope,
  cleanMethodSteps,
  emptyLearning,
  foldEligible,
  foldEvaluation,
  foldMethodFeedback,
  foldObservation,
  foldRead,
  foldRelation,
  foldSourceChange,
  mergeMethodResultLinks,
  methodContentDigest,
  libraryEvictions,
  mountedMethodDigest,
  promotionVerdict,
  relationIssues,
  resetLearningForDigest,
  retirementProposal,
  unresolvedConflicts,
  validateMethodSkill,
} from "@evimed/domain";
import { productId } from "./productPersistence.mjs";
import { HttpError } from "./security.mjs";

/** What a method document's payload calls itself, distinct from the
 *  `source-method` rows the source pipeline already writes under this kind. */
export const LEARNED_METHOD_RECORD_TYPE = "learned-method";

/**
 * A lesson whose only evidence was the platform's own reviewer — the gate's
 * findings a run repaired against, with nothing the researcher said or changed.
 *
 * It is about how to pass EviMed's checks, which is the capability's handbook
 * (the L2 loop, spec §19.17), not how this person works. Both methods the loop
 * learnt in production were of this kind and sat in the researcher's own list
 * as 「我的做法」 (audit 2026-09-26, L-G3). Such a lesson stays under its own
 * record type: never listed as the researcher's or exported in a pack. The
 * handbook loop applies it as a separate owner-scoped capability supplement.
 */
export const HANDBOOK_CANDIDATE_RECORD_TYPE = "handbook-candidate";

/** @param {string} text @returns {string} */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** @param {string} name @returns {string} */
export function learnedMethodId(name) {
  return `method:learned:${name}`;
}

/** @param {string} name @returns {string} */
export function handbookCandidateId(name, capabilityId = "") {
  return `method:handbook:${capabilityId ? `${capabilityId}:` : ""}${name}`;
}

/** @param {any} document @returns {boolean} */
export function isLearnedMethod(document) {
  return document?.payload?.recordType === LEARNED_METHOD_RECORD_TYPE;
}

/**
 * Why a method that is not retired stands as it does, in the reader's words.
 *
 * Computed from the record rather than stored and trusted: a stored reason is
 * a sentence written by whichever code path last touched the method, and
 * `claim-verdict-audit` still carried an English one naming a retirement
 * mechanism that no longer exists (audit 2026-09-26, L-G8). A retired method's
 * reason is the one written when it was stopped (`retirementSentence`, or the
 * researcher's own 停用), and is kept.
 * @param {any} payload
 * @returns {string}
 */
export function effectiveStatusReason(payload) {
  if (payload?.status === "candidate") {
    return unresolvedConflicts(payload?.learning?.relations).length
      ? "它和另一条做法说法相反，理清之前不会用上。"
      : "刚刚更新过，下一次整理时生效。";
  }
  // Returned to an earlier body because the results produced under the newer one were found wrong (N14): said while it
  // is still the body the method was returned to. What the sentence claims is an association and never a cause.
  const returned = Array.isArray(payload?.links) ? payload.links.at(-1) : null;
  if (returned?.type === "rolled_back_for_regression" && returned.toDigest === payload?.contentDigest) {
    return `用上较新一版后，${returned.results} 个结果里有 ${returned.against} 个没能被重算复现，或被你改正过，已回到这一版；这只说明两者相伴出现，不证明是这条做法造成的。`;
  }
  return payload?.provenance?.origin === "explicit"
    ? "你亲口定下的做法，已直接生效；回到上一版即可撤销。"
    : "从你自己的研究里学到，已直接生效；用上它的研究若明显更常被退回，会自动停用，你也可以随时停用。";
}

/**
 * Which body this is, counting from 1: the number of different texts the
 * method has held. A method written before the count existed is on its first
 * as far as the record can say (the migration fills it from the revisions).
 * @param {any} payload @returns {number}
 */
export function bodyVersionOf(payload) {
  const value = Number(payload?.bodyVersion);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/**
 * The researcher-facing steps of a method, when they render the body it holds
 * now; null otherwise.
 * @param {any} payload @returns {string | null}
 */
export function methodStepsOf(payload) {
  const steps = payload?.displaySteps;
  return steps && steps.contentDigest === payload?.contentDigest ? cleanMethodSteps(steps.text) : null;
}

/**
 * The scope a method declared for itself, in the distillation's own words, and whether it describes the body the method
 * holds now: a scope is written with the body it restates (`applies_when`, `not_when`), and an amendment that brings no
 * new one leaves the old standing and says it is no longer current.
 * @param {any} payload
 * @returns {{ applicability: string, counterexamples: string[], current: boolean } | null}
 */
export function methodScopeOf(payload) {
  const scope = cleanMethodScope(payload?.scope);
  return scope ? { ...scope, current: payload.scope.digest === payload?.contentDigest } : null;
}

/**
 * A provenance with the result versions it names merged into what the method already named, once each and bounded.
 * @param {any} provenance @param {unknown} [earlier]
 */
function withResultLinks(provenance, earlier = []) {
  const { results: named, ...rest } = provenance ?? {};
  const merged = mergeMethodResultLinks(earlier, named);
  return merged.length ? { ...rest, results: merged } : rest;
}

/**
 * The project a method was learnt in, from whatever the caller named: the
 * provenance's own field first, then the project the caller passed.
 * @param {any} provenance @param {unknown} projectId
 * @returns {string | null}
 */
function sourceProjectOf(provenance, projectId) {
  for (const value of [provenance?.sourceProjectId, projectId]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * The shape `promotionVerdict` and `retirementProposal` read, assembled from a
 * stored document. Kept in one function because the two callers that build it
 * by hand would be the two that disagree.
 * @param {any} document @param {{revisions?: readonly string[]}} [extra]
 * @returns {any}
 */
export function methodRecordFrom(document, { revisions = undefined } = {}) {
  const payload = document?.payload ?? {};
  return {
    id: document?.id,
    name: payload.frontmatter?.name ?? "",
    digest: payload.contentDigest ?? "",
    status: payload.status ?? "candidate",
    dependencies: payload.dependencies ?? [],
    learning: payload.learning ?? emptyLearning(payload.contentDigest ?? ""),
    provenance: payload.provenance ?? { origin: "inferred" },
    // What later became of the results produced under each revision (N14), and — only where a caller needed the lifecycle
    // to answer which earlier body to return to — every body the method has held, newest first.
    ...(payload.scientific ? { scientific: payload.scientific } : {}),
    ...(revisions ? { revisions } : {}),
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
   *
   * Every saved revision counts, not only the current one: a lesson learned
   * against an earlier body of a method it reuses still names text the ledger
   * holds. Reading only the current digest refused the restore of
   * `pre-submission-freeze-check` (lost with its project on 09-23), which
   * pins `claim-verdict-audit` as it was before its amendment of 09-22.
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
      for (const saved of await this.#savedRevisions(userId, document.id)) {
        if (saved?.payload?.contentDigest) known.add(saved.payload.contentDigest);
      }
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
   *
   * `projectId` names the project the method was learnt in, and is recorded as
   * `provenance.sourceProjectId`. The record itself is the account's: a method
   * follows the researcher, and one filed under its project was deleted with it
   * (audit 2026-09-26, L-G1).
   * @param {string} userId
   * @param {{projectId?: string|null, frontmatter: any, body: string, files?: any, provenance: any, dependencies?: any[], mountedTools?: readonly string[], display?: unknown, steps?: unknown, scope?: unknown}} input
   */
  async createCandidate(userId, input) {
    const digest = this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
    const name = String(input.frontmatter?.name ?? "");
    const id = learnedMethodId(name);
    const sourceProjectId = sourceProjectOf(input.provenance, input.projectId);
    const provenance = withResultLinks({ origin: "inferred", ...input.provenance, ...(sourceProjectId ? { sourceProjectId } : {}) });
    const createdAt = this.now().toISOString();
    const steps = cleanMethodSteps(input.steps);
    const scope = cleanMethodScope(input.scope);
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
      // And the steps in their language, bound to the body they render.
      ...(steps ? { displaySteps: { text: steps, contentDigest: digest } } : {}),
      // The situation it is for and the ones it must not be loaded into, as the distillation declared them; outside the
      // digest, like everything else on the record that is not SKILL.md.
      ...(scope ? { scope: { ...scope, digest } } : {}),
      bodyVersion: 1,
      bodyUpdatedAt: createdAt,
      createdAt,
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
      payload.statusReason = effectiveStatusReason(payload);
      // The same field `#setStatus` stamps, so "when did this become effective"
      // has one answer however it became effective.
      payload.statusChangedAt = payload.createdAt;
    }
    await this.documents.put(userId, "method", productId(id, "method"), payload, {
      expectedRevision: 0,
      projectId: null,
    });
    return this.getMethod(userId, id);
  }

  /**
   * Recheck a handbook with the same body, dependency and provenance rules as a method.
   * @param {string} userId
   * @param {{frontmatter: any, body: string, files?: any, provenance: any, dependencies?: any[], display?: unknown, steps?: unknown, capabilityId?: string | null}} input
   */
  async validateHandbook(userId, input) {
    return this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
  }

  /** Queue exactly one application per owner, capability and reviewed content.
   * @param {string} userId @param {any} candidate @param {{retryOf?:string,transactionClient?:any}} [options] */
  async enqueueHandbook(userId, candidate, { retryOf, transactionClient = null } = {}) {
    if (!this.jobs || candidate?.payload?.recordType !== HANDBOOK_CANDIDATE_RECORD_TYPE) return null;
    const { capabilityId, contentDigest, provenance } = candidate.payload;
    return this.jobs.enqueue(userId, "consolidate", {
      ...(retryOf ? { retryOf } : {}),
      action: "optimize", candidateId: candidate.id, candidateDigest: contentDigest,
      candidateRevision: candidate.payload.candidateRevision ?? candidate.revision, capabilityId,
      sourceRunId: provenance?.runId ?? null, sourceProjectId: provenance?.sourceProjectId ?? null,
    }, { idempotencyKey: `handbook:${sha256(JSON.stringify([userId, candidate.id, capabilityId, contentDigest, retryOf ?? null]))}`, projectId: null, transactionClient });
  }

  /** One record per capability and name, separate from personal methods. Prior digest outcomes are preserved.
   * @param {string} userId @param {any} input */
  async recordHandbookCandidate(userId, input) {
    const digest = this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
    const name = String(input.frontmatter?.name ?? "");
    const id = handbookCandidateId(name, input.capabilityId ?? "");
    const current = await this.documents.get(userId, "method", productId(id, "method"));
    if (current?.payload?.contentDigest === digest) {
      await this.enqueueHandbook(userId, current);
      return current;
    }
    const steps = cleanMethodSteps(input.steps);
    const payload = {
      recordType: HANDBOOK_CANDIDATE_RECORD_TYPE,
      candidateRevision: (current?.revision ?? 0) + 1,
      dispositions: { ...(current?.payload?.dispositions ?? {}), [digest]: { state: "queued", at: this.now().toISOString() } },
      // Applied supplements have a separate record type and revision history.
      status: "candidate",
      frontmatter: input.frontmatter,
      body: input.body,
      ...(input.files ? { files: input.files } : {}),
      dependencies: input.dependencies ?? [],
      contentDigest: digest,
      capabilityId: typeof input.capabilityId === "string" && input.capabilityId ? input.capabilityId : null,
      provenance: { origin: "inferred", ...input.provenance, derivedFrom: "reviewer" },
      ...(cleanMethodDisplay(input.display) ? { display: cleanMethodDisplay(input.display) } : {}),
      ...(steps ? { displaySteps: { text: steps, contentDigest: digest } } : {}),
      createdAt: current?.payload?.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    await this.documents.put(userId, "method", id, payload, { expectedRevision: current?.revision ?? 0, projectId: null });
    const candidate = await this.documents.get(userId, "method", id);
    await this.enqueueHandbook(userId, candidate);
    return candidate;
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
   * @param {{expectedRevision: number, frontmatter: any, body: string, files?: any, provenance?: any, dependencies?: any[], mountedTools?: readonly string[], display?: unknown, steps?: unknown, scope?: unknown}} input
   */
  async amendMethod(userId, methodId, input) {
    const current = await this.getMethod(userId, methodId);
    const digest = this.#validated({ ...input, resolveDigest: await this.#digestResolver(userId) });
    const learning = resetLearningForDigest(current.payload.learning, digest);
    const bodyChanged = digest !== current.payload.contentDigest;
    const at = this.now().toISOString();
    const steps = cleanMethodSteps(input.steps);
    const scope = cleanMethodScope(input.scope);
    // Where the method was first learnt stays its source; a later lesson from
    // another project does not move it.
    const sourceProjectId = sourceProjectOf(current.payload.provenance, null) ?? sourceProjectOf(input.provenance, null);
    const payload = {
      ...current.payload,
      status: bodyChanged ? "candidate" : current.payload.status,
      frontmatter: input.frontmatter,
      body: input.body,
      ...(input.files ? { files: input.files } : { files: undefined }),
      dependencies: input.dependencies ?? current.payload.dependencies ?? [],
      contentDigest: digest,
      learning,
      // The result versions each lesson was learnt from accumulate: the method names every pair it was shaped by.
      provenance: withResultLinks({ ...current.payload.provenance, ...input.provenance, ...(sourceProjectId ? { sourceProjectId } : {}) }, current.payload.provenance?.results),
      // A new line when the revision brought one; otherwise the old one stands.
      ...(cleanMethodDisplay(input.display) ? { display: cleanMethodDisplay(input.display) } : {}),
      // New steps when the revision brought them; otherwise the old rendering
      // stays and, naming the old digest, is no longer shown (`methodView`)
      // until the next consolidation pass renders the new body.
      ...(steps ? { displaySteps: { text: steps, contentDigest: digest } } : {}),
      // A new scope when the revision declared one; otherwise the old one stands and `methodScopeOf` says it is no
      // longer current.
      ...(scope ? { scope: { ...scope, digest } } : {}),
      bodyVersion: bodyChanged ? bodyVersionOf(current.payload) + 1 : bodyVersionOf(current.payload),
      bodyUpdatedAt: bodyChanged ? at : current.payload.bodyUpdatedAt ?? current.createdAt ?? at,
      updatedAt: at,
    };
    if (payload.files === undefined) delete payload.files;
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision: input.expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * Give a method the line its researcher reads — a title and a sentence, the
   * steps in their language, or both — and nothing else: not a revision of the
   * method (the digest, status and counters are untouched, and no history row
   * is written, `ProductDocuments.put` `telemetry`).
   *
   * A title and sentence the method already has stay: they are what the
   * researcher has been reading it as, and a pass that only came to render the
   * steps does not rename it.
   * @param {string} userId @param {string} methodId @param {unknown} display
   */
  async setDisplay(userId, methodId, display) {
    const cleaned = cleanMethodDisplay(display);
    const steps = cleanMethodSteps(/** @type {any} */ (display)?.steps);
    if (!cleaned && !steps) throw new HttpError(422, "method_display_invalid", "A method's display needs a title and a summary, or its steps, within their limits.");
    const document = await this.getMethod(userId, methodId);
    const line = cleanMethodDisplay(document.payload.display) ?? cleaned;
    await this.documents.put(userId, "method", document.id, {
      ...document.payload,
      ...(line ? { display: line } : {}),
      ...(steps ? { displaySteps: { text: steps, contentDigest: document.payload.contentDigest } } : {}),
    }, {
      expectedRevision: document.revision,
      telemetry: true,
    });
    return this.getMethod(userId, methodId);
  }

  /** @param {string} userId @param {string} methodId */
  async getMethod(userId, methodId) {
    const document = await this.documents.get(userId, "method", productId(methodId, "method"));
    if (!isLearnedMethod(document)) throw new HttpError(404, "method_not_found", "The method is unavailable.");
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
   * The researcher's library, one page of it.
   *
   * `projectId` narrows it to the methods learnt in that project
   * (`provenance.sourceProjectId`), never to a storage column: every method is
   * the account's (`createCandidate`), and a filter on where it is filed would
   * find nothing.
   * @param {string} userId
   * @param {{projectId?: string|null, status?: string, limit?: number, cursor?: string|null}} [options]
   */
  async listMethods(userId, options = {}) {
    const filter = {
      recordType: LEARNED_METHOD_RECORD_TYPE,
      ...(options.status ? { status: options.status } : {}),
      ...(typeof options.projectId === "string" && options.projectId ? { provenance: { sourceProjectId: options.projectId } } : {}),
    };
    return this.documents.list(userId, "method", {
      limit: options.limit ?? 50,
      cursor: options.cursor ?? null,
      filter,
    });
  }

  /**
   * The methods a run may mount: effective, and nothing else — the whole
   * library, whichever project each was learnt in.
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
    // The reader's sentence, from the record: a promotion used to keep
    // whatever reason an earlier path had written, English included.
    return this.#setStatus(userId, methodId, "approved", input.expectedRevision, document,
      effectiveStatusReason({ ...document.payload, status: "approved" }));
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
   * `link`, when the stop answers a regression of the results produced under the body the method held
   * (`applyRegression`), is kept on the record: what was left, and which entries showed it.
   * @param {string} userId @param {string} methodId @param {{expectedRevision: number, reason?: string, link?: unknown}} input
   */
  async retire(userId, methodId, input) {
    const document = await this.getMethod(userId, methodId);
    return this.#setStatus(userId, methodId, "retired", input.expectedRevision, document, input.reason, input.link);
  }

  /**
   * @param {string} userId @param {string} methodId @param {string} status
   * @param {number} expectedRevision @param {any} document @param {string} [reason] @param {unknown} [link]
   */
  async #setStatus(userId, methodId, status, expectedRevision, document, reason, link) {
    if (!METHOD_STATUSES.includes(status)) throw new HttpError(400, "method_status_invalid", "Unknown method status.");
    const payload = {
      ...document.payload,
      status,
      ...(reason ? { statusReason: String(reason).slice(0, 500) } : {}),
      ...(link ? { links: appendMethodLink(document.payload.links, link) } : {}),
      statusChangedAt: this.now().toISOString(),
    };
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * Every saved revision of a method, newest first, paged to the end.
   * @param {string} userId @param {string} methodId @returns {Promise<any[]>}
   */
  async #savedRevisions(userId, methodId) {
    /** @type {any[]} */
    const saved = [];
    /** @type {number | null} */
    let before = null;
    // Twenty pages of a hundred: a method that has been rewritten two
    // thousand times is a defect this read does not need to survive, and a
    // bound is what keeps it from reading one forever.
    for (let page = 0; page < 20; page += 1) {
      const result = await this.documents.history(userId, "method", methodId, { limit: 100, ...(before ? { beforeRevision: before } : {}) });
      const items = Array.isArray(result) ? result : result?.items ?? [];
      saved.push(...items);
      if (items.length < 100) break;
      before = items.at(-1).revision;
    }
    return saved.sort((left, right) => right.revision - left.revision);
  }

  /**
   * Restore an earlier version by saving it forward.
   *
   * Never by deleting: the history of a method includes the versions that were
   * withdrawn, and a rollback that erased its own cause would remove the
   * evidence for the next decision about the same method.
   *
   * What 「回到上一版」 means is decided here, from the record, because the
   * number a caller sends is a guess (the page sends `revision - 1`):
   *
   *  - A revision number a counter write took names the state saved at or
   *    before it. Counter writes save no history (`#saveLearning`), and older
   *    ones that did differ from their predecessor in counters only.
   *  - For a stopped method it is the undo of the stop: the latest saved state
   *    that was not retired, body included.
   *  - For a method in use it is the previous *body*. The target is walked back
   *    past every saved revision holding the text the method holds now — a
   *    method with 77 revisions and two bodies restored its previous counter,
   *    which changed nothing (audit 2026-09-26, L-G4). With no earlier body
   *    there is nothing to go back to, and the answer says so.
   *
   * The counters come with the body they describe: kept for the same text,
   * reset for another (`resetLearningForDigest`), as an amendment resets them.
   * The status is the promotion rule's for the restored record, never the one
   * the old revision carried.
   *
   * `targetDigest` names the body to return to instead of a revision number: the newest saved revision holding exactly
   * that text. The lifecycle uses it when the results produced under the current body showed a regression and the
   * earlier body that is not itself harmful is known by its digest (`scientificRegression`); `link` then records what
   * was left and which entries showed it.
   * @param {string} userId @param {string} methodId @param {{expectedRevision: number, targetRevision?: number, targetDigest?: string, link?: unknown}} input
   */
  async rollback(userId, methodId, input) {
    const current = await this.getMethod(userId, methodId);
    const saved = await this.#savedRevisions(userId, methodId);
    const digestOf = (/** @type {any} */ entry) => String(entry?.payload?.contentDigest ?? "");
    let index;
    if (typeof input.targetDigest === "string" && input.targetDigest) {
      index = saved.findIndex((entry) => digestOf(entry) === input.targetDigest && !entry.deletedAt);
      if (index < 0 || input.targetDigest === current.payload.contentDigest) {
        throw new HttpError(404, "method_revision_unavailable", "That method revision is unavailable.");
      }
    } else {
      const requested = Number(input.targetRevision);
      index = saved.findIndex((entry) => entry.revision <= requested);
      // A number past the record's own is not a revision anybody saw.
      if (!Number.isSafeInteger(requested) || requested > current.revision || index < 0) {
        throw new HttpError(404, "method_revision_unavailable", "That method revision is unavailable.");
      }
      if (current.payload.status === "retired") {
        while (index < saved.length && (saved[index].payload?.status === "retired" || saved[index].deletedAt)) index += 1;
      } else {
        while (index < saved.length && (digestOf(saved[index]) === current.payload.contentDigest || saved[index].deletedAt)) index += 1;
      }
    }
    const target = saved[index];
    if (!target) throw new HttpError(409, "method_no_earlier_version", "This method has no earlier version to go back to.");

    const sameBody = digestOf(target) === current.payload.contentDigest;
    const at = this.now().toISOString();
    const sourceProjectId = sourceProjectOf(current.payload.provenance, null);
    /** @type {any} */
    const payload = {
      ...current.payload,
      frontmatter: target.payload.frontmatter,
      body: target.payload.body,
      ...(target.payload.files ? { files: target.payload.files } : { files: undefined }),
      dependencies: target.payload.dependencies ?? [],
      contentDigest: digestOf(target),
      learning: sameBody ? current.payload.learning : resetLearningForDigest(current.payload.learning, digestOf(target)),
      provenance: { ...target.payload.provenance, ...(sourceProjectId ? { sourceProjectId } : {}) },
      ...(sameBody ? {} : {
        ...(cleanMethodDisplay(target.payload.display) ? { display: cleanMethodDisplay(target.payload.display) } : {}),
        ...(target.payload.displaySteps ? { displaySteps: target.payload.displaySteps } : {}),
        // The scope of the body it is returned to, not the one it leaves (a body with none declares none).
        scope: target.payload.scope,
      }),
      ...(input.link ? { links: appendMethodLink(current.payload.links, input.link) } : {}),
      bodyVersion: sameBody ? bodyVersionOf(current.payload) : bodyVersionOf(current.payload) + 1,
      bodyUpdatedAt: sameBody ? current.payload.bodyUpdatedAt ?? current.createdAt ?? at : at,
      restoredFromRevision: target.revision,
      updatedAt: at,
    };
    if (payload.files === undefined) delete payload.files;
    if (payload.scope === undefined) delete payload.scope;
    const verdict = promotionVerdict(methodRecordFrom({ id: methodId, payload: { ...payload, status: "candidate" } }));
    payload.status = verdict.status;
    payload.statusReason = effectiveStatusReason(payload);
    payload.statusChangedAt = at;
    await this.documents.put(userId, "method", methodId, payload, { expectedRevision: input.expectedRevision });
    return this.getMethod(userId, methodId);
  }

  /**
   * A method's versions as a person reads them: one entry per body it has
   * held, newest first — never a counter write, never a status flip of the
   * same text. The first saved revision of each body is its entry.
   * @param {string} userId @param {string} methodId
   * @returns {Promise<{version: number, revision: number, contentDigest: string, at: string | null, title: string | null, current: boolean}[]>}
   */
  async history(userId, methodId) {
    const current = await this.getMethod(userId, methodId);
    const saved = (await this.#savedRevisions(userId, methodId)).sort((left, right) => left.revision - right.revision);
    /** @type {{version: number, revision: number, contentDigest: string, at: string | null, title: string | null, current: boolean}[]} */
    const versions = [];
    let previous = "";
    for (const entry of saved) {
      const digest = String(entry.payload?.contentDigest ?? "");
      if (!digest || digest === previous) continue;
      previous = digest;
      versions.push({
        version: versions.length + 1,
        revision: entry.revision,
        contentDigest: digest,
        at: entry.recordedAt ?? entry.payload?.bodyUpdatedAt ?? entry.payload?.updatedAt ?? entry.payload?.createdAt ?? null,
        title: cleanMethodDisplay(entry.payload?.display)?.title ?? null,
        current: false,
      });
    }
    const last = versions.at(-1);
    if (last && last.contentDigest === current.payload.contentDigest) last.current = true;
    return versions.reverse();
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

  /**
   * Add one entry to a method's scientific record: what became of a result produced while a revision of it was read
   * (`methodFeedback.mjs` in the domain). Telemetry like the counters — no history row, and the revision still moves, so
   * a writer holding the older record conflicts rather than overwriting an entry — and idempotent by the entry's own
   * identity, so a join that replays writes nothing twice.
   *
   * The entry stays under the digest it names, never the one the method holds now: a body amended since the run read it
   * keeps what happened under it, which is what lets a regression be pinned to one revision.
   * @param {string} userId @param {string} methodId @param {unknown} entry
   * @returns {Promise<{ document: any, added: boolean }>}
   */
  async recordScientific(userId, methodId, entry) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = await this.getMethod(userId, methodId);
      const scientific = foldMethodFeedback(document.payload.scientific, entry);
      if (scientific === document.payload.scientific) return { document, added: false };
      try {
        await this.documents.put(userId, "method", methodId, { ...document.payload, scientific }, { expectedRevision: document.revision, telemetry: true });
        return { document: await this.getMethod(userId, methodId), added: true };
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === 7) throw error;
      }
    }
    throw new HttpError(409, "product_revision_conflict", "Concurrent method feedback did not settle.");
  }

  /**
   * Label a method with a change of a source it rests on (N15): the source, the state it was found in and the result
   * version the method is linked to. Telemetry like the scientific record — no history row, the revision moves so a
   * concurrent writer conflicts instead of overwriting — and idempotent by the entry's identity. It is a label read
   * beside the method: no body, status or counter moves, and the lifecycle never reads it, because a notice that a
   * source changed is not evidence that the method was wrong.
   * @param {string} userId @param {string} methodId @param {unknown} entry
   * @returns {Promise<{ document: any, added: boolean }>}
   */
  async recordSourceChange(userId, methodId, entry) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const document = await this.getMethod(userId, methodId);
      const before = Array.isArray(document.payload.sourceChanges) ? document.payload.sourceChanges : [];
      const sourceChanges = foldSourceChange(before, entry);
      if (sourceChanges === before) return { document, added: false };
      try {
        await this.documents.put(userId, "method", methodId, { ...document.payload, sourceChanges }, { expectedRevision: document.revision, telemetry: true });
        return { document: await this.getMethod(userId, methodId), added: true };
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === 7) throw error;
      }
    }
    throw new HttpError(409, "product_revision_conflict", "Concurrent method labels did not settle.");
  }

  /**
   * Which revision of a method a mounted file was: the digest a run's ledger records is the file's (`mountedMethodDigest`),
   * and every record about the method is keyed by its content digest, so a feedback joined to a run needs this to say
   * which body it is about. The current body first, then every saved one. Null when no body the method ever held was that
   * file — a feedback with no revision to name is not recorded under a guess.
   * @param {string} userId @param {string} methodId @param {string} mountedDigest
   * @returns {Promise<{ contentDigest: string, revision: number, current: boolean } | null>}
   */
  async revisionByMountedDigest(userId, methodId, mountedDigest) {
    const current = await this.getMethod(userId, methodId);
    if (mountedMethodDigest(current.payload, sha256) === mountedDigest) {
      return { contentDigest: String(current.payload.contentDigest), revision: current.revision, current: true };
    }
    for (const saved of await this.#savedRevisions(userId, methodId)) {
      if (!saved.payload?.frontmatter || saved.deletedAt) continue;
      if (mountedMethodDigest(saved.payload, sha256) === mountedDigest) {
        return { contentDigest: String(saved.payload.contentDigest), revision: saved.revision, current: false };
      }
    }
    return null;
  }

  /**
   * The methods that name one result version by a recorded link: learnt from it (its provenance names the original a
   * researcher corrected and the successor the platform generated) or used for it (its scientific record holds an entry
   * about it). By the immutable version identity and nothing else, never by a similarity of names — the lookup a change
   * of one of the sources that result rests on is followed through (N15).
   * @param {string} userId @param {string} versionId
   * @returns {Promise<any[]>}
   */
  async methodsLinkedTo(userId, versionId) {
    const found = new Map();
    for (const filter of [
      { recordType: LEARNED_METHOD_RECORD_TYPE, provenance: { results: [{ versionId }] } },
      { recordType: LEARNED_METHOD_RECORD_TYPE, scientific: { entries: [{ result: { versionId } }] } },
    ]) {
      const page = await this.documents.list(userId, "method", { limit: 100, filter });
      for (const document of page.items ?? []) found.set(document.id, document);
    }
    return [...found.values()];
  }

  /**
   * Act on a regression proposal (`retirementProposal`, code `scientific_regression`): return the method to the exact
   * earlier body it names, or stop it when there is none, and keep the link that says why. Both are what a researcher
   * can undo by restoring a revision. The sentence is the reader's, passed in because it lives with the other
   * retirement sentences (`methodConsolidation.mjs`).
   * @param {string} userId @param {any} document the method as read just now
   * @param {{ action?: string, rollbackToDigest?: string | null, evidence?: string[], runs?: number, rejected?: number }} proposal
   * @param {{ retire: string }} sentences
   * @returns {Promise<{ action: "rollback" | "retire", document: any }>}
   */
  async applyRegression(userId, document, proposal, sentences) {
    const link = {
      type: proposal.action === "rollback" && proposal.rollbackToDigest ? "rolled_back_for_regression" : "retired_for_regression",
      at: this.now().toISOString(), fromDigest: document.payload.contentDigest, toDigest: proposal.rollbackToDigest ?? null,
      results: proposal.runs ?? 0, against: proposal.rejected ?? 0, evidence: proposal.evidence ?? [],
    };
    if (proposal.action === "rollback" && proposal.rollbackToDigest) {
      return { action: "rollback", document: await this.rollback(userId, document.id, { expectedRevision: document.revision, targetDigest: proposal.rollbackToDigest, link }) };
    }
    return { action: "retire", document: await this.retire(userId, document.id, { expectedRevision: document.revision, reason: sentences.retire, link }) };
  }

  /**
   * Write the counters, which are telemetry about the method and not a change
   * of it: no history row, no new `updated_at` (`ProductDocuments.put`). The
   * revision still moves, so a writer holding the older record conflicts
   * rather than overwriting a count.
   * @param {string} userId @param {string} methodId @param {any} document @param {any} learning */
  async #saveLearning(userId, methodId, document, learning) {
    await this.documents.put(userId, "method", methodId, { ...document.payload, learning }, {
      expectedRevision: document.revision,
      telemetry: true,
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
    // A method with something on its scientific record is read with every body it has held, newest first, because the
    // answer to a regression is the exact earlier body to return to; the others need no history read.
    const records = new Map();
    for (const document of items) {
      const revisions = document.payload.status === "approved" && document.payload.scientific?.entries?.length
        ? (await this.history(userId, document.id).catch(() => [])).map((version) => version.contentDigest) : undefined;
      records.set(document.id, methodRecordFrom(document, { revisions }));
    }
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
