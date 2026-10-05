/** Consume reviewed lessons as owner-scoped supplements, without claiming a measured benefit. */
import { createHash } from "node:crypto";
import { usagePurposeOfRun } from "@evimed/domain";
import { HANDBOOK_CANDIDATE_RECORD_TYPE } from "./learningService.mjs";
import { HttpError } from "./security.mjs";

export const CAPABILITY_HANDBOOK_RECORD_TYPE = "capability-handbook";
export const HANDBOOK_DISPOSITIONS = Object.freeze(["queued", "evaluating", "applied", "rejected", "failed", "stale"]);
const terminal = new Set(["applied", "rejected", "failed"]);
/** @param {any} value */
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
/** @param {string} capabilityId @param {string} name */
export const capabilityHandbookId = (capabilityId, name) => `method:capability-handbook:${capabilityId}:${name}`;
/** Bind every evaluation to the same shipped capability and exact owner-specific change. @param {any} registry @param {string} id */
export const shippedCapabilityDigest = (registry, id) => {
  const entry = registry.getPackage(id);
  return entry ? digest({ manifest: entry.manifest, skillText: entry.skillText }) : null;
};

export class HandbookConsolidation {
  /** @param {{learning:any, jobs:any, registry:any, resolveSourceRun:(userId:string,projectId:string,runId:string)=>Promise<any>,
   * enabled?:(userId:string,projectId:string|null)=>boolean|Promise<boolean>, evaluate?:((request:any)=>Promise<any>)|null, now?:()=>Date}} input */
  constructor({ learning, jobs, registry, resolveSourceRun, enabled = () => true, evaluate = null, now = () => new Date() }) {
    this.learning = learning;
    this.documents = learning.documents;
    this.jobs = jobs;
    this.registry = registry;
    this.resolveSourceRun = resolveSourceRun;
    this.enabled = enabled;
    this.evaluate = evaluate;
    this.now = now;
    this.cursors = new Map();
  }

