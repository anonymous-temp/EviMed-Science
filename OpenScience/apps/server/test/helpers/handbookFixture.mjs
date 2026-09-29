import { METHOD_SKILL_SCHEMA } from "@evimed/domain";
import { LearningService } from "../../src/learningService.mjs";
import { productDocumentsDouble } from "./productDocumentsDouble.mjs";

export const BODY = ["## Purpose", "Keep denominators tied to the preserved source.", "## When to Use", "When summarizing study results.", "## Inputs", "The preserved study and its population.", "## Workflow", "1. Check each denominator against the source.", "## Verification", "- Every number names its population.", "## Constraints", "- Never infer absent counts.", "## Output", "A source-linked account of the results."].join("\n");
export const frontmatter = { name: "denominator-check", description: "Check study denominators when summarizing preserved research results.", whenToUse: "When summarizing results.", metadata: { role: "functional", applies_when: "Summarizing study results.", not_when: "No numerical results.", derived_from: "run:source-run", evimed_schema: METHOD_SKILL_SCHEMA } };
export const registry = { get: (id) => ["geo-content", "meta-analysis"].includes(id) ? { id, visibility: "public" } : null,
  getPackage: (id) => registry.get(id) ? { manifest: registry.get(id), skillText: "Canonical shipped skill." } : null };
export function fixture() {
  const documents = productDocumentsDouble();
  const queued = [];
  const jobs = { async enqueue(userId, kind, payload, options) {
    const existing = queued.find((job) => job.userId === userId && job.idempotencyKey === options.idempotencyKey);
    if (existing) return existing;
    const job = { id: `job-${queued.length + 1}`, userId, kind, payload, ...options, leaseToken: "lease", attempts: 1, maxAttempts: 3 };
    queued.push(job); return job;
  }, async withLease(_userId, _id, token, operation) {
    if (token !== "lease") return null;
    return operation(null);
  }, async finishWithLease(_userId, _id, token, result, operation) {
    if (token !== "lease") throw Object.assign(new Error("Lease lost"), { code: "product_job_lease_lost" });
    await operation(null); return { result };
  } };
  const learning = new LearningService({ documents, jobs });
  const input = (overrides = {}) => ({ frontmatter, body: BODY, capabilityId: "geo-content", provenance: { runId: "source-run", sourceProjectId: "source-project", derivedFrom: "reviewer" }, ...overrides });
  const resolveSourceRun = async (userId, projectId, runId) => userId === "alice" && projectId === "source-project" && runId === "source-run"
    ? { id: runId, effectiveAgentId: "geo-content", status: "succeeded" } : null;
  return { documents, jobs, queued, learning, input, resolveSourceRun };
}
