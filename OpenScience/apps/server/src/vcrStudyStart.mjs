import { createHash } from "node:crypto";
import { HttpError } from "./security.mjs";

/** Stable request identity excludes the editable brief; the fingerprint includes its exact bytes.
 * @param {any} study @param {string} sessionId @param {any} input @param {string} actor */
export function vcrStartIdentity(study, sessionId, input, actor) {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    dispatchId: `vcr-start-${hash([study.id, input.requestId]).slice(0, 48)}`,
    dispatchFingerprint: hash({ studyId: study.id, sessionId, brief: input.brief, name: input.name ?? null,
      action: input.action ?? "definition", actor }),
  };
}

/** Starts submit once into the canonical conversation. Known busy sessions are refused; native concurrent input follows DSH queue semantics.
 * @param {any} dependencies */
export function createVcrStudyStart({ conversations, runs, projectFor, inbox, orchestrator, save, dispatch }) {
  return async (user, study, input) => {
    if (study.purpose === "calculation") throw new HttpError(409, "vcr_calculation_research_required", "Create a research study to start research from this calculation.");
    if (!["active", "draft"].includes(study.status)) throw new HttpError(409, "vcr_study_paused", "This study is paused.");
    const project = await projectFor(study);
    const conversation = await conversations(study);
    if (!conversation?.exists || !conversation.sessionId) throw new HttpError(503, "vcr_conversation_unavailable", "The study conversation is unavailable. Please retry.");
    const sessionId = conversation.sessionId;
    const identity = vcrStartIdentity(study, sessionId, input, String(user.id));
    const existing = (await runs.list(project)).find(run => run.dispatchId === identity.dispatchId);
    const answer = async run => ({ studyId: study.id, sessionId: run.sessionId, runId: run.id,
      status: run.status, dispatchStatus: run.dispatchStatus, errorCode: run.errorCode ?? null,
      state: await orchestrator().intakeStatus(study.id, run) });
    if (existing) {
      if (existing.sessionId !== sessionId || existing.dispatchFingerprint !== identity.dispatchFingerprint) {
        throw new HttpError(409, "agent_run_dispatch_conflict", "This request id already belongs to another research request.");
      }
      const known = await runs.existingDispatch(project, existing);
      await orchestrator().recoverIntake(study, known);
      return answer(known);
    }
    const state = await inbox(project, sessionId);
    if (!state || state.running !== false || state.queued !== 0) throw new HttpError(409, "vcr_conversation_busy", "The study conversation is busy. Retry when it finishes.");
    /** @type {any} */
    let intake = null;
    try {
      const run = await dispatch(user, project, sessionId, identity.dispatchId, input.brief, {
        dispatchFingerprint: identity.dispatchFingerprint,
        beforeReserve: async () => { intake = await orchestrator().claimIntake(study, { ...identity, sessionId, action: input.action ?? "definition" }); },
        beforeSend: reservedRun => intake.bind(reservedRun),
        beforePrompt: () => save(user, study, input),
        systemSupplement: "The user explicitly started research with the original brief below. Establish the study definition from the supplied information; ask focused questions for missing essentials. Save a structured definition only when justified. Explain the next steps requested by the user. Do not launch an additional definition run or assume a seven-step programme was requested.",
      });
      await intake.bind(run);
      return answer(run);
    } catch (error) {
      // A reserved run can be accepted despite a lost response. Its existing dispatch remains the authority.
      const run = (await runs.list(project)).find(item => item.dispatchId === identity.dispatchId);
      if (run) {
        if (run.sessionId !== sessionId || run.dispatchFingerprint !== identity.dispatchFingerprint) {
          throw new HttpError(409, "agent_run_dispatch_conflict", "This request id already belongs to another research request.");
        }
        if (intake) await intake.bind(run);
        else await orchestrator().recoverIntake(study, run);
        return answer(run);
      }
      if (intake) await intake.release(error?.code ?? "vcr_unavailable");
      throw error;
    }
  };
}