  /** @param {any} job @param {any} candidate @param {any} result @param {any} [applied] */
  async complete(job, candidate, result, applied = null) {
    const current = await this.documents.get(job.userId, "method", candidate.id);
    if (!current) throw new HttpError(404, "handbook_candidate_unavailable", "The handbook candidate is unavailable.");
    if (!await this.enabled(job.userId, current.payload.provenance?.sourceProjectId ?? null)) {
      throw new HttpError(409, "learning_paused", "Learning is paused.");
    }
    if (applied && (current.payload.contentDigest !== job.payload.candidateDigest
      || current.payload.candidateRevision !== candidate.payload.candidateRevision)) {
      return this.complete(job, current, { ...result, disposition: "stale", reason: "handbook_candidate_changed", handbookId: undefined }, null);
    }
    const disposition = { ...result, jobId: job.id, at: this.now().toISOString(), candidateDigest: job.payload.candidateDigest };
    const dispositions = { ...current.payload.dispositions, [job.payload.candidateDigest]: disposition };
    // Older disposition history remains in ProductDocuments.revisions.
    const retained = Object.fromEntries(Object.entries(dispositions).slice(-40));
    const completed = await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, result, async (client) => {
      // This CAS and the supplement write commit with the job under its lease;
      // a changed candidate/baseline, lost lease or failed write rolls all back.
      await this.documents.put(job.userId, "method", current.id, { ...current.payload, dispositions: retained }, {
        expectedRevision: current.revision, transactionClient: client,
      });
      if (applied) await this.documents.put(job.userId, "method", applied.id, applied.payload, {
        expectedRevision: applied.expectedRevision, transactionClient: client,
      });
      if (result.disposition === "stale" && !job.payload.retryOf && current.payload.contentDigest === job.payload.candidateDigest) {
        await this.learning.enqueueHandbook(job.userId, current, { retryOf: job.id, transactionClient: client });
      }
    });
    if (!completed) throw new HttpError(409, "product_job_lease_lost", "The handbook job lost its lease.");
    return { ...result, jobCompleted: true };
  }

  /** @param {{job:any}} request */
  async run({ job }) {
    const candidate = await this.documents.get(job.userId, "method", String(job.payload?.candidateId ?? ""));
    if (candidate?.payload?.recordType !== HANDBOOK_CANDIDATE_RECORD_TYPE) {
      throw new HttpError(404, "handbook_candidate_unavailable", "The handbook candidate is unavailable.");
    }
    const payload = candidate.payload;
    if (!await this.enabled(job.userId, payload.provenance?.sourceProjectId ?? null)) throw new HttpError(409, "learning_paused", "Learning is paused.");
    const previous = payload.dispositions?.[job.payload.candidateDigest];
    if (terminal.has(previous?.disposition)) return { ...previous, jobCompleted: false };
    const base = { action: "optimize", candidateId: candidate.id, candidateDigest: job.payload.candidateDigest,
      capabilityId: payload.capabilityId, verification: "unmeasured" };
    if (payload.contentDigest !== job.payload.candidateDigest) {
      return this.complete(job, candidate, { ...base, disposition: "stale", reason: "handbook_candidate_changed" });
    }
    const fail = (reason) => this.complete(job, candidate, { ...base, disposition: "failed", reason });
    const source = await this.resolveSourceRun(job.userId, payload.provenance?.sourceProjectId, payload.provenance?.runId);
    if (!source || source.id !== payload.provenance?.runId || source.learningEvaluation
      || usagePurposeOfRun(source) !== "kernel") return fail("handbook_source_unavailable");
    const capability = this.registry.get(source.effectiveAgentId);
    if (!capability || capability.visibility === "internal") return fail("handbook_capability_unavailable");
    if ((payload.capabilityId && payload.capabilityId !== capability.id)
      || (job.payload.capabilityId && job.payload.capabilityId !== capability.id)) return fail("handbook_source_capability_mismatch");
    base.capabilityId = capability.id;
    if (payload.provenance?.derivedFrom !== "reviewer") return fail("handbook_source_review_unavailable");
    try {
      if (await this.learning.validateHandbook(job.userId, payload) !== payload.contentDigest) return fail("handbook_digest_invalid");
    } catch (error) {
      if (error?.code === "method_invalid") return fail("handbook_method_invalid");
      throw error;
    }
    const id = capabilityHandbookId(capability.id, payload.frontmatter.name);
    const baseline = await this.documents.get(job.userId, "method", id);
    const binding = { userId: job.userId, capabilityId: capability.id, candidateDigest: payload.contentDigest,
      baselineDigest: baseline?.payload?.contentDigest ?? null, baselineRevision: baseline?.revision ?? 0,
      shippedCapabilityDigest: shippedCapabilityDigest(this.registry, capability.id) };
    if (!binding.shippedCapabilityDigest) return fail("handbook_capability_unavailable");
    let evaluation = null;
    if (this.evaluate) {
      const marked = await this.jobs.withLease(job.userId, job.id, job.leaseToken, (client) => this.documents.put(job.userId, "method", candidate.id,
        { ...payload, dispositions: { ...payload.dispositions, [payload.contentDigest]: {
          disposition: "evaluating", candidateDigest: payload.contentDigest, jobId: job.id, binding, at: this.now().toISOString(),
        } } }, { expectedRevision: candidate.revision, transactionClient: client }));
      if (!marked) throw new HttpError(409, "product_job_lease_lost", "The handbook job lost its lease.");
      evaluation = await this.evaluate({ job, binding, candidate: structuredClone(candidate), baseline: structuredClone(baseline) });
      if (!evaluation || !["better", "non_inferior", "worse", "inconclusive"].includes(evaluation.verdict)
        || typeof evaluation.report !== "string" || !evaluation.report || evaluation.bootstrap === true
        || Object.entries(binding).some(([key, value]) => evaluation[key] !== value)) return fail("handbook_evaluation_binding_invalid");
      if (["worse", "inconclusive"].includes(evaluation.verdict)) {
        return this.complete(job, candidate, { ...base, disposition: "rejected", reason: "handbook_evaluation_rejected", evaluation });
      }
    }
    const currentBaseline = await this.documents.get(job.userId, "method", id);
    if ((currentBaseline?.revision ?? 0) !== binding.baselineRevision
      || shippedCapabilityDigest(this.registry, capability.id) !== binding.shippedCapabilityDigest) {
      return this.complete(job, candidate, { ...base, disposition: "stale", reason: "handbook_baseline_changed", binding });
    }
    const at = this.now().toISOString();
    const verification = evaluation ? "evaluated" : "unmeasured";
    const result = { ...base, disposition: "applied", reason: "source_review_and_validation", handbookId: id,
      handbookRevision: binding.baselineRevision + 1, verification, binding, ...(evaluation ? { evaluation } : {}) };
    try {
      return await this.complete(job, candidate, result, { id, expectedRevision: binding.baselineRevision, payload: {
        recordType: CAPABILITY_HANDBOOK_RECORD_TYPE, capabilityId: capability.id, status: "active",
        frontmatter: payload.frontmatter, body: payload.body, ...(payload.files ? { files: payload.files } : {}),
        dependencies: payload.dependencies, contentDigest: payload.contentDigest, display: payload.display,
        version: (baseline?.payload?.version ?? 0) + 1, verification, binding, ...(evaluation ? { evaluation } : {}),
        source: { candidateId: candidate.id, candidateDigest: payload.contentDigest, runId: source.id, projectId: payload.provenance.sourceProjectId, sessionId: source.sessionId ?? null },
        previousRevision: baseline?.revision ?? null, observations: [], createdAt: baseline?.payload?.createdAt ?? at, appliedAt: at,
      } });
    } catch (error) {
      if (error?.code !== "product_revision_conflict") throw error;
      return this.complete(job, candidate, { ...base, disposition: "stale", reason: "handbook_revision_changed", binding });
    }
  }

  /** Restore a saved body forward by CAS. Observations belong to a version and never cross the restore.
   * @param {string} userId @param {string} id @param {{expectedRevision:number,targetRevision:number}} input */
  async rollback(userId, id, { expectedRevision, targetRevision }) {
    const current = await this.documents.get(userId, "method", id);
    if (current?.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE) throw new HttpError(404, "handbook_unavailable", "The handbook is unavailable.");
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 1 || targetRevision >= current.revision) {
      throw new HttpError(404, "handbook_revision_unavailable", "That handbook revision is unavailable.");
    }
    const history = await this.documents.history(userId, "method", id, { beforeRevision: targetRevision + 1, limit: 1 });
    const saved = history[0];
    if (!saved || saved.deletedAt || saved.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE
      || saved.payload.capabilityId !== current.payload.capabilityId) throw new HttpError(404, "handbook_revision_unavailable", "That handbook revision is unavailable.");
    await this.learning.validateHandbook(userId, saved.payload);
    return this.documents.put(userId, "method", id, { ...saved.payload, version: current.payload.version + 1,
      verification: "unmeasured", evaluation: null, observations: [], previousRevision: current.revision,
      restoredFromRevision: saved.revision, appliedAt: this.now().toISOString(),
    }, { expectedRevision });
  }

  /** Reuse the maintenance timer. One bounded page per owner per call, resuming after restart from the beginning.
   * @param {string} userId @param {{limit?:number,cursor?:string|null}} [options] */
  async reconcile(userId, { limit = 25, cursor = this.cursors.get(userId) ?? null } = {}) {
    if (!await this.enabled(userId, null)) return { queued: 0, nextCursor: cursor };
    const page = await this.documents.list(userId, "method", { filter: { recordType: HANDBOOK_CANDIDATE_RECORD_TYPE }, limit, cursor });
    let queued = 0;
    for (let candidate of page.items) {
      if (!await this.enabled(userId, candidate.payload.provenance?.sourceProjectId ?? null)) continue;
      const outcome = candidate.payload.dispositions?.[candidate.payload.contentDigest];
      if (terminal.has(outcome?.disposition)) continue;
      if (!candidate.payload.candidateRevision) {
        candidate = await this.documents.put(userId, "method", candidate.id, { ...candidate.payload,
          candidateRevision: candidate.revision + 1,
        }, { expectedRevision: candidate.revision });
      }
      const job = await this.learning.enqueueHandbook(userId, candidate);
      if (job?.status === "failed") {
        await this.documents.put(userId, "method", candidate.id, { ...candidate.payload, dispositions: {
          ...candidate.payload.dispositions, [candidate.payload.contentDigest]: { disposition: "failed", reason: job.error?.code ?? "handbook_job_failed", jobId: job.id, at: this.now().toISOString() },
        } }, { expectedRevision: candidate.revision });
      } else if (job) queued += 1;
    }
    this.cursors.set(userId, page.nextCursor);
    return { queued, nextCursor: page.nextCursor };
  }
}
