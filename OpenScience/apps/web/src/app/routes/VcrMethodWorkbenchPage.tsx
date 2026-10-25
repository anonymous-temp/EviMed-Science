import { Link, useParams, useSearchParams } from "react-router";
import { getVcrJob, getVcrMethodConfiguration } from "@/lib/vcrClient";
import { PageShell } from "@/components/layout/PageShell";
import { EmptyState } from "@/components/cards/EmptyState";
import { Disclosure } from "@/components/ui/Disclosure";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { VcrMethodResult } from "@/components/vcr/VcrMethodResult";
import { VcrTabSkeleton } from "@/components/vcr/VcrStates";
import { useVcrLoad, VcrTabError } from "@/components/vcr/vcrTabKit";
import { vcrCalculationPath } from "@/lib/vcrMethodLocation";

/** Legacy method addresses preserve an exact job; new work starts in conversation. */
export function VcrMethodWorkbenchPage() {
  const [query] = useSearchParams();
  const { methodId } = useParams();
  const studyId = query.get("study");
  const jobId = query.get("job");
  if (!studyId || !jobId) return <PageShell title="虚拟临床研究" width="wide"><EmptyState title="计算已移入研究对话" description="描述研究问题，AI 会查找证据、选择方法并调用计算。" action={<Link to="/app/virtual-research" className="text-link">开始研究任务</Link>} /></PageShell>;
  return <HistoricalResult key={`${studyId}:${jobId}:${methodId}`} studyId={studyId} jobId={jobId} />;
}
function HistoricalResult({ studyId, jobId }: { studyId: string; jobId: string }) {
  const { state, reload } = useVcrLoad(`historical-method:${studyId}:${jobId}`, () => getVcrJob(studyId, jobId));
  const configuration = useVcrLoad(`historical-configuration:${studyId}:${jobId}`, () => getVcrMethodConfiguration(studyId, jobId));
  return <PageShell title="历史计算结果" width="wide" back={<Link to={vcrCalculationPath(studyId)} className="text-link">计算历史</Link>}>
    {state.kind === "loading" ? <VcrTabSkeleton /> : state.kind === "error" ? <VcrTabError message={state.message} onRetry={reload} /> : <>
      <VcrMethodResult studyId={studyId} job={state.data} />
      <Disclosure summary="本次运行配置">{configuration.state.kind === "error"
        ? <Note action={<Button size="sm" variant="text" onClick={configuration.reload}>重读配置</Button>}>{configuration.state.message}</Note>
        : <pre className="overflow-auto whitespace-pre-wrap text-caption">{configuration.state.kind === "ready" ? JSON.stringify(configuration.state.data, null, 2) : "正在读取配置"}</pre>}</Disclosure>
    </>}
  </PageShell>;
}
