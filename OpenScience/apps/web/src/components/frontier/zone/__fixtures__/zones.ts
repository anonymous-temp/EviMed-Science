import {
  parseZoneDetail,
  parseZoneOverview,
  type TopicCard,
  type ZoneDetail,
  type ZoneOverview,
} from "@/lib/evidenceTopicClient";
import { rawFrontierItem } from "@/components/frontier/__fixtures__/frontierItems";

/**
 * A topic zone as `GET /api/frontier/zones/:id` sends it, read the way the page reads it. The defaults are a platform zone (the kind
 * the owner's plan draws: GLP-1 受体激动剂减重) that the reader does not follow and has no cards in.
 */
export function rawZone(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "zone-glp1", slug: "glp1-obesity", title: "GLP-1 受体激动剂减重", type: "drug-indication",
    keywords: ["GLP-1 受体激动剂", "减重"],
    scope: "成人超重或肥胖者使用 GLP-1 类药物减重的疗效、安全性、指南与可及性；降糖适应症不在此列",
    specialties: [{ key: "endocrinology", label: "内分泌" }], group: "肥胖",
    kind: "official", published: true, creator: null, following: false,
    counts: { week: 58, month: 247, all: 610 }, perWeek: 58, cards: 0,
    latest: { itemId: "k1", title: "司美格鲁肽获批新适应症", at: "2026-10-29T05:00:00.000Z" },
    lifecycle: "active", updatedAt: "2026-10-29T06:20:00.000Z", countsAt: "2026-10-29T06:20:00.000Z",
    revision: 3, definition: null, canEdit: false, canDelete: false, band: "normal", overviewAt: "2026-10-29T06:00:00.000Z", related: [],
    ...overrides,
  };
}

export function zone(overrides: Record<string, unknown> = {}): ZoneDetail {
  const parsed = parseZoneDetail(rawZone(overrides));
  if (!parsed) throw new Error("fixture zone did not parse");
  return parsed;
}

/** One item row, as a module or the 动态 list sends it. */
export const rawItem = (id: string, title: string, overrides: Record<string, unknown> = {}) => rawFrontierItem({
  id, title, titleZh: title, titleRaw: title, source: { id: `src-${id}`, name: "丁香园", homepage: null, platformProduced: false },
  timelineAt: "2026-10-28T06:30:00.000Z", publishedAt: "2026-10-28T06:30:00.000Z", ...overrides,
});

export const rawCard = (overrides: Record<string, unknown> = {}) => ({
  provider: "team", id: "card-1", version: "2", updatedAt: "2026-10-27T08:00:00.000Z", status: "current",
  title: "司美格鲁肽能降低非糖尿病肥胖者的心血管事件吗", conclusion: "能：主要心血管事件相对下降约 20%。",
  certainty: { scheme: "GRADE", level: "moderate", labelZh: "中等确定性" }, producer: { name: "EviMed 证据中心", kind: "platform" },
  sourceCount: 4, detail: { kind: "inline", href: "/app/frontier/zones/zone-glp1/evidence/card-1" }, ...overrides,
});

/** An overview of a drug-indication zone with the modules in the order the server sends them for that type. */
export function rawOverview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zoneId: "zone-glp1", type: "drug-indication",
    modules: [
      { key: "progress", progress: { text: "司美格鲁肽获批新适应症[1]，替尔泊肽的安全性数据更新[2]，[9]不是引用。", at: "2026-10-29T06:00:00.000Z",
        refs: [{ n: 1, itemId: "k1", title: "司美格鲁肽获批新适应症", sourceName: "NMPA" }, { n: 2, itemId: "k2", title: "替尔泊肽安全性更新", sourceName: "FDA" }] } },
      { key: "key-updates", items: [rawItem("k1", "司美格鲁肽获批新适应症", { timelineAt: "2026-10-29T03:00:00.000Z" }), rawItem("k2", "替尔泊肽安全性更新")],
        more: { role: "approval", window: "30d" } },
      { key: "approved-drugs", rows: [
        { label: "司美格鲁肽", key: "semaglutide", approval: { agency: "NMPA", date: "2026-10-20", kind: "新适应症", itemId: "k1" }, study: null, count30: 31 },
        { label: "替尔泊肽", key: "tirzepatide", approval: null, study: null, count30: 0 },
      ] },
      { key: "guidelines", items: [rawItem("g1", "中国肥胖症诊疗指南更新")], more: { role: "guideline", window: "90d" } },
      { key: "multi-source", events: [{ eventId: "ev1", title: "替尔泊肽减重研究发表", reports: 5, hasPrimary: true, lastAt: "2026-10-28T08:00:00.000Z", itemId: "k2" }] },
      { key: "latest", items: [rawItem("l1", "肥胖患者用药依从性研究")], more: { role: null, window: "30d" } },
    ],
    side: {
      related: [{ id: "zone-mash", slug: null, title: "GLP-1 受体激动剂与 MASH", keywords: [], scope: "", specialties: [], group: "", kind: "official", published: true, counts: {} }],
      entities: {
        drugs: [{ label: "司美格鲁肽", key: "semaglutide", count: 31 }, { label: "替尔泊肽", key: "tirzepatide", count: 22 }],
        diseases: [{ label: "肥胖症", key: null, count: 40 }],
        orgs: [{ label: "诺和诺德", key: null, count: 9 }],
      },
      weekly: Array.from({ length: 12 }, (_, index) => ({ weekStart: new Date(Date.UTC(2026, 7, 10) + index * 7 * 86_400_000).toISOString().slice(0, 10), count: (index * 7) % 23 + 3 })),
      topics: [{ id: "topic-1", title: "司美格鲁肽停药后体重反弹吗" }],
      congresses: [{ id: "cong-1", name: "EASD 2026", start: "2026-11-02", end: "2026-11-06" }],
    },
    ...overrides,
  };
}

export function overview(overrides: Record<string, unknown> = {}): ZoneOverview {
  return parseZoneOverview(rawOverview(overrides));
}

export const cardRecord = (overrides: Record<string, unknown> = {}) => rawCard(overrides) as unknown as TopicCard;
