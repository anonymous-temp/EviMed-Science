/** Advisory changes against immutable result inputs. A source lookup never edits a result. */
import { createHash } from "node:crypto";
import { AFFECTED_CLASSES, SOURCE_REPLACED_KIND, affectedClass, affectedCounts, doiOf, projectAffected } from "@evimed/domain";
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";
import { HttpError } from "./security.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stateSet = new Set(["changed", "no_update", "unknown", "unavailable"]);
const identity = source => String(source?.id ?? doiOf(source?.doi) ?? "");
const DIGEST = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^src_[a-f0-9]{32}$/;
/** Pages of dependents read for one calculation, and results per page: the bound on one change's reach, never a silent cutoff of the scan. */
const DEPENDENT_PAGES = 5;
const DEPENDENT_PAGE = 100;
const isMissing = error => [401, 403, 404].includes(error?.status) || ["result_not_found", "result_version_unavailable"].includes(error?.code);

/**
 * Only recorded input identities participate, never a title or similar prose. A knowledge-base document is also
 * recorded by the digest of its exact bytes (`contentDigest`), which is how a result that read the file names it.
 */
function matches(input, source) {
  if (input?.kind !== "source" && !(source.contentDigest && input?.kind === "data")) return false;
  if (input.availability === "restricted") return false;
  if (source.contentDigest && DIGEST.test(source.contentDigest) && input.digest === source.contentDigest) return true;
  if (input.kind !== "source") return false;
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
    ...(value.versionId ? { versionId: String(value.versionId) } : {}), ...(doiOf(value.doi) ? { doi: doiOf(value.doi) } : {}),
    ...(DIGEST.test(String(value.contentDigest ?? "")) ? { contentDigest: String(value.contentDigest) } : {}),
    ...(SOURCE_ID.test(String(value.replacedBy ?? "")) ? { replacedBy: String(value.replacedBy) } : {}) };
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

/** What a researcher is told in the inbox: that the source changed and what rests on it, never that a result is wrong. */
function impactBody(checked, affected) {
  const replaced = checked.updates.some(update => update.kind === SOURCE_REPLACED_KIND);
  const { found, unknown } = affectedCounts(affected);
  const names = { calculations: "个计算", dependents: "个依赖它的结果", memories: "条记忆", methods: "个方法" };
  const rests = AFFECTED_CLASSES.filter(name => found[name]).map(name => `${found[name]} ${names[name]}`);
  return `${replaced ? "资料库里这份文件有了新版本。" : "来源发布了更正或撤回通知。"}历史结果已保留；这只说明来源变了，不说明原来的结论有误。`
    + `${rests.length ? `依赖它的有：${rests.join("、")}。` : ""}`
    + `${unknown.some(name => name === "memories" || name === "methods") ? "有些依赖暂时查不到，不能当作没有。" : ""}可以检查受影响的部分并继续研究。`;
}

/** The printed values of a version that are bound to one calculation: how many, and the first few keys. */
function boundTo(version, calculationId) {
  const items = (version.bindings?.items ?? []).filter(item => item.calculation?.versionId === calculationId);
  return { versionId: version.versionId, path: version.path ?? null, boundValues: items.length,
    keys: [...new Set(items.map(item => item.calculation.key))].slice(0, 5) };
}

/**
 * What an agenda is asked to do about a source change: look at the result and at what was found to rest on the source,
 * and nothing else. The notice says the source changed; the note never says the conclusion is wrong.
 * @param {any} payload a result impact's payload
 */
function continuationNote(payload) {
  const affected = projectAffected(payload.affected);
  const named = (list, label) => (list?.items?.length ? ` ${label}: ${list.items.map(item => item.versionId ?? item.id ?? item.recordId).join(", ")}${list.total > list.items.length ? ` and ${list.total - list.items.length} more` : ""}.` : "");
  const scope = affected ? [
    named(affected.calculations, "Calculations among its bound values that rest on the source (recompute only these and the printed values bound to them)"),
    named(affected.dependents, "Results whose printed values are bound to this calculation"),
    affected.methods.total ? ` ${affected.methods.total} learned method(s) are linked to it; they carry a label that the source changed.` : "",
    affected.memories.total ? ` ${affected.memories.total} memory record(s) name the source and carry a label that it changed.` : "",
  ].join("") : "";
  return `Review source updates against immutable result ${payload.versionId}. Source: ${JSON.stringify(payload.source)}. Notices: ${JSON.stringify(payload.sourceStatus.updates)}.${scope}`
    + " A notice means the source changed; it does not by itself show the result's conclusion is wrong."
    + " Recheck only what rests on this source and leave every other result, calculation, memory and method as it is, without running it again."
    + " Preserve the prior result. Identify affected conclusions; create a successor only for the affected analysis. State what changed, what was recomputed, and what remains uncertain.";
}

