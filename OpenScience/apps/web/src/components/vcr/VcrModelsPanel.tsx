import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { getVcrModels, type VcrModelCard, type VcrModelTier } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { MasterDetail } from "@/components/ui/MasterDetail";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrModelAdoptDialog } from "./VcrModelAdoptDialog";
import { endpointLabel, VcrModelRecord } from "./VcrModelRecord";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { intendedUseLabel, modelRiskLabel, modelTierLabel } from "./vcrText";

type Filter = "all" | VcrModelTier;

/**
 * 模型与方法: the library both studies draw on, and what each model's output is allowed to be used for (R19, plan §5.3; audit B §4.8).
 *
 * The models are a list beside the record of the one in view (`VcrModelRecord`, the same body a study's 「模型 ›」 drawer shows). The
 * tier is not a badge: it is a **ceiling** (plan §8.2). A literature model can support a design and cannot support a submission, and
 * a result that used one is labelled down to that ceiling wherever it appears. The 「数字孪生」 line is derived the same way — a
 * model earns the word only with all four pieces of evidence behind it (`twinLabel`), and the record says which one is missing
 * rather than leaving the term to marketing.
 *
 * Hidden knowledge:
 *  - **A filter with nobody in it is not drawn.** The tiers are the chips, each with its count, and a tier no model is in is not a
 *    chip: zero is not a filter.
 *  - **The statistical method packages are a reference table, folded.** Thirty-five rows of numerics are for the statistician who
 *    checks which algorithm a number came from; they sit under one line at the end and carry no sentence about what a passed
 *    reference case does or does not say.
 *  - **The engine's own catalogue is an operator's matter.** When the compute engine and the method catalogue disagree the platform
 *    says so in its logs and operator views, not to the person choosing a model.
 */
export function VcrModelsPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const { state, reload } = useVcrLoad("vcr:models", () => getVcrModels());
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") {
    return state.off
      ? <EmptyState title={VCR_OFF_SENTENCE} />
      : <VcrTabError message={state.message} onRetry={reload} />;
  }
  const data = state.data;
  const tiers = (["scenario", "literature", "data", "validated"] as const)
    .map((tier) => ({ value: tier, count: data.models.filter((model) => model.tier === tier).length }))
    .filter((entry) => entry.count > 0);
  const models = filter === "all" ? data.models : data.models.filter((model) => model.tier === filter);
  const opened = data.models.find((model) => model.id === openId) ?? null;
  // Beside the list the record is always there (the first model until one is chosen); on a narrow page it opens on a press.
  const current = (opened && models.includes(opened) ? opened : null) ?? models[0] ?? null;

  const adopt = <Button variant="secondary" size="sm" onClick={() => setAdopting(true)}>引入文献模型</Button>;
  return (
    <div className="flex flex-col gap-6">
      <Toolbar
        label="模型与方法的筛选与操作"
        filters={tiers.length > 1
          ? [{
            kind: "chips",
            label: "可信度层级",
            neutral: "all",
            value: filter,
            onChange: (next) => setFilter(next as Filter),
            options: [{ value: "all", label: "全部", count: data.models.length }, ...tiers.map((entry) => ({ value: entry.value, label: modelTierLabel(entry.value), count: entry.count }))],
          }]
          : []}
        summary={`${data.models.length} 个模型`}
        actions={adopt}
      />

      {models.length === 0
        ? <EmptyState title="还没有模型" action={<Button variant="secondary" onClick={() => setAdopting(true)}>引入文献模型</Button>} />
        : (
          <MasterDetail
            className="h-auto"
            narrow="drawer"
            selected={opened !== null}
            listLabel="模型"
            detailLabel="模型记录"
            detailTitle={opened?.name ?? "模型记录"}
            onCloseDetail={() => setOpenId(null)}
            list={(
              <div className="pr-4 max-lg:pr-0">
                <List label="模型">
                  {models.map((model) => (
                    <ListRow
                      key={model.id}
                      title={model.name}
                      onOpen={() => setOpenId(model.id)}
                      selected={current?.id === model.id}
                      titleProps={{ "data-vcr-model": model.id }}
                      meta={<ModelMeta model={model} />}
                    />
                  ))}
                </List>
              </div>
            )}
            detail={({ split }) => {
              const model = split ? current : opened;
              return model ? (
                <div className="pl-6 max-lg:pl-0">
                  <Section title={model.name}>
                    <VcrModelRecord model={model} />
                  </Section>
                </div>
              ) : null;
            }}
          />
        )}

      {data.methods.length > 0 && (
        <Disclosure summary={`方法包 · ${data.methods.length}`}>
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
                  ? (
                    <span className="flex flex-col gap-1">
                      <span className="inline-flex items-center gap-1 text-ok"><CircleCheck size={16} aria-hidden="true" />{row.numeric}</span>
                      {row.validation?.ciUrl && <a className="text-link hover:underline" href={row.validation.ciUrl} target="_blank" rel="noreferrer">查看验证来源</a>}
                    </span>
                  )
                  : <span className="text-text-3">—</span>,
              },
              {
                key: "assumptions",
                header: "适用假设",
                isEmpty: (row) => !row.assumptions?.length,
                cell: (row) => row.assumptions?.length
                  ? (
                    <Disclosure summary="查看假设及来源">
                      <List label={`${row.name} 的适用假设`}>
                        {row.assumptions.map((item, index) => (
                          <li key={index} className="py-1">
                            <p>{item.text}</p>
                            <p className="text-text-3">{item.source}</p>
                          </li>
                        ))}
                      </List>
                    </Disclosure>
                  )
                  : <span className="text-text-3">—</span>,
              },
              { key: "usedIn", header: "用在", isEmpty: (row) => !row.usedIn, cell: (row) => row.usedIn ?? "—" },
            ]}
            rows={data.methods}
            rowKey={(row) => row.id}
            rowAttrs={(row) => ({ "data-vcr-method": row.id })}
          />
        </Disclosure>
      )}

      {data.ladder && data.ladder.length > 0 && (
        <Disclosure summary="可信度要求（按用途）">
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
        </Disclosure>
      )}

      {adopting && <VcrModelAdoptDialog onClose={() => setAdopting(false)} onSaved={reload} />}
    </div>
  );
}

/** What a model row says under its name: where it comes from, what it predicts and how risky it is. */
function ModelMeta({ model }: { model: VcrModelCard }) {
  return (
    <span className="flex flex-col gap-1">
      {/* The tier and what the model may be used for are the row's two marks; beside the name they would leave it a narrow column to wrap in. */}
      <span className="flex flex-wrap items-center gap-1.5">
        <Tag>{modelTierLabel(model.tier)}</Tag>
        <Tag tone="accent">{intendedUseLabel(model.useCeiling)}</Tag>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-caption text-text-3">
        {model.family && <span>{model.family}</span>}
        {model.version && <span className="tabular-nums">{model.version}</span>}
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
      {model.scope && <span className="truncate text-caption text-text-2">{model.scope}</span>}
    </span>
  );
}
