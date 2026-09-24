/**
 * 「前沿动态」 — the browser's side of `/api/frontier/*`.
 *
 * Hidden knowledge:
 *
 *  - Every route answers in the platform's `{ data }` envelope, so every call
 *    goes through `productRequest`, which unwraps it and turns a refusal into a
 *    `WebApiError` carrying the named code. Nothing here reads a raw body.
 *  - The read path is cached by the browser, not by this file. The list routes
 *    send `ETag` + `Cache-Control: private, no-cache`; a 304 is answered from
 *    the browser's cache and reaches `fetch` as the 200 it revalidated. Hand-
 *    rolled ETag handling here would be a second cache that can disagree with
 *    the first.
 *  - A list cursor is opaque and names the axis, the view and the content
 *    version it was minted under. When the selected set changes while a reader
 *    pages, the server answers `400 invalid_cursor` — on purpose, instead of
 *    silently continuing from somewhere else — and `listFrontierItems` starts
 *    over from page one and says so (`restarted`), so the page replaces its
 *    list rather than appending a page that no longer follows it.
 *  - The module can be off, or offered only to operators; either way every
 *    route answers 404 `frontier_not_enabled`. The routes of the second wave
 *    (for-you, hot, events, dailies, save-to-library, abstract-zh) may simply
 *    not exist yet on a given server: those answer 404 `not_found`. The
 *    wave-two readers below return `null` for both, so a block that has
 *    nothing behind it is hidden or says 「还在准备」, and never breaks the page.
 *  - Nothing a response carries is rendered unread. Items are parsed field by
 *    field, so a field the page does not know — a dimension's score, a model
 *    name — never reaches the DOM. Since 2026-09-24 a card shows one number,
 *    the editorial total (`score`, plan 2026-09-23 §6.2 编辑评分) with its
 *    band; the four dimensions behind it stay words (`levels`), and that is
 *    enforced here, not remembered at each render. A link is kept only when it
 *    is http(s).
 *  - Heat is shown as the server shows it: a whole number (heat × 10), with
 *    the hot list's rank change, badge and trend, and the event page's side
 *    column. How it is computed, in the reader's words, is `@evimed/domain`'s
 *    `FRONTIER_HEAT_METHOD_ZH` (「热度怎么算」), stated from the same numbers.
 */
import { useEffect, useState } from "react";
import {
  FRONTIER_ITEM_FLAG_LABELS_ZH,
  FRONTIER_LANE_LABELS_ZH,
  FRONTIER_LANES as LANE_KEYS,
  FRONTIER_SPECIALTIES as SPECIALTY_KEYS,
  FRONTIER_SPECIALTY_LABELS_ZH,
} from "@evimed/domain";
import { fetchWebMe, WebApiError, webErrorMessage, type WebMe } from "./apiClient";
import { productRequest } from "./productClient";

/* ---------------------------------------------------------------- vocabulary */

/** One closed-vocabulary value with the reader's word for it. */
export interface FrontierLabelled {
  key: string;
  label: string;
}

/**
 * The eight lanes, in the order the filter row offers them — derived from
 * `@evimed/domain`'s frontier vocabulary, the table the server labels every
 * item with, so a filter pill and a card can never name one lane twice.
 * `mixed` is not among them: the screening model resolves it per item and a
 * reader never sees it.
 */
export const FRONTIER_LANES: readonly FrontierLabelled[] = Object.freeze(
  LANE_KEYS.map((key) => ({ key, label: FRONTIER_LANE_LABELS_ZH[key] })),
);

/** The twenty-one specialties the dropdown offers, in the vocabulary's order. */
export const FRONTIER_SPECIALTIES: readonly FrontierLabelled[] = Object.freeze(
  SPECIALTY_KEYS.map((key) => ({ key, label: FRONTIER_SPECIALTY_LABELS_ZH[key] })),
);

/**
 * Item flags, for the one case the server sent a key without its word. The
 * server's label wins whenever it sent one; a key in neither is dropped rather
 * than printed (a code on screen is a code the reader has to learn).
 */
const FLAG_LABELS: Readonly<Record<string, string>> = FRONTIER_ITEM_FLAG_LABELS_ZH;

const LANE_LABELS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(FRONTIER_LANES.map((lane) => [lane.key, lane.label])));
const SPECIALTY_LABELS: Readonly<Record<string, string>> = FRONTIER_SPECIALTY_LABELS_ZH;

/* --------------------------------------------------------------------- shapes */

export type FrontierView = "selected" | "all";
export type FrontierAxis = "timeline" | "published";
export type FrontierWindow = "24h" | "3d" | "7d" | "30d";
export const FRONTIER_WINDOWS: readonly FrontierWindow[] = Object.freeze(["24h", "3d", "7d", "30d"]);
export type FrontierLevel = "high" | "medium" | "low";
/** The band an editorial score reads in: at or above the selection line, from 60 up to it, below 60. */
export type FrontierScoreBand = "high" | "medium" | "low";
export type FrontierVerification = "pending" | "passed" | "repaired" | "title-only";
export type FrontierDatePrecision = "instant" | "day" | "inferred";
export type FrontierSearchMode = "list" | "keyword" | "hybrid";
/** How a search is ordered: by relevance (the default), or the matches newest first. A list is always newest first. */
export type FrontierSearchSort = "relevance" | "time";

export interface FrontierItemState {
  starred: boolean;
  hidden: boolean;
  read: boolean;
}

/** One enrichment fact: a word, a number, a yes/no, a list, or a small record of those. */
export type FrontierFact = string | number | boolean | string[] | Record<string, string | number | boolean>;

