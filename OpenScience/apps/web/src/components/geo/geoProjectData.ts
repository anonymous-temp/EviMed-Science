import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { webErrorMessage, WebApiError } from "@/lib/apiClient";
import {
  getGeoDiagnosis,
  getGeoEvidence,
  getGeoMonitoring,
  getGeoStrategy,
  getGeoValue,
  isGeoOff,
  type GeoDiagnosis,
  type GeoEvidence,
  type GeoMonitoring,
  type GeoStrategyView,
  type GeoValue,
} from "@/lib/geoClient";
import { GeoFrameContext } from "./geoFrame";

/**
 * One project's data, read once (R19, audit C class 4.5).
 *
 * The diagnosis was fetched by three tabs under three keys, the monitoring by four, the value analysis by every one: a tab switch
 * was a request, and the same project said the same number three times from three answers. The layout owns a `GeoDataCache`, a read
 * is keyed by what it is **of** — `diagnosis:<project>` — and not by the tab asking, and the five reads of the project
 * (`useGeoDiagnosis`, `useGeoMonitoring`, `useGeoValue`, `useGeoEvidence`, `useGeoStrategy`) go through it: the cache's when a
 * layout is above them and the tab's own fetch when none is (a tab rendered alone, a test). What belongs to one tab or one drawer —
 * its list, a source's detail — is `useGeoLoad`, read when the tab opens.
 *
 *  - a tab that arrives finds the read already there and draws it at once; one older than {@link STALE_MS} is read again behind
 *    the data it shows, which stays on the screen — the page never goes back to a skeleton for a refresh;
 *  - `reload()` reads again and keeps what is shown until the answer comes (an action's refresh does not flash);
 *  - `invalidate()` marks everything stale and re-reads what is on screen: the layout calls it when a step of the programme changes
 *    state, so the rail and the numbers move together;
 *  - a read that failed is an error with 重试, and is read again the next time a tab asks.
 */

export type GeoLoad<T> =
  | { kind: "loading" }
  /** `off`: the module is not open to this account; `missing`: nothing at that address. */
  | { kind: "error"; message: string; off: boolean; missing: boolean }
  | { kind: "ready"; data: T };

export interface GeoLoadResult<T> {
  state: GeoLoad<T>;
  reload: () => void;
}

/** How long a read is current. A tab switch inside it fetches nothing; one after it reads again behind what is drawn. */
export const STALE_MS = 30_000;

const LOADING: GeoLoad<never> = { kind: "loading" };

function failed(error: unknown): GeoLoad<never> {
  return {
    kind: "error",
    message: webErrorMessage(error, { fallback: "暂时无法读取，请稍后重试。" }),
    off: isGeoOff(error),
    missing: error instanceof WebApiError && error.status === 404 && !isGeoOff(error),
  };
}

interface Entry {
  state: GeoLoad<unknown>;
  /** When the state last became data; 0 is stale. */
  loadedAt: number;
  /** The latest read's number: an answer to an earlier one is dropped. */
  epoch: number;
  reading: boolean;
  loader: () => Promise<unknown>;
  watchers: number;
}

export class GeoDataCache {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /** The read's state: stable until it changes. */
  snapshot = (key: string): GeoLoad<unknown> => this.#entries.get(key)?.state ?? LOADING;

