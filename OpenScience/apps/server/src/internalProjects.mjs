/**
 * Projects the platform keeps in an account for its own background work.
 *
 * Hidden knowledge: a bounded run takes its project's runtime, and opening
 * that project answers 423 until the run ends (`assertInteractiveRuntimeAvailable`).
 * The learning loop used to run in the researcher's own project — the one the
 * lesson came from — and once it stopped waiting for the night (2026-09-21) a
 * researcher who asked a follow-up after a delivery found their conversation
 * locked for the minutes a distillation takes. So the loop's runs live in a
 * project of their own, which the researcher never sees, which never takes
 * one of their runtime slots, and which never counts against their projects.
 *
 * Understanding an uploaded document is the same kind of work and lives the
 * same way, in its own project: a knowledge-base upload used to reserve the
 * researcher's project runtime, stop their conversation's container to start
 * one on a subdirectory the runtime controller never mounts, and fail every
 * upload after locking the project (2026-09-21, reproduced live).
 *
 * The paired evaluation creates its own project through the public API
 * (`evals/method-quality/configs/*.json`, `eval-method-*`); it is the platform
 * measuring itself and is hidden the same way.
 *
 * @module internalProjects
 */

import { PLATFORM_PUBLISHER_USER_ID } from "@evimed/domain";
import { HttpError } from "./security.mjs";

/** Where the learning loop's own runs happen, one per account. */
export const EVOLUTION_PROJECT_ID = "evimed-evolution";
export const EVOLUTION_PROJECT_NAME = "EviMed 循证进化";

export const LEARNING_PROJECT_ID = "evimed-learning";

/** What the project is called where an operator lists everything. */
export const LEARNING_PROJECT_NAME = "EviMed 学习";

/** Where the understanding runs of uploaded documents happen, one per account. */
export const SOURCES_PROJECT_ID = "evimed-sources";

/** What that project is called where an operator lists everything. */
export const SOURCES_PROJECT_NAME = "EviMed 资料";

/**
 * Where the frontier feed's model calls are billed (「前沿动态」, plan §7.2):
 * one project, under the first operator account, made when the feed's worker
 * starts. The feed is the platform's own work for every reader at once — no
 * researcher asked for it and none should see it in their spend — and the
 * usage ledger wants a real account and project for every row, so it borrows
 * an operator's, the way the learning loop borrows each researcher's.
 */
export const FRONTIER_PROJECT_ID = "evimed-frontier";

/** What the frontier project is called where an operator lists everything. */
export const FRONTIER_PROJECT_NAME = "EviMed 前沿动态";

/**
 * Where the platform's evidence programme works and bills (evidence-flywheel plan §5.1, B7, 2026-10-05):
 * the topic selector's decisions, the agendas that write the official zones, and — in the account of a
 * researcher who keeps their own zone current — the upkeep of that zone, so the usage ledger has a real
 * account and project to book each model call to (its project reference is a foreign key). The platform's
 * own copy belongs to the publisher account (`ensureEvidenceProject`), never to a person.
 *
 * It is internal by name, for every owner: hidden, outside the account's project ceiling, excluded from
 * learning, memory extraction, 「与你相关」 and capsule export, and a background runtime that waits for room
 * rather than taking a researcher's slot (`backgroundRuntimeLimit`) — the same mechanism the frontier
 * project uses, not a second one.
 */
export const EVIDENCE_PROJECT_ID = "evimed-evidence";

/** What the evidence project is called where an operator lists everything. */
export const EVIDENCE_PROJECT_NAME = "EviMed 证据中心";

/**
 * The paired evaluation's cells, one short-lived project each
 * (`learningEvaluation.mjs`). Missing from this list until 2026-09-21, so
 * while an evaluation ran its 「Private method evaluation」 projects sat in the
 * researcher's project list and held their runtime slots.
 */
const EVALUATION_CELL_PROJECT = /^methodeval-[a-f0-9]{24}$/;

/**
 * The capability acceptance battery (`scripts/ops/capability-acceptance.mjs`,
 * `acceptance-<capability>[-<suffix>]`) and the standing integration audit
 * (`audit-*`) are the platform measuring itself too. They ran as ordinary
 * projects until 2026-09-29, in the account the owner signs in with: they sat
 * in the owner's sidebar after the owner had asked for one demonstration
 * project only (2026-09-23), they filled the account's project ceiling, and
 * every accepted run was read as the researcher's own work — the learning loop
 * distilled methods from them (two of which then taught every later run to
 * write package bookkeeping into its report) and 「与你相关」 read their topics
 * as the researcher's interests.
 */
