import { WebApiError } from "./apiClient";
import { parseFrontierItem, type FrontierItem } from "./frontierClient";
import { productRequest } from "./productClient";

/**
 * The topic zones of 「证据专区」 (owner 2026-10-29; plan `docs/superpowers/plans/2026-10-29-evidence-zone-topics.md` v1.2): the
 * directory, a zone's page (its overview modules, its items, its cards), and a reader's own zones (「我的专区」: a sentence drafted
 * into a definition, previewed, created, edited, published to the platform, deleted).
 *
 * This file is the contract between the web and `apps/server/src/evidenceZone*.mjs`: every shape the server answers with is
 * declared and parsed here. The vocabulary (zone types, roles, modules) is the domain's `evidenceZoneTopics.mjs`.
 */

export type ZoneType = "drug-indication" | "disease-strategy" | "technology-use" | "policy";
export type ZoneRole = "research" | "guideline" | "approval" | "policy" | "safety" | "conference" | "industry" | "news";
export type ZoneModuleKey =
  | "progress" | "cards" | "key-updates" | "approved-drugs" | "guidelines" | "key-studies" | "safety" | "trials" | "policy"
  | "industry" | "congress" | "multi-source" | "latest";
export type ZoneBand = "narrow" | "normal" | "broad";
export type ZoneLifecycle = "active" | "quiet" | "archived";
export type ZoneDirectoryView = "recommended" | "mine" | "community";
export type ZoneItemsWindow = "7d" | "30d" | "90d" | "all";

export const ZONE_ROLES: readonly ZoneRole[] = ["research", "guideline", "approval", "policy", "safety", "conference", "industry", "news"];
export const ZONE_ROLE_LABELS: Readonly<Record<ZoneRole, string>> = {
  research: "研究", guideline: "指南共识", approval: "审批监管", policy: "医保与政策", safety: "药物安全", conference: "会议",
  industry: "产业", news: "资讯观点",
};
export const ZONE_MODULE_LABELS: Readonly<Record<ZoneModuleKey, string>> = {
  progress: "最新进展", cards: "证据卡片", "key-updates": "重要更新", "approved-drugs": "已获批药物", guidelines: "指南与共识",
  "key-studies": "关键研究", safety: "安全信号", trials: "在研试验", policy: "医保与政策", industry: "产业动态", congress: "会议速递",
  "multi-source": "多方报道", latest: "最新动态",
};

