import { VCR_LONGITUDINAL_SCHEMAS } from "@evimed/domain";
import type { VcrLongitudinalData } from "@/lib/vcrLongitudinalClient";
import { Input, Select } from "@/components/ui/Input";
import { Disclosure } from "@/components/ui/Disclosure";

const fieldNames: Record<string, string> = { historyId: "预测起点的历史记录", providerId: "可用预测模型", predictionId: "预测版本", otherPredictionId: "另一个预测版本", outcomeHistoryId: "后续结局历史", benchmarkId: "试验预测基准" };
const recordKinds: Record<string, string[]> = { historyId: ["history"], outcomeHistoryId: ["history"], predictionId: ["prediction", "prediction_set"], otherPredictionId: ["prediction", "prediction_set"], benchmarkId: ["trial_prediction"] };
export function forecastPrerequisite(method: string, data: VcrLongitudinalData): string | null {
  if (method === "forecast.trajectories" && !data.providers.length) return "目前没有可调用的预测模型，可先在研究中导入外部预测，再进行验证或版本比较。";
  const schema = (VCR_LONGITUDINAL_SCHEMAS as Record<string, { required: string[] }>)[method];
  for (const field of schema?.required ?? []) {
    if (recordKinds[field] && !data.records.some(record => recordKinds[field].includes(record.kind))) return `尚缺${fieldNames[field]}，请在研究的纵向预测流程中导入或保存。`;
  }
  if (method === "forecast.compare" && data.records.filter(record => ["prediction", "prediction_set"].includes(record.kind)).length < 2) return "需要两个已保存的预测版本，可先导入另一个预测版本。";
  return null;
}
/** Owned record selectors are a thin editor over the domain's reference contract. */
export function VcrForecastMethodInputs({ method, data, value, onChange }: { method: string; data: VcrLongitudinalData; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void }) {
  const schema = (VCR_LONGITUDINAL_SCHEMAS as Record<string, { required: string[]; optional: string[] }>)[method];
  const update = (key: string, next: unknown) => onChange({ ...value, [key]: next });
  const endpoint = (value.endpoint ?? {}) as Record<string, string>;
  return <div className="flex flex-col gap-3">
    {schema.required.filter(key => fieldNames[key]).map(key => <Select key={key} label={fieldNames[key]} value={String(value[key] ?? "")} onChange={event => update(key, event.target.value)}><option value="">请选择</option>{key === "providerId" ? data.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.version}</option>) : data.records.filter(record => recordKinds[key]?.includes(record.kind)).map(record => <option key={record.id} value={record.id}>{record.summary.endpoint?.code ?? (record.kind === "history" ? "历史记录" : "预测记录")} · {record.createdAt} · {record.summary.model?.version ?? ""}</option>)}</Select>)}
    {method === "forecast.trajectories" && <>
      <Input label="预测终点" value={endpoint.code ?? ""} onChange={event => update("endpoint", { ...endpoint, code: event.target.value })} />
      <Input label="终点单位" value={endpoint.unit ?? ""} onChange={event => update("endpoint", { ...endpoint, unit: event.target.value })} />
      <Select label="预测类型" value={endpoint.type ?? ""} onChange={event => update("endpoint", { ...endpoint, type: event.target.value })}><option value="">请选择</option><option value="continuous">连续结局</option><option value="risk">风险</option><option value="survival_probability">生存概率</option><option value="rate">发生率</option></Select>
      <Input label="预测时间点（天）" hint="多个时间点以逗号分隔。" value={Array.isArray(value.horizonsDays) ? value.horizonsDays.join(", ") : ""} onChange={event => update("horizonsDays", event.target.value.split(",").filter(item => item.trim()).map(Number))} />
    </>}
    <Disclosure summary="可选计算设置">
      <div className="flex flex-col gap-3">{schema.optional.includes("bootstrap") && <Input label="重抽样次数" type="number" min={0} max={500} value={typeof value.bootstrap === "number" ? value.bootstrap : ""} onChange={event => { if (event.target.value === "") { const next = { ...value }; delete next.bootstrap; onChange(next); } else update("bootstrap", Number(event.target.value)); }} />}
      {schema.optional.includes("samples") && <Input label="每人预测抽样次数" type="number" min={1} max={1000} value={typeof value.samples === "number" ? value.samples : ""} onChange={event => { if (event.target.value === "") { const next = { ...value }; delete next.samples; onChange(next); } else update("samples", Number(event.target.value)); }} />}
      {schema.optional.includes("mode") && <Select label="比较目的" value={String(value.mode ?? "")} onChange={event => update("mode", event.target.value)}><option value="">请选择</option><option value="scenario">情景差异</option><option value="input_sensitivity">输入敏感性</option><option value="model_version">模型版本差异</option><option value="update">预测更新</option></Select>}
      {schema.optional.includes("windowDays") && <Input label="结局观察窗口（天）" type="number" min={0} value={typeof value.windowDays === "number" ? value.windowDays : ""} onChange={event => update("windowDays", Number(event.target.value))} />}
      </div>
    </Disclosure>
  </div>;
}
