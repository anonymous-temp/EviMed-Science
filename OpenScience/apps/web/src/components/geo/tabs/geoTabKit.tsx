import { useState, type ReactNode } from "react";
import { Link } from "react-router";
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
import { useGeoFrame } from "../geoFrame";
import { GEO_STEP_RECIPES } from "../geoStepRecipes";
import { geoDestinationPath, GEO_STEP_HOME } from "../geoTabs";
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
    <div data-geo-tab-loading="" className="animate-pulse" aria-hidden="true">
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
    </div>
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
  return state?.status === "none" && state.requested === true;
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
  const frame = useGeoFrame();
  const [busy, setBusy] = useState(false);
  const recipe = GEO_STEP_RECIPES[step];
  const state = project.steps[step];
  // A queued step the allowance would not start is not work under way: it says what it waits on and where that is put right.
  const allowanceWait = stepAllowanceWait(state);
  const start = () => {
    setBusy(true);
    void runGeoStep(geoId, step)
      .then(() => frame?.reload())
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这一步无法开始，请稍后重试。" })))
      .finally(() => setBusy(false));
  };
  const inputs: StepInput[] = recipe.uses.map((input) => ({ label: input.label, to: geoDestinationPath(geoId, GEO_STEP_HOME[input.step]) }));
  if (allowanceWait) {
    return <StepState phase="credits" step={recipe.verb} waiting={allowanceWait} topUp={<AllowanceTopUp waiting={allowanceWait} />} />;
  }
  if (stepInProgress(project, step)) {
    return <StepState phase="running" step={recipe.verb} startedAt={state?.updatedAt ?? null} />;
  }
  if (stepWaiting(project, step)) {
    return <StepState phase="queued" step={recipe.verb} after={recipe.after ?? undefined} />;
  }
  if (state?.status === "failed") {
    return <StepState phase="failed" step={recipe.verb} onResume={start} resuming={busy} />;
  }
  return (
    <StepState
      phase="empty"
      step={recipe.verb}
      noun={recipe.noun}
      uses={inputs}
      gives={recipe.gives}
      onStart={project.access && !project.access.abilities.includes("run") ? undefined : start}
      starting={busy}
      reason={project.access && !project.access.abilities.includes("run") ? "你在这个项目里只有查看权限。" : undefined}
    />
  );
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
  const snapshot = firstSnapshot(cell, fallbackSnapshotId);
  const text = <GeoCellText cell={cell} unit={unit} layout={layout} />;
  if (!snapshot) return <span className={className}>{text}</span>;
  return (
    <Link
      to={answerPath(geoId, snapshot)}
      data-geo-cell-link=""
      className={cn("rounded hover:underline hover:decoration-border-control hover:underline-offset-4", className)}
    >
      {text}
      {label && <span className="sr-only">{`${label}，看回答`}</span>}
    </Link>
  );
}
