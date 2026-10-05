import type { EvidenceCard, EvidenceClinicalView, EvidenceFactBox, EvidenceProducer, EvidencePublicView, EvidenceZone } from "@/lib/evidenceZoneClient";

/** A card as `GET /api/frontier/zones/:id/evidence/:id` sends it: one verified claim, one the quotation of which was not found, the numbers computed by the server. */
export const producer: EvidenceProducer = { kind: "user", name: "李研究", relation: "none" };

export const availableFactBox: EvidenceFactBox = {
  status: "available", per: 1000, unit: "people", excluded: [],
  benefits: [{ index: 0, outcome: "卒中", timeframe: "2 年", denominator: 100, control: { label: "常规治疗", per1000: 120 }, intervention: { label: "试验药", per1000: 70 }, difference: -50, sourceIndexes: [1] }],
  harms: [{ index: 1, outcome: "大出血", timeframe: "2 年", denominator: 100, control: { label: "常规治疗", per1000: 10 }, intervention: { label: "试验药", per1000: 30 }, difference: 20, sourceIndexes: [1] }],
};
/** A fact box that has a reason instead of numbers: no comparison says whether its outcome is a benefit or a harm. */
export const reasonedFactBox: EvidenceFactBox = { status: "unavailable", reason: "outcome_role_missing", per: 1000, unit: "people", benefits: [], harms: [], excluded: [{ index: 0, reason: "outcome_role_missing" }] };

export const clinicalView: EvidenceClinicalView = {
  kind: "clinical",
  header: { title: "试验药能预防卒中吗", producer, originality: "synthesis", primary: false, journeyStage: null, disclosure: null, lastCheckedAt: "2026-10-04T00:00:00Z" },
  population: "有卒中风险的成人",
  rows: [
    { title: "卒中", outcome: "卒中", timeframe: "2 年", comparator: "常规治疗", intervention: "试验药", relativeEffect: "RR 0.58", certainty: "中",
      absoluteEffect: { status: "computed", per: 1000, unit: "people", control: 120, intervention: 70, difference: -50 },
      participants: 4200, studies: 3, outcomeRole: "benefit", note: null, sourceIndexes: [1] },
    { title: "大出血", outcome: "大出血", timeframe: "2 年", comparator: "常规治疗", intervention: "试验药", relativeEffect: null, certainty: null,
      absoluteEffect: { status: "unavailable", reason: "counts_missing" },
      participants: null, studies: null, outcomeRole: "harm", note: null, sourceIndexes: [1] },
  ],
  claims: [],
  counts: { total: 2, verified: 1, quote_not_found: 1, source_unavailable: 0, no_quote: 0, derived: 0 },
};

export const publicView: EvidencePublicView = {
  kind: "public",
  header: { title: "试验药能预防卒中吗", producer, originality: "synthesis", primary: false, journeyStage: null, disclosure: null },
  panels: [
    { key: "oneLineAnswer", label: "一句话回答", status: "written", text: "试验显示卒中减少，但大出血增多。", claimIds: ["CLM-001"], traced: true },
    { key: "whatItIs", label: "这是什么", status: "written", text: "一种口服抗栓药。", claimIds: [], traced: false },
    { key: "labelSays", label: "说明书怎么说", status: "missing", text: null, claimIds: [], traced: false },
    { key: "notApplicable", label: "什么情况不适用", status: "missing", text: null, claimIds: [], traced: false },
    { key: "seekCareWhen", label: "出现什么情况立刻就医", status: "written", text: "出现黑便或呕血。", claimIds: [], traced: false },
    { key: "commonMisunderstandings", label: "实测到的常见误解", status: "written", items: [{ misunderstanding: "吃了就不会中风", correction: "只是降低风险", claimIds: ["CLM-001"], traced: true }] },
    { key: "sourcesAndCheckDate", label: "来源和核对日期", status: "written", sources: [{ title: "试验 A", url: "https://example.org/a" }], checkedAt: "2026-10-04T00:00:00Z" },
  ],
  factBox: availableFactBox,
};

export const card: EvidenceCard = {
  id: "ec_0123456789abcdef", zoneId: "ez_1", revision: 2, state: "published", canEdit: false, canResearch: true,
  title: "试验药能预防卒中吗", subtype: "academic", summary: "试验显示卒中减少。", body: "· 试验中卒中更少。",
  creator: "李研究", reviewer: null, reviewedAt: null,
  producer, originality: "synthesis", primary: false,
  lineage: { resultVersionId: `rv_${"a".repeat(64)}`, runId: "run_one" },
  disclosure: { model: "deepseek-v4-flash", generatedAt: "2026-10-03T08:00:00Z", lastCheckedAt: "2026-10-04T00:00:00Z", aiSteps: ["search", "screen", "extract", "synthesize"], authors: [{ name: "李研究" }], reviewers: [] },
  claims: [
    { text: "试验中卒中更少。", claimId: "CLM-001", claimType: "direct", claim: "试验中卒中更少。", sourceIndexes: [1], supportQuote: "Among 100 adults on the drug, 7 had a stroke",
      uncertainty: "开放标签。", verification: { claimId: "CLM-001", claimType: "direct", status: "verified", mark: "✓", sources: [{ sourceIndex: 1, status: "verified", mark: "✓" }] } },
    { text: "出血减半。", claimId: "CLM-002", claimType: "direct", claim: "出血减半。", sourceIndexes: [1], supportQuote: "Bleeding fell by half in every subgroup",
      verification: { claimId: "CLM-002", claimType: "direct", status: "quote_not_found", mark: "⚠", sources: [{ sourceIndex: 1, status: "quote_not_found", mark: "⚠" }] } },
  ],
  claimCount: 2,
  claimVerification: { total: 2, verified: 1, quote_not_found: 1, source_unavailable: 0, no_quote: 0, derived: 0 },
  views: { clinical: clinicalView, public: publicView },
  sources: [{ title: "试验 A", url: "https://example.org/a", excerpt: "Among 100 adults on the drug, 7 had a stroke", coverage: "full-text", checkedAt: "2026-10-03T08:00:00Z" }],
  limitations: "只有一项试验。", discussion: [], review: null,
};

export const zone: EvidenceZone = {
  id: "ez_1", revision: 3, state: "published", kind: "user", visibility: "platform", canEdit: true, title: "卒中研究", description: null, background: null,
  experts: [], following: false, canFollow: false, canFeedback: false, canResearch: true, evidenceCount: 1,
};
