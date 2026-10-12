import { productRequest } from "./productClient";

/**
 * What the knowledge base page and a document's page read beyond the documents themselves (2026-10-12, knowledge base P0):
 * what rests on a document, and — as they are added — the files a project's conversations delivered, the composition of the
 * library and the Obsidian vault export. Their own file, so `sourceClient.ts` stays the documents'.
 */

/** What rests on one document (`GET /api/sources/:id/dependents`): the memories, learned methods and results that name it. */
export interface SourceDependents {
  memories: Array<{ recordId: string; text: string; scope: string }>;
  methods: Array<{ id: string; title: string }>;
  results: Array<{ versionId: string; runId: string; path: string; title: string | null; at: string }>;
}

export function getSourceDependents(sourceId: string) {
  return productRequest<SourceDependents>(`/sources/${encodeURIComponent(sourceId)}/dependents`);
}

/** The memory page, with one memory's drawer open (`?record=`, the address an inbox notice carries). */
export const memoryRecordPath = (recordId: string) => `/app/memory?record=${encodeURIComponent(recordId)}`;
/** The memory page, with one learned method's drawer open (`?method=`). */
export const methodPath = (methodId: string) => `/app/memory?method=${encodeURIComponent(methodId)}`;
/** One file a run delivered, on its own page. */
export const runFilePath = (runId: string, path: string) => `/app/runs/${encodeURIComponent(runId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
