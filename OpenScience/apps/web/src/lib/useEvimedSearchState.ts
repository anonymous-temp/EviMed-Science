import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, WEB_SESSION_SYNC_STORAGE_KEY } from "./apiClient";
import {
  evimedSearchCategory, evimedSearchFailure, readEvimedSearchDetail, readEvimedSearchFacets, searchEvimed,
  type EvimedSearchCategory, type EvimedSearchDetail, type EvimedSearchFailure,
  type EvimedSearchFacets, type EvimedSearchResult, type EvimedSearchItem,
} from "./evimedSearchClient";

import { parseEvimedSearchFilters, writeEvimedSearchFilters, EVIMED_SEARCH_FILTER_KEYS } from "./evimedSearchFilters";

type Resource<T> = { key: string; status: "loading" } | { key: string; status: "success"; data: T }
  | { key: string; status: "error"; error: EvimedSearchFailure };
type Entry<T> = { data: T; expiresAt: number };
type View = { query: string; search: string; draft: string };
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 24;
const PAGE_SIZE = 10;

function cached<T>(entries: Map<string, Entry<T>>, key: string): T | undefined {
  const entry = entries.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.data : undefined;
}

function remember<T>(entries: Map<string, Entry<T>>, key: string, data: T) {
  entries.delete(key);
  entries.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  if (entries.size > CACHE_LIMIT) entries.delete(entries.keys().next().value!);
}