/** One published item, as `GET /api/frontier/items` returns it (build spec B.6). */
export interface FrontierItem {
  id: string;
  /** What the card leads with: the Chinese title, else the original. */
  title: string;
  titleRaw: string;
  titleZh: string | null;
  summary: string | null;
  reason: string | null;
  lang: string;
  lane: string;
  laneLabel: string;
  sourceType: string;
  sourceTypeLabel: string;
  evidenceType: string | null;
  evidenceTypeLabel: string | null;
  evidenceBasis: "pubmed-types" | "registry" | "model" | null;
  specialties: FrontierLabelled[];
  flags: FrontierLabelled[];
  entities: { drugs: string[]; trials: string[]; orgs: string[]; diseases: string[] };
  source: { id: string; name: string; homepage: string | null };
  url: string;
  doi: string | null;
  pmid: string | null;
  registryIds: string[];
  publishedAt: string | null;
  datePrecision: FrontierDatePrecision;
  timelineAt: string;
  visibleAt: string | null;
  selected: boolean;
  selectedRule: string | null;
  safetyAlert: boolean;
  verification: FrontierVerification;
  /**
   * The editorial total, 0–100 (「编辑评分 · 满分 100」): null for a safety
   * alert, which is not scored for a reader, and for an item not scored in full.
   */
  score: number | null;
  /** The band `score` reads in; null with no score. */
  scoreBand: FrontierScoreBand | null;
  /** The four dimensions in words. The numbers behind them never leave the server. */
  levels: { authority: FrontierLevel | null; impact: FrontierLevel | null; novelty: FrontierLevel | null; relevance: FrontierLevel | null };
  openAccess: { status: string; pdfUrl: string | null } | null;
  /**
   * The plugin's enrichment as facts, by the plugin's own keys — the ones this
   * build names get a Chinese label, any other is shown by its key (plan
   * §14.6: a new field reaches the card without a release).
   */
  facts: Record<string, FrontierFact>;
  /**
   * Other institutions that reported it (「另有 N 家报道」), one each — its
   * latest mention — named as a reader knows them, at most five.
   */
  alsoReportedBy: Array<{ sourceId: string; sourceName: string; url: string }>;
  /** How many other institutions reported it; `alsoReportedBy` names up to five of them. */
  alsoReportedCount: number;
  event: { id: string; title: string } | null;
  /** The reader's own marks; `read` is what greys a card's title. */
  state: FrontierItemState;
}

/** `GET /api/frontier/items/:id` adds the stored texts: the original abstract and, once written, the shared Chinese one. */
export interface FrontierItemDetail extends FrontierItem {
  abstract: string | null;
  abstractZh: string | null;
}

export interface FrontierItemsQuery {
  view?: FrontierView;
  by?: FrontierAxis;
  lane?: string | null;
  specialty?: string | null;
  window?: FrontierWindow | null;
  q?: string | null;
  starred?: boolean;
  /** Official safety alerts only, from every lane (the rail's 安全警示). */
  safety?: boolean;
  /** A search's order; relevance unless `time` (the words' matches, newest first). */
  sort?: FrontierSearchSort;
  cursor?: string | null;
  /** 1–50; the server's default is 30. */
  limit?: number;
}

export interface FrontierItemsPage {
  items: FrontierItem[];
  nextCursor: string | null;
  /** The content version the page was read at; compared with `/status`. */
  version: string | null;
  mode: FrontierSearchMode;
  /** The cursor had gone stale and this is page one again (see the module note). */
  restarted: boolean;
}

export type FrontierPluginState = "ok" | "degraded" | "unreachable" | "incompatible" | "unconfigured";

/**
 * What this deployment's feed can do beyond its lists (`/status`
 * `capabilities`). An action is offered only when its capability is true, so
 * a button never leads to a route that would answer 404; a server that does
 * not say is read as offering none of them.
 */
export interface FrontierCapabilities {
  saveToLibrary: boolean;
  abstractZh: boolean;
  forYou: boolean;
  hot: boolean;
  daily: boolean;
}

export interface FrontierStatus {
  enabled: boolean;
  audience: string;
  plugin: { state: FrontierPluginState; lastPullAt: string | null };
  lastPublishedAt: string | null;
  lastDailyDay: string | null;
  sources: { total: number; enabled: number; healthy: number; degraded: number; unreadable: number; drifted: number; planned: number };
  counts: { today: number; selectedToday: number };
  personalization: "available" | "unavailable" | "off";
  capabilities: FrontierCapabilities;
  /** View versions as strings, so a number and its string compare equal. */
  versions: { content: string | null; hot: string | null; daily: string | null };
}

/** One row of the public sources list (build spec B.6 `FrontierSource`). */
export interface FrontierSource {
  id: string;
  /** The registry's name: the feed this row is (「openFDA 药品召回（enforcement）API」). */
  name: string;
  /** The institution a reader knows it by (「FDA」); the feed's name where the platform names none. */
  displayName: string;
  homepage: string | null;
  lane: string;
  laneLabel: string;
  sourceType: string;
  sourceTypeLabel: string;
  access: string;
  health: string;
  healthLabel: string;
  lastOkAt: string | null;
  lastNewEntryAt: string | null;
  entries7d: number;
  /** Its items selected in the last 30 days (「近 30 天精选」), recounted hourly. */
  selected30d: number;
  enabled: boolean;
  retired: boolean;
}

export interface FrontierSources {
  mirroredAt: string | null;
  counts: Record<string, number>;
  sources: FrontierSource[];
}

export interface FrontierFollow {
  id: string;
  kind: "topic" | "specialty" | "drug" | "source" | "event";
  key: string;
  label: string;
  muted: boolean;
}

/*
 * Wave two. These shapes are what this page renders; the server package that
 * builds the routes (build spec D) implements them. Every field is read
 * defensively, so a partial answer renders what it has.
 */

/**
 * `GET /api/frontier/for-you`: at most eight items, each under one of the reader's interests.
 * A reason's `topic` is that interest alone — what 「与我相关」 groups items under and heads a
 * group with — and `text` the older sentence around it (「因为你在做：…」). `basis` (ranked by
 * meaning or by keywords) is read and never shown. `paused`: the reader switched their memory off,
 * so the block has nothing for them until they switch it on.
 */