  /**
   * A consumer begins to read `key`. Returns what ends it. The read starts when nothing has it, when it failed, or when it is older
   * than {@link STALE_MS}; the loader is the consumer's latest.
   */
  watch(key: string, loader: () => Promise<unknown>): () => void {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { state: LOADING, loadedAt: 0, epoch: 0, reading: false, loader, watchers: 0 };
      this.#entries.set(key, entry);
    }
    entry.loader = loader;
    entry.watchers += 1;
    if (!entry.reading && (entry.state.kind !== "ready" || this.#now() - entry.loadedAt > STALE_MS)) this.#read(entry);
    const held = entry;
    return () => { held.watchers = Math.max(0, held.watchers - 1); };
  }

  /** Read `key` again now, keeping what is shown until the answer comes. */
  reload(key: string): void {
    const entry = this.#entries.get(key);
    if (entry) this.#read(entry);
  }

  /** Everything is stale: what a tab is showing is read again behind itself, the rest the next time a tab asks. */
  invalidate(): void {
    for (const entry of this.#entries.values()) {
      entry.loadedAt = 0;
      if (entry.watchers > 0) this.#read(entry);
    }
  }

  #read(entry: Entry): void {
    entry.reading = true;
    entry.epoch += 1;
    const epoch = entry.epoch;
    void Promise.resolve()
      .then(() => entry.loader())
      .then(
        (data) => {
          if (entry.epoch !== epoch) return;
          entry.state = { kind: "ready", data };
          entry.loadedAt = this.#now();
        },
        (error: unknown) => {
          if (entry.epoch !== epoch) return;
          entry.state = failed(error);
          entry.loadedAt = 0;
        },
      )
      .finally(() => {
        if (entry.epoch !== epoch) return;
        entry.reading = false;
        for (const listener of this.#listeners) listener();
      });
  }
}

const NO_SUBSCRIBE = () => () => {};

/** A tab that has no layout above it: its own read, once per `key`, and again on `reload()`. */
function useStandaloneLoad<T>(key: string, load: () => Promise<T>, enabled: boolean): GeoLoadResult<T> {
  const [state, setState] = useState<GeoLoad<T>>(LOADING);
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const shownKey = useRef(key);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    if (shownKey.current !== key) {
      shownKey.current = key;
      setState(LOADING);
    }
    Promise.resolve()
      .then(() => loader.current())
      .then(
        (data) => { if (live) setState({ kind: "ready", data }); },
        (error: unknown) => { if (live) setState(failed(error)); },
      );
    return () => { live = false; };
  }, [key, round, enabled]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { state, reload };
}

/**
 * Reads a route once per `key`, and again on `reload()`. While a reload is in flight the last answer stays on screen, so an
 * action's refresh does not flash a skeleton; a first read that fails is an error with 重试. This is a tab's **own** read — the
 * articles, the questions, a source's detail: each is read when the tab (or the drawer) opens, as it always was.
 */
export function useGeoLoad<T>(key: string, load: () => Promise<T>): GeoLoadResult<T> {
  return useStandaloneLoad<T>(key, load, true);
}

/**
 * A read that belongs to the **project** and not to the tab that asked: inside a project's layout it is the layout's cache's, shared
 * by every tab that asks for the same key and current for {@link STALE_MS}; where there is no layout (a tab rendered alone) it is the
 * caller's own, as `useGeoLoad`. The key names what is read, not who reads it: `diagnosis:<id>`, never `accuracy:diagnosis:<id>`.
 */
export function useSharedGeoLoad<T>(key: string, load: () => Promise<T>): GeoLoadResult<T> {
  const cache = useContext(GeoFrameContext)?.data ?? null;
  const loader = useRef(load);
  loader.current = load;
  const standalone = useStandaloneLoad<T>(key, load, cache === null);
  const shared = useSyncExternalStore(cache ? cache.subscribe : NO_SUBSCRIBE, () => (cache ? cache.snapshot(key) : LOADING)) as GeoLoad<T>;
  useEffect(() => (cache ? cache.watch(key, () => loader.current()) : undefined), [cache, key]);
  const reload = useCallback(() => { cache?.reload(key); }, [cache, key]);
  return cache ? { state: shared, reload } : standalone;
}

/* ----------------------------------------------------- what every tab shares */

export const useGeoDiagnosis = (geoId: string) => useSharedGeoLoad<GeoDiagnosis>(`diagnosis:${geoId}`, () => getGeoDiagnosis(geoId));
export const useGeoMonitoring = (geoId: string) => useSharedGeoLoad<GeoMonitoring>(`monitoring:${geoId}`, () => getGeoMonitoring(geoId));
export const useGeoValue = (geoId: string) => useSharedGeoLoad<GeoValue>(`value:${geoId}`, () => getGeoValue(geoId));
export const useGeoEvidence = (geoId: string) => useSharedGeoLoad<GeoEvidence>(`evidence:${geoId}`, () => getGeoEvidence(geoId));
export const useGeoStrategy = (geoId: string) => useSharedGeoLoad<GeoStrategyView>(`strategy:${geoId}`, () => getGeoStrategy(geoId));
