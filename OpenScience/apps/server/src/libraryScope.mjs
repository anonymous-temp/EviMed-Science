import path from "node:path";
import { LIBRARY_PROJECT_ID, assertClientProject, isInternalProject } from "./internalProjects.mjs";
import { HttpError, safeId } from "./security.mjs";

/**
 * Which projects of one account a document applies to (2026-10-28).
 *
 * A document is one row of the knowledge base per file hash (`GET /api/sources?scope=all`) and applies to
 *
 *   the ordinary project that holds it (always, and never taken away)
 *   ∪ what its library record says: `projects: "all"` (a marker — a project made later is covered too) or a list of
 *     project ids. A record with no `projects` is every record written before this field existed, and means all.
 *
 * A document with no record applies to the project that holds it and nowhere else. A document in personal storage is
 * held by no project; with a record that lists nobody it applies nowhere and is only kept.
 *
 * This file is the one place that reads that rule. Every scope check — `kb_search`, `kb_browse`, the conversation's
 * document selection, the project's library directory, a compile — asks `libraryRecordCovers` and nothing else asks the
 * record's field directly, so a document limited to project A cannot be one check short of being readable in project B.
 */

/** The record's marker for every project, present and future. */
export const LIBRARY_ALL_PROJECTS = "all";
/** The most projects one record may list: the account's own projects are far fewer, and a list is read whole per check. */
export const LIBRARY_PROJECTS_MAX = 200;

/**
 * What a stored record says. A missing field is the old record, which meant every project; anything else that is not a
 * list of project ids reads as an empty list — a record this code cannot understand never widens a document.
 * @param {any} payload a library record's payload
 * @returns {"all" | string[]}
 */
export function libraryRecordProjects(payload) {
  const value = payload?.projects;
  if (value === undefined || value === LIBRARY_ALL_PROJECTS) return LIBRARY_ALL_PROJECTS;
  return Array.isArray(value) ? [...new Set(value.filter((/** @type {unknown} */ id) => typeof id === "string" && id))] : [];
}

/**
 * Whether a record puts its document in a project. The project that holds the document is the caller's business: this
 * answers only for the record.
 * @param {any} payload a library record's payload @param {unknown} projectId
 */
export function libraryRecordCovers(payload, projectId) {
  if (typeof projectId !== "string" || !projectId) return false;
  const projects = libraryRecordProjects(payload);
  return projects === LIBRARY_ALL_PROJECTS || projects.includes(projectId);
}

/**
 * The effective projects of a document: the projects holding it plus what its record adds.
 * @param {{ holders: Iterable<string>, record: any | null }} input `record`: the library record's payload, or null for none
 * @returns {"all" | string[]}
 */
export function effectiveProjects({ holders, record }) {
  if (record && libraryRecordProjects(record) === LIBRARY_ALL_PROJECTS) return LIBRARY_ALL_PROJECTS;
  return [...new Set([...holders, ...(record ? /** @type {string[]} */ (libraryRecordProjects(record)) : [])])].sort();
}

/**
 * The ordinary projects among the projects that hold a document: where it lives, which is never taken away from it.
 * Personal storage and the platform's own projects hold documents too, and are not projects a person works in.
 * @param {Iterable<unknown>} projectIds @returns {string[]}
 */
export function ordinaryHolderProjects(projectIds) {
  return [...new Set([...projectIds].map(String).filter((id) => id !== LIBRARY_PROJECT_ID && !isInternalProject(id)))].sort();
}

/**
 * The request's `projects`: `"all"` or a list of project ids, the list de-duplicated and in the order given. Only the shape
 * is checked here; which ids may be named is `assertApplicableProject`'s.
 * @param {unknown} value @returns {"all" | string[]}
 */
export function parseLibraryProjects(value) {
  if (value === LIBRARY_ALL_PROJECTS) return LIBRARY_ALL_PROJECTS;
  if (!Array.isArray(value) || value.length > LIBRARY_PROJECTS_MAX) {
    throw new HttpError(400, "library_projects_invalid", 'Send "all" or a list of project ids.');
  }
  /** @type {string[]} */
  const ids = [];
  for (const id of value) {
    if (typeof id !== "string") throw new HttpError(400, "library_projects_invalid", 'Send "all" or a list of project ids.');
    let safe;
    try { safe = safeId(id, "project id"); } catch { throw new HttpError(400, "library_projects_invalid", "A project id is not valid."); }
    if (!ids.includes(safe)) ids.push(safe);
  }
  return ids;
}

/**
 * The one rule for where a document may be sent: an existing, unarchived, ordinary project of the account — not a platform
 * project, not a 循证 GEO project, not a 虚拟临床研究 study. The copy route (`POST /api/library/:id/projects`) and the
 * applicability list share it, so the two cannot disagree about what an ordinary project is.
 *
 * Every refusal is the same 400 (`library_project_invalid`): another account's project and a project that does not exist
 * must not read differently.
 *
 * @param {{ store: { requireProject: (user: any, id: string) => Promise<any> }, internalProject?: (user: any, id: string) => boolean,
 *   moduleProject?: (user: any, id: string) => Promise<boolean> }} dependencies
 * @param {any} user @param {unknown} projectId
 * @param {{ code?: string, message?: string, allowArchived?: boolean }} [options] `code`: what a refusal is called (the copy route
 *   keeps `library_payload_invalid`, which its callers already read)
 * @returns {Promise<any>} the project
 */
export async function assertOrdinaryProject({ store, internalProject = (_user, id) => isInternalProject(id), moduleProject = async () => false },
  user, projectId, { code = "library_project_invalid", message = "Choose an ordinary project.", allowArchived = false } = {}) {
  const refuse = () => new HttpError(400, code, message);
  if (typeof projectId !== "string" || !projectId || internalProject(user, projectId)) throw refuse();
  try { assertClientProject(projectId); } catch { throw refuse(); }
  let project;
  try { project = await store.requireProject(user, projectId); } catch (error) {
    if (error instanceof HttpError && [400, 403, 404].includes(error.status)) throw refuse();
    throw error;
  }
  if (!allowArchived && project.archivedAt) throw refuse();
  if (await moduleProject(user, project.id)) throw refuse();
  return project;
}

/**
 * The host directory of one project's view of the account's library: a real copy of exactly the documents that apply to the
 * project, which the runtime mounts read-only at /workspace/library. The account's own `library/` directory is the master
 * the views are written from and is never mounted — a mount of it would show a project every document the account keeps.
 * `runtimeManager`'s `projectLibraryViewDir` names the same directory, and the two must agree.
 * @param {Record<string, any>} config @param {string} userId @param {string} projectId
 */
export function projectLibraryViewDir(config, userId, projectId) {
  return path.join(libraryViewsRoot(config, userId), safeId(String(projectId), "project id"));
}

/** The directory that holds every project's view, beside the master `library/` directory.
 * @param {Record<string, any>} config @param {string} userId */
export function libraryViewsRoot(config, userId) {
  return path.join(config.dataDir, "users", safeId(String(userId), "user id"), "library-views");
}
