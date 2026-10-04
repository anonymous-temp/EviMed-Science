/**
 * A correction, recorded where the learning loop and the result view can both read it (plan 2026-10-02 §11.3 N12).
 *
 * The researcher selects something in a delivered result and says in the native composer what to change; the run
 * writes the revised form beside the original (`resultRevision.mjs`). Until now that act left two linked immutable
 * versions and nothing else: no feedback, nothing for distillation, nothing the result view could say about what the
 * correction changed. This service is the missing producer, and it adds no store: the pair is written into the existing
 * feedback ledger (`result-corrected`, `feedbackEvents.mjs`), and what the run left is written into the existing
 * `result-revision` record the selection already is.
 *
 * Two moments:
 *
 * - **A successor is captured** (`capture`, called by the result store when a captured file is the selected output in its
 *   revised form). The pair of versions is immutable the moment it exists, so the event is written then, once per pair
 *   however often the capture replays. What it says about the two — which numbers moved, which sources, which claims — is
 *   decided from their bytes (`correctionEffects`), never from the researcher's instruction.
 * - **The run ends** (`settle`, from the run-finished hook, after the run's files and bindings are captured). The
 *   revision record gets what the run actually left: the successor it ended on, each other output (a Word or PDF the run
 *   wrote is a rendering, and its consistency with the successor is `not_checked`: nothing here reads a binary), the
 *   calculations whose recomputed values the successor prints (read from value bindings, N06), and what the run was told
 *   the change could reach. The lesson the correction is evidence for is queued here, once, for the successor the run
 *   ended on rather than for each draft along the way.
 *
 * Hidden knowledge:
 *
 * - **Nothing here is an adoption.** The researcher's words are theirs and the successor is the platform run's; the event
 *   says so (`successorOrigin: "system_generated"`, `adoption: "not_recorded"`) and no `deliverable-adopted` is ever
 *   written for it. Asking for a change is not approving what came back.
 * - **A label, never a gate.** A comparison that cannot be made is `unknown`, a ledger that cannot be written is audited
 *   by code and the version stays as captured, and nothing here asks anyone to confirm anything.
 * - **The run that is learnt from is the one whose work was corrected.** The distillation reads the original's run (its
 *   transcript, and through the availability records the method digest it used); only an original with no run falls back
 *   to the run that made the successor.
 */
import { bindableKind, correctionCalculations, correctionEffects, projectCorrectionOutcome, projectResultCorrection, renderingFormat } from "@evimed/domain";

/** The largest version either side of a comparison is read for: past it the comparison is `unknown`, not a megabyte of diff. */
const TEXT_LIMIT = 2 * 1024 * 1024;
/** The run's own versions are read a page at a time, to a bound. */
const OUTPUT_PAGES = 5;

/** @param {any} error @returns {string} a bounded error code */
const codeOf = (error) => (typeof error?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(error.code) ? error.code : "result_correction_failed");

export class ResultCorrectionService {
  /**
   * @param {{ results: any, documents: any, feedback?: any, runs?: any, learning?: (() => any) | null,
   *   report?: (code: string) => void, now?: () => Date }} dependencies
   *   `learning`: answers the learning triggers when this deployment has them (`LearningTriggers.afterCorrection`).
   */
  constructor({ results, documents, feedback = null, runs = null, learning = null, report = () => {}, now = () => new Date() }) {
    this.results = results; this.documents = documents; this.feedback = feedback; this.runs = runs; this.learning = learning;
    this.report = report; this.now = now;
  }

  /** The decoded bytes of a version, or null when they are not text, are too large, may not be read or cannot be read.
   * @param {string} userId @param {any} project @param {any} version */
  async #text(userId, project, version) {
    if (version.size > TEXT_LIMIT) return null;
    if (bindableKind(version.path, version.mimeType) === "binary" && !String(version.mimeType).startsWith("text/")) return null;
    try {
      const { bytes } = await this.results.raw(userId, project.id, version.versionId);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch { return null; }
  }