const SELF_MEASUREMENT_PROJECT = /^(?:acceptance|audit)-[a-z0-9-]+$/;

/**
 * What a background run is closed with when a researcher's start took its
 * runtime (`RuntimeManager.makeRoomFor`), and what a prompt refused behind that
 * stop is named. The owner of the work reads it as "ask again later", never as
 * a failure of the work: the learning loop's job and the source worker's job
 * wait and resume, and the paired evaluation excludes the cell instead of
 * scoring it (`evals/method-quality/run_paired.py`).
 */
export const RUNTIME_YIELDED_CODE = "runtime_yielded";

/**
 * The acceptance battery's and the standing audit's projects: the platform
 * measuring itself by using the product the way an ordinary account does. They
 * are internal (hidden, never a researcher's work) and yet what they did is a
 * real operation on the deployment, which is why the availability collector
 * counts them where it does not count a lesson or an evaluation cell.
 * @param {unknown} projectId @returns {boolean}
 */
export function isSelfMeasurementProject(projectId) {
  return SELF_MEASUREMENT_PROJECT.test(String(projectId ?? ""));
}

/** @param {unknown} projectId @returns {boolean} */
export function isInternalProject(projectId) {
  const id = String(projectId ?? "");
  return /^eval-paper-[a-zA-Z0-9_-]+$/.test(id) || id === EVOLUTION_PROJECT_ID || /^evolution-eval-[a-z0-9-]+$/.test(id) || id === LEARNING_PROJECT_ID || id === SOURCES_PROJECT_ID || id === FRONTIER_PROJECT_ID || id === EVIDENCE_PROJECT_ID
    || /^eval-method-[a-z0-9-]+$/.test(id) || EVALUATION_CELL_PROJECT.test(id)
    || SELF_MEASUREMENT_PROJECT.test(id);
}

/**
 * The names a client can give a project through the public route, and so no evidence of anything: the
 * self-measurement shapes, and the paired evaluation's `eval-method-*`. Every other internal name is
 * the server's own — made through the store, or refused at creation (`isReservedProjectId`).
 */
const CLIENT_NAMEABLE_INTERNAL = /^(?:(?:acceptance|audit)-[a-z0-9-]+|eval-method-[a-z0-9-]+)$/;

/**
 * Whether an account may hold the platform's self-measurement projects: an operator, or the
 * deployment's configured acceptance account (`OPEN_SCIENCE_ACCEPTANCE_USERNAME`).
 * @param {{ operatorUsers?: string[], acceptanceUsername?: string } | null | undefined} config @param {unknown} userId
 */
export function isMeasurementAccount(config, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  return (config?.operatorUsers ?? []).includes(id) || (Boolean(config?.acceptanceUsername) && config?.acceptanceUsername === id);
}

/**
 * Whether a project is the platform's own, for everything that is about money or limits: whether its
 * runs are charged, whether it counts against the account's project ceiling, whether its runtime takes
 * one of the researcher's slots. The answer needs both the name and the owner.
 *
 * A name alone is a waiver anyone can type: `POST /api/projects` takes an id from its caller, and
 * `projectIdFromName` derives one from a researcher's own title (an English "Audit trial" becomes
 * `audit-trial`). So `acceptance-*`, `audit-*` and `eval-method-*` are internal only when the account
 * that owns them is an operator or the acceptance account, and are ordinary projects for everyone
 * else. The names the server makes itself (the loop's, the knowledge base's, the frontier's, an
 * evaluation cell's, the evolution module's) are reserved at creation and stay internal by name.
 * @param {{ operatorUsers?: string[], acceptanceUsername?: string } | null | undefined} config
 * @param {unknown} userId @param {unknown} projectId @returns {boolean}
 */
export function isInternalProjectOf(config, userId, projectId) {
  if (!isInternalProject(projectId)) return false;
  return !CLIENT_NAMEABLE_INTERNAL.test(String(projectId)) || isMeasurementAccount(config, userId);
}

/**
 * Ids the public project route never lets an account name: the platform makes them itself. An
 * evaluation cell's id, the frontier's and the loop's are internal by name for every owner, so they
 * must not be reachable by typing (`createResearcherProject`).
 * @param {unknown} projectId @returns {boolean}
 */
