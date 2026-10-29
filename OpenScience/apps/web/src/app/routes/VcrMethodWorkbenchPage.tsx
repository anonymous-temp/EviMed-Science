import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams, useLocation } from "react-router";
import { fetchWebMe, WEB_SESSION_ENDED_EVENT, webErrorMessage } from "@/lib/apiClient";
import { activateMethodDraftOwner, type MethodDraftScope } from "@/lib/vcrMethodDraft";
import { getVcrModels, getVcrStudy } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrMethodRunner, type VcrMethodRunnerProps } from "@/components/vcr/VcrMethodRunner";
import { VcrTabSkeleton } from "@/components/vcr/VcrStates";
import { useVcrLoad, VcrTabError } from "@/components/vcr/vcrTabKit";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";
import { vcrChatPath } from "@/lib/studyLocation";
import { isVcrTab, stepsOfTab, vcrTabPath, vcrWorkflowSteps } from "@/components/vcr/vcrTabs";
import { methodEntryId, methodTitle } from "@/lib/vcrMethodDisplay";

interface MethodScope { address: string; props: VcrMethodRunnerProps }
type DraftOwner = Pick<MethodDraftScope, "userId" | "tenantId" | "projectId">;
export function VcrMethodWorkbenchPage() {
  const [owner, setOwner] = useState<DraftOwner | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const ended = () => { live = false; setOwner(null); setError("请重新确认登录后继续编辑方法参数。"); };
    window.addEventListener(WEB_SESSION_ENDED_EVENT, ended);
    void fetchWebMe().then(me => {
      if (!live) return;
      if (!me?.user?.id || !me?.project?.id) { setError("请重新确认登录后继续编辑方法参数。"); return; }
      const tenantId = me.tenant?.id ?? me.user.tenantId ?? me.user.id;
      activateMethodDraftOwner(me.user.id, tenantId);
      setOwner({ userId: me.user.id, tenantId, projectId: me.project.id });
    }).catch(failure => { if (live) setError(webErrorMessage(failure, { fallback: "账户暂时无法读取，请重试。" })); });
    return () => { live = false; window.removeEventListener(WEB_SESSION_ENDED_EVENT, ended); };
  }, [attempt]);
  if (!owner) return <PageShell title="方法工作台" width="wide">{error ? <VcrTabError message={error} onRetry={() => { setError(""); setAttempt(value => value + 1); }} /> : <VcrTabSkeleton />}</PageShell>;
  return <AddressedMethodWorkbench key={`${owner.tenantId}:${owner.userId}:${owner.projectId}`} owner={owner} />;
}
function AddressedMethodWorkbench({ owner }: { owner: DraftOwner }) {
  const location = useLocation();
  const { methodId } = useParams();
  const [query] = useSearchParams();
  const { state, reload } = useVcrLoad("method:catalogue", getVcrModels);
  const studyId = query.get("study") ?? undefined;
  const context = useVcrLoad(`method:context:${studyId ?? "none"}`, () => studyId ? getVcrStudy(studyId) : Promise.resolve(null));
  const study = context.state.kind === "ready" ? context.state.data : null;
  const programme = study?.purpose !== "calculation";
  const returnView = query.get("view");
  const originView = isVcrTab(returnView) ? returnView : "overview";
  const jobId = query.get("job") ?? undefined;
  const modelId = query.get("model") ?? undefined;
  const current = useMemo<MethodScope | null>(() => {
    if (state.kind !== "ready" || studyId && (!study || study.id !== studyId)) return null;
    const method = state.data.methods.find(row => row.id === methodId || row.method === methodId || methodEntryId(row) === methodId);
    const model = state.data.models.find(row => row.id === modelId);
    const chosen = model?.executionSpec ? state.data.methods.find(row => row.method === model.executionSpec?.method) ?? method : method;
    if (!chosen) return null;
    const sourceModel = model?.executionSpec && model.executionSpec.method === (chosen.method ?? chosen.id) ? { id: model.id, version: model.version, studyId: model.studyId, scenario: model.executionSpec.scenario } : undefined;
    return { address: JSON.stringify([chosen.id, studyId, jobId, modelId, sourceModel?.version ?? null, (location.state as { methodScenario?: unknown } | null)?.methodScenario ? location.key : null]), props: { method: chosen, methods: state.data.methods, sourceModel, studyId, initialStudyId: studyId, initialJobId: jobId, initialScenario: (location.state as { methodScenario?: Record<string, unknown> } | null)?.methodScenario, showTitle: false, draftScope: { ...owner, projectId: study?.projectId ?? owner.projectId, studyId: studyId ?? "", method: chosen.method ?? chosen.id, jobId, modelId, modelVersion: sourceModel?.version, launchId: (location.state as { methodScenario?: unknown } | null)?.methodScenario ? location.key : undefined } } };
  }, [state, methodId, studyId, jobId, modelId, location.state, location.key, study, owner]);
  // Same-route addresses retain their controls. The account-scoped session cache also restores editable values after leaving this route.
  const [scopes, setScopes] = useState<MethodScope[]>([]);
  useEffect(() => { if (current) setScopes(previous => previous.some(scope => scope.address === current.address) ? previous : [...previous, current]); }, [current]);
  const shown = current && !scopes.some(scope => scope.address === current.address) ? [...scopes, current] : scopes;
  const draftNotice = (location.state as { methodDraftNotice?: string } | null)?.methodDraftNotice;
  return <PageShell title={current ? methodTitle(current.props.method) : "方法工作台"} width="wide"
    back={study ? <Link to={programme ? vcrTabPath(study.id, originView) : vcrCalculationPath(study.id)} className="rounded text-ui text-link hover:underline">{study.name}</Link> : undefined}
    steps={study && programme ? { label: "研究进度", steps: vcrWorkflowSteps(study), activeSteps: stepsOfTab(originView), visible: true, showState: true } : undefined}
    actions={<>{study && <><Link to={vcrTabPath(study.id, "data")} className="rounded text-ui text-link hover:underline">资料与证据</Link>{programme && <Link to={vcrChatPath(study.id)} className="rounded text-ui text-link hover:underline">研究对话</Link>}</>}<Link to="/app/capabilities" className="text-ui text-link hover:underline">科研工具</Link></>}>
    {context.state.kind === "error" && <VcrTabError message={context.state.message} onRetry={context.reload} />}
    {draftNotice && <p role="status" className="mb-4 text-ui">{draftNotice}</p>}
    {state.kind === "loading" || studyId && context.state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : studyId && context.state.kind === "error" ? null : !current ? <EmptyState title="没有找到这个方法" action={<Button variant="secondary" onClick={reload}>重新读取方法目录</Button>} /> : null}
    {shown.map(scope => <div key={scope.address} hidden={!current || scope.address !== current.address} data-method-scope={scope.address}><VcrMethodRunner {...scope.props} active={scope.address === current?.address} /></div>)}
  </PageShell>;
}
