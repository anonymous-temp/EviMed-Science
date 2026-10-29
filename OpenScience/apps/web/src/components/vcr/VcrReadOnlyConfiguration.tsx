import { VCR_SCENARIO_SCHEMAS } from "@evimed/domain";
import type { VcrMethodConfiguration } from "@/lib/vcrClient";
import { FactList, type Fact } from "@/components/ui/FactList";
import { methodFieldText } from "./vcrMethodFieldText";
import { methodChoiceLabel } from "./vcrMethodChoiceText";
import { fieldLabel, type Schema } from "./vcrScenarioFieldLabels";

/** Read the saved scenario using the same scientific labels and units as its schema. */
export function VcrReadOnlyConfiguration({ configuration }: { configuration: VcrMethodConfiguration }) {
  const rows: Fact[] = [];
  const root = configuration.scenario;
  function visit(value: unknown, schema: Schema | undefined, path: string, label: string) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, schema?.items, `${path}[${index}]`, `${label} ${index + 1}`));
      return;
    }
    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      const fields = schema?.t === "variant" ? schema.variants?.[String(object[schema.on ?? "type"])] : schema?.fields;
      Object.entries(object).filter(([key]) => !/Id$|Ids$|Hash$|^provenance$/.test(key)).forEach(([key, entry]) => visit(entry, fields?.[key], path ? `${path}.${key}` : key, path ? `${label} · ${fieldLabel(key)}` : fieldLabel(key)));
      return;
    }
    const text = methodFieldText(configuration.method, path, schema ?? {}, root, label);
    const displayed = typeof value === "boolean" ? value ? "是" : "否" : typeof value === "string" ? methodChoiceLabel(configuration.method, path, value) : String(value);
    rows.push({ label: text.label, value: `${displayed}${text.unit ? ` ${text.unit}` : ""}` });
  }
  visit(root, (VCR_SCENARIO_SCHEMAS as unknown as Record<string, Schema>)[configuration.method], "", "研究配置");
  return <FactList rows={[{ label: "方法版本", value: configuration.methodVersion ?? "未记录" }, { label: "配置版本", value: "本次运行的保留配置" }, { label: "随机种子", value: String(configuration.seed) }, ...(configuration.replicates ? [{ label: "重复次数", value: String(configuration.replicates) }] : []), ...rows]} />;
}
