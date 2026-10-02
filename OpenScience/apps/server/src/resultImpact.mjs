/** Advisory changes against immutable result inputs. A source lookup never edits a result. */
import { createHash } from "node:crypto";
import { doiOf } from "@evimed/domain";
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";
import { HttpError } from "./security.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stateSet = new Set(["changed", "no_update", "unknown", "unavailable"]);
const identity = source => String(source?.id ?? doiOf(source?.doi) ?? "");

/** Only recorded input identities participate, never a title or similar prose. */
function matches(input, source) {
  if (input?.kind !== "source" || input.availability === "restricted") return false;
  const sameId = identity(source) && (input.id === identity(source) || doiOf(input.id) && doiOf(input.id) === doiOf(identity(source)));
  if (!sameId) return false;
  if (source.digest && input.digest !== source.digest) return false;
  if (source.versionId && input.versionId !== source.versionId) return false;
  return true;
}

/** Copy only public identities; source data-plane paths and arbitrary response fields stay out. */
function sourceReference(value) {
  const id = identity(value);
  if (!id || id.length > 512) throw new HttpError(400, "result_impact_source_invalid", "An exact source identity is required.");
  return { id, ...(value.digest ? { digest: String(value.digest) } : {}),
    ...(value.versionId ? { versionId: String(value.versionId) } : {}), ...(doiOf(value.doi) ? { doi: doiOf(value.doi) } : {}) };
}

