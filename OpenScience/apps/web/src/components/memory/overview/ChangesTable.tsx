import { ChartCard } from "@/components/ui/ChartCard";
import { List, ListRow } from "@/components/ui/ListRow";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import { MarkGlyph } from "@/components/memory/map/MarkGlyph";
import { memoryExcerpt } from "@/lib/memoryText";
import type { ChangeRow } from "./memoryOverviewModel";

/** How many rows the table opens with, and how many each 「显示更多」 adds. */
export const TABLE_FIRST = 12;

/**
 * The table behind the charts: 「最近变化」, one row for each change the selection leaves, newest first — a glyph, the memory, method or pack in ink,
 * under it what happened, when and where, and › at the end, because a press opens its drawer. With 「只看需要看一眼」 on it is 「需要看一眼」
 * and each row says why. Documents added on one day are one row, and it leaves the section (↗) for the knowledge base, as a row of a list
 * that goes to a page of its own does.
 *
 * It is a card of the kind the charts are — a heading, the number of rows at its end, the rows under it — so the page stacks one kind of block and
 * the table reads as what stands behind the charts. It shares the chart's selection: a range, a week, a topic and the search narrow both, and
 * the rows are what a screen reader gets of the chart.
 */
export function ChangesTable({ title, rows, label, onOpen }: {
  title: string;
  rows: readonly ChangeRow[];
  label: string;
  onOpen: (target: Exclude<ChangeRow["target"], { kind: "files" }>) => void;
}) {
  const { visible, remaining, more } = useShowMore(rows, { first: TABLE_FIRST, step: 12, resetKey: `${label}|${rows.length}|${rows[0]?.key ?? ""}` });
  return (
    <ChartCard title={title} meta={rows.length}>
      <List label={label}>
        {visible.map((row) => (
          <ListRow
            key={row.key}
            title={<span className="line-clamp-2 max-w-measure">{memoryExcerpt(row.title, 120)}</span>}
            leading={<MarkGlyph node={{ type: "memory", subtype: null, state: row.state }} glyph={row.glyph} />}
            meta={row.meta}
            titleProps={{ "data-overview-row": "" }}
            {...(row.target.kind === "files"
              ? { to: "/app/files", leaves: true }
              : { onOpen: () => onOpen(row.target as Exclude<ChangeRow["target"], { kind: "files" }>) })}
          />
        ))}
      </List>
      <ShowMore remaining={remaining} unit="条" onMore={more} />
    </ChartCard>
  );
}
