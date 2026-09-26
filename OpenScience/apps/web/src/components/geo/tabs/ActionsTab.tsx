import type { GeoProject } from "@/lib/geoClient";
import { ContentTab } from "./ContentTab";
import { DistributionTab } from "./DistributionTab";
import { EffectSection } from "./EffectSection";
import { TabSection } from "./geoTabKit";

/**
 * 行动 — writing and placing are one pipeline, so they are one page (appendix
 * E §3.2). 「内容」 and 「投放」 were two tabs, and a reader had to hold the
 * article list in their head to make sense of the order list.
 *
 * Its last section is the measurement of the work itself: the question groups
 * we placed articles for against the ones we only watched. That used to live
 * in 「监测」, one tab away from the placements it is about.
 */
export function ActionsTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  return (
    <div data-geo-tab="actions" className="flex flex-col gap-10">
      <ContentTab geoId={geoId} project={project} />
      <TabSection title="投放">
        <DistributionTab geoId={geoId} project={project} />
      </TabSection>
      <TabSection title="效果">
        <EffectSection project={project} />
      </TabSection>
    </div>
  );
}