export interface ZoneKeyword { label: string; terms: string[] }
export interface ZoneDefinition {
  type: ZoneType;
  keywords: ZoneKeyword[];
  perspective: string | null;
  scope: string;
  include: string;
  exclude: string;
  excludeTerms: string[];
  specialties: string[];
  group: string;
}
export interface ZoneCounts { week: number; month: number; all: number }
export interface ZoneSummary {
  id: string;
  /** The zone's revision, where the directory sends it: following needs it, and the web reads the zone first where it is absent. */
  revision?: number;
  /** How many readers follow the zone, where the server says so (大家建的 lists it). */
  followers?: number;
  /** Whether the reader made this zone, where the server says so (`mine` lists the reader's own zones before the ones they follow). */
  owned?: boolean;
  slug: string | null;
  title: string;
  type: ZoneType | null;
  keywords: string[];
  scope: string;
  specialties: Array<{ key: string; label: string }>;
  group: string;
  kind: "official" | "user";
  published: boolean;
  creator: string | null;
  following: boolean;
  counts: ZoneCounts;
  perWeek: number | null;
  cards: number;
  latest: { itemId: string; title: string; at: string | null } | null;
  lifecycle: ZoneLifecycle;
  updatedAt: string | null;
}
export interface ZoneDirectory {
  view: ZoneDirectoryView;
  /** `recommended`: specialty → group → zones. `mine` and `community`: one flat list in `zones`, `groups` empty. */
  groups: Array<{ specialty: { key: string; label: string }; sections: Array<{ label: string; zones: ZoneSummary[] }> }>;
  zones: ZoneSummary[];
  total: number;
  canCreate: boolean;
  userZones: { count: number; max: number };
}
/** A zone that took over from an archived one (a merge or a split), as its page links to it. */
export interface ZoneSuccessor { id: string; slug: string | null; title: string }
export interface ZoneDetail extends ZoneSummary {
  revision: number;
  /** The definition, for the zone's owner (and an operator); null for other readers. */
  definition: ZoneDefinition | null;
  canEdit: boolean;
  canDelete: boolean;
  band: ZoneBand | null;
  overviewAt: string | null;
  related: ZoneSummary[];
  /** The zones that took over, where the zone was archived by a merge or a split; none otherwise. */
  successors: ZoneSuccessor[];
  /** When the newest item of the zone came out (ISO); null while it has none. A quiet zone says so in its header. */
  lastItemAt: string | null;
}
export interface ZoneProgress {
  text: string;
  refs: Array<{ n: number; itemId: string; title: string; sourceName: string }>;
  at: string;
}
export interface ZoneDrugRow {
  label: string;
  key: string | null;
  approval: { agency: string; date: string | null; kind: string; itemId: string } | null;
  study: { itemId: string; title: string } | null;
  count30: number;
}
export interface ZoneEventRow { eventId: string; title: string; reports: number; hasPrimary: boolean; lastAt: string | null; itemId: string | null }
export interface TopicCard {
  provider: string;
  id: string;
  version: string;
  updatedAt: string | null;
  status: "current" | "updating" | "superseded" | "withdrawn";
  title: string;
  conclusion: string;
  certainty: { scheme: string; level: string; labelZh: string } | null;
  producer: { name: string; kind: string };
  sourceCount: number;
  detail: { kind: "inline"; href: string } | { kind: "link"; url: string };
}
export type ZoneModule =
  | { key: "progress"; progress: ZoneProgress }
  | { key: "cards"; cards: TopicCard[]; total: number }
  | { key: "approved-drugs"; rows: ZoneDrugRow[] }
  | { key: "multi-source"; events: ZoneEventRow[] }
  | { key: Exclude<ZoneModuleKey, "progress" | "cards" | "approved-drugs" | "multi-source">; items: FrontierItem[]; more: { role: ZoneRole | null; window: ZoneItemsWindow } | null };
export interface ZoneSide {
  related: ZoneSummary[];
  entities: { drugs: ZoneEntityCount[]; diseases: ZoneEntityCount[]; orgs: ZoneEntityCount[] };
  weekly: Array<{ weekStart: string; count: number }>;
  topics: Array<{ id: string; title: string }>;
  congresses: Array<{ id: string; name: string; start: string; end: string }>;
}
export interface ZoneEntityCount { label: string; key: string | null; count: number }
export interface ZoneOverview { zoneId: string; type: ZoneType | null; modules: ZoneModule[]; side: ZoneSide }
export interface ZoneItemsQuery { role?: ZoneRole | null; picked?: boolean; window?: ZoneItemsWindow; q?: string; cursor?: string | null }
export interface ZoneItemsPage { items: FrontierItem[]; roleCounts: Partial<Record<ZoneRole, number>>; nextCursor: string | null; total: number | null }
export interface ZonePreview { count30: number; perWeek: number; band: ZoneBand | null; recent: FrontierItem[]; borderline: FrontierItem[] }
export interface ZoneDraft { title: string; definition: ZoneDefinition }
export interface ZoneDraftResult {
  draft: ZoneDraft;
  /** Other readings of an ambiguous sentence ("ADC": 抗体偶联药物 or 表观扩散系数); the reader picks one. */
  readings: Array<{ label: string; draft: ZoneDraft }>;
  suggestions: {
    narrower: Array<{ label: string; draft: ZoneDraft; perWeek: number | null }>;
    broader: Array<{ label: string; draft: ZoneDraft; perWeek: number | null }>;
  };
  preview: ZonePreview;
  similar: ZoneSummary[];
}
export interface ZoneCreateInput {
  title: string;
  definition: ZoneDefinition;
  seeds: { positive: string[]; negative: string[] };
  published: boolean;
  requestId: string;
}

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const optionalText = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const items = (value: unknown): FrontierItem[] => list(value).map(parseFrontierItem).filter((item): item is FrontierItem => item !== null);
const path = (value: string) => encodeURIComponent(value);

