import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { useAddressOpen, useAddressText, withParam } from "@/lib/addressState";
import type { RangeKey } from "./memoryOverviewModel";

/**
 * What the reader has chosen on the dashboard, kept in the address so a reload, a pasted link and Back find the page as it was: one
 * selection that narrows the chart, the relation and topic panel and the table behind them together.
 *
 * Choosing which of the two panels is shown (`explore`) pushes an entry, so Back steps back through it; narrowing — a range, the week a cell
 * selected, a topic, the search, only what needs a look — replaces, so Back does not walk through every choice; a mark that opens in the
 * drawer pushes, so Back closes it first (`useAddressOpen`). A parameter at its default is not written, so the plain address is the plain page.
 */
export interface OverviewSelection {
  range: RangeKey;
  /** Only what needs a second look. */
  look: boolean;
  /** One project, from an old link of the map; the page offers no control for it, but the mark that lets go of it. */
  project: string | null;
  topic: string | null;
  /** The Monday of one week the chart selected (YYYY-MM-DD). */
  week: string | null;
  /** The panel the reader chose; null is the page's own choice (the relations when there are some, else the topics). */
  explore: "graph" | "topics" | null;
  q: string;
}

export const DEFAULT_SELECTION: OverviewSelection = { range: "all", look: false, project: null, topic: null, week: null, explore: null, q: "" };

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function parseSelection(params: URLSearchParams): OverviewSelection {
  const range = params.get("range");
  const week = params.get("week") ?? "";
  const explore = params.get("explore");
  const text = (name: string, max: number) => { const value = params.get(name); return value ? value.slice(0, max) : null; };
  return {
    range: range === "30d" || range === "90d" ? range : "all",
    look: params.get("look") === "1",
    project: text("project", 160),
    topic: text("topic", 200),
    week: DAY.test(week) ? week : null,
    explore: explore === "graph" || explore === "topics" ? explore : null,
    q: (params.get("q") ?? "").slice(0, 80),
  };
}

const WRITTEN: ReadonlyArray<[string, (selection: OverviewSelection) => string | null]> = [
  ["range", (s) => (s.range === "all" ? null : s.range)],
  ["look", (s) => (s.look ? "1" : null)],
  ["project", (s) => s.project],
  ["topic", (s) => s.topic],
  ["week", (s) => s.week],
  ["explore", (s) => s.explore],
  ["q", (s) => s.q || null],
];

/** The address of a selection: what differs from the plain page, and nothing else. Parameters it does not own (`open`) are kept. */
export function selectionParams(selection: OverviewSelection, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  let params = new URLSearchParams(base);
  for (const [name, write] of WRITTEN) params = withParam(params, name, write(selection));
  return params;
}

export function useOverviewSelection() {
  const [params, setParams] = useSearchParams();
  const selection = useMemo(() => parseSelection(params), [params]);
  const search = useAddressText("q", 80);
  const drawer = useAddressOpen("open");

  /** Choosing a panel pushes an entry. */
  const setExplore = useCallback((explore: "graph" | "topics") => {
    setParams((current) => selectionParams({ ...parseSelection(current), explore }, current));
  }, [setParams]);

  /** Narrowing replaces the entry. */
  const narrow = useCallback((patch: Partial<OverviewSelection>) => {
    setParams((current) => selectionParams({ ...parseSelection(current), ...patch }, current), { replace: true });
  }, [setParams]);

  /** Back to the whole capsule: everything narrowed is let go, the panel the reader chose kept. */
  const clear = useCallback(() => {
    search.clear();
    setParams((current) => selectionParams({ ...DEFAULT_SELECTION, explore: parseSelection(current).explore }, current), { replace: true });
  }, [search, setParams]);

  return { selection: { ...selection, q: search.committed }, search, setExplore, narrow, clear, drawer };
}
