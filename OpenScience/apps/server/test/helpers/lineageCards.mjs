/**
 * A lineage card as the TCM CDSS defines it (`src/lib/tcm-lineages.ts`
 * `LineageCard` and its `LineageQuestionStrategy`), for the pack tests.
 */

/** The CDSS's 经方 card and its question strategy, as `tcm-lineages.ts` defines them. */
export function classicalFormulaCard(overrides = {}) {
  return {
    card: {
      code: "classical-formula",
      label: "经方思路",
      group: "classic",
      cardNature: "source_preference",
      provenance: {
        representativePhysicians: ["张仲景"],
        representativeWorks: ["《伤寒论》", "《金匮要略》"],
        lineageSummary: "源于仲景学术体系，以六经辨证和方证对应组织经典方剂的临床运用。",
      },
      governance: {
        schemaVersion: "1.0.0", cardVersion: "1.0.0", status: "active",
        author: { id: "tcm-cdss-content-governance", displayName: "中医 CDSS 内容治理组" },
        reviewedBy: [{ id: "tcm-clinical-safety-review", displayName: "中医临床安全审核角色" }],
        reviewedAt: "2026-07-12", effectiveAt: "2026-07-12",
      },
      safetyObedience: "流派偏好仅用于组织问诊与辨治思路；急危重风险处置、特殊人群禁忌、药事审方和执业医师复核始终优先。",
      aliases: ["经方", "经方思路"],
      coreTheory: "重视方证对应与六经/病位病性线索，先核对方证眼目，再考虑加减。",
      dxEmphasis: ["方证对应", "寒热虚实", "表里传变"],
      formulaStyle: "优先说明代表方证是否吻合，不吻合时不得套用经方名。",
      representativeFormulas: ["桂枝汤", "小柴胡汤", "半夏泻心汤", "苓桂术甘汤"],
      herbTendency: "药味精炼，重配伍结构与剂量比例。",
      modificationStyle: "小幅加减，强调保留主方结构。",
      applicability: "症状组合、舌脉和病势与经典方证高度吻合时适用。",
      cautions: ["不得把代表方未经证型核对直接转为剂量级候选处方。"],
      ...overrides,
    },
    questionStrategy: {
      lineageCode: "classical-formula",
      label: "经方思路",
      inquiryFocus: ["寒热", "汗出", "口渴"],
      syndromeAnchors: ["太阳中风", "少阳证"],
      contraindicationBoundaries: ["阴虚火旺慎用辛温"],
      templates: [{ id: "q1", question: "是否怕风、汗出？", reason: "辨太阳中风", fields: ["xianbingshi"], options: [] }],
    },
  };
}
