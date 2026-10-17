/**
 * What a source is to the project, said by the kinds of site the engines cite and by where the brand could place an article
 * (R19, audit C §2.3 信源 and A.5 信源 row).
 *
 * Two questions share one page: 「AI 引用谁」 — the sites the engines cited in the latest round, counted — and 「可投放」 — the sites an
 * article could go to. The first is read from the sources route's rows; the second from the sources each action carries, which are
 * the market's own ranking (`rankOutlets`, r19-geos §5), so what this page lists as placeable is what an order would use and is never
 * worked out again here.
 */
import type { GeoAction, GeoActionSource, GeoSourceLayer, GeoSourceRow } from "@/lib/geoClient";
import { sourceKindWord } from "../tabs/geoTabText";

/** The kind a source row is counted under: the server's kind, and 「其他」 where it gave none. */
export const OTHER_KIND = "other";

export function kindOf(source: Pick<GeoSourceRow, "kind">): { key: string; label: string } {
  const key = source.kind?.trim() || OTHER_KIND;
  return { key, label: key === OTHER_KIND ? "其他" : sourceKindWord(key) ?? "其他" };
}

export interface KindCount {
  key: string;
  label: string;
  /** Sites of this kind, and the answers that cited them. */
  sites: number;
  citations: number;
}

/** The kinds of site, the most cited first. `citationsOf` is the row's count for the engine in view. */
export function kindCounts<T extends Pick<GeoSourceRow, "kind">>(sources: readonly T[], citationsOf: (source: T) => number): KindCount[] {
  const counts = new Map<string, KindCount>();
  for (const source of sources) {
    const kind = kindOf(source);
    const cited = citationsOf(source);
    const entry = counts.get(kind.key) ?? { key: kind.key, label: kind.label, sites: 0, citations: 0 };
    entry.sites += 1;
    entry.citations += cited;
    counts.set(kind.key, entry);
  }
  // Two server kinds can share a reader's word (「百科」 and `encyclopedia`): one bar, not two of the same name.
  const merged = new Map<string, KindCount>();
  for (const entry of counts.values()) {
    const found = merged.get(entry.label);
    if (found) {
      found.sites += entry.sites;
      found.citations += entry.citations;
    } else merged.set(entry.label, { ...entry });
  }
  return [...merged.values()].sort((left, right) => right.citations - left.citations || right.sites - left.sites);
}

/** A source the market lists, or the brand's own: the server's word that an article can go there. */
export const isPlaceable = (source: Pick<GeoSourceRow, "market" | "layer">): boolean => source.market !== null || source.layer === "owned";

/** All three conditions are checked and met. An unchecked one (null) is not met. */
export const conditionsVerified = (source: Pick<GeoSourceRow, "conditions">): boolean =>
  source.conditions.icp === true && source.conditions.newsIndexed === true && source.conditions.medical === true;

/* ------------------------------------------------------------- candidates */

/** One place an article could go, once, with every action that would send one there. */
export interface Candidate {
  key: string;
  name: string;
  /** A website; null for the brand's own channel (then `channel` names it). */
  domain: string | null;
  channel: string | null;
  kind: string | null;
  layer: GeoSourceLayer | null;
  route: GeoActionSource["route"];
  /** Would an order be placed there now (the market's answer); null where it was not asked. */
  available: boolean | null;
  unavailableBecause: string[];
  price: number | null;
  conditions: GeoActionSource["conditions"];
  /** The engines that cite it for these actions. */
  engines: string[];
  /** The question groups whose actions list it, once each. */
  groups: Array<{ id: string; name: string }>;
  /** Actions that list it. */
  actions: number;
  why: string | null;
}

const ROUTE_ORDER: Readonly<Record<string, number>> = { market: 0, own: 1, waiting_market: 2, not_in_market: 3 };

/** The places the actions send articles to, merged by site (or channel), the placeable first and then those that serve most groups. */
export function candidatesOf(actions: readonly GeoAction[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const action of actions) {
    if (action.choice?.skipped) continue;
    for (const source of action.sources) {
      const key = source.domain ?? (source.channel ? `channel:${source.channel}` : null);
      if (!key) continue;
      const found = byKey.get(key);
      const candidate: Candidate = found ?? {
        key,
        name: source.name || source.domain || "",
        domain: source.domain,
        channel: source.channel,
        kind: source.kind,
        layer: source.layer,
        route: source.route,
        available: source.available,
        unavailableBecause: [...source.unavailableBecause],
        price: source.price,
        conditions: source.conditions,
        engines: [],
        groups: [],
        actions: 0,
        why: source.why,
      };
      candidate.actions += 1;
      for (const engine of Object.keys(source.citedFor ?? {})) if (!candidate.engines.includes(engine)) candidate.engines.push(engine);
      if (action.group && !candidate.groups.some((group) => group.id === action.group!.id)) candidate.groups.push({ id: action.group.id, name: action.group.name });
      // The better statement of the same place wins: an available one over an unavailable, a priced over an unpriced.
      if (found) {
        if (found.available !== true && source.available === true) {
          found.available = true;
          found.route = source.route;
          found.unavailableBecause = [...source.unavailableBecause];
        }
        if (found.price === null && source.price !== null) found.price = source.price;
        if (!found.why && source.why) found.why = source.why;
      }
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    (ROUTE_ORDER[left.route ?? ""] ?? 9) - (ROUTE_ORDER[right.route ?? ""] ?? 9)
    || right.groups.length - left.groups.length
    || right.actions - left.actions);
}

/** Every domain the actions of one group send an article to: the group's side of 「与某群相关」. */
export function domainsOfGroup(actions: readonly GeoAction[], groupId: string): Set<string> {
  const domains = new Set<string>();
  for (const action of actions) {
    if (action.group?.id !== groupId) continue;
    for (const source of action.sources) if (source.domain) domains.add(source.domain);
  }
  return domains;
}

/** The groups whose actions list a site: the drawer's 「涉及的问题群」. */
export function groupsOfDomain(actions: readonly GeoAction[], domain: string): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const action of actions) {
    if (!action.group || !action.sources.some((source) => source.domain === domain)) continue;
    seen.set(action.group.id, action.group.name);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}