const byId = (left, right) => String(left.versionId ?? left.recordId ?? left.id).localeCompare(String(right.versionId ?? right.recordId ?? right.id));

export class ResultImpactService {
  /**
   * `knowledge` is the memories and learned methods that rest on a changed source (`knowledgeChange.mjs`); absent, the
   * record says those lookups were not made. `authorizeContinuation(ownerId, impact)` answers which agenda the researcher
   * already authorized for this result, if any (the running agenda whose episode produced it); at most
   * `autoRecheckLimit` impacts of one check are continued that way, and the rest wait for the researcher's own choice.
   * @param {{documents:any,results:any,autopilot?:any,notifications?:any,knowledge?:any,authorizeContinuation?:(userId:string,impact:any)=>Promise<string|null>,
   *   autoRecheckLimit?:number,report?:(code:string)=>void,now?:()=>Date}} dependencies
   */
  constructor({ documents, results, autopilot = null, notifications = null, knowledge = null, authorizeContinuation = null, autoRecheckLimit = 3,
    report = () => {}, now = () => new Date() }) {
    this.documents = documents; this.results = results; this.autopilot = autopilot; this.notifications = notifications; this.knowledge = knowledge;
    this.authorizeContinuation = authorizeContinuation; this.autoRecheckLimit = autoRecheckLimit; this.report = report; this.now = now;
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

  /**
   * Preserve the advisory row; current source permissions bound every public read. A version that rests on the source
   * through a calculation among its bound values is read the same way, by that calculation's own recorded inputs.
   */
  async projectImpact(userId, projectId, row) {
    const version = await this.results.get(userId, projectId, row.payload.versionId);
    const holders = [version];
    for (const item of row.payload.affected?.calculations?.items ?? []) {
      try { holders.push(await this.results.get(userId, projectId, item.versionId)); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    const matchesSource = holders.flatMap(holder => (holder.inputs ?? []).filter(input => matches({ ...input,
      availability: input.availability === "restricted" ? "reference" : input.availability }, row.payload.source)));
    if (matchesSource.some(input => !["restricted", "deleted"].includes(input.availability))) {
      return row.payload.affected ? { ...row, payload: { ...row.payload, affected: projectAffected(row.payload.affected) } } : row;
    }
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
   * The knowledge base received new bytes for a file it already held (a new content-addressed document beside the old
   * one): the work that rests on the old document is affected the way work that rests on a corrected paper is. The old
   * document is named by its id and by the digest of its exact bytes, which is how a result that read the file recorded
   * it, and what replaced it by its id. Found by those recorded links, never by the file's name.
   * @param {string} userId @param {{projectId:string, replaced:{sourceId:string, sha256:string}, by?:{sourceId?:string, at?:string|null}}} input
   */
  async reconcileReplacement(userId, { projectId, replaced, by = {} }) {
    const date = typeof by.at === "string" && /^\d{4}-\d{2}-\d{2}/.test(by.at) ? by.at.slice(0, 10) : null;
    const status = { state: "changed", checkedAt: this.now().toISOString(), reason: "replaced",
      updates: [{ kind: SOURCE_REPLACED_KIND, noticeDoi: null, date, source: null }] };
    return this.reconcileSourceUpdate(userId, { projectId, status,
      source: { id: replaced.sourceId, contentDigest: replaced.sha256, ...(by.sourceId ? { replacedBy: by.sourceId } : {}) } }, { exact: true });
  }

  /**
   * The versions that name the source: every version of the project whose recorded inputs do (a scan of all of them, so
   * a DOI written in another form still meets its work), or — for a knowledge-base document, which is named by exact
   * identifiers — the versions that contain exactly those identifiers.
   * @returns {Promise<{ ids: string[], scanned: number }>}
   */
  async #naming(userId, projectId, ref, exact) {
    const ids = new Set();
    let scanned = 0;
    const pages = async (list) => {
      let cursor = null;
      const cursors = new Set();
      do {
        const page = await list(cursor);
        for (const resultRow of page.items) {
          const result = resultRow.payload ?? resultRow;
          scanned += 1;
          if ((result.inputs ?? []).some(input => matches(input, ref))) ids.add(result.versionId ?? result.id ?? resultRow.id);
        }
        cursor = page.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new HttpError(503, "result_impact_pagination_invalid", "Result pagination did not advance.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    };
    if (!exact) await pages(cursor => this.results.list(userId, { projectId, limit: 100, cursor }));
    else {
      for (const filter of [{ inputs: [{ id: ref.id }] }, ...(ref.contentDigest ? [{ inputs: [{ digest: ref.contentDigest }] }] : [])]) {
        await pages(cursor => this.results.query(userId, projectId, filter, { limit: DEPENDENT_PAGE, cursor }));
      }
    }
    return { ids: [...ids], scanned };
  }

  /**
   * The versions whose printed values are bound to one calculation (`bindingSources`, the lineage's own index), read to
   * a bound. A lookup that cannot be made is unknown, and the calculation's dependents are then not enumerated.
   * @returns {Promise<{ items: any[], unknown?: string }>}
   */
  async #boundTo(userId, projectId, calculation) {
    if (typeof this.results.query !== "function") return { items: [], unknown: "unavailable" };
    const items = [];
    try {
      let cursor = null;
      for (let page = 0; page < DEPENDENT_PAGES; page += 1) {
        const reply = await this.results.query(userId, projectId, { bindingSources: [calculation.versionId] }, { limit: DEPENDENT_PAGE, cursor });
        items.push(...reply.items.filter(item => item.versionId !== calculation.versionId));
        cursor = reply.nextCursor ?? null;
        if (!cursor) break;
      }
      return { items };
    } catch (error) {
      this.report(typeof error?.code === "string" ? error.code : "result_impact_dependents_failed");
      return { items: [], unknown: "lookup_failed" };
    }
  }

  /**
   * Call after a trusted check. Unavailable and unknown checks record a gap, never a fabricated change.
   * No-update checks do not create new impacts. Every result page is checked; no silent 100-result cutoff.
   *
   * Beyond the versions that name the source themselves, a version whose printed values are bound to a calculation that
   * rests on it is affected too, and so are the memories that name it and the learned methods linked to those versions:
   * each is found by its recorded link, labelled with the source's new state and listed on the impact. Work that rests
   * on nothing the source touches gets no row and is not asked to run again.
   * @param {string} userId @param {{projectId:string, source:any, status:any}} input @param {{exact?:boolean}} [options]
   */
  async reconcileSourceUpdate(userId, { projectId, source, status }, { exact = false } = {}) {
    const project = await this.results.scope(userId, projectId);
    const ownerId = project.userId;
    const ref = sourceReference(source);
    const checked = statusProjection(status);
    // Memories rest on the source whether or not a result of this project does; the label is about the source.
    const memories = this.knowledge ? await this.knowledge.memories(ownerId, projectId, ref, checked) : { unknown: "unavailable" };
    if (checked.state === "no_update") return { items: [], scanned: 0 };
    const { ids, scanned } = await this.#naming(userId, projectId, ref, exact);
    const changeKey = hash([ref, checked.state, checked.reason ?? null, checked.updates]);
    /** @type {Map<string, any>} */
    const calculations = new Map();
    /** Does a calculation still rest on the source, and what is bound to it. @param {string} calculationId */
    const calculation = async calculationId => {
      if (!calculations.has(calculationId)) {
        const entry = { version: null, rests: false, dependents: null, unknown: null };
        try {
          entry.version = await this.results.get(userId, projectId, calculationId);
          entry.rests = (entry.version.inputs ?? []).some(input => matches(input, ref) && input.availability !== "deleted");
        } catch (error) {
          if (!isMissing(error)) { this.report(typeof error?.code === "string" ? error.code : "result_impact_calculation_failed"); entry.unknown = "lookup_failed"; }
        }
        calculations.set(calculationId, entry);
      }
      return calculations.get(calculationId);
    };
    const queue = [...ids];
    const queued = new Set(queue);
    const items = [];
    let continued = 0;
    for (let position = 0; position < queue.length; position += 1) {
      const versionId = queue[position];
      const currentResult = await this.results.get(userId, projectId, versionId);
      const named = (currentResult.inputs ?? []).some(input => matches(input, ref) && input.availability !== "deleted");
      // A calculation that rests on the source brings in the versions bound to it, once each.
      const isCalculation = (currentResult.machineValues ?? []).length > 0;
      let dependents = { items: [] };
      if (named && isCalculation) {
        dependents = await this.#boundTo(userId, projectId, currentResult);
        for (const dependent of dependents.items) if (!queued.has(dependent.versionId)) { queued.add(dependent.versionId); queue.push(dependent.versionId); }
      }
      const boundIds = [...new Set((currentResult.bindings?.items ?? []).map(item => item.calculation?.versionId))].filter(id => id && id !== versionId);
      /** @type {any[]} */
      const resting = [];
      let calculationUnknown = null;
      for (const id of boundIds) {
        const entry = await calculation(id);
        if (entry.unknown) calculationUnknown = entry.unknown;
        else if (entry.rests) resting.push(entry.version);
      }
      if (!named && !resting.length) continue;
      const methods = this.knowledge ? await this.knowledge.methodsFor(ownerId, [versionId, ...resting.map(item => item.versionId)], ref, checked) : { unknown: "unavailable" };
      const affected = { schemaVersion: 1, via: named ? "input" : "calculation",
        calculations: affectedClass(calculationUnknown && !resting.length ? { unknown: calculationUnknown }
          : { items: resting.map(item => ({ ...boundTo(currentResult, item.versionId), versionId: item.versionId, path: item.path ?? null })).sort(byId) }, "calculations"),
        dependents: affectedClass(dependents.unknown ? { unknown: dependents.unknown }
          : { items: dependents.items.map(item => boundTo(item, versionId)).sort(byId) }, "dependents"),
        memories: affectedClass({ ...memories, items: [...(memories.items ?? [])].sort(byId) }, "memories"),
        methods: affectedClass({ ...methods, items: [...(methods.items ?? [])].sort(byId) }, "methods") };
      const id = `impact-${hash([ownerId, projectId, versionId, changeKey]).slice(0, 48)}`;
      let row = await this.documents.get(ownerId, "result-impact", id);
      if (!row) {
        const findings = (currentResult.findings ?? []).filter(finding => finding.elementId
          && (finding.sourceRefs ?? []).some(input => matches({ kind: "source", ...input }, ref)));
        const payload = { schemaVersion: 1, recordType: "result-impact", versionId,
          source: ref, sourceStatus: checked, changeKey, effect: checked.state === "changed" ? "potentially_affected" : "source_gap",
          claimIds: [...new Set(findings.map(finding => finding.elementId))],
          coverage: !named ? "calculation_bindings" : findings.length ? "recorded_claim_refs" : "result_inputs_only",
          affected, historicalResultPreserved: true, recomputed: false, observedAt: this.now().toISOString(),
          continuation: { status: "awaiting_user", reason: "authorization_required" } };
        try { row = await this.documents.put(ownerId, "result-impact", id, payload, { expectedRevision: 0, projectId }); }
        catch (error) {
          if (error?.code !== "product_revision_conflict") throw error;
          row = await this.documents.get(ownerId, "result-impact", id);
          if (!row) throw error;
        }
      } else if (JSON.stringify(row.payload.affected ?? null) !== JSON.stringify(affected)) {
        // A later check of the same change finds what rests on it now: a memory written since, a method learnt since.
        // Only the list moves; the continuation, the status and the preserved result are as they were.
        try { row = await this.documents.put(ownerId, "result-impact", id, { ...row.payload, affected }, { expectedRevision: row.revision, projectId }); }
        catch (error) { if (error?.code !== "product_revision_conflict") throw error; row = await this.documents.get(ownerId, "result-impact", id) ?? row; }
      }
      if (checked.state === "changed") {
        await this.notifications?.create(ownerId, { noticeType: "notify", severity: "attention", projectId,
          title: "引用来源有更新", body: impactBody(checked, projectAffected(affected)),
          source: currentResult.producer?.runId ? { type: "run", id: currentResult.producer.runId } : { type: "system", id }, idempotencyKey: `result-impact:${id}` });
        // The agenda the researcher already runs for this work may recheck it: no further approval, and no recheck for an
        // agenda that is paused or not started. A failure here leaves the impact waiting for the researcher's own choice.
        if (this.authorizeContinuation && row.payload.continuation.status !== "scheduled" && continued < this.autoRecheckLimit) {
          continued += 1;
          try {
            const agendaId = await this.authorizeContinuation(ownerId, row);
            if (agendaId) row = await this.continueImpact(ownerId, projectId, id, { agendaId });
          } catch (error) { this.report(typeof error?.code === "string" ? error.code : "result_impact_continuation_failed"); row = await this.documents.get(ownerId, "result-impact", id) ?? row; }
        }
      }
      items.push(await this.projectImpact(userId, projectId, row));
    }
    // A source that changed and that no result of this project names may still be one the researcher's memories and methods
    // rest on: that is told in the inbox too, once for the change.
    if (!items.length && checked.state === "changed" && memories.total) {
      const id = `knowledge-change-${hash([ownerId, ref, changeKey]).slice(0, 32)}`;
      await this.notifications?.create(ownerId, { noticeType: "notify", severity: "attention", projectId, title: "引用来源有更新",
        body: impactBody(checked, projectAffected({ schemaVersion: 1, calculations: affectedClass({ items: [] }, "calculations"),
          dependents: affectedClass({ items: [] }, "dependents"), memories: affectedClass(memories, "memories"), methods: affectedClass({ items: [] }, "methods") })),
        source: { type: "system", id }, idempotencyKey: `knowledge-change:${id}` });
    }
    return { items, scanned };
  }

  /** Explicit user continuation or a trusted existing consent resolver; existing agenda budgets still apply. */
  async assertContinuation(userId, projectId, binding) {
    try {
      const project = await this.results.scope(userId, projectId);
      const impact = await this.get(userId, projectId, binding.impactId);
      if (project.userId !== userId || binding.requestedBy !== userId || binding.projectId !== projectId
        || impact.payload.versionId !== binding.versionId || JSON.stringify(sourceReference(impact.payload.source)) !== JSON.stringify(sourceReference(binding.source))
        || impact.payload.continuation.agendaId !== binding.agendaId
        || !["preparing", "scheduled"].includes(impact.payload.continuation.status)) throw new HttpError(409, "result_impact_source_unavailable", "Continuation binding is no longer authorized.");
    } catch (error) {
      // Permission and deletion refusals are terminal; an infrastructure outage
      // still propagates for the existing worker retry policy.
      if (error?.code === "result_impact_source_unavailable") throw error;
      if (![401, 403, 404].includes(error?.status) && !["result_not_found", "result_impact_not_found"].includes(error?.code)) throw error;
      throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
    }
  }

  async readScheduledContinuation(userId, projectId, id, binding, scheduled) {
    try {
      await this.assertContinuation(userId, projectId, binding);
      const impact = await this.get(userId, projectId, id);
      if (impact.payload.continuation.status === "unavailable") throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
      return impact;
    } catch (error) {
      if (error?.code === "result_impact_source_unavailable" || [401, 403, 404].includes(error?.status)) {
        await this.autopilot.stopContinuation(userId, scheduled.episode.id, binding, { jobId: scheduled.job?.id });
      }
      throw error;
    }
  }

  async continueImpact(userId, projectId, id, { agendaId, expectedRevision = undefined }) {
    const project = await this.results.scope(userId, projectId);
    const ownerId = project.userId;
    let impact = await this.get(userId, projectId, id);
    if (userId !== ownerId) throw new HttpError(403, "result_impact_agenda_unauthorized", "Only the agenda owner can authorize research continuation.");
    if (impact.payload.continuation.status === "unavailable") {
      const stored = await this.documents.get(ownerId, "result-impact", id);
      if (stored?.payload?.continuation?.episodeId && this.autopilot) {
        const episode = await this.autopilot.getEpisode(ownerId, stored.payload.continuation.episodeId);
        if (episode.payload.continuationBinding?.impactId === id) await this.autopilot.stopContinuation(ownerId, episode.id, episode.payload.continuationBinding);
      }
      throw new HttpError(409, "result_impact_source_unavailable", "This source is no longer available for continuation.");
    }
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
    const note = continuationNote(impact.payload);
    const continuationBinding = { impactId: id, versionId: impact.payload.versionId, source: impact.payload.source,
      projectId, requestedBy: userId, agendaId };
    const scheduled = await this.autopilot.schedule(ownerId, agenda.id, { trigger: "follow-up", requestId: id, note,
      continuationBinding, expectedRevision: agenda.revision });
    // schedule's persisted request identity makes retries safe if the process died before this CAS.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      impact = await this.readScheduledContinuation(userId, projectId, id, continuationBinding, scheduled);
      if (impact.payload.continuation.status === "scheduled") return impact;
      try {
        await this.documents.put(ownerId, "result-impact", id, { ...impact.payload,
        continuation: { status: "scheduled", agendaId: agenda.id, episodeId: scheduled.episode.id, scheduledAt: this.now().toISOString() } },
        { expectedRevision: impact.revision, projectId });
        return await this.readScheduledContinuation(userId, projectId, id, continuationBinding, scheduled);
      }
      catch (error) { if (error?.code !== "product_revision_conflict" || attempt === 3) throw error; }
    }
  }
}
