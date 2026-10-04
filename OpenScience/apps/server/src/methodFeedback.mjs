/**
 * What later became of a result, joined to the method that was read to produce it (plan 2026-10-02 §11.3 N14).
 *
 * Three things happen to a delivered result after the run that produced it is over, and the platform observes each of
 * them for itself: a trusted recalculation of its recipe reproduces its numbers or does not (`ResultReplayService`, N06),
 * the researcher corrects it through the anchored revision (`ResultCorrectionService`, N12), and the engine's own
 * diagnostics say whether the method's conditions held for its data. This is the module that carries each of them to
 * the record of the method the producing run read, under the revision it read, so that the method's lifecycle
 * (`retirementProposal`) can read two axes and not one: whether the deliveries were accepted, and what became of the
 * results.
 *
 * Hidden knowledge:
 *
 * - **No second record.** The facts are already ledgered: the correction pair is a `result-corrected` feedback event, the
 *   replay is a `result-replay` document, the run's ledger names the methods it read. What is written here is the join —
 *   an entry on the method's own record (`payload.scientific`) naming the result version, the run, the digest of the
 *   revision and the source of the signal by their identifiers — and nothing that could be reconstructed from them.
 * - **Joined by what the run read, never by what was mounted.** `methodsInvoked` is the set of learned methods the run
 *   opened (`methodObservations.mjs`); `methodsLoaded` also holds the ones it passed over. A method that was in the
 *   room and unread is not evidence of anything and is charged with nothing, which is what keeps a later task the
 *   method was never relevant to from adding to — or taking from — its record. The digest the ledger holds is the
 *   mounted file's, so it is resolved to the revision of the method that file was (`revisionByMountedDigest`); a file no
 *   revision of the method ever was is not recorded under a guess.
 * - **The successor is not evidence.** A correction's successor is something the platform's run generated and nobody
 *   approved (`successorOrigin: "system_generated"`). It is kept as the second half of the pair on the entry; the
 *   signal is about the ORIGINAL, and the methods the revision run read earn nothing from it.
 * - **A label, never a gate.** A feedback that cannot be joined (the run left no ledger record, the method was deleted,
 *   a file matched no revision) is skipped with its reason and the result, the correction and the replay stand as they
 *   were. What the join may cause — returning a method to an earlier body, or stopping it — is the lifecycle's answer to
 *   a demonstrated regression of a revision (`scientificRegression`), is immediate only for a method the system
 *   inferred, and is undone by restoring a revision.
 * - **Learning's own switches apply.** The researcher's 「停止学习」, someone else's capsule being tried, the platform's
 *   own automated work and a learning evaluation are not the researcher's learning, and nothing is written for them.
 *
 * @module methodFeedback
 */
import { createHash } from "node:crypto";
import {
  feedbackSignalFromCorrection, feedbackSignalFromReplay, foldMethodFeedback, isResearcherOwnedWork, methodScientific,
  projectResultCorrection, retirementProposal,
} from "@evimed/domain";
import { CAPABILITY_HANDBOOK_RECORD_TYPE } from "./handbookConsolidation.mjs";
import { isInternalProject } from "./internalProjects.mjs";
import { learnedMethodId, methodRecordFrom, methodScopeOf } from "./learningService.mjs";
import { retirementSentence } from "./methodConsolidation.mjs";

/** How many methods and handbooks one run is joined to; a run reads a handful, and a count is never a ledger. */
const MAX_USED = 16;
/** How often a write that lost a race to another telemetry write is tried again. */
const WRITE_ATTEMPTS = 6;

/** @param {any} error @returns {string} a bounded error code */
const codeOf = (error) => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "method_feedback_failed");

