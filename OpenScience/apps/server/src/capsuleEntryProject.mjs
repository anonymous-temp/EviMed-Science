/**
 * Which project a capsule entry is labelled with, and whether a conversation in a project may read it.
 *
 * A person has one capsule (`account-capsule:<hash>`). A note a conversation wrote lives in it with the project it was written
 * in as a label: the document's `project_id` column — what a project's deletion cascades on and what the memory page, the map and
 * `ProductDocuments.list({ projectId })` read — and the same id in `payload.projectId`, which a payload filter and a share can see.
 * The label is a filter and nothing else: an entry with none belongs to the whole account and every project reads it; an entry
 * with one is read in that project's conversations and in none other, as the project's own notes capsule was
 * (2026-10-24, the owner's ruling: 「记忆胶囊有必要按项目拆分吗，没必要吧」).
 *
 * What a knowledge-base document yielded (`DOCUMENT_MEMORY_LAYER`) carries its project in the payload alone and is placed by its
 * publication ledger when it does not (`derivedMemory.mjs`); `CapsuleService` decides those, and everything else here.
 *
 * @module capsuleEntryProject
 */

/**
 * The project an entry is labelled with, or null for an entry of the whole account. Reads a `ProductDocuments` record (`projectId`),
 * a raw row (`project_id`) or, last, the payload's own copy.
 * @param {{ projectId?: string | null, project_id?: string | null, payload?: { projectId?: unknown } | null } | null | undefined} row
 * @returns {string | null}
 */
export function entryProject(row) {
  const label = row?.projectId ?? row?.project_id ?? row?.payload?.projectId ?? null;
  return typeof label === "string" && label ? label : null;
}

/**
 * Whether a conversation in `projectId` (null: one in no project) may read the entry: an entry of the whole account, or one labelled
 * with this very project.
 * @param {Parameters<typeof entryProject>[0]} row @param {string | null} projectId
 */
export function entryReaches(row, projectId) {
  const label = entryProject(row);
  return label === null || label === projectId;
}