export interface FrontierForYou {
  state: "available" | "unavailable" | "off";
  basis: "vector" | "tags" | null;
  paused: boolean;
  items: Array<{ item: FrontierItem; reason: { text: string; topic: string | null; memoryId: string | null } }>;
}

/** What makes an event's first-hand material first-hand: 「含原始论文」「含官方公告」…. */
export type FrontierPrimaryKind = "paper" | "official" | "guideline" | "label";

/** Which ranking `GET /api/frontier/hot` answers: the current list (72 hours), or a week's or a month's. */
export type FrontierHotWindow = "current" | "week" | "month";
export const FRONTIER_HOT_WINDOWS: readonly FrontierHotWindow[] = Object.freeze(["current", "week", "month"]);

/** A hot event's one badge: 「新」 (first reported within 12 hours) or 「升温」 (placed or measured higher than 6 hours before). */
export type FrontierHotBadge = "new" | "rising";

/** One point of a heat trend: its time and the heat shown then (×10, rounded); null where nothing was measured. */
export interface FrontierTrendPoint {
  at: string;
  heat: number | null;
}

/**
 * One row of `GET /api/frontier/hot`. On the current list: `heat` (the heat shown, heat × 10 rounded),
 * `rankChange` against the list 6 hours before (places gained, negative when lost, `"new"` when it was
 * not on it, null with no list that old), `badge`, and a 24-hour `trend` of seven points, oldest first —
 * null means 「暂无走势」 (less than 6 hours of history). On a week's or a month's ranking those four are
 * null and `period` carries the row instead: 「本周 N 家机构 · M 篇 · 在榜 X 小时 · 最高第 K 名」.
 * `sourceCount72h` counts independent institutions (「N 家机构报道」).
 */
export interface FrontierHotEvent {
  rank: number;
  id: string;
  title: string;
  latest: string | null;
  sourceCount72h: number;
  reportCount: number;
  primary: FrontierPrimaryKind | null;
  hasPrimary: boolean;
  firstAt: string | null;
  lastAt: string | null;
  status: "developing" | "settled";
  heat: number | null;
  rankChange: number | "new" | null;
  badge: FrontierHotBadge | null;
  trend: FrontierTrendPoint[] | null;
  period: { institutions: number; reports: number; hoursOnList: number | null; bestRank: number | null } | null;
}

/**
 * `GET /api/frontier/hot?window=`: the ranking and when it was taken — for the current list the
 * snapshot's time (「近 72 小时 · 22:40 更新」) with `since` 72 hours before it; for a week or a
 * month the moment it was computed, over the window from `since`.
 */
export interface FrontierHotBoard {
  window: FrontierHotWindow;
  takenAt: string | null;
  since: string | null;
  events: FrontierHotEvent[];
}

export type FrontierEventRole = "primary" | "report" | "background";

/** `GET /api/frontier/events/:id` (a merged id answers 308, which `fetch` follows). */
export interface FrontierEvent {
  id: string;
  title: string;
  /** 「先了解这件事」; null until the event has earned one (plan §4.4). */
  digest: string | null;
  latest: { text: string; at: string | null } | null;
  status: "developing" | "settled";
  lane: string;
  laneLabel: string;
  specialties: FrontierLabelled[];
  sourceCount72h: number;
  reportCount: number;
  firstAt: string | null;
  lastAt: string | null;
  /*
   * The side column (plan 2026-09-23 §6.2). The parser always sets these;
   * they are optional only so hand-built fixtures that predate them still
   * type-check.
   */
  /** The heat now, as shown (heat × 10, rounded); null with nothing to measure. */
  heat?: number | null;
  /** Whether it holds first-hand material, and which (「有论文原文」「有官方公告」…). */
  hasPrimary?: boolean;
  primary?: FrontierPrimaryKind | null;
  /** Institutions reporting it in the last 72 hours, by kind of source (「期刊 1 · 媒体 1」); the kinds add up to `total`. */
  institutions72h?: { total: number; byType: Array<{ type: string; label: string; count: number }> };
  /** Hourly heat over the last 72 hours from its first report, oldest first; null — 「暂无走势」 — under 6 hours old. */
  trend?: FrontierTrendPoint[] | null;
  items: Array<FrontierItem & { role: FrontierEventRole }>;
  related: Array<{ id: string; title: string; relation: string; at: string | null }>;
}

/** One row of `GET /api/frontier/dailies`. */
export interface FrontierDailySummary {
  day: string;
  title: string | null;
  itemCount: number;
  generatedAt: string | null;
}

/**
 * `GET /api/frontier/dailies/:day`. The header reads 「9月23日 周三 · {itemCount} 条 · 约 {readingMinutes} 分钟」;
 * `previousDay` / `nextDay` are the nearest issues on either side (a quiet day has none), null at either end.
 * `markdown` is the issue as it reads now — the institutions' names, no withdrawn item — ready to copy.
 */
export interface FrontierDaily {
  day: string;
  windowStart: string | null;
  windowEnd: string | null;
  generatedAt: string | null;
  lead: { item: FrontierItem; text: string | null; event: { id: string; title: string } | null } | null;
  sections: Array<{ lane: string; laneLabel: string; items: FrontierItem[] }>;
  safety: FrontierItem[];
  aiMinute: string | null;
  markdown: string;
  /** The items the issue shows now. */
  itemCount: number;
  /** Minutes to read it, at 400 characters a minute; at least 1. */
  readingMinutes: number;
  previousDay: string | null;
  nextDay: string | null;
}

/** `POST …/save-to-library`: an open-access PDF, or a short record when there is none. */
export interface FrontierLibrarySave {
  kind: "pdf" | "md";
  path: string | null;
  /** Why a record was saved where a PDF was expected (the download failed), in the reader's words. */
  note: string | null;
}

/** `POST …/abstract-zh`: the shared Chinese abstract, or the original with a note. */
export interface FrontierAbstract {
  abstractZh: string | null;
  abstract: string | null;
  note: string | null;
}