/** @param {unknown[]} parts @returns {string} */
const identity = (parts) => `sf_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;

export class MethodFeedbackService {
  /**
   * `runs` lists one project's run ledger. `enabled` answers whether this run's learning is on for its owner (the
   * researcher's own switch, a capsule trial); absent, it is.
   * @param {{ learning: any, runs: { list: (project: any) => Promise<any[]> },
   *   enabled?: ((project: any, run: any) => Promise<boolean>) | null, report?: (code: string) => void, now?: () => Date }} dependencies
   */
  constructor({ learning, runs, enabled = null, report = () => {}, now = () => new Date() }) {
    if (!learning || !runs) throw new TypeError("Method feedback needs the method ledger and the run ledger.");
    this.learning = learning; this.runs = runs; this.enabled = enabled; this.report = report; this.now = now;
  }

  /** @param {any} project @param {string} runId */
  async #run(project, runId) {
    try { return (await this.runs.list(project)).find((/** @type {any} */ row) => row?.id === runId) ?? null; } catch { return null; }
  }

  /**
   * What one run read, resolved to the revisions of the methods it read: the learned methods it invoked (the platform's
   * own trial candidates excepted, which are an evaluation's and not the researcher's), the handbooks it used, the
   * learned methods it was given and passed over, and what could not be resolved with the reason. Nothing is guessed:
   * a name that is no method of this account, or a file no revision was, is listed as unresolved.
   * @param {any} project @param {any} run
   * @returns {Promise<{ methods: { id: string, name: string, status: string, digest: string, current: boolean, document: any }[],
   *   handbooks: { id: string, capabilityId: string, digest: string }[], passedOver: { id: string, name: string }[],
   *   unresolved: { name: string, reason: string }[] }>}
   */
  async usedBy(project, run) {
    const userId = project.userId;
    /** @type {Awaited<ReturnType<MethodFeedbackService["usedBy"]>>} */
    const used = { methods: [], handbooks: [], passedOver: [], unresolved: [] };
    const invoked = (Array.isArray(run?.methodsInvoked) ? run.methodsInvoked : []).filter((/** @type {any} */ entry) => entry?.name && entry?.digest && !entry.trial);
    for (const entry of invoked.slice(0, MAX_USED)) {
      const id = learnedMethodId(String(entry.name));
      const document = await this.learning.getMethod(userId, id).catch(() => null);
      if (!document) { used.unresolved.push({ name: String(entry.name), reason: "method_unavailable" }); continue; }
      const revision = await this.learning.revisionByMountedDigest(userId, id, String(entry.digest)).catch(() => null);
      if (!revision) { used.unresolved.push({ name: String(entry.name), reason: "revision_unknown" }); continue; }
      used.methods.push({ id, name: String(entry.name), status: String(document.payload.status ?? ""), digest: revision.contentDigest, current: revision.current, document });
    }
    const invokedNames = new Set(invoked.map((/** @type {any} */ entry) => String(entry.name)));
    for (const entry of (Array.isArray(run?.methodsLoaded) ? run.methodsLoaded : []).slice(0, MAX_USED)) {
      if (entry?.name && !entry.trial && !invokedNames.has(String(entry.name))) used.passedOver.push({ id: learnedMethodId(String(entry.name)), name: String(entry.name) });
    }
    for (const mounted of (Array.isArray(run?.capabilityHandbooks) ? run.capabilityHandbooks : []).slice(0, MAX_USED)) {
      if (mounted?.ownerId !== userId || !mounted.id || !mounted.contentDigest) continue;
      const row = await this.learning.documents.get(userId, "method", mounted.id).catch(() => null);
      // Used, not attached: the run's own observation says whether the model opened it (`recordHandbookRunObservations`).
      const read = row?.payload?.recordType === CAPABILITY_HANDBOOK_RECORD_TYPE
        && (row.payload.observations ?? []).some((/** @type {any} */ item) => item?.runId === run.id && item.used === true && item.contentDigest === mounted.contentDigest);
      if (read) used.handbooks.push({ id: String(mounted.id), capabilityId: String(mounted.capabilityId ?? ""), digest: String(mounted.contentDigest) });
    }
    return used;
  }

  /**
   * What a lesson about one run is shown of the methods that run read: each by identity, revision and standing, with
   * what became of the results produced under that revision and the scope it declared, and the ones it passed over.
   * Bounded, and never the body (the related methods carry that).
   * @param {any} project @param {any} run
   */
  async usedForLesson(project, run) {
    const used = await this.usedBy(project, run);
    return {
      invoked: used.methods.map((method) => ({
        id: method.id, name: method.name, status: method.status, digest: method.digest, current: method.current,
        scientific: methodScientific(method.document.payload.scientific, method.digest),
        ...(methodScopeOf(method.document.payload) ? { scope: methodScopeOf(method.document.payload) } : {}),
      })),
      handbooks: used.handbooks,
      passedOver: used.passedOver,
      unresolved: used.unresolved,
    };
  }

  /**
   * The researcher's own learning is on for this run, and the run is theirs: not the platform's automated work, not a
   * learning evaluation, not an internal project's.
   * @param {any} project @param {any} run
   */
  async #learnable(project, run) {
    if (isInternalProject(project.id) || run?.learningEvaluation || !isResearcherOwnedWork(run)) return false;
    return this.enabled ? Boolean(await this.enabled(project, run).catch(() => false)) : true;
  }

  /**
   * One signal, written to everything the producing run read.
   * @param {any} project @param {any} run
   * @param {{ signal: string, at: string, result: { versionId: string, digest: string }, successor?: any, replay?: any, event?: any,
   *   kind?: string | null, applicability?: any }} source
   */
  async #record(project, run, source) {
    const userId = project.userId;
    const used = await this.usedBy(project, run);
    /** @type {{ kind: "method" | "handbook", id: string, digest: string, added: boolean, acted?: string }[]} */
    const recorded = [];
    const base = (/** @type {string} */ digest) => ({
      id: identity([source.signal, digest, source.result.versionId, source.successor?.versionId ?? "", source.replay?.id ?? "", source.event?.id ?? ""]),
      signal: source.signal, at: source.at, digest, used: "invoked", runId: run.id,
      result: source.result, successor: source.successor ?? null, replay: source.replay ?? null, event: source.event ?? null,
      kind: source.kind ?? null, applicability: source.applicability ?? { state: "unknown" },
    });
    for (const method of used.methods) {
      try {
        const { document, added } = await this.learning.recordScientific(userId, method.id, base(method.digest));
        /** @type {{ kind: "method", id: string, digest: string, added: boolean, acted?: string }} */
        const item = { kind: "method", id: method.id, digest: method.digest, added };
        if (added) item.acted = (await this.#act(userId, document)) ?? undefined;
        recorded.push(item);
      } catch (error) { this.report(codeOf(error)); }
    }
    for (const handbook of used.handbooks) {
      try { recorded.push({ kind: "handbook", id: handbook.id, digest: handbook.digest, added: await this.#recordHandbook(userId, handbook, base(handbook.digest)) }); }
      catch (error) { this.report(codeOf(error)); }
    }
    return { recorded, unresolved: used.unresolved, skipped: recorded.length || used.unresolved.length ? null : "no_method_read" };
  }

  /**
   * A handbook is versioned by replacement, not by amendment (`HandbookConsolidation`), so an entry is recorded only
   * against the version that is current; a handbook replaced since the run read it carries nothing from it.
   * @param {string} userId @param {{ id: string, digest: string }} handbook @param {any} entry
   */
  async #recordHandbook(userId, handbook, entry) {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const row = await this.learning.documents.get(userId, "method", handbook.id);
      if (row?.payload?.recordType !== CAPABILITY_HANDBOOK_RECORD_TYPE || row.payload.contentDigest !== handbook.digest) return false;
      const scientific = foldMethodFeedback(row.payload.scientific, entry);
      if (scientific === row.payload.scientific) return false;
      try {
        await this.learning.documents.put(userId, "method", row.id, { ...row.payload, scientific }, { expectedRevision: row.revision, telemetry: true });
        return true;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "product_revision_conflict" || attempt === WRITE_ATTEMPTS - 1) throw error;
      }
    }
    return false;
  }

  /**
   * What the lifecycle now says about a method an entry was just added to: when the results produced under the revision
   * it holds show a regression, return it to the exact earlier body or stop it. Only that clause is acted on here; every
   * other retirement reason is the nightly pass's, with the delivery axis's own evidence.
   * @param {string} userId @param {any} document
   * @returns {Promise<string | null>} what was done, or null
   */
  async #act(userId, document) {
    if (document.payload?.status !== "approved") return null;
    try {
      const revisions = (await this.learning.history(userId, document.id)).map((/** @type {any} */ version) => version.contentDigest);
      const proposal = retirementProposal(methodRecordFrom(document, { revisions }), { nowMs: this.now().getTime() });
      if (!proposal.propose || !proposal.immediate || proposal.code !== "scientific_regression") return null;
      return (await this.learning.applyRegression(userId, document, proposal, { retire: retirementSentence(proposal) })).action;
    } catch (error) { this.report(codeOf(error)); return null; }
  }

  /**
   * A correction (`result-corrected`) of a result the run produced, carried to the methods the run read. The signal is
   * what the two versions' bytes showed changed, never what the researcher said, and it is about the original: the
   * successor is kept beside it as the other half of the pair and is not evidence.
   * @param {any} project @param {any} event the feedback ledger's event
   */
  async fromCorrection(project, event) {
    let correction;
    try { correction = projectResultCorrection(event?.detail); } catch { return { recorded: [], unresolved: [], skipped: "correction_unreadable" }; }
    const runId = correction.originalRunId ?? event?.runId ?? null;
    if (!runId) return { recorded: [], unresolved: [], skipped: "run_unknown" };
    const run = await this.#run(project, runId);
    if (!run) return { recorded: [], unresolved: [], skipped: "run_unavailable" };
    if (!await this.#learnable(project, run)) return { recorded: [], unresolved: [], skipped: "not_learnable" };
    return this.#record(project, run, {
      signal: feedbackSignalFromCorrection(correction),
      at: typeof event.occurredAt === "string" ? event.occurredAt : this.now().toISOString(),
      result: { versionId: correction.original.versionId, digest: correction.original.digest },
      successor: { versionId: correction.successor.versionId, digest: correction.successor.digest },
      event: { id: String(event.id) }, kind: correction.kind,
    });
  }

  /**
   * A recalculation of a result the run produced, carried to the methods the run read: when it ran on what the original
   * ran on, whether its numbers agreed; with what the engine's own diagnostics said about the data. A replay on another
   * engine, or one whose numbers were not compared, is not recorded (`feedbackSignalFromReplay` says why).
   * @param {{ project: any, original: any, replayId: string, output: any, comparison: any, applicability?: any }} input
   */
  async fromReplay({ project, original, replayId, output, comparison, applicability = undefined }) {
    const decided = feedbackSignalFromReplay(comparison);
    if (!decided.signal) return { recorded: [], unresolved: [], skipped: decided.reason };
    const runId = original?.producer?.runId ?? null;
    if (!runId) return { recorded: [], unresolved: [], skipped: "run_unknown" };
    const run = await this.#run(project, runId);
    if (!run) return { recorded: [], unresolved: [], skipped: "run_unavailable" };
    if (!await this.#learnable(project, run)) return { recorded: [], unresolved: [], skipped: "not_learnable" };
    return this.#record(project, run, {
      signal: decided.signal, at: this.now().toISOString(),
      result: { versionId: original.versionId, digest: original.digest },
      replay: { id: replayId, outputVersionId: output?.versionId ?? null, numbers: decided.numbers }, applicability,
    });
  }
}