  /** @param {any} project @param {string | null | undefined} runId */
  async #run(project, runId) {
    if (!this.runs || !runId) return null;
    try { return (await this.runs.list(project)).find((/** @type {any} */ row) => row?.id === runId) ?? null; } catch { return null; }
  }

  /**
   * The event for one (original, successor) pair, idempotent by the pair. The result store calls this when a successor to a
   * revision's selection is captured.
   * @param {{ userId: string, project: any, successor: any, correction: any }} input
   * @returns {Promise<{ event: any, created: boolean } | null>}
   */
  async capture({ userId, project, successor, correction }) {
    if (!this.feedback || !successor?.supersedesVersionId) return null;
    try {
      const original = await this.results.get(userId, project.id, successor.supersedesVersionId);
      const [beforeText, afterText] = await Promise.all([this.#text(userId, project, original), this.#text(userId, project, successor)]);
      const { kind, effects } = correctionEffects({ before: original, after: successor, beforeText, afterText });
      const originalRunId = original.producer?.runId ?? null;
      const originalRun = await this.#run(project, originalRunId);
      return await this.feedback.recordResultCorrection(project.userId, {
        projectId: project.id, runId: originalRunId, occurredAt: this.now(),
        correction: { revisionId: correction.revisionId, original, successor, kind, effects, anchor: correction.anchor,
          instruction: correction.instruction, instructionDigest: correction.instructionDigest,
          capabilityId: originalRun?.effectiveAgentId ?? null, originalRunId, revisionRunId: correction.runId ?? successor.producer?.runId ?? null,
          originalMethod: original.method },
      });
    } catch (error) { this.report(codeOf(error)); return null; }
  }

  /** Every version a run captured under one directory, newest first, to a bound.
   * @param {string} userId @param {string} projectId @param {string} runId @param {string} directory */
  async #outputs(userId, projectId, runId, directory) {
    /** @type {any[]} */
    const found = [];
    let cursor = null;
    for (let page = 0; page < OUTPUT_PAGES; page += 1) {
      const result = await this.results.list(userId, { projectId, runId, limit: 100, cursor });
      found.push(...result.items.filter((/** @type {any} */ version) => version.path.startsWith(`${directory}/`)));
      cursor = result.nextCursor ?? null;
      if (!cursor) break;
    }
    return found;
  }

  /**
   * At the end of a run: record what each revision it answered actually left, and queue the lesson the correction is
   * evidence for. A revision already settled is left as it is.
   * @param {any} project @param {any} run the run's ledger record
   */
  async settle(project, run) {
    if (!run?.id || !run.sessionId) return { settled: 0 };
    let settled = 0;
    const page = await this.documents.list(project.userId, "result-revision", { projectId: project.id, limit: 50,
      filter: { recordType: "result-revision", state: "bound", sessionId: run.sessionId } });
    for (const row of page.items) {
      const staged = row.payload;
      if (!(run.kernelRequestIds ?? []).includes(staged.promptRequestId) || staged.outcome?.settledAt) continue;
      try { await this.#settleOne(project, run, row); settled += 1; } catch (error) { this.report(codeOf(error)); }
    }
    return { settled };
  }

  /** @param {any} project @param {any} run @param {any} row */
  async #settleOne(project, run, row) {
    const staged = row.payload;
    const actor = staged.requestedBy;
    const original = await this.results.get(actor, project.id, staged.versionId);
    const directory = `artifacts/result-revisions/${staged.id}/output`;
    const outputs = await this.#outputs(actor, project.id, run.id, directory);
    const successors = outputs.filter((version) => version.supersedesVersionId === original.versionId)
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
    const final = successors[0] ?? null;
    /** @type {Record<string, any>} */
    let outcome = { status: "no_successor", successorVersionId: null, outputs: [], calculations: [], reach: staged.reach };
    if (final) {
      // The event of the pair the run ended on, written again in case its capture-time record could not be.
      const recorded = await this.capture({ userId: actor, project, successor: final,
        correction: { revisionId: staged.id, anchor: staged.anchor, instruction: staged.instruction, instructionDigest: staged.instructionDigest, runId: run.id } });
      if (recorded?.event && run.status === "succeeded") await this.#lesson(project, run, original, recorded.event);
      outcome = {
        status: "settled", successorVersionId: final.versionId, calculations: correctionCalculations(original, final), reach: staged.reach,
        outputs: outputs.map((version) => {
          const format = renderingFormat(version.path);
          return { versionId: version.versionId, path: version.path, role: version.versionId === final.versionId ? "successor" : format ? "rendering" : "other", format };
        }),
      };
    }
    const settled = projectCorrectionOutcome({ ...outcome, settledAt: this.now().toISOString() });
    await this.documents.put(project.userId, "result-revision", staged.id, { ...staged, outcome: settled },
      { projectId: project.id, expectedRevision: row.revision });
  }

  /** @param {any} project @param {any} run @param {any} original @param {any} event */
  async #lesson(project, run, original, event) {
    const triggers = this.learning?.();
    if (!triggers?.afterCorrection) return;
    try { await triggers.afterCorrection(project, { event, runId: original.producer?.runId ?? run.id }); }
    catch (error) { this.report(codeOf(error)); }
  }

  /**
   * What the researcher's corrections of one version, or of which it is the successor, were and left: the answer of the
   * result view. The version must be one the caller may read; events of another project are not returned.
   * @param {string} userId @param {string} projectId @param {string} versionId
   */
  async read(userId, projectId, versionId) {
    const version = await this.results.get(userId, projectId, versionId);
    const project = await this.results.scope(userId, projectId);
    if (!this.feedback) return { versionId: version.versionId, items: [] };
    const events = await this.feedback.listResultCorrections(project.userId, version.versionId);
    const items = [];
    for (const event of events) {
      if (event.projectId !== project.id) continue;
      let record;
      try { record = projectResultCorrection(event.detail); } catch { continue; }
      let outcome = null;
      if (record.revisionId) {
        const row = await this.documents.get(project.userId, "result-revision", record.revisionId).catch(() => null);
        if (row?.projectId === project.id && row.payload?.outcome) outcome = projectCorrectionOutcome(row.payload.outcome);
      }
      items.push({ id: event.id, occurredAt: event.occurredAt, role: record.original.versionId === version.versionId ? "original" : "successor", correction: record, outcome });
    }
    return { versionId: version.versionId, items };
  }
}
