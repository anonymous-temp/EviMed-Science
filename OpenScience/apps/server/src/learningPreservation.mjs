/**
 * What deleting a project must not take from the learning loop.
 *
 * Hidden knowledge: on 2026-09-23 a project deletion removed a learned method
 * and every one of its revisions, and the lessons still waiting to be learnt
 * from its runs — `documents(user_id, project_id)` and `jobs(user_id,
 * project_id)` both cascade from `projects`, and the method and its jobs were
 * filed under the project they came from (audit 2026-09-26, L-G1). A method
 * is the researcher's, not the project's; methods are now stored at account
 * level (`LearningService.createCandidate`, and the migration of 2026-09-27
 * for the ones already written). This module does the same for the jobs.
 *
 * Inside the deletion's own transaction, before the project row goes:
 *
 *  - every `distill` and `consolidate` job filed under the project moves to
 *    the account's learning project, where the loop's model steps run anyway
 *    (`learningRuntime.dispatch`), and records the project it came from as
 *    `payload.sourceProjectId`;
 *  - for a lesson still waiting, what it needs to be learnt later is copied
 *    beside it — the run's transcript (and a `routine` lesson's peer runs'),
 *    into the learning project's own transcript directory where
 *    `readRunTranscript` reads it, and a small record of the run itself,
 *    which the worker reads when the project's ledger is gone
 *    (`archivedLessonRun`).
 *
 * The copies are written before the rows commit and before the project's
 * directory is removed, so a failure here fails the deletion with everything
 * intact, and the request can be retried. A lesson whose transcript was never
 * captured moves all the same: it fails by name when it runs
 * (`distillation_run_unavailable`), which is a record rather than a silence.
 *
 * @module learningPreservation
 */

import path from "node:path";

import { LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME } from "./internalProjects.mjs";
import { transcriptPath } from "./runTranscripts.mjs";
import { HttpError, readTextFileNoFollow, safeId, writeFileAtomicNoFollow } from "./security.mjs";

/** Where a moved lesson's run record is kept, in the learning project's metadata. */
export const LESSON_RUNS_DIR = "lesson-runs";

/** The job kinds that belong to the learning loop. */
const LEARNING_JOB_KINDS = Object.freeze(["distill", "consolidate"]);

/**
 * The account's learning project, made on first use — the same rule
 * `learningRuntime` applies before its first step.
 * @param {any} store @param {any} user
 */
export async function ensureLearningProject(store, user) {
  try {
    return await store.requireProject(user, LEARNING_PROJECT_ID);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "project_not_found" && /** @type {any} */ (error)?.status !== 404) throw error;
    await store.createProject(user, LEARNING_PROJECT_ID, LEARNING_PROJECT_NAME);
    return store.requireProject(user, LEARNING_PROJECT_ID);
  }
}

/** @param {{metaDir: string}} learningProject @param {string} runId */
function lessonRunPath(learningProject, runId) {
  return path.join(learningProject.metaDir, LESSON_RUNS_DIR, `${safeId(runId, "run id")}.json`);
}

/**
 * The part of a run a distillation reads, and nothing more: the ledger row
 * also carries the question, artifacts and receipts, and none of it is needed
 * to learn from the transcript.
 * @param {any} run
 */
function lessonRunRecord(run) {
  return {
    id: String(run.id),
    sessionId: run.sessionId ?? null,
    status: run.status ?? null,
    effectiveAgentId: run.effectiveAgentId ?? null,
    effectiveAgentVersion: run.effectiveAgentVersion ?? null,
    dispatchId: run.dispatchId ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    transcript: run.transcript ? { completeness: run.transcript.completeness ?? null } : null,
  };
}

/**
 * Move a project's learning jobs to the learning project, keeping what the
 * waiting ones need. Idempotent: a copy already made is not made again, and a
 * job already moved is no longer the project's.
 *
 * @param {{client: any, userId: string, project: any, learningProject: any, runs?: readonly any[]}} input
 *   `client` is the deletion's transaction; `runs` is the project's ledger.
 * @returns {Promise<{moved: number, preserved: string[]}>} jobs moved, and the runs whose inputs were kept
 */
export async function preserveProjectLessons({ client, userId, project, learningProject, runs = [] }) {
  if (!client || !learningProject || String(project?.id) === LEARNING_PROJECT_ID) return { moved: 0, preserved: [] };
  if (String(learningProject.id) !== LEARNING_PROJECT_ID) {
    throw new HttpError(500, "learning_project_invalid", "Lessons move only to the account's learning project.");
  }
  const jobs = await client.query(`SELECT id,kind,status,payload FROM evimed_product.jobs
    WHERE user_id=$1 AND project_id=$2 AND kind=ANY($3::text[]) FOR UPDATE`, [userId, project.id, [...LEARNING_JOB_KINDS]]);
  const byId = new Map((runs ?? []).map((run) => [String(run?.id ?? ""), run]));
  /** @type {Set<string>} */
  const preserved = new Set();
  for (const job of jobs.rows) {
    if (job.kind !== "distill" || !["queued", "running"].includes(job.status)) continue;
    const runIds = [job.payload?.runId, ...(Array.isArray(job.payload?.peerRunIds) ? job.payload.peerRunIds : [])]
      .filter((value) => typeof value === "string" && value);
    for (const runId of runIds) {
      if (preserved.has(runId)) continue;
      let target;
      try { target = transcriptPath(learningProject, runId); } catch { continue; }
      const text = await readTextFileNoFollow(project.rootDir, transcriptPath(project, runId), "");
      if (text && !await readTextFileNoFollow(learningProject.rootDir, target, "")) {
        await writeFileAtomicNoFollow(learningProject.rootDir, target, text, { encoding: "utf8", mode: 0o600 });
      }
      const run = byId.get(runId);
      if (run) {
        await writeFileAtomicNoFollow(learningProject.rootDir, lessonRunPath(learningProject, runId),
          `${JSON.stringify(lessonRunRecord(run))}\n`, { encoding: "utf8", mode: 0o600 });
      }
      preserved.add(runId);
    }
  }
  const moved = await client.query(`UPDATE evimed_product.jobs
    SET project_id=$3, payload=payload || jsonb_build_object('sourceProjectId', coalesce(payload->>'sourceProjectId', $2::text)),
        updated_at=clock_timestamp()
    WHERE user_id=$1 AND project_id=$2 AND kind=ANY($4::text[])`, [userId, project.id, LEARNING_PROJECT_ID, [...LEARNING_JOB_KINDS]]);
  return { moved: Number(moved.rowCount ?? 0), preserved: [...preserved] };
}

/**
 * The run a moved lesson was queued for, read from the copy kept when its
 * project was deleted; null when there is none.
 * @param {any} learningProject @param {string} runId
 */
export async function archivedLessonRun(learningProject, runId) {
  if (!learningProject || !runId) return null;
  let file;
  try { file = lessonRunPath(learningProject, String(runId)); } catch { return null; }
  const text = await readTextFileNoFollow(learningProject.rootDir, file, "");
  if (!text) return null;
  try {
    const record = JSON.parse(text);
    return record && record.id === String(runId) ? record : null;
  } catch {
    return null;
  }
}
