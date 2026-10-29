import { VCR_LONGITUDINAL_METHODS } from "@evimed/domain";
import type { VcrModels } from "@/lib/vcrClient";

export type VcrMethod = VcrModels["methods"][number];
const FORECAST_TITLES: Record<string, string> = { "forecast.trajectories": "预测后续轨迹", "forecast.evaluate": "验证预测与后续结局", "forecast.compare": "比较预测版本", "forecast.trial_benchmark": "验证试验效果预测" };
/** Preserve the supported identities when an older server catalogue omits them. */
export function completeMethodCatalogue(methods: VcrMethod[]): VcrMethod[] {
  return [...methods, ...Object.entries(VCR_LONGITUDINAL_METHODS).filter(([id]) => !methods.some(row => (row.method ?? row.id) === id)).map(([id, protocol]) => ({ id, method: id, name: FORECAST_TITLES[id], version: protocol.version }))];
}
