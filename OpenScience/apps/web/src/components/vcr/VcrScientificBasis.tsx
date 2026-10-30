import { FactList } from "@/components/ui/FactList";
export interface VcrScientificComputationBasis {
  basis: "normal_approximation" | "schoenfeld_event_probability";
  formula: "two_sample_means_normal_approximation" | "two_proportion_normal_approximation" | "schoenfeld_lachin_foulkes";
  nTreatment: number; nControl: number; total: number; targetPower: number;
  powerCheckBasis: "pooled_two_sample_t" | "two_proportion_normal_approximation" | "logrank_martingale_integral";
  powerAtAllocatedN: number; allocationRequested?: number; allocationAchieved?: number;
}
/** Sizing approximation and achieved-power check are distinct scientific claims. */
export function VcrScientificBasis({ basis }: { basis: VcrScientificComputationBasis }) {
  const sizing = basis.basis === "schoenfeld_event_probability" ? "Schoenfeld 事件数近似，结合 Lachin–Foulkes 事件概率换算样本量" : basis.formula === "two_sample_means_normal_approximation" ? "两组均值的正态近似样本量" : "两组比例的正态近似样本量";
  const checking = ({ pooled_two_sample_t: "合并方差双样本 t 检验", two_proportion_normal_approximation: "两组比例正态近似", logrank_martingale_integral: "Log-rank 鞅积分" })[basis.powerCheckBasis];
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  return <FactList rows={[{ label: "样本量方法", value: sizing }, { label: "分配后人数", value: `干预组 ${basis.nTreatment} 人；对照组 ${basis.nControl} 人；总计 ${basis.total} 人` }, { label: "目标把握度", value: percent(basis.targetPower) }, { label: "按实际分配人数核对的把握度", value: `${percent(basis.powerAtAllocatedN)}（${checking}）` }]} />;
}