function parseDefinition(value: unknown): ZoneDefinition | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    type: text(raw.type) as ZoneType,
    keywords: list(raw.keywords).map((entry) => {
      const keyword = record(entry) ?? {};
      return { label: text(keyword.label), terms: list(keyword.terms).map(text).filter(Boolean) };
    }).filter((keyword) => keyword.label),
    perspective: optionalText(raw.perspective),
    scope: text(raw.scope),
    include: text(raw.include),
    exclude: text(raw.exclude),
    excludeTerms: list(raw.excludeTerms).map(text).filter(Boolean),
    specialties: list(raw.specialties).map(text).filter(Boolean),
    group: text(raw.group),
  };
}

export function parseZoneSummary(value: unknown): ZoneSummary | null {
  const raw = record(value);
  if (!raw || !text(raw.id) || !text(raw.title)) return null;
  const counts = record(raw.counts) ?? {};
  const latest = record(raw.latest);
  return {
    id: text(raw.id),
    ...(typeof raw.revision === "number" ? { revision: raw.revision } : {}),
    ...(typeof raw.owned === "boolean" ? { owned: raw.owned } : {}),
    ...(typeof raw.followers === "number" && raw.followers >= 0 ? { followers: raw.followers } : {}),
    slug: optionalText(raw.slug),
    title: text(raw.title),
    type: (optionalText(raw.type) as ZoneType | null),
    keywords: list(raw.keywords).map(text).filter(Boolean),
    scope: text(raw.scope),
    specialties: list(raw.specialties).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
      .map((entry) => ({ key: text(entry.key), label: text(entry.label) })),
    group: text(raw.group),
    kind: raw.kind === "user" ? "user" : "official",
    published: raw.published === true,
    creator: optionalText(raw.creator),
    following: raw.following === true,
    counts: { week: count(counts.week), month: count(counts.month), all: count(counts.all) },
    perWeek: typeof raw.perWeek === "number" ? raw.perWeek : null,
    cards: count(raw.cards),
    latest: latest && text(latest.itemId) ? { itemId: text(latest.itemId), title: text(latest.title), at: optionalText(latest.at) } : null,
    lifecycle: raw.lifecycle === "quiet" || raw.lifecycle === "archived" ? raw.lifecycle : "active",
    updatedAt: optionalText(raw.updatedAt),
  };
}
const summaries = (value: unknown): ZoneSummary[] => list(value).map(parseZoneSummary).filter((zone): zone is ZoneSummary => zone !== null);

export function parseZoneDetail(value: unknown): ZoneDetail | null {
  const summary = parseZoneSummary(value);
  const raw = record(value);
  if (!summary || !raw) return null;
  const band = raw.band === "narrow" || raw.band === "normal" || raw.band === "broad" ? raw.band : null;
  return {
    ...summary,
    revision: count(raw.revision),
    definition: parseDefinition(raw.definition),
    canEdit: raw.canEdit === true,
    canDelete: raw.canDelete === true,
    band,
    overviewAt: optionalText(raw.overviewAt),
    related: summaries(raw.related),
    successors: list(raw.successors).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null && !!text(entry.id) && !!text(entry.title))
      .map((entry) => ({ id: text(entry.id), slug: optionalText(entry.slug), title: text(entry.title) })),
    lastItemAt: optionalText(raw.lastItemAt),
  };
}

function parseCard(value: unknown): TopicCard | null {
  const raw = record(value);
  if (!raw || !text(raw.id) || !text(raw.title)) return null;
  const detail = record(raw.detail) ?? {};
  const certainty = record(raw.certainty);
  const producer = record(raw.producer) ?? {};
  const status = raw.status === "updating" || raw.status === "superseded" || raw.status === "withdrawn" ? raw.status : "current";
  return {
    provider: text(raw.provider),
    id: text(raw.id),
    version: text(raw.version),
    updatedAt: optionalText(raw.updatedAt),
    status,
    title: text(raw.title),
    conclusion: text(raw.conclusion),
    certainty: certainty ? { scheme: text(certainty.scheme), level: text(certainty.level), labelZh: text(certainty.labelZh) } : null,
    producer: { name: text(producer.name), kind: text(producer.kind) },
    sourceCount: count(raw.sourceCount),
    detail: detail.kind === "link" ? { kind: "link", url: text(detail.url) } : { kind: "inline", href: text(detail.href) },
  };
}

