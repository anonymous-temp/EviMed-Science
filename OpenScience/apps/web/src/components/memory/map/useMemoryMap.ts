import { useCallback, useEffect, useRef, useState } from "react";
import { MEMORY_CHANGED_EVENT } from "@/lib/memoryClient";
import { fetchMemoryMap, refreshTopics, type MapQuery, type MemoryMap } from "@/lib/memoryMapClient";

/**
 * The memory map's document, read again only when what the server filters changes — the project, the range, the focus and its
 * depth — and when a memory changed on screen. The topic, the kind, the aspect and the search narrow the document in hand, so the
 * five views switch without asking (spec §5.2).
 *
 * While a new document is being read the previous one stays on screen: a graph that blanked at every narrowing would read as the
 * map being rebuilt. `state` is `loading` only before the first answer, and `error` keeps what was last read.
 *
 * The topics are the one thing that may be out of date (`status.topics === "stale"`): when the document says so, the page asks for
 * a regrouping once and reads again; the server groups only when the memories changed and the day's bound allows, so asking costs
 * nothing when there is nothing to do.
 */
export function useMemoryMap(query: MapQuery) {
  const [state, setState] = useState<{ doc: MemoryMap | null; status: "loading" | "ready" | "error"; asked: string }>({ doc: null, status: "loading", asked: "" });
  const [attempt, setAttempt] = useState(0);
  const key = `${query.projectId ?? ""}|${query.range}|${query.focus ?? ""}|${query.depth}|${attempt}`;
  const regrouped = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    fetchMemoryMap(query).then(
      (doc) => { if (!cancelled) setState({ doc, status: "ready", asked: key }); },
      () => { if (!cancelled) setState((held) => ({ ...held, status: "error", asked: key })); },
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
  const stale = state.doc?.status.topics === "stale";
  const stamp = `${state.doc?.summary.memories ?? 0}|${state.doc?.facets.topics.length ?? 0}|${state.doc?.summary.since ?? ""}`;
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

  return { doc: state.doc, status: state.doc && state.status === "error" ? ("ready" as const) : state.status, failed: state.status === "error", loading: state.asked !== key && state.status !== "error", grouping, reload };
}
