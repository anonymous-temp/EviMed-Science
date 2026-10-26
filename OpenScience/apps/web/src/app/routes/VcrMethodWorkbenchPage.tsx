import { Link, useParams, useSearchParams } from "react-router";
import { getVcrJob, getVcrMethodConfiguration, getVcrModels, getVcrStudy } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { Disclosure } from "@/components/ui/Disclosure";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { VcrMethodResult } from "@/components/vcr/VcrMethodResult";
import { VcrReadOnlyConfiguration } from "@/components/vcr/VcrReadOnlyConfiguration";
import { VcrTabSkeleton } from "@/components/vcr/VcrStates";
import { useVcrLoad, VcrTabError } from "@/components/vcr/vcrTabKit";
import { isVcrTab, vcrTabPath } from "@/components/vcr/vcrTabs";
import { vcrChatPath } from "@/lib/studyLocation";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";

/** Legacy method addresses preserve an exact job; new work starts in conversation. */
export function VcrMethodWorkbenchPage() {
  const [query] = useSearchParams();
  const { methodId = "" } = useParams();
  const studyId = query.get("study");
  const jobId = query.get("job");
  const view = query.get("view");
  if (!studyId || !jobId) return <PageShell title="虚拟临床研究" width="wide"><EmptyState title="计算已移入研究对话" description="描述研究问题，AI 会查找证据、选择方法并调用计算。" action={<Link to="/app/virtual-research" className="text-link">开始研究任务</Link>} /></PageShell>;
  return <HistoricalResult key={`${studyId}:${jobId}:${methodId}`} studyId={studyId} jobId={jobId} methodId={methodId} view={view} />;
}
function HistoricalResult({ studyId, jobId, methodId, view }: { studyId: string; jobId: string; methodId: string; view: string | null }) {
  const context = useVcrLoad(`historical-study:${studyId}`, () => getVcrStudy(studyId));
  const methods = useVcrLoad("historical-methods", getVcrModels);
  const { state, reload } = useVcrLoad(`historical-method:${studyId}:${jobId}`, () => getVcrJob(studyId, jobId));
  const configuration = useVcrLoad(`historical-configuration:${studyId}:${jobId}`, () => getVcrMethodConfiguration(studyId, jobId));
  const method = configuration.state.kind === "ready" ? configuration.state.data.method : methodId;
  const name = methods.state.kind === "ready" ? methods.state.data.methods.find(row => row.id === method || row.method === method)?.name : null;
  const programme = context.state.kind === "ready" && context.state.data.purpose !== "calculation";
  const conversation = programme ? <Link to={vcrChatPath(studyId)} className="text-link">研究对话</Link> : undefined;
  return <PageShell title={name ?? "历史计算结果"} width="wide" back={<Link to={programme && isVcrTab(view) ? vcrTabPath(studyId, view) : programme ? vcrTabPath(studyId, "overview") : vcrCalculationPath(studyId)} className="text-link">{programme ? "返回研究结果" : "计算历史"}</Link>} actions={conversation}>
    {context.state.kind === "error" && <Note action={<Button variant="text" size="sm" onClick={context.reload}>重读研究信息</Button>}>{context.state.message}</Note>}
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <VcrMethodResult studyId={studyId} job={state.data} continuation={conversation} />}
    <Disclosure summary="本次运行配置">{configuration.state.kind === "error"
      ? <Note action={<Button size="sm" variant="text" onClick={configuration.reload}>重读配置</Button>}>{configuration.state.message}</Note>
      : configuration.state.kind === "ready" ? <VcrReadOnlyConfiguration configuration={configuration.state.data} /> : <VcrTabSkeleton rows={1} />}</Disclosure>
  </PageShell>;
}