/* -------------------------------------------------------------------- parsing */

type Raw = Record<string, unknown>;

const record = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const strings = (value: unknown, max = 50): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(0, max) : []);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback);
const orNull = <T extends string>(value: unknown, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? value as T : null);
/** A whole number the server computed — a heat shown, hours on the list — or null when it sent none. */
const whole = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
/** A rank: a whole number from 1, or null. */
const place = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null);

/** A heat trend, oldest first: points with a readable time; null when the server sent none (「暂无走势」). */
function parseTrend(value: unknown): FrontierTrendPoint[] | null {
  if (!Array.isArray(value)) return null;
  const points = value.flatMap((entry) => {
    const point = record(entry);
    const at = moment(point?.at);
    return at ? [{ at, heat: whole(point?.heat) }] : [];
  });
  return points.length > 0 ? points : null;
}

/** A version as a string: the server sends numbers, and `1` and `"1"` are one version. */
function version(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

/** An http(s) link, or null. A `javascript:` or relative value is never rendered as a link. */
export function safeLink(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : null;
  } catch {
    return null;
  }
}

/** A moment the server stamped; unparseable is absent, not "1970". */
function moment(value: unknown): string | null {
  const candidate = text(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : null;
}

function labelled(value: unknown, fallback: Readonly<Record<string, string>>, max = 20): FrontierLabelled[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: FrontierLabelled[] = [];
  for (const entry of value) {
    const item = record(entry);
    const key = text(item?.key) ?? text(entry);
    if (!key || seen.has(key)) continue;
    const label = text(item?.label) ?? fallback[key];
    if (!label) continue;
    seen.add(key);
    out.push({ key, label });
    if (out.length >= max) break;
  }
  return out;
}

const LEVELS = ["high", "medium", "low"] as const;

const FACT_KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** A fact's scalar: a non-empty word, a finite number, a yes/no. */
function factScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return value.trim() ? value.trim().slice(0, 300) : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "boolean" ? value : undefined;
}

/** The card's facts, bounded as the server bounds them: at most twelve, lists of twenty, records of ten. */
export function parseFacts(value: unknown): Record<string, FrontierFact> {
  const raw = record(value);
  const facts: Record<string, FrontierFact> = {};
  if (!raw) return facts;
  for (const [key, entry] of Object.entries(raw)) {
    if (Object.keys(facts).length >= 12) break;
    if (!FACT_KEY.test(key)) continue;
    if (Array.isArray(entry)) {
      const list = strings(entry, 20);
      if (list.length > 0) facts[key] = list;
      continue;
    }
    const nested = record(entry);
    if (nested) {
      const flat: Record<string, string | number | boolean> = {};
      for (const [name, part] of Object.entries(nested).slice(0, 10)) {
        const scalar = factScalar(part);
        if (FACT_KEY.test(name) && scalar !== undefined) flat[name] = scalar;
      }
      if (Object.keys(flat).length > 0) facts[key] = flat;
      continue;
    }
    const scalar = factScalar(entry);
    if (scalar !== undefined) facts[key] = scalar;
  }
  return facts;
}

/**
 * One item, or null when it lacks what a card cannot do without (an id, a
 * title, a link to the original, the source's name, a time). Only the fields
 * named in `FrontierItem` are read.
 */
export function parseFrontierItem(value: unknown): FrontierItem | null {
  const raw = record(value);
  if (!raw) return null;
  const id = text(raw.id);
  const titleRaw = text(raw.titleRaw) ?? text(raw.title);
  const url = safeLink(raw.url);
  const source = record(raw.source);
  const sourceName = text(source?.name);
  const timelineAt = moment(raw.timelineAt) ?? moment(raw.visibleAt) ?? moment(raw.publishedAt);
  if (!id || !titleRaw || !url || !sourceName || !timelineAt) return null;
  const titleZh = text(raw.titleZh);
  const lane = text(raw.lane) ?? "mixed";
  const levels = record(raw.levels);
  const openAccess = record(raw.openAccess);
  const entities = record(raw.entities);
  const event = record(raw.event);
  const state = record(raw.state);
  const alsoReportedBy = (Array.isArray(raw.alsoReportedBy) ? raw.alsoReportedBy : []).flatMap((entry) => {
    const mention = record(entry);
    const name = text(mention?.sourceName);
    const link = safeLink(mention?.url);
    return name && link ? [{ sourceId: text(mention?.sourceId) ?? "", sourceName: name, url: link }] : [];
  }).slice(0, 5);
  const score = typeof raw.score === "number" && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 100 ? Math.round(raw.score) : null;
  return {
    id,
    title: text(raw.title) ?? titleZh ?? titleRaw,
    titleRaw,
    titleZh,
    summary: text(raw.summary),
    reason: text(raw.reason),
    lang: text(raw.lang) ?? "und",
    lane,
    laneLabel: text(raw.laneLabel) ?? LANE_LABELS[lane] ?? "",
    sourceType: text(raw.sourceType) ?? "media",
    sourceTypeLabel: text(raw.sourceTypeLabel) ?? "",
    evidenceType: text(raw.evidenceType),
    evidenceTypeLabel: text(raw.evidenceTypeLabel),
    evidenceBasis: orNull(raw.evidenceBasis, ["pubmed-types", "registry", "model"] as const),
    specialties: labelled(raw.specialties, SPECIALTY_LABELS, 3),
    flags: labelled(raw.flags, FLAG_LABELS),
    entities: {
      drugs: strings(entities?.drugs, 20),
      trials: strings(entities?.trials, 20),
      orgs: strings(entities?.orgs, 20),
      diseases: strings(entities?.diseases, 20),
    },
    source: { id: text(source?.id) ?? "", name: sourceName, homepage: safeLink(source?.homepage) },
    url,
    doi: text(raw.doi),
    pmid: text(raw.pmid),
    registryIds: strings(raw.registryIds, 10),
    publishedAt: moment(raw.publishedAt),
    datePrecision: oneOf(raw.datePrecision, ["instant", "day", "inferred"] as const, "instant"),
    timelineAt,
    visibleAt: moment(raw.visibleAt),
    selected: raw.selected === true,
    selectedRule: text(raw.selectedRule),
    safetyAlert: raw.safetyAlert === true,
    verification: oneOf(raw.verification, ["pending", "passed", "repaired", "title-only"] as const, "pending"),
    // A safety alert carries no score for a reader, whatever a server sent.
    score: raw.safetyAlert === true ? null : score,
    scoreBand: raw.safetyAlert === true || score === null ? null : orNull(raw.scoreBand, ["high", "medium", "low"] as const),
    levels: {
      authority: orNull(levels?.authority, LEVELS),
      impact: orNull(levels?.impact, LEVELS),
      novelty: orNull(levels?.novelty, LEVELS),
      relevance: orNull(levels?.relevance, LEVELS),
    },
    openAccess: openAccess ? { status: text(openAccess.status) ?? "unknown", pdfUrl: safeLink(openAccess.pdfUrl) } : null,
    facts: parseFacts(raw.facts),
    alsoReportedBy,
    // A server that sends no count has named them all (it named at most five).
    alsoReportedCount: Math.max(count(raw.alsoReportedCount), alsoReportedBy.length),
    event: event && text(event.id) && text(event.title) ? { id: text(event.id)!, title: text(event.title)! } : null,
    state: { starred: state?.starred === true, hidden: state?.hidden === true, read: state?.read === true },
  };
}

