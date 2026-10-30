import { useCallback, useEffect, useRef, useState } from "react";
import { productErrorMessage } from "@/lib/productClient";
import { listSources, type SourceCounts, type SourceKind, type SourcePassage, type SourceRecord } from "@/lib/sourceClient";
import { toast } from "@/lib/toast";
import { isKnowledgePage, isReading } from "./sourceView";

/** The first page and the polling refresh ask for at least this many documents. */
export const PAGE_SIZE = 50;
/** How many pages one load follows to find enough documents once the compiled files are left out of the list (50 documents a page). */
const MAX_FOLLOWED_PAGES = 10;
/** A document still being read is asked about again this often: that is the one change a row shows. */
const READING_POLL_MS = 5000;

/** Where a list is brought back to: how many documents it had loaded, so the one the reader opened is among them. */
export interface RestorePosition {
  count: number;
}

/**
 * The knowledge base's list of documents: every document of the account, once each (`scope=all`), newest first, a page of fifty at a time
 * with the rest loaded as the list is scrolled, and the search run where the documents are. The platform's own compiled files are the
 * 知识页 view's and are left out, and a page that was mostly those is followed until it holds documents (bounded).
 *
 * `enabled` is false while another view is open: nothing is read then. `restore`, read once when the list is first loaded, is the number
 * of documents the list had when a document was opened from it, so that coming back finds the same rows (the scroll is the page's to
 * put back, `onRestored`). A row still being read is polled; a read, a delete and a change of where a document takes effect are each one
 * refresh of the head of the list, which keeps what was loaded beyond it.
 */
export function useDocumentList({ enabled, kind, search, restore, onRestored }: {
  enabled: boolean;
  kind: SourceKind | null;
  search: string;
  restore: RestorePosition | null;
  onRestored: () => void;
}) {
  const [items, setItems] = useState<SourceRecord[] | null>(null);
  const [counts, setCounts] = useState<SourceCounts | null>(null);
  // Where the search matched inside documents' text, by document: shown under each row.
  const [passages, setPassages] = useState<Record<string, SourcePassage[]>>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loaded = useRef(0);
  const pending = useRef(restore);

  const load = useCallback(async (background = false) => {
    const current = ++generation.current;
    if (!background) { setItems(null); setNextCursor(null); setError(null); }
    const position = background ? null : pending.current;
    const ask = (more: { cursor?: string; limit: number }) => listSources({ kind: "all" }, { ...(kind ? { kind } : {}), q: search, ...more });
    try {
      const page = await ask({ limit: background ? Math.min(100, Math.max(PAGE_SIZE, loaded.current)) : position ? Math.min(100, Math.max(PAGE_SIZE, position.count)) : PAGE_SIZE });
      if (generation.current !== current) return;
      setCounts(page.counts ?? null);
      setError(null);
      setPassages((previous) => (background ? { ...previous, ...(page.passages ?? {}) } : page.passages ?? {}));
      const documents = (rows: SourceRecord[]) => rows.filter((row) => !isKnowledgePage(row));
      if (!background) {
        // The pages the reader had open are read again until the document they opened is among them, and a page that was mostly the
        // platform's own files is followed until it holds the documents it should (both bounded).
        let loadedItems = documents(page.items);
        let cursor = page.nextCursor;
        const wanted = position ? position.count : PAGE_SIZE;
        const dropped = page.items.length - loadedItems.length;
        for (let more = 0; cursor && (position !== null || dropped > 0) && loadedItems.length < wanted && more < MAX_FOLLOWED_PAGES; more += 1) {
          const next = await ask({ cursor, limit: PAGE_SIZE });
          if (generation.current !== current) return;
          const known = new Set(loadedItems.map((item) => item.id));
          loadedItems = [...loadedItems, ...documents(next.items).filter((item) => !known.has(item.id))];
          cursor = next.nextCursor;
          if (next.passages) setPassages((previous) => ({ ...previous, ...next.passages }));
        }
        if (position) { pending.current = null; onRestored(); }
        setItems(loadedItems);
        setNextCursor(cursor);
        return;
      }
      // A refresh of the head of the list: what it holds replaces those rows, and what was loaded beyond it stays.
      setItems((previous) => {
        const fresh = documents(page.items);
        if (!previous || !page.nextCursor) { setNextCursor(page.nextCursor); return fresh; }
        const oldest = page.items.at(-1)?.createdAt ?? "";
        const known = new Set(fresh.map((item) => item.id));
        const tail = previous.filter((item) => !known.has(item.id) && item.createdAt < oldest);
        if (tail.length === 0) setNextCursor(page.nextCursor);
        return [...fresh, ...tail];
      });
    } catch (loadError) {
      if (generation.current === current) {
        if (!background) setItems([]);
        setError(`无法加载资料：${productErrorMessage(loadError)}`);
      }
    }
  }, [kind, search, onRestored]);
  useEffect(() => {
    if (!enabled) return undefined;
    void load();
    return () => { generation.current += 1; };
  }, [enabled, load]);
  useEffect(() => { loaded.current = items?.length ?? 0; }, [items]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      // The next page may be the platform's own files from end to end: pages are followed until a document comes (bounded).
      let cursor: string | null = nextCursor;
      let added: SourceRecord[] = [];
      for (let followed = 0; cursor && added.length === 0 && followed < MAX_FOLLOWED_PAGES; followed += 1) {
        const page = await listSources({ kind: "all" }, { ...(kind ? { kind } : {}), q: search, cursor, limit: PAGE_SIZE });
        if (generation.current !== current) return;
        added = page.items.filter((row) => !isKnowledgePage(row));
        if (page.passages) setPassages((previous) => ({ ...previous, ...page.passages }));
        cursor = page.nextCursor;
      }
      setItems((previous) => {
        const known = new Set((previous ?? []).map((item) => item.id));
        return [...(previous ?? []), ...added.filter((item) => !known.has(item.id))];
      });
      setNextCursor(cursor);
    } catch (loadError) {
      toast.error(`无法加载更多：${productErrorMessage(loadError)}`);
    } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, kind, search]);

  // Polled while a row is still being read.
  const processing = items?.some(isReading) ?? false;
  useEffect(() => {
    if (!enabled || !processing || error) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { void load(true); }, READING_POLL_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [enabled, items, processing, error, load]);

  return { items, setItems, counts, passages, nextCursor, loadingMore, error, load, loadMore };
}
