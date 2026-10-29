/**
 * The small decisions of a topic zone's page that are not layout (ez-web-zone, owner 2026-10-29): where the zone and its tabs are
 * addressed, how the 动态 tab's filters live in the address, how a count in the header or a bar of the weekly chart becomes a filter,
 * which line says whose zone it is, and the draft 「深入研究」 opens the conversation with.
 *
 * Pure functions only, so each is tested once (`zoneText.test.ts`) and the components stay about layout.
 */
import type { FrontierItem } from "@/lib/frontierClient";
import {
  ZONE_ROLES,
  ZONE_ROLE_LABELS,
  type ZoneDetail,
  type ZoneItemsWindow,
  type ZoneOverview,
  type ZoneProgress,
  type ZoneRole,
  type ZoneSummary,
} from "@/lib/evidenceTopicClient";
import { cardEyebrow, feedDay, feedDayKey, itemLine } from "../frontierText";

/** The page's three views; the address holds the tab (`?tab=`) and 概览 is the one with none. */
export type ZoneTab = "overview" | "items" | "cards";

/** The address of a zone: its readable name when it has one, else its id. */
export function zonePath(zone: Pick<ZoneSummary, "id" | "slug">): string {
  return zone.slug ? `/app/frontier/zones/s/${encodeURIComponent(zone.slug)}` : `/app/frontier/zones/${encodeURIComponent(zone.id)}`;
}

/** The address of an item's reading page. */
export const articlePath = (id: string) => `/app/frontier/items/${encodeURIComponent(id)}`;

/** The address of an event's page (「N 家机构报道」). */
export const eventPath = (id: string) => `/app/frontier/events/${encodeURIComponent(id)}`;

/** The tab an address names; anything else is 概览, and 证据卡片 is only a tab of a zone that has cards. */
export function zoneTabOf(value: string | null, hasCards: boolean): ZoneTab {
  if (value === "items") return "items";
  return value === "cards" && hasCards ? "cards" : "overview";
}

/** What the 动态 tab shows: the filters that live in the address, so a reload and a shared link show the same list. */
export interface ZoneItemsView {
  role: ZoneRole | null;
  /** 精选 only. */
  picked: boolean;
  /** `null`: the reader has not chosen, and the tab opens on the last 30 days (wider, while that is empty). */
  window: ZoneItemsWindow | null;
  q: string;
  /** `YYYY-MM-DD` of the Monday a bar of the weekly chart stands for: the list narrows to that week. */
  week: string | null;
}

export const EMPTY_ITEMS_VIEW: ZoneItemsView = { role: null, picked: false, window: null, q: "", week: null };

const WINDOWS: readonly ZoneItemsWindow[] = ["7d", "30d", "90d", "all"];

/** The tab's filters as the address says them; a value that is not one of the vocabulary's is ignored. */
export function readItemsView(params: URLSearchParams): ZoneItemsView {
  const role = params.get("role");
  const window = params.get("window");
  const week = params.get("week");
  return {
    role: ZONE_ROLES.includes(role as ZoneRole) ? (role as ZoneRole) : null,
    picked: params.get("picked") === "1",
    window: WINDOWS.includes(window as ZoneItemsWindow) ? (window as ZoneItemsWindow) : null,
    q: (params.get("q") ?? "").slice(0, 200),
    week: week && /^\d{4}-\d{2}-\d{2}/.test(week) ? week.slice(0, 10) : null,
  };
}

/** A zone's 动态 tab as query parameters; what is not set is not written. */
export function itemsParams(view: Partial<ZoneItemsView>): URLSearchParams {
  const params = new URLSearchParams({ tab: "items" });
  if (view.role) params.set("role", view.role);
  if (view.picked) params.set("picked", "1");
  if (view.window) params.set("window", view.window);
  if (view.q) params.set("q", view.q);
  if (view.week) params.set("week", view.week);
  return params;
}

/** The address of a zone's 动态 tab under the given filters. */
export function itemsHref(path: string, view: Partial<ZoneItemsView>): string {
  return `${path}?${itemsParams(view).toString()}`;
}

/** The time windows the tab offers, in the words of its chips. */
export const WINDOW_OPTIONS: ReadonlyArray<{ value: ZoneItemsWindow; label: string }> = [
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "90d", label: "90 天" },
  { value: "all", label: "全部" },
];

/** The window the tab opens on while the reader has chosen none, and the wider ones it falls back to while that holds nothing. */
export const DEFAULT_WINDOW: ZoneItemsWindow = "30d";
export const WIDER_WINDOW: Readonly<Partial<Record<ZoneItemsWindow, ZoneItemsWindow>>> = { "7d": "30d", "30d": "90d", "90d": "all" };

