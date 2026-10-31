import { geoWorkflowState } from "@evimed/domain";
import { Button } from "@/components/ui/Button";
import { geoActionPermission, geoJourney } from "../geoJourney";
import { GeoStepRunButton } from "../GeoStepRunButton";
import { useOpenGeoConversation } from "../useOpenGeoConversation";
import { GEO_STEP_NAMES } from "../geoText";
import { PendingFeedback } from "@/components/ui/PendingFeedback";
import { useGeoDestinationPath } from "../useGeoPath";
import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { webErrorMessage } from "@/lib/apiClient";
import { stepAllowanceWait } from "@/lib/allowanceWait";
import { runGeoStep, type GeoCell, type GeoProject, type GeoStepKey } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { LoadError } from "@/components/cards/LoadError";
import { AllowanceTopUp } from "@/components/runs/AllowanceTopUp";
import { Section } from "@/components/ui/Section";
import { StepState, type StepInput } from "@/components/ui/StepState";
import { GeoCellText } from "../GeoCellText";
import { GeoMetricMembersDrawer } from "../GeoMetricMembersDrawer";
import { useGeoFrame } from "../geoFrame";
import { GEO_STEP_RECIPES } from "../geoStepRecipes";
import { GEO_STEP_HOME } from "../geoTabs";
import type { GeoUnit } from "../geoText";
import { answerPath } from "./geoTabText";

/**
 * What every tab shares: the four states (loading, error with retry, a step still being worked on, content), a section heading
 * and a number that opens the answers behind it. A tab's controls are not here: they go through `useGeoToolbar`, which puts them
 * in the fixed band, and the data a tab reads is the project's (`geoProjectData.ts`).
 */

/* --------------------------------------------------------------------- load */

export { useGeoLoad, type GeoLoad, type GeoLoadResult } from "../geoProjectData";

function Bar({ className }: { className: string }) {
  return <div className={cn("rounded bg-surface-2", className)} />;
}

/** A tab's first paint: a filter row and rows shaped like the list to come. */
export function TabSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <PendingFeedback><div data-geo-tab-loading="" className="animate-pulse" aria-hidden="true">
      <div className="flex h-sm items-center gap-2">
        <Bar className="h-sm w-16 rounded-full" />
        <Bar className="h-4 w-12" />
        <Bar className="h-4 w-12" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 border-b border-faint py-4">
          <Bar className={cn("h-3.5", index % 2 ? "w-2/3" : "w-3/4")} />
          <Bar className="h-3 w-1/4" />
        </div>
      ))}
    </div></PendingFeedback>
  );
}

/** A route that did not answer, with 重试. */
export function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <LoadError message={message} onRetry={onRetry} />;
}

/* -------------------------------------------------------------------- steps */

/** Whether the step is being worked on right now. */
export function stepInProgress(project: GeoProject, step: GeoStepKey): boolean {
  const state = project.steps[step];
  return state?.status === "running" || state?.status === "queued";
}

/** Whether the step was asked for and waits for the one before it. */
export function stepWaiting(project: GeoProject, step: GeoStepKey): boolean {
  const state = project.steps[step];
  return state?.status === "none" && geoWorkflowState(project.steps).steps[step].required;
}

/**
 * What a tab shows while it has nothing to show — one body for a step's five states (`StepState`): a recipe where nobody has begun
 * it (what it uses, each a way to the thing; what it gives; one button naming the work), the step it waits for, what is going on, what
 * was kept when it did not finish, and where the allowance is put right.
 *
 * The button starts the work and keeps the person where they are: the step moves to 「进行中」, the band's sentence says so, and
 * the page reads itself again when it finishes. The conversation is the header's 「对话」.
 */
