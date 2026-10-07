import { listSources, type SourceListOptions, type SourceRecord } from "./sourceClient";

/** Pages one walk reads, of a hundred documents each. A bound, so a cursor that never ends cannot loop. */
const MAX_PAGES = 20;

/**
 * Every document of a project in one state, page after page: for the callers that offer a document by name and
 * must not stop at the first page — the composer's 「@知识库」 and a task's materials. The list used to answer
 * its first fifty and these callers took that for all of them, so the fifty-first document could not be named.
 */
export async function listAllSources(projectId: string, options: Pick<SourceListOptions, "state" | "status"> = {}): Promise<SourceRecord[]> {
  const items: SourceRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: Awaited<ReturnType<typeof listSources>> = await listSources(projectId, { ...options, limit: 100, cursor });
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return items;
}
