import { getGeoSources, type GeoProject, type GeoTier } from "@/lib/geoClient";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { EvidenceTab } from "./EvidenceTab";
import { JourneyTab } from "./JourneyTab";
import { Layout, Targets } from "./PlanStrategy";
import { TabError, TabSection, TabSkeleton, useGeoLoad } from "./geoTabKit";
import { marketConnected } from "../geoOverviewModel";
import { coverageText, engineName } from "../geoText";
import { yuan } from "./geoTabText";

/**
 * 方案 — what this programme is measuring and what it is meant to reach, in the order a reader asks: how it is measured (which
 * engines, how long, how much budget), what it is aiming at (the target tier, chosen here, with its numbers), where the work goes
 * (the main battlefield and what each engine can be expected to do), who the patients and doctors are, and last the product and
 * the claims every sentence we publish rests on.
 *
 * It is the page a reader opens to answer “按什么口径算的”, which is why the settings sit here and not under a chart.
 */
export function PlanTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const engines = (project.engines ?? []).map(engineName).join("、");
  return (
    <div data-geo-tab="plan" className="flex flex-col gap-10">
      <Panel title="测量方案">
        <PanelRow label="测量的 AI 引擎" control={engines || "—"} />
        <PanelRow label="覆盖周期" control={coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)} />
        <PanelRow
          label="投放预算"
          control={project.budget && project.budget.totalCny > 0
            ? `${yuan(project.budget.totalCny)} · 每天最多 ${yuan(project.budget.dailyCny)}`
            : marketConnected(project) ? "还没有设" : "等媒介集市接通"}
        />
      </Panel>
      <Strategy geoId={geoId} project={project} />
      <TabSection title="患者与医生的旅程" level="ui">
        <JourneyTab geoId={geoId} project={project} />
      </TabSection>
      <TabSection title="产品与依据" level="ui">
        <EvidenceTab geoId={geoId} project={project} />
      </TabSection>
    </div>
  );
}

/** The target tier and the layout, read from the sources analysis; nothing is drawn for a part it has not produced. */
function Strategy({ geoId, project }: { geoId: string; project: GeoProject }) {
  const { state, reload } = useGeoLoad(`plan-strategy:${geoId}`, () => getGeoSources(geoId));
  if (state.kind === "loading") return <TabSkeleton rows={3} />;
  if (state.kind === "error") return <TabError message={state.message} onRetry={reload} />;
  const data = state.data;
  const tiers: GeoTier[] = (Array.isArray(data?.tiers) ? data.tiers : []).filter((tier) => tier && ["1", "2", "3"].includes(tier.tier));
  const expectations = (Array.isArray(data?.expectations) ? data.expectations : []).filter((row) => row && row.engine);
  return (
    <>
      {tiers.length > 0 && <Targets geoId={geoId} tiers={tiers} chosen={data.chosenTier ?? project.tier ?? null} onChanged={reload} />}
      <Layout geoId={geoId} battlefield={data?.battlefield ?? null} expectations={expectations} />
    </>
  );
}
