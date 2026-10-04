/**
 * Hand what a run preserved to source intake.
 *
 * Hidden knowledge: a run's preserved sources live under `.evimed-sources/` in
 * its workspace, and the runtime cannot write the project's `knowledge-base/`
 * (it is mounted read-only). So a supplementary spreadsheet or a trial's
 * posted results could be read by the run that fetched them and by no one else:
 * never parsed by the in-house parser, never searchable, never in the
 * researcher's library once the run ended. This is the one way a preserved
 * file becomes a source, and it is the same way an upload becomes one
 * (`writeProjectUpload` in `server.mjs`): the format admission, the project's
 * capacity, an atomic no-follow write, the mirror into a running runtime and the
 * source registration that parses and indexes it. There is no second intake.
 *
 * What the runtime names is a preserved path and a group label, never a
 * destination. The control plane
 *
 * - takes the project from the runtime's token, not from the request;
 * - re-reads the file through `sourceCapture`, which verifies the capture's
 *   manifest, its directory version and the file's digest, so the bytes that
 *   reach the library are the bytes the tool preserved, not whatever a later
 *   edit left there;
 * - writes it at `knowledge-base/open-access/<group>/<file name>`, a path of
 *   its own. A file whose bytes change under the same name becomes the next
 *   version of that source family (`SourceService.register` keys a family by
 *   path), which is how a supplement that changed keeps its history.
 *
 * Each file has its own answer. A format the knowledge base cannot read (a
 * `.zip`, an `.rds`) is refused by name and the rest go on, and every file stays
 * preserved and readable in the workspace whatever intake says.
 *
 * @module sourceIntakeHandoff
 */

import path from "node:path";

import { HttpError } from "./security.mjs";
import { isInternalProject } from "./internalProjects.mjs";

/** At most this many files in one hand-off: a paper's supplements, not a corpus. */
export const MAX_INTAKE_FILES = 40;
/** Where handed-off files land, under the project's knowledge base. */
export const INTAKE_FOLDER = "knowledge-base/open-access";
const GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCES_PREFIX = ".evimed-sources/";

/**
 * @param {{
 *   context: (identity: { userId: string, projectId: string }) => Promise<{ user: any, project: any }>,
 *   read: (project: any, relativePath: string) => Promise<{ bytes: Buffer }>,
 *   write: (context: { user: any, project: any }, rel: string, bytes: Buffer) => Promise<any>,
 * }} dependencies
 */
export function createSourceIntakeHandoff({ context, read, write }) {
  /**
   * @param {{ identity: { userId: string, projectId: string }, group: string, files: string[] }} request
   * @returns {Promise<{ results: Array<Record<string, any>> }>}
   */
  return async function handOff({ identity, group, files }) {
    if (typeof group !== "string" || !GROUP.test(group)) {
      throw new HttpError(400, "source_intake_group_invalid", "The group is a short file-name-safe label.");
    }
    if (!Array.isArray(files) || files.length < 1 || files.length > MAX_INTAKE_FILES || files.some((file) => typeof file !== "string")) {
      throw new HttpError(400, "source_intake_files_invalid", `Hand over between 1 and ${MAX_INTAKE_FILES} preserved files.`);
    }
    const { user, project } = await context(identity);
    // The platform's own background projects are nobody's library.
    if (isInternalProject(project.id)) throw new HttpError(404, "project_not_found", "Project not found.");
    /** @type {Array<Record<string, any>>} */
    const results = [];
    for (const file of [...new Set(files)]) {
      try {
        const normalized = file.replaceAll("\\", "/");
        if (!normalized.startsWith(SOURCES_PREFIX) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
          throw new HttpError(400, "source_intake_path_invalid", "Only a preserved source path can be handed to intake.");
        }
        const { bytes } = await read(project, normalized);
        const rel = `${INTAKE_FOLDER}/${group}/${path.posix.basename(normalized)}`;
        const registered = await write({ user, project }, rel, bytes);
        results.push({
          path: file,
          registered: Boolean(registered?.source),
          knowledgePath: rel,
          ...(registered?.source ? {
            sourceId: registered.source.id,
            duplicate: Boolean(registered.duplicate),
            status: registered.source.payload?.status ?? null,
          } : { reason: "not_registered" }),
        });
      } catch (error) {
        // One file's refusal is its own answer, named by its code; it never
        // stops the rest of the paper's supplements from being offered.
        results.push({ path: file, registered: false, reason: typeof error?.code === "string" ? error.code : "source_intake_failed" });
      }
    }
    return { results };
  };
}
