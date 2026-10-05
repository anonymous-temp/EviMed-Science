/**
 * What rests on a source that changed, other than the result versions themselves (plan 2026-10-02 §11.3 N15): the
 * memories that name it and the learned methods linked to a result that rests on it, each found by a recorded link and
 * labelled with the source's new state.
 *
 * The result side — which versions name the source, which calculations among their value bindings do, the impact rows,
 * the inbox notice and the continuation of an authorized agenda — stays in `resultImpact.mjs`, which asks this module
 * for the rest. Registered by one line (`new ResultImpactService({ knowledge })`) and absent, the impact path is what it
 * was.
 *
 * Hidden knowledge:
 *
 * - **A label, never a verdict or a gate.** A memory's link and a method's record gain the state the check found and
 *   why. No memory version moves, no method revision, status or counter moves, nothing is hidden or failed, and recall
 *   and the lifecycle go on as before; what reads the label is recall (which says the memory rests on a source that
 *   changed) and the impact panel. A correction is a notice that the source changed, so the wording of everything built
 *   from here says what changed and what depends on it, never that a conclusion is wrong.
 * - **Recorded links only.** A memory is found by its `record_sources` row (`dependentsOfSource`), a method by the
 *   immutable result version its record names (`methodsLinkedTo`). Neither is ever found by what it says.
 * - **A lookup that could not be made is unknown.** It is returned as `{ unknown: reason }`, which the record keeps as
 *   such; a failure here never fails the check that called it, and a failed check never lowers what an earlier one found
 *   (`linkStatesLeftFor`).
 * - **The one record of source changes is read, not re-detected.** `labelSince` takes what `sourceChanges.mjs` recorded
 *   since a position of its feed — whoever detected it: Crossref, the frontier, the evidence zone — and labels the memories
 *   that name those works, with no lookup of its own.
 * - **What is shown follows what the reader may see.** Every memory dependent is labelled (the label is about the
 *   source), but only the ones in this project's scope or the account's own are listed in a project's panel, and only
 *   those in use: a replaced or archived memory is history that still names its source.
 *
 * @module knowledgeChange
 */
import { createHash } from "node:crypto";
import { doiOf, doiOfSourceIdentifier, linkReasonOf, linkStateOf, linkStatesLeftFor, sourceUpdateStatusOfFact } from "@evimed/domain";
import { methodLabel } from "./learningService.mjs";
import { sourceLinkOf } from "./researchMemory.mjs";

/** How many result versions one source change looks up methods for; a link is a handful, and a count is never a ledger. */
const MAX_VERSIONS = 40;

/** @param {any} error @returns {string} */
const codeOf = (error) => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "knowledge_change_failed");

/**
 * The memory source link a source identity can be: a published work by its DOI, a knowledge-base document by its `src_`
 * id. Anything else (a preserved file's path) names nothing a memory records, so it is no link.
 * @param {{ id?: string, doi?: string }} ref @returns {{ type: string, id: string } | null}
 */
export function memoryLinkOf(ref) {
  const doi = doiOf(ref?.doi ?? ref?.id);
  const link = doi ? sourceLinkOf({ type: "doi", id: doi }) : sourceLinkOf({ type: "knowledge_source", id: String(ref?.id ?? "") });
  return link ? { type: link.type, id: link.id } : null;
}

export class KnowledgeChangeService {
  /**
   * `memory` is the research-memory store (`dependentsOfSource`, `markSourceLinks`), `methods` the learning service
   * (`methodsLinkedTo`, `recordSourceChange`). Either absent, its class is reported unknown, never none.
   * `sourceChanges` is the one record of what was published about a work after it was published (`sourceChanges.mjs`).
   * @param {{ memory?: any, methods?: any, sourceChanges?: any, report?: (code: string) => void, now?: () => Date }} dependencies
   */
  constructor({ memory = null, methods = null, sourceChanges = null, report = () => {}, now = () => new Date() }) {
    this.memory = memory; this.methods = methods; this.sourceChanges = sourceChanges; this.report = report; this.now = now;
  }

  /**
   * Label the memories that name the works whose changes were recorded since a position of the source-change feed, and
   * list the ones this project may be shown, per work. The same labelling a check makes (`memories`), taken from what
   * was recorded rather than from a lookup: a retraction the frontier noticed reaches a memory that names the work
   * without anybody asking Crossref. Keep the `cursor` and give it back to go on from there.
   * @param {string} ownerId @param {string} projectId @param {{ since?: number | string | null, limit?: number }} [options]
   * @returns {Promise<{ items?: Array<{ identifier: string, memories: any[] }>, cursor?: number, hasMore?: boolean, unknown?: string }>}
   */
  async labelSince(ownerId, projectId, { since = 0, limit = 50 } = {}) {
    if (!this.sourceChanges) return { unknown: "unavailable" };
    let page;
    try { page = await this.sourceChanges.changedSince(since, limit); }
    catch (error) { this.report(codeOf(error)); return { unknown: "lookup_failed" }; }
    /** @type {Array<{ identifier: string, memories: any[] }>} */
    const items = [];
    for (const fact of page.items) {
      const doi = doiOfSourceIdentifier(fact.identifier);
      const status = sourceUpdateStatusOfFact(fact);
      if (!doi || status.state !== "changed") continue;
      const found = await this.memories(ownerId, projectId, { id: doi, doi }, status);
      if (found.items?.length) items.push({ identifier: fact.identifier, memories: found.items });
    }
    return { items, cursor: page.cursor, hasMore: page.hasMore };
  }

