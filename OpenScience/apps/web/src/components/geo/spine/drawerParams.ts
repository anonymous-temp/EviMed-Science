import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * The address of the two records of a project that open in a drawer over whatever page the person is on (page-structure rule 2:
 * a record opens in the right-hand drawer and the list stays where it is):
 *
 *  - `?group=<id>` — the question group (`ClusterDrawer`). Every place a group's name appears is a link to this address on the
 *    page it is on; a page that cannot host the drawer sends the link to 问题与回答, which can.
 *  - `?action=<key>` — one action (`ActionDrawer`), on 行动.
 *  - `?error=<claim key>` — one wrong claim (`ErrorDrawer`), on 准确与安全.
 *  - `?on=<engine>` — the engine a group's drawer rests on (a cell of the group × engine matrix was pressed).
 *
 * A page's own filters are other words (`cluster`, `pool`, `show` …) so that a link meaning "this group's drawer" and one meaning
 * "this page, narrowed to this group" cannot be mistaken for one another. The bar keeps every other parameter a link does not name.
 */
export const GEO_GROUP_PARAM = "group";
export const GEO_ACTION_PARAM = "action";
export const GEO_ERROR_PARAM = "error";
/** A tab's own narrowing to one engine (a filter, not the drawer). */
export const GEO_ENGINE_PARAM = "engine";
/** The engine a group's drawer rests on. */
export const GEO_DRAWER_ENGINE_PARAM = "on";
/** A tab's own narrowing to one question group (a filter, not the drawer). */
export const GEO_CLUSTER_FILTER_PARAM = "cluster";
export const GEO_POOL_PARAM = "pool";
export const GEO_SOURCE_PARAM = "source";

/** The query string after the named changes (`null` removes a parameter); every other parameter is kept as it is. */
export function searchWith(search: string, changes: Readonly<Record<string, string | null | undefined>>): string {
  const params = new URLSearchParams(search);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") params.delete(name);
    else params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The drawer a page is showing and the ways to open and close it. Opening one closes the other: there is one drawer. */
export function useGeoDrawerAddress() {
  const [params, setParams] = useSearchParams();
  const group = params.get(GEO_GROUP_PARAM);
  const action = params.get(GEO_ACTION_PARAM);
  const error = params.get(GEO_ERROR_PARAM);
  const engine = params.get(GEO_DRAWER_ENGINE_PARAM);
  const open = useCallback((next: { group?: string | null; action?: string | null; error?: string | null; engine?: string | null }) => {
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      copy.delete(GEO_GROUP_PARAM);
      copy.delete(GEO_ACTION_PARAM);
      copy.delete(GEO_ERROR_PARAM);
      copy.delete(GEO_DRAWER_ENGINE_PARAM);
      if (next.engine) copy.set(GEO_DRAWER_ENGINE_PARAM, next.engine);
      if (next.group) copy.set(GEO_GROUP_PARAM, next.group);
      if (next.action) copy.set(GEO_ACTION_PARAM, next.action);
      if (next.error) copy.set(GEO_ERROR_PARAM, next.error);
      return copy;
    });
  }, [setParams]);
  const close = useCallback(() => {
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      copy.delete(GEO_GROUP_PARAM);
      copy.delete(GEO_ACTION_PARAM);
      copy.delete(GEO_ERROR_PARAM);
      copy.delete(GEO_DRAWER_ENGINE_PARAM);
      return copy;
    }, { replace: true });
  }, [setParams]);
  return { group, action, error, engine, open, close };
}

/** One parameter of the address as state: read, and written in place (a filter is not a step in the history). */
export function useGeoSearchParam(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name);
  const set = useCallback((next: string | null) => {
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      if (next === null || next === "") copy.delete(name);
      else copy.set(name, next);
      return copy;
    }, { replace: true });
  }, [name, setParams]);
  return [value, set];
}

/**
 * Several parameters of the address changed in one step, in place. Two calls of {@link useGeoSearchParam} in one handler do not add
 * up: each starts from the address the page last drew, so the later one writes the earlier one's old value back. A choice that
 * lets go of more than one thing (the toolbar's 「清除筛选」, a pool that takes its group with it) goes through this.
 */
export function useGeoSearchChange(): (changes: Readonly<Record<string, string | null | undefined>>) => void {
  const [, setParams] = useSearchParams();
  return useCallback((changes) => {
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      for (const [name, value] of Object.entries(changes)) {
        if (value === null || value === undefined || value === "") copy.delete(name);
        else copy.set(name, value);
      }
      return copy;
    }, { replace: true });
  }, [setParams]);
}
