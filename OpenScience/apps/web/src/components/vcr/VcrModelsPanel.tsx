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
import { EmptyState } from "@/components/cards/EmptyState";
import { useVcrToolbar } from "./studyFrameContext";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrModelAdoptDialog } from "./VcrModelAdoptDialog";
import { endpointLabel, VcrModelRecord } from "./VcrModelRecord";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { VcrMethodRunner, methodTask } from "./VcrMethodRunner";
import { intendedUseLabel, modelRiskLabel, modelTierLabel } from "./vcrText";

type VcrModelsMethod = import("@/lib/vcrClient").VcrModels["methods"][number];

type Filter = "all" | VcrModelTier;

/** Models retain their evidence records; task-grouped methods configure the existing study computation jobs. */
export function VcrModelsPanel() {
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [revisingModel, setRevisingModel] = useState<VcrModelCard | null>(null);
  const [runningMethod, setRunningMethod] = useState<VcrModelsMethod | null>(null);
  const [sourceModel, setSourceModel] = useState<VcrModelCard | null>(null);
  const { state, reload } = useVcrLoad("vcr:models", () => getVcrModels());
  const data = state.kind === "ready" ? state.data : null;
  const tiers = (["scenario", "literature", "data", "validated"] as const)
    .map((tier) => ({ value: tier, count: data ? data.models.filter((model) => model.tier === tier).length : 0 }))
    .filter((entry) => entry.count > 0);
  // The page's one toolbar, beside its views: the tier chips, how many models, the one button that adds one.
  useVcrToolbar(data
    ? {
      label: "模型与方法的筛选与操作",
      filters: tiers.length > 1
        ? [{
          kind: "chips",
          label: "可信度层级",
          neutral: "all",
          value: filter,
          onChange: (next) => setFilter(next as Filter),
          options: [{ value: "all", label: "全部", count: data.models.length }, ...tiers.map((entry) => ({ value: entry.value, label: modelTierLabel(entry.value), count: entry.count }))],
        }]
        : [],
      summary: `${data.models.length} 个模型`,
      actions: <Button variant="secondary" size="sm" onClick={() => setAdopting(true)}>引入文献模型</Button>,
    }
    : null);
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") {
    return state.off
      ? <EmptyState title={VCR_OFF_SENTENCE} />
      : <VcrTabError message={state.message} onRetry={reload} />;
  }
  if (!data) return null;
  const models = filter === "all" ? data.models : data.models.filter((model) => model.tier === filter);
  const opened = data.models.find((model) => model.id === openId) ?? null;
  // Beside the list the record is always there (the first model until one is chosen); on a narrow page it opens on a press.
  const current = (opened && models.includes(opened) ? opened : null) ?? models[0] ?? null;

  return (
    <div className="flex flex-col gap-6">
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
                    {model.registrationState && <p className="text-caption text-text-2">{model.registrationState === "parameterized_reference" ? "已有来源参数参考配置；个体预测能力及临床验证尚未建立。" : "文献来源已登记，模型说明或参数仍待补充。"}</p>}
                    {model.specificationMissing?.length ? <ul className="text-caption text-text-2">{model.specificationMissing.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
                    {model.executionSpec && <Button variant="secondary" onClick={() => { const method = data.methods.find(row => row.method === model.executionSpec?.method); if (method) { setSourceModel(model); setRunningMethod(method); } }}>配置来源参数参考仿真</Button>}
                    {model.tier === "literature" && <Button variant="secondary" onClick={() => { setRevisingModel(model); setAdopting(true); }}>补充来源并登记新版本</Button>}
                  </Section>
                </div>
              ) : null;
            }}
          />
        )}

      {data.methods.length > 0 && (
        <Section title="方法">
          {Array.from(new Set(data.methods.map((method) => methodTask(method.method ?? method.id)))).map((task) => (
            <Section key={task} title={task}>
              <List label={task}>
                {data.methods.filter((method) => methodTask(method.method ?? method.id) === task).map((method) => (
                  <ListRow key={method.id} title={method.name} onOpen={() => { setSourceModel(null); setRunningMethod(method); }}
                    titleProps={{ "data-vcr-method": method.id }}
                    meta={<span className="text-caption text-text-3">{method.endpoints ?? "终点要求未说明"} · {method.usedIn ?? "选择研究后配置"}</span>} />
                ))}
              </List>
            </Section>
          ))}
        </Section>
      )}
      {runningMethod && <VcrMethodRunner key={`${runningMethod.id}:${sourceModel?.id ?? ""}`} method={runningMethod} sourceModel={sourceModel?.executionSpec ? { id: sourceModel.id, version: sourceModel.version, studyId: sourceModel.studyId, scenario: sourceModel.executionSpec.scenario } : undefined} onClose={() => { setRunningMethod(null); setSourceModel(null); }} />}

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

      {adopting && <VcrModelAdoptDialog initialModel={revisingModel} onClose={() => { setAdopting(false); setRevisingModel(null); }} onSaved={reload} />}
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
