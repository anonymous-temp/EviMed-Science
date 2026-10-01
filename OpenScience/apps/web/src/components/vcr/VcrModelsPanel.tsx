import { useState } from "react";
import { Link } from "react-router";
import { CircleCheck } from "lucide-react";
import { VCR_ENDPOINT_TYPE_LABELS_ZH, VCR_TWIN_LABELS_ZH } from "@evimed/domain";
import { getVcrModels, type VcrModelCard, type VcrModelTier } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { FilterChips } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { useVcrLoad, VcrFacts, VcrSection, VcrTabError } from "./vcrTabKit";
import { VcrModelAdoptDialog } from "./VcrModelAdoptDialog";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { intendedUseLabel, modelRiskLabel, modelTierLabel, numberText } from "./vcrText";
import { vcrTabPath } from "./vcrTabs";

type Filter = "all" | VcrModelTier | "methods";

/** An endpoint key as a reader says it: 「事件时间」, never `time_to_event`. */
const endpointLabel = (endpoint: string | null | undefined): string | null =>
  endpoint ? (VCR_ENDPOINT_TYPE_LABELS_ZH as Record<string, string>)[endpoint] ?? endpoint : null;

/**
 * The name a model's output has earned. `baseline_conditioned_prediction` is
 * a label of its own — 「基线条件化预测」 — and never 「不适用」: it is what a
 * one-shot prediction from baseline is honestly called (plan §5.2).
 */
export function twinLabelOf(model: Pick<VcrModelCard, "twin" | "twinLabel">): string | null {
  if (model.twinLabel) return model.twinLabel;
  return model.twin ? (VCR_TWIN_LABELS_ZH as Record<string, string>)[model.twin] ?? null : null;
}

const VALIDATION_WORD = { passed: "通过", partial: "部分", none: "无" } as const;

/**
 * 模型与方法: the library both studies draw on, and what each model's output
 * is allowed to be used for.
 *
 * The tier is not a badge: it is a **ceiling** (plan §8.2). A literature
 * model can support a design and cannot support a submission, and a result
 * that used one is labelled down to that ceiling wherever it appears. The
 * 「数字孪生」 line is derived the same way — a model earns the word only with
 * all four pieces of evidence behind it (`twinLabel`), and the card says which
 * one is missing rather than leaving the term to marketing.
 */