function parseModule(value: unknown): ZoneModule | null {
  const raw = record(value);
  const key = text(raw?.key) as ZoneModuleKey;
  if (!raw || !key || !(key in ZONE_MODULE_LABELS)) return null;
  if (key === "progress") {
    const progress = record(raw.progress);
    if (!progress || !text(progress.text)) return null;
    return {
      key,
      progress: {
        text: text(progress.text),
        refs: list(progress.refs).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
          .map((entry) => ({ n: count(entry.n), itemId: text(entry.itemId), title: text(entry.title), sourceName: text(entry.sourceName) })),
        at: text(progress.at),
      },
    };
  }
  if (key === "cards") return { key, cards: list(raw.cards).map(parseCard).filter((card): card is TopicCard => card !== null), total: count(raw.total) };
  if (key === "approved-drugs") {
    return {
      key,
      rows: list(raw.rows).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null).map((entry) => {
        const approval = record(entry.approval);
        const study = record(entry.study);
        return {
          label: text(entry.label),
          key: optionalText(entry.key),
          approval: approval ? { agency: text(approval.agency), date: optionalText(approval.date), kind: text(approval.kind), itemId: text(approval.itemId) } : null,
          study: study ? { itemId: text(study.itemId), title: text(study.title) } : null,
          count30: count(entry.count30),
        };
      }),
    };
  }
  if (key === "multi-source") {
    return {
      key,
      events: list(raw.events).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null).map((entry) => ({
        eventId: text(entry.eventId), title: text(entry.title), reports: count(entry.reports), hasPrimary: entry.hasPrimary === true,
        lastAt: optionalText(entry.lastAt), itemId: optionalText(entry.itemId),
      })),
    };
  }
  const more = record(raw.more);
  return {
    key,
    items: items(raw.items),
    more: more ? { role: (optionalText(more.role) as ZoneRole | null), window: (text(more.window) || "30d") as ZoneItemsWindow } : null,
  };
}

const entityCounts = (value: unknown): ZoneEntityCount[] =>
  list(value).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
    .map((entry) => ({ label: text(entry.label), key: optionalText(entry.key), count: count(entry.count) }));

export function parseZoneOverview(value: unknown): ZoneOverview {
  const raw = record(value) ?? {};
  const side = record(raw.side) ?? {};
  const entities = record(side.entities) ?? {};
  return {
    zoneId: text(raw.zoneId),
    type: (optionalText(raw.type) as ZoneType | null),
    modules: list(raw.modules).map(parseModule).filter((module): module is ZoneModule => module !== null),
    side: {
      related: summaries(side.related),
      entities: { drugs: entityCounts(entities.drugs), diseases: entityCounts(entities.diseases), orgs: entityCounts(entities.orgs) },
      weekly: list(side.weekly).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
        .map((entry) => ({ weekStart: text(entry.weekStart), count: count(entry.count) })),
      topics: list(side.topics).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
        .map((entry) => ({ id: text(entry.id), title: text(entry.title) })),
      congresses: list(side.congresses).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null)
        .map((entry) => ({ id: text(entry.id), name: text(entry.name), start: text(entry.start), end: text(entry.end) })),
    },
  };
}

function parseDraft(value: unknown): ZoneDraft | null {
  const raw = record(value);
  const definition = parseDefinition(raw?.definition);
  if (!raw || !definition || !text(raw.title)) return null;
  return { title: text(raw.title), definition };
}

function parsePreview(value: unknown): ZonePreview {
  const raw = record(value) ?? {};
  const band = raw.band === "narrow" || raw.band === "normal" || raw.band === "broad" ? raw.band : null;
  return { count30: count(raw.count30), perWeek: count(raw.perWeek), band, recent: items(raw.recent), borderline: items(raw.borderline) };
}

const suggestionList = (value: unknown) =>
  list(value).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null).flatMap((entry) => {
    const draft = parseDraft(entry.draft);
    return draft ? [{ label: text(entry.label), draft, perWeek: typeof entry.perWeek === "number" ? entry.perWeek : null }] : [];
  });

export function parseZoneDraftResult(value: unknown): ZoneDraftResult {
  const raw = record(value) ?? {};
  const draft = parseDraft(raw.draft);
  if (!draft) throw new WebApiError("The zone draft was malformed.", { status: 502 });
  const suggestions = record(raw.suggestions) ?? {};
  return {
    draft,
    readings: list(raw.readings).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null).flatMap((entry) => {
      const reading = parseDraft(entry.draft);
      return reading ? [{ label: text(entry.label), draft: reading }] : [];
    }),
    suggestions: { narrower: suggestionList(suggestions.narrower), broader: suggestionList(suggestions.broader) },
    preview: parsePreview(raw.preview),
    similar: summaries(raw.similar),
  };
}

