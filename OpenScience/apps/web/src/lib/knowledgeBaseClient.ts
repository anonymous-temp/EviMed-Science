import { WebApiError, fetchWithWebAuth, webApiBase, webErrorMessage } from "./apiClient";
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

/**
 * 「导出到 Obsidian」: the project's documents as one zip of Markdown notes (`GET /api/sources/export/vault`), saved by the
 * browser. A refusal carries its code, so the reader is told why (the size limit) and not only that it failed.
 */
export async function downloadKnowledgeVault(projectId: string): Promise<void> {
  const root = webApiBase.endsWith("/api") ? webApiBase : `${webApiBase}/api`;
  const response = await fetchWithWebAuth(`${root}/sources/export/vault?${new URLSearchParams({ projectId })}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string; requestId?: string } | null;
    throw new WebApiError(body?.error ?? "The knowledge base could not be exported.", { status: response.status, code: body?.code, requestId: body?.requestId });
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "evimed-knowledge-base.zip";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** What the export says when it is refused: the size limit is the one refusal the reader can act on. */
export function vaultErrorMessage(error: unknown): string {
  return webErrorMessage(error, { codes: { archive_too_large: "资料太多，一次导不完。请先删掉一部分再导出。" } });
}
