import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { useAddressOpen, useAddressText, withParam } from "@/lib/addressState";
import { MAP_PARTS, MAP_VIEWS, type MapPart, type MapView } from "@/lib/memoryMapClient";

/**
 * What the reader has chosen on the memory map, kept in the address: the one selection all five views share (spec §5.2), so a
 * reload, a pasted link and Back find the page as it was.
 *
 * Which writes make a history entry follows the other list pages (`addressState.ts`): choosing a view pushes, so Back steps back
 * through the views; narrowing — a project, a range, a topic, a kind, a focus — replaces, so Back does not walk through every
 * choice; a mark that opens in the drawer pushes, so Back closes it first. Only a project, a range or a focus asks the server
 * again; the topic, the kind, the aspect and the search narrow the document already in hand, so the views switch at once.
 *
 * A parameter at its default is not written (`view=graph`, `range=all`, `depth=1`), so the plain address is the plain page.
 */
export interface MapSelection {
  view: MapView;
  /** A project's id; null is every project. */
  project: string | null;
  /** `30d`, `90d`, `1y`, `all`, or `YYYY-MM-DD..YYYY-MM-DD` (the server's own grammar). */
  range: string;
  topic: string | null;
  kind: string | null;
  /** One axis of a radar: `aspect:…`. */
  dimension: string | null;
  /** The mark the graph is centred on (`memory:…`, `cluster:…`). */
  focus: string | null;
  depth: 1 | 2;
  /** Shows the focused memory's sources as a chain instead of its neighbours. */
  chain: boolean;
  /** Only what needs a second look. */
  look: boolean;
  /** One part of the capsule, the way a card of the overview drills into the map: 关于你, 项目, 做法 or 知识. */
  part: MapPart | null;
  q: string;
}

export const DEFAULT_SELECTION: MapSelection = {
  view: "graph", project: null, range: "all", topic: null, kind: null, dimension: null, focus: null, depth: 1, chain: false, look: false, part: null, q: "",
};

const RANGE = /^(?:30d|90d|1y|all|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/u;
const NODE = /^[a-z]+:.{1,300}$/su;

/** @param {URLSearchParams} params */
export function parseSelection(params: URLSearchParams): MapSelection {
  const view = params.get("view");
  const range = params.get("range") ?? "";
  const focus = params.get("focus") ?? "";
  const text = (name: string, max = 200) => {
    const value = params.get(name);
    return value ? value.slice(0, max) : null;
  };
  return {
    view: MAP_VIEWS.includes(view as MapView) ? (view as MapView) : "graph",
    project: text("project", 160),
    range: RANGE.test(range) ? range : "all",
    topic: text("topic"),
    kind: text("kind", 60),
    dimension: text("dimension", 80),
    focus: NODE.test(focus) ? focus : null,
    depth: params.get("depth") === "2" ? 2 : 1,
    chain: params.get("chain") === "1",
    look: params.get("look") === "1",
    part: MAP_PARTS.includes(params.get("part") as MapPart) ? (params.get("part") as MapPart) : null,
    q: (params.get("q") ?? "").slice(0, 80),
  };
}

const WRITTEN: ReadonlyArray<[keyof MapSelection, (selection: MapSelection) => string | null]> = [
  ["view", (s) => (s.view === "graph" ? null : s.view)],
  ["project", (s) => s.project],
  ["range", (s) => (s.range === "all" ? null : s.range)],
  ["topic", (s) => s.topic],
  ["kind", (s) => s.kind],
  ["dimension", (s) => s.dimension],
  ["focus", (s) => s.focus],
  ["depth", (s) => (s.focus && s.depth === 2 ? "2" : null)],
  ["chain", (s) => (s.focus && s.chain ? "1" : null)],
  ["look", (s) => (s.look ? "1" : null)],
  ["part", (s) => s.part],
  ["q", (s) => s.q || null],
];

/** The address of a selection: what differs from the plain page, and nothing else. Parameters it does not own are kept. */
export function selectionParams(selection: MapSelection, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  let params = new URLSearchParams(base);
  for (const [name, write] of WRITTEN) params = withParam(params, name, write(selection));
  return params;
}

/** A selection changed by a patch; changing what a focus is centred on drops what only made sense for the old one. */
export function patchSelection(selection: MapSelection, patch: Partial<MapSelection>): MapSelection {
  const next = { ...selection, ...patch };
  if (patch.focus !== undefined && patch.focus !== selection.focus) {
    if (patch.chain === undefined) next.chain = false;
    if (patch.depth === undefined) next.depth = 1;
  }
  if (!next.focus) { next.chain = false; next.depth = 1; }
  return next;
}

export function useMapSelection() {
  const [params, setParams] = useSearchParams();
  const selection = useMemo(() => parseSelection(params), [params]);
  const search = useAddressText("q", 80);
  const drawer = useAddressOpen("open");

  /** Choosing a view pushes an entry. */
  const setView = useCallback((view: MapView) => {
    setParams((current) => selectionParams(patchSelection(parseSelection(current), { view }), current));
  }, [setParams]);

  /** Narrowing replaces the entry. */
  const narrow = useCallback((patch: Partial<MapSelection>) => {
    setParams((current) => selectionParams(patchSelection(parseSelection(current), patch), current), { replace: true });
  }, [setParams]);

  /** Back to the whole map: everything narrowed is cleared, the view kept. */
  const clear = useCallback(() => {
    search.clear();
    setParams((current) => selectionParams({ ...DEFAULT_SELECTION, view: parseSelection(current).view }, withParam(current, "open", null)), { replace: true });
  }, [search, setParams]);

  return { selection: { ...selection, q: search.committed }, search, setView, narrow, clear, drawer };
}
