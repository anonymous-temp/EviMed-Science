import { Link } from "react-router";
import { CircleCheck } from "lucide-react";
import { VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_TWIN_LABELS_ZH } from "@evimed/domain";
import type { VcrModelCard } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { DataTable } from "@/components/ui/DataTable";
import { FactList, type Fact } from "@/components/ui/FactList";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { intendedUseLabel, modelRiskLabel, modelTierLabel, numberText } from "./vcrText";
import { vcrTabPath } from "./vcrTabs";

/** An endpoint key as a reader says it: 「事件时间」, never `time_to_event`. */
export const endpointLabel = (endpoint: string | null | undefined): string | null =>
  endpoint ? (VCR_ENDPOINT_TYPE_LABELS_ZH as Record<string, string>)[endpoint] ?? endpoint : null;

/**
 * The name a model's output has earned. `baseline_conditioned_prediction` is a label of its own — 「基线条件化预测」 — and never
 * 「不适用」: it is what a one-shot prediction from baseline is honestly called (plan §5.2).
 */
export function twinLabelOf(model: Pick<VcrModelCard, "twin" | "twinLabel">): string | null {
  if (model.twinLabel) return model.twinLabel;
  return model.twin ? (VCR_TWIN_LABELS_ZH as Record<string, string>)[model.twin] ?? null : null;
}

const VALIDATION_WORD = { passed: "通过", partial: "部分", none: "无" } as const;

/**
 * A model's record (plan §8.2): what it is, where it holds, what backs it and what it may be called — one body for the two places a
 * model is read: the method library's detail beside its list, and the drawer a study's 「模型 ›」 opens over its virtual patients.
 *
 * Hidden knowledge:
 *  - **The tier is a ceiling, not a badge.** A literature model can support a design and cannot support a submission; the
 *    ceiling and the risk are said at the top, with the name its output has earned.
 *  - **What the model covers comes first; how it is called comes last.** The rows a reader checks — the population, the region, the
 *    endpoint, the sources — lead; the interface's own parameters (the call shape, the events it reads, how far it projects, how many
 *    trajectories a history gets, when it retires) follow them behind 「全部 N 项」, because they are for the person wiring a model in,
 *    and never a sentence about how the platform works.
 *  - A list longer than eight facts folds (`FactList`), so the record is as long as what a reader needs first.
 */
