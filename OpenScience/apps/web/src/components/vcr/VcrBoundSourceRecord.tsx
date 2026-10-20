import { useState } from "react";
import { getVcrModels } from "@/lib/vcrClient";
import { Disclosure } from "@/components/ui/Disclosure";
import { VcrModelRecord } from "./VcrModelRecord";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

export function VcrBoundSourceRecord({ modelId, version }: { modelId: string; version?: string | null }) {
  const [open, setOpen] = useState(false);
  return <Disclosure summary="文献参数与原文依据" onToggle={setOpen}>{open && <SourceRecord modelId={modelId} version={version} />}</Disclosure>;
}
function SourceRecord({ modelId, version }: { modelId: string; version?: string | null }) {
  const { state, reload } = useVcrLoad(`bound-source:${modelId}`, getVcrModels);
  if (state.kind === "loading") return <VcrTabSkeleton rows={1} />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const model = state.data.models.find(row => row.id === modelId && (!version || row.version === version));
  return model ? <VcrModelRecord model={model} /> : <p role="status" className="text-ui">此来源版本暂时无法读取，历史配置与结果仍保留。</p>;
}
