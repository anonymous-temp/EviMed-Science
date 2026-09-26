import type { GeoProject } from "@/lib/geoClient";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { EvidenceTab } from "./EvidenceTab";
import { JourneyTab } from "./JourneyTab";
import { TabSection } from "./geoTabKit";
import { coverageText, engineName } from "../geoText";
import { yuan } from "./geoTabText";

const TIER_WORDS: Readonly<Record<string, string>> = Object.freeze({ "1": "档一", "2": "档二", "3": "档三" });

/**
 * 方案 — what this programme is measuring and on what grounds: the product's
 * own identity and the claims library behind every sentence we publish, the
 * journey the questions were drawn from, and the settings a reader may need to
 * check (which engines, how long, which target tier, how much budget).
 *
 * It is the page a reader opens to answer 「按什么口径算的」, which is why the
 * settings sit here and not under a chart.
 */
export function PlanTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const engines = (project.engines ?? []).map(engineName).join("、");
  return (
    <div data-geo-tab="plan" className="flex flex-col gap-10">
      <Panel title="测量方案">
        <PanelRow label="测量的 AI 引擎" control={engines || "—"} />
        <PanelRow label="覆盖周期" control={coverageText(project.coverageDays, project.startedAt ?? project.createdAt ?? null)} />
        <PanelRow label="目标档位" control={TIER_WORDS[project.tier] ?? "—"} />
        <PanelRow
          label="投放预算"
          control={project.budget && project.budget.totalCny > 0
            ? `${yuan(project.budget.totalCny)} · 每天最多 ${yuan(project.budget.dailyCny)}`
            : "还没有设"}
        />
      </Panel>
      <TabSection title="产品与依据">
        <EvidenceTab geoId={geoId} project={project} />
      </TabSection>
      <TabSection title="患者与医生的旅程">
        <JourneyTab geoId={geoId} project={project} />
      </TabSection>
    </div>
  );
}
