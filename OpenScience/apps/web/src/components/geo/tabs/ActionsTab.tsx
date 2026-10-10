import { ValueSection } from "./ValueSection";
import { getGeoDistribution, type GeoProject } from "@/lib/geoClient";
import { ContentTab } from "./ContentTab";
import { Distribution, hasDistribution } from "./DistributionTab";
import { EffectSection } from "./EffectSection";
import { TabError, TabSection, useGeoLoad } from "./geoTabKit";

/** What placing waits for, said once — under the stage counts, not at the bottom of the page. */
const MARKET_OFF_SENTENCE = "投放要等媒介集市接通：接通之前不会下单，写好的稿件先留在这里。";

/**
 * 行动 — writing and placing are one pipeline, so they are one page (appendix
 * E §3.2). “内容” and “投放” were two tabs, and a reader had to hold the
 * article list in their head to make sense of the order list.
 *
 * The page reads in the order a reader asks: where the articles stand, and if
 * nothing can be placed yet, why (right under the counts); the articles; what
 * was placed; and last the measurement of the work itself — the question groups
 * we placed articles for against the ones we only watched. That used to live in
 * “监测”, one tab away from the placements it is about. A section with nothing
 * in it is not drawn.
 */
export function ActionsTab({ geoId, project }: { geoId: string; project: GeoProject }) {
  const distribution = useGeoLoad(`distribution:${geoId}`, () => getGeoDistribution(geoId));
  const loaded = distribution.state.kind === "ready" ? distribution.state.data : null;
  const marketOff = loaded?.market?.configured === false;
  return (
    <div data-geo-tab="actions" className="flex flex-col gap-10">
      <ValueSection geoId={geoId} project={project} mode="actions" />
      <ContentTab
        geoId={geoId}
        project={project}
        notice={marketOff ? <p data-geo-market-off="" className="mt-3 max-w-measure text-ui text-text-2">{MARKET_OFF_SENTENCE}</p> : null}
      />
      {distribution.state.kind === "error" && (
        <TabSection title="投放">
          <TabError message={distribution.state.message} onRetry={distribution.reload} />
        </TabSection>
      )}
      {loaded && hasDistribution(loaded) && (
        <TabSection title="投放">
          <Distribution geoId={geoId} project={project} data={loaded} onChanged={distribution.reload} />
        </TabSection>
      )}
      <TabSection title="效果">
        <EffectSection project={project} />
      </TabSection>
    </div>
  );
}