export function VcrModelsPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const { state, reload } = useVcrLoad("vcr:models", () => getVcrModels());
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") {
    return state.off
      ? <p className="py-12 text-center text-ui text-text-3">{VCR_OFF_SENTENCE}</p>
      : <VcrTabError message={state.message} onRetry={reload} />;
  }
  const data = state.data;
  const models = filter === "all" || filter === "methods" ? data.models : data.models.filter((model) => model.tier === filter);
  const selected = data.models.find((model) => model.id === openId) ?? data.models[0] ?? null;
  const counts = (tier: VcrModelTier) => data.models.filter((model) => model.tier === tier).length;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-4">
        {data.engineMismatch && data.engineMismatch.length > 0 && (
          <p data-vcr-engine-mismatch="" className="text-caption text-text-3">
            {`计算引擎与方法目录不一致：${data.engineMismatch.join("；")}`}
          </p>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setAdopting(true)}>引入文献模型</Button>
        </div>

        <FilterChips
          label="模型与方法"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "全部", count: data.models.length + data.methods.length },
            { value: "scenario", label: modelTierLabel("scenario"), count: counts("scenario") },
            { value: "literature", label: modelTierLabel("literature"), count: counts("literature") },
            { value: "data", label: modelTierLabel("data"), count: counts("data") },
            { value: "validated", label: modelTierLabel("validated"), count: counts("validated") },
            { value: "methods", label: "方法包", count: data.methods.length },
          ]}
        />

        {filter !== "methods" && (
          <ul className="flex flex-col gap-2">
            {models.map((model) => (
              <li key={model.id}>
                <button
                  type="button"
                  data-vcr-model={model.id}
                  aria-current={selected?.id === model.id ? "true" : undefined}
                  onClick={() => setOpenId(model.id)}
                  className={cn(
                    // A ring rather than a border: a bordered <button> is a
                    // hand-made outline button, and there are none of those.
                    "w-full rounded-card p-3 text-left outline-none ring-1",
                    selected?.id === model.id ? "bg-accent-soft ring-accent" : "bg-surface ring-border hover:ring-border-control",
                  )}
                >
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-ui font-medium text-text">{model.name}</span>
                    {model.family && <span className="text-caption text-text-3">{model.family}</span>}
                    {model.version && <span className="text-caption tabular-nums text-text-3">{model.version}</span>}
                    <span className="flex-1" />
                    <Tag>{modelTierLabel(model.tier)}</Tag>
                    <Tag tone="accent">{intendedUseLabel(model.useCeiling)}</Tag>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-3">
                    {model.sources && <span>{model.sources}</span>}
                    {endpointLabel(model.endpoint) && <span>{endpointLabel(model.endpoint)}</span>}
                    <span>{`模型风险 ${modelRiskLabel(model.risk)}`}</span>
                    {model.numeric && (
                      <span className="inline-flex items-center gap-1 text-ok">
                        <CircleCheck size={16} aria-hidden="true" />
                        {`数值用例 ${model.numeric.passed}/${model.numeric.total}`}
                      </span>
                    )}
                  </span>
                  {model.scope && <span className="mt-1 block truncate text-caption text-text-2">{model.scope}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {(filter === "all" || filter === "methods") && data.methods.length > 0 && (
          <VcrSection title="方法包" meta={`${data.methods.length}`}>
            <DataTable
              label="方法包"
              minWidth="min-w-[36rem]"
              columns={[
                { key: "name", header: "方法", rowHeader: true, cell: (row) => row.name },
                { key: "version", header: "版本", isEmpty: (row) => !row.version, cell: (row) => row.version ?? "—" },
                { key: "endpoints", header: "支持的终点", isEmpty: (row) => !row.endpoints, cell: (row) => row.endpoints ?? "—" },
                {
                  key: "numeric",
                  header: "数值验证",
                  cell: (row) => row.numeric
                    ? <div className="flex flex-col gap-1"><span className="inline-flex items-center gap-1 text-ok"><CircleCheck size={16} aria-hidden="true" />{row.numeric}</span>
                      {row.validation?.ciUrl && <a className="text-link hover:underline" href={row.validation.ciUrl} target="_blank" rel="noreferrer">查看验证来源</a>}</div>
                    : <span className="text-text-3">当前版本尚无已核对的参考用例</span>,
                },
                { key: "assumptions", header: "适用假设", cell: (row) => row.assumptions?.length
                  ? <details><summary className="cursor-pointer text-link">查看假设及来源</summary><ul className="mt-2 flex flex-col gap-2">
                    {row.assumptions.map((item, index) => <li key={index}><p>{item.text}</p><p className="text-text-3">{item.source}</p></li>)}
                  </ul></details> : <span className="text-text-3">尚未提供已核对的假设说明</span> },
                { key: "usedIn", header: "用在", isEmpty: (row) => !row.usedIn, cell: (row) => row.usedIn ?? "—" },
              ]}
              rows={data.methods}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ "data-vcr-method": row.id })}
            />
          </VcrSection>
        )}

        {data.ladder && data.ladder.length > 0 && (
          <VcrSection title="可信度要求（按用途）">
            <DataTable
              label="可信度要求"
              minWidth="min-w-[36rem]"
              columns={[
                { key: "risk", header: "模型风险", rowHeader: true, cell: (row) => modelRiskLabel(row.risk) },
                { key: "needs", header: "至少要有的证据", cell: (row) => row.needs },
                { key: "ceiling", header: "最高预期用途", cell: (row) => intendedUseLabel(row.ceiling) },
              ]}
              rows={data.ladder}
              rowKey={(row) => row.risk}
            />
          </VcrSection>
        )}
      </div>

      {selected && <ModelDetail model={selected} />}
      {adopting && <VcrModelAdoptDialog onClose={() => setAdopting(false)} onSaved={reload} />}
    </div>
  );
}

/** A model's card (plan §8.2): what it is, where it holds, what backs it, and what it may be called. */
function ModelDetail({ model }: { model: VcrModelCard }) {
  const twin = twinLabelOf(model);
  const text = (value: string | null | undefined) => (value ? [value] : []);
  return (
    <Card
      header={(
        <div data-vcr-model-card={model.id}>
          <h2 className="text-section font-semibold text-text">{model.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <Tag>{`可信度层级 · ${modelTierLabel(model.tier)}`}</Tag>
            <Tag>{`模型风险 ${modelRiskLabel(model.risk)}`}</Tag>
            <Tag tone="accent">{`最高预期用途 · ${intendedUseLabel(model.useCeiling)}`}</Tag>
          </p>
        </div>
      )}
    >
      <VcrFacts
        rows={[
          ...text(model.family).map((value) => ({ label: "类型", value })),
          ...text(model.version).map((value) => ({ label: "版本", value })),
          ...text(model.provider).map((value) => ({ label: "提供方", value })),
          ...text(model.interface).map((value) => ({ label: "执行接口", value })),
          ...text(model.scope).map((value) => ({ label: "适用人群", value })),
          ...text(model.region).map((value) => ({ label: "适用地区", value })),
          ...text(endpointLabel(model.endpoint)).map((value) => ({ label: "终点", value })),
          ...text(model.timeRange).map((value) => ({ label: "时间范围", value })),
          ...text(model.inputRange).map((value) => ({ label: "输入范围", value })),
          ...(model.inputs && model.inputs.length > 0 ? [{ label: "输入", value: model.inputs.join("、") }] : []),
          ...text(model.outputs).map((value) => ({ label: "输出", value })),
          ...text(model.missingData).map((value) => ({ label: "缺失数据", value })),
          ...text(model.sources).map((value) => ({ label: "来源", value })),
          ...text(model.uncertainty).map((value) => ({ label: "不确定性", value })),
          ...text(model.retirement).map((value) => ({ label: "退役规则", value })),
        ]}
      />

      {twin && (
        <p data-vcr-twin={model.twin ?? ""} className="mt-4 flex flex-wrap items-center gap-2 rounded bg-surface-1 px-3 py-2 text-caption text-text-2">
          <Tag tone={model.twin === "digital_twin" ? "accent" : "neutral"}>{twin}</Tag>
          {model.twinReason && <span className="text-text-3">{model.twinReason}</span>}
        </p>
      )}

      {model.validation && model.validation.length > 0 && (
        <VcrSection title="验证" className="mt-6">
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
        </VcrSection>
      )}

      {model.limits && model.limits.length > 0 && (
        <VcrSection title="已知局限" className="mt-6">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-caption text-text-2">
            {model.limits.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </VcrSection>
      )}

      {model.missingEvidence && model.missingEvidence.length > 0 && (
        <VcrSection title="还缺的证据" className="mt-6">
          <ul data-vcr-missing-evidence="" className="flex flex-wrap gap-1.5">
            {model.missingEvidence.map((item) => <li key={item}><Tag tone="warn">{item}</Tag></li>)}
          </ul>
        </VcrSection>
      )}

      {model.usedBy && model.usedBy.length > 0 && (
        <p className="mt-6 flex flex-wrap gap-x-2 gap-y-1 text-caption text-text-3">
          <span>{`被 ${numberText(model.usedBy.length, 0)} 个研究使用`}</span>
          {model.usedBy.map((user) => (
            <Link key={user.id} to={vcrTabPath(user.id, "overview")} className="text-link hover:underline">{user.label}</Link>
          ))}
        </p>
      )}
    </Card>
  );
}
