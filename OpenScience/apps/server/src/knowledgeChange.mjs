/**
 * What rests on a source that changed, other than the result versions themselves (plan 2026-10-02 §11.3 N15): the
 * memory files that name it and the learned methods linked to a result that rests on it, each found by a recorded link and
 * labelled with the source's new state.
 *
 * The result side — which versions name the source, which calculations among their value bindings do, the impact rows,
 * the inbox notice and the continuation of an authorized agenda — stays in `resultImpact.mjs`, which asks this module
 * for the rest. Registered by one line (`new ResultImpactService({ knowledge })`) and absent, the impact path is what it
 * was.
 *
 * Hidden knowledge:
 *
 * - **A label, never a verdict or a gate.** A memory file gains a label line and a method's record gains the state the check
 *   found and why. Nothing is hidden or failed, no method revision, status or counter moves, and recall and the lifecycle go on
 *   as before; what reads the label is the memory page and the impact panel. A correction is a notice that the source changed,
 *   so the wording of everything built from here says what changed and what depends on it, never that a conclusion is wrong.
 * - **Recorded links only.** A memory file is found by the source its text names, as the overlay recorded it
 *   (`NativeMemoryStore.dependentsOfSource`), a method by the immutable result version its record names (`methodsLinkedTo`).
 *   Neither is ever found by what it says.
 * - **A lookup that could not be made is unknown.** It is returned as `{ unknown: reason }`, which the record keeps as
 *   such; a failure here never fails the check that called it, and a failed check never lowers what an earlier one found
 *   (`NativeMemoryWorker.labelSource`).
 * - **The one record of source changes is read, not re-detected.** `labelSince` takes what `sourceChanges.mjs` recorded
 *   since a position of its feed — whoever detected it: Crossref, the frontier, the evidence zone — and labels the memory files
 *   that name those works, with no lookup of its own. (An evidence card or a frontier item a memory rested on was a link the
 *   legacy records kept and a memory file cannot: the hourly sweep over those was deleted with that engine, 2026-10-25.)
 * - **What is shown follows what the reader may see.** Every memory dependent is labelled (the label is about the
 *   source), but only the ones in this project's scope or the account's own are listed in a project's panel, and only
 *   those in use: a replaced or archived memory is history that still names its source.
 *
 * @module knowledgeChange
 */
import { createHash } from "node:crypto";
import { doiOf, doiOfSourceIdentifier, linkReasonOf, linkStateOf, sourceUpdateStatusOfFact } from "@evimed/domain";
import { methodLabel } from "./learningService.mjs";

/** How many result versions one source change looks up methods for; a link is a handful, and a count is never a ledger. */
const MAX_VERSIONS = 40;

/**
 * The memories a project's panel lists, as a predicate over a dependent row: in this project's scope or the account's own.
 * @param {string} projectId @returns {(row: any) => boolean}
 */
const listedIn = (projectId) => (row) => row.scope === "user" || row.scope === "organization" || (row.scope === "project" && row.scopeId === projectId);


/** @param {any} error @returns {string} */
const codeOf = (error) => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "knowledge_change_failed");

/**
 * The source a memory file can name for a source identity: a published work by its DOI, a knowledge-base document by its `src_`
 * id. Anything else (a preserved file's path, an evidence card) names nothing a memory file records, so it is no link.
 * @param {{ id?: string, doi?: string }} ref @returns {{ type: string, id: string } | null}
 */
export function memoryLinkOf(ref) {
  const doi = doiOf(ref?.doi ?? ref?.id);
  if (doi) return { type: "doi", id: doi };
  const id = String(ref?.id ?? "");
  return /^src_[a-f0-9]{32}$/.test(id) ? { type: "knowledge_source", id } : null;
}