export function isReservedProjectId(projectId) {
  const id = String(projectId ?? "");
  return id === LEARNING_PROJECT_ID || id === SOURCES_PROJECT_ID || id === FRONTIER_PROJECT_ID || id === EVIDENCE_PROJECT_ID || EVALUATION_CELL_PROJECT.test(id);
}

/**
 * A request from a browser session may not name a project the platform made for itself: it is answered
 * exactly as a project that does not exist (the code and message `requireProject` gives), so nothing says
 * the name is taken. The platform's own work in those projects is waived from the credit hold, the
 * settlement and the spend caps (`internalFor` in `server.mjs`), and the learning loop makes
 * `evimed-learning` in every account and the evidence upkeep `evimed-evidence` in an ordinary one — so a
 * researcher who named one in the project header ran research nobody paid for (evidence-flywheel review,
 * 2026-10-06: dispatch, session and runtime creation and upload all answered 2xx). Called where client
 * requests resolve their project; the platform's workers never come through it. The self-measurement
 * names stay usable by their accounts — `isInternalProjectOf` already rules who may hold them.
 * @param {unknown} projectId
 */
export function assertClientProject(projectId) {
  if (isReservedProjectId(projectId)) throw new HttpError(404, "project_not_found", "Project not found.");
}

/**
 * How many of the deployment's runtimes the platform's own background work may
 * hold at once: all but one researcher's full share, and never fewer than one.
 *
 * Background work now runs around the clock — learning, document
 * understanding, paired evaluations of hours — and on 2026-09-21 it could hold
 * every one of the four runtimes, so a researcher opening a project was
 * refused. It waits for room instead; a researcher never waits for it. The
 * runtime controller and the control plane compute the same number.
 *
 * That share is a ceiling on what background work may *take*, not a promise of
 * what a researcher will find free: on a deployment with one slot the floor of
 * one is the whole deployment, and a distillation held it for ten minutes
 * against a researcher's start (429, 2026-10-04). So a researcher's start that
 * finds the global ceiling reached retires a background runtime and the work
 * resumes later (`RuntimeManager.makeRoomFor`, `RUNTIME_YIELDED_CODE`); the
 * share only decides how many such runtimes may be up while nobody needs them.
 * @param {number | null | undefined} maxGlobal @param {number | null | undefined} maxPerUser
 * @returns {number | null} null when the deployment sets no global ceiling
 */
export function backgroundRuntimeLimit(maxGlobal, maxPerUser) {
  const global = Number(maxGlobal);
  if (maxGlobal == null || !Number.isFinite(global) || global <= 0) return null;
  const share = Number(maxPerUser);
  return Math.max(1, global - (maxPerUser != null && Number.isFinite(share) && share > 0 ? share : 1));
}

/** Evolution development and release-replay projects reserve the last research slot. */
export function isEvolutionProject(projectId) {
  return projectId === EVOLUTION_PROJECT_ID || /^(?:eval-paper-|evolution-eval-)[A-Za-z0-9_-]+$/.test(String(projectId));
}

/**
 * The evidence project of one account, made when missing: the publisher account's by default (the
 * programme's own, `OPEN_SCIENCE_EVIDENCE_PROGRAMME_*`), or the account of a researcher whose zone's
 * upkeep is billed to them (`evidenceEditorial.mjs`). The same name in both, because it is the same
 * kind of work: keeping evidence current, billed to whoever owns it.
 * @param {{ userById: (id: string) => Promise<any>, requireProject: (user: any, id: string) => Promise<any>,
 *   createProject: (user: any, id: string, name: string) => Promise<any> }} store
 * @param {string} [userId]
 * @returns {Promise<{ userId: string, projectId: string }>}
 */
export async function ensureEvidenceProject(store, userId = PLATFORM_PUBLISHER_USER_ID) {
  const user = await store.userById(userId);
  if (!user) throw new HttpError(503, "evidence_account_unavailable", "The account the evidence project belongs to does not exist.");
  try {
    await store.requireProject(user, EVIDENCE_PROJECT_ID);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "project_not_found" && /** @type {any} */ (error)?.status !== 404) throw error;
    try {
      await store.createProject(user, EVIDENCE_PROJECT_ID, EVIDENCE_PROJECT_NAME);
    } catch (conflict) {
      // Another control plane made it first; that is the project we wanted.
      if (/** @type {any} */ (conflict)?.code !== "project_exists") throw conflict;
    }
  }
  return { userId: user.id, projectId: EVIDENCE_PROJECT_ID };
}