/** A search round lives only in this mounted page, never in browser storage. */
export function useEvimedSearchState() {
  const category = evimedSearchCategory(useParams<{ category: string }>().category);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const page = Math.max(1, Math.min(1000, Number.parseInt(params.get("page") ?? "1", 10) || 1));
  const detailRef = params.get("detail");
  const search = params.toString();
  const filters = useMemo(() => parseEvimedSearchFilters(category, new URLSearchParams(search)), [category, search]);
  const language = filters.language ?? "";
  const sort = filters.sort ?? "comprehensive";
  const source = filters.source ?? "";
  const scholarly = category === "literature" || category === "guidelines";
  const navigation = new URLSearchParams();
  if (query) navigation.set("q", query);
  if (page > 1) navigation.set("page", String(page));
  const listParams = writeEvimedSearchFilters(category, navigation, filters);
  const facetFilters = { ...filters };
  delete facetFilters.startYear; delete facetFilters.endYear; delete facetFilters.sort;
  const facetKey = JSON.stringify([category, query, facetFilters]);
  const listSearch = listParams.toString();
  const listKey = JSON.stringify([category, query, page, filters]);
  const detailKey = JSON.stringify([category, detailRef]);
  const [revision, setRevision] = useState(0);
  const [, setSelectionVersion] = useState(0);
  const [facetRevision, setFacetRevision] = useState(0);
  const [facetState, setFacetState] = useState<Resource<EvimedSearchFacets>>({ key: "", status: "loading" });
  const [draftState, setDraftState] = useState({ category, query, value: query });
  const [listState, setListState] = useState<Resource<EvimedSearchResult>>({ key: "", status: "loading" });
  const [detailState, setDetailState] = useState<Resource<EvimedSearchDetail>>({ key: "", status: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const memory = useRef({
    query, epoch: 0, controller: null as AbortController | null,
    facetController: null as AbortController | null,
    views: new Map<EvimedSearchCategory, View>(),
    facets: new Map<string, Entry<EvimedSearchFacets>>(),
    selected: new Map<string, EvimedSearchItem[]>(),
    lists: new Map<string, Entry<EvimedSearchResult>>(),
    details: new Map<string, Entry<EvimedSearchDetail>>(),
    scroll: new Map<string, number>(),
  });
  const store = memory.current;
  const selectionFilters = { ...filters };
  delete selectionFilters.sort;
  const selectionKey = JSON.stringify([category, query, selectionFilters]);
  const selectedItems = store.selected.get(selectionKey) ?? [];
  const view = store.query === query ? store.views.get(category) : undefined;
  const draft = draftState.category === category && draftState.query === query ? draftState.value : view?.draft ?? query;
  const requestKey = `${detailRef ? detailKey : listKey}:${location.key}:${revision}`;
  const latestRequestKey = useRef(requestKey);
  latestRequestKey.current = requestKey;
  const listHit = store.query === query ? cached(store.lists, listKey) : undefined;
  const detailHit = store.query === query ? cached(store.details, detailKey) : undefined;
  const state: Resource<EvimedSearchResult> = listHit ? { key: requestKey, status: "success", data: listHit }
    : listState.key === requestKey ? listState : { key: requestKey, status: "loading" };
  const readerState: Resource<EvimedSearchDetail> = detailHit ? { key: requestKey, status: "success", data: detailHit }
    : detailState.key === requestKey ? detailState : { key: requestKey, status: "loading" };
  const result = state.status === "success" ? state.data : null;
  const busy = Boolean(query) && state.status === "loading";

  const facetRequestKey = `${facetKey}:${facetRevision}`;
  const facetHit = store.query === query ? cached(store.facets, facetKey) : undefined;
  const facets = facetHit ?? (facetState.key === facetRequestKey && facetState.status === "success" ? facetState.data : undefined);
  const facetsBusy = Boolean(query) && !facets && (facetState.key !== facetRequestKey || facetState.status === "loading");

  const clearRound = useCallback((nextQuery: string) => {
    store.controller?.abort();
    store.facetController?.abort();
    store.epoch += 1;
    store.query = nextQuery;
    store.views.clear();
    store.facets.clear();
    store.selected.clear();
    setSelectionVersion(value => value + 1);
    setFacetState({ key: "", status: "loading" });
    store.lists.clear();
    store.details.clear();
    store.scroll.clear();
    setListState({ key: "", status: "loading" });
    setDetailState({ key: "", status: "loading" });
  }, [store]);

  // History and direct links are authoritative; memory never rewrites their conditions.
  useLayoutEffect(() => {
    if (store.query !== query) clearRound(query);
    const previous = store.views.get(category);
    store.views.set(category, { query, search: listSearch, draft });
    if (draftState.category !== category || draftState.query !== query) {
      setDraftState({ category, query, value: previous?.query === query ? previous.draft : query });
    }
  }, [category, clearRound, draft, draftState.category, draftState.query, listSearch, query, store]);

  useEffect(() => {
    const clearSession = () => {
      clearRound("");
      setDraftState({ category, query: "", value: "" });
      navigate(`/app/search/${category}`, { replace: true });
    };
    const sync = (event: StorageEvent) => {
      if (event.key === WEB_SESSION_SYNC_STORAGE_KEY || event.key === null) clearSession();
    };
    window.addEventListener(WEB_SESSION_STARTED_EVENT, clearSession);
    window.addEventListener(WEB_SESSION_ENDED_EVENT, clearSession);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WEB_SESSION_STARTED_EVENT, clearSession);
      window.removeEventListener(WEB_SESSION_ENDED_EVENT, clearSession);
      window.removeEventListener("storage", sync);
    };
  }, [category, clearRound, navigate]);

  useEffect(() => {
    if (!query && !detailRef) return undefined;
    const controller = new AbortController();
    const epoch = store.epoch;
    store.controller = controller;
    const current = () => !controller.signal.aborted && store.epoch === epoch;
    const refused = (error: unknown) => {
      const failure = evimedSearchFailure(error);
      if (failure.action === "login") {
        store.lists.clear(); store.details.clear(); store.views.clear(); store.scroll.clear(); store.facets.clear(); store.selected.clear();
        store.facetController?.abort();
        setFacetState({ key: "", status: "loading" });
        setListState({ key: "", status: "loading" });
        setDetailState({ key: "", status: "loading" });
      }
      return failure;
    };
    if (detailRef) {
      const hit = cached(store.details, detailKey);
      if (hit) {
        const entry = store.details.get(detailKey)!;
        store.details.delete(detailKey); store.details.set(detailKey, entry);
        setDetailState({ key: requestKey, status: "success", data: hit });
      } else {
        setDetailState({ key: requestKey, status: "loading" });
        readEvimedSearchDetail(category, detailRef, controller.signal).then(data => {
          if (!current()) return;
          remember(store.details, detailKey, data);
          setDetailState({ key: requestKey, status: "success", data });
        }, (error: unknown) => { if (current()) setDetailState({ key: requestKey, status: "error", error: refused(error) }); });
      }
    } else {
      const hit = cached(store.lists, listKey);
      if (hit) {
        const entry = store.lists.get(listKey)!;
        store.lists.delete(listKey); store.lists.set(listKey, entry);
        setListState({ key: requestKey, status: "success", data: hit });
      } else {
        setListState({ key: requestKey, status: "loading" });
        searchEvimed(category, { query, page, pageSize: PAGE_SIZE, filters }, controller.signal).then(data => {
          if (!current()) return;
          remember(store.lists, listKey, data);
          for (const key of store.scroll.keys()) if (!store.lists.has(key)) store.scroll.delete(key);
          setListState({ key: requestKey, status: "success", data });
        }, (error: unknown) => { if (current()) setListState({ key: requestKey, status: "error", error: refused(error) }); });
      }
    }
    return () => controller.abort();
  }, [category, detailKey, detailRef, filters, listKey, page, query, requestKey, store]);

  // Refinement metadata does not delay results, or reload when paging, sorting or selecting a year interval.
  useEffect(() => {
    if (!query || detailRef) return undefined;
    const hit = cached(store.facets, facetKey);
    if (hit) {
      const entry = store.facets.get(facetKey)!;
      store.facets.delete(facetKey); store.facets.set(facetKey, entry);
      setFacetState({ key: facetRequestKey, status: "success", data: hit });
      return undefined;
    }
    const controller = new AbortController();
    store.facetController = controller;
    const epoch = store.epoch;
    const current = () => !controller.signal.aborted && epoch === store.epoch;
    const [facetCategory, facetQuery, requestedFilters] = JSON.parse(facetKey);
    setFacetState({ key: facetRequestKey, status: "loading" });
    readEvimedSearchFacets(facetCategory, { query: facetQuery, filters: requestedFilters }, controller.signal).then(data => {
      if (!current()) return;
      if (data.unavailable.length === 0) remember(store.facets, facetKey, data);
      setFacetState({ key: facetRequestKey, status: "success", data });
    }, (error: unknown) => {
      if (!current()) return;
      const failure = evimedSearchFailure(error);
      if (failure.action === "login") {
        store.controller?.abort();
        store.lists.clear(); store.details.clear(); store.facets.clear(); store.views.clear(); store.scroll.clear(); store.selected.clear();
        setListState({ key: latestRequestKey.current, status: "error", error: failure });
        setDetailState({ key: "", status: "loading" });
      }
      setFacetState({ key: facetRequestKey, status: "success", data: { timeline: [], groups: [], unavailable: ["filters"] } });
    });
    return () => controller.abort();
  }, [facetKey, facetRequestKey, query, detailRef, store]);

  function scroller() {
    return rootRef.current?.querySelector("[data-page-header]")?.closest<HTMLElement>(".overflow-y-auto") ?? null;
  }
  function captureScroll() {
    const element = scroller();
    if (element && !detailRef && state.status === "success") store.scroll.set(listKey, element.scrollTop);
  }
  // Listen only to rendered results; skeletons and the reader cannot overwrite a list's position.
  useLayoutEffect(() => {
    const element = scroller();
    if (!element) return undefined;
    if (detailRef) { element.scrollTop = 0; return undefined; }
    if (state.status !== "success") { element.scrollTop = 0; return undefined; }
    element.scrollTop = store.scroll.get(listKey) ?? 0;
    const save = () => { store.scroll.set(listKey, element.scrollTop); };
    element.addEventListener("scroll", save, { passive: true });
    return () => element.removeEventListener("scroll", save);
  }, [detailRef, listKey, state.status, store]);

  function setDraft(value: string) {
    setDraftState({ category, query, value });
    store.views.set(category, { query, search: listSearch, draft: value });
  }
  function update(values: Record<string, string | null>) {
    captureScroll();
    const next = new URLSearchParams(listSearch);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value); else next.delete(name);
    }
    // A changed filter starts at the top even if that exact page was seen earlier.
    if (Object.keys(values).some(name => name !== "page")) {
      for (const key of store.scroll.keys()) if (JSON.parse(key)[0] === category) store.scroll.delete(key);
    }
    if (Object.keys(values).some(name => name !== "page" && name !== "sort")) {
      for (const key of store.selected.keys()) if (JSON.parse(key)[0] === category) store.selected.delete(key);
      setSelectionVersion(value => value + 1);
    }
    setParams(next);
  }
  function refresh(resetPage: boolean) {
    for (const key of store.selected.keys()) if (JSON.parse(key)[0] === category) store.selected.delete(key);
    setSelectionVersion(value => value + 1);
    store.controller?.abort();
    store.facetController?.abort();
    for (const key of store.facets.keys()) if (JSON.parse(key)[0] === category) store.facets.delete(key);
    setFacetState({ key: "", status: "loading" });
    for (const key of store.lists.keys()) if (JSON.parse(key)[0] === category) store.lists.delete(key);
    for (const key of store.details.keys()) if (JSON.parse(key)[0] === category) store.details.delete(key);
    const next = new URLSearchParams(listSearch);
    if (resetPage) {
      next.delete("page");
      for (const key of store.scroll.keys()) if (JSON.parse(key)[0] === category) store.scroll.delete(key);
    }
    setParams(next);
    setFacetRevision(value => value + 1);
  }
  function submit() {
    if (composing.current || !draft.trim()) return;
    const nextQuery = draft.trim();
    if (nextQuery === query) { if (!busy) refresh(true); return; }
    clearRound(nextQuery);
    setDraftState({ category, query: nextQuery, value: nextQuery });
    setParams({ q: nextQuery });
  }
  function clearSearch() {
    clearRound("");
    setDraftState({ category, query: "", value: "" });
    setParams({});
  }
  function switchCategory(value: string) {
    const nextCategory = evimedSearchCategory(value);
    if (nextCategory === category) return;
    captureScroll();
    store.views.set(category, { query, search: listSearch, draft });
    if (!query) {
      // Before the first search, categories scope the same input rather than restoring result-page drafts.
      store.views.set(nextCategory, { query: "", search: "", draft });
      setDraftState({ category: nextCategory, query: "", value: draft });
      navigate(`/app/search/${nextCategory}`);
      return;
    }
    const target = store.views.get(nextCategory);
    const search = target?.query === query ? target.search : new URLSearchParams(query ? { q: query } : {}).toString();
    navigate(`/app/search/${nextCategory}${search ? `?${search}` : ""}`);
  }
  function selectItems(items: EvimedSearchItem[], selected: boolean) {
    const selection = new Map((store.selected.get(selectionKey) ?? []).map(item => [item.id, item]));
    for (const item of items) {
      if (selected && selection.size < 20) selection.set(item.id, item);
      else if (!selected) selection.delete(item.id);
    }
    if (selection.size) store.selected.set(selectionKey, [...selection.values()]); else store.selected.delete(selectionKey);
    setSelectionVersion(value => value + 1);
  }
  function updateCollected(actionRef: string, collected: boolean) {
    // Update every cached appearance of the same record, including selected export snapshots.
    const currentItem = result?.items.find(item => item.actionRef === actionRef);
    const currentId = currentItem?.id ?? (readerState.status === "success" && readerState.data.actionRef === actionRef ? readerState.data.id : undefined);
    const matches = (item: EvimedSearchItem) => item.actionRef === actionRef || Boolean(currentId && item.id === currentId);
    for (const entry of store.lists.values()) {
      if (entry.data.category !== category) continue;
      entry.data = { ...entry.data, items: entry.data.items.map(item => matches(item) ? { ...item, collected } : item) };
    }
    for (const [key, entry] of store.details) {
      if (JSON.parse(key)[0] === category && (entry.data.actionRef === actionRef || Boolean(currentId && entry.data.id === currentId))) entry.data = { ...entry.data, collected };
    }
    for (const [key, items] of store.selected) {
      if (JSON.parse(key)[0] === category) store.selected.set(key, items.map(item => matches(item) ? { ...item, collected } : item));
    }
    if (listState.status === "success") setListState({ ...listState, data: { ...listState.data, items: listState.data.items.map(item => matches(item) ? { ...item, collected } : item) } });
    if (detailState.status === "success" && (detailState.data.actionRef === actionRef || Boolean(currentId && detailState.data.id === currentId))) {
      setDetailState({ ...detailState, data: { ...detailState.data, collected } });
    }
    setSelectionVersion(value => value + 1);
  }
  return {
    selectedItems, selectItems, clearSelection: () => { store.selected.delete(selectionKey); setSelectionVersion(value => value + 1); }, updateCollected,
    rootRef, category, params: listParams, query, page, detailRef, language, sort, source, scholarly, filters, facets, facetsBusy,
    draft, setDraft, composing, result, state, readerState, busy, update, submit, clearSearch, switchCategory,
    resetFilters: () => update(Object.fromEntries([...EVIMED_SEARCH_FILTER_KEYS, "page"].map(key => [key, null]))),
    retryFacets: () => { store.facets.delete(facetKey); setFacetRevision(value => value + 1); },
    retrySearch: () => refresh(false), retryCurrent: () => refresh(false),
    retryDetail: () => { store.details.delete(detailKey); setRevision(value => value + 1); },
    backTo: `${location.pathname}${listSearch ? `?${listSearch}` : ""}`,
    currentPath: `${location.pathname}${location.search}`,
  };
}