/* --------------------------------------------------------------------- weeks */

const DAY = 86_400_000;

/** The `YYYY-MM-DD` of a week's last day (a week is seven days from its first). */
export function weekEnd(weekStart: string): string {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
}

/**
 * The narrowest window the server offers that still holds a week: the 7 days, 30, 90, or all of it. The server filters by window
 * only, so a bar of the chart asks for this and the page cuts the list to the week itself.
 */
export function weekWindow(weekStart: string, now = Date.now()): ZoneItemsWindow {
  const start = Date.parse(`${weekStart}T00:00:00+08:00`);
  if (Number.isNaN(start)) return "all";
  const days = (now - start) / DAY;
  return days <= 7 ? "7d" : days <= 30 ? "30d" : days <= 90 ? "90d" : "all";
}

/** Whether an item was published in the week that begins on `weekStart` (Beijing days, as the list cuts them). */
export function inWeek(item: Pick<FrontierItem, "timelineAt">, weekStart: string): boolean {
  const day = feedDayKey(item.timelineAt);
  return day !== null && day >= weekStart && day <= weekEnd(weekStart);
}

/** 「10月19日起一周」: a bar of the weekly chart, and the mark of the filter it sets. */
export function weekLabel(weekStart: string, now = Date.now()): string {
  const day = feedDay(`${weekStart}T00:00:00+08:00`, now);
  return day ? `${day}起一周` : weekStart;
}

/* -------------------------------------------------------------------- header */

/** Whose zone it is, as the header says it; none for a platform zone, which is nobody's in particular. */
export function zoneOwnerLine(zone: Pick<ZoneDetail, "kind" | "canEdit" | "published" | "creator">): string | null {
  if (zone.kind !== "user") return null;
  if (zone.canEdit) return zone.published ? "我的专区 · 已公开" : "我的专区";
  return zone.creator ? `${zone.creator} 创建` : "读者创建";
}

/** The specialties a zone belongs to, in the reader's words. */
export function zoneSpecialties(zone: Pick<ZoneSummary, "specialties">): string {
  return zone.specialties.map((entry) => entry.label).filter(Boolean).join("、");
}

/* --------------------------------------------------------------------- items */

/** 「丁香园 · 10月29日 · 指南共识」: the one meta line of a compact row of the overview. */
export function itemMeta(item: FrontierItem, now = Date.now()): string {
  return [item.source.name, feedDay(item.timelineAt, now), cardEyebrow(item)].filter(Boolean).join(" · ");
}

/** The roles the 动态 tab offers as chips: 全部, then each role the window holds items of, with its count; none with 0. */
export function roleOptions(counts: Partial<Record<ZoneRole, number>>, all: number | null): Array<{ value: string; label: string; count?: number }> {
  const present = ZONE_ROLES.filter((role) => (counts[role] ?? 0) > 0);
  return [
    { value: "", label: "全部", ...(all !== null ? { count: all } : {}) },
    ...present.map((role) => ({ value: role, label: ZONE_ROLE_LABELS[role], count: counts[role] })),
  ];
}

/* ------------------------------------------------------------------ research */

/** The citation marks of a 最新进展 text (`[3]`), which mean nothing outside the page that lists their items. */
const MARK = /\[\d{1,2}\]/g;

/** The 最新进展 as words, without the marks that point at the page's list. */
export function progressText(progress: Pick<ZoneProgress, "text">): string {
  return progress.text.replace(MARK, "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * 「深入研究」: the question a conversation about the zone opens with, as an unsent draft — the zone's scope, what is new, and the items
 * of its key updates by the line the assistant reads them through (`frontier:<id>`). Built from what the page holds; a zone whose
 * overview has not loaded still gets its name and scope.
 */
export function zoneResearchDraft(zone: Pick<ZoneDetail, "title" | "scope">, overview: ZoneOverview | null): string {
  const progress = overview?.modules.find((module) => module.key === "progress");
  const updates = overview?.modules.find((module) => module.key === "key-updates");
  const lines = [
    `请围绕“${zone.title}”做一次深入研究：近期有哪些重要进展，证据有多强，指南和监管有什么变化，对临床实践和我的研究意味着什么。`,
    "",
    ...(zone.scope ? [`范围：${zone.scope}`] : []),
    ...(progress?.key === "progress" ? [`最新进展：${progressText(progress.progress)}`] : []),
    ...(updates && "items" in updates && updates.items.length > 0 ? ["重要更新：", ...updates.items.slice(0, 6).map((item) => itemLine(item))] : []),
  ];
  return lines.join("\n");
}
