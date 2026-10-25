import { Link, useNavigate, useParams } from "react-router";
import { VCR_JOB_METHODS } from "@evimed/domain";
import { getVcrMethodHistory, getVcrModels, getVcrStudy } from "@/lib/vcrClient";
import { vcrMethodPath } from "@/lib/vcrMethodLocation";
import { EmptyState } from "@/components/cards/EmptyState";
import { PageShell } from "@/components/layout/PageShell";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { VcrStudyPage } from "@/app/virtual-research/VcrStudyPage";
import { vcrTabPath } from "@/components/vcr/vcrTabs";
import { VcrTabSkeleton } from "@/components/vcr/VcrStates";
import { useVcrLoad, VcrTabError } from "@/components/vcr/vcrTabKit";

/** A calculation container may hold several methods. Its landing page chooses one or reopens a precise job. */
export function VcrCalculationWorkbenchPage() {
  const { studyId = "", tab } = useParams();
  if (tab) return <VcrStudyPage />;
  return <CalculationScope key={studyId} studyId={studyId} />;
}
function CalculationScope({ studyId }: { studyId: string }) {
  const navigate = useNavigate();
  const context = useVcrLoad(`calculation-context:${studyId}`, () => getVcrStudy(studyId));
  const catalogue = useVcrLoad("calculation:methods", getVcrModels);
  const history = useVcrLoad(`calculation-history:${studyId}`, () => getVcrMethodHistory(studyId));
  return <PageShell title={context.state.kind === "ready" ? context.state.data.name : "独立计算"} width="wide" actions={<><Link to={vcrTabPath(studyId, "data")} className="rounded text-ui text-link hover:underline">资料与证据</Link><Link to={vcrTabPath(studyId, "matching")} className="rounded text-ui text-link hover:underline">入排匹配</Link></>}>
    {context.state.kind === "error" && <VcrTabError message={context.state.message} onRetry={context.reload} />}
    {history.state.kind === "loading" ? <VcrTabSkeleton rows={1} /> : history.state.kind === "error" ? <VcrTabError message={history.state.message} onRetry={history.reload} /> : history.state.data.jobs.length === 0 ? <EmptyState title="这里还没有历史计算" action={<Link to="/app/virtual-research" className="text-link">开始研究对话</Link>} /> : <Section title="历史计算"><List label="此计算空间的历史" divided>{history.state.data.jobs.map(job => {
      const method = job.method ?? (VCR_JOB_METHODS as Record<string, string>)[job.kind];
      const title = catalogue.state.kind === "ready" ? catalogue.state.data.methods.find(row => (row.method ?? row.id) === method)?.name : null;
      return <ListRow key={job.id} title={title ?? job.label ?? "方法计算"} meta={job.createdAt ?? job.updatedAt} onOpen={method ? () => navigate(vcrMethodPath(method, { studyId, jobId: job.id })) : undefined} />;
    })}</List></Section>}

  </PageShell>;
}
