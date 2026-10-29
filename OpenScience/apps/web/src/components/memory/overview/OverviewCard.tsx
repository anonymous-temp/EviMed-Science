import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChartCard } from "@/components/ui/ChartCard";
import { Note } from "@/components/ui/Note";
import { List, ListRow } from "@/components/ui/ListRow";
import { Button } from "@/components/ui/Button";
import { MarkGlyph } from "@/components/memory/map/MarkGlyph";
import { markKindWord } from "@/components/memory/map/mapModel";
import { AskMenu } from "@/components/memory/AskMenu";
import { formatDay } from "@/lib/format";
import { memoryExcerpt } from "@/lib/memoryText";
import type { MapNode, MapOpen } from "@/lib/memoryMapClient";
import type { MarkRow } from "./memoryOverviewModel";

/** What a card is in: the read is under way, it failed, it has nothing yet (a recipe) or it has something. */
export type CardState = "loading" | "error" | "recipe" | "content";

/** The parts of the overview, in the order of the page. */
export type OverviewPart = "growth" | "you" | "projects" | "methods" | "knowledge" | "received";

/**
 * One of the six cards of the overview, drawn the one way: a sentence with its number as the heading, one link to the part in the map at
 * the heading's end, and the card's four states — a skeleton while the read is under way, one line with 重试 when it failed (never a
 * zero), a recipe when there is nothing yet, the content. `data-overview-card`, `data-state` and `data-count` are what the release walk
 * reads: that the page has its six cards in order, that none is still loading or silently failed, and that the number in a card's heading
 * is the number the headline says and the rows it draws (`data-shape`, `data-more`, `data-memories` say how it draws them).
 *
 * The card owns no data and reads nothing: its page hands it the state of its own read, so one card failing leaves the other five drawn.
 */
export function OverviewCard({ part, title, count = null, memories = null, shape = null, more = 0, state, drill, errorMessage, onRetry, height, children }: {
  part: OverviewPart;
  /** The heading: a sentence with the number in it (「关于你 · 6 件」), or the card's bare name when it has no number to give. */
  title: string;
  /** The number in the heading, for the walk; null when the card has none to give (not read, or a recipe). */
  count?: number | null;
  /** How many of its things are memories, for the card that counts projects: with 关于你's, the sentence's number. */
  memories?: number | null;
  /** How the card draws what it counts (`rows`, `bars`, `table`, `types`, `months`, `strip`, `single`): what the walk holds its rows and bars to. */
  shape?: string | null;
  /** How many more things there are than the card lists (「全部 N 个」). */
  more?: number;
  state: CardState;
  /** The map narrowed to this part: where the card's one link goes. */
  drill?: { to: string; label: string } | null;
  errorMessage?: string;
  onRetry?: () => void;
  /** The height of the skeleton. */
  height?: number;
  children?: ReactNode;
}) {
  return (
    <div
      data-overview-card={part} data-state={state} data-shape={state === "recipe" ? "recipe" : state === "content" ? shape ?? undefined : undefined}
      data-count={state === "content" && count !== null ? count : undefined} data-memories={state === "content" && memories !== null ? memories : undefined}
      data-more={state === "content" && more > 0 ? more : undefined} className="h-full"
    >
      <ChartCard
        className="h-full"
        title={title}
        state={state === "loading" ? "loading" : state === "error" ? "error" : "content"}
        errorMessage={errorMessage ?? "这一部分暂时没有读到。"}
        onRetry={onRetry}
        height={height ?? 120}
        meta={state === "content" && drill ? <Link to={drill.to} className="rounded text-link hover:underline hover:underline-offset-4">{drill.label}</Link> : undefined}
      >
        {children}
      </ChartCard>
    </div>
  );
}

/**
 * A card with nothing yet: what it is made of, what it gives, and the one thing to do about it — the sentence is the recipe and the
 * button the step (owner ruling 2026-10-14: an empty state is a recipe). Never a bare 「暂无」.
 */
export function Recipe({ children, action }: { children: ReactNode; action: ReactNode }) {
  return <Note action={action}>{children}</Note>;
}

/**
 * The recipe's button, the one quiet kind of control a recipe has. A `text` button, the look the sidebar's own 28 px controls and the header's
 * 「⋯」 already have: a data page is held to ten kinds of control, and a filled button on a card that is only sometimes a recipe is the eleventh.
 */
export function RecipeButton({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  // The link colour says it is pressed (a `text` button is the page's grey otherwise), and it is a colour the page already has: the sentence's numbers.
  return <Button size="sm" variant="text" className="text-link hover:text-link" onClick={onPress}>{children}</Button>;
}

/** What a row says under its title: the kind of mark and the day it began. */
function rowMeta(row: MarkRow): string {
  const node = row.node as Pick<MapNode, "type" | "subtype" | "group">;
  return [markKindWord(node as MapNode), formatDay(row.at)].filter(Boolean).join(" · ");
}

/**
 * The things a card lists as themselves — memories, methods, documents — each a row of the memory page's own kind: its shape, its words,
 * the day it began, and in its 「⋯」 the one thing to do with it besides open it, 「就这个提问」. A press opens what the mark opens (the
 * drawer, the page), through the one `onOpen` the page gives.
 */
export function MarkRows({ label, rows, onOpen, ask }: {
  label: string;
  rows: readonly MarkRow[];
  onOpen: (open: MapOpen, row: MarkRow) => void;
  ask: "memory" | "method" | "document";
}) {
  return (
    <List label={label}>
      {rows.map((row) => {
        const opens = row.open;
        const projectId = row.projectId && row.projectId !== "__other" ? row.projectId : null;
        return (
          <ListRow
            key={row.id}
            title={<span className="line-clamp-2 max-w-measure">{memoryExcerpt(row.title, 120)}</span>}
            leading={<MarkGlyph node={row.node} />}
            meta={rowMeta(row)}
            to={opens?.kind === "page" ? opens.href : undefined}
            onOpen={opens && opens.kind !== "page" ? () => onOpen(opens, row) : undefined}
            titleProps={{ "data-overview-row": "" }}
            menu={<AskMenu kind={ask} text={row.title} projectId={projectId} />}
          />
        );
      })}
    </List>
  );
}
