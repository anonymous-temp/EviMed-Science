import type { GeoProject } from "@/lib/geoClient";
import { useGeoFrame } from "../geoFrame";
import { useGeoStrategy } from "../geoProjectData";
import { StepPending, TabError, TabSkeleton } from "./geoTabKit";
import { Assumptions, Battlefield, ClientToDos, EnginePromises, Targets } from "./PlanStrategy";

/**
 * 方案 — the strategy and the targets (R19 audit C §2.3), about a screen and a half: what the programme is aiming at (the three
 * tiers, the choice being the column's header), where the work goes (the battlefield), what each engine can be promised, what the
 * client has to do, and what the plan took as given.
 *
 * It reads `GET …/strategy` and nothing else: the page used to read every source of the project (1,734 rows) to find a tier and a
 * layout. It is one kind of object — a plan — so the measurement settings (engines, cadence, budget, publisher, members), the
 * journey and the claims are not blocks of it: they are the header's 项目设置, 问题与回答 and 依据.
 */
export function PlanTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoStrategy(geoId);
  const frame = useGeoFrame();
  if (state.kind === "loading") return <TabSkeleton rows={4} />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const plan = state.data;
  // No strategy run has written yet: the step that makes it is the recipe.
  if (plan.version === null && plan.tiers.length === 0 && !plan.battlefield) {
    return <StepPending geoId={geoId} project={project} step="sources" />;
  }
  return (
    <div data-geo-tab="plan" className="flex flex-col gap-10">
      <Targets geoId={geoId} plan={plan} onChosen={() => { reload(); frame?.data.invalidate(); }} />
      <Battlefield geoId={geoId} plan={plan} />
      <EnginePromises plan={plan} />
      <ClientToDos geoId={geoId} plan={plan} onChanged={reload} />
      <Assumptions project={project} plan={plan} />
    </div>
  );
}
