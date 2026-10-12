import { List, ListRow } from "@/components/ui/ListRow";
import { ShowMore, useShowMore } from "@/components/ui/ShowMore";
import type { MapNode } from "@/lib/memoryMapClient";
import { MarkGlyph } from "./MarkGlyph";

/** One line of the list under a canvas: a mark, or an event standing for one. */
export interface MarkLine {
  id: string;
  title: string;
  /** 「决定 · 3月2日」. */
  kind: string;
  /** Why it needs a look, or that it was replaced. */
  note: string | null;
  node: Pick<MapNode, "type" | "subtype" | "state">;
  /** Pressing the row; absent when the row opens nothing. */
  onOpen?: () => void;
  /** An address of its own the row goes to (a document's page), instead of a drawer. */
  to?: string;
}

/**
 * The same marks as the canvas, as rows (spec §5.1): the page's text for a screen reader and for a browser with no canvas, and the
 * place the walk clicks. A row opens what the mark opens — the memory's drawer, a document's page — through the one `onOpen`.
 */
export function MarkList({ lines, label, empty, unit = "个" }: { lines: readonly MarkLine[]; label: string; empty: string; unit?: string }) {
  const { visible, remaining, more } = useShowMore(lines, { first: 30, step: 30, resetKey: `${label}|${lines.length}|${lines[0]?.id ?? ""}` });
  if (lines.length === 0) return <p className="text-ui text-text-3">{empty}</p>;
  return (
    <div>
      <List label={label}>
        {visible.map((line) => (
          <ListRow
            key={line.id}
            title={line.title}
            leading={<MarkGlyph node={line.node} />}
            meta={[line.kind, line.note].filter(Boolean).join(" · ")}
            to={line.to}
            onOpen={line.to ? undefined : line.onOpen}
          />
        ))}
      </List>
      <ShowMore remaining={remaining} unit={unit} onMore={more} />
    </div>
  );
}
