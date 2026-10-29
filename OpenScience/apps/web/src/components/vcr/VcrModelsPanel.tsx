import { useState } from "react";
import { useNavigate } from "react-router";
import { getVcrModels, type VcrModelCard } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { DataTable } from "@/components/ui/DataTable";
import { modelRiskLabel, intendedUseLabel } from "./vcrText";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrMethodCatalogue } from "./VcrMethodCatalogue";
import { VcrMethodRunner } from "./VcrMethodRunner";
import { VcrModelAdoptDialog } from "./VcrModelAdoptDialog";
import { VcrModelRecord } from "./VcrModelRecord";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { methodEntryId, type VcrMethod } from "@/lib/vcrMethodDisplay";

/** Compatibility entry for old model-library links, reusing the shared method surface. */
export function VcrModelsPanel() {
  const navigate = useNavigate();
  const { state, reload } = useVcrLoad("vcr:models", getVcrModels);
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  const [family, setFamily] = useState("all");
  const [running, setRunning] = useState<VcrMethod | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [revision, setRevision] = useState<VcrModelCard | null>(null);
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return state.off ? <EmptyState title={VCR_OFF_SENTENCE} /> : <VcrTabError message={state.message} onRetry={reload} />;
  const data = state.data;
  if (adopting) return <VcrModelAdoptDialog initialModel={revision} onClose={() => { setAdopting(false); setRevision(null); }} onSaved={reload} />;
  if (running) return <VcrMethodRunner method={running} methods={data.methods} onClose={() => setRunning(null)} />;
  return <div className="min-w-0">
    {family !== "all" && <Button variant="text" size="sm" onClick={() => setFamily("all")}>全部计算任务</Button>}
    <VcrMethodCatalogue methods={data.methods} family={family} onSelectFamily={setFamily} onOpen={setRunning} />
    {!data.methods.length && <EmptyState title="还没有可用方法" />}
    <Disclosure summary="文献参数与模型来源"><div className="flex flex-col gap-4"><Button variant="secondary" onClick={() => setAdopting(true)}>使用文献参数</Button><List label="保存的参数与模型">{data.models.map(model => <ListRow key={model.id} title={model.name} onOpen={() => setOpenModelId(model.id)} titleProps={{ "data-vcr-model": model.id }} meta={(openModelId ?? data.models[0]?.id) === model.id ? <Section title={model.name}><VcrModelRecord model={model} />{model.registrationState && <p>{model.registrationState === "parameterized_reference" ? "已有可运行的来源参数参考场景；尚未建立个体预测能力及临床验证。" : "来源已登记，尚不能直接运行。"}</p>}{model.executionSpec && <Button size="sm" variant="secondary" onClick={() => { const method = data.methods.find(row => row.method === model.executionSpec?.method); if (method) navigate(`/app/capabilities/methods/${encodeURIComponent(methodEntryId(method))}?model=${encodeURIComponent(model.id)}`); }}>选择研究并使用参数</Button>}{model.tier === "literature" && <Button size="sm" variant="text" onClick={() => { setRevision(model); setAdopting(true); }}>补充来源并保存新版本</Button>}</Section> : undefined} />)}</List>{data.ladder?.length ? <Disclosure summary="可信度要求（按用途）"><DataTable label="可信度要求" columns={[{ key: "risk", header: "模型风险", rowHeader: true, cell: row => modelRiskLabel(row.risk) }, { key: "needs", header: "至少要有的证据", cell: row => row.needs }, { key: "ceiling", header: "最高预期用途", cell: row => intendedUseLabel(row.ceiling) }]} rows={data.ladder} rowKey={row => row.risk} /></Disclosure> : null}</div></Disclosure>
  </div>;
}