function parseItems(value: unknown): FrontierItem[] {
  return Array.isArray(value) ? value.map(parseFrontierItem).filter((item): item is FrontierItem => item !== null) : [];
}

function parseItemsPage(value: unknown, restarted: boolean): FrontierItemsPage {
  const raw = record(value) ?? {};
  return {
    items: parseItems(raw.items),
    nextCursor: text(raw.nextCursor),
    version: version(raw.version),
    mode: oneOf(raw.mode, ["list", "keyword", "hybrid"] as const, "list"),
    restarted,
  };
}

function parseStatus(value: unknown): FrontierStatus {
  const raw = record(value) ?? {};
  const plugin = record(raw.plugin);
  const sources = record(raw.sources);
  const counts = record(raw.counts);
  const versions = record(raw.versions);
  const capabilities = record(raw.capabilities);
  return {
    enabled: raw.enabled !== false,
    audience: text(raw.audience) ?? "all",
    plugin: {
      state: oneOf(plugin?.state, ["ok", "degraded", "unreachable", "incompatible", "unconfigured"] as const, "ok"),
      lastPullAt: moment(plugin?.lastPullAt),
    },
    lastPublishedAt: moment(raw.lastPublishedAt),
    lastDailyDay: text(raw.lastDailyDay),
    sources: {
      total: count(sources?.total), enabled: count(sources?.enabled), healthy: count(sources?.healthy),
      degraded: count(sources?.degraded), unreadable: count(sources?.unreadable), drifted: count(sources?.drifted),
      planned: count(sources?.planned),
    },
    counts: { today: count(counts?.today), selectedToday: count(counts?.selectedToday) },
    personalization: oneOf(raw.personalization, ["available", "unavailable", "off"] as const, "off"),
    capabilities: {
      saveToLibrary: capabilities?.saveToLibrary === true,
      abstractZh: capabilities?.abstractZh === true,
      forYou: capabilities?.forYou === true,
      hot: capabilities?.hot === true,
      daily: capabilities?.daily === true,
    },
    versions: { content: version(versions?.content), hot: version(versions?.hot), daily: version(versions?.daily) },
  };
}

function parseSource(value: unknown): FrontierSource | null {
  const raw = record(value);
  const id = text(raw?.id);
  const name = text(raw?.name);
  if (!raw || !id || !name) return null;
  const lane = text(raw.lane) ?? "mixed";
  return {
    id,
    name,
    displayName: text(raw.displayName) ?? name,
    homepage: safeLink(raw.homepage),
    lane,
    laneLabel: text(raw.laneLabel) ?? LANE_LABELS[lane] ?? "",
    sourceType: text(raw.sourceType) ?? "media",
    sourceTypeLabel: text(raw.sourceTypeLabel) ?? "",
    access: text(raw.access) ?? "",
    health: text(raw.health) ?? "degraded",
    healthLabel: text(raw.healthLabel) ?? "",
    lastOkAt: moment(raw.lastOkAt),
    lastNewEntryAt: moment(raw.lastNewEntryAt),
    entries7d: count(raw.entries7d),
    selected30d: count(raw.selected30d),
    enabled: raw.enabled !== false,
    retired: raw.retired === true,
  };
}

function parseState(value: unknown): FrontierItemState {
  const state = record(record(value)?.state);
  return { starred: state?.starred === true, hidden: state?.hidden === true, read: state?.read === true };
}

function parseHotEvent(value: unknown, index: number): FrontierHotEvent | null {
  const raw = record(value);
  const id = text(raw?.id) ?? text(record(raw?.event)?.id);
  const title = text(raw?.title) ?? text(record(raw?.event)?.title);
  if (!raw || !id || !title) return null;
  const primary = orNull(raw.primary, ["paper", "official", "guideline", "label"] as const);
  const period = record(raw.period);
  return {
    rank: count(raw.rank) || index + 1,
    id,
    title,
    latest: text(raw.latest),
    sourceCount72h: count(raw.sourceCount72h),
    reportCount: count(raw.reportCount),
    primary,
    hasPrimary: raw.hasPrimary === true || primary !== null,
    firstAt: moment(raw.firstAt),
    lastAt: moment(raw.lastAt),
    status: oneOf(raw.status, ["developing", "settled"] as const, "developing"),
    heat: whole(raw.heat),
    rankChange: raw.rankChange === "new" ? "new" : typeof raw.rankChange === "number" && Number.isInteger(raw.rankChange) ? raw.rankChange : null,
    badge: orNull(raw.badge, ["new", "rising"] as const),
    trend: parseTrend(raw.trend),
    period: period ? {
      institutions: count(period.institutions), reports: count(period.reports), hoursOnList: whole(period.hoursOnList), bestRank: place(period.bestRank),
    } : null,
  };
}

