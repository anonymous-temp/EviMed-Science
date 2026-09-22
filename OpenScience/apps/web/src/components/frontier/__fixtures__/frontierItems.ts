import { parseFrontierItem, type FrontierItem } from "@/lib/frontierClient";

/**
 * One item as `GET /api/frontier/items` sends it (build spec B.6), shared by
 * the frontier tests. It also carries fields the contract never sends — a
 * score, a model name — so a test can prove the page could not show them if a
 * server ever did.
 */
export function rawFrontierItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1b2c3d4e5f60718",
    title: "口服 PCSK9 抑制剂降低主要心血管事件",
    titleRaw: "Oral PCSK9 Inhibition and Cardiovascular Outcomes",
    titleZh: "口服 PCSK9 抑制剂降低主要心血管事件",
    summary: "多中心双盲试验纳入 12000 例患者。",
    reason: "首个口服 PCSK9 抑制剂的硬终点证据。",
    lang: "en",
    lane: "evidence", laneLabel: "临床证据",
    sourceType: "journal", sourceTypeLabel: "期刊",
    evidenceType: "rct", evidenceTypeLabel: "RCT", evidenceBasis: "pubmed-types",
    specialties: [{ key: "cardiology", label: "心血管" }],
    flags: [],
    entities: { drugs: ["PCSK9"], trials: [], orgs: [], diseases: [] },
    source: { id: "nejm", name: "NEJM", homepage: "https://www.nejm.org" },
    url: "https://www.nejm.org/doi/full/10.1056/example",
    doi: "10.1056/example", pmid: null, registryIds: [],
    publishedAt: "2026-09-22T06:00:00.000Z", datePrecision: "instant",
    timelineAt: "2026-09-22T06:30:00.000Z", visibleAt: "2026-09-22T06:30:00.000Z",
    selected: true, selectedRule: "threshold", safetyAlert: false, verification: "passed",
    levels: { authority: "high", impact: "high", novelty: "medium", relevance: "low" },
    openAccess: null, alsoReportedBy: [], event: null,
    state: { starred: false, hidden: false, read: false },
    // Never on the wire by contract; here to prove they could not leak if they were.
    scoreTotal: 87, scores: { impact: 29, novelty: 17, relevance: 13 }, editorModel: "deepseek-flash",
    ...overrides,
  };
}

/** The same item, read the way the page reads it. */
export function frontierItem(overrides: Record<string, unknown> = {}): FrontierItem {
  const item = parseFrontierItem(rawFrontierItem(overrides));
  if (!item) throw new Error("fixture item did not parse");
  return item;
}
