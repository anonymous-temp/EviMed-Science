import { useState } from "react";
import { useNavigate } from "react-router";
import { getVcrModels, type VcrTabKey } from "@/lib/vcrClient";
import { METHOD_FAMILIES, methodEntryId, methodTask } from "@/lib/vcrMethodDisplay";
import { vcrMethodPath } from "@/lib/vcrMethodLocation";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrMethodCatalogue } from "./VcrMethodCatalogue";
import { useVcrToolbar } from "./studyFrameContext";
import { useVcrLoad, VcrTabError } from "./vcrTabKit";
import { VcrTabSkeleton } from "./VcrStates";

const STEP_FAMILIES: Record<VcrTabKey, readonly string[]> = {
  overview: METHOD_FAMILIES,
  data: [METHOD_FAMILIES[2]],
  population: [METHOD_FAMILIES[0]],
  patients: [METHOD_FAMILIES[1]],
  comparator: [METHOD_FAMILIES[3], METHOD_FAMILIES[5]],
  trial: [METHOD_FAMILIES[4], METHOD_FAMILIES[5]],
  matching: [METHOD_FAMILIES[6]],
};
/** Step-scoped discovery opens the same addressed workbench and exact history as Research Tools. */
export function VcrStudyMethods({ studyId, tab }: { studyId: string; tab: VcrTabKey }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { state, reload } = useVcrLoad(`${studyId}:method-catalogue`, getVcrModels);
  useVcrToolbar({ label: "本步方法", search: { label: "搜索本步方法", value: query, onChange: setQuery, onClear: () => setQuery("") } });
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  const methods = state.data.methods.filter(method => STEP_FAMILIES[tab].includes(methodTask(method.method ?? method.id)));
  return methods.length ? <VcrMethodCatalogue methods={methods} query={query} onOpen={method => navigate(`${vcrMethodPath(methodEntryId(method), { studyId })}&view=${tab}`)} /> : <EmptyState title="这一步暂没有独立计算方法" />;
}
