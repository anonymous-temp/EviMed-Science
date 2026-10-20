import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams, useLocation } from "react-router";
import { getVcrModels } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrMethodRunner, type VcrMethodRunnerProps } from "@/components/vcr/VcrMethodRunner";
import { VcrTabSkeleton } from "@/components/vcr/VcrStates";
import { useVcrLoad, VcrTabError } from "@/components/vcr/vcrTabKit";
import { methodEntryId, methodTitle } from "@/lib/vcrMethodDisplay";

interface MethodScope { address: string; props: VcrMethodRunnerProps }
export function VcrMethodWorkbenchPage() {
  const location = useLocation();
  const { methodId } = useParams();
  const [query] = useSearchParams();
  const { state, reload } = useVcrLoad("method:catalogue", getVcrModels);
  const studyId = query.get("study") ?? undefined;
  const jobId = query.get("job") ?? undefined;
  const modelId = query.get("model") ?? undefined;
  const current = useMemo<MethodScope | null>(() => {
    if (state.kind !== "ready") return null;
    const method = state.data.methods.find(row => row.id === methodId || row.method === methodId || methodEntryId(row) === methodId);
    const model = state.data.models.find(row => row.id === modelId);
    const chosen = model?.executionSpec ? state.data.methods.find(row => row.method === model.executionSpec?.method) ?? method : method;
    if (!chosen) return null;
    const sourceModel = model?.executionSpec && model.executionSpec.method === (chosen.method ?? chosen.id) ? { id: model.id, version: model.version, studyId: model.studyId, scenario: model.executionSpec.scenario } : undefined;
    return { address: JSON.stringify([chosen.id, studyId, jobId, modelId, (location.state as { methodScenario?: unknown } | null)?.methodScenario ? location.key : null]), props: { method: chosen, methods: state.data.methods, sourceModel, initialStudyId: studyId, initialJobId: jobId, initialScenario: (location.state as { methodScenario?: Record<string, unknown> } | null)?.methodScenario, showTitle: false } };
  }, [state, methodId, studyId, jobId, modelId, location.state, location.key]);
  // The addressed workspaces stay mounted only within this authenticated route. Back/Forward restores each scope's unsent form;
  // a late response can only update its own hidden scope, and leaving the route drops every retained form.
  const [scopes, setScopes] = useState<MethodScope[]>([]);
  useEffect(() => { if (current) setScopes(previous => previous.some(scope => scope.address === current.address) ? previous : [...previous, current]); }, [current]);
  const shown = current && !scopes.some(scope => scope.address === current.address) ? [...scopes, current] : scopes;
  const draftNotice = (location.state as { methodDraftNotice?: string } | null)?.methodDraftNotice;
  return <PageShell title={current ? methodTitle(current.props.method) : "方法工作台"} width="wide" actions={<Link to="/app/capabilities" className="text-ui text-link hover:underline">科研工具</Link>}>
    {draftNotice && <p role="status" className="mb-4 text-ui">{draftNotice}</p>}
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : !current ? <EmptyState title="没有找到这个方法" action={<Button variant="secondary" onClick={reload}>重新读取方法目录</Button>} /> : shown.map(scope => <div key={scope.address} hidden={scope.address !== current.address} data-method-scope={scope.address}><VcrMethodRunner {...scope.props} /></div>)}
  </PageShell>;
}