export function VcrModelRecord({ model, className }: { model: VcrModelCard; className?: string }) {
  const twin = twinLabelOf(model);
  const sourceBindings = (Array.isArray(model.revisionCard?.parameterBindings) ? model.revisionCard.parameterBindings : []).filter(row => row && typeof row === "object" && typeof row.field === "string" && typeof row.sourceId === "string" && typeof row.quote === "string" && typeof row.textSha256 === "string" && Number.isFinite(row.mappedValue)) as Array<{ field: string; value: number; mappedValue: number; unit: string; quote: string; quoteStart: number; quoteEnd: number; sourceId: string; textSha256: string }>;
  const parameterLabels: Record<string, string> = { "truth.effect": "结局差值", "truth.sd": "标准差", "truth.controlRate": "对照发生率", "truth.treatmentRate": "干预发生率", "truth.hazardRatio": "风险比", "truth.controlMedian": "对照中位时间" };
  const calculationUnit = (field: string, originalUnit: string) => ["truth.controlRate", "truth.treatmentRate"].includes(field) ? "比例（0–1）" : field === "truth.hazardRatio" ? "无量纲比值" : originalUnit || "单位未声明";
  const inputs = sourceBindings.length ? ["研究设计人数", ...sourceBindings.map(row => `${parameterLabels[row.field] ?? row.field}（计算单位：${calculationUnit(row.field, row.unit)}）`)] : model.inputs;
  const rows: Fact[] = [
    ...(model.scope ? [{ label: "适用人群", value: model.scope }] : []),
    ...(model.region ? [{ label: "适用地区", value: model.region }] : []),
    ...(endpointLabel(model.endpoint) ? [{ label: "终点", value: endpointLabel(model.endpoint) }] : []),
    ...(model.timeRange ? [{ label: "时间范围", value: model.timeRange }] : []),
    ...(model.inputRange ? [{ label: "输入范围", value: model.inputRange }] : []),
    ...(model.sources ? [{ label: "来源", value: model.sources }] : []),
    ...(twin ? [{ label: "称谓", value: (
      <span data-vcr-twin={model.twin ?? ""}>
        <Tag tone={model.twin === "digital_twin" ? "accent" : "neutral"}>{twin}</Tag>
        {model.twinReason && <span className="ml-2 text-caption text-text-3">{model.twinReason}</span>}
      </span>
    ) }] : []),
    ...(model.provider ? [{ label: "提供方", value: model.provider }] : []),
    ...(model.family ? [{ label: "类型", value: model.family }] : []),
    ...(model.version ? [{ label: "版本", value: model.version }] : []),
    ...(model.shapeLabel ? [{ label: "调用接口", value: model.shapeLabel }] : []),
    ...(model.events && model.events.length > 0 ? [{ label: "读取的事件", value: model.events.join("、") }] : []),
    ...(model.horizon ? [{ label: "最长推演时间", value: model.horizon }] : []),
    ...(model.trajectoriesMax ? [{ label: "每份历史最多轨迹数", value: String(model.trajectoriesMax) }] : []),
    ...(inputs && inputs.length > 0 ? [{ label: "输入", value: inputs.join("、") }] : []),
    ...(model.outputs ? [{ label: "输出", value: model.outputs }] : []),
    ...(model.missingData ? [{ label: "缺失数据", value: model.missingData }] : []),
    ...(model.uncertainty ? [{ label: "不确定性", value: model.uncertainty }] : []),
    ...(model.retirement ? [{ label: "退役规则", value: model.retirement }] : []),
  ];
  return (
    <div data-vcr-model-card={model.id} className={cn("flex flex-col gap-6", className)}>
      <p className="flex flex-wrap items-center gap-1.5">
        <Tag>{`可信度层级 · ${modelTierLabel(model.tier)}`}</Tag>
        <Tag>{`模型风险 ${modelRiskLabel(model.risk)}`}</Tag>
        <Tag tone="accent">{`最高预期用途 · ${intendedUseLabel(model.useCeiling)}`}</Tag>
        {model.numeric && (
          <span className="inline-flex items-center gap-1 text-caption text-ok">
            <CircleCheck size={16} aria-hidden="true" />
            {`数值用例 ${model.numeric.passed}/${model.numeric.total}`}
          </span>
        )}
      </p>

      {rows.length > 0 && <FactList rows={rows} />}
      {sourceBindings.length > 0 && <Section title="文献参数" level="sub">
        <DataTable label="文献参数与来源" rows={sourceBindings} rowKey={row => row.field} columns={[
          { key: "field", header: "参数", cell: row => parameterLabels[row.field] ?? row.field },
          { key: "value", header: "原文取值与单位", cell: row => `${row.value} ${row.unit || "单位未声明"}` },
          { key: "mapped", header: "计算取值与单位", cell: row => `${row.mappedValue} ${calculationUnit(row.field, row.unit)}` },
          { key: "source", header: "依据", cell: row => <Link className="inline-flex min-h-8 items-center py-1 text-link hover:underline" to={`/app/files/${encodeURIComponent(row.sourceId)}?${new URLSearchParams({ start: String(row.quoteStart), end: String(row.quoteEnd), sha: row.textSha256 })}`}>{row.quote}</Link> },
        ]} />
      </Section>}

      {model.shapeMissing && model.shapeMissing.length > 0 && (
        <Section title="接口还缺的内容" level="sub" count={model.shapeMissing.length}>
          <ul data-vcr-model-shape-missing="" className="flex list-disc flex-col gap-1 pl-4 text-ui text-text-2">
            {model.shapeMissing.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </Section>
      )}

      {model.validation && model.validation.length > 0 && (
        <Section title="验证" level="sub">
          <DataTable
            label={`${model.name} 的验证`}
            minWidth="min-w-0"
            columns={[
              { key: "label", header: "项目", rowHeader: true, cell: (row) => row.label },
              {
                key: "state",
                header: "结果",
                cell: (row) => (
                  <Tag tone={row.state === "partial" ? "warn" : "neutral"} className={cn(row.state === "passed" && "bg-ok-soft text-ok")}>
                    {VALIDATION_WORD[row.state] ?? VALIDATION_WORD.none}
                  </Tag>
                ),
              },
              { key: "detail", header: "说明", isEmpty: (row) => !row.detail, cell: (row) => <span className="text-text-2">{row.detail ?? "—"}</span> },
            ]}
            rows={model.validation}
            rowKey={(row) => row.label}
          />
        </Section>
      )}

      {model.limits && model.limits.length > 0 && (
        <Section title="已知局限" level="sub" count={model.limits.length}>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-ui text-text-2">
            {model.limits.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </Section>
      )}

      {model.missingEvidence && model.missingEvidence.length > 0 && (
        <Section title="还缺的证据" level="sub" count={model.missingEvidence.length}>
          <ul data-vcr-missing-evidence="" className="flex flex-wrap gap-1.5">
            {model.missingEvidence.map((item) => <li key={item}><Tag tone="warn">{item}</Tag></li>)}
          </ul>
        </Section>
      )}

      {model.usedBy && model.usedBy.length > 0 && (
        <Section title="用到它的研究" level="sub" count={numberText(model.usedBy.length, 0)}>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {model.usedBy.map((user) => (
              <li key={user.id}><Link to={vcrTabPath(user.id, "overview")} className="inline-flex min-h-8 items-center py-1 text-ui text-link hover:underline">{user.label}</Link></li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
