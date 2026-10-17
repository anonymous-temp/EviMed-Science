import { fixture } from "./serverFixtures";

/** What the server sends for a scenario population the engine has described (the profile is the engine's own, one entry per variable). */
export function generatedPopulation() {
  const raw = fixture("ev201/population.json");
  raw.version = "人群 v1";
  raw.kind = "情景人群";
  raw.versions = [{ id: "pop_1", label: "人群 v1", stale: false, counts: null }];
  raw.constraints = [{ label: "eGFR 下限", violations: 3 }];
  raw.profileKind = "generated";
  raw.profile = [
    { key: "age", variable: "age", label: "年龄（岁）", kind: "continuous", declared: { family: "normal", params: { mean: 58, sd: 10 }, constraints: [{ kind: "bounds", min: 18, max: 90 }] },
      declaredText: "正态分布，均数 58、标准差 10；限定在 18–90", generatedText: "均数 58.2，标准差 9.8", violations: 0, outOfBounds: false,
      histogram: { breaks: [20, 30, 40, 50, 60, 70, 80, 90], counts: [4, 11, 24, 31, 19, 8, 3] }, mean: 58.2, sd: 9.8 },
    { key: "egfr", variable: "egfr", label: "eGFR", kind: "continuous", declared: { family: "normal", params: { mean: 80, sd: 20 }, constraints: [{ kind: "bounds", min: 30, max: null }] },
      declaredText: "正态分布，均数 80、标准差 20；不小于 30", generatedText: "均数 79.1，标准差 19.4", violations: 12, outOfBounds: false,
      histogram: { breaks: [10, 40, 70, 100, 130], counts: [30, 280, 520, 170] }, mean: 79.1, sd: 19.4 },
    { key: "female", variable: "female", label: "女性", kind: "binary", declared: { family: "bernoulli", params: { prob: 0.45 } }, declaredText: "二分类，取 1 的概率 45%", generatedText: "女性 44.6%",
      histogram: null, levels: [{ level: "0", label: "否", n: 554, percent: 55.4, suppressed: false }, { level: "1", label: "是", n: 446, percent: 44.6, suppressed: false }], violations: null, outOfBounds: false },
    { key: "tumour", variable: "tumour", label: "肿瘤类型", kind: "categorical", declared: null, declaredText: null, generatedText: "腺癌 62%，鳞癌 38%", histogram: null,
      missingText: "缺失 12 条（1.2%）", levels: [{ level: "腺癌", label: "腺癌", n: 620, percent: 62, suppressed: false }, { level: "鳞癌", label: "鳞癌", n: 380, percent: 38, suppressed: false }], violations: null, outOfBounds: false },
  ];
  raw.records = { result: "res_pop", rows: 1000 };
  raw.criteria = []; raw.attrition = []; raw.outcome = null; raw.unknownReasons = []; raw.blockers = []; raw.quality = null; raw.headline = null; raw.definition = null; raw.stale = null;
  raw.counts = { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: 1000, note: null, notes: {}, scope: null };
  raw.download = { path: "records/res_9.csv", rows: 1000 };
  return raw;
}