export class KnowledgeChangeService {
  /**
   * `native` is the memory engine's side (`labelSource` writes the label line into the files that name a source,
   * `dependentsOfSource` lists them), `methods` the learning service (`methodsLinkedTo`, `recordSourceChange`). Either absent, its
   * class is reported unknown, never none.
   * `sourceChanges` is the one record of what was published about a work after it was published (`sourceChanges.mjs`).
   * `pages` is the knowledge pages' service (`knowledgePageService.mjs`): the pages that quote a source are found by the
   * `dependsOn` their records hold and labelled stale, and the project is queued for a recompile; absent, the class is unknown.
   * @param {{ native?: { labelSource: (userId: string, source: { type: string, id: string }, state: string) => Promise<number>,
   *     dependentsOfSource: (userId: string, source: { type: string, id: string }) => Promise<any[]> } | null,
   *   methods?: any, pages?: any, sourceChanges?: any, report?: (code: string) => void, now?: () => Date }} dependencies
   */
  constructor({ native = null, methods = null, pages = null, sourceChanges = null, report = () => {}, now = () => new Date() }) {
    this.native = native;
    this.methods = methods; this.wiki = pages; this.sourceChanges = sourceChanges; this.report = report; this.now = now;
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
      // The knowledge pages that quote a document of this project carrying the same DOI; a position with no project names none.
      if (projectId !== "-") await this.pages(ownerId, projectId, { id: doi, doi }, status);
      if (found.items?.length) items.push({ identifier: fact.identifier, memories: found.items });
    }
    return { items, cursor: page.cursor, hasMore: page.hasMore };
  }

  /**
   * Label the memory files that name a source with what a check found, and list the ones this project may be shown.
   * @param {string} ownerId @param {string} projectId @param {{ id: string, doi?: string }} ref
   * @param {{ state: string, reason?: string, updates?: any[] }} checked the source update status (`statusProjection`)
   * @returns {Promise<{ items?: any[], total?: number, unknown?: string }>}
   */
  async memories(ownerId, projectId, ref, checked) {
    const link = memoryLinkOf(ref);
    if (!link) return { items: [], total: 0 };
    if (!this.native) return { unknown: "unavailable" };
    try {
      // The memory files that name the source gain (or lose) the label line, and the ones this project may be shown are listed.
      await this.native.labelSource(ownerId, link, linkStateOf(checked));
      const shown = (await this.native.dependentsOfSource(ownerId, link)).filter(listedIn(projectId));
      return { total: shown.length, items: shown.map((/** @type {any} */ row) => ({ recordId: row.recordId, scope: row.scope, kind: row.kind, state: row.state })) };
    } catch (error) {
      this.report(codeOf(error));
      return { unknown: "lookup_failed" };
    }
  }

  /**
   * The knowledge pages that quote a source, labelled with what a check found and queued for a recompile. A label and a queue
   * entry, never a verdict: no page is hidden, withheld or rewritten here, and a check that could not answer changes nothing.
   * Found by the recorded document id only — a knowledge-base document by its `src_` id, a published work by the DOI the
   * project's documents carry.
   * @param {string} ownerId @param {string} projectId @param {{ id: string, doi?: string }} ref
   * @param {{ state: string, reason?: string, updates?: any[] }} checked
   * @returns {Promise<{ total?: number, items?: any[], unknown?: string }>}
   */
  async pages(ownerId, projectId, ref, checked) {
    if (!this.wiki?.enabled) return { unknown: "unavailable" };
    const state = linkStateOf(checked);
    if (state !== "changed" && state !== "retracted") return { items: [], total: 0 };
    try {
      const ids = new Set(/^src_[a-f0-9]{32}$/.test(String(ref?.id)) ? [String(ref.id)] : []);
      const doi = doiOf(ref?.doi ?? ref?.id);
      if (doi) for (const id of await this.wiki.sourceIdsByDoi(ownerId, projectId, doi)) ids.add(id);
      if (!ids.size) return { items: [], total: 0 };
      await this.wiki.noteSourcesChanged(ownerId, projectId, [...ids].map((sourceId) => ({ sourceId, reason: state })));
      /** @type {any[]} */
      const items = [];
      for (const sourceId of ids) items.push(...await this.wiki.pagesQuoting(ownerId, projectId, sourceId));
      return { total: items.length, items };
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
    let found;
    try { found = await this.#methodsLinked(ownerId, versionIds); }
    catch (error) {
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

  /**
   * The learned methods linked to result versions, found by the version identities their records name.
   * @param {string} ownerId @param {readonly string[]} versionIds
   * @returns {Promise<Map<string, any>>} by method id
   */
  async #methodsLinked(ownerId, versionIds) {
    /** @type {Map<string, any>} */
    const found = new Map();
    for (const versionId of [...new Set(versionIds)].slice(0, MAX_VERSIONS)) {
      for (const document of await this.methods.methodsLinkedTo(ownerId, versionId)) {
        if (found.has(document.id)) continue;
        const learnt = (document.payload?.provenance?.results ?? []).some((/** @type {any} */ entry) => entry?.versionId === versionId);
        found.set(document.id, { id: document.id, title: methodLabel(document), versionId, relation: learnt ? "learnt_from" : "used_for" });
      }
    }
    return found;
  }

  /**
   * What rests on a source, read and nothing else: the memories that name it and the learned methods linked to the result
   * versions that rest on it, found by recorded link and labelled by no one. What a document's page lists under
   * 「相关记忆与做法」 — the same two classes `memories` and `methodsFor` label when the source changes, and the same rule for
   * which memories a project's panel lists (`listedIn`). A class that could not be looked up is `{ unknown }`, never an empty
   * list; the page then lists nothing of it and says nothing about it.
   * @param {string} ownerId @param {string} projectId @param {{ id: string, doi?: string }} ref @param {readonly string[]} versionIds
   * @returns {Promise<{ memories: { items?: any[], unknown?: string }, methods: { items?: any[], unknown?: string } }>}
   */
  async dependents(ownerId, projectId, ref, versionIds) {
    return { memories: await this.#readMemories(ownerId, projectId, ref), methods: await this.#readMethods(ownerId, versionIds) };
  }

  /** @param {string} ownerId @param {string} projectId @param {{ id: string, doi?: string }} ref */
  async #readMemories(ownerId, projectId, ref) {
    const link = memoryLinkOf(ref);
    if (!link) return { items: [] };
    if (!this.native) return { unknown: "unavailable" };
    try {
      const rows = (await this.native.dependentsOfSource(ownerId, link)).filter(listedIn(projectId));
      return { items: rows.map((/** @type {any} */ row) => ({ recordId: row.recordId, scope: row.scope, kind: row.kind, state: row.state })) };
    } catch (error) { this.report(codeOf(error)); return { unknown: "lookup_failed" }; }
  }

  /** @param {string} ownerId @param {readonly string[]} versionIds */
  async #readMethods(ownerId, versionIds) {
    if (!this.methods) return { unknown: "unavailable" };
    try { return { items: [...(await this.#methodsLinked(ownerId, versionIds)).values()] }; }
    catch (error) { this.report(codeOf(error)); return { unknown: "lookup_failed" }; }
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