function parseHotBoard(value: unknown, window: FrontierHotWindow): FrontierHotBoard {
  const raw = record(value) ?? {};
  const rows = Array.isArray(raw.events) ? raw.events : Array.isArray(raw.items) ? raw.items : [];
  return {
    window: oneOf(raw.window, FRONTIER_HOT_WINDOWS, window),
    takenAt: moment(raw.takenAt),
    since: moment(raw.since),
    events: rows.map(parseHotEvent).filter((row): row is FrontierHotEvent => row !== null).slice(0, 10),
  };
}

function parseEvent(value: unknown): FrontierEvent | null {
  const raw = record(value);
  const id = text(raw?.id);
  const title = text(raw?.title);
  if (!raw || !id || !title) return null;
  const latest = record(raw.latest);
  const lane = text(raw.lane) ?? "mixed";
  const primary = orNull(raw.primary, ["paper", "official", "guideline", "label"] as const);
  const institutions = record(raw.institutions72h);
  return {
    id,
    title,
    digest: text(raw.digest),
    latest: latest && text(latest.text) ? { text: text(latest.text)!, at: moment(latest.at) } : null,
    status: oneOf(raw.status, ["developing", "settled"] as const, "developing"),
    lane,
    laneLabel: text(raw.laneLabel) ?? LANE_LABELS[lane] ?? "",
    specialties: labelled(raw.specialties, SPECIALTY_LABELS, 3),
    sourceCount72h: count(raw.sourceCount72h),
    reportCount: count(raw.reportCount),
    firstAt: moment(raw.firstAt),
    lastAt: moment(raw.lastAt),
    heat: whole(raw.heat),
    hasPrimary: raw.hasPrimary === true || primary !== null,
    primary,
    institutions72h: {
      total: count(institutions?.total),
      // A kind the server did not label is not shown: a key on screen is a key the reader has to learn.
      byType: (Array.isArray(institutions?.byType) ? institutions.byType : []).flatMap((entry) => {
        const kind = record(entry);
        const type = text(kind?.type);
        const label = text(kind?.label);
        return type && label && count(kind?.count) > 0 ? [{ type, label, count: count(kind?.count) }] : [];
      }),
    },
    trend: parseTrend(raw.trend),
    items: (Array.isArray(raw.items) ? raw.items : []).flatMap((entry) => {
      const item = parseFrontierItem(entry);
      return item ? [{ ...item, role: oneOf(record(entry)?.role, ["primary", "report", "background"] as const, "report") }] : [];
    }),
    related: (Array.isArray(raw.related) ? raw.related : []).flatMap((entry) => {
      const link = record(entry);
      const relatedId = text(link?.id);
      const relatedTitle = text(link?.title);
      return relatedId && relatedTitle ? [{ id: relatedId, title: relatedTitle, relation: text(link?.relation) ?? "related", at: moment(link?.at) }] : [];
    }),
  };
}

function parseDaily(value: unknown): FrontierDaily | null {
  const raw = record(value);
  const day = text(raw?.day);
  if (!raw || !day) return null;
  const lead = record(raw.lead);
  const leadItem = parseFrontierItem(lead?.item);
  const leadEvent = record(lead?.event);
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).flatMap((entry) => {
    const section = record(entry);
    const lane = text(section?.lane) ?? "mixed";
    const items = parseItems(section?.items);
    return items.length > 0 ? [{ lane, laneLabel: text(section?.laneLabel) ?? LANE_LABELS[lane] ?? "", items }] : [];
  });
  return {
    day,
    windowStart: moment(raw.windowStart),
    windowEnd: moment(raw.windowEnd),
    generatedAt: moment(raw.generatedAt),
    lead: leadItem ? {
      item: leadItem,
      text: text(lead?.text),
      event: leadEvent && text(leadEvent.id) && text(leadEvent.title) ? { id: text(leadEvent.id)!, title: text(leadEvent.title)! } : null,
    } : null,
    sections,
    safety: parseItems(raw.safety),
    aiMinute: text(raw.aiMinute),
    markdown: typeof raw.markdown === "string" ? raw.markdown : "",
    itemCount: count(raw.itemCount),
    readingMinutes: Math.max(1, count(raw.readingMinutes)),
    previousDay: text(raw.previousDay),
    nextDay: text(raw.nextDay),
  };
}

/* -------------------------------------------------------------------- errors */

/** Why a frontier route answered nothing: the module is off here, or the route does not exist yet. */
export type FrontierAbsence = "off" | "not-offered";

/**
 * `off` for 404 `frontier_not_enabled` (the module is off, or offered to
 * operators only); `not-offered` for a 404 naming no frontier code — a route
 * this server does not have yet. Anything else is a real failure: null.
 */
export function frontierAbsence(error: unknown): FrontierAbsence | null {
  if (!(error instanceof WebApiError) || error.status !== 404) return null;
  if (error.code === "frontier_not_enabled") return "off";
  if (error.code === null || error.code === "not_found") return "not-offered";
  return null;
}

/** A cursor the server no longer honours: start over from page one. */
export function isInvalidCursor(error: unknown): boolean {
  return error instanceof WebApiError && error.status === 400 && error.code === "invalid_cursor";
}

/** One Chinese sentence for a refused frontier request, from the one dictionary. */
export function frontierErrorMessage(error: unknown): string {
  return webErrorMessage(error, {
    codes: {
      frontier_not_enabled: "前沿动态还没有在这个工作空间开放。",
      invalid_cursor: "列表有更新，请从第一页重新加载。",
    },
    statuses: { 404: "这条动态已不存在，请刷新列表。" },
    fallback: "暂时读不到前沿动态，请稍后重试。",
  });
}