/** Whether an answer is the topic directory's: 推荐 lists `groups`, the other views `zones`. The old service's list answers `items`. */
const isTopicDirectory = (raw: Raw) => Array.isArray(raw.groups) || Array.isArray(raw.zones);

/**
 * Whether this reader may make a zone, as the last directory read said (null before any). 「新建专区」, wherever it is offered, follows
 * it: a page that is not the directory has no list of its own to ask, and the directory is the one place the server says so.
 */
let createAllowed: boolean | null = null;
const createListeners = new Set<() => void>();
function recordCreateAllowed(value: boolean): void {
  if (createAllowed === value) return;
  createAllowed = value;
  for (const listener of createListeners) listener();
}
export const zoneCreateAllowed = (): boolean | null => createAllowed;
export function subscribeZoneCreate(listener: () => void): () => void {
  createListeners.add(listener);
  return () => { createListeners.delete(listener); };
}
/** For tests: nothing has been read yet. */
export function forgetZoneCreateAllowed(): void { createAllowed = null; }

export async function fetchZoneDirectory(view: ZoneDirectoryView, options: { specialty?: string | null; q?: string } = {}): Promise<ZoneDirectory> {
  const params = new URLSearchParams({ view });
  if (options.specialty) params.set("specialty", options.specialty);
  if (options.q) params.set("q", options.q);
  const raw = record(await productRequest<unknown>(`/frontier/zones?${params.toString()}`)) ?? {};
  // A deployment without the topic zones answers this address with the old service's list. That is no directory: it lists nothing and
  // offers nothing to make, instead of a 「新建专区」 whose zone would open on a page the deployment does not serve.
  if (!isTopicDirectory(raw)) {
    recordCreateAllowed(false);
    return { view, groups: [], zones: [], total: 0, canCreate: false, userZones: { count: 0, max: 0 } };
  }
  const userZones = record(raw.userZones) ?? {};
  const canCreate = raw.canCreate === true;
  recordCreateAllowed(canCreate);
  return {
    view: raw.view === "mine" || raw.view === "community" ? raw.view : "recommended",
    groups: list(raw.groups).map((entry) => record(entry)).filter((entry): entry is Raw => entry !== null).map((entry) => {
      const specialty = record(entry.specialty) ?? {};
      return {
        specialty: { key: text(specialty.key), label: text(specialty.label) },
        sections: list(entry.sections).map((section) => record(section)).filter((section): section is Raw => section !== null)
          .map((section) => ({ label: text(section.label), zones: summaries(section.zones) })),
      };
    }),
    zones: summaries(raw.zones),
    total: count(raw.total),
    canCreate,
    userZones: { count: count(userZones.count), max: count(userZones.max) },
  };
}

/**
 * A zone that is not a topic zone: a reader's container of research-result cards, or a 循证 GEO product zone. The server answers its
 * address in the old service's shape (a state, a count of cards and no keywords or counts of items), and its page is the old zone's.
 */
export class NotTopicZoneError extends Error {
  constructor() {
    super("The zone is not a topic zone.");
    this.name = "NotTopicZoneError";
  }
}

/** A topic zone by its id or its readable name. Throws `NotTopicZoneError` for a zone of the old kind. */
export async function fetchZone(zoneId: string): Promise<ZoneDetail> {
  const raw = record(record(await productRequest<unknown>(`/frontier/zones/${path(zoneId)}`))?.zone);
  if (raw && text(raw.id) && !record(raw.counts)) throw new NotTopicZoneError();
  const zone = parseZoneDetail(raw);
  if (!zone) throw new WebApiError("The zone was malformed.", { status: 502 });
  return zone;
}

/** What an overview holds to show: a module the server sent empty (a new zone's 最新动态, the card block of a zone without cards) is not content. */
export function moduleHasContent(module: ZoneModule): boolean {
  switch (module.key) {
    case "progress": return module.progress.text !== "";
    case "cards": return module.cards.length > 0;
    case "approved-drugs": return module.rows.length > 0;
    case "multi-source": return module.events.length > 0;
    default: return module.items.length > 0;
  }
}