export function StepPending({ geoId, project, step }: { geoId: string; project: GeoProject; step: GeoStepKey }) {
  const geoDestinationPath = useGeoDestinationPath();
  const navigate = useNavigate();
  const frame = useGeoFrame();
  const [busy, setBusy] = useState(false);
  const open = useOpenGeoConversation();
  const recipe = GEO_STEP_RECIPES[step];
  const state = project.steps[step];
  const workflow = geoWorkflowState(project.steps);
  const projected = workflow.steps[step];
  const permission = geoActionPermission(project, "run");
  const journey = geoJourney(project);
  const allowanceWait = stepAllowanceWait(state);
  const start = () => {
    if (!permission.allowed || busy) return;
    if (step === "monitoring") {
      navigate(geoDestinationPath(geoId, { tab: "visibility", section: "geo-automation" }));
      return;
    }
    setBusy(true);
    void runGeoStep(geoId, step)
      .then(answer => {
        toast.success(answer.accepted === false ? "没有新增任务，请查看当前工作状态。" : answer.runId ? `已开始${recipe.verb}。` : `已提交${recipe.verb}，等待开始。`, {action: frame ? {label:"查看运行记录",onClick:() => frame.openPanel("runs")} : undefined});
        frame?.reload();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一步无法开始，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  // The workflow owns dependencies; the eight destinations do not imply eight mandatory tasks.
  const inputs: StepInput[] = (projected.dependencies as GeoStepKey[]).map(key => ({ label: GEO_STEP_NAMES[key], to: geoDestinationPath(geoId, GEO_STEP_HOME[key]) }));
  const record = projected.runId ? <GeoStepRunButton project={project} runId={projected.runId} /> : null;
  let body;
  if (state?.status === "failed") body = <StepState phase="failed" step={recipe.verb} failure={projected.error ?? undefined} kept={state.summary?.text ? `已保留：${state.summary.text}` : undefined} onResume={permission.allowed ? start : undefined} resuming={busy} />;
  else if (project.status !== "active") body = <StepState phase="empty" step={recipe.verb} noun={recipe.noun} reason={permission.reason} />;
  else if (allowanceWait) body = <StepState phase="credits" step={recipe.verb} waiting={allowanceWait} topUp={permission.allowed ? <AllowanceTopUp waiting={allowanceWait} /> : undefined} />;
  else if (state?.status === "running") body = <StepState phase="running" step={recipe.verb} startedAt={state?.updatedAt ?? null} />;
  else if (state?.status === "queued" || stepWaiting(project, step)) body = <StepState phase="queued" step={recipe.verb} after={(projected.waitingFor as GeoStepKey[]).map(key => GEO_STEP_NAMES[key]).join("、") || undefined} />;

  else if (!journey.product || project.product.identityStatus === "ambiguous") body = <div className="flex flex-col items-start gap-3 py-6">
    <h2 className="text-section font-semibold">先确认产品与资料</h2>
    <p className="max-w-measure text-ui text-text-2">请在现有对话中说明产品名称、适用场景、目标受众和本次要做的工作，附上说明书、证据或稿件。已有资料会优先用于确认产品。</p>
    {journey.canConverse && <Button variant="secondary" onClick={() => void open({geoId,projectId:project.projectId,sessionId:frame?.conversation,primarySessionId:project.sessionId},journey.next.draft)}>在对话中补充产品与资料</Button>}
  </div>;
  else body = <StepState phase="empty" step={step === "monitoring" ? "设置自动监测" : `开始任务：${recipe.verb}`} noun={recipe.noun} uses={inputs} gives={recipe.gives} onStart={permission.allowed ? start : undefined} starting={busy} reason={permission.reason} />;
  return <div>{body}{record && <div className="flex justify-center">{record}</div>}{!permission.allowed && state?.status === "failed" && <p className="text-center text-caption text-text-3">{permission.reason}</p>}</div>;

}

/* ------------------------------------------------------------------ layout */

/**
 * A section inside a tab. It is FRAME's `Section` with the two levels this module used: the title's 18/600 (`section`), and the
 * panel title's 14/600 (`ui`, `compact`) on a page whose blocks are panels — so a section never adds a type size of its own (spec
 * §5.2: at most four size × weight pairs a page).
 */
export function TabSection({
  title,
  meta,
  level = "section",
  children,
  className,
}: {
  title: string;
  /** A count at the heading's end. */
  meta?: ReactNode;
  level?: "section" | "ui" | "compact";
  children: ReactNode;
  className?: string;
}) {
  // A count is the heading's own; anything else (a link to the whole list) goes where a block's controls go.
  const count = typeof meta === "string" || typeof meta === "number" ? meta : undefined;
  const toolbar = count === undefined && meta ? <span className="text-caption tabular-nums text-text-3">{meta}</span> : undefined;
  return (
    <Section title={title} count={count} toolbar={toolbar} level={level === "section" ? "section" : "sub"} className={className}>
      {children}
    </Section>
  );
}

/** A table's column heading cell. */
export const TH = "px-2 pb-2 text-left text-caption font-normal text-text-3";
/** A table's body cell. */
export const TD = "px-2 py-3 align-top text-ui text-text";

/* ----------------------------------------------------------------- numbers */

/** The first answer a number rests on, if the server named it. */
export function firstSnapshot(cell: GeoCell | null | undefined, fallback?: string | null): string | null {
  return cell?.snapshotIds?.[0] ?? fallback ?? null;
}

/**
 * A number that opens the answers behind it (build spec §6: every number
 * clickable to the answers). Without an answer to open it is plain text.
 */
export function CellLink({
  geoId,
  cell,
  unit,
  layout = "stack",
  fallbackSnapshotId,
  label,
  className,
}: {
  geoId: string;
  cell: GeoCell | null | undefined;
  unit?: GeoUnit;
  layout?: "inline" | "stack";
  /** An answer to open when the cell names none (an error's answer, say). */
  fallbackSnapshotId?: string | null;
  /** The link's accessible name: “DeepSeek 的品牌提及率”. */
  label?: string;
  className?: string;
}) {
  const [membersOpen, setMembersOpen] = useState(false);
  const location = useLocation();
  const snapshot = firstSnapshot(cell, fallbackSnapshotId);
  const text = <GeoCellText cell={cell} unit={unit} layout={layout} />;
  if (cell?.members?.selectionRef && cell.members.total > 0) return <>
    <button type="button" data-geo-cell-link="" className={cn("rounded text-left hover:underline", className)} onClick={() => setMembersOpen(true)}>
      {text}{label && <span className="sr-only">{`${label}，看回答`}</span>}
    </button>
    {membersOpen && <GeoMetricMembersDrawer geoId={geoId} members={cell.members} label={label} onClose={() => setMembersOpen(false)} />}
  </>;
  if (!snapshot) return <span className={className}>{text}</span>;
  return (
    <Link
      to={`${answerPath(geoId, snapshot)}${location.search}`}
      data-geo-cell-link=""
      className={cn("rounded hover:underline hover:decoration-border-control hover:underline-offset-4", className)}
    >
      {text}
      {label && <span className="sr-only">{`${label}，看回答`}</span>}
    </Link>
  );
}