/** A wave-two read: its value, or null where the route answers nothing. */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (frontierAbsence(error)) return null;
    throw error;
  }
}

/* ------------------------------------------------------------------- requests */

const id = (value: string) => encodeURIComponent(value);

function itemsQueryString(query: FrontierItemsQuery): string {
  const params = new URLSearchParams();
  params.set("view", query.view ?? "selected");
  params.set("by", query.by ?? "timeline");
  if (query.lane) params.set("lane", query.lane);
  if (query.specialty) params.set("specialty", query.specialty);
  if (query.window) params.set("window", query.window);
  const q = query.q?.trim();
  if (q) params.set("q", q.slice(0, 200));
  // Relevance is the server's default; only the other order is named.
  if (q && query.sort === "time") params.set("sort", "time");
  if (query.starred) params.set("starred", "1");
  if (query.safety) params.set("safety", "1");
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(Math.min(50, Math.max(1, Math.floor(query.limit ?? 30)))));
  return params.toString();
}

export async function fetchFrontierStatus(): Promise<FrontierStatus> {
  return parseStatus(await productRequest<unknown>("/frontier/status"));
}

/**
 * One page of items. A cursor the server refuses as `invalid_cursor` is not
 * an error to show: the list changed under the reader, so page one is read
 * again and returned with `restarted: true`.
 */
export async function listFrontierItems(query: FrontierItemsQuery = {}): Promise<FrontierItemsPage> {
  try {
    return parseItemsPage(await productRequest<unknown>(`/frontier/items?${itemsQueryString(query)}`), false);
  } catch (error) {
    if (!query.cursor || !isInvalidCursor(error)) throw error;
    return parseItemsPage(await productRequest<unknown>(`/frontier/items?${itemsQueryString({ ...query, cursor: null })}`), true);
  }
}

export async function fetchFrontierItem(itemId: string): Promise<FrontierItemDetail> {
  const raw = record(await productRequest<unknown>(`/frontier/items/${id(itemId)}`));
  const item = parseFrontierItem(raw?.item);
  if (!item) throw new WebApiError("The frontier item was malformed.", { status: 502 });
  return { ...item, abstract: text(record(raw?.item)?.abstract), abstractZh: text(record(raw?.item)?.abstractZh) };
}

export async function fetchFrontierSources(): Promise<FrontierSources> {
  const raw = record(await productRequest<unknown>("/frontier/sources")) ?? {};
  const counts = record(raw.counts) ?? {};
  return {
    mirroredAt: moment(raw.mirroredAt),
    counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, count(value)])),
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map(parseSource).filter((source): source is FrontierSource => source !== null),
  };
}

async function itemAction(itemId: string, action: "star" | "unstar" | "hide" | "unhide" | "read"): Promise<FrontierItemState> {
  return parseState(await productRequest<unknown>(`/frontier/items/${id(itemId)}/${action}`, "POST", {}));
}
export const starFrontierItem = (itemId: string) => itemAction(itemId, "star");
export const unstarFrontierItem = (itemId: string) => itemAction(itemId, "unstar");
export const hideFrontierItem = (itemId: string) => itemAction(itemId, "hide");
export const unhideFrontierItem = (itemId: string) => itemAction(itemId, "unhide");
export const markFrontierItemRead = (itemId: string) => itemAction(itemId, "read");

function parseFollow(value: unknown): FrontierFollow | null {
  const follow = record(value);
  const followId = text(follow?.id) ?? (typeof follow?.id === "number" ? String(follow.id) : null);
  const key = text(follow?.key);
  const kind = orNull(follow?.kind, ["topic", "specialty", "drug", "source", "event"] as const);
  return followId && key && kind ? { id: followId, kind, key, label: text(follow?.label) ?? key, muted: follow?.muted === true } : null;
}

export async function listFrontierFollows(): Promise<FrontierFollow[]> {
  const raw = record(await productRequest<unknown>("/frontier/follows"));
  return (Array.isArray(raw?.follows) ? raw.follows : []).map(parseFollow).filter((follow): follow is FrontierFollow => follow !== null);
}

/** Follow — or, with `muted`, see less of — a topic, specialty, drug, source or event. Following again updates, never duplicates. */
export async function addFrontierFollow(input: { kind: FrontierFollow["kind"]; key: string; label: string; muted?: boolean }): Promise<FrontierFollow> {
  const follow = parseFollow(record(await productRequest<unknown>("/frontier/follows", "POST", {
    kind: input.kind, key: input.key, label: input.label, muted: input.muted === true,
  }))?.follow);
  if (!follow) throw new WebApiError("The frontier follow was malformed.", { status: 502 });
  return follow;
}

export async function removeFrontierFollow(followId: string): Promise<void> {
  await productRequest<unknown>(`/frontier/follows/${id(followId)}`, "DELETE");
}

/**
 * The operators' three actions — withdraw, pin, unpin — each with its reason
 * on the record, and the display switch on a source. The server authorizes
 * each (403 `frontier_operator_required`); this page offers none of them yet.
 */
export async function operateFrontierItem(itemId: string, action: "withdraw" | "pin" | "unpin", reason: string): Promise<void> {
  await productRequest<unknown>(`/frontier/ops/items/${id(itemId)}/${action}`, "POST", { reason });
}
export async function setFrontierSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
  await productRequest<unknown>(`/frontier/ops/sources/${id(sourceId)}/enabled`, "POST", { enabled });
}

/* --------------------------------------------------------- wave-two requests */

export function fetchFrontierForYou(): Promise<FrontierForYou | null> {
  return optional(async () => {
    const raw = record(await productRequest<unknown>("/frontier/for-you")) ?? {};
    const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((entry) => {
      const row = record(entry);
      const item = parseFrontierItem(row?.item);
      const reason = record(row?.reason);
      const because = text(reason?.text);
      return item && because ? [{ item, reason: { text: because, topic: text(reason?.topic), memoryId: text(reason?.memoryId) } }] : [];
    }).slice(0, 8);
    return {
      state: oneOf(raw.state ?? raw.status, ["available", "unavailable", "off"] as const, "off"),
      basis: orNull(raw.basis, ["vector", "tags"] as const),
      paused: raw.paused === true,
      items,
    };
  });
}

