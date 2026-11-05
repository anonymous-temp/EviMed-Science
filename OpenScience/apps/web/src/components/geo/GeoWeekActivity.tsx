import type { GeoProject } from "@/lib/geoClient";
import { List, ListRow } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";
import { dayWord, weekTarget, GEO_ALERT_KINDS } from "./geoOverviewModel";
import { useGeoPath } from "./useGeoPath";

/** Recent project events link to the actual object where one is available. */
export function GeoWeekActivity({ geoId, project, compact = false }: { geoId: string; project: GeoProject; compact?: boolean }) {
  const path = useGeoPath();
  const items = project.overview.week ?? [];
  if (items.length === 0) return null;
  const rows = (
      <List divided label="本周">
        {items.slice(0, 5).map((item, index) => {
          const to = weekTarget(geoId, item);
          return (
            <ListRow
              key={`${index}:${item.text}`}
              to={to ? path(to) : undefined}
              leading={<span className="w-16 text-caption text-text-3">{dayWord(item.at) ?? ""}</span>}
              title={item.text}
              trailing={GEO_ALERT_KINDS.has(item.kind) ? <Tag tone="safety">需处理</Tag> : undefined}
            />
          );
        })}
      </List>
  );
  return compact ? <details className="border-t border-border pt-4">
    <summary className="cursor-pointer font-semibold text-text">本周（{items.length > 5 ? "最近 5 条" : items.length}）</summary>
    <div className="mt-3">{rows}</div>
  </details> : <Section title="本周">{rows}</Section>;
}