/** Canonical changes exclude check time: repeated checks of one notice are one impact. */
function statusProjection(status) {
  if (!stateSet.has(status?.state)) throw new HttpError(400, "result_impact_status_invalid", "Invalid source update state.");
  const notices = (Array.isArray(status.updates) ? status.updates : []).map(item => ({
    kind: String(item.kind), noticeDoi: doiOf(item.noticeDoi), date: item.date ?? null, source: item.source ?? null,
  }));
  const updates = [...new Map(notices.map(item => [JSON.stringify(item), item])).values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (status.state === "changed" && !updates.length) throw new HttpError(400, "result_impact_status_invalid", "A changed source must name its observed update.");
  return { state: status.state, checkedAt: status.checkedAt ?? null,
    ...(status.reason ? { reason: String(status.reason).slice(0, 80) } : {}), updates };
}

/**
 * Canonical matrix links, with byte digests supplied by the existing stable capture reader.
 * No digest is derived from clipped/decoded prose. Missing capture facts stay references.
 * @param {any} matrix @param {{verdict?:any,capturedSources?:Map<string,{digest?:string,versionId?:string}>}} options
 */
export function clinicalResultLinks(matrix, { verdict = null, capturedSources = new Map() } = {}) {
  const inputs = new Map();
  const findings = [];
  const verified = new Map((verdict?.claims ?? []).map(claim => [claim.claimId, claim]));
  const claims = new Map((matrix?.claims ?? []).map(claim => [claim.claimId, claim]));
  const refsByClaim = new Map();
  const resolving = new Set();
  const references = claim => {
    if (!claim || resolving.has(claim.claimId)) return [];
    if (refsByClaim.has(claim.claimId)) return refsByClaim.get(claim.claimId);
    resolving.add(claim.claimId);
    const sourceRefs = [];
    for (const origin of claimEvidenceSources(claim)) {
      const doi = doiOf(origin.identifier) ?? doiOf(origin.sourceUrl);
      const path = typeof origin.artifactPath === "string" && !origin.artifactPath.startsWith("/")
        && !origin.artifactPath.includes("\\") && !origin.artifactPath.split("/").includes("..") ? origin.artifactPath : null;
      const id = doi ?? path;
      if (!id || id.length > 200) continue;
      const capture = capturedSources.get(path);
      const ref = { kind: "source", id, path,
        digest: capture?.digest ?? null, versionId: capture?.versionId ?? null,
        availability: capture?.digest ? "captured" : "reference" };
      inputs.set(JSON.stringify([ref.id, ref.digest, ref.versionId]), ref);
      sourceRefs.push(ref);
    }
    for (const parent of Array.isArray(claim.derivedFrom) ? claim.derivedFrom : []) sourceRefs.push(...references(claims.get(parent)));
    resolving.delete(claim.claimId);
    const refs = [...new Map(sourceRefs.map(ref => [JSON.stringify(ref), ref])).values()];
    refsByClaim.set(claim.claimId, refs);
    return refs;
  };
  for (const claim of claims.values()) {
    const sourceRefs = references(claim);
    if (sourceRefs.length) findings.push({ id: `claim-${claim.claimId}`, kind: "claim_source_binding",
      status: verified.get(claim.claimId)?.status ?? "not_run", message: "Recorded claim-to-source links; source support remains separately assessed.",
      elementId: claim.claimId, sourceRefs });
  }
  return { inputs: [...inputs.values()], findings };
}

export class ResultImpactService {
  /** @param {{documents:any,results:any,autopilot?:any,notifications?:any,authorizeContinuation?:(userId:string,impact:any)=>Promise<string|null>,now?:()=>Date}} dependencies */
  constructor({ documents, results, autopilot = null, notifications = null, authorizeContinuation = null, now = () => new Date() }) {
    this.documents = documents; this.results = results; this.autopilot = autopilot; this.notifications = notifications;
    this.authorizeContinuation = authorizeContinuation; this.now = now;
  }

  async list(userId, { projectId, versionId = null, limit = 50, cursor = null }) {
    const project = await this.results.scope(userId, projectId);
    if (versionId) await this.results.get(userId, projectId, versionId);
    const page = await this.documents.list(project.userId, "result-impact", { projectId, limit, cursor,
      filter: { recordType: "result-impact", ...(versionId ? { versionId } : {}) } });
    return { ...page, items: await Promise.all(page.items.map(row => this.projectImpact(userId, projectId, row))) };
  }

  async get(userId, projectId, id) {
    const project = await this.results.scope(userId, projectId);
    const row = await this.documents.get(project.userId, "result-impact", id);
    if (!row || row.projectId !== projectId) throw new HttpError(404, "result_impact_not_found", "This result impact is unavailable.");
    return this.projectImpact(userId, projectId, row);
  }

  /** Preserve the advisory row; current source permissions bound every public read. */
  async projectImpact(userId, projectId, row) {
    const version = await this.results.get(userId, projectId, row.payload.versionId);
    const matchesSource = (version.inputs ?? []).filter(input => matches({ ...input,
      availability: input.availability === "restricted" ? "reference" : input.availability }, row.payload.source));
    if (matchesSource.some(input => !["restricted", "deleted"].includes(input.availability))) return row;
    return { ...row, payload: { schemaVersion: row.payload.schemaVersion, recordType: "result-impact", versionId: row.payload.versionId,
      source: { id: "unavailable-source" }, sourceStatus: { state: "unavailable", checkedAt: null,
        reason: matchesSource.some(input => input.availability === "restricted") ? "restricted" : "source_unavailable", updates: [] },
      effect: "source_gap", claimIds: [], coverage: "source_unavailable", historicalResultPreserved: true, recomputed: false,
      continuation: { status: "unavailable", reason: "source_unavailable" } } };
  }

  /** Integrate a trusted claim-verification projection. DOI and preserved path are separate recorded identities. */
  async reconcileVerification(userId, projectId, verdict) {
    const seen = new Set();
    const replies = [];
    for (const claim of verdict.claims ?? []) for (const source of claim.sources ?? []) {
      if (!source.updateStatus) continue;
      for (const id of [source.doi, source.artifactPath].filter(Boolean)) {
        const key = JSON.stringify([id, source.updateStatus]);
        if (seen.has(key)) continue;
        seen.add(key);
        replies.push(await this.reconcileSourceUpdate(userId, { projectId, source: { id, ...(source.doi ? { doi: source.doi } : {}) }, status: source.updateStatus }));
      }
    }
    return { items: [...new Map(replies.flatMap(reply => reply.items).map(row => [row.id, row])).values()] };
  }

  /**
   * Call after a trusted check. Unavailable and unknown checks record a gap, never a fabricated change.
   * No-update checks do not create new impacts. Every result page is checked; no silent 100-result cutoff.
   */
  async reconcileSourceUpdate(userId, { projectId, source, status }) {
    const project = await this.results.scope(userId, projectId);
    const ownerId = project.userId;
    const ref = sourceReference(source);
    const checked = statusProjection(status);
    if (checked.state === "no_update") return { items: [], scanned: 0 };
    const items = [];
    let cursor = null;
    let scanned = 0;
    const cursors = new Set();
    do {
      const page = await this.results.list(userId, { projectId, limit: 100, cursor });
      for (const resultRow of page.items) {
        const result = resultRow.payload ?? resultRow;
        scanned += 1;
        if (!(result.inputs ?? []).some(input => matches(input, ref))) continue;
        const versionId = result.versionId ?? result.id ?? resultRow.id;
        const currentResult = await this.results.get(userId, projectId, versionId);
        if (!(currentResult.inputs ?? []).some(input => matches(input, ref) && input.availability !== "deleted")) continue;
        const changeKey = hash([ref, checked.state, checked.reason ?? null, checked.updates]);
        const id = `impact-${hash([ownerId, projectId, versionId, changeKey]).slice(0, 48)}`;
        let row = await this.documents.get(ownerId, "result-impact", id);
        if (!row) {
          const findings = (currentResult.findings ?? []).filter(finding => finding.elementId
            && (finding.sourceRefs ?? []).some(input => matches({ kind: "source", ...input }, ref)));
          const payload = { schemaVersion: 1, recordType: "result-impact", versionId,
            source: ref, sourceStatus: checked, changeKey, effect: checked.state === "changed" ? "potentially_affected" : "source_gap",
            claimIds: [...new Set(findings.map(finding => finding.elementId))],
            coverage: findings.length ? "recorded_claim_refs" : "result_inputs_only",
            historicalResultPreserved: true, recomputed: false, observedAt: this.now().toISOString(),
            continuation: { status: "awaiting_user", reason: "authorization_required" } };
          try { row = await this.documents.put(ownerId, "result-impact", id, payload, { expectedRevision: 0, projectId }); }
          catch (error) {
            if (error?.code !== "product_revision_conflict") throw error;
            row = await this.documents.get(ownerId, "result-impact", id);
            if (!row) throw error;
          }
        }
        if (checked.state === "changed") {
          await this.notifications?.create(ownerId, { noticeType: "notify", severity: "attention", projectId,
            title: "引用来源有更新", body: "来源发布了更正或撤回通知。历史结果已保留，可以检查受影响的结论并继续研究。",
            source: result.producer?.runId ? { type: "run", id: result.producer.runId } : { type: "system", id }, idempotencyKey: `result-impact:${id}` });
          if (this.authorizeContinuation && row.payload.continuation.status !== "scheduled") {
            const agendaId = await this.authorizeContinuation(userId, row);
            if (agendaId) row = await this.continueImpact(userId, projectId, id, { agendaId });
          }
        }
        items.push(await this.projectImpact(userId, projectId, row));
      }
      cursor = page.nextCursor ?? null;
      if (cursor && cursors.has(cursor)) throw new HttpError(503, "result_impact_pagination_invalid", "Result pagination did not advance.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { items, scanned };
  }

  /** Explicit user continuation or a trusted existing consent resolver; existing agenda budgets still apply. */
  async continueImpact(userId, projectId, id, { agendaId, expectedRevision = undefined }) {
    const project = await this.results.scope(userId, projectId);
    const ownerId = project.userId;
    let impact = await this.get(userId, projectId, id);
    if (userId !== ownerId) throw new HttpError(403, "result_impact_agenda_unauthorized", "Only the agenda owner can authorize research continuation.");
    if (impact.payload.continuation.status === "unavailable") throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
    if (impact.payload.continuation.agendaId && impact.payload.continuation.agendaId !== agendaId) throw new HttpError(409, "result_impact_continuation_conflict", "This impact already belongs to another agenda continuation.");
    if (impact.payload.continuation.status === "scheduled") return impact;
    if (impact.payload.effect !== "potentially_affected") throw new HttpError(409, "result_impact_not_changed", "An unavailable source is a gap, not evidence to recompute.");
    if (!this.autopilot) throw new HttpError(503, "result_impact_continuation_unavailable", "Research continuation is unavailable.");
    const agenda = await this.documents.get(ownerId, "agenda", agendaId);
    if (!agenda || agenda.projectId !== projectId || !agenda.payload.enabled || agenda.payload.status !== "active" || agenda.payload.archivedAt) {
      throw new HttpError(409, "result_impact_agenda_unauthorized", "An existing active agenda in this project is required.");
    }
    if (expectedRevision !== undefined && impact.revision !== expectedRevision) throw new HttpError(409, "product_revision_conflict", "The impact changed before continuation.");
    if (impact.payload.continuation.status !== "preparing") {
      try { impact = await this.documents.put(ownerId, "result-impact", id, { ...impact.payload,
        continuation: { status: "preparing", agendaId, requestedBy: userId, requestedAt: this.now().toISOString() } },
      { expectedRevision: impact.revision, projectId }); }
      catch (error) {
        if (error?.code !== "product_revision_conflict") throw error;
        impact = await this.get(userId, projectId, id);
        if (impact.payload.continuation.agendaId !== agendaId) throw new HttpError(409, "result_impact_continuation_conflict", "Another agenda owns this continuation.");
      }
    }
    impact = await this.get(userId, projectId, id);
    if (impact.payload.continuation.status === "unavailable") throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
    const note = `Review source updates against immutable result ${impact.payload.versionId}. Source: ${JSON.stringify(impact.payload.source)}. Notices: ${JSON.stringify(impact.payload.sourceStatus.updates)}. Preserve the prior result. Identify affected conclusions; create a successor only for the affected analysis. State what changed, what was recomputed, and what remains uncertain.`;
    const scheduled = await this.autopilot.schedule(ownerId, agenda.id, { trigger: "follow-up", requestId: id, note, expectedRevision: agenda.revision });
    // schedule's persisted request identity makes retries safe if the process died before this CAS.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      impact = await this.get(userId, projectId, id);
      if (impact.payload.continuation.status === "unavailable") throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
      if (impact.payload.continuation.status === "scheduled") return impact;
      try { return await this.documents.put(ownerId, "result-impact", id, { ...impact.payload,
        continuation: { status: "scheduled", agendaId: agenda.id, episodeId: scheduled.episode.id, scheduledAt: this.now().toISOString() } },
      { expectedRevision: impact.revision, projectId }); }
      catch (error) { if (error?.code !== "product_revision_conflict" || attempt === 3) throw error; }
    }
  }
}