  /**
   * Label the memories that rest on a source with what a check found, and list the ones this project may be shown.
   * @param {string} ownerId @param {string} projectId @param {{ id: string, doi?: string }} ref
   * @param {{ state: string, reason?: string, updates?: any[] }} checked the source update status (`statusProjection`)
   * @returns {Promise<{ items?: any[], total?: number, unknown?: string }>}
   */
  async memories(ownerId, projectId, ref, checked) {
    const link = memoryLinkOf(ref);
    if (!link) return { items: [], total: 0 };
    if (!this.memory || this.memory.configured === false) return { unknown: "unavailable" };
    try {
      const dependents = await this.memory.dependentsOfSource(ownerId, link);
      if (!dependents.length) return { items: [], total: 0 };
      const next = linkStateOf(checked);
      const from = linkStatesLeftFor(next);
      /** @type {Set<string>} */
      let moved = new Set();
      if (dependents.some((/** @type {any} */ row) => row.state !== next && from.includes(row.state))) {
        moved = new Set((await this.memory.markSourceLinks(ownerId, link, { state: next, reason: linkReasonOf(checked), onlyFrom: from })).recordIds);
      }
      const shown = dependents.filter((/** @type {any} */ row) => ["active", "pending"].includes(row.status)
        && (row.scope === "user" || row.scope === "organization" || (row.scope === "project" && row.scopeId === projectId)));
      return { total: shown.length, items: shown.map((/** @type {any} */ row) => ({ recordId: row.recordId, scope: row.scope, kind: row.kind,
        state: moved.has(row.recordId) ? next : row.state })) };
    } catch (error) {
      this.report(codeOf(error));
      return { unknown: "lookup_failed" };
    }
  }

  /**
   * The learned methods linked to result versions that rest on a source, found by the version identities their records
   * name, and — when the source really changed — labelled with it. A check that could not answer lists them and labels
   * nothing: there is no change to record.
   * @param {string} ownerId @param {readonly string[]} versionIds @param {{ id: string, doi?: string }} ref
   * @param {{ state: string, reason?: string, updates?: any[] }} checked
   * @returns {Promise<{ items?: any[], total?: number, unknown?: string }>}
   */
  async methodsFor(ownerId, versionIds, ref, checked) {
    if (!this.methods) return { unknown: "unavailable" };
    const state = linkStateOf(checked);
    const at = this.now().toISOString();
    /** @type {Map<string, any>} */
    const found = new Map();
    try {
      for (const versionId of [...new Set(versionIds)].slice(0, MAX_VERSIONS)) {
        for (const document of await this.methods.methodsLinkedTo(ownerId, versionId)) {
          if (found.has(document.id)) continue;
          const learnt = (document.payload?.provenance?.results ?? []).some((/** @type {any} */ entry) => entry?.versionId === versionId);
          found.set(document.id, { id: document.id, title: methodLabel(document), versionId, relation: learnt ? "learnt_from" : "used_for" });
        }
      }
    } catch (error) {
      this.report(codeOf(error));
      return { unknown: "lookup_failed" };
    }
    if (state === "changed" || state === "retracted") {
      for (const item of found.values()) {
        const id = `sc_${createHash("sha256").update(JSON.stringify([ref.id, state, item.versionId, item.id])).digest("hex").slice(0, 32)}`;
        try {
          await this.methods.recordSourceChange(ownerId, item.id, { id, source: { id: ref.id, ...(ref.doi ? { doi: ref.doi } : {}) }, state,
            reason: linkReasonOf(checked), versionId: item.versionId, relation: item.relation, at });
        } catch (error) { this.report(codeOf(error)); }
      }
    }
    return { total: found.size, items: [...found.values()] };
  }
}

/**
 * The agenda the researcher already runs for a result: the one whose episode produced it, or one of the calculations it
 * rests on, found by the run each version records — never by a topic or a title. Only a running agenda (enabled and
 * active, not archived) is returned; a paused or not-started one is not a standing authorization, and a result nobody's
 * agenda produced has none, so its impact waits for the researcher's own choice. Absent or failing, there is none.
 * @param {{ results: any, autopilot: any }} dependencies
 * @returns {(ownerId: string, impact: any) => Promise<string | null>}
 */
export function producingAgenda({ results, autopilot }) {
  return async (ownerId, impact) => {
    const projectId = impact.projectId;
    const versionIds = [impact.payload.versionId, ...(impact.payload.affected?.calculations?.items ?? []).map((/** @type {any} */ item) => item.versionId)];
    for (const versionId of versionIds) {
      const runId = (await results.get(ownerId, projectId, versionId).catch(() => null))?.producer?.runId;
      if (!runId) continue;
      const agendaId = (await autopilot.episodeForRun(ownerId, projectId, runId).catch(() => null))?.payload?.agendaId;
      if (typeof agendaId !== "string") continue;
      const agenda = await autopilot.get(ownerId, agendaId).catch(() => null);
      if (agenda?.projectId === projectId && agenda.payload.enabled && agenda.payload.status === "active" && !agenda.payload.archivedAt) return agendaId;
    }
    return null;
  };
}
