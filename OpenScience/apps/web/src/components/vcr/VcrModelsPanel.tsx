import { useState } from "react";
import { getVcrModels } from "@/lib/vcrClient";
import { Button } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrModelRecord } from "./VcrModelRecord";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { useGeneralResearchDraft } from "./useGeneralResearchDraft";

/** Saved scientific objects remain browsable independently of numerical methods. */
export function VcrModelsPanel() {
  const { state, reload } = useVcrLoad("vcr:models", getVcrModels);
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  const ask = useGeneralResearchDraft();
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return state.off ? <EmptyState title={VCR_OFF_SENTENCE} /> : <VcrTabError message={state.message} onRetry={reload} />;
  const models = state.data.models;
  if (!models.length) return <EmptyState title="还没有保存的模型与参数" action={<Button variant="secondary" onClick={() => ask("请帮我从文献整理适合这项研究的参数与模型，保留来源和适用范围：")}>在对话中整理来源</Button>} />;
  return <List label="保存的模型与参数" divided>{models.map(model => <ListRow key={`${model.id}:${model.version}`} title={model.name} onOpen={() => setOpenModelId(current => current === model.id ? null : model.id)} expanded={openModelId === model.id} titleProps={{ "data-vcr-model": model.id }} meta={<>
    <span className="text-caption text-text-3">{model.version ? `版本 ${model.version}` : "版本未记录"}</span>
    {openModelId === model.id && <div className="relative z-sticky"><Section title={model.name}><VcrModelRecord model={model} />
      <div className="flex flex-wrap gap-3"><Button size="sm" variant="secondary" disabled={!model.version} onClick={() => ask(`请在研究中使用“${model.name}”${model.version ? `（版本 ${model.version}）` : ""}，先核对适用范围与证据。`, { kind: "model", ...(model.studyId ? { studyId: model.studyId } : {}), objectId: model.id, version: model.version ?? undefined })}>在对话中使用</Button><Button size="sm" variant="text" disabled={!model.version} onClick={() => ask(`请为“${model.name}”${model.version ? `（版本 ${model.version}）` : ""}补充来源，保留当前版本并建立新版本。`, { kind: "model", ...(model.studyId ? { studyId: model.studyId } : {}), objectId: model.id, version: model.version ?? undefined })}>在对话中补充来源</Button></div>
    </Section></div>}
  </>} />)}</List>;
}