/**
 * A hot ranking with the time it was taken: the current list (the default), or a week's or a
 * month's ranking. Null where the route does not exist yet or the module is off.
 */
export function fetchFrontierHotBoard(window: FrontierHotWindow = "current"): Promise<FrontierHotBoard | null> {
  return optional(async () => parseHotBoard(await productRequest<unknown>(window === "current" ? "/frontier/hot" : `/frontier/hot?window=${window}`), window));
}

/** The current hot list's rows alone (what the page read before the board carried its time). */
export async function fetchFrontierHot(): Promise<FrontierHotEvent[] | null> {
  return (await fetchFrontierHotBoard("current"))?.events ?? null;
}

/**
 * An event. Unlike the other wave-two readers this one throws every refusal,
 * because its page says something different for each: the module off, the
 * event page not built yet (`frontierAbsence`), or this event not existing.
 * A merged event's old id answers 308, which `fetch` follows; the event that
 * comes back carries the surviving id.
 */
export async function fetchFrontierEvent(eventId: string): Promise<FrontierEvent> {
  const event = parseEvent(record(await productRequest<unknown>(`/frontier/events/${id(eventId)}`))?.event);
  if (!event) throw new WebApiError("The frontier event was malformed.", { status: 502 });
  return event;
}

export function listFrontierDailies(limit = 30): Promise<FrontierDailySummary[] | null> {
  return optional(async () => {
    const raw = record(await productRequest<unknown>(`/frontier/dailies?limit=${Math.min(60, Math.max(1, Math.floor(limit)))}`)) ?? {};
    return (Array.isArray(raw.dailies) ? raw.dailies : Array.isArray(raw.items) ? raw.items : []).flatMap((entry) => {
      const row = record(entry);
      const day = text(row?.day);
      return day ? [{ day, title: text(row?.title), itemCount: count(row?.itemCount), generatedAt: moment(row?.generatedAt) }] : [];
    });
  });
}

export function fetchFrontierDaily(day: string): Promise<FrontierDaily | null> {
  return optional(async () => {
    const daily = parseDaily(record(await productRequest<unknown>(`/frontier/dailies/${id(day)}`))?.daily);
    if (!daily) throw new WebApiError("The frontier daily was malformed.", { status: 502 });
    return daily;
  });
}

/** Null where the route does not exist yet; the card then says 「还在准备」. */
export function saveFrontierItemToLibrary(itemId: string, projectId: string): Promise<FrontierLibrarySave | null> {
  return optional(async () => {
    const saved = record(record(await productRequest<unknown>(`/frontier/items/${id(itemId)}/save-to-library`, "POST", { projectId }))?.saved);
    return { kind: oneOf(saved?.kind, ["pdf", "md"] as const, "md"), path: text(saved?.path), note: text(saved?.note) };
  });
}

export function fetchFrontierAbstractZh(itemId: string): Promise<FrontierAbstract | null> {
  return optional(async () => {
    const raw = record(await productRequest<unknown>(`/frontier/items/${id(itemId)}/abstract-zh`, "POST", {})) ?? {};
    return { abstractZh: text(raw.abstractZh), abstract: text(raw.abstract), note: text(raw.note) };
  });
}

/* ------------------------------------------------------- the daily's switch */

/** The inbox preferences, as far as the daily's switch reads and writes them. */
interface InboxPreferencesWire {
  quietHours: { start: string; end: string };
  digestTime: string;
  switches: Record<string, boolean>;
  channels: string[];
  revision: number;
}

/**
 * Whether the daily is pushed to this account (the inbox's `frontier`
 * switch). It lives with the other notification switches and is on unless
 * turned off, so a server that has not stored it yet reads as on.
 */
export async function fetchFrontierDigestSwitch(): Promise<boolean> {
  const current = await productRequest<InboxPreferencesWire>("/inbox/preferences");
  return current?.switches?.frontier !== false;
}

/**
 * Turn the daily's push on or off. The preference belongs to the inbox, so it
 * is written through the inbox's own route with everything else as it is.
 */
export async function setFrontierDigestSwitch(enabled: boolean): Promise<boolean> {
  const current = await productRequest<InboxPreferencesWire>("/inbox/preferences");
  const saved = await productRequest<InboxPreferencesWire>("/inbox/preferences", "PATCH", {
    quietHours: current.quietHours,
    digestTime: current.digestTime,
    switches: { ...current.switches, frontier: enabled },
    channels: current.channels,
    expectedRevision: current.revision,
  });
  return saved?.switches?.frontier !== false;
}

/* -------------------------------------------------------------------- feature */

/** Whether `/api/me` offers this account the module. A missing `features` is off. */
export function frontierOffered(me: WebMe | null): boolean {
  const features = record((me as (WebMe & { features?: unknown }) | null)?.features);
  return features?.frontier === true;
}

/** `error`: `/api/me` could not be read, which is not the same as being told no. */
export type FrontierFeature = "loading" | "on" | "off" | "error";

/**
 * The account's answer, read once per mount from the shared `/api/me`.
 *
 * Presentation only, like `useOperator`: the routes authorize themselves, so a
 * browser that flips this gains a navigation row, never the data behind it.
 */
export function useFrontierFeature(): FrontierFeature {
  const [feature, setFeature] = useState<FrontierFeature>("loading");
  useEffect(() => {
    let active = true;
    // Through a promise even for a synchronous throw, so one failure path.
    Promise.resolve()
      .then(() => fetchWebMe())
      .then(
        (me) => { if (active) setFeature(frontierOffered(me) ? "on" : "off"); },
        () => { if (active) setFeature("error"); },
      );
    return () => { active = false; };
  }, []);
  return feature;
}