export async function fetchZoneOverview(zoneId: string): Promise<ZoneOverview> {
  return parseZoneOverview(await productRequest<unknown>(`/frontier/zones/${path(zoneId)}/overview`));
}

export async function fetchZoneItems(zoneId: string, query: ZoneItemsQuery = {}): Promise<ZoneItemsPage> {
  const params = new URLSearchParams();
  if (query.role) params.set("role", query.role);
  if (query.picked) params.set("picked", "1");
  if (query.window) params.set("window", query.window);
  if (query.q) params.set("q", query.q);
  if (query.cursor) params.set("cursor", query.cursor);
  const raw = record(await productRequest<unknown>(`/frontier/zones/${path(zoneId)}/items?${params.toString()}`)) ?? {};
  const roleCounts = record(raw.roleCounts) ?? {};
  return {
    items: items(raw.items),
    roleCounts: Object.fromEntries(Object.entries(roleCounts).map(([role, value]) => [role, count(value)])) as Partial<Record<ZoneRole, number>>,
    nextCursor: optionalText(raw.nextCursor),
    total: typeof raw.total === "number" ? raw.total : null,
  };
}

export async function fetchZoneCards(zoneId: string): Promise<TopicCard[]> {
  const raw = record(await productRequest<unknown>(`/frontier/zones/${path(zoneId)}/cards`)) ?? {};
  return list(raw.cards).map(parseCard).filter((card): card is TopicCard => card !== null);
}

/** One sentence (or a base zone, or an item to start from) drafted into a zone definition with its preview. */
export async function draftZone(input: { text: string; baseZoneId?: string | null; fromItemId?: string | null }): Promise<ZoneDraftResult> {
  return parseZoneDraftResult(await productRequest<unknown>("/frontier/zones/draft", "POST", input));
}

/** The preview of a definition the reader edited by hand (keywords added or removed), without drafting again. */
export async function previewZone(definition: ZoneDefinition): Promise<ZonePreview> {
  return parsePreview(record(await productRequest<unknown>("/frontier/zones/preview", "POST", { definition }))?.preview);
}

export async function createZone(input: ZoneCreateInput): Promise<ZoneDetail> {
  const zone = parseZoneDetail(record(await productRequest<unknown>("/frontier/zones", "POST", input))?.zone);
  if (!zone) throw new WebApiError("The zone was malformed.", { status: 502 });
  return zone;
}

export async function updateZone(zone: Pick<ZoneDetail, "id" | "revision">, change: { title?: string; definition?: ZoneDefinition; published?: boolean }): Promise<ZoneDetail> {
  const updated = parseZoneDetail(record(await productRequest<unknown>(`/frontier/zones/${path(zone.id)}`, "PATCH", { ...change, expectedRevision: zone.revision }))?.zone);
  if (!updated) throw new WebApiError("The zone was malformed.", { status: 502 });
  return updated;
}

/**
 * Follows or unfollows a zone a list shows: the directory's rows carry no revision unless the server sends one, so the zone is read
 * first where it is missing (the follow route is checked against it).
 */
export async function followZoneSummary(zone: Pick<ZoneSummary, "id" | "revision">, follow: boolean): Promise<ZoneDetail> {
  const revision = zone.revision ?? (await fetchZone(zone.id)).revision;
  return followZone({ id: zone.id, revision }, follow);
}

export async function deleteZone(zoneId: string): Promise<void> {
  await productRequest<unknown>(`/frontier/zones/${path(zoneId)}`, "DELETE");
}

export async function followZone(zone: Pick<ZoneDetail, "id" | "revision">, follow: boolean): Promise<ZoneDetail> {
  const updated = parseZoneDetail(record(await productRequest<unknown>(`/frontier/zones/${path(zone.id)}/follow`, follow ? "POST" : "DELETE", { expectedRevision: zone.revision }))?.zone);
  if (!updated) throw new WebApiError("The zone was malformed.", { status: 502 });
  return updated;
}

/** A reader's word on one item of a zone: it does not belong (the model checks again), or show more like it. */
export async function zoneItemFeedback(zoneId: string, itemId: string, kind: "not-in" | "more-like"): Promise<void> {
  await productRequest<unknown>(`/frontier/zones/${path(zoneId)}/items/${path(itemId)}/feedback`, "POST", { kind });
}
