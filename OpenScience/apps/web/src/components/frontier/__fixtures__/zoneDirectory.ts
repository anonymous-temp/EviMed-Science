import type { ZoneDefinition, ZoneDirectory, ZoneDirectoryView, ZonePreview, ZoneSummary } from "@/lib/evidenceTopicClient";
import { frontierItem } from "./frontierItems";

/** A zone as the directory lists it (`ZoneSummary`); every field a test does not name is an ordinary active platform zone. */
export function topicZone(over: Partial<ZoneSummary> = {}): ZoneSummary {
  return {
    id: "zone_glp1", slug: null, title: "GLP-1 受体激动剂减重", type: "drug-indication", keywords: ["GLP-1 受体激动剂", "减重"],
    scope: "GLP-1 类药物用于减重的研究、指南和监管动态", specialties: [{ key: "endocrinology", label: "内分泌" }], group: "肥胖", kind: "official",
    published: true, creator: null, following: false, counts: { week: 37, month: 150, all: 480 }, perWeek: 37, cards: 0, latest: null,
    lifecycle: "active", updatedAt: "2026-10-28T08:00:00Z", ...over,
  };
}

/** A directory answer: `recommended` groups the zones under their first specialty and group, the others list them flat. */
export function topicDirectory(view: ZoneDirectoryView, zones: ZoneSummary[], over: Partial<ZoneDirectory> = {}): ZoneDirectory {
  const groups: ZoneDirectory["groups"] = [];
  if (view === "recommended") {
    for (const zone of zones) {
      const specialty = zone.specialties[0] ?? { key: "other", label: "其他" };
      let entry = groups.find((candidate) => candidate.specialty.key === specialty.key);
      if (!entry) groups.push(entry = { specialty, sections: [] });
      let section = entry.sections.find((candidate) => candidate.label === zone.group);
      if (!section) entry.sections.push(section = { label: zone.group, zones: [] });
      section.zones.push(zone);
    }
  }
  return { view, groups, zones: view === "recommended" ? [] : zones, total: zones.length, canCreate: true, userZones: { count: 0, max: 30 }, ...over };
}

export const topicDefinition: ZoneDefinition = {
  type: "drug-indication",
  keywords: [{ label: "GLP-1 受体激动剂", terms: ["GLP-1 受体激动剂", "司美格鲁肽"] }, { label: "心血管结局", terms: ["心血管结局"] }],
  perspective: null, scope: "超重或肥胖者使用 GLP-1 类药物后的心血管事件与心血管获益研究", include: "", exclude: "", excludeTerms: [],
  specialties: ["endocrinology"], group: "肥胖",
};

/** A preview as `POST /api/frontier/zones/preview` answers it. */
export function topicPreview(over: Partial<ZonePreview> = {}): ZonePreview {
  return {
    count30: 41, perWeek: 10, band: "normal",
    recent: [frontierItem({ id: "r1", title: "司美格鲁肽的心血管结局研究" }), frontierItem({ id: "r2", title: "替尔泊肽减重后的血压变化" })],
    borderline: [frontierItem({ id: "b1", title: "减重手术与药物的比较" }), frontierItem({ id: "b2", title: "胰高血糖素样肽的基础研究" })],
    ...over,
  };
}
