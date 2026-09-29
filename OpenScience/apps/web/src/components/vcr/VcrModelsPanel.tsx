import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { getVcrModels, type VcrModelCard, type VcrModelTier } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { DataTable } from "@/components/ui/DataTable";
import { FilterChips } from "@/components/ui/FilterChips";
import { Tag } from "@/components/ui/Tag";
import { useVcrLoad, VcrFacts, VcrSection, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";
import { modelRiskLabel, modelTierLabel, numberText, intendedUseLabel } from "./vcrText";

type Filter = "all" | VcrModelTier | "methods";

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
  const { state, reload } = useVcrLoad("vcr:models", () => getVcrModels());
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const models = filter === "all" || filter === "methods" ? data.models : data.models.filter((model) => model.tier === filter);
  const selected = data.models.find((model) => model.id === openId) ?? data.models[0] ?? null;
  const counts = (tier: VcrModelTier) => data.models.filter((model) => model.tier === tier).length;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="flex flex-col gap-4">
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
                    {model.endpoint && <span>{model.endpoint}</span>}
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
                  isEmpty: (row) => !row.numeric,
                  cell: (row) => row.numeric
                    ? <span className="inline-flex items-center gap-1 text-ok"><CircleCheck size={16} aria-hidden="true" />{row.numeric}</span>
                    : <span className="text-text-3">—</span>,
                },
                { key: "usedIn", header: "用在", isEmpty: (row) => !row.usedIn, cell: (row) => row.usedIn ?? "—" },
              ]}
              rows={data.methods}
              rowKey={(row) => row.id}
            />
          </VcrSection>
        )}

        {data.ladder && data.ladder.length > 0 && (
          <VcrSection title="可信度要求（按用途）" meta="证据不够时，结果的预期用途自动降一级">
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
    </div>
  );
}

function ModelDetail({ model }: { model: VcrModelCard }) {
  return (
    <Card
      header={(
        <div>
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
          ...(model.scope ? [{ label: "适用人群", value: model.scope }] : []),
          ...(model.endpoint ? [{ label: "终点", value: model.endpoint }] : []),
          ...(model.timeRange ? [{ label: "时间范围", value: model.timeRange }] : []),
          ...(model.inputRange ? [{ label: "输入范围", value: model.inputRange }] : []),
          ...(model.sources ? [{ label: "来源", value: model.sources }] : []),
          ...(model.uncertainty ? [{ label: "不确定性", value: model.uncertainty }] : []),
        ]}
      />

      {model.validation && model.validation.length > 0 && (
        <VcrSection title="验证表" className="mt-6">
          <ul className="flex flex-col gap-2">
            {model.validation.map((row) => (
              <li key={row.label} className="flex flex-wrap items-baseline gap-2">
                <span className="w-24 shrink-0 text-caption text-text-3">{row.label}</span>
                <Tag tone={row.state === "passed" ? "neutral" : row.state === "partial" ? "warn" : "neutral"} className={cn(row.state === "passed" && "bg-ok-soft text-ok")}>
                  {row.state === "passed" ? "通过" : row.state === "partial" ? "部分" : "无"}
                </Tag>
                {row.detail && <span className="min-w-0 flex-1 text-caption text-text-2">{row.detail}</span>}
              </li>
            ))}
          </ul>
        </VcrSection>
      )}

      {model.limits && model.limits.length > 0 && (
        <VcrSection title="已知局限" className="mt-6">
          <ul className="flex list-disc flex-col gap-1 pl-4 text-caption text-text-2">
            {model.limits.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </VcrSection>
      )}

      {model.twin && (
        <p className="mt-6 flex flex-wrap items-center gap-2 rounded bg-surface-1 px-3 py-2 text-caption text-text-2">
          <Tag>{model.twin === "digital_twin" ? "数字孪生" : "不适用"}</Tag>
          <span>“数字孪生”标签</span>
          {model.twinReason && <span className="text-text-3">{model.twinReason}</span>}
        </p>
      )}

      {model.usedBy && model.usedBy.length > 0 && (
        <p className="mt-3 text-caption text-text-3">
          {`被 ${numberText(model.usedBy.length, 0)} 个研究使用 · ${model.usedBy.map((user) => user.label).join(" · ")}`}
        </p>
      )}
    </Card>
  );
}
