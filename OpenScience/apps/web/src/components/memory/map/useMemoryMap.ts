import { useCallback, useEffect, useRef, useState } from "react";
import { MEMORY_CHANGED_EVENT } from "@/lib/memoryClient";
import { fetchMemoryMap, refreshTopics, type MapQuery, type MemoryMap } from "@/lib/memoryMapClient";

/**
 * The memory map's document, read again only when what the server filters changes — the project, the range, the focus and its
 * depth — and when a memory changed on screen. The topic, the kind, the aspect and the search narrow the document in hand, so the
 * five views switch without asking (spec §5.2).
 *
 * Refreshes retain the current selection's document. Changing project, range or focus immediately removes the old document:
 * its marks and actions must never appear under the next selection's header, even if that request fails.
 *
 * The topics are the one thing that may be out of date (`status.topics === "stale"`): when the document says so, the page asks for
 * a regrouping once and reads again; the server groups only when the memories changed and the day's bound allows, so asking costs
 * nothing when there is nothing to do.
 */
export function useMemoryMap(query: MapQuery) {
  const [state, setState] = useState<{ doc: MemoryMap | null; status: "loading" | "ready" | "error"; asked: string; scope: string }>({ doc: null, status: "loading", asked: "", scope: "" });
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([query.projectId, query.range, query.focus, query.depth]);
  const key = `${scope}|${attempt}`;
  const doc = state.scope === scope ? state.doc : null;
  const regrouped = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    fetchMemoryMap(query).then(
      (doc) => { if (!cancelled) setState({ doc, status: "ready", asked: key, scope }); },
      () => { if (!cancelled) setState((held) => ({ doc: held.scope === scope ? held.doc : null, status: "error", asked: key, scope })); },
    );
    return () => { cancelled = true; };
    // `query` is read through its fields, which `key` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);

  useEffect(() => {
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MEMORY_CHANGED_EVENT, reload);
  }, [reload]);

  // A regrouping is asked for once for each state of the memories the document was read from.
  const stale = doc?.status.topics === "stale";
  const stamp = `${scope}|${doc?.summary.memories ?? 0}|${doc?.facets.topics.length ?? 0}|${doc?.summary.since ?? ""}`;
  const [grouping, setGrouping] = useState(false);
  useEffect(() => {
    if (!stale || regrouped.current.has(stamp)) return;
    regrouped.current.add(stamp);
    setGrouping(true);
    refreshTopics().then(
      (result) => { if (result.made) reload(); },
      () => undefined,
    ).finally(() => setGrouping(false));
  }, [stale, stamp, reload]);

  const failed = state.asked === key && state.status === "error";
  return { doc, status: doc ? ("ready" as const) : failed ? ("error" as const) : ("loading" as const), failed, loading: state.asked !== key, grouping, reload };
}
